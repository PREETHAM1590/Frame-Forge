using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace Frameforge.Windows;

// ActiveDependents: services that are running (or starting) and depend on this one.
public record ServiceInfo(bool Exists, bool Running, bool CanStop, string[] ActiveDependents);
// State: "stopped", "started", "skipped" or "failed".
public record ServiceOutcome(string Name, string State, string Detail);
// Declined: the user refused the administrator prompt. Error: the elevated step did not finish or answered unreadably.
public record ServiceBatch(bool Declined, ServiceOutcome[] Outcomes, string? Error = null);
public record ServicePlan(string[] Targets, ServiceOutcome[] Skipped);

public interface IServiceStore
{
    ServiceInfo Query(string name);
    // Stops and waits up to the timeout; true once the service reports Stopped. Never changes the start type.
    bool Stop(string name, TimeSpan timeout);
    bool Start(string name, TimeSpan timeout);
}
public interface IServiceElevator { ServiceBatch Run(string action, string[] names); }
public interface IControllerProbe { bool XboxControllerConnected(); }

// Stop-only pausing: the start type is never changed, so a service that is never restarted comes back after a reboot.
public static class ServicePolicy
{
    // Candidates, in the order they are considered. XboxGipSvc runs the controller firmware and accessory support.
    public static readonly string[] Allowlist =
    [
        "XblAuthManager", "XblGameSave", "XboxNetApiSvc", "XboxGipSvc", "DiagTrack", "WSearch", "SysMain", "Spooler",
        "MapsBroker", "lfsvc", "RetailDemo", "WerSvc", "PhoneSvc", "TrkWks"
    ];
    // Needed for Xbox, Game Pass and Microsoft Store titles (sign-in, saves, multiplayer).
    public static readonly string[] StoreServices = ["XblAuthManager", "XblGameSave", "XboxNetApiSvc"];
    // Hard-coded and not user-editable. Windows Update is denied here although the research allows pausing it.
    public static readonly HashSet<string> Deny = new(StringComparer.OrdinalIgnoreCase)
    {
        // Core OS
        "RpcSs", "RpcEptMapper", "DcomLaunch", "LSM", "BrokerInfrastructure", "CoreMessaging", "PlugPlay", "Power", "ProfSvc", "UserManager", "Winmgmt", "EventLog",
        "EventSystem", "SENS", "SystemEventsBroker", "TimeBrokerSvc", "Schedule", "CryptSvc", "TrustedInstaller", "UxSms", "Themes", "StateRepository", "ShellHWDetection",
        "DeviceInstall", "DsmSvc", "gpsvc", "nsi", "StorSvc", "Appinfo", "KeyIso", "SamSs", "lmhosts", "ProfSvc", "UserDataSvc", "CDPSvc", "CDPUserSvc", "TextInputManagementService",
        // Audio
        "Audiosrv", "AudioEndpointBuilder", "MMCSS",
        // Networking
        "Dhcp", "Dnscache", "NlaSvc", "netprofm", "LanmanWorkstation", "LanmanServer", "WlanSvc", "BFE", "mpssvc", "Wcmsvc", "iphlpsvc", "IKEEXT", "WinHttpAutoProxySvc", "RmSvc",
        // Input and Bluetooth
        "hidserv", "BthServ", "BthAvctpSvc", "bthserv", "TabletInputService", "XboxGipSvcDrivers",
        // Security
        "WinDefend", "WdNisSvc", "Sense", "SecurityHealthService", "wscsvc", "WdFilter", "WdBoot",
        // Windows Update and its helpers
        "wuauserv", "UsoSvc", "WaaSMedicSvc", "sedsvc", "BITS", "DoSvc", "InstallService",
        // Anti-cheat and DRM
        "EasyAntiCheat", "EasyAntiCheat_EOS", "BEService", "vgc", "vgk", "FACEIT", "faceit", "PnkBstrA", "PnkBstrB", "xhunter1", "Steam Client Service", "EpicOnlineServices",
        // GPU
        "NVDisplay.ContainerLocalSystem", "NvContainerLocalSystem", "AMD External Events Utility", "WMIRegistrationService"
    };
    // Prefix families that are always denied (peripheral software, anti-cheat, GPU vendors, Game Pass).
    public static readonly string[] DenyPrefixes =
    [
        "GamingServices", "Wacom", "Razer", "LGHUB", "Corsair", "SteelSeries", "Ricochet", "mhyprot", "Battle.net", "Nv", "AMD", "Intel", "igfx", "EasyAntiCheat", "NVDisplay"
    ];
    public static bool Denied(string name) => Deny.Contains(name) || DenyPrefixes.Any(p => name.StartsWith(p, StringComparison.OrdinalIgnoreCase));
    public static bool Allowed(string name) => Allowlist.Contains(name, StringComparer.OrdinalIgnoreCase) && !Denied(name);

