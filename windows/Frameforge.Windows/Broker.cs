using System.Buffers.Binary;
using System.Globalization;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace Frameforge.Windows;

// "Approve admin once": an optional LocalSystem service (FrameforgeBroker) that runs the same six elevated child entry points
// the helper otherwise starts with a UAC prompt each time. This file is the pure part: wire format, allowlist, replay and rate
// guard, client admission, install paths and the status decision. docs/SECURITY.md explains the trust model.

public sealed record BrokerRequest(int V, string Type, string? Nonce = null, long Ts = 0, string? Op = null, string? Action = null, string[]? Args = null);
// Type: "pong", "result", "line", "end" or "error". Text is the child's result file (result) or one JSON line (line).
public sealed record BrokerReply(int V, string Type, string? Nonce = null, bool Ok = true, string? Code = null, string? Text = null, int Pid = 0, string? Version = null);

public static class BrokerProtocol
{
    public const int Version = 1, MaxRequestBytes = 65536, MaxReplyBytes = 1048576;
    public const string PipeName = "FrameforgeBroker", ServiceName = "FrameforgeBroker", RegistryKey = @"SOFTWARE\Frameforge\Broker";
    public static string AppVersion => typeof(BrokerProtocol).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
    public static string NewNonce() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));

    // 4-byte little-endian length, then UTF-8 JSON. A length of 0 or above the cap is a protocol error, never an allocation.
    public static async Task WriteAsync(Stream stream, object value, CancellationToken cancel = default)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(value, value.GetType(), HelperJson.Options);
        if (json.Length > MaxReplyBytes) throw new InvalidDataException("Frame too large.");
        var frame = new byte[4 + json.Length];
        BinaryPrimitives.WriteInt32LittleEndian(frame, json.Length);
        json.CopyTo(frame, 4);
        await stream.WriteAsync(frame, cancel).ConfigureAwait(false);
        await stream.FlushAsync(cancel).ConfigureAwait(false);
    }
    // Null at a clean end of stream.
    public static async Task<byte[]?> ReadAsync(Stream stream, int max, CancellationToken cancel = default)
    {
        var header = new byte[4];
        if (!await Fill(stream, header, cancel).ConfigureAwait(false)) return null;
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length <= 0 || length > max) throw new InvalidDataException("Invalid frame length.");
        var body = new byte[length];
        if (!await Fill(stream, body, cancel).ConfigureAwait(false)) throw new InvalidDataException("Truncated frame.");
        return body;
    }
    private static async Task<bool> Fill(Stream stream, byte[] buffer, CancellationToken cancel)
    {
        for (var read = 0; read < buffer.Length;)
        {
            var n = await stream.ReadAsync(buffer.AsMemory(read), cancel).ConfigureAwait(false);
            if (n == 0) { if (read == 0) return false; throw new InvalidDataException("Truncated frame."); }
            read += n;
        }
        return true;
    }
    public static T? Parse<T>(byte[] frame) where T : class
    {
        try { return JsonSerializer.Deserialize<T>(frame, HelperJson.Options); } catch (JsonException) { return null; }
    }
}

// The only things the broker will ever do: the six existing elevated child entry points, each with the arguments its own child
// accepts. The same validators the child runs (RestoreCommands.Parse, ServiceCommands.ValidNames, OptimizationTable.IsAdmin ...) run here
// first, so a bad request is refused before a process starts. There is no free-form path, command line or registry key in any request:
// the broker also picks the result file itself, in a directory only SYSTEM and Administrators can write.
public static class BrokerAllowlist
{
    public static readonly string[] Ops = ["--elevated", "--elevated-services", "--elevated-timer", "--elevated-optimize", "--elevated-fps", "--elevated-startup"];
    public const int MaxArgs = 64, MaxArg = 24000;
    public static readonly string[] OptimizeCommands = ["capture", "apply", "verify", "restore"];

