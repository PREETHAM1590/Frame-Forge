using System.ComponentModel;
using System.Net;
using System.Text.Json;
using Frameforge.Windows;
using Xunit;

public class BoosterMechanismTests
{
    private const string Sid = "S-1-5-21-1", Start = "2026-10-12T10:00:00.0000000Z";
    private static readonly ProcessTarget Game = new(100, Start, @"C:\Games\Test\game.exe", "game", "Normal");
    private static Mechanisms Off() => new(false, "Normal", null, false, false, false, false, false);
    private static SessionCommand Command(Mechanisms m, bool store = false, bool unattended = false, bool preset = false) => new("start", Game.Pid, Game.StartTime, Game.ExecutablePath, m, [], 50, null, store, unattended, preset);

    // ---- fakes ----
    private sealed class Processes : IProcessControl
    {
        public Dictionary<int, ProcInfo> Running { get; } = new() { [Game.Pid] = new(Game, 1, Sid, false) };
        public int LogicalCpus => 12;
        public ProcInfo[] List() => [.. Running.Values];
        public ProcessTarget? Read(ProcessTarget id) => Running.TryGetValue(id.Pid, out var p) && p.Target.StartTime == id.StartTime ? p.Target : null;
        public void SetPriority(ProcessTarget id, string priority) { }
        public ulong GetAffinity(ProcessTarget id) => 0xFFF;
        public void SetAffinity(ProcessTarget id, ulong mask) { }
        public bool Suspend(ProcessTarget id) => true;
        public void Resume(ProcessTarget id) { }
        public (int Suspended, int Total) Threads(ProcessTarget id) => (0, 1);
        public int Close(ProcessTarget[] ids) => ids.Length;
    }
    private sealed class Power : IPowerStore
    {
        public static readonly Guid Balanced = new("381b4222-f694-41f0-9685-ff5bb260df2e");
        public Guid Current { get; set; } = Balanced;
        public List<Guid> Schemes { get; } = [Balanced, BoostSessionEngine.HighPerformance];
        public Guid Active() => Current;
        public bool Exists(Guid scheme) => Schemes.Contains(scheme);
        public void SetActive(Guid scheme) => Current = scheme;
        public void Duplicate(Guid source, Guid destination, string name) { }
        public string? Name(Guid scheme) => null;
        public void Delete(Guid scheme) { }
    }
    private sealed class Timer : ITimerControl { public string? Unsupported => null; public bool Request() => true; public void Release() { } }
    private sealed class MemoryStore : IRegistryStore
    {
        public ValueState Read(Setting setting) => new(false, null, setting.Kind);
        public void Write(Setting setting, ValueState state) { }
    }
    private sealed class Registry : IRegistryAccess
    {
        public Dictionary<(string, string), RegValue> Values { get; } = new();
        public object? Policy { get; set; }
        public List<string> Writes { get; } = [];
        public RegValue Read(string path, string name) => Values.GetValueOrDefault((path, name), new(false, null, null));
        public void Write(string path, string name, string kind, object value) { Writes.Add($"{name}={value}"); Values[(path, name)] = new(true, kind, value); }
        public void Delete(string path, string name) { Writes.Add($"-{name}"); Values.Remove((path, name)); }
        public object? ReadPolicy(string path, string name) => path == BoosterPaths.DvrPolicyPath && name == BoosterPaths.DvrPolicyName ? Policy : null;
    }
    private sealed class Settings : IPowerSettings
    {
        public Dictionary<(Guid, Guid), uint> Values { get; } = new();
        public List<string> Writes { get; } = [];
        public uint? ReadAc(Guid scheme, Guid setting) => Values.TryGetValue((scheme, setting), out var v) ? v : null;
        public void WriteAc(Guid scheme, Guid setting, uint value) { Writes.Add($"{scheme}/{BoosterPaths.SettingName(setting)}={value}"); Values[(scheme, setting)] = value; }
    }
    private sealed class Throttling : IPowerThrottling
    {
        public (uint, uint)? State { get; set; } = (0, 0);
        public (uint Control, uint State)? Get(ProcessTarget identity) => State;
        public void Set(ProcessTarget identity, uint control, uint state) => State = (control, state);
    }
    private sealed class Topology(string name, params (int Eff, int Threads)[] cores) : ICpuTopology
    {
        public string CpuName => name;
        public LogicalCpu[] Cpus()
        {
            var list = new List<LogicalCpu>(); var index = 0; var core = 0;
            foreach (var (eff, threads) in cores) { for (var t = 0; t < threads; t++) { list.Add(new(0, index, core, eff, 256 + index)); index++; } core++; }
            return [.. list];
        }
    }
    private sealed class CpuSets : ICpuSets
    {
        public int[] Current { get; set; } = [];
        public int[] Get(ProcessTarget identity) => Current;
        public void Set(ProcessTarget identity, int[] ids) => Current = ids;
    }
    private sealed class Gpus(int count) : IGpuInfo { public int Count() => count; }
    private sealed class Services : IServiceStore
    {
        public Dictionary<string, ServiceInfo> Items { get; } = new(StringComparer.OrdinalIgnoreCase);
        public List<string> Calls { get; } = [];
        public bool Exists(string n) => Items.ContainsKey(n);
        public void Add(string name, bool running = true, bool canStop = true, params string[] dependents) => Items[name] = new(true, running, canStop, dependents);
        public ServiceInfo Query(string name) => Items.GetValueOrDefault(name, new(false, false, false, []));
        public bool Stop(string name, TimeSpan timeout) { Calls.Add($"stop {name}"); Items[name] = Items[name] with { Running = false }; return true; }
        public bool Start(string name, TimeSpan timeout) { Calls.Add($"start {name}"); Items[name] = Items[name] with { Running = true }; return true; }
        // Tests do not wait out the real stay-running window.
        public Func<string, (bool Stays, uint Code)>? Stays { get; set; }
        public int Starts(string name) => Calls.Count(c => c == $"start {name}");
        public bool StaysRunning(string name, TimeSpan window, out uint exitCode)
        {
            var (stays, code) = Stays?.Invoke(name) ?? (true, 0u);
            exitCode = stays ? 0 : code;
            if (!stays) Items[name] = Items[name] with { Running = false };
            return stays;
        }
    }
    private sealed class Elevator(Services services, List<Step>? steps = null) : IServiceElevator
    {
        public List<(string Action, string[] Names)> Calls { get; } = [];
        public bool Decline { get; set; }
        public string[] StopOnly { get; set; } = [];
        public int CapturedBefore { get; private set; } = -1;
        public int StepsAtFirstCall { get; private set; } = -1;
        // Lets a test look at the PC at the moment the prompt would open.
        public Action<string>? Hook { get; set; }
        public ServiceBatch Run(string action, string[] names, CancellationToken cancel = default)
        {
            CapturedBefore = steps?.Count(s => s.Event == "captured") ?? -1;
            if (StepsAtFirstCall < 0) StepsAtFirstCall = steps?.Count ?? 0;
            Hook?.Invoke(action);
            Calls.Add((action, names));
            if (Decline) return new(true, []);
            return ServiceCommands.Execute(action, action == "stop" && StopOnly.Length > 0 ? StopOnly : names, services, new Controllers(false));
        }
    }
    private sealed class Controllers(bool connected) : IControllerProbe { public bool XboxControllerConnected() => connected; }

    private sealed record Rig(Processes Processes, Power Power, List<Step> Steps, Registry Registry, Settings Settings, Throttling Throttling, CpuSets Sets, Services Services, Elevator Elevator, BoostSessionEngine Engine, Extras Extras);
    private static Rig Setup(string cpu = "13th Gen Intel(R) Core(TM) i5-13420H", (int, int)[]? cores = null, int gpus = 2, bool elevate = true, bool controller = false, int build = 26300)
    {
        var processes = new Processes(); var power = new Power(); var steps = new List<Step>(); var registry = new Registry(); var settings = new Settings();
        var throttling = new Throttling(); var sets = new CpuSets(); var services = new Services();
        cores ??= [(1, 2), (1, 2), (1, 2), (1, 2), (0, 1), (0, 1), (0, 1), (0, 1)];
        var elevator = new Elevator(services, steps);
        var extras = new Extras(registry, settings, throttling, new Topology(cpu, cores), sets, new Gpus(gpus), services, elevator, new Controllers(controller), build, elevate);
        var engine = new BoostSessionEngine(processes, power, new Timer(), new MemoryStore(), steps.Add, 999, null, extras);
        return new(processes, power, steps, registry, settings, throttling, sets, services, elevator, engine, extras);
    }
    private static Captured CapturedOf(Rig rig, string mechanism) => rig.Steps.Last(s => s.Event == "captured" && s.Mechanism == mechanism).Prior!;
    private static string[] Calls(Rig rig) => [.. rig.Elevator.Calls.Select(c => $"{c.Action} {string.Join(',', c.Names)}")];
    private static Step Result(Rig rig, string mechanism) => rig.Steps.Last(s => s.Mechanism == mechanism && s.Event is not ("captured" or "released"));

