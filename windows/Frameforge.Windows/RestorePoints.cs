using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace Frameforge.Windows;

public record RestorePoint(long Sequence, string Description, DateTime CreatedAt);
public record FrequencyState(bool Existed, int? Minutes);
public record RestoreStatus(string Protection, bool PolicyDisabled, FrequencyState Frequency, bool Elevated, string SystemDrive);
public record ElevatedRequest(string Action, string[] Args);
public record RestoreResult(
    bool Ok,
    string Message,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Code = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Outcome = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] RestorePoint? Point = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] RestorePoint? LastPoint = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? CreatedSequence = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? FrequencyRestored = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] RestoreStatus? RestoreStatus = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] RestorePoint[]? RestorePoints = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? Available = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ResultPath = null,
    // Per-drive answer for the system drive at creation time: "confirmed", "off" or "unknown".
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? DriveCoverage = null);

public interface IRestoreStore
{
    bool PolicyDisabled();
    /// <summary>Per-volume System Protection for the system drive; null when it cannot be determined.</summary>
    bool? SystemDriveProtected();
    int? SessionInterval();
    FrequencyState ReadFrequency();
    void WriteFrequency(FrequencyState state);
    RestorePoint[] List();
    uint Create(string description);
    uint Enable(string driveRoot);
    bool Elevated { get; }
    string SystemDrive { get; }
}

public sealed class RestorePoints(IRestoreStore store, TimeSpan? createTimeout = null)
{
    private static readonly Regex Drive = new(@"\A[A-Z]:\z");
    private static readonly FrequencyState Bypass = new(true, 0);
    // Nested budgets: child create 120 s < parent wait 150 s after UAC approval < Node 330 s including the prompt.
    public static readonly TimeSpan CreateLimit = TimeSpan.FromSeconds(120);
    public RestoreStatus Status()
    {
        var drive = store.SystemDrive;
        if (!Drive.IsMatch(drive)) throw new InvalidOperationException("Unexpected system drive.");
        var protection = store.SessionInterval() switch { 1 => "enabled", 0 => "disabled", _ => "unknown" };
        return new(protection, store.PolicyDisabled(), store.ReadFrequency(), store.Elevated, drive);
    }
    public RestoreResult StatusResult()
    {
        var status = Status();
        var message = status.PolicyDisabled ? "System Restore is turned off by policy on this PC."
            : status.Protection switch
            {
                "enabled" => "System Protection is on for at least one drive. Per-drive state is confirmed when creating.",
                "disabled" => "System Protection appears to be off. Per-drive state is confirmed when creating.",
                _ => "System Protection state is unknown. Per-drive state is confirmed when creating."
            };
        return new(true, message, RestoreStatus: status);
    }
    private RestorePoint[] Sorted() => store.List().OrderByDescending(p => p.Sequence).ToArray();
    public RestoreResult List()
    {
        if (store.PolicyDisabled()) return new(true, "System Restore is turned off by policy on this PC.", RestorePoints: [], Available: false);
        var points = Sorted();
        return new(true, points.Length == 0 ? "No Windows restore points exist yet." : $"{points.Length} Windows restore points found.", RestorePoints: points, Available: true);
    }
    public RestoreResult Create(string description, bool bypass, FrequencyState original)
    {
        if (store.PolicyDisabled()) return new(true, "System Restore is turned off by policy on this PC.", Outcome: "policy-disabled");
        // A point is useless for whole-PC recovery unless the system drive itself is protected.
        if (store.SystemDriveProtected() == false) return new(true, $"System Protection is off for {store.SystemDrive}.", Outcome: "protection-disabled", DriveCoverage: "off");
        if (bypass && store.ReadFrequency() != original) throw new InvalidOperationException("The restore point frequency changed. Retry the normal creation first.");
        var before = Sorted().FirstOrDefault()?.Sequence ?? 0;
        if (!bypass) return CreateCore(description, before, null);
        RestoreResult result;
        store.WriteFrequency(Bypass);
        try { result = CreateCore(description, before, 0); }
        finally { store.WriteFrequency(original); }
        return result with { FrequencyRestored = store.ReadFrequency() == original };
    }
    private RestoreResult CreateCore(string description, long before, int? window)
    {
        var task = Task.Run(() => store.Create(description));
        if (Task.WhenAny(task, Task.Delay(createTimeout ?? CreateLimit)).GetAwaiter().GetResult() != task)
            return new(true, $"Windows did not finish creating the restore point within {CreateLimit.TotalSeconds:0} seconds. It may still be created; check Load restore points.", "restore-timeout", "failed");
        var code = task.GetAwaiter().GetResult();
        if (code is 1058 or 0x80070422) return new(true, $"System Protection is off for {store.SystemDrive}.", Outcome: "protection-disabled", DriveCoverage: "off");
        if (code != 0) return new(true, $"Windows could not create the restore point (error {code}).", "restore-failed", "failed");
        var points = Sorted();
        var newest = points.FirstOrDefault();
        // Only a new point carrying our description counts; another app may create one at the same time.
        var created = points.FirstOrDefault(p => p.Sequence > before && p.Description == description);
        if (created is not null)
            return store.SystemDriveProtected() switch
            {
                false => new(true, $"Windows created restore point #{created.Sequence}, but System Protection is off for {store.SystemDrive}, so it does not cover the system drive.", Outcome: "protection-disabled", Point: created, DriveCoverage: "off"),
                null => new(true, $"Windows restore point created and verified. {store.SystemDrive} coverage could not be confirmed.", Outcome: "created", Point: created, CreatedSequence: created.Sequence, DriveCoverage: "unknown"),
                true => new(true, "Windows restore point created and verified.", Outcome: "created", Point: created, CreatedSequence: created.Sequence, DriveCoverage: "confirmed")
            };
        // Windows returns 0 but silently skips creation inside the frequency window, so 0 alone is not success.
        var minutes = window ?? store.ReadFrequency().Minutes ?? 1440;
        if (newest is not null && minutes > 0 && newest.CreatedAt > DateTime.UtcNow.AddMinutes(-minutes))
            return new(true, "Windows skipped the restore point because one was created recently.", Outcome: "throttled", LastPoint: newest);
        return new(true, "Windows did not create a restore point; System Protection may be off for the system drive", "restore-not-created", "failed");
    }
    public RestoreResult Enable(string drive)
    {
        if (drive != store.SystemDrive || !Drive.IsMatch(drive)) throw new InvalidOperationException("Only the system drive is supported.");
        var code = store.Enable(drive + "\\");
        if (code != 0) return new(false, $"Windows could not turn on System Protection (error {code}).", "enable-failed");
        var result = StatusResult();
        var status = result.RestoreStatus!;
        // Only the per-drive check confirms the system drive; the any-drive hint never does.
        return store.SystemDriveProtected() switch
        {
            true => result with { Message = $"System Protection turned on for {drive}.", RestoreStatus = status with { Protection = "enabled" } },
            false => result with { Message = $"Windows accepted the request but has not turned on System Protection for {drive}.", RestoreStatus = status with { Protection = "disabled" } },
            null => result with { Message = $"Windows accepted the request, but System Protection for {drive} could not be confirmed.", RestoreStatus = status with { Protection = "unknown" } }
        };
    }
    public RestoreResult SetFrequency(FrequencyState state)
    {
        store.WriteFrequency(state);
        var result = StatusResult();
        return result.RestoreStatus!.Frequency == state ? result with { Message = "Restore point frequency restored and verified." }
            : new(false, "Windows did not retain the restore point frequency.", "verification-failed");
    }
}