    // Null when allowed; otherwise a stable code ("not-allowed" or "invalid-arguments").
    public static string? Reject(string? op, string? action, string[]? args)
    {
        if (op is null || !Ops.Contains(op, StringComparer.Ordinal) || action is null || action.Length is 0 or > 64) return "not-allowed";
        if (args is null || args.Length > MaxArgs || args.Any(a => a is null || a.Length > MaxArg || a.Contains('\0'))) return "invalid-arguments";
        try
        {
            // Items that lower Windows security (Defender, UAC, SmartScreen, mitigations ...) never go through the broker, whatever the
            // command: they always need their own interactive Windows prompt on top of the in-app acknowledgement.
            if (op == "--elevated-optimize" && NamesSecurityItem(args)) return "not-allowed";
            var valid = op switch
            {
                "--elevated" => RestoreCommands.Parse(new ElevatedRequest(action, args)) is not null,
                "--elevated-services" => ServiceCommands.ValidAction(action) && ServiceCommands.ValidNames(action, args),
                "--elevated-timer" => TimerArguments(action, args),
                "--elevated-optimize" => OptimizeArguments(action, args),
                "--elevated-startup" => StartupArguments(action, args),
                _ => FpsArguments(action, args)
            };
            return valid ? null : "invalid-arguments";
        }
        catch (Exception error) when (error is InvalidOperationException or FormatException or OverflowException or JsonException) { return "invalid-arguments"; }
    }
    private static bool TimerArguments(string action, string[] args)
    {
        if (action is not ("enable" or "restore") || args.Length != 2 || args[0] is not ("0" or "1")) return false;
        int? value = args[1] == "-" ? null : TimerGlobalSetting.ParseDword(args[1]);
        return args[0] == "1" ? value is not null : value is null;
    }
    // Startup apps: one machine-wide StartupApproved switch (Task Manager's own value). Nothing here lowers Windows security, and the id can only
    // address the five switchable StartupApproved places, so it is not a free-form registry path.
    private static bool StartupArguments(string action, string[] args) =>
        action == "write" && args.Length == 3 && StartupApproved.LocationOf(args[0]).Machine && StartupApproved.ValidToken(args[1]) &&
        (args[2] is "enable" or "disable" || StartupApproved.ValidToken(args[2]));
    public static bool NamesSecurityItem(string[] args)
    {
        try { return args.Length == 1 && JsonSerializer.Deserialize<AdminRequest>(args[0], HelperJson.Options) is { Ids: { } ids } && ids.Any(OptimizationTable.IsSecurity); }
        catch (JsonException) { return false; }
    }
    private static bool OptimizeArguments(string action, string[] args)
    {
        if (action != "run" || args.Length != 1) return false;
        var request = JsonSerializer.Deserialize<AdminRequest>(args[0], HelperJson.Options);
        return request is { Ids.Length: > 0 and <= 24 } && OptimizeCommands.Contains(request.Command) && request.Ids.All(OptimizationTable.IsAdmin);
    }
    // game pid, game start time (round-trip UTC), parent pid. The broker replaces the parent with the pipe client's own pid.
    private static bool FpsArguments(string action, string[] args) =>
        action == "capture" && args.Length == 3 && int.TryParse(args[0], NumberStyles.None, CultureInfo.InvariantCulture, out var game) && game > 0 &&
        DateTime.TryParseExact(args[1], "O", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var started) && started.Kind == DateTimeKind.Utc &&
        int.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out var parent) && parent > 0;
}

