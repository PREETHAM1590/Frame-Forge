using System.ComponentModel;
using System.Management;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Frameforge.Windows;

// A registry value as it exists now. Kind is null when the value is absent.
public record RegValue(bool Existed, string? Kind, object? Value);
// What a session writes: the captured prior (absent included) and the value Frameforge set. Revert restores Prior only while Applied is still in place.
public record RegCapture(string Path, string Name, string Kind, bool Existed, object? Value, object Applied);

// Current-user registry only; machine policy is read-only.
public interface IRegistryAccess
{
    RegValue Read(string path, string name);
    void Write(string path, string name, string kind, object value);
    void Delete(string path, string name);
    object? ReadPolicy(string path, string name);
}
public interface IPowerSettings
{
    // Null when the scheme does not expose the setting.
    uint? ReadAc(Guid scheme, Guid setting);
    void WriteAc(Guid scheme, Guid setting, uint value);
}
// ProcessPowerThrottling control and state masks; null when Windows cannot report them.
public interface IPowerThrottling
{
    (uint Control, uint State)? Get(ProcessTarget identity);
    void Set(ProcessTarget identity, uint control, uint state);
}
public interface IGpuInfo { int Count(); }

public sealed class WindowsRegistryAccess : IRegistryAccess
{
    public RegValue Read(string path, string name)
    {
        using var key = Registry.CurrentUser.OpenSubKey(path, false);
        if (key is null || !key.GetValueNames().Contains(name, StringComparer.OrdinalIgnoreCase)) return new(false, null, null);
        return new(true, key.GetValueKind(name).ToString(), key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames));
    }
    public void Write(string path, string name, string kind, object value)
    {
        using var key = Registry.CurrentUser.CreateSubKey(path, true);
        key.SetValue(name, value, kind == "String" ? RegistryValueKind.String : RegistryValueKind.DWord);
    }
    public void Delete(string path, string name)
    {
        using var key = Registry.CurrentUser.OpenSubKey(path, true);
        key?.DeleteValue(name, false);
    }
    public object? ReadPolicy(string path, string name)
    {
        using var key = Registry.LocalMachine.OpenSubKey(path, false);
        return key?.GetValue(name);
    }
}