    // ---- services ----
    [Fact]
    public void DenyListWinsAndAllowlistNeverOverlapsIt()
    {
        foreach (var name in new[] { "RpcSs", "Audiosrv", "AudioEndpointBuilder", "Dhcp", "Dnscache", "hidserv", "BthServ", "WinDefend", "mpssvc", "BFE", "wuauserv", "UsoSvc", "BITS", "DoSvc", "WaaSMedicSvc",
            "EasyAntiCheat_EOS", "vgc", "vgk", "BEService", "NVDisplay.ContainerLocalSystem", "NvContainerLocalSystem", "GamingServices", "GamingServicesNet", "WacomPenService", "RazerCentralService", "LGHUBUpdaterService", "Steam Client Service" })
            Assert.True(ServicePolicy.Denied(name), name);
        Assert.All(ServicePolicy.Allowlist, name => Assert.False(ServicePolicy.Denied(name), name));
        Assert.False(ServicePolicy.Allowed("RpcSs"));
        Assert.False(ServicePolicy.Allowed("wuauserv"));
        Assert.False(ServicePolicy.Allowed("GamingServices"));
        Assert.True(ServicePolicy.Allowed("DiagTrack"));
    }
    [Fact]
    public void PlanSkipsStoppedStoreControllerAndDependedOnServices()
    {
        var services = new Services();
        services.Add("DiagTrack"); services.Add("SysMain"); services.Add("Spooler", running: false); services.Add("lfsvc", canStop: false);
        services.Add("XblAuthManager", dependents: "XblGameSave"); services.Add("XblGameSave"); services.Add("XboxNetApiSvc"); services.Add("XboxGipSvc");
        services.Add("TrkWks", dependents: "SomeOtherService");
        var plan = ServicePolicy.Plan(services, false, false);
        Assert.Equal(["XblGameSave", "XblAuthManager", "XboxNetApiSvc", "XboxGipSvc", "DiagTrack", "SysMain"], plan.Targets);
        Assert.Contains(plan.Skipped, s => s.Name == "TrkWks" && s.Detail.Contains("SomeOtherService"));
        Assert.Contains(plan.Skipped, s => s.Name == "Spooler" && s.Detail.Contains("Not running"));
        Assert.Contains(plan.Skipped, s => s.Name == "lfsvc" && s.Detail.Contains("does not allow"));
        Assert.Contains(plan.Skipped, s => s.Name == "WSearch" && s.Detail.Contains("Not installed"));

        var store = ServicePolicy.Plan(services, true, true);
        Assert.DoesNotContain("XblAuthManager", store.Targets);
        Assert.DoesNotContain("XboxNetApiSvc", store.Targets);
        Assert.DoesNotContain("XboxGipSvc", store.Targets);
        // XblGameSave is no longer a dependent problem for itself: it is skipped with the store services.
        Assert.DoesNotContain("XblGameSave", store.Targets);
        Assert.Contains("DiagTrack", store.Targets);
    }
    [Fact]
    public void ServicesAreJournaledBeforeThePromptPausedAndRestartedOnlyIfStopped()
    {
        var rig = Setup();
        rig.Services.Add("DiagTrack"); rig.Services.Add("SysMain"); rig.Services.Add("Spooler"); rig.Services.Add("TrkWks", running: false);
        rig.Engine.Start(Command(Off() with { PauseServices = true }));
        var item = CapturedOf(rig, "pauseServices");
        Assert.Equal(["DiagTrack", "SysMain", "Spooler"], item.Items!);
        // The administrator step ran after the capture event was emitted.
        Assert.Equal(1, rig.Elevator.CapturedBefore);
        Assert.Equal(["stop DiagTrack,SysMain,Spooler"], Calls(rig).Take(1));
        Assert.Equal("applied", Result(rig, "pauseServices").Event);
        Assert.All(new[] { "DiagTrack", "SysMain", "Spooler" }, n => Assert.False(rig.Services.Query(n).Running));
        // A service the user stopped earlier is neither paused nor restarted.
        Assert.False(rig.Services.Query("TrkWks").Running);
        // Starting a service that was running before: simulate the user starting SysMain by hand mid-session.
        rig.Services.Items["SysMain"] = rig.Services.Items["SysMain"] with { Running = true };
        var reverts = rig.Engine.Revert();
        Assert.Equal("reverted", reverts.Single().State);
        Assert.Equal(["stop DiagTrack", "stop SysMain", "stop Spooler", "start Spooler", "start DiagTrack"], rig.Services.Calls);
        Assert.True(rig.Services.Query("DiagTrack").Running);
        Assert.True(rig.Services.Query("Spooler").Running);
        Assert.False(rig.Services.Query("TrkWks").Running);
        // One administrator step to stop, one to start; the start list is the reverse of the stop order and leaves out the running one.
        Assert.Equal(2, rig.Elevator.Calls.Count);
        Assert.Equal("start Spooler,DiagTrack", Calls(rig)[1]);
    }
    [Fact]
    public void DeclinedAdministratorPromptSkipsServicesAndReleasesTheJournal()
    {
        var rig = Setup();
        rig.Services.Add("DiagTrack");
        rig.Elevator.Decline = true;
        rig.Engine.Start(Command(Off() with { PauseServices = true }));
        Assert.Equal(["captured", "released", "skipped"], rig.Steps.Select(s => s.Event));
        Assert.Contains("admin declined", rig.Steps.Last().Detail);
        Assert.True(rig.Services.Query("DiagTrack").Running);
        var revert = rig.Engine.Revert().Single();
        Assert.Equal(("reverted", "Never applied; nothing to undo."), (revert.State, revert.Detail));
        Assert.Single(rig.Elevator.Calls);
    }
    [Fact]
    public void AutoBoostNeverOpensAnAdministratorPrompt()
    {
        var rig = Setup();
        rig.Services.Add("DiagTrack");
        rig.Engine.Start(Command(Off() with { PauseServices = true }, unattended: true));
        Assert.Equal(("skipped", BoostSessionEngine.AutoSkipServices), (rig.Steps.Single().Event, rig.Steps.Single().Detail));
        Assert.Empty(rig.Elevator.Calls);
    }
    [Fact]
    public void PartialStopKeepsOnlyTheJournalAndRevertStartsJustTheStoppedOnes()
    {
        var rig = Setup();
        rig.Services.Add("DiagTrack"); rig.Services.Add("SysMain");
        rig.Elevator.StopOnly = ["DiagTrack"];
        rig.Engine.Start(Command(Off() with { PauseServices = true }));
        Assert.True(rig.Services.Query("SysMain").Running);
        Assert.Contains("Paused 1 service(s): DiagTrack", Result(rig, "pauseServices").Detail);
        rig.Engine.Revert();
        Assert.Equal(["stop DiagTrack", "start DiagTrack"], rig.Services.Calls);
    }
    [Fact]
    public void RecoveryWithoutElevationLeavesServicesPendingAndNeverPrompts()
    {
        var rig = Setup(elevate: false);
        rig.Services.Add("DiagTrack"); rig.Services.Add("Spooler", running: false);
        var item = new Captured("pauseServices", Items: ["DiagTrack", "Spooler"]);
        rig.Services.Items["DiagTrack"] = rig.Services.Items["DiagTrack"] with { Running = false };
        var result = rig.Engine.Recover([item]).Single();
        Assert.Equal("failed", result.State);
        Assert.Contains("Retry recovery", result.Detail);
        Assert.Contains("restart Windows", result.Detail);
        Assert.Empty(rig.Elevator.Calls);

        var allowed = Setup();
        allowed.Services.Add("DiagTrack", running: false); allowed.Services.Add("Spooler", running: false);
        Assert.Equal("reverted", allowed.Engine.Recover([item]).Single().State);
        Assert.Equal(["start Spooler,DiagTrack"], Calls(allowed));
        // Running already: nothing to start and no prompt.
        var running = Setup(); running.Services.Add("DiagTrack"); running.Services.Add("Spooler");
        Assert.Equal("reverted", running.Engine.Recover([item]).Single().State);
        Assert.Empty(running.Elevator.Calls);
    }
    [Fact]
    public void RecoveryRejectsServiceNamesOutsideTheAllowlist()
    {
        var rig = Setup();
        rig.Services.Add("RpcSs", running: false);
        foreach (var name in new[] { "RpcSs", "wuauserv", "WinDefend", "NoSuchService" })
            Assert.Equal("failed", rig.Engine.Recover([new Captured("pauseServices", Items: [name])]).Single().State);
        Assert.Empty(rig.Elevator.Calls);
        Assert.Equal("failed", rig.Engine.Recover([new Captured("pauseServices", Items: [])]).Single().State);
        Assert.Throws<InvalidOperationException>(() => ServiceCommands.Execute("stop", ["RpcSs"], rig.Services, new Controllers(false)));
        Assert.Throws<InvalidOperationException>(() => ServiceCommands.Execute("delete", ["DiagTrack"], rig.Services, new Controllers(false)));
    }
    [Fact]
    public void ElevatedStopRechecksEverythingAndStopsDependentsFirst()
    {
        var services = new Services();
        services.Add("XblAuthManager", dependents: "XblGameSave"); services.Add("XblGameSave"); services.Add("XboxGipSvc"); services.Add("Spooler", canStop: false); services.Add("SysMain", dependents: "Unrelated");
        var batch = ServiceCommands.Execute("stop", ["XblAuthManager", "XblGameSave", "XboxGipSvc", "Spooler", "SysMain"], services, new Controllers(true));
        Assert.Equal(["stop XblGameSave", "stop XblAuthManager"], services.Calls);
        Assert.Equal("skipped", batch.Outcomes.Single(o => o.Name == "XboxGipSvc").State);
        Assert.Equal("skipped", batch.Outcomes.Single(o => o.Name == "Spooler").State);
        Assert.Contains("Unrelated", batch.Outcomes.Single(o => o.Name == "SysMain").Detail);
        // Starting leaves a running service alone.
        var again = ServiceCommands.Execute("start", ["XblAuthManager", "XblGameSave", "SysMain"], services, new Controllers(false));
        Assert.Equal(["started", "started", "skipped"], again.Outcomes.Select(o => o.State));
    }

