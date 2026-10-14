using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Frameforge.Windows;

// ActiveDependents: services that are running (or starting) and depend on this one. StopPending: it is still shutting down.
public record ServiceInfo(bool Exists, bool Running, bool CanStop, string[] ActiveDependents, bool StopPending = false);
// State: "stopped", "started", "skipped" or "failed". Code is a stable kebab-case reason (see ServiceCodes).
public record ServiceOutcome(string Name, string State, string Detail, string? Code = null);
// Declined: the user refused the administrator prompt. Error and Code: the elevated step did not finish or answered unreadably.
// Purge: the standby memory list step, when the request asked for it (State "purged" or "failed").
public record ServiceBatch(bool Declined, ServiceOutcome[] Outcomes, string? Error = null, string? Code = null, ServiceOutcome? Purge = null);
public record ServicePlan(string[] Targets, ServiceOutcome[] Skipped);

public static class ServiceCodes
{
    public const string ElevationCancelled = "elevation-cancelled", ElevationFailed = "elevation-failed", ElevationTimeout = "elevation-timeout", ResultRejected = "result-rejected", ResultUnreadable = "result-unreadable",
        ElevationExpired = "elevation-expired", StoppedAgain = "stopped-again", PurgeFailed = "purge-failed";
    public const string NotInstalled = "not-installed", NotRunning = "not-running", CannotStop = "cannot-stop", HasDependents = "has-dependents", ControllerConnected = "controller-connected",
        StoreGame = "store-game", Denied = "denied", StopTimeout = "stop-timeout", StartTimeout = "start-timeout", StopPending = "stop-pending", AccessDenied = "access-denied", ServiceError = "service-error";
}