// Per-request nonce (base64 of 16 to 32 random bytes), a timestamp within a minute of the broker's clock, no nonce twice within
// five minutes (replay, remembered per account and capped), and a ceiling on requests per minute per client process (and four
// times that per account), so one busy or hostile process cannot starve the others.
public sealed class RequestGuard(Func<DateTime>? clock = null, int perMinute = 30)
{
    private static readonly TimeSpan Skew = TimeSpan.FromSeconds(60), Remember = TimeSpan.FromMinutes(5), Window = TimeSpan.FromMinutes(1);
    public const int MaxRemembered = 2048;
    private readonly Func<DateTime> now = clock ?? (() => DateTime.UtcNow);
    private readonly Dictionary<string, Dictionary<string, DateTime>> seen = [];
    private readonly Dictionary<string, Queue<DateTime>> recent = [];
    private readonly object gate = new();
    public static bool ValidNonce(string? nonce)
    {
        if (nonce is null || nonce.Length is < 22 or > 44) return false;
        try { return Convert.FromBase64String(nonce).Length is >= 16 and <= 32; } catch (FormatException) { return false; }
    }
    public static long Stamp(DateTime utc) => new DateTimeOffset(utc, TimeSpan.Zero).ToUnixTimeMilliseconds();
    // Null when the request may proceed; otherwise "bad-nonce", "stale", "replay" or "rate-limited".
    public string? Check(string? nonce, long timestampMs, ClientInfo? client = null)
    {
        if (!ValidNonce(nonce)) return "bad-nonce";
        lock (gate)
        {
            var at = now();
            if (Math.Abs(Stamp(at) - timestampMs) > Skew.TotalMilliseconds) return "stale";
            var sid = client?.Sid ?? "";
            if (!seen.TryGetValue(sid, out var known)) seen[sid] = known = [];
            foreach (var old in known.Where(p => at - p.Value > Remember).Select(p => p.Key).ToList()) known.Remove(old);
            if (known.ContainsKey(nonce!)) return "replay";
            if (known.Count >= MaxRemembered) known.Remove(known.MinBy(p => p.Value).Key);
            known[nonce!] = at;
            var process = Pressure("pid:" + (client?.Pid ?? 0), at);
            var account = Pressure("sid:" + sid, at);
            if (process.Count >= perMinute || account.Count >= perMinute * 4) return "rate-limited";
            process.Enqueue(at);
            account.Enqueue(at);
            foreach (var idle in recent.Where(p => p.Value.Count == 0 || at - p.Value.Peek() > Window && at - p.Value.ToArray()[^1] > Window).Select(p => p.Key).ToList()) recent.Remove(idle);
            return null;
        }
    }
    private Queue<DateTime> Pressure(string key, DateTime at)
    {
        if (!recent.TryGetValue(key, out var queue)) recent[key] = queue = [];
        while (queue.Count > 0 && at - queue.Peek() > Window) queue.Dequeue();
        return queue;
    }
}

public sealed record ClientInfo(int Pid, int Session, string? Image, string? Sid);

// Written to HKLM at install time (admin-only writable) and read by the service at start and by the app for status.
public sealed record BrokerConfig(string OwnerSid, string ClientImage, string Version, string InstallDir)
{
    public static BrokerConfig? Load(Func<string, object?>? read = null)
    {
        try
        {
            if (read is null)
            {
                using var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(BrokerProtocol.RegistryKey, false);
                if (key is null) return null;
                read = key.GetValue;
            }
            return read("OwnerSid") is string owner && read("ClientImage") is string image && read("Version") is string version && read("InstallDir") is string dir
                ? new BrokerConfig(owner, image, version, dir) : null;
        }
        catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { return null; }
    }
}

public static class ClientPolicy
{
    // Admission: the connection's own token user must be the person who approved the install, and the process must be the helper
    // registered at install. Best effort by design: the image path of a per-user install can be replaced by that same user, which
    // is why the trade-off is documented in SECURITY.md and why every operation is still limited to the allowlist.
    public static string? Reject(ClientInfo client, BrokerConfig config)
    {
        if (client.Sid is null || !string.Equals(client.Sid, config.OwnerSid, StringComparison.OrdinalIgnoreCase)) return "other-user";
        if (client.Image is null || !BrokerPaths.SamePath(client.Image, config.ClientImage)) return "wrong-image";
        return null;
    }
}

