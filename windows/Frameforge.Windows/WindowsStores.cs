using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Frameforge.Windows;

/// <summary>Runs one of two fixed Windows tools with an argument array (never a command string).</summary>
public interface IToolRunner { string Run(string tool, string[] args); }

public sealed class SystemTools : IToolRunner
{
    public string Run(string tool, string[] args)
    {
        if (tool is not ("bcdedit" or "powercfg")) throw new InvalidOperationException("Unsupported tool.");
        var info = new ProcessStartInfo { FileName = Path.Combine(Environment.SystemDirectory, tool + ".exe"), UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in args) info.ArgumentList.Add(arg);
        using var process = Process.Start(info) ?? throw new InvalidOperationException($"{tool} could not start.");
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(15000)) { try { process.Kill(true); } catch (InvalidOperationException) { } throw new InvalidOperationException($"{tool} did not finish in time."); }
        if (process.ExitCode != 0) throw new InvalidOperationException($"{tool} refused the request. Administrator rights are required for the boot store and power settings.");
        return output.Result;
    }
}

/// <summary>Boot configuration data through bcdedit with fixed entries, elements and value shapes. Booleans are canonical "on"/"off" (English Yes/No only).</summary>
public sealed class BcdStore(IToolRunner tools)
{
    private static readonly string[] Entries = ["{bootmgr}", "{current}"];
    private static readonly Dictionary<string, Regex> Elements = new()
    {
        ["timeout"] = new("^[0-9]{1,5}$"), ["bootmenupolicy"] = new("^(legacy|standard)$"),
        ["quietboot"] = new("^(on|off)$"), ["hypervisorlaunchtype"] = new("^(off|auto|on)$"),
    };
    private static void Check(string entry, string element) { if (!Entries.Contains(entry) || !Elements.ContainsKey(element)) throw new InvalidOperationException("Unsupported boot setting."); }
    public static string? Parse(string output, string element)
    {
        foreach (var line in output.Split('\n'))
        {
            var match = Regex.Match(line.Trim(), @"^(?<k>[A-Za-z0-9_]+)\s+(?<v>\S.*)$");
            if (!match.Success || !match.Groups["k"].Value.Equals(element, StringComparison.OrdinalIgnoreCase)) continue;
            var value = match.Groups["v"].Value.Trim().ToLowerInvariant();
            value = value switch { "yes" => "on", "no" => "off", _ => value };
            if (!Elements[element].IsMatch(value)) throw new InvalidOperationException("The boot store shows a value Frameforge does not recognise. No change was made.");
            return value;
        }
        return null;
    }
    public string? Get(string entry, string element) { Check(entry, element); return Parse(tools.Run("bcdedit", ["/enum", entry]), element); }
    public void Set(string entry, string element, string value)
    {
        Check(entry, element);
        if (!Elements[element].IsMatch(value)) throw new InvalidOperationException("Invalid boot value.");
        tools.Run("bcdedit", ["/set", entry, element, value]);
    }
    public void Delete(string entry, string element) { Check(entry, element); tools.Run("bcdedit", ["/deletevalue", entry, element]); }
}

/// <summary>Changes only a service's start type (2 automatic, 3 manual, 4 disabled) through the service manager, so the running Windows honours it at once.</summary>
public interface IServiceConfig { void SetStartType(string name, int start); }

public sealed class WindowsRegistryStore(IToolRunner? tools = null, IServiceStore? services = null, IServiceConfig? config = null) : IRegistryStore, IKeyDepth
{
    private readonly IToolRunner runner = tools ?? new SystemTools();
    private readonly WindowsServiceStore real = new();
    private IServiceStore Services => services ?? real;
    private IServiceConfig Config => config ?? real;
    private static readonly TimeSpan ServiceWait = TimeSpan.FromSeconds(20);
    private static string ServiceName(Setting setting) => setting.Path[(setting.Path.LastIndexOf('\\') + 1)..];
    private static (RegistryKey Root, string Sub) Split(Setting setting) =>
        setting.IsMachine ? (Registry.LocalMachine, setting.Path[Setting.Machine.Length..]) : (Registry.CurrentUser, setting.Path);
    private static string Entry(Setting setting) => setting.Path[Setting.BcdPrefix.Length..];

    public ValueState Read(Setting setting)
    {
        if (setting.IsBcd) { var text = new BcdStore(runner).Get(Entry(setting), setting.Name); return new(text is not null, text, "String"); }
        if (setting.Via == "service-stop")
        {
            var info = Services.Query(ServiceName(setting));
            return new(info.Exists, info.Exists ? info.Running ? 1 : 0 : null, "DWord");
        }
        var (root, sub) = Split(setting);
        using var key = root.OpenSubKey(sub, false);
        if (key is null || !key.GetValueNames().Contains(setting.Name, StringComparer.OrdinalIgnoreCase))
        {
            return new(false, null, setting.Kind);
        }
        if (key.GetValueKind(setting.Name).ToString() != setting.Kind) throw new InvalidOperationException("An affected registry value has an unexpected type. No change was made.");
        return new(true, key.GetValue(setting.Name, null, RegistryValueOptions.DoNotExpandEnvironmentNames), setting.Kind);
    }