    // Which allowlisted services are running now and may be stopped. Each skipped one carries its reason.
    public static ServicePlan Plan(IServiceStore store, bool storeGame, bool controllerConnected)
    {
        var skipped = new List<ServiceOutcome>();
        var info = new Dictionary<string, ServiceInfo>(StringComparer.OrdinalIgnoreCase);
        var candidates = new List<string>();
        foreach (var name in Allowlist)
        {
            if (Denied(name)) { skipped.Add(new(name, "skipped", "On the never-pause list.")); continue; }
            if (storeGame && StoreServices.Contains(name)) { skipped.Add(new(name, "skipped", "This game comes from the Xbox app or Microsoft Store, which need this service.")); continue; }
            if (name == "XboxGipSvc" && controllerConnected) { skipped.Add(new(name, "skipped", "An Xbox controller is connected; this service supports it.")); continue; }
            var current = store.Query(name);
            info[name] = current;
            if (!current.Exists) skipped.Add(new(name, "skipped", "Not installed on this PC."));
            else if (!current.Running) skipped.Add(new(name, "skipped", "Not running; left as it is."));
            else if (!current.CanStop) skipped.Add(new(name, "skipped", "Windows does not allow stopping it right now."));
            else candidates.Add(name);
        }
        // A service with a running dependent that is not itself being paused would take that dependent down: leave both alone.
        bool changed;
        do
        {
            changed = false;
            foreach (var name in candidates.ToArray())
            {
                var blocker = info[name].ActiveDependents.FirstOrDefault(d => !candidates.Contains(d, StringComparer.OrdinalIgnoreCase));
                if (blocker is null) continue;
                candidates.Remove(name);
                skipped.Add(new(name, "skipped", $"The running service {blocker} depends on it, so it is left alone."));
                changed = true;
            }
        } while (changed);
        return new(StopOrder(candidates, name => info[name].ActiveDependents), [.. skipped]);
    }
    // Dependents first, so no stop is refused for a running dependent; reverse it to start required services before their dependents.
    public static string[] StopOrder(IEnumerable<string> names, Func<string, string[]> dependents)
    {
        var set = names.ToList();
        var ordered = new List<string>();
        void Visit(string name)
        {
            if (ordered.Contains(name, StringComparer.OrdinalIgnoreCase)) return;
            foreach (var dependent in dependents(name).Where(d => set.Contains(d, StringComparer.OrdinalIgnoreCase))) Visit(dependent);
            if (!ordered.Contains(name, StringComparer.OrdinalIgnoreCase)) ordered.Add(name);
        }
        foreach (var name in set) Visit(name);
        return [.. ordered];
    }
}

public static class ServiceCommands
{
    public static readonly TimeSpan StopWait = TimeSpan.FromSeconds(5), StartWait = TimeSpan.FromSeconds(10);
    private static readonly Regex ResultName = new(@"\Aframeforge-[0-9a-f]{32}\.json\z");
    public const int MaxServices = 32;