public interface IServiceStore
{
    ServiceInfo Query(string name);
    // Stops and waits up to the timeout; true once the service reports Stopped. Never changes the start type.
    bool Stop(string name, TimeSpan timeout);
    bool Start(string name, TimeSpan timeout);
    // After a start: true when the service is still running at the end of the window. Otherwise exitCode is what Windows last reported for it.
    bool StaysRunning(string name, TimeSpan window, out uint exitCode)
    {
        exitCode = 0;
        for (var deadline = DateTime.UtcNow + window; ; Thread.Sleep(100))
        {
            if (!Query(name).Running) return false;
            if (DateTime.UtcNow >= deadline) return true;
        }
    }
}
// cancel: the user stopped the boost while the administrator prompt was still open. Withdraws the request; nothing is changed.
public interface IServiceElevator { ServiceBatch Run(string action, string[] names, CancellationToken cancel = default); }
// The standby memory list: cached pages Windows can reuse. Returns null on success or the reason it failed.
public interface IMemoryPurger { string? Purge(); }
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
    // The allowlist is the real guard (Allowed needs both); this list documents what must never be added to it.
    public static readonly HashSet<string> Deny = new(StringComparer.OrdinalIgnoreCase)
    {
        // Core OS
        "RpcSs", "RpcEptMapper", "DcomLaunch", "LSM", "BrokerInfrastructure", "CoreMessaging", "PlugPlay", "Power", "ProfSvc", "UserManager", "Winmgmt", "EventLog",
        "EventSystem", "SENS", "SystemEventsBroker", "TimeBrokerSvc", "Schedule", "CryptSvc", "TrustedInstaller", "UxSms", "Themes", "StateRepository", "ShellHWDetection",
        "DeviceInstall", "DsmSvc", "gpsvc", "nsi", "StorSvc", "Appinfo", "KeyIso", "SamSs", "lmhosts", "UserDataSvc", "CDPSvc", "TextInputManagementService",
        // Audio
        "Audiosrv", "AudioEndpointBuilder", "MMCSS",
        // Networking
        "Dhcp", "Dnscache", "NlaSvc", "netprofm", "LanmanWorkstation", "LanmanServer", "WlanSvc", "BFE", "mpssvc", "Wcmsvc", "iphlpsvc", "IKEEXT", "WinHttpAutoProxySvc",
        // Input and Bluetooth
        "hidserv", "BthServ", "BthAvctpSvc", "bthserv", "TabletInputService",
        // Security
        "WinDefend", "WdNisSvc", "Sense", "SecurityHealthService", "wscsvc",
        // Windows Update and its helpers
        "wuauserv", "UsoSvc", "WaaSMedicSvc", "sedsvc", "BITS", "DoSvc", "InstallService",
        // Anti-cheat and DRM
        "EasyAntiCheat", "EasyAntiCheat_EOS", "BEService", "vgc", "vgk", "FACEIT", "faceit", "PnkBstrA", "PnkBstrB", "xhunter1", "Steam Client Service", "EpicOnlineServices",
        // GPU
        "NVDisplay.ContainerLocalSystem", "NvContainerLocalSystem", "AMD External Events Utility", "WMIRegistrationService"
    };
    // Prefix families that are always denied: peripheral software, anti-cheat, GPU vendors, Game Pass and common third-party antivirus.
    public static readonly string[] DenyPrefixes =
    [
        "GamingServices", "Wacom", "Razer", "LGHUB", "Corsair", "SteelSeries", "Ricochet", "mhyprot", "Battle.net", "Nv", "AMD", "Intel", "igfx", "EasyAntiCheat", "NVDisplay",
        "avast", "AVG", "McAfee", "mfe", "Norton", "Symantec", "Kaspersky", "avp", "ekrn", "Bitdefender", "bdservicehost", "Malwarebytes", "MBAM", "Sophos", "ESET", "Trend", "Webroot"
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
            if (Denied(name)) { skipped.Add(new(name, "skipped", "On the never-pause list.", ServiceCodes.Denied)); continue; }
            if (storeGame && StoreServices.Contains(name)) { skipped.Add(new(name, "skipped", "This game comes from the Xbox app or Microsoft Store, which need this service.", ServiceCodes.StoreGame)); continue; }
            if (name == "XboxGipSvc" && controllerConnected) { skipped.Add(new(name, "skipped", "An Xbox controller is connected; this service supports it.", ServiceCodes.ControllerConnected)); continue; }
            var current = store.Query(name);
            info[name] = current;
            if (!current.Exists) skipped.Add(new(name, "skipped", "Not installed on this PC.", ServiceCodes.NotInstalled));
            else if (!current.Running) skipped.Add(new(name, "skipped", "Not running; left as it is.", ServiceCodes.NotRunning));
            else if (!current.CanStop) skipped.Add(new(name, "skipped", "Windows does not allow stopping it right now.", ServiceCodes.CannotStop));
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
                skipped.Add(new(name, "skipped", $"The running service {blocker} depends on it, so it is left alone.", ServiceCodes.HasDependents));
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
    public static readonly TimeSpan StopWait = TimeSpan.FromSeconds(5), StartWait = TimeSpan.FromSeconds(10), StableWait = TimeSpan.FromSeconds(5);
    public const int MaxServices = 32;
    public static bool ValidAction(string action) => action is "stop" or "start" or "stop-purge" or "purge";
    public static bool ValidNames(string action, string[] names) =>
        (action == "purge" ? names.Length == 0 : names.Length is > 0 and <= MaxServices) && names.All(ServicePolicy.Allowed);

    // Runs inside the elevated instance (or inline when the helper is already elevated). Re-checks everything itself.
    // One failing service never discards the outcomes already collected.
    public static ServiceBatch Execute(string action, string[] names, IServiceStore store, IControllerProbe controllers, IMemoryPurger? purger = null, TimeSpan? stable = null)
    {
        if (!ValidAction(action) || !ValidNames(action, names) || names.Distinct(StringComparer.OrdinalIgnoreCase).Count() != names.Length)
            throw new InvalidOperationException("Unsupported service request.");
        var outcomes = new List<ServiceOutcome>();
        var verb = action == "stop-purge" ? "stop" : action;
        if (verb == "start") outcomes.AddRange(StartAll(names, store, stable ?? StableWait));
        else
            foreach (var name in verb == "stop" ? Resolve(names, store) : names)
            {
                try { outcomes.Add(One(name, names, store, controllers)); }
                catch (Win32Exception error) { outcomes.Add(Refused(name, error)); }
                catch (InvalidOperationException error) { outcomes.Add(new(name, "failed", error.Message, ServiceCodes.ServiceError)); }
            }
        // One-shot and not reversible; harmless, because Windows refills the cache as programs need it.
        ServiceOutcome? purge = null;
        if (action is "stop-purge" or "purge")
        {
            string? failure;
            try { failure = purger is null ? "Memory control is not available in this build." : purger.Purge(); }
            catch (Exception error) when (error is Win32Exception or InvalidOperationException or DllNotFoundException or EntryPointNotFoundException) { failure = "Windows refused the request."; }
            purge = failure is null ? new("standby-list", "purged", "Standby memory list cleared.") : new("standby-list", "failed", failure, ServiceCodes.PurgeFailed);
        }
        return new(false, [.. outcomes], Purge: purge);
    }
    private static ServiceOutcome Refused(string name, Win32Exception error) =>
        new(name, "failed", $"Windows refused (error {error.NativeErrorCode}).", error.NativeErrorCode == 5 ? ServiceCodes.AccessDenied : ServiceCodes.ServiceError);
    // Running is not enough: a service can start and die a moment later (SysMain did once). Every service is started first, then all are
    // watched in one shared window (not one window each, which would add 5 s per service); the ones that died get one more start and watch.
    private static List<ServiceOutcome> StartAll(string[] names, IServiceStore store, TimeSpan stable)
    {
        var results = new Dictionary<string, ServiceOutcome>(StringComparer.OrdinalIgnoreCase);
        var watching = new List<string>();
        foreach (var name in names)
        {
            try
            {
                var info = store.Query(name);
                if (!info.Exists) results[name] = new(name, "skipped", "Not installed.", ServiceCodes.NotInstalled);
                else if (info.Running) results[name] = new(name, "skipped", "Already running.");
                else if (info.StopPending) results[name] = new(name, "failed", "It is still shutting down. Retry in a moment.", ServiceCodes.StopPending);
                else if (store.Start(name, StartWait)) watching.Add(name);
                else results[name] = new(name, "failed", "Windows did not report it running in time.", ServiceCodes.StartTimeout);
            }
            catch (Win32Exception error) { results[name] = Refused(name, error); }
            catch (InvalidOperationException error) { results[name] = new(name, "failed", error.Message, ServiceCodes.ServiceError); }
        }
        var (alive, dead) = Watch(watching, store, stable);
        foreach (var name in alive) results[name] = new(name, "started", "Started and still running.");
        var again = new List<string>();
        foreach (var (name, code) in dead)
        {
            try
            {
                if (store.Start(name, StartWait)) again.Add(name);
                else results[name] = new(name, "failed", $"It stopped again after starting (Windows error {code}) and did not start a second time.", ServiceCodes.StartTimeout);
            }
            catch (Win32Exception error) { results[name] = Refused(name, error); }
            catch (InvalidOperationException error) { results[name] = new(name, "failed", error.Message, ServiceCodes.ServiceError); }
        }
        var (alive2, dead2) = Watch(again, store, stable);
        foreach (var name in alive2) results[name] = new(name, "started", "Started and still running (second try).");
        foreach (var (name, code) in dead2) results[name] = new(name, "failed", $"It started but stopped again, twice (Windows error {code}).", ServiceCodes.StoppedAgain);
        return [.. names.Select(n => results[n])];
    }
    private static (List<string> Alive, List<(string Name, uint Code)> Dead) Watch(List<string> names, IServiceStore store, TimeSpan window)
    {
        var alive = new List<string>(); var dead = new List<(string, uint)>();
        var deadline = DateTime.UtcNow + window;
        foreach (var name in names)
        {
            var left = deadline - DateTime.UtcNow;
            uint code;
            try
            {
                if (store.StaysRunning(name, left < TimeSpan.Zero ? TimeSpan.Zero : left, out code)) alive.Add(name);
                else dead.Add((name, code));
            }
            catch (Win32Exception error) { dead.Add((name, (uint)error.NativeErrorCode)); }
        }
        return (alive, dead);
    }
    private static ServiceOutcome One(string name, string[] names, IServiceStore store, IControllerProbe controllers)
    {
        var info = store.Query(name);
        if (!info.Exists) return new(name, "skipped", "Not installed.", ServiceCodes.NotInstalled);
        if (!info.Running) return new(name, "skipped", "Not running.", ServiceCodes.NotRunning);
        if (!info.CanStop) return new(name, "skipped", "Windows does not allow stopping it right now.", ServiceCodes.CannotStop);
        if (name == "XboxGipSvc" && controllers.XboxControllerConnected()) return new(name, "skipped", "An Xbox controller is connected.", ServiceCodes.ControllerConnected);
        if (info.ActiveDependents.FirstOrDefault(d => !names.Contains(d, StringComparer.OrdinalIgnoreCase)) is { } blocker)
            return new(name, "skipped", $"The running service {blocker} depends on it.", ServiceCodes.HasDependents);
        return store.Stop(name, StopWait)
            ? new(name, "stopped", "Stopped.")
            : new(name, "failed", "It did not stop within 5 seconds. Frameforge checks again at the end of the session and restarts it if it stopped late.", ServiceCodes.StopTimeout);
    }
    private static string[] Resolve(string[] names, IServiceStore store) => ServicePolicy.StopOrder(names, name => { try { return store.Query(name).ActiveDependents; } catch (Win32Exception) { return []; } });

    // Entry point for `--elevated-services <action> <resultPath> <name>...`. Writes exactly one JSON object to the result file.
    public static int RunElevatedChild(string[] argv, Func<object, string> serialize, IServiceStore? store = null, IControllerProbe? controllers = null, IMemoryPurger? purger = null)
    {
        if (argv.Length < 2) return 2;
        using var file = ElevatedCall.OpenResult(argv[1], out var rejected);
        if (file is null) return rejected;
        object result;
        try { result = Execute(argv[0], argv[2..], store ?? new WindowsServiceStore(), controllers ?? new WindowsControllerProbe(), purger ?? new WindowsMemoryPurger()); }
        catch (Exception error) { result = new ServiceBatch(false, [], error is InvalidOperationException ? error.Message : "Windows could not complete the service request.", ServiceCodes.ServiceError); }
        file.Write(Encoding.UTF8.GetBytes(serialize(result)));
        return 0;
    }
}