    public int MissingKeys(Setting setting)
    {
        if (setting.IsBcd) return 0;
        var (root, sub) = Split(setting);
        var missing = 0;
        for (var path = sub; path.Length > 0;)
        {
            using (var key = root.OpenSubKey(path, false)) if (key is not null) break;
            missing++;
            var cut = path.LastIndexOf('\\');
            path = cut < 0 ? "" : path[..cut];
        }
        return missing;
    }

    public void Write(Setting setting, ValueState state)
    {
        if (setting.IsBcd)
        {
            var bcd = new BcdStore(runner);
            if (state.Existed) bcd.Set(Entry(setting), setting.Name, (string)state.Value!); else bcd.Delete(Entry(setting), setting.Name);
            return;
        }
        if (setting.Via == "service-config")
        {
            if (!state.Existed || state.Value is not int start || start is not (2 or 3 or 4)) throw new InvalidOperationException("Invalid service start type.");
            try { Config.SetStartType(ServiceName(setting), start); } catch (System.ComponentModel.Win32Exception error) { throw new InvalidOperationException($"Windows refused to change the {ServiceName(setting)} service (error {error.NativeErrorCode}).", error); }
            return;
        }
        if (setting.Via == "service-stop")
        {
            var name = ServiceName(setting);
            if (!state.Existed || state.Value is not int run || run is not (0 or 1)) throw new InvalidOperationException("Invalid service state.");
            try
            {
                if (!(run == 0 ? Services.Stop(name, ServiceWait) : Services.Start(name, ServiceWait))) throw new InvalidOperationException($"The {name} service did not {(run == 0 ? "stop" : "start")} in time.");
            }
            catch (System.ComponentModel.Win32Exception error) { throw new InvalidOperationException($"Windows refused to {(run == 0 ? "stop" : "start")} the {name} service (error {error.NativeErrorCode}).", error); }
            return;
        }
        if (setting.Via == "hibernate")
        {
            if (!state.Existed || state.Value is not int on || on is not (0 or 1)) throw new InvalidOperationException("Invalid hibernation state.");
            runner.Run("powercfg", ["/hibernate", on == 1 ? "on" : "off"]);
            return;
        }
        var (root, sub) = Split(setting);
        if (state.Existed)
        {
            using var key = root.CreateSubKey(sub, true);
            key.SetValue(setting.Name, state.Value!, setting.Kind == "String" ? RegistryValueKind.String : RegistryValueKind.DWord);
            return;
        }
        using (var key = root.OpenSubKey(sub, true)) key?.DeleteValue(setting.Name, false);
        // Remove the keys this change created, innermost first, only while they are empty.
        var path = sub;
        for (var level = 0; level < setting.OwnKey && path.Length > 0; level++)
        {
            using (var key = root.OpenSubKey(path, false)) if (key is null || key.ValueCount != 0 || key.SubKeyCount != 0) break;
            root.DeleteSubKey(path, false);
            var cut = path.LastIndexOf('\\'); path = cut < 0 ? "" : path[..cut];
        }
    }
}

public sealed class WindowsFacts : IFacts
{
    public int Build() => Environment.OSVersion.Version.Build;
    public bool MachineKeyExists(string path) { using var key = Registry.LocalMachine.OpenSubKey(path, false); return key is not null; }
    // Tamper Protection is only read. 4 means off; any other present value is treated as on so Frameforge never tries around it.
    public string? ServiceBlocker(string name)
    {
        var info = new WindowsServiceStore().Query(name);
        if (!info.Exists || !info.Running) return null;
        if (!info.CanStop) return $"Windows does not allow stopping the {name} service right now.";
        return info.ActiveDependents.Length > 0 ? $"The running service {info.ActiveDependents[0]} depends on {name}." : null;
    }
    public bool TamperProtectionOn()
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows Defender\Features", false);
        return key?.GetValue("TamperProtection") is int value && value != 4;
    }
}

/// <summary>Read-only view of what Microsoft Defender reports (WMI MSFT_MpComputerStatus), shown beside the Defender optimization.</summary>
public static class DefenderStatus
{
    public static (bool? Antivirus, bool? RealTime)? Read()
    {
        try
        {
            using var searcher = new System.Management.ManagementObjectSearcher(new System.Management.ManagementScope(@"root\Microsoft\Windows\Defender"), new System.Management.ObjectQuery("SELECT AntivirusEnabled, RealTimeProtectionEnabled FROM MSFT_MpComputerStatus"), new System.Management.EnumerationOptions { Timeout = TimeSpan.FromSeconds(4) });
            foreach (System.Management.ManagementObject item in searcher.Get())
                using (item) return (item["AntivirusEnabled"] as bool?, item["RealTimeProtectionEnabled"] as bool?);
        }
        catch (Exception error) when (error is System.Management.ManagementException or System.Runtime.InteropServices.COMException or UnauthorizedAccessException or InvalidOperationException) { }
        return null;
    }
    public static string Describe(Func<(bool? Antivirus, bool? RealTime)?>? read = null)
    {
        var state = (read ?? Read)();
        if (state is null) return "Windows did not report Microsoft Defender's state (another antivirus may be managing protection).";
        string Word(bool? on) => on is null ? "unknown" : on.Value ? "on" : "off";
        return $"Defender reports antivirus {Word(state.Value.Antivirus)} and real-time protection {Word(state.Value.RealTime)}.";
    }
}
