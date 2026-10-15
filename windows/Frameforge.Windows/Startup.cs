using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using Microsoft.Win32;

namespace Frameforge.Windows;

// Programs that start with Windows. Enabled/disabled is the exact StartupApproved value Task Manager reads and writes, so both agree and the
// change is reversible. Frameforge never deletes a startup entry; "restore" puts the StartupApproved value back byte for byte (or removes it if it was absent).
// Source: hkcu-run, hklm-run, hklm-run32, hkcu-folder, hklm-folder (switchable); hkcu-runonce, hklm-runonce, task, uwp (listed only).
// Enabled is null when Windows has no per-item switch Frameforge can read. Approved: the current StartupApproved value as hex, null when absent.
public record StartupItem(string Id, string Name, string Command, string Path, string Publisher, string Source, string Scope, bool? Enabled, bool CanToggle,
    long? SizeBytes, string Impact, bool Critical, string? CriticalReason, string? Approved, string? Note);
public record StartupList(StartupItem[] Items, string[] Warnings);
// State: "applied", "already-set", "conflict", "failed", "declined", "timeout", "expired". Before/After: StartupApproved hex (null = absent) as read.
public record StartupWriteResult(string State, string Detail, string? Before, string? After);
// Op: "list", "set" (Enable) or "restore". Expect: the value the caller last saw ("-" = absent). New (restore): the value to put back ("-" = remove).
public record StartupRequest(string Op, string? Id = null, bool Enable = false, string? Expect = null, string? New = null);

// Where Windows keeps the switch for one item: machine hive or not, StartupApproved subkey (Run, Run32, StartupFolder) and value name.
public record StartupLocation(bool Machine, string Sub, string Name);

public interface IStartupApprovedStore
{
    byte[]? Read(StartupLocation location);
    void Write(StartupLocation location, byte[] value);
    void Delete(StartupLocation location);
}

public sealed class WindowsStartupApprovedStore : IStartupApprovedStore
{
    private const string Key = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\";
    private static RegistryKey Base(bool machine) => RegistryKey.OpenBaseKey(machine ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, RegistryView.Registry64);
    public byte[]? Read(StartupLocation l)
    {
        using var hive = Base(l.Machine);
        using var key = hive.OpenSubKey(Key + l.Sub, false);
        return key?.GetValue(l.Name, null, RegistryValueOptions.DoNotExpandEnvironmentNames) is byte[] bytes && key.GetValueKind(l.Name) == RegistryValueKind.Binary ? bytes : null;
    }
    public void Write(StartupLocation l, byte[] value)
    {
        using var hive = Base(l.Machine);
        using var key = hive.CreateSubKey(Key + l.Sub, true) ?? throw new InvalidOperationException("The StartupApproved key could not be opened.");
        key.SetValue(l.Name, value, RegistryValueKind.Binary);
    }
    public void Delete(StartupLocation l)
    {
        using var hive = Base(l.Machine);
        using var key = hive.OpenSubKey(Key + l.Sub, true);
        key?.DeleteValue(l.Name, false);
    }
}