    // Runs inside the elevated instance (or inline when the helper is already elevated). Re-checks everything itself.
    public static ServiceBatch Execute(string action, string[] names, IServiceStore store, IControllerProbe controllers)
    {
        if (action is not ("stop" or "start") || names.Length is 0 or > MaxServices || names.Any(n => !ServicePolicy.Allowed(n)) || names.Distinct(StringComparer.OrdinalIgnoreCase).Count() != names.Length)
            throw new InvalidOperationException("Unsupported service request.");
        var outcomes = new List<ServiceOutcome>();
        foreach (var name in action == "stop" ? Resolve(names, store) : names)
        {
            try
            {
                var info = store.Query(name);
                if (!info.Exists) { outcomes.Add(new(name, "skipped", "Not installed.")); continue; }
                if (action == "start")
                {
                    if (info.Running) { outcomes.Add(new(name, "skipped", "Already running.")); continue; }
                    outcomes.Add(store.Start(name, StartWait) ? new(name, "started", "Started.") : new(name, "failed", "Windows did not report it running in time."));
                    continue;
                }
                if (!info.Running) outcomes.Add(new(name, "skipped", "Not running."));
                else if (!info.CanStop) outcomes.Add(new(name, "skipped", "Windows does not allow stopping it right now."));
                else if (name == "XboxGipSvc" && controllers.XboxControllerConnected()) outcomes.Add(new(name, "skipped", "An Xbox controller is connected."));
                else if (info.ActiveDependents.FirstOrDefault(d => !names.Contains(d, StringComparer.OrdinalIgnoreCase)) is { } blocker) outcomes.Add(new(name, "skipped", $"The running service {blocker} depends on it."));
                else outcomes.Add(store.Stop(name, StopWait) ? new(name, "stopped", "Stopped.") : new(name, "failed", "It did not stop within 5 seconds; left as it is."));
            }
            catch (Win32Exception error) { outcomes.Add(new(name, "failed", $"Windows refused (error {error.NativeErrorCode}).")); }
        }
        return new(false, [.. outcomes]);
    }
    private static string[] Resolve(string[] names, IServiceStore store) => ServicePolicy.StopOrder(names, name => { try { return store.Query(name).ActiveDependents; } catch (Win32Exception) { return []; } });

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
    // Entry point for `--elevated-services <action> <resultPath> <name>...`. Writes exactly one JSON object to the result file.
    public static int RunElevatedChild(string[] argv, Func<object, string> serialize)
    {
        if (argv.Length < 3 || !RestoreCommands.ValidResultPath(argv[1])) return 2;
        using var file = new FileStream(argv[1], FileMode.Open, FileAccess.Write, FileShare.None);
        if (file.Length != 0 || !string.Equals(FinalPath(file.SafeFileHandle), argv[1], StringComparison.OrdinalIgnoreCase)) return 2;
        object result;
        try { result = Execute(argv[0], argv[2..], new WindowsServiceStore(), new WindowsControllerProbe()); }
        catch (Exception error) { result = new ServiceBatch(false, [], error is InvalidOperationException ? error.Message : "Windows could not complete the service request."); }
        file.Write(Encoding.UTF8.GetBytes(serialize(result)));
        return 0;
    }
}