    // ---- Game Bar capture ----
    private static (string, string) GameDvr => (BoosterPaths.GameConfigStore, "GameDVR_Enabled");
    private static (string, string) AppCapture => (BoosterPaths.GameDvr, "AppCaptureEnabled");
    private static (string, string) Historical => (BoosterPaths.GameDvr, "HistoricalCaptureEnabled");
    private static (string, string) Nexus => (BoosterPaths.GameBar, "UseNexusForGameBarEnabled");
    [Fact]
    public void GameBarIsLeftAloneWhenPolicyAndValuesAreAlreadyOff()
    {
        var rig = Setup();
        rig.Registry.Policy = 0;
        rig.Registry.Values[GameDvr] = new(true, "DWord", 0); rig.Registry.Values[Nexus] = new(true, "DWord", 0);
        rig.Engine.Start(Command(Off() with { GameBarCapture = true }));
        Assert.Equal("skipped", rig.Steps.Single().Event);
        Assert.Contains("policy", rig.Steps.Single().Detail);
        Assert.Empty(rig.Registry.Writes);
    }
    [Fact]
    public void GameBarCapturesAbsentAndSetValuesThenRestoresThemExactly()
    {
        var rig = Setup();
        rig.Registry.Values[GameDvr] = new(true, "DWord", 1);
        rig.Registry.Values[Historical] = new(true, "DWord", 1);
        // AppCaptureEnabled is absent; UseNexus is already 0.
        rig.Registry.Values[Nexus] = new(true, "DWord", 0);
        rig.Engine.Start(Command(Off() with { GameBarCapture = true }));
        Assert.Equal("applied", Result(rig, "gameBarCapture").Event);
        var item = CapturedOf(rig, "gameBarCapture");
        Assert.Equal(["GameDVR_Enabled", "AppCaptureEnabled", "HistoricalCaptureEnabled"], item.RegValues!.Select(v => v.Name));
        Assert.Equal([true, false, true], item.RegValues!.Select(v => v.Existed));
        Assert.Equal(0, rig.Registry.Values[AppCapture].Value);
        Assert.Equal(0, rig.Registry.Values[GameDvr].Value);
        Assert.Equal("reverted", rig.Engine.Revert().Single().State);
        Assert.Equal(1, rig.Registry.Values[GameDvr].Value);
        Assert.Equal(1, rig.Registry.Values[Historical].Value);
        Assert.False(rig.Registry.Values.ContainsKey(AppCapture), "an absent value is deleted again, not left at 0");
        Assert.Equal(0, rig.Registry.Values[Nexus].Value);
        Assert.Equal("reverted", rig.Engine.Recover([item]).Single().State);
    }
    [Fact]
    public void GameBarKeepsExternalChangesAndLeavesUnexpectedTypesAlone()
    {
        var rig = Setup();
        rig.Registry.Values[GameDvr] = new(true, "String", "1");
        rig.Registry.Values[Historical] = new(true, "DWord", 1);
        rig.Engine.Start(Command(Off() with { GameBarCapture = true }));
        Assert.Equal("1", rig.Registry.Values[GameDvr].Value);
        Assert.DoesNotContain(CapturedOf(rig, "gameBarCapture").RegValues!, v => v.Name == "GameDVR_Enabled");
        Assert.Contains("unexpected type", Result(rig, "gameBarCapture").Detail);
        rig.Registry.Values[Historical] = new(true, "DWord", 7);
        var revert = rig.Engine.Revert().Single();
        Assert.Equal("conflict", revert.State);
        Assert.Equal(7, rig.Registry.Values[Historical].Value);
        Assert.False(rig.Registry.Values.ContainsKey(AppCapture), "values still at Frameforge's setting are restored even when another one conflicts");
    }
    [Fact]
    public void GameBarRecoveryRejectsUnauthorizedRegistryPaths()
    {
        var rig = Setup();
        var evil = new Captured("gameBarCapture", RegValues: [new RegCapture(@"Software\Microsoft\Windows\CurrentVersion\Run", "GameDVR_Enabled", "DWord", true, 1, 0)]);
        Assert.Equal("failed", rig.Engine.Recover([evil]).Single().State);
        var wrongKind = new Captured("gameBarCapture", RegValues: [new RegCapture(BoosterPaths.GameConfigStore, "GameDVR_Enabled", "String", true, "1", "0")]);
        Assert.Equal("failed", rig.Engine.Recover([wrongKind]).Single().State);
        Assert.Empty(rig.Registry.Writes);
    }

    // ---- power throttling ----
    [Fact]
    public void PowerThrottlingIsCapturedOptedOutAndRestored()
    {
        var rig = Setup();
        rig.Engine.Start(Command(Off() with { PowerThrottling = true }));
        var item = CapturedOf(rig, "powerThrottling");
        Assert.Equal(("0:0", "1:0"), (item.Prior, item.Applied));
        Assert.Equal((1u, 0u), rig.Throttling.State);
        Assert.Equal("applied", Result(rig, "powerThrottling").Event);
        Assert.Equal("reverted", rig.Engine.Revert().Single().State);
        Assert.Equal((0u, 0u), rig.Throttling.State);

        rig.Throttling.State = (1u, 0u);
        Assert.Equal("reverted", rig.Engine.Recover([item]).Single().State);
        rig.Throttling.State = (1u, 1u);
        Assert.Equal("conflict", rig.Engine.Recover([item]).Single().State);
        Assert.Equal((1u, 1u), rig.Throttling.State);
        rig.Processes.Running.Remove(Game.Pid);
        Assert.Equal("reverted", rig.Engine.Recover([item]).Single().State);
    }
    [Fact]
    public void PowerThrottlingSkipsWhenAlreadyOptedOutAndIsUnsupportedWithoutState()
    {
        var rig = Setup(); rig.Throttling.State = (1u, 0u);
        rig.Engine.Start(Command(Off() with { PowerThrottling = true }));
        Assert.Equal("skipped", rig.Steps.Single().Event);
        var none = Setup(); none.Throttling.State = null;
        none.Engine.Start(Command(Off() with { PowerThrottling = true }));
        Assert.Equal("unsupported", none.Steps.Single().Event);
        var old = Setup(build: 14393);
        old.Engine.Start(Command(Off() with { PowerThrottling = true }));
        Assert.Equal("unsupported", old.Steps.Single().Event);
        Assert.DoesNotContain(old.Steps, s => s.Event == "captured");
    }