public static class BrokerPaths
{
    public const string ExeName = "Frameforge.Windows.exe", ServiceArgument = "--broker-service";
    public static string InstallDir(string programFiles) => Path.Combine(programFiles, "Frameforge", "Broker");
    public static string DataDir(string commonAppData) => Path.Combine(commonAppData, "Frameforge", "Broker");
    // Quoted, and it ends in a fixed argument: the service control manager runs exactly this and nothing a user can influence.
    public static string ImagePath(string installDir) => $"\"{Path.Combine(installDir, ExeName)}\" {ServiceArgument}";
    public static bool SamePath(string a, string b)
    {
        try { return string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase); } catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException) { return false; }
    }
    // The broker refuses to serve unless it is the exact exe at the admin-only install location.
    public static string? VerifyInstallLocation(string processPath, string programFiles)
    {
        var expected = Path.Combine(InstallDir(programFiles), ExeName);
        if (!SamePath(processPath, expected)) return "The broker is not running from its install directory.";
        try
        {
            for (DirectoryInfo? dir = new FileInfo(processPath).Directory; dir is not null && !SamePath(dir.FullName, programFiles); dir = dir.Parent)
                if (dir.Attributes.HasFlag(FileAttributes.ReparsePoint)) return "The broker install path contains a link.";
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return "The broker install path could not be checked."; }
        return null;
    }
    private static readonly SecurityIdentifier[] Trusted =
    [
        new(WellKnownSidType.LocalSystemSid, null), new(WellKnownSidType.BuiltinAdministratorsSid, null), new(WellKnownSidType.CreatorOwnerSid, null),
        new("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464") // NT SERVICE\TrustedInstaller
    ];
    private const FileSystemRights Writes = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteExtendedAttributes | FileSystemRights.WriteAttributes |
        FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.Delete | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
    // SIDs that can write to, delete from or re-permission a directory although they are not SYSTEM, Administrators or TrustedInstaller.
    public static string[] WritableByOthers(IEnumerable<FileSystemAccessRule> rules) =>
        [.. rules.Where(r => r.AccessControlType == AccessControlType.Allow && (r.FileSystemRights & Writes) != 0 && r.IdentityReference is SecurityIdentifier sid && !Trusted.Contains(sid))
            .Select(r => r.IdentityReference.Value).Distinct()];
    // Only an ordinary person's SID may own the pipe: a local or domain user (RID 1000 and up) or a Microsoft/Entra account; never SYSTEM, a built-in group or a well-known account.
    public static bool ValidOwnerSid(string? text)
    {
        if (text is null || text.Length > 184) return false;
        try
        {
            var parts = new SecurityIdentifier(text).Value.Split('-');
            if (parts.Length == 8 && parts[..4].SequenceEqual(["S", "1", "12", "1"])) return true;
            return parts.Length == 8 && parts[..4].SequenceEqual(["S", "1", "5", "21"]) && uint.TryParse(parts[7], NumberStyles.None, CultureInfo.InvariantCulture, out var rid) && rid >= 1000;
        }
        catch (ArgumentException) { return false; }
    }
}

public sealed record BrokerState(string State, string Message, string? Version = null);

public sealed record BrokerFacts(bool ServiceExists, bool Running, string? ImagePath, BrokerConfig? Config, string ExpectedImagePath, string HelperPath, string UserSid, string AppVersion,
    bool? PingOk, string? BrokerVersion);

public static class BrokerStatusCheck
{
    // Read-only: a service-manager query, an HKLM read and (when the rest is in order) a ping. Never opens a prompt.
    public static BrokerState Evaluate(BrokerFacts f)
    {
        if (!f.ServiceExists && f.Config is null) return new("not-installed", "Admin access is not set up. Each administrator step asks Windows for approval.");
        if (!f.ServiceExists || f.Config is null) return new("unhealthy", "The admin service is only partly installed. Remove it, then approve admin again.");
        if (!string.Equals(f.ImagePath, f.ExpectedImagePath, StringComparison.OrdinalIgnoreCase)) return new("unhealthy", "The admin service does not point at its protected install folder, so Frameforge ignores it. Remove it.");
        if (!string.Equals(f.Config.OwnerSid, f.UserSid, StringComparison.OrdinalIgnoreCase)) return new("needs-update", "The admin service was approved for a different Windows account. Approve it again for this account.");
        if (!BrokerPaths.SamePath(f.Config.ClientImage, f.HelperPath)) return new("needs-update", "Frameforge now lives in a different folder than when admin was approved. Approve it again.");
        if (f.Config.Version != f.AppVersion) return new("needs-update", $"The admin service is version {f.Config.Version}; this Frameforge is {f.AppVersion}. Update it with one approval.", f.Config.Version);
        if (!f.Running) return new("unhealthy", "The admin service is installed but not running. Each administrator step asks Windows for approval until it is.", f.Config.Version);
        if (f.PingOk != true) return new("unhealthy", "The admin service did not answer. Each administrator step asks Windows for approval until it does.", f.Config.Version);
        return f.BrokerVersion == f.AppVersion
            ? new("ready", "Admin access is approved. Administrator steps run without a Windows prompt.", f.AppVersion)
            : new("needs-update", "The running admin service is out of date. Update it with one approval.", f.BrokerVersion);
    }
}