public sealed class WindowsGpuInfo : IGpuInfo
{
    // Physical adapters sit on the PCI bus; virtual and remote display adapters do not.
    public int Count()
    {
        using var searcher = new ManagementObjectSearcher(new ManagementScope(@"root\CIMV2"), new ObjectQuery("SELECT PNPDeviceID FROM Win32_VideoController"), new System.Management.EnumerationOptions { Timeout = TimeSpan.FromSeconds(4) });
        using var results = searcher.Get();
        return results.Cast<ManagementObject>().Count(item => { using (item) return (item["PNPDeviceID"] as string)?.StartsWith(@"PCI\", StringComparison.OrdinalIgnoreCase) == true; });
    }
}

public sealed class WindowsPowerSettings : IPowerSettings
{
    public uint? ReadAc(Guid scheme, Guid setting)
    {
        var sub = BoosterPaths.SubProcessor;
        var error = PowerReadACValueIndex(IntPtr.Zero, ref scheme, ref sub, ref setting, out var value);
        return error == 0 ? value : error == 2 ? null : throw new Win32Exception((int)error);
    }
    public void WriteAc(Guid scheme, Guid setting, uint value)
    {
        var sub = BoosterPaths.SubProcessor;
        var error = PowerWriteACValueIndex(IntPtr.Zero, ref scheme, ref sub, ref setting, value);
        if (error != 0) throw new Win32Exception((int)error);
    }
    [DllImport("powrprof.dll")] private static extern uint PowerReadACValueIndex(IntPtr root, ref Guid scheme, ref Guid subgroup, ref Guid setting, out uint value);
    [DllImport("powrprof.dll")] private static extern uint PowerWriteACValueIndex(IntPtr root, ref Guid scheme, ref Guid subgroup, ref Guid setting, uint value);
}

public sealed class WindowsPowerThrottling : IPowerThrottling
{
    private const int ProcessPowerThrottlingClass = 4;
    [StructLayout(LayoutKind.Sequential)] private struct State { public uint Version, ControlMask, StateMask; }
    public (uint Control, uint State)? Get(ProcessTarget identity)
    {
        using var handle = WindowsProcessControl.Verified(identity, 0);
        var state = new State { Version = 1 };
        return GetProcessInformation(handle, ProcessPowerThrottlingClass, ref state, (uint)Marshal.SizeOf<State>()) ? (state.ControlMask, state.StateMask) : null;
    }
    public void Set(ProcessTarget identity, uint control, uint stateMask)
    {
        using var handle = WindowsProcessControl.Verified(identity, WindowsProcesses.SetInformation);
        var state = new State { Version = 1, ControlMask = control, StateMask = stateMask };
        if (!SetProcessInformation(handle, ProcessPowerThrottlingClass, ref state, (uint)Marshal.SizeOf<State>())) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessInformation(Microsoft.Win32.SafeHandles.SafeProcessHandle process, int information, ref State state, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetProcessInformation(Microsoft.Win32.SafeHandles.SafeProcessHandle process, int information, ref State state, uint size);
}

public static class BoosterPaths
{
    public static readonly Guid SubProcessor = new("54533251-82be-4824-96c1-47b60b740d00");
    public static readonly Guid CpMinCores = new("0cc5b647-c1df-4637-891a-dec35c318583");
    // Core parking minimum for the second efficiency class; on hybrid CPUs that class is the performance cores.
    public static readonly Guid CpMinCores1 = new("0cc5b647-c1df-4637-891a-dec35c318584");
    public const string GameConfigStore = @"System\GameConfigStore", GameDvr = @"Software\Microsoft\Windows\CurrentVersion\GameDVR", GameBar = @"Software\Microsoft\GameBar";
    public const string DvrPolicyPath = @"SOFTWARE\Policies\Microsoft\Windows\GameDVR", DvrPolicyName = "AllowGameDVR";
    public const string GpuPreferences = @"Software\Microsoft\DirectX\UserGpuPreferences", Layers = @"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers";
    // Overlay and capture values turned to 0 for a session. The Game Mode values and the Game Bar app itself are never touched.
    public static readonly (string Path, string Name)[] GameBarValues =
    [
        (GameConfigStore, "GameDVR_Enabled"), (GameDvr, "AppCaptureEnabled"), (GameDvr, "HistoricalCaptureEnabled"), (GameBar, "UseNexusForGameBarEnabled")
    ];
    // The first three values are what AllowGameDVR=0 already switches off machine-wide.
    public static bool GovernedByDvrPolicy(string name) => name is "GameDVR_Enabled" or "AppCaptureEnabled" or "HistoricalCaptureEnabled";
    public static string SettingName(Guid setting) => setting == CpMinCores ? "cpmincores" : setting == CpMinCores1 ? "cpmincores1" : throw new InvalidOperationException("Invalid saved core parking setting.");
    public static Guid SettingGuid(string? name) => name switch { "cpmincores" => CpMinCores, "cpmincores1" => CpMinCores1, _ => throw new InvalidOperationException("Invalid saved core parking setting.") };

    // Per-exe string values: merged, never replaced, so the user's other flags survive.
    public static string WithGpuPreference(string? prior)
    {
        var pairs = (prior ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
        var index = pairs.FindIndex(p => p.StartsWith("GpuPreference=", StringComparison.OrdinalIgnoreCase));
        if (index >= 0) pairs[index] = "GpuPreference=2"; else pairs.Add("GpuPreference=2");
        return string.Join(';', pairs) + ";";
    }
    public static bool HasGpuPreference(string? value) => (value ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Any(p => p.Equals("GpuPreference=2", StringComparison.OrdinalIgnoreCase));
    public const string FsoFlag = "DISABLEDXMAXIMIZEDWINDOWEDMODE";
    public static string WithFsoOff(string? prior)
    {
        var tokens = (prior ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        if (tokens.Count == 0) return "~ " + FsoFlag;
        if (!tokens.Contains(FsoFlag, StringComparer.OrdinalIgnoreCase)) tokens.Add(FsoFlag);
        return string.Join(' ', tokens);
    }
    public static bool HasFsoOff(string? value) => (value ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).Contains(FsoFlag, StringComparer.OrdinalIgnoreCase);
    // The per-exe value name is a path; only a fully qualified local .exe is accepted, both when applying and when recovering.
    public static bool ValidExe(string? path) => path is not null && path.Length <= 2048 && Path.IsPathFullyQualified(path) && !path.StartsWith(@"\\", StringComparison.Ordinal) && path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);
}