public static class StartupApproved
{
    // Task Manager: first byte 02 = enabled, 03 = disabled (any odd first byte counts as disabled); bytes 4..11 are the FILETIME of the change (zero when enabled).
    public static bool Enabled(byte[]? value) => value is not { Length: > 0 } || (value[0] & 1) == 0;
    public static byte[] EncodeEnabled() => [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    public static byte[] EncodeDisabled(DateTime nowUtc)
    {
        var bytes = new byte[12];
        bytes[0] = 3;
        BitConverter.GetBytes(nowUtc.ToFileTimeUtc()).CopyTo(bytes, 4);
        return bytes;
    }
    public static string? Hex(byte[]? value) => value is null ? null : Convert.ToHexString(value).ToLowerInvariant();
    public static byte[]? FromHex(string? hex) => hex is null ? null : Convert.FromHexString(hex);
    // Wire form: "-" is absent, otherwise 8..512 hex digits (an even count).
    public static bool ValidToken(string? token) => token == "-" || (token is { Length: >= 8 and <= 512 } && token.Length % 2 == 0 && Regex.IsMatch(token, "^[0-9a-fA-F]+$"));
    public static string? FromToken(string token) => token == "-" ? null : token.ToLowerInvariant();

    private static readonly Dictionary<string, (bool Machine, string Sub)> Switchable = new()
    {
        ["hkcu-run"] = (false, "Run"), ["hklm-run"] = (true, "Run"), ["hklm-run32"] = (true, "Run32"),
        ["hkcu-folder"] = (false, "StartupFolder"), ["hklm-folder"] = (true, "StartupFolder"),
    };
    public static StartupLocation? Location(string source, string name) =>
        Switchable.TryGetValue(source, out var s) ? new(s.Machine, s.Sub, name) : null;
    // "source|name": the only identity the app sends, so it can only ever address the five switchable StartupApproved places.
    public static StartupLocation LocationOf(string id)
    {
        var bar = id.IndexOf('|');
        if (id.Length > 300 || bar <= 0 || bar == id.Length - 1) throw new InvalidOperationException("Unsupported startup item.");
        return Location(id[..bar], id[(bar + 1)..]) ?? throw new InvalidOperationException("This startup source cannot be switched.");
    }

    // Compare-and-set: changes the value only while it still equals what the caller saw, then reads it back.
    // next: "enable", "disable", "-" (remove) or hex. clock is injectable for tests.
    public static StartupWriteResult Write(IStartupApprovedStore store, StartupLocation location, string expectToken, string next, Func<DateTime>? clock = null)
    {
        if (!ValidToken(expectToken) || !(next is "enable" or "disable" || ValidToken(next))) throw new InvalidOperationException("Unsupported startup request.");
        var current = store.Read(location);
        var now = Hex(current);
        var wanted = next switch
        {
            "enable" => Hex(EncodeEnabled()),
            "disable" => Hex(EncodeDisabled((clock ?? (() => DateTime.UtcNow))())),
            _ => FromToken(next),
        };
        // A repeat request needs no write. An absent value already means enabled.
        var already = next == "enable" ? Enabled(current) : next == "disable" ? !Enabled(current) : now == wanted;
        if (already) return new("already-set", "Already in that state. Nothing was changed.", now, now);
        if (now != FromToken(expectToken)) return new("conflict", "The startup setting changed after Frameforge read it (for example in Task Manager). Nothing was changed; refresh and try again.", now, now);
        if (wanted is null) store.Delete(location); else store.Write(location, FromHex(wanted)!);
        var after = Hex(store.Read(location));
        return after == wanted ? new("applied", "Startup setting changed and verified.", now, after) : new("failed", "Windows did not keep the startup setting.", now, after);
    }

    private static readonly TimeSpan Approval = TimeSpan.FromSeconds(120), ChildWait = TimeSpan.FromSeconds(30);
    // The unelevated helper. Current-user items are written here; machine items go through the elevated child (one prompt, freshness guard).
    public static StartupWriteResult Run(StartupRequest request, IStartupApprovedStore store, IElevatedLauncher? launcher = null, bool? elevated = null, TimeSpan? approval = null, TimeSpan? grace = null, Func<DateTime>? clock = null)
    {
        if (request.Id is null || request.Expect is null || !ValidToken(request.Expect)) throw new InvalidOperationException("Unsupported startup request.");
        var next = request.Op switch
        {
            "set" => request.Enable ? "enable" : "disable",
            "restore" when ValidToken(request.New) => request.New!,
            _ => throw new InvalidOperationException("Unsupported startup request."),
        };
        var location = LocationOf(request.Id);
        if (!location.Machine || (elevated ?? RestoreCommands.IsElevated())) return Write(store, location, request.Expect, next, clock);
        var outcome = ElevatedCall.Run(launcher ?? ElevatedLaunchers.Default(), "--elevated-startup", "write", [request.Id, request.Expect, next], approval ?? Approval, ChildWait, default, grace);
        var unchanged = "Nothing was changed.";
        return outcome.Status switch
        {
            ElevationStatus.Declined => new("declined", $"Administrator approval was declined. {unchanged}", null, null),
            ElevationStatus.NotApproved or ElevationStatus.Cancelled => new("timeout", $"Administrator approval was not given within 2 minutes. {unchanged} A prompt that is still open does nothing now.", null, null),
            ElevationStatus.Expired => new("expired", $"The administrator request expired before it was approved. {unchanged}", null, null),
            ElevationStatus.Rejected => new("failed", $"The administrator step rejected its result file. {unchanged}", null, null),
            ElevationStatus.NoChild => new("failed", "The administrator request could not start.", null, null),
            ElevationStatus.ChildTimeout => new("failed", "The administrator step did not finish in time. Refresh the list to see the current state.", null, null),
            _ => Parse(outcome.Text),
        };
    }
    private static StartupWriteResult Parse(string? text)
    {
        try { if (!string.IsNullOrEmpty(text) && text.Length < 4096 && JsonSerializer.Deserialize<StartupWriteResult>(text, HelperJson.Options) is { } result) return result; }
        catch (JsonException) { /* Reported below. */ }
        return new("failed", "The administrator step returned no readable result. Refresh the list to see the current state.", null, null);
    }
    // Entry point for `--elevated-startup write <resultPath> <id> <expect> <next>`. Writes exactly one JSON object to the result file.
    public static int RunElevatedChild(string[] argv, Func<object, string> serialize, IStartupApprovedStore? store = null)
    {
        if (argv.Length != 5 || argv[0] != "write") return 2;
        using var file = ElevatedCall.OpenResult(argv[1], out var rejected);
        if (file is null) return rejected;
        StartupWriteResult result;
        try
        {
            var location = LocationOf(argv[2]);
            // The elevated child only ever touches the machine-wide switches.
            if (!location.Machine) throw new InvalidOperationException("Unsupported startup request.");
            result = Write(store ?? new WindowsStartupApprovedStore(), location, argv[3], argv[4]);
        }
        catch (Exception error) when (error is InvalidOperationException or FormatException) { result = new("failed", "The startup request was not valid. Nothing was changed.", null, null); }
        catch (Exception error) when (error is UnauthorizedAccessException or System.Security.SecurityException or IOException) { result = new("failed", "Windows refused the change (access denied). Nothing was changed.", null, null); }
        file.Write(Encoding.UTF8.GetBytes(serialize(result)));
        return 0;
    }
}

public sealed record StartupFile(bool Exists, long Size, string Publisher);

// What the lister reads from Windows; faked in tests.
public interface IStartupSources
{
    IEnumerable<(string Name, string Command)> RunValues(string source);          // hkcu-run, hklm-run, hklm-run32, hkcu-runonce, hklm-runonce
    IEnumerable<(string Name, string Target, string FilePath)> FolderItems(bool machine);
    IEnumerable<(string Name, string Command, bool Enabled)> LogonTasks();
    IEnumerable<(string Name, string Package, bool Enabled)> StoreTasks();
    StartupFile Inspect(string path);
    string SystemRoot { get; }
}

public static class StartupLister
{
    private static readonly Regex Quoted = new("^\\s*\"([^\"]+)\"", RegexOptions.Compiled),
        Executable = new("^\\s*(.+?\\.(?:exe|bat|cmd|com|lnk|msc|cpl))(?:\\s|$)", RegexOptions.Compiled | RegexOptions.IgnoreCase),
        Security = new("Norton|McAfee|Kaspersky|Bitdefender|Avast|\\bAVG\\b|\\bESET\\b|Malwarebytes|Sophos|Trend Micro|CrowdStrike|Webroot|SecurityHealth|Windows Defender|MsMpEng", RegexOptions.Compiled | RegexOptions.IgnoreCase),
        Driver = new("Realtek|RtkAud|Nahimic|NVIDIA|Advanced Micro Devices|\\bAMD\\b|Intel\\(R\\)|Intel Corp", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // The program a Run command line starts: a quoted path, else the text up to the first known executable extension, else the first word.
    public static string ExecutablePath(string command)
    {
        var text = Environment.ExpandEnvironmentVariables(command ?? "").Trim();
        if (Quoted.Match(text) is { Success: true } q) return q.Groups[1].Value;
        if (Executable.Match(text) is { Success: true } e) return e.Groups[1].Value;
        return text.Split(' ', 2)[0];
    }
    // A size-based estimate only: Windows' own startup impact (CPU and disk at sign-in) is not available to Frameforge.
    public static string Impact(long? size) => size is null ? "unknown" : size < 5_000_000 ? "low" : size < 50_000_000 ? "medium" : "high";
    public static string? CriticalReason(string name, string path, string publisher, string systemRoot)
    {
        var text = $"{name} {path} {publisher}";
        if (Security.IsMatch(text)) return "Security software or Windows Security: turning it off can leave the PC unprotected.";
        if (!string.IsNullOrEmpty(systemRoot) && path.StartsWith(systemRoot, StringComparison.OrdinalIgnoreCase)) return "A Windows component.";
        if (Driver.IsMatch(text)) return "A driver helper (audio or graphics): its features such as audio effects or control panels may stop working.";
        return null;
    }

    private static string Cut(string text, int length) => text.Length <= length ? text : text[..length];
    public static StartupList Build(IStartupSources sources, IStartupApprovedStore approved)
    {
        var items = new List<StartupItem>();
        var warnings = new List<string>();
        void Add(string source, string name, string command, string path, string note, bool? enabledOverride, StartupLocation? location, string scope)
        {
            // The app caps field sizes; an over-long name could not be addressed by id anyway.
            if (name.Length > 250) return;
            path = Cut(path, 2000);
            var file = sources.Inspect(path);
            var raw = location is null ? null : approved.Read(location);
            var size = file.Exists ? file.Size : (long?)null;
            var reason = CriticalReason(name, path, file.Publisher, sources.SystemRoot);
            items.Add(new($"{source}|{name}", name, Cut(command, 2000), path, Cut(file.Publisher, 190), source, scope,
                enabledOverride ?? (location is null ? null : StartupApproved.Enabled(raw)), location is not null, size, Impact(size), reason is not null, reason,
                StartupApproved.Hex(raw), string.IsNullOrEmpty(note) ? (file.Exists || path.Length == 0 ? null : "The program was not found at this path.") : note));
        }
        foreach (var source in new[] { "hkcu-run", "hklm-run", "hklm-run32" })
            try { foreach (var (name, command) in sources.RunValues(source)) Add(source, name, command, ExecutablePath(command), "", null, StartupApproved.Location(source, name), source.StartsWith("hkcu") ? "user" : "machine"); }
            catch (Exception error) when (error is System.Security.SecurityException or IOException or UnauthorizedAccessException) { warnings.Add($"Could not read {source}."); }
        foreach (var machine in new[] { false, true })
            try
            {
                foreach (var (name, target, file) in sources.FolderItems(machine))
                {
                    var source = machine ? "hklm-folder" : "hkcu-folder";
                    // The StartupApproved value is named after the file in the folder, extension included.
                    Add(source, name, file, string.IsNullOrEmpty(target) ? file : target, "", null, StartupApproved.Location(source, name), machine ? "machine" : "user");
                }
            }
            catch (Exception error) when (error is System.Security.SecurityException or IOException or UnauthorizedAccessException) { warnings.Add("Could not read a Startup folder."); }
        foreach (var source in new[] { "hkcu-runonce", "hklm-runonce" })
            try { foreach (var (name, command) in sources.RunValues(source)) Add(source, name, command, ExecutablePath(command), "Runs once at the next sign-in, then Windows removes it. Listed only.", null, null, source.StartsWith("hkcu") ? "user" : "machine"); }
            catch (Exception error) when (error is System.Security.SecurityException or IOException or UnauthorizedAccessException) { warnings.Add($"Could not read {source}."); }
        try { foreach (var (name, command, enabled) in sources.LogonTasks()) Add("task", name, command, ExecutablePath(command), "Task Scheduler logon task. Listed only; change it in Task Scheduler.", enabled, null, "machine"); }
        catch (Exception error) when (error is System.Security.SecurityException or IOException or UnauthorizedAccessException) { warnings.Add("Could not read Task Scheduler logon tasks."); }
        try { foreach (var (name, package, enabled) in sources.StoreTasks()) Add("uwp", name, package, "", "Microsoft Store app startup task. Listed only; change it in Task Manager or Settings > Apps > Startup.", enabled, null, "user"); }
        catch (Exception error) when (error is System.Security.SecurityException or IOException or UnauthorizedAccessException) { warnings.Add("Could not read Store app startup tasks."); }
        return new(items.OrderBy(i => i.Name, StringComparer.OrdinalIgnoreCase).Take(500).ToArray(), warnings.ToArray());
    }
}

public sealed class WindowsStartupSources : IStartupSources
{
    public string SystemRoot => Environment.GetFolderPath(Environment.SpecialFolder.Windows);
    private static RegistryKey Hive(bool machine, RegistryView view = RegistryView.Registry64) => RegistryKey.OpenBaseKey(machine ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, view);
    public IEnumerable<(string Name, string Command)> RunValues(string source)
    {
        var (machine, view, key) = source switch
        {
            "hkcu-run" => (false, RegistryView.Registry64, "Run"), "hklm-run" => (true, RegistryView.Registry64, "Run"), "hklm-run32" => (true, RegistryView.Registry32, "Run"),
            "hkcu-runonce" => (false, RegistryView.Registry64, "RunOnce"), "hklm-runonce" => (true, RegistryView.Registry64, "RunOnce"),
            _ => throw new InvalidOperationException("Unsupported startup source."),
        };
        using var hive = Hive(machine, view);
        using var run = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\" + key, false);
        if (run is null) yield break;
        foreach (var name in run.GetValueNames())
            if (name.Length > 0 && run.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames) is string command) yield return (name, command);
    }
    public IEnumerable<(string Name, string Target, string FilePath)> FolderItems(bool machine)
    {
        var folder = Environment.GetFolderPath(machine ? Environment.SpecialFolder.CommonStartup : Environment.SpecialFolder.Startup);
        if (!Directory.Exists(folder)) yield break;
        foreach (var file in Directory.EnumerateFiles(folder))
        {
            var name = Path.GetFileName(file);
            if (name.Equals("desktop.ini", StringComparison.OrdinalIgnoreCase)) continue;
            yield return (name, file.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase) ? LinkTarget(file) : file, file);
        }
    }
    // WScript.Shell is the documented way to read a shortcut; a failure just means the shortcut itself is shown.
    private static string LinkTarget(string link)
    {
        try
        {
            dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!)!;
            return (string)shell.CreateShortcut(link).TargetPath;
        }
        catch (Exception) { return ""; }
    }
    public IEnumerable<(string Name, string Command, bool Enabled)> LogonTasks()
    {
        var root = Path.Combine(SystemRoot, "System32", "Tasks");
        if (!Directory.Exists(root)) yield break;
        var count = 0;
        foreach (var file in Directory.EnumerateFiles(root, "*", new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint }))
        {
            var relative = Path.GetRelativePath(root, file);
            // Windows' own tasks (Microsoft\Windows) are not startup programs a user manages.
            if (relative.StartsWith(@"Microsoft\Windows", StringComparison.OrdinalIgnoreCase) || count >= 300) continue;
            (string Name, string Command, bool Enabled)? found = null;
            try
            {
                using var reader = XmlReader.Create(file, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
                var xml = XDocument.Load(reader);
                var logon = xml.Descendants().FirstOrDefault(e => e.Name.LocalName == "LogonTrigger");
                var exec = xml.Descendants().FirstOrDefault(e => e.Name.LocalName == "Exec");
                if (logon is null || exec is null) continue;
                string Child(XElement parent, string name) => parent.Elements().FirstOrDefault(e => e.Name.LocalName == name)?.Value ?? "";
                var settingsOn = !string.Equals(xml.Descendants().FirstOrDefault(e => e.Name.LocalName == "Settings")?.Elements().FirstOrDefault(e => e.Name.LocalName == "Enabled")?.Value, "false", StringComparison.OrdinalIgnoreCase);
                var triggerOn = !string.Equals(Child(logon, "Enabled"), "false", StringComparison.OrdinalIgnoreCase);
                found = ("\\" + relative, $"{Child(exec, "Command").Trim()} {Child(exec, "Arguments").Trim()}".Trim(), settingsOn && triggerOn);
            }
            catch (Exception error) when (error is XmlException or IOException or UnauthorizedAccessException) { /* Unreadable tasks are skipped. */ }
            if (found is { } task) { count++; yield return task; }
        }
    }
    public IEnumerable<(string Name, string Package, bool Enabled)> StoreTasks()
    {
        using var hive = Hive(false);
        using var data = hive.OpenSubKey(@"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData", false);
        if (data is null) yield break;
        foreach (var package in data.GetSubKeyNames())
        {
            using var packageKey = data.OpenSubKey(package, false);
            if (packageKey is null) continue;
            foreach (var task in packageKey.GetSubKeyNames())
            {
                using var taskKey = packageKey.OpenSubKey(task, false);
                // State: 0 disabled, 1 disabled by user, 2 enabled, 3 disabled by policy, 4 enabled by policy.
                if (taskKey?.GetValue("State") is int state) yield return ($"{package.Split('_')[0]} ({task})", package, state is 2 or 4);
            }
        }
    }
    public StartupFile Inspect(string path)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || !File.Exists(path)) return new(false, 0, "");
            var info = new FileInfo(path);
            var company = System.Diagnostics.FileVersionInfo.GetVersionInfo(path).CompanyName ?? "";
            return new(true, info.Length, company.Trim());
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { return new(false, 0, ""); }
    }
}