    // ---- smart cores ----
    [Fact]
    public void SmartCoresPlanFollowsTheCpuLayout()
    {
        LogicalCpu[] Cpus(params (int Eff, int Threads)[] cores) => new Topology("x", cores).Cpus();
        var hybrid = Cpus((1, 2), (1, 2), (1, 2), (1, 2), (0, 1), (0, 1));
        var plan = SmartCores.Plan("Intel", hybrid);
        Assert.Equal([256, 257, 258, 259, 260, 261, 262, 263], plan.Ids);
        Assert.Null(plan.Skip);
        Assert.Contains("not hybrid", SmartCores.Plan("AMD Ryzen 7 7800X3D", Cpus((0, 2), (0, 2), (0, 2), (0, 2))).Skip);
        Assert.Contains("fewer than 6", SmartCores.Plan("Intel", Cpus((1, 1), (1, 1), (1, 2), (0, 1), (0, 1))).Skip);
        Assert.Contains("V-Cache", SmartCores.Plan("AMD Ryzen 9 7950X3D 16-Core Processor", hybrid).Skip);
        Assert.True(SmartCores.IsDualCcdX3d("AMD Ryzen 9 9900X3D"));
        Assert.False(SmartCores.IsDualCcdX3d("AMD Ryzen 7 7800X3D"));
        Assert.False(SmartCores.IsDualCcdX3d("AMD Ryzen 9 7950X"));
        var topology = SmartCores.Describe("Intel", hybrid);
        Assert.Equal((true, 4, 8, 2, 2), (topology.Hybrid, topology.PerformanceCores, topology.PerformanceThreads, topology.EfficiencyCores, topology.EfficiencyThreads));
        // The highest class is the performance class, not a hard-coded 1.
        var three = Cpus((2, 2), (2, 2), (2, 2), (2, 2), (1, 1), (0, 1));
        Assert.Equal(8, SmartCores.Plan("Intel", three).Ids.Length);
    }
    [Fact]
    public void SmartCoresSetsAndClearsTheGameCpuSet()
    {
        var rig = Setup();
        rig.Engine.Start(Command(Off() with { SmartCores = true }));
        var item = CapturedOf(rig, "smartCores");
        Assert.Empty(item.Items!);
        Assert.Equal(8, item.AppliedItems!.Length);
        Assert.Equal([256, 257, 258, 259, 260, 261, 262, 263], rig.Sets.Current);
        Assert.Equal("reverted", rig.Engine.Revert().Single().State);
        Assert.Empty(rig.Sets.Current);

        rig.Sets.Current = [300];
        Assert.Equal("conflict", rig.Engine.Recover([item]).Single().State);
        Assert.Equal([300], rig.Sets.Current);
    }
    [Fact]
    public void SmartCoresSkipsNonHybridDualCcdAndGamesWithTheirOwnCpuSet()
    {
        var plain = Setup(cores: [(0, 2), (0, 2), (0, 2), (0, 2)]);
        plain.Engine.Start(Command(Off() with { SmartCores = true }));
        Assert.Equal("unsupported", plain.Steps.Single().Event);
        Assert.Contains("not hybrid", plain.Steps.Single().Detail);
        Assert.Empty(plain.Sets.Current);

        var x3d = Setup(cpu: "AMD Ryzen 9 7950X3D 16-Core Processor");
        x3d.Engine.Start(Command(Off() with { SmartCores = true }));
        Assert.Equal("unsupported", x3d.Steps.Single().Event);

        var few = Setup(cores: [(1, 1), (1, 1), (1, 2), (0, 1), (0, 1)]);
        few.Engine.Start(Command(Off() with { SmartCores = true }));
        Assert.Equal("unsupported", few.Steps.Single().Event);
        Assert.Contains("fewer than 6", few.Steps.Single().Detail);

        var own = Setup(); own.Sets.Current = [258];
        own.Engine.Start(Command(Off() with { SmartCores = true }));
        Assert.Equal("skipped", own.Steps.Single().Event);
        Assert.Equal([258], own.Sets.Current);

        var affinity = Setup();
        affinity.Engine.Start(Command(Off() with { SmartCores = true, Affinity = [0, 1, 2, 3] }));
        Assert.Equal("skipped", affinity.Steps.Last(s => s.Mechanism == "smartCores").Event);
        Assert.Empty(affinity.Sets.Current);
    }

    // ---- core parking ----
    private static readonly Guid Scheme = new("396783ca-20d2-459f-b042-4722bc020d51");
    [Fact]
    public void CoreParkingRaisesTheAcValueOnTheActiveSchemeAndRestoresThatScheme()
    {
        var rig = Setup(); rig.Power.Schemes.Add(Scheme); rig.Power.Current = Scheme;
        rig.Settings.Values[(Scheme, BoosterPaths.CpMinCores)] = 4; rig.Settings.Values[(Scheme, BoosterPaths.CpMinCores1)] = 0;
        rig.Engine.Start(Command(Off() with { CoreParking = true }));
        Assert.Equal([100u, 100u], [rig.Settings.Values[(Scheme, BoosterPaths.CpMinCores)], rig.Settings.Values[(Scheme, BoosterPaths.CpMinCores1)]]);
        Assert.Equal(["captured", "captured", "applied"], rig.Steps.Select(s => s.Event));
        var first = rig.Steps.First().Prior!;
        Assert.Equal(("4", "100", Scheme.ToString(), "cpmincores"), (first.Prior, first.Applied, first.Scheme, first.Setting));
        Assert.Equal(("0", "cpmincores1"), (CapturedOf(rig, "coreParking").Prior, CapturedOf(rig, "coreParking").Setting));
        // The user switches plans mid-session: the scheme Frameforge changed is the one restored.
        rig.Power.Current = Power.Balanced;
        rig.Settings.Values[(Power.Balanced, BoosterPaths.CpMinCores)] = 5;
        Assert.All(rig.Engine.Revert(), r => Assert.Equal("reverted", r.State));
        Assert.Equal([4u, 0u], [rig.Settings.Values[(Scheme, BoosterPaths.CpMinCores)], rig.Settings.Values[(Scheme, BoosterPaths.CpMinCores1)]]);
        Assert.Equal(5u, rig.Settings.Values[(Power.Balanced, BoosterPaths.CpMinCores)]);
        Assert.Equal(Power.Balanced, rig.Power.Current);
        Assert.DoesNotContain(rig.Settings.Writes, w => w.Contains("dc", StringComparison.OrdinalIgnoreCase));
    }
    [Fact]
    public void CoreParkingSkipsWhenAlreadyOffAndKeepsExternalChanges()
    {
        var off = Setup(cores: [(0, 2), (0, 2), (0, 2), (0, 2)]); off.Settings.Values[(Power.Balanced, BoosterPaths.CpMinCores)] = 100;
        off.Engine.Start(Command(Off() with { CoreParking = true }));
        Assert.Equal("skipped", off.Steps.Single().Event);
        Assert.Contains("already 100%", off.Steps.Single().Detail);
        Assert.Empty(off.Settings.Writes);

        var rig = Setup(cores: [(0, 2), (0, 2), (0, 2), (0, 2)]); rig.Settings.Values[(Power.Balanced, BoosterPaths.CpMinCores)] = 4;
        rig.Engine.Start(Command(Off() with { CoreParking = true }));
        var item = CapturedOf(rig, "coreParking");
        Assert.Single(rig.Steps, s => s.Event == "captured");
        rig.Settings.Values[(Power.Balanced, BoosterPaths.CpMinCores)] = 50;
        Assert.Equal("conflict", rig.Engine.Recover([item]).Single().State);
        Assert.Equal(50u, rig.Settings.Values[(Power.Balanced, BoosterPaths.CpMinCores)]);
        rig.Settings.Values[(Power.Balanced, BoosterPaths.CpMinCores)] = 4;
        Assert.Equal("reverted", rig.Engine.Recover([item]).Single().State);
    }
    [Fact]
    public void CoreParkingIsUnsupportedOnDualCcdX3dAndRecoveryRejectsBadValues()
    {
        var rig = Setup(cpu: "AMD Ryzen 9 9950X3D 16-Core Processor"); rig.Settings.Values[(Power.Balanced, BoosterPaths.CpMinCores)] = 4;
        rig.Engine.Start(Command(Off() with { CoreParking = true }));
        Assert.Equal("unsupported", rig.Steps.Single().Event);
        Assert.Empty(rig.Settings.Writes);
        foreach (var bad in new[] {
            new Captured("coreParking", Prior: "4", Applied: "100", Scheme: "nope", Setting: "cpmincores"),
            new Captured("coreParking", Prior: "400", Applied: "100", Scheme: Scheme.ToString(), Setting: "cpmincores"),
            new Captured("coreParking", Prior: "4", Applied: "100", Scheme: Scheme.ToString(), Setting: "other") })
            Assert.Equal("failed", rig.Engine.Recover([bad]).Single().State);
    }
    [Fact]
    public void CoreParkingReadsTheSchemeAfterThePowerPlanStep()
    {
        var rig = Setup(cores: [(0, 2), (0, 2), (0, 2), (0, 2)]);
        rig.Settings.Values[(BoostSessionEngine.HighPerformance, BoosterPaths.CpMinCores)] = 10;
        rig.Settings.Values[(Power.Balanced, BoosterPaths.CpMinCores)] = 4;
        rig.Engine.Start(Command(Off() with { PowerPlan = true, CoreParking = true }));
        Assert.Equal(BoostSessionEngine.HighPerformance.ToString(), CapturedOf(rig, "coreParking").Scheme);
        Assert.Equal(4u, rig.Settings.Values[(Power.Balanced, BoosterPaths.CpMinCores)]);
        Assert.All(rig.Engine.Revert(), r => Assert.Equal("reverted", r.State));
        Assert.Equal(Power.Balanced, rig.Power.Current);
        Assert.Equal(10u, rig.Settings.Values[(BoostSessionEngine.HighPerformance, BoosterPaths.CpMinCores)]);
    }