// GC-7 for services: the helper starts itself with the runas verb and reads a validated result file. No argument string is built.
public sealed class WindowsServiceElevator(TimeSpan? childWait = null) : IServiceElevator
{
    private static readonly Regex Name = new(@"\Aframeforge-[0-9a-f]{32}\.json\z");
    // One stop pass waits at most 5 s per service, 32 services; the wait starts after the administrator approved.
    private readonly TimeSpan wait = childWait ?? TimeSpan.FromSeconds(200);
    public ServiceBatch Run(string action, string[] names)
    {
        if (action is not ("stop" or "start") || names.Length is 0 or > ServiceCommands.MaxServices || names.Any(n => !ServicePolicy.Allowed(n)))
            throw new InvalidOperationException("Unsupported service request.");
        if (RestoreCommands.IsElevated()) return ServiceCommands.Execute(action, names, new WindowsServiceStore(), new WindowsControllerProbe());
        var resultPath = Path.Combine(Path.GetTempPath(), $"frameforge-{Guid.NewGuid():N}.json");
        using (new FileStream(resultPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) { }
        try
        {
            var info = new ProcessStartInfo { FileName = Environment.ProcessPath!, UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden };
            foreach (var argument in new[] { "--elevated-services", action, resultPath }.Concat(names)) info.ArgumentList.Add(argument);
            Process? child;
            try { child = Process.Start(info); }
            catch (Win32Exception error) when (error.NativeErrorCode == 1223) { return new(true, []); }
            using (child)
            {
                if (child is null) return new(false, [], "The administrator request could not start.");
                if (!child.WaitForExit(wait)) return new(false, [], "The administrator step did not finish in time.");
                if (child.ExitCode == 2) return new(false, [], "The administrator step rejected its result file. Nothing was changed.");
            }
            var text = File.ReadAllText(resultPath);
            if (text.Length is 0 or > 1024 * 1024) return new(false, [], "The administrator step returned no result.");
            var batch = JsonSerializer.Deserialize<ServiceBatch>(text, HelperJson.Options) ?? new(false, [], "Unreadable administrator result.");
            return batch.Outcomes.Length > ServiceCommands.MaxServices ? new(false, [], "Unreadable administrator result.") : batch;
        }
        finally
        {
            try { if (Name.IsMatch(Path.GetFileName(resultPath))) File.Delete(resultPath); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { /* Temp cleanup is best effort. */ }
        }
    }
}

public sealed class WindowsControllerProbe : IControllerProbe
{
    [StructLayout(LayoutKind.Sequential)] private struct XInputState { public uint Packet; public ushort Buttons; public byte LeftTrigger, RightTrigger; public short LX, LY, RX, RY; }
    // XInput answers 0 for a connected controller in slots 0 to 3.
    public bool XboxControllerConnected()
    {
        try { for (uint slot = 0; slot < 4; slot++) if (XInputGetState(slot, out _) == 0) return true; return false; }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException) { return true; }
    }
    [DllImport("xinput1_4.dll")] private static extern uint XInputGetState(uint index, out XInputState state);
}

// Service control manager access; the query side needs no administrator rights.
public sealed class WindowsServiceStore : IServiceStore
{
    private const uint Connect = 1, QueryStatus = 4, EnumerateDependents = 8, StartRight = 0x10, StopRight = 0x20;
    private const uint Stopped = 1, StopPending = 3, Running = 4;
    private static IntPtr Manager()
    {
        var manager = OpenSCManagerW(null, null, Connect);
        return manager != IntPtr.Zero ? manager : throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    // Null when the service does not exist.
    private static IntPtr Open(IntPtr manager, string name, uint access)
    {
        var service = OpenServiceW(manager, name, access);
        if (service != IntPtr.Zero) return service;
        var error = Marshal.GetLastWin32Error();
        return error == 1060 ? IntPtr.Zero : throw new Win32Exception(error);
    }
    private static (uint State, uint Accepted) Status(IntPtr service)
    {
        var buffer = Marshal.AllocHGlobal(36);
        try
        {
            if (!QueryServiceStatusEx(service, 0, buffer, 36, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return ((uint)Marshal.ReadInt32(buffer, 4), (uint)Marshal.ReadInt32(buffer, 8));
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    public ServiceInfo Query(string name)
    {
        var manager = Manager();
        try
        {
            var service = Open(manager, name, QueryStatus | EnumerateDependents);
            if (service == IntPtr.Zero) return new(false, false, false, []);
            try
            {
                var (state, accepted) = Status(service);
                return new(true, state is Running or 2, (accepted & 1) != 0, Dependents(service));
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
    // ENUM_SERVICE_STATUSW: name pointer, display name pointer, then a 28-byte SERVICE_STATUS (48 bytes with alignment on x64).
    private static string[] Dependents(IntPtr service)
    {
        EnumDependentServicesW(service, 1, IntPtr.Zero, 0, out var needed, out var count);
        if (needed == 0) return [];
        var buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!EnumDependentServicesW(service, 1, buffer, needed, out _, out count)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return Enumerable.Range(0, (int)count).Select(i => Marshal.PtrToStringUni(Marshal.ReadIntPtr(buffer, i * 48)) ?? "").Where(n => n.Length > 0).ToArray();
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    public bool Stop(string name, TimeSpan timeout) => Change(name, StopRight, service =>
    {
        var status = new byte[28];
        if (!ControlService(service, 1, status) && Marshal.GetLastWin32Error() != 1062) throw new Win32Exception(Marshal.GetLastWin32Error());
    }, Stopped, timeout);
    public bool Start(string name, TimeSpan timeout) => Change(name, StartRight, service =>
    {
        if (!StartServiceW(service, 0, IntPtr.Zero) && Marshal.GetLastWin32Error() != 1056) throw new Win32Exception(Marshal.GetLastWin32Error());
    }, Running, timeout);
    private static bool Change(string name, uint right, Action<IntPtr> act, uint wanted, TimeSpan timeout)
    {
        var manager = Manager();
        try
        {
            var service = Open(manager, name, QueryStatus | right);
            if (service == IntPtr.Zero) throw new InvalidOperationException($"{name} is not installed.");
            try
            {
                act(service);
                var deadline = DateTime.UtcNow + timeout;
                while (true)
                {
                    if (Status(service).State == wanted) return true;
                    if (DateTime.UtcNow >= deadline) return false;
                    Thread.Sleep(100);
                }
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenSCManagerW(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CloseServiceHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatusEx(IntPtr service, int level, IntPtr buffer, uint size, out uint needed);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool EnumDependentServicesW(IntPtr service, uint state, IntPtr buffer, uint size, out uint needed, out uint count);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool ControlService(IntPtr service, uint control, byte[] status);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool StartServiceW(IntPtr service, uint argc, IntPtr argv);
}