public static class RestoreCommands
{
    private static readonly Regex DescriptionPattern = new(@"\A[\p{L}\p{N} ._()\-]{1,64}\z");
    private static readonly Regex ResultName = new(@"\Aframeforge-[0-9a-f]{32}\.json\z");
    private static readonly Regex DrivePattern = new(@"\A[A-Z]:\z");
    public static bool ValidDescription(string? text) => text is not null && DescriptionPattern.IsMatch(text);
    private static bool Flag(string text, out bool value) { value = text == "1"; return text is "0" or "1"; }
    private static bool Minutes(string existed, string text, out FrequencyState state)
    {
        state = new(false, null);
        if (!Flag(existed, out var flag) || !int.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var minutes)) return false;
        state = new(flag, flag ? minutes : null);
        return flag ? minutes >= 0 : minutes == -1;
    }
    // Validates the action and every argument; the returned closure performs it.
    public static Func<RestorePoints, RestoreResult> Parse(ElevatedRequest request)
    {
        var a = request.Args ?? [];
        return request.Action switch
        {
            "restore-list" when a.Length == 0 => engine => engine.List(),
            "restore-create" when a.Length == 4 && ValidDescription(a[0]) && Flag(a[1], out var bypass) && Minutes(a[2], a[3], out var original) =>
                engine => engine.Create(a[0], bypass, original),
            "restore-enable" when a.Length == 1 && DrivePattern.IsMatch(a[0]) => engine => engine.Enable(a[0]),
            "restore-frequency-set" when a.Length == 2 && Minutes(a[0], a[1], out var state) => engine => engine.SetFrequency(state),
            _ => throw new InvalidOperationException("Unsupported elevated request.")
        };
    }
    public static bool ValidResultPath(string path)
    {
        try
        {
            if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal) || !ResultName.IsMatch(Path.GetFileName(path))) return false;
            var info = new FileInfo(path);
            return info.Exists && info.Length == 0 && !info.Attributes.HasFlag(FileAttributes.ReparsePoint) &&
                new DriveInfo(Path.GetPathRoot(path)!).DriveType == DriveType.Fixed;
        }
        catch (Exception error) when (error is IOException or ArgumentException or UnauthorizedAccessException) { return false; }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);
    private static string FinalPath(SafeFileHandle handle)
    {
        var buffer = new StringBuilder(1024);
        var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity) throw new InvalidOperationException("Could not resolve the result file.");
        var text = buffer.ToString();
        return text.StartsWith(@"\\?\", StringComparison.Ordinal) ? text[4..] : text;
    }
    public static bool IsElevated() => new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);

    // GC-7: never concatenate arguments; ArgumentList is honoured by ShellExecuteEx (verified by spike).
    public static object Run(ElevatedRequest request)
    {
        var action = Parse(request);
        if (IsElevated()) return action(new RestorePoints(new WindowsRestoreStore()));
        SweepStaleResults();
        var draft = Path.Combine(Path.GetTempPath(), $"frameforge-{Guid.NewGuid():N}.json");
        string resultPath;
        using (var file = new FileStream(draft, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) resultPath = FinalPath(file.SafeFileHandle);
        var keep = false;
        try
        {
            var info = new ProcessStartInfo { FileName = Environment.ProcessPath!, UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden };
            foreach (var argument in new[] { "--elevated", request.Action, resultPath }.Concat(request.Args ?? [])) info.ArgumentList.Add(argument);
            Process? child;
            // Blocks while the consent prompt is open; the wait below starts only after approval.
            try { child = Process.Start(info); }
            catch (Win32Exception error) when (error.NativeErrorCode == 1223)
            {
                return new RestoreResult(true, "Administrator approval was declined. Nothing was changed.", "elevation-cancelled");
            }
            using (child)
            {
                if (child is null) throw new InvalidOperationException("The administrator request could not start.");
                if (!child.WaitForExit(ParentWait))
                {
                    // Keep the file: the child still writes its verified result, which the app reads on the next refresh.
                    keep = true;
                    return new RestoreResult(true, "Windows is still working on the administrator request. The result is checked on the next refresh.", "elevated-pending", ResultPath: resultPath);
                }
                if (ExitCode(child) == 2) return new RestoreResult(false, "The administrator helper rejected its result file. Nothing was changed.", "elevated-rejected");
            }
            return ParseResult(File.ReadAllText(resultPath));
        }
        finally
        {
            if (!keep) TryDelete(resultPath);
        }
    }
    public static readonly TimeSpan ParentWait = TimeSpan.FromSeconds(150);
    private static int? ExitCode(Process child)
    {
        try { return child.ExitCode; } catch (Exception error) when (error is InvalidOperationException or Win32Exception) { return null; }
    }
    private static JsonElement ParseResult(string text)
    {
        using var document = JsonDocument.Parse(text.Length is > 0 and < 1024 * 1024 ? text : throw new InvalidOperationException("The administrator request returned no result."));
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("Invalid administrator result.");
        return document.RootElement.Clone();
    }
    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { /* Swept on a later run. */ }
    }
    private static void SweepStaleResults()
    {
        try
        {
            foreach (var old in Directory.EnumerateFiles(Path.GetTempPath(), "frameforge-*.json"))
                if (ResultName.IsMatch(Path.GetFileName(old)) && File.GetLastWriteTimeUtc(old) < DateTime.UtcNow.AddDays(-1)) TryDelete(old);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { /* Best effort. */ }
    }
    // Unelevated read of a result the elevated child finished after the parent stopped waiting.
    public static object ReadResult(string path)
    {
        if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal) || !ResultName.IsMatch(Path.GetFileName(path)))
            throw new InvalidOperationException("Invalid result path.");
        if (!File.Exists(path)) return new RestoreResult(true, "The administrator request finished without a result.", "elevated-missing");
        string text;
        try
        {
            using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None);
            text = new StreamReader(file, Encoding.UTF8).ReadToEnd();
        }
        catch (IOException) { return new RestoreResult(true, "Windows is still working on the restore point.", "elevated-pending", ResultPath: path); }
        if (text.Length == 0)
        {
            if (File.GetLastWriteTimeUtc(path) > DateTime.UtcNow.AddMinutes(-15)) return new RestoreResult(true, "Windows is still working on the restore point.", "elevated-pending", ResultPath: path);
            TryDelete(path);
            return new RestoreResult(true, "The administrator request finished without a result.", "elevated-missing");
        }
        var result = ParseResult(text);
        TryDelete(path);
        return result;
    }
    // Entry point for `--elevated <action> <resultPath> ...args`. Writes exactly one JSON object to the result file.
    public static int RunElevatedChild(string[] argv, Func<object, string> serialize)
    {
        if (argv.Length < 2 || !ValidResultPath(argv[1])) return 2;
        using var file = new FileStream(argv[1], FileMode.Open, FileAccess.Write, FileShare.None);
        // Reject a swapped file or a junction anywhere in the path before an elevated write.
        if (file.Length != 0 || !string.Equals(FinalPath(file.SafeFileHandle), argv[1], StringComparison.OrdinalIgnoreCase)) return 2;
        object result;
        try { result = Parse(new(argv[0], argv[2..]))(new RestorePoints(new WindowsRestoreStore())); }
        catch (Exception error) { result = new RestoreResult(false, error is InvalidOperationException ? error.Message : "Windows could not complete the restore point request."); }
        file.Write(Encoding.UTF8.GetBytes(serialize(result)));
        return 0;
    }
}