    // ---- launch settings (per-game, persistent) ----
    private const string Layers = BoosterPaths.Layers, Gpu = BoosterPaths.GpuPreferences;
    private const string Exe = @"C:\Games\Test\game.exe";
    [Fact]
    public void GpuPreferenceMergesWithExistingPairsAndRestoresTheExactString()
    {
        Assert.Equal("AutoHDREnable=2097;GpuPreference=2;", BoosterPaths.WithGpuPreference("AutoHDREnable=2097;"));
        Assert.Equal("GpuPreference=2;", BoosterPaths.WithGpuPreference(null));
        Assert.Equal("GpuPreference=2;AppStatus=1;", BoosterPaths.WithGpuPreference("GpuPreference=1;AppStatus=1;"));
        var registry = new Registry { Values = { [(Gpu, Exe)] = new(true, "String", "AutoHDREnable=2097;") } };
        var read = LaunchSettings.Run(new("gpuPreference", Exe, "read"), registry, new Gpus(2));
        Assert.Equal(("ready", "AutoHDREnable=2097;", "AutoHDREnable=2097;GpuPreference=2;"), (read.State, read.Current, read.After));
        Assert.Empty(registry.Writes);
        var applied = LaunchSettings.Run(new("gpuPreference", Exe, "apply"), registry, new Gpus(2));
        Assert.Equal(("applied", true), (applied.State, applied.Existed));
        Assert.Equal("AutoHDREnable=2097;GpuPreference=2;", registry.Values[(Gpu, Exe)].Value);
        var revert = LaunchSettings.Run(new("gpuPreference", Exe, "revert", true, "AutoHDREnable=2097;", applied.After), registry, new Gpus(2));
        Assert.Equal("reverted", revert.State);
        Assert.Equal("AutoHDREnable=2097;", registry.Values[(Gpu, Exe)].Value);
        // Reverting again is a no-op that still reports reverted.
        Assert.Equal("reverted", LaunchSettings.Run(new("gpuPreference", Exe, "revert", true, "AutoHDREnable=2097;", applied.After), registry, new Gpus(2)).State);

        var absent = new Registry();
        var set = LaunchSettings.Run(new("gpuPreference", Exe, "apply"), absent, new Gpus(2));
        Assert.False(set.Existed);
        Assert.Equal("GpuPreference=2;", absent.Values[(Gpu, Exe)].Value);
        Assert.Equal("reverted", LaunchSettings.Run(new("gpuPreference", Exe, "revert", false, null, set.After), absent, new Gpus(2)).State);
        Assert.False(absent.Values.ContainsKey((Gpu, Exe)), "a value that did not exist is deleted, not left empty");

        absent.Values[(Gpu, Exe)] = new(true, "String", "Changed=1;");
        var conflict = LaunchSettings.Run(new("gpuPreference", Exe, "revert", false, null, "GpuPreference=2;"), absent, new Gpus(2));
        Assert.Equal(("conflict", "Changed=1;"), (conflict.State, conflict.Current));
        Assert.Equal("Changed=1;", absent.Values[(Gpu, Exe)].Value);
    }
    [Fact]
    public void LaunchSettingsRefuseUnsupportedAndUnsafeRequests()
    {
        var registry = new Registry();
        Assert.Equal("unsupported", LaunchSettings.Run(new("gpuPreference", Exe, "read"), registry, new Gpus(1)).State);
        Assert.Equal("unsupported", LaunchSettings.Run(new("gpuPreference", Exe, "apply"), registry, new Gpus(1)).State);
        Assert.Empty(registry.Writes);
        // Fullscreen optimizations do not need a second GPU.
        Assert.Equal("ready", LaunchSettings.Run(new("fullscreenOptimizations", Exe, "read"), registry, new Gpus(1)).State);
        registry.Values[(Gpu, Exe)] = new(true, "DWord", 1);
        Assert.Equal("unsupported", LaunchSettings.Run(new("gpuPreference", Exe, "apply"), registry, new Gpus(2)).State);
        foreach (var exe in new[] { "relative.txt", @"C:\x\game.bat", @"\\server\share\game.exe", "" })
            Assert.Throws<InvalidOperationException>(() => LaunchSettings.Run(new("gpuPreference", exe, "apply"), registry, new Gpus(2)));
        Assert.Throws<InvalidOperationException>(() => LaunchSettings.Run(new("autoexec", Exe, "apply"), registry, new Gpus(2)));
        Assert.Throws<InvalidOperationException>(() => LaunchSettings.Run(new("gpuPreference", Exe, "delete"), registry, new Gpus(2)));
        Assert.Throws<InvalidOperationException>(() => LaunchSettings.Run(new("gpuPreference", Exe, "revert", true, null, "x"), registry, new Gpus(2)));
        Assert.Throws<InvalidOperationException>(() => LaunchSettings.Run(new("gpuPreference", Exe, "revert", false, "x", "x"), registry, new Gpus(2)));
        Assert.Equal(1, registry.Values[(Gpu, Exe)].Value);
    }
    [Fact]
    public void FullscreenOptimizationsMergeFlagsAndRestoreExactly()
    {
        Assert.Equal("~ DISABLEDXMAXIMIZEDWINDOWEDMODE", BoosterPaths.WithFsoOff(null));
        Assert.Equal("~ PERPROCESSSYSTEMDPIFORCEOFF DISABLEDXMAXIMIZEDWINDOWEDMODE", BoosterPaths.WithFsoOff("~ PERPROCESSSYSTEMDPIFORCEOFF"));
        Assert.Equal("~ RUNASADMIN DISABLEDXMAXIMIZEDWINDOWEDMODE", BoosterPaths.WithFsoOff("~ RUNASADMIN DISABLEDXMAXIMIZEDWINDOWEDMODE"));
        var registry = new Registry { Values = { [(Layers, Exe)] = new(true, "String", "~ RUNASADMIN") } };
        var applied = LaunchSettings.Run(new("fullscreenOptimizations", Exe, "apply"), registry, new Gpus(1));
        Assert.Equal("~ RUNASADMIN DISABLEDXMAXIMIZEDWINDOWEDMODE", registry.Values[(Layers, Exe)].Value);
        Assert.Equal("reverted", LaunchSettings.Run(new("fullscreenOptimizations", Exe, "revert", true, "~ RUNASADMIN", applied.After), registry, new Gpus(1)).State);
        Assert.Equal("~ RUNASADMIN", registry.Values[(Layers, Exe)].Value);
        var already = new Registry { Values = { [(Layers, Exe)] = new(true, "String", "~ DISABLEDXMAXIMIZEDWINDOWEDMODE") } };
        Assert.Equal("already-set", LaunchSettings.Run(new("fullscreenOptimizations", Exe, "apply"), already, new Gpus(1)).State);
        Assert.Empty(already.Writes);
    }
    [Fact]
    public void LaunchSettingsAreNoLongerSessionMechanisms()
    {
        var rig = Setup();
        rig.Engine.Start(Command(Off()));
        Assert.Empty(rig.Registry.Writes);
        Assert.DoesNotContain("GpuPreference", typeof(Mechanisms).GetProperties().Select(p => p.Name));
        Assert.DoesNotContain("FullscreenOptimizations", typeof(Mechanisms).GetProperties().Select(p => p.Name));
        // A saved session from the first pass is not silently "reverted" as something else.
        Assert.Equal("failed", rig.Engine.Recover([new Captured("gpuPreference", RegValues: [new RegCapture(Gpu, Exe, "String", false, null, "GpuPreference=2;")])]).Single().State);
    }