// GC-7 for services: the helper starts itself with the runas verb and reads a validated result file. No argument string is built.
// The result file lifecycle (canonical path from the created handle, stale sweep, kept while the child may still write) is
// the restore points' own, shared through RestoreCommands. A request file next to it (see ElevationRequest) is withdrawn when the
// boost is stopped or nobody answers the prompt, so a late approval changes nothing.
public sealed class WindowsServiceElevator(TimeSpan? childWait = null, IElevatedLauncher? launcher = null, TimeSpan? approvalBudget = null, TimeSpan? grace = null, bool? elevated = null) : IServiceElevator
{
    // How long the administrator prompt may stay unanswered.
    public static readonly TimeSpan ApprovalBudget = TimeSpan.FromSeconds(120);
    // One stop pass waits at most 5 s per service, 32 services; the wait starts after the administrator approved.
    private readonly TimeSpan wait = childWait ?? TimeSpan.FromSeconds(200);
    // Creates the empty result file the elevated child will fill and returns its canonical path. The child compares that exact string
    // with GetFinalPathNameByHandle, so a short (8.3) or junctioned TEMP must be resolved here, as the restore points do.
    public static string NewResultPath(string? directory = null)
    {
        RestoreCommands.SweepStaleResults();
        var draft = Path.Combine(directory ?? Path.GetTempPath(), $"frameforge-{Guid.NewGuid():N}.json");
        using var file = new FileStream(draft, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        return RestoreCommands.FinalPath(file.SafeFileHandle);
    }
    public ServiceBatch Run(string action, string[] names, CancellationToken cancel = default)
    {
        if (!ServiceCommands.ValidAction(action) || !ServiceCommands.ValidNames(action, names))
            throw new InvalidOperationException("Unsupported service request.");
        if (elevated ?? RestoreCommands.IsElevated()) return ServiceCommands.Execute(action, names, new WindowsServiceStore(), new WindowsControllerProbe(), new WindowsMemoryPurger());
        var budget = approvalBudget ?? ApprovalBudget;
        if (cancel.IsCancellationRequested) return Withdrawn(ElevationStatus.Cancelled, budget);
        var outcome = ElevatedCall.Run(launcher ?? new WindowsElevatedLauncher(), "--elevated-services", action, names, budget, wait, cancel, grace);
        return outcome.Status switch
        {
            ElevationStatus.Declined => new(true, [], "Administrator approval was declined.", ServiceCodes.ElevationCancelled),
            ElevationStatus.NotApproved or ElevationStatus.Cancelled => Withdrawn(outcome.Status, budget),
            ElevationStatus.Expired => new(true, [], "The administrator request expired before it was approved. Nothing was changed.", ServiceCodes.ElevationExpired),
            ElevationStatus.NoChild => new(false, [], "The administrator request could not start.", ServiceCodes.ElevationFailed),
            ElevationStatus.ChildTimeout => new(false, [], "The administrator step did not finish in time.", ServiceCodes.ElevationTimeout),
            ElevationStatus.Rejected => new(false, [], "The administrator step rejected its result file. Nothing was changed.", ServiceCodes.ResultRejected),
            _ => Read(outcome.Text)
        };
    }
    // Nothing was approved, so nothing was changed: the journal can be released.
    private static ServiceBatch Withdrawn(ElevationStatus status, TimeSpan budget) => status == ElevationStatus.Cancelled
        ? new(true, [], "The boost was stopped before administrator approval, so nothing was changed.", ServiceCodes.ElevationCancelled)
        : new(true, [], $"Administrator approval was not given within {budget.TotalMinutes:0.#} minutes, so nothing was changed. A prompt that is still open does nothing now.", ServiceCodes.ElevationTimeout);
    private static ServiceBatch Read(string? text)
    {
        if (text is null || text.Length is 0 or > 1024 * 1024) return new(false, [], "The administrator step returned no result.", ServiceCodes.ResultUnreadable);
        ServiceBatch? batch;
        try { batch = JsonSerializer.Deserialize<ServiceBatch>(text, HelperJson.Options); }
        catch (JsonException) { batch = null; }
        return batch is null || batch.Outcomes is null || batch.Outcomes.Length > ServiceCommands.MaxServices
            ? new(false, [], "Unreadable administrator result.", ServiceCodes.ResultUnreadable)
            : batch;
    }
}

// NtSetSystemInformation(SystemMemoryListInformation = 0x50) with MemoryPurgeStandbyList (4); needs SeProfileSingleProcessPrivilege.
public sealed class WindowsMemoryPurger : IMemoryPurger
{
    private const int SystemMemoryListInformation = 0x50, MemoryPurgeStandbyList = 4;
    [StructLayout(LayoutKind.Sequential, Pack = 4)] private struct TokenPrivileges { public uint Count; public long Luid; public uint Attributes; }
    public string? Purge()
    {
        if (!OpenProcessToken(GetCurrentProcess(), 0x28, out var token)) return $"Windows refused the request (error {Marshal.GetLastWin32Error()}).";
        try
        {
            if (!LookupPrivilegeValueW(null, "SeProfileSingleProcessPrivilege", out var luid)) return $"Windows refused the request (error {Marshal.GetLastWin32Error()}).";
            var privileges = new TokenPrivileges { Count = 1, Luid = luid, Attributes = 2 };
            // AdjustTokenPrivileges succeeds even when the privilege was not granted; only the last error tells.
            if (!AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero) || Marshal.GetLastWin32Error() != 0)
                return "Windows did not grant the memory privilege, so the standby list was not cleared.";
        }
        finally { CloseHandle(token); }
        var command = MemoryPurgeStandbyList;
        var status = NtSetSystemInformation(SystemMemoryListInformation, ref command, sizeof(int));
        return status == 0 ? null : $"Windows refused to clear the standby list (status 0x{status:X8}).";
    }
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool LookupPrivilegeValueW(string? system, string name, out long luid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivileges state, uint length, IntPtr previous, IntPtr returnLength);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll")] private static extern int NtSetSystemInformation(int informationClass, ref int information, int length);
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
public sealed class WindowsServiceStore : IServiceStore, IServiceConfig
{
    private const uint Connect = 1, QueryStatus = 4, EnumerateDependents = 8, StartRight = 0x10, StopRight = 0x20;
    private const uint Stopped = 1, StopPendingState = 3, Running = 4;
    private static readonly TimeSpan PendingWait = TimeSpan.FromSeconds(3);
    private static IntPtr Manager()
    {
        var manager = OpenSCManagerW(null, null, Connect);
        return manager != IntPtr.Zero ? manager : throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    // Zero when the service does not exist.
    private static IntPtr Open(IntPtr manager, string name, uint access)
    {
        var service = OpenServiceW(manager, name, access);
        if (service != IntPtr.Zero) return service;
        var error = Marshal.GetLastWin32Error();
        return error == 1060 ? IntPtr.Zero : throw new Win32Exception(error);
    }
    private static (uint State, uint Accepted) Status(IntPtr service) => Status(service, out _);
    // SERVICE_STATUS_PROCESS: state at 4, accepted controls at 8, Win32 exit code at 12, service-specific exit code at 16.
    private static (uint State, uint Accepted) Status(IntPtr service, out uint exitCode)
    {
        var buffer = Marshal.AllocHGlobal(36);
        try
        {
            if (!QueryServiceStatusEx(service, 0, buffer, 36, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var win32 = (uint)Marshal.ReadInt32(buffer, 12);
            exitCode = win32 == 1066 ? (uint)Marshal.ReadInt32(buffer, 16) : win32;
            return ((uint)Marshal.ReadInt32(buffer, 4), (uint)Marshal.ReadInt32(buffer, 8));
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    public bool StaysRunning(string name, TimeSpan window, out uint exitCode)
    {
        exitCode = 0;
        var manager = Manager();
        try
        {
            var service = Open(manager, name, QueryStatus);
            if (service == IntPtr.Zero) return false;
            try
            {
                for (var deadline = DateTime.UtcNow + window; ; Thread.Sleep(200))
                {
                    if (Status(service, out exitCode).State != Running) return false;
                    if (DateTime.UtcNow >= deadline) { exitCode = 0; return true; }
                }
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
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
                // A service that is shutting down settles within moments; wait briefly instead of reporting a half state.
                for (var deadline = DateTime.UtcNow + PendingWait; state == StopPendingState && DateTime.UtcNow < deadline;)
                {
                    Thread.Sleep(100);
                    (state, accepted) = Status(service);
                }
                return new(true, state is Running or 2, (accepted & 1) != 0, Dependents(service), state == StopPendingState);
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
    // ENUM_SERVICE_STATUSW: two string pointers and a 28-byte SERVICE_STATUS; the stride follows the pointer size and alignment.
    [StructLayout(LayoutKind.Sequential)] private struct EnumServiceStatus { public IntPtr Name, Display; public uint Type, State, Controls, Win32Exit, Specific, CheckPoint, WaitHint; }
    private static string[] Dependents(IntPtr service)
    {
        EnumDependentServicesW(service, 1, IntPtr.Zero, 0, out var needed, out var count);
        if (needed == 0) return [];
        var buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!EnumDependentServicesW(service, 1, buffer, needed, out _, out count)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var stride = Marshal.SizeOf<EnumServiceStatus>();
            return Enumerable.Range(0, (int)count).Select(i => Marshal.PtrToStringUni(Marshal.ReadIntPtr(buffer, i * stride)) ?? "").Where(n => n.Length > 0).ToArray();
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
    // SERVICE_CHANGE_CONFIG (2); every other field stays SERVICE_NO_CHANGE, and the delayed-start flag is a separate setting this never touches.
    public void SetStartType(string name, int start)
    {
        if (start is not (2 or 3 or 4)) throw new InvalidOperationException("Invalid service start type.");
        var manager = Manager();
        try
        {
            var service = Open(manager, name, 2);
            if (service == IntPtr.Zero) throw new InvalidOperationException($"{name} is not installed.");
            try { if (!ChangeServiceConfigW(service, 0xFFFFFFFF, (uint)start, 0xFFFFFFFF, null, null, IntPtr.Zero, null, null, null, null)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
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
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ChangeServiceConfigW(IntPtr service, uint serviceType, uint startType, uint errorControl, string? path, string? group, IntPtr tagId, string? dependencies, string? account, string? password, string? displayName);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CloseServiceHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatusEx(IntPtr service, int level, IntPtr buffer, uint size, out uint needed);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool EnumDependentServicesW(IntPtr service, uint state, IntPtr buffer, uint size, out uint needed, out uint count);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool ControlService(IntPtr service, uint control, byte[] status);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool StartServiceW(IntPtr service, uint argc, IntPtr argv);
}