public sealed class WindowsRestoreStore : IRestoreStore
{
    private const string Key = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore";
    private const string PolicyKey = @"SOFTWARE\Policies\Microsoft\Windows NT\SystemRestore";
    private const string Frequency = "SystemRestorePointCreationFrequency";
    public bool PolicyDisabled()
    {
        using var key = Registry.LocalMachine.OpenSubKey(PolicyKey, false);
        return key is not null && (key.GetValue("DisableSR") is 1 || key.GetValue("DisableConfig") is 1);
    }
    public int? SessionInterval()
    {
        using var key = Registry.LocalMachine.OpenSubKey(Key, false);
        return key?.GetValue("RPSessionInterval") as int?;
    }
    public FrequencyState ReadFrequency()
    {
        using var key = Registry.LocalMachine.OpenSubKey(Key, false);
        if (key is null || !key.GetValueNames().Contains(Frequency)) return new(false, null);
        if (key.GetValueKind(Frequency) != RegistryValueKind.DWord) throw new InvalidOperationException("The restore point frequency has an unexpected type. No change was made.");
        return new(true, (int)key.GetValue(Frequency)!);
    }
    public void WriteFrequency(FrequencyState state)
    {
        using var key = Registry.LocalMachine.CreateSubKey(Key, true);
        if (state.Existed) key.SetValue(Frequency, state.Minutes!.Value, RegistryValueKind.DWord);
        else key.DeleteValue(Frequency, false);
    }
    // Protected volumes are listed as "\\?\Volume{guid}\:(C%3A)" entries. Admin-only; unknown formats give null so creation falls back to WMI's own answer.
    public bool? SystemDriveProtected()
    {
        try
        {
            var volume = new StringBuilder(64);
            if (!GetVolumeNameForVolumeMountPointW(SystemDrive + "\\", volume, (uint)volume.Capacity)) return null;
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\SPP\Clients", false);
            var entries = key?.GetValueNames().SelectMany(name => key.GetValue(name) as string[] ?? []).Where(e => e.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase)).ToArray() ?? [];
            if (entries.Length == 0) return null;
            return entries.Any(e => e.StartsWith(volume.ToString(), StringComparison.OrdinalIgnoreCase));
        }
        catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { return null; }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetVolumeNameForVolumeMountPointW(string mountPoint, StringBuilder volumeName, uint length);
    private static readonly ManagementScope Scope = new(@"\\.\root\default", new ConnectionOptions { EnablePrivileges = true });
    public RestorePoint[] List()
    {
        using var searcher = new ManagementObjectSearcher(Scope, new ObjectQuery("SELECT SequenceNumber, Description, CreationTime, RestorePointType FROM SystemRestore"));
        using var results = searcher.Get();
        return results.Cast<ManagementObject>().Select(point =>
        {
            using (point)
            {
                var description = point["Description"] as string ?? "";
                return new RestorePoint(Convert.ToInt64(point["SequenceNumber"], CultureInfo.InvariantCulture), description.Length > 256 ? description[..256] : description,
                    ManagementDateTimeConverter.ToDateTime((string)point["CreationTime"]).ToUniversalTime());
            }
        }).ToArray();
    }
    private static uint Invoke(string method, object[] args)
    {
        using var restore = new ManagementClass(Scope, new ManagementPath("SystemRestore"), null);
        return unchecked((uint)Convert.ToInt64(restore.InvokeMethod(method, args), CultureInfo.InvariantCulture));
    }
    // 12 = MODIFY_SETTINGS, 100 = BEGIN_SYSTEM_CHANGE.
    public uint Create(string description) => Invoke("CreateRestorePoint", [description, 12, 100]);
    public uint Enable(string driveRoot) => Invoke("Enable", [driveRoot]);
    public bool Elevated => RestoreCommands.IsElevated();
    public string SystemDrive => Environment.GetEnvironmentVariable("SystemDrive") ?? "";
}