    // ---- fix round 1: services journal, ordering, codes ----
    [Fact]
    public void AFailedOrLateStopStaysJournaledAndIsRestartedIfItStoppedLate()
    {
        var rig = Setup();
        rig.Services.Add("DiagTrack"); rig.Services.Add("Spooler");
        // DiagTrack misses the 5 s wait; the real service stops moments later.
        var slow = new SlowStop(rig.Services, "DiagTrack");
        var engine = new BoostSessionEngine(rig.Processes, rig.Power, new Timer(), new MemoryStore(), rig.Steps.Add, 999, null, rig.Extras with { Elevator = slow });
        engine.Start(Command(Off() with { PauseServices = true }));
        Assert.Equal("applied", Result(rig, "pauseServices").Event);
        Assert.Contains("did not stop within 5 seconds", Result(rig, "pauseServices").Detail ?? Result(rig, "pauseServices").Detail);
        // Journal narrowed to what this session stopped or may have stopped: both here.
        Assert.Equal(["DiagTrack", "Spooler"], CapturedOf(rig, "pauseServices").Items!);
        rig.Services.Items["DiagTrack"] = rig.Services.Items["DiagTrack"] with { Running = false };
        engine.Revert();
        Assert.True(rig.Services.Query("DiagTrack").Running);
        Assert.True(rig.Services.Query("Spooler").Running);

        // When only failures happened and nothing stopped, the journal is kept too (not released).
        var only = Setup(); only.Services.Add("DiagTrack");
        var never = new SlowStop(only.Services, "DiagTrack");
        var engine2 = new BoostSessionEngine(only.Processes, only.Power, new Timer(), new MemoryStore(), only.Steps.Add, 999, null, only.Extras with { Elevator = never });
        engine2.Start(Command(Off() with { PauseServices = true }));
        Assert.Equal("failed", Result(only, "pauseServices").Event);
        Assert.Equal("stop-timeout", Result(only, "pauseServices").Code);
        Assert.DoesNotContain(only.Steps, s => s.Event == "released");
    }
    private sealed class SlowStop(Services services, string slow) : IServiceElevator
    {
        public ServiceBatch Run(string action, string[] names, CancellationToken cancel = default)
        {
            if (action != "stop") return ServiceCommands.Execute(action, names, services, new Controllers(false));
            // The slow one reports a timeout without stopping yet.
            var rest = names.Where(n => n != slow).ToArray();
            var outcomes = new List<ServiceOutcome>();
            if (names.Contains(slow)) outcomes.Add(new(slow, "failed", "It did not stop within 5 seconds. Frameforge checks again at the end of the session and restarts it if it stopped late.", ServiceCodes.StopTimeout));
            if (rest.Length > 0) outcomes.AddRange(ServiceCommands.Execute("stop", rest, services, new Controllers(false)).Outcomes);
            return new(false, [.. outcomes]);
        }
    }
    [Fact]
    public void OnlyServicesTheStepStoppedAreJournaledAndOthersAreNeverStarted()
    {
        var rig = Setup();
        rig.Services.Add("DiagTrack"); rig.Services.Add("SysMain"); rig.Services.Add("Spooler");
        rig.Elevator.StopOnly = ["DiagTrack", "Spooler"];
        rig.Engine.Start(Command(Off() with { PauseServices = true }));
        Assert.Equal(["captured", "captured", "released", "applied"], rig.Steps.Select(s => s.Event));
        Assert.Equal(["DiagTrack", "SysMain", "Spooler"], rig.Steps[0].Prior!.Items!);
        Assert.Equal(["DiagTrack", "Spooler"], rig.Steps[1].Prior!.Items!);
        // The user stops SysMain by hand mid-session: it was never ours to start.
        rig.Services.Items["SysMain"] = rig.Services.Items["SysMain"] with { Running = false };
        rig.Engine.Revert();
        Assert.DoesNotContain("start SysMain", rig.Services.Calls);
        Assert.Equal("start Spooler,DiagTrack", Calls(rig).Last());
    }
    [Fact]
    public void ThePromptWaitsForEveryOtherMechanismAndTheRestartIsTheLastRevertStep()
    {
        var rig = Setup(cores: [(0, 2), (0, 2), (0, 2), (0, 2)]);
        rig.Services.Add("DiagTrack");
        rig.Settings.Values[(BoostSessionEngine.HighPerformance, BoosterPaths.CpMinCores)] = 4;
        rig.Engine.Start(Command(Off() with { PauseServices = true, PowerPlan = true, CoreParking = true, PowerThrottling = true }));
        // The journal entry is the oldest, so crash recovery sees the services.
        Assert.Equal("pauseServices", rig.Steps.First(s => s.Event == "captured").Mechanism);
        // The game was already boosted when the prompt would have opened.
        var before = rig.Steps.Take(rig.Elevator.StepsAtFirstCall).ToArray();
        foreach (var id in new[] { "powerPlan", "coreParking", "powerThrottling" })
            Assert.Contains(before, s => s.Event == "applied" && s.Mechanism == id);
        Assert.DoesNotContain(before, s => s.Event == "applied" && s.Mechanism == "pauseServices");
        Assert.Equal(("applied", "pauseServices"), (rig.Steps.Last().Event, rig.Steps.Last().Mechanism));
        // At revert the services restart (the prompt) comes after every other restore.
        string? powerAtPrompt = null; uint? parkingAtPrompt = null;
        rig.Elevator.Hook = action => { if (action == "start") { powerAtPrompt = rig.Power.Current.ToString(); parkingAtPrompt = rig.Settings.Values[(BoostSessionEngine.HighPerformance, BoosterPaths.CpMinCores)]; } };
        var reverts = rig.Engine.Revert();
        Assert.Equal(Power.Balanced.ToString(), powerAtPrompt);
        Assert.Equal(4u, parkingAtPrompt);
        Assert.Equal("start DiagTrack", Calls(rig).Last());
        // Results stay one per capture in reverse capture order, so the services result is last (it was captured first).
        Assert.Equal(["coreParking", "powerThrottling", "powerPlan", "pauseServices"], reverts.Select(r => r.Id));
    }
    [Fact]
    public void ANarrowedServicesJournalIsStillRestartedLastAndResultsStayAligned()
    {
        var rig = Setup(cores: [(0, 2), (0, 2), (0, 2), (0, 2)]);
        rig.Services.Add("DiagTrack"); rig.Services.Add("SysMain");
        rig.Settings.Values[(Power.Balanced, BoosterPaths.CpMinCores)] = 4;
        rig.Elevator.StopOnly = ["DiagTrack"];
        rig.Engine.Start(Command(Off() with { PauseServices = true, CoreParking = true }));
        // Captured: planned services, core parking, then the narrowed services entry (the planned one was released).
        var order = rig.Steps.Where(s => s.Event == "captured").Select(s => s.Mechanism).ToArray();
        Assert.Equal(["pauseServices", "coreParking", "pauseServices"], order);
        uint? parkingAtPrompt = null;
        rig.Elevator.Hook = action => { if (action == "start") parkingAtPrompt = rig.Settings.Values[(Power.Balanced, BoosterPaths.CpMinCores)]; };
        var reverts = rig.Engine.Revert();
        Assert.Equal(4u, parkingAtPrompt);
        // Reverse capture order: narrowed services, core parking, the released original ("never applied").
        Assert.Equal(["pauseServices", "coreParking", "pauseServices"], reverts.Select(r => r.Id));
        Assert.Contains("Restarted DiagTrack", reverts[0].Detail);
        Assert.Equal("Never applied; nothing to undo.", reverts[2].Detail);
    }
    [Fact]
    public void RecoveryRestartsServicesAfterTheOtherRevertsEvenWhenTheyWereCapturedLast()
    {
        var rig = Setup();
        rig.Services.Add("DiagTrack", running: false);
        rig.Throttling.State = (1u, 0u);
        var services = new Captured("pauseServices", Items: ["DiagTrack"]);
        var throttle = new Captured("powerThrottling", Game, "0:0", "1:0");
        string? stateAtPrompt = null;
        rig.Elevator.Hook = action => { if (action == "start") stateAtPrompt = rig.Throttling.State.ToString(); };
        // Node's order: oldest first. Services were captured after the throttling entry (a narrowed journal).
        var results = rig.Engine.Recover([throttle, services]);
        Assert.Equal(["pauseServices", "powerThrottling"], results.Select(r => r.Id));
        Assert.Equal("(0, 0)", stateAtPrompt);
        Assert.All(results, r => Assert.Equal("reverted", r.State));
        // And without elevation the other restores still happen while the services stay pending.
        var quiet = Setup(elevate: false);
        quiet.Services.Add("DiagTrack", running: false); quiet.Throttling.State = (1u, 0u);
        var pending = quiet.Engine.Recover([throttle, services]);
        Assert.Equal(["failed", "reverted"], pending.Select(r => r.State));
        Assert.Equal((0u, 0u), quiet.Throttling.State);
    }
    [Fact]
    public void RevertWaitsOutAStoppingServiceAndReportsItHonestly()
    {
        var rig = Setup();
        rig.Services.Add("DiagTrack");
        rig.Services.Items["DiagTrack"] = rig.Services.Items["DiagTrack"] with { Running = false, StopPending = true };
        var result = rig.Engine.Recover([new Captured("pauseServices", Items: ["DiagTrack"])]).Single();
        Assert.Equal(("failed", "stop-pending"), (result.State, result.Code));
        Assert.Contains("still shutting down", result.Detail);
        Assert.Empty(rig.Elevator.Calls);
        // Mixed: the settled one is started, the stopping one is reported.
        rig.Services.Add("Spooler", running: false);
        var mixed = rig.Engine.Recover([new Captured("pauseServices", Items: ["DiagTrack", "Spooler"])]).Single();
        Assert.Equal(("failed", "stop-pending"), (mixed.State, mixed.Code));
        Assert.True(rig.Services.Query("Spooler").Running);
        // The start step refuses a service that is still stopping instead of calling StartService on it.
        var batch = ServiceCommands.Execute("start", ["DiagTrack"], rig.Services, new Controllers(false));
        Assert.Equal(("failed", "stop-pending"), (batch.Outcomes.Single().State, batch.Outcomes.Single().Code));
    }
    private sealed class FaultyStore(Services inner, string faulty) : IServiceStore
    {
        public ServiceInfo Query(string name) => inner.Query(name);
        public bool Stop(string name, TimeSpan timeout) => name == faulty ? throw new InvalidOperationException($"{name} is not installed.") : inner.Stop(name, timeout);
        public bool Start(string name, TimeSpan timeout) => inner.Start(name, timeout);
        public bool StaysRunning(string name, TimeSpan window, out uint exitCode) => inner.StaysRunning(name, window, out exitCode);
    }
    [Fact]
    public void AMidBatchFailureKeepsTheOutcomesAlreadyCollected()
    {
        var services = new Services();
        services.Add("DiagTrack"); services.Add("SysMain"); services.Add("Spooler");
        var batch = ServiceCommands.Execute("stop", ["DiagTrack", "SysMain", "Spooler"], new FaultyStore(services, "SysMain"), new Controllers(false));
        Assert.Equal(["stopped", "failed", "stopped"], batch.Outcomes.Select(o => o.State));
        Assert.Equal("service-error", batch.Outcomes[1].Code);
        Assert.Equal(["stop DiagTrack", "stop Spooler"], services.Calls);
    }
    [Fact]
    public void SkippedServicesCarryStructuredCodes()
    {
        var services = new Services();
        services.Add("DiagTrack", running: false); services.Add("Spooler", canStop: false); services.Add("TrkWks", dependents: "Other"); services.Add("XblAuthManager"); services.Add("XboxGipSvc");
        var plan = ServicePolicy.Plan(services, true, true);
        string Code(string name) => plan.Skipped.Single(s => s.Name == name).Code!;
        Assert.Equal(["not-running", "cannot-stop", "has-dependents", "store-game", "controller-connected", "not-installed"], new[] { Code("DiagTrack"), Code("Spooler"), Code("TrkWks"), Code("XblAuthManager"), Code("XboxGipSvc"), Code("WSearch") });
        var json = System.Text.Json.JsonSerializer.Serialize(new MechanismResult("pauseServices", "failed", "x", "stop-timeout"), HelperJson.Options);
        Assert.Equal("{\"id\":\"pauseServices\",\"state\":\"failed\",\"detail\":\"x\",\"code\":\"stop-timeout\"}", json);
        Assert.DoesNotContain("code", System.Text.Json.JsonSerializer.Serialize(new MechanismResult("a", "applied", "x"), HelperJson.Options));
    }
    [Fact]
    public void TheResultFileGetsItsCanonicalPathEvenWhenTempIsAShortName()
    {
        var dir = Path.Combine(Path.GetTempPath(), "frameforge-long-directory-name-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dir);
        try
        {
            var buffer = new System.Text.StringBuilder(260);
            if (GetShortPathNameW(dir, buffer, 260) == 0 || string.Equals(buffer.ToString(), dir, StringComparison.OrdinalIgnoreCase))
                return; // 8.3 names are switched off on this volume; nothing to prove here.
            var shortDir = buffer.ToString();
            var path = WindowsServiceElevator.NewResultPath(shortDir);
            Assert.StartsWith(dir, path, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("~", path);
            Assert.True(RestoreCommands.ValidResultPath(path));
        }
        finally { Directory.Delete(dir, true); }
    }
    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern uint GetShortPathNameW(string longPath, System.Text.StringBuilder shortPath, uint length);
    [Fact]
    public void ReadingRealDependentsUsesTheRightStructStride()
    {
        // Dhcp, Dnscache and nsi have several running dependents on any Windows PC; protected services refuse access, so try each.
        var store = new WindowsServiceStore();
        foreach (var candidate in new[] { "Dhcp", "Dnscache", "nsi" })
        {
            ServiceInfo info;
            try { info = store.Query(candidate); } catch (System.ComponentModel.Win32Exception) { continue; }
            if (!info.Exists || info.ActiveDependents.Length == 0) continue;
            // A wrong stride would produce garbage or fewer names; every name read must be a real service.
            Assert.All(info.ActiveDependents, name => Assert.True(store.Query(name).Exists, name));
            Assert.True(info.ActiveDependents.Length >= 2, candidate);
            break;
        }
        Assert.False(store.Query("NoSuchServiceFrameforge").Exists);    }

    // ---- fix round 1: smart cores on Windows 11, X3D detection ----
    [Fact]
    public void SmartCoresStaysOffInPresetsOnWindows11ButCustomAndWindows10CanUseIt()
    {
        var preset = Setup(build: 26300);
        preset.Engine.Start(Command(Off() with { SmartCores = true }, preset: true));
        Assert.Equal("skipped", preset.Steps.Single().Event);
        Assert.Contains("Thread Director", preset.Steps.Single().Detail);
        Assert.Empty(preset.Sets.Current);

        var custom = Setup(build: 26300);
        custom.Engine.Start(Command(Off() with { SmartCores = true }));
        Assert.Equal("applied", Result(custom, "smartCores").Event);

        var win10 = Setup(build: 19045);
        win10.Engine.Start(Command(Off() with { SmartCores = true }, preset: true));
        Assert.Equal("applied", Result(win10, "smartCores").Event);
        Assert.Equal(8, win10.Sets.Current.Length);

        // Non-hybrid stays "unsupported" even in a preset: the more useful reason wins.
        var plain = Setup(build: 26300, cores: [(0, 2), (0, 2), (0, 2), (0, 2)]);
        plain.Engine.Start(Command(Off() with { SmartCores = true }, preset: true));
        Assert.Equal("unsupported", plain.Steps.Single().Event);
    }
    [Fact]
    public void DualCcdX3dDetectionPrefersTheCacheLayoutAndFailsClosedOnNames()
    {
        foreach (var name in new[] { "AMD Ryzen 9 7950X3D 16-Core Processor", "AMD Ryzen 9 9950X3D", "AMD Ryzen 9 9900X3D", "AMD Ryzen 9 9950X3D2", "AMD Ryzen 9 7945HX3D", "AMD Ryzen 9 9955HX3D", "AMD Ryzen 9 7900X3D" })
            Assert.True(SmartCores.IsDualCcdX3d(name), name);
        foreach (var name in new[] { "AMD Ryzen 7 5800X3D 8-Core Processor", "AMD Ryzen 7 7800X3D", "AMD Ryzen 7 9800X3D", "AMD Ryzen 5 5600X3D", "AMD Ryzen 9 7950X", "13th Gen Intel(R) Core(TM) i5-13420H" })
            Assert.False(SmartCores.IsDualCcdX3d(name), name);
        // The cache layout decides when Windows reports it.
        Assert.True(SmartCores.IsDualCcdX3d("AMD Ryzen 9 9955HX3D", [96 << 20, 32 << 20]));
        Assert.True(SmartCores.IsDualCcdX3d("AMD Ryzen 9 9950X3D2", [96 << 20, 96 << 20]));
        Assert.False(SmartCores.IsDualCcdX3d("AMD Ryzen 9 7945HX3D", [96 << 20]));
        Assert.False(SmartCores.IsDualCcdX3d("AMD Ryzen 7 7800X3D", [96 << 20]));
        Assert.False(SmartCores.IsDualCcdX3d("AMD Ryzen 9 7950X", [32 << 20, 32 << 20]));
        Assert.False(SmartCores.IsDualCcdX3d("Intel Core i9", [36 << 20]));
        // Core parking uses the same decision.
        var rig = Setup(cpu: "AMD Ryzen 9 9955HX3D"); rig.Settings.Values[(Power.Balanced, BoosterPaths.CpMinCores)] = 4;
        rig.Engine.Start(Command(Off() with { CoreParking = true }));
        Assert.Equal("unsupported", rig.Steps.Single().Event);
        // The real PC reports its own cache layout.
        var real = new WindowsCpuTopology().L3Sizes();
        Assert.True(real is null || real.Length >= 1);
    }

    // ---- capabilities, contract parity, network ----
    [Fact]
    public void CapabilitiesReportEveryNewMechanismPerPc()
    {
        var rig = Setup(); rig.Services.Add("DiagTrack"); rig.Settings.Values[(Power.Balanced, BoosterPaths.CpMinCores)] = 4;
        var caps = BoostSessionEngine.Capabilities(rig.Power, new Timer(), 12, new MemoryStore(), null, rig.Extras);
        string[] ids = ["pauseServices", "gameBarCapture", "smartCores", "coreParking", "powerThrottling"];
        foreach (var id in ids) Assert.Contains(caps.Mechanisms, m => m.Id == id);
        Assert.True(caps.Mechanisms.Single(m => m.Id == "pauseServices").Available);
        Assert.True(caps.Mechanisms.Single(m => m.Id == "smartCores").Available);
        Assert.Equal(8, caps.Topology!.PerformanceThreads);
        Assert.DoesNotContain(caps.Mechanisms, m => m.Id is "gpuPreference" or "fullscreenOptimizations");
        Assert.True(caps.Topology!.ThreadDirector, "hybrid on build 26300");
        Assert.Contains("Thread Director", caps.Mechanisms.Single(m => m.Id == "smartCores").Detail);
        Assert.False(BoostSessionEngine.Capabilities(Setup(build: 19045).Power, new Timer(), 12, new MemoryStore(), null, Setup(build: 19045).Extras).Topology!.ThreadDirector);
        var none = BoostSessionEngine.Capabilities(rig.Power, new Timer(), 12, new MemoryStore(), null, null);
        Assert.All(ids, id => Assert.False(none.Mechanisms.Single(m => m.Id == id).Available));
    }
    [Fact]
    public void NewJsonShapesMatchWhatNodeSendsAndExpects()
    {
        var options = HelperJson.Options;
        // Every mechanism key Node sends; the helper rejects unknown members.
        var keys = "gameMode,priority,affinity,powerPlan,lowerBackground,suspendBackground,closeBackground,timerResolution,pauseServices,gameBarCapture,smartCores,coreParking,powerThrottling".Split(',');
        var json = "{" + string.Join(",", keys.Select(k => k == "priority" ? "\"priority\":\"High\"" : k == "affinity" ? "\"affinity\":null" : $"\"{k}\":true")) + "}";
        var parsed = JsonSerializer.Deserialize<Mechanisms>(json, options)!;
        Assert.True(parsed.PauseServices && parsed.GameBarCapture && parsed.SmartCores && parsed.CoreParking && parsed.PowerThrottling);
        var command = JsonSerializer.Deserialize<SessionCommand>("{\"command\":\"start\",\"storeGame\":true,\"unattended\":true,\"preset\":true}", options)!;
        Assert.True(command.StoreGame && command.Unattended && command.Preset);
        var captured = new Captured("gameBarCapture", RegValues: [new RegCapture(BoosterPaths.GameDvr, "AppCaptureEnabled", "DWord", false, null, 0)]);
        Assert.Equal("{\"mechanism\":\"gameBarCapture\",\"regValues\":[{\"path\":\"Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\GameDVR\",\"name\":\"AppCaptureEnabled\",\"kind\":\"DWord\",\"existed\":false,\"value\":null,\"applied\":0}]}", JsonSerializer.Serialize(captured, options));
        var service = new Captured("pauseServices", Items: ["DiagTrack"]);
        Assert.Equal("{\"mechanism\":\"pauseServices\",\"items\":[\"DiagTrack\"]}", JsonSerializer.Serialize(service, options));
        var parking = new Captured("coreParking", Prior: "4", Applied: "100", Scheme: Scheme.ToString(), Setting: "cpmincores");
        Assert.Equal("{\"mechanism\":\"coreParking\",\"prior\":\"4\",\"applied\":\"100\",\"scheme\":\"396783ca-20d2-459f-b042-4722bc020d51\",\"setting\":\"cpmincores\"}", JsonSerializer.Serialize(parking, options));
        var back = JsonSerializer.Deserialize<Captured>(JsonSerializer.Serialize(captured, options), options)!;
        Assert.Equal(JsonValueKind.Number, ((JsonElement)back.RegValues![0].Applied).ValueKind);
    }
    [Fact]
    public void NetworkCheckSummarizesLossAndJitterAndValidatesTheHost()
    {
        Assert.True(NetworkCheck.ValidHost("example.com")); Assert.True(NetworkCheck.ValidHost("1.1.1.1")); Assert.True(NetworkCheck.ValidHost("2606:4700:4700::1111")); Assert.True(NetworkCheck.ValidHost("my-router"));
        foreach (var bad in new[] { "", " ", "a b", "example.com/path", "http://x", "-bad", "bad-", "x;y", "1", "999", "1.2.3", new string('a', 254), "a$b" }) Assert.False(NetworkCheck.ValidHost(bad), bad);
        var summary = NetworkCheck.Summarize("example.com", IPAddress.Parse("1.1.1.1"), [10, 20, null, 10]);
        Assert.Equal((4, 3, 25.0, 10.0, 13.3, 20.0, 10.0), (summary.Sent, summary.Received, summary.LossPercent, summary.MinMs, summary.AvgMs, summary.MaxMs, summary.JitterMs));
        var dead = NetworkCheck.Summarize("example.com", IPAddress.Parse("1.1.1.1"), [null, null, null]);
        Assert.Equal((3, 0, 100.0, null), (dead.Sent, dead.Received, dead.LossPercent, dead.AvgMs));
    }
    private sealed class FakePinger(params double?[] replies) : IPinger
    {
        private int index;
        public double? Ping(IPAddress address, int timeoutMs) => replies[index++ % replies.Length];
    }
    private sealed class FakeResolver(string? address) : IResolver { public IPAddress? Resolve(string host) => address is null ? null : IPAddress.Parse(address); }
    [Fact]
    public void NetworkCheckPingsTheRequestedCountAndRefusesLocalTargets()
    {
        var pauses = 0;
        var result = NetworkCheck.Run("example.com", 5, new FakePinger(12, 14, null, 12, 13), new FakeResolver("93.184.216.34"), _ => pauses++);
        Assert.Equal((5, 4, 20.0, 4), (result.Sent, result.Received, result.LossPercent, pauses));
        Assert.Equal("93.184.216.34", result.Address);
        Assert.Throws<InvalidOperationException>(() => NetworkCheck.Run("example.com", 2, new FakePinger(1), new FakeResolver("93.184.216.34")));
        Assert.Throws<InvalidOperationException>(() => NetworkCheck.Run("example.com", 31, new FakePinger(1), new FakeResolver("93.184.216.34")));
        Assert.Throws<InvalidOperationException>(() => NetworkCheck.Run("localhost", 5, new FakePinger(1), new FakeResolver("127.0.0.1")));
        Assert.Throws<InvalidOperationException>(() => NetworkCheck.Run("bad host", 5, new FakePinger(1), new FakeResolver("1.1.1.1")));
        Assert.Equal(100.0, NetworkCheck.Run("nope.invalid", 5, new FakePinger(1), new FakeResolver(null)).LossPercent);
        Assert.True(NetworkCheck.Useful(IPAddress.Parse("192.168.1.1")));
    }
}
