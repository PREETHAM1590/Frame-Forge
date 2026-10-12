using System.ComponentModel;
using System.Text.Json;
using Frameforge.Windows;
using Xunit;

public class BoostSessionTests
{
    private const string Sid = "S-1-5-21-1", Start = "2026-10-12T10:00:00.0000000Z";
    private static ProcessTarget P(int pid, string path, string priority = "Normal") => new(pid, Start, path, Path.GetFileNameWithoutExtension(path), priority);
    private static readonly ProcessTarget Game = P(100, @"C:\Games\Test\game.exe");
    private static Mechanisms Off(string priority = "Normal") => new(false, priority, null, false, false, false, false, false);

    private sealed class FakeProcesses : IProcessControl
    {
        public Dictionary<int, ProcInfo> Running { get; } = new() { [Game.Pid] = new(Game, 1, Sid, false) };
        public Dictionary<int, ulong> Affinity { get; } = new();
        public HashSet<int> Suspended { get; } = [];
        public List<string> Calls { get; } = [];
        public bool Refuse { get; set; }
        public int LogicalCpus => 8;
        public void Add(ProcessTarget p, int session = 1, string? sid = Sid, bool critical = false) => Running[p.Pid] = new(p, session, sid, critical);
        public ProcInfo[] List() => [.. Running.Values];
        public ProcessTarget? Read(ProcessTarget id) => Running.TryGetValue(id.Pid, out var p) && p.Target.StartTime == id.StartTime ? p.Target : null;
        public void SetPriority(ProcessTarget id, string priority)
        {
            if (Refuse) throw new Win32Exception(5);
            Calls.Add($"priority {id.Pid} {priority}");
            Running[id.Pid] = Running[id.Pid] with { Target = Running[id.Pid].Target with { Priority = priority } };
        }
        public ulong GetAffinity(ProcessTarget id) => Affinity.GetValueOrDefault(id.Pid, 0xFFUL);
        public void SetAffinity(ProcessTarget id, ulong mask) => Affinity[id.Pid] = mask;
        public bool Suspend(ProcessTarget id) { Calls.Add($"suspend {id.Pid}"); return Suspended.Add(id.Pid); }
        // Sticky: also suspended by another program, so one resume leaves it suspended.
        public HashSet<int> Sticky { get; } = [];
        public void Resume(ProcessTarget id) { Calls.Add($"resume {id.Pid}"); if (!Sticky.Contains(id.Pid)) Suspended.Remove(id.Pid); }
        public bool IsSuspended(ProcessTarget id) => Suspended.Contains(id.Pid);
        public int Close(ProcessTarget[] ids) { foreach (var id in ids) { Calls.Add($"close {id.Pid}"); Running.Remove(id.Pid); } return ids.Length; }
    }
    private sealed class FakePower(params Guid[] schemes) : IPowerStore
    {
        public static readonly Guid Balanced = new("381b4222-f694-41f0-9685-ff5bb260df2e");
        public List<Guid> Schemes { get; } = [Balanced, .. schemes];
        public HashSet<Guid> Refused { get; } = [];
        public Guid Current { get; set; } = Balanced;
        public Guid Active() => Current;
        public bool Exists(Guid scheme) => Schemes.Contains(scheme);
        public void SetActive(Guid scheme) => Current = scheme;
        public Guid Duplicate(Guid source, string name) { if (Refused.Contains(source)) throw new Win32Exception(87); var created = Guid.NewGuid(); Schemes.Add(created); return created; }
        public void Delete(Guid scheme) => Schemes.Remove(scheme);
    }
    private sealed class FakeTimer(string? unsupported = null) : ITimerControl
    {
        public bool Held { get; private set; }
        public string? Unsupported => unsupported;
        public bool Request() => Held = true;
        public void Release() => Held = false;
    }
    private sealed class MemoryRegistry : IRegistryStore
    {
        public Dictionary<string, ValueState> Values { get; } = new();
        public ValueState Read(Setting setting) => Values.GetValueOrDefault(setting.Name, new(false, null, setting.Kind));
        public void Write(Setting setting, ValueState state) { if (state.Existed) Values[setting.Name] = state; else Values.Remove(setting.Name); }
    }
    private sealed record Rig(FakeProcesses Processes, FakePower Power, FakeTimer Timer, MemoryRegistry Registry, List<Step> Steps, BoostSessionEngine Engine);
    private static Rig Setup(FakePower? power = null, FakeTimer? timer = null, Guid? owned = null)
    {
        var processes = new FakeProcesses(); power ??= new FakePower(BoostSessionEngine.HighPerformance); timer ??= new FakeTimer(); var registry = new MemoryRegistry(); var steps = new List<Step>();
        return new(processes, power, timer, registry, steps, new BoostSessionEngine(processes, power, timer, registry, steps.Add, 999, owned));
    }
    private static SessionCommand Command(Mechanisms m, params BackgroundRule[] background) => new("start", Game.Pid, Game.StartTime, Game.ExecutablePath, m, background, 50);

    [Fact]
    public void PowerPlanIsRestoredOnlyWhileUnchanged()
    {
        var rig = Setup();
        rig.Engine.Start(Command(Off() with { PowerPlan = true }));
        Assert.Equal(BoostSessionEngine.HighPerformance, rig.Power.Current);
        var captured = rig.Steps.Single(s => s.Event == "captured").Prior!;
        Assert.Equal("reverted", rig.Engine.Revert().Single().State);
        Assert.Equal(FakePower.Balanced, rig.Power.Current);

        var external = Guid.NewGuid();
        rig.Power.Current = external;
        Assert.Equal("conflict", rig.Engine.Recover([captured]).Single().State);
        Assert.Equal(external, rig.Power.Current);
    }
    [Fact]
    public void AbsentTargetPlanIsUnavailableAndNothingChanges()
    {
        var rig = Setup(new FakePower());
        rig.Engine.Start(Command(Off() with { PowerPlan = true }));
        var step = rig.Steps.Single();
        Assert.Equal(("unavailable", "High performance plan not present"), (step.Event, step.Detail));
        Assert.Equal(FakePower.Balanced, rig.Power.Current);
    }
    [Fact]
    public void DenylistedOtherSessionAndCriticalProcessesAreNeverTouched()
    {
        var rig = Setup();
        rig.Processes.Add(P(200, @"C:\Windows\explorer.exe"));
        rig.Processes.Add(P(201, @"C:\Apps\chat.exe"), session: 0);
        rig.Processes.Add(P(202, @"C:\Apps\chat.exe"), sid: "S-1-5-21-other");
        rig.Processes.Add(P(203, @"C:\Apps\chat.exe"), critical: true);
        rig.Processes.Add(P(204, @"C:\Apps\chat.exe"), sid: null);
        rig.Processes.Add(P(50, @"C:\Frameforge\electron.exe"));
        rig.Processes.Add(P(51, @"C:\Frameforge\electron.exe"));
        rig.Processes.Add(P(205, @"C:\Apps\chat.exe"));
        rig.Engine.Start(Command(Off() with { SuspendBackground = true, LowerBackground = true }, new BackgroundRule("chat.exe", "suspend"), new BackgroundRule("electron.exe", "suspend")));
        Assert.Equal(["suspend 205"], rig.Processes.Calls);
        Assert.Throws<InvalidOperationException>(() => rig.Engine.Start(Command(Off(), new BackgroundRule("explorer.exe", "lower"))));
        Assert.DoesNotContain(rig.Processes.Calls, c => c.Contains(" 200"));
    }
    [Fact]
    public void SuspendedProcessesAreResumedOnStopAndOnStdinEof()
    {
        var rig = Setup();
        rig.Processes.Add(P(300, @"C:\Apps\sync.exe"));
        rig.Processes.Add(P(301, @"C:\Apps\sync.exe"));
        var written = new List<object>();
        var reason = SessionRunner.Run(new StringReader(""), written.Add, rig.Engine, Command(Off() with { SuspendBackground = true }, new BackgroundRule("sync.exe", "suspend")), null, null, null, 10);
        Assert.Equal("stdin-closed", reason);
        Assert.Equal(["suspend 300", "suspend 301", "resume 301", "resume 300"], rig.Processes.Calls);
        Assert.Empty(rig.Processes.Suspended);
        Assert.Equal(2, rig.Steps.Count(s => s.Event == "captured" && s.Mechanism == "suspendBackground"));

        var stopped = Setup(); stopped.Processes.Add(P(300, @"C:\Apps\sync.exe"));
        Assert.Equal("stop", SessionRunner.Run(new StringReader("{\"command\":\"stop\"}\n"), _ => { }, stopped.Engine, Command(Off() with { SuspendBackground = true }, new BackgroundRule("sync.exe", "suspend")), null, null, null, 10));
        Assert.Empty(stopped.Processes.Suspended);
    }
    [Fact]
    public void PriorityChangesAreCapturedFirstAndExternalChangesAreKept()
    {
        var rig = Setup();
        rig.Engine.Start(Command(Off("High")));
        Assert.Equal(["captured", "applied"], rig.Steps.Select(s => s.Event));
        Assert.Equal(("Normal", "High"), (rig.Steps[0].Prior!.Prior, rig.Steps[0].Prior!.Applied));
        rig.Processes.SetPriority(Game, "AboveNormal");
        Assert.Equal("conflict", rig.Engine.Revert().Single().State);
        Assert.Equal("AboveNormal", rig.Processes.Running[Game.Pid].Target.Priority);

        var refused = Setup(); refused.Processes.Refuse = true;
        refused.Engine.Start(Command(Off("High")));
        Assert.Equal("failed", refused.Steps.Last().Event);
        Assert.Contains("refused", refused.Steps.Last().Detail);
    }
    [Fact]
    public void ProtectedGameTargetIsRefused()
    {
        var rig = Setup();
        var explorer = P(400, @"C:\Windows\explorer.exe"); rig.Processes.Add(explorer);
        Assert.Throws<InvalidOperationException>(() => rig.Engine.Start(new("start", explorer.Pid, explorer.StartTime, explorer.ExecutablePath, Off("High"), [], 50)));
        rig.Processes.Running[Game.Pid] = rig.Processes.Running[Game.Pid] with { Critical = true };
        Assert.Throws<InvalidOperationException>(() => rig.Engine.Start(Command(Off("High"))));
        Assert.Empty(rig.Processes.Calls);
    }
    [Fact]
    public void TimerIsUnsupportedWithoutTheGlobalFlagOnNewBuilds()
    {
        Assert.NotNull(BoostSessionEngine.TimerSupport(19041, null));
        Assert.NotNull(BoostSessionEngine.TimerSupport(22631, 0));
        Assert.NotNull(BoostSessionEngine.TimerSupport(19045, 1));
        Assert.Null(BoostSessionEngine.TimerSupport(22631, 1));
        Assert.Null(BoostSessionEngine.TimerSupport(18363, null));
        var rig = Setup(timer: new FakeTimer("no global timer"));
        rig.Engine.Start(Command(Off() with { TimerResolution = true }));
        Assert.Equal("unsupported", rig.Steps.Single().Event);

        var held = Setup(); held.Engine.Start(Command(Off() with { TimerResolution = true }));
        Assert.True(held.Timer.Held);
        held.Engine.Revert();
        Assert.False(held.Timer.Held);
    }
    [Fact]
    public void GameBarValuesAreCapturedAppliedAndRestored()
    {
        var rig = Setup();
        rig.Registry.Values["AutoGameModeEnabled"] = new(true, 0, "DWord");
        rig.Engine.Start(Command(Off() with { GameMode = true }));
        Assert.Equal(1, rig.Registry.Values["AutoGameModeEnabled"].Value);
        Assert.Equal(1, rig.Registry.Values["AllowAutoGameMode"].Value);
        Assert.Equal("applied", rig.Steps.Last().Event);
        Assert.Equal("reverted", rig.Engine.Revert().Single().State);
        Assert.Equal(0, rig.Registry.Values["AutoGameModeEnabled"].Value);
        Assert.False(rig.Registry.Values.ContainsKey("AllowAutoGameMode"));

        var on = Setup(); on.Registry.Values["AutoGameModeEnabled"] = new(true, 1, "DWord"); on.Registry.Values["AllowAutoGameMode"] = new(true, 1, "DWord");
        on.Engine.Start(Command(Off() with { GameMode = true }));
        Assert.Equal("skipped", on.Steps.Single().Event);
    }
    [Fact]
    public void AffinityAndLoweringRevertAndRecoveryRejectsForeignRegistryValues()
    {
        var rig = Setup();
        rig.Processes.Add(P(500, @"C:\Apps\sync.exe"));
        rig.Engine.Start(Command(Off() with { Affinity = [2, 3], LowerBackground = true }, new BackgroundRule("sync.exe", "lower")));
        Assert.Equal(0b1100UL, rig.Processes.Affinity[Game.Pid]);
        Assert.Equal("BelowNormal", rig.Processes.Running[500].Target.Priority);
        Assert.All(rig.Engine.Revert(), r => Assert.Equal("reverted", r.State));
        Assert.Equal(0xFFUL, rig.Processes.Affinity[Game.Pid]);
        Assert.Equal("Normal", rig.Processes.Running[500].Target.Priority);
        var foreign = new Captured("gameMode", Registry: new([new("mouse-precision", @"Control Panel\Mouse", "MouseSpeed", "String", true, "1")]));
        Assert.Equal("failed", rig.Engine.Recover([foreign]).Single().State);
    }
    [Fact]
    public void AbsentRegistryValuesSerializeAsExplicitNull()
    {
        // C-1 regression: optimizer snapshots and Game Mode captures must keep `value: null` for absent values.
        var registry = new MemoryRegistry();
        var snapshot = JsonSerializer.Serialize(new RegistryOperations(registry).Capture(["capture-off"]), HelperJson.Options);
        Assert.Contains("\"existed\":false,\"value\":null", snapshot);
        var rig = Setup();
        rig.Registry.Values["AutoGameModeEnabled"] = new(true, 0, "DWord");
        rig.Engine.Start(Command(Off() with { GameMode = true }));
        var captured = JsonSerializer.Serialize<object>(rig.Steps.First(s => s.Event == "captured"), HelperJson.Options);
        Assert.Contains("\"name\":\"AllowAutoGameMode\",\"kind\":\"DWord\",\"existed\":false,\"value\":null", captured);
        Assert.DoesNotContain("\"detail\"", captured);
        Assert.DoesNotContain("\"process\"", captured);
        var ended = JsonSerializer.Serialize<object>(new Ended("ended", "stop", null, []), HelperJson.Options);
        Assert.Equal("{\"event\":\"ended\",\"reason\":\"stop\",\"reverts\":[]}", ended);
    }
    [Fact]
    public void GameModeAbsentValuesAreWindowsDefaultOnAndExternalChangesAreKept()
    {
        var rig = Setup();
        rig.Engine.Start(Command(Off() with { GameMode = true }));
        Assert.Equal(("skipped", "Windows Game Mode is already on (Windows default)."), (rig.Steps.Single().Event, rig.Steps.Single().Detail));
        Assert.Empty(rig.Registry.Values);

        var off = Setup(); off.Registry.Values["AutoGameModeEnabled"] = new(true, 0, "DWord");
        off.Engine.Start(Command(Off() with { GameMode = true }));
        off.Registry.Values["AutoGameModeEnabled"] = new(true, 0, "DWord");
        Assert.Equal("conflict", off.Engine.Revert().Single().State);
        Assert.Equal(1, off.Registry.Values["AllowAutoGameMode"].Value);
    }
    [Fact]
    public void CapturesAreCappedAndEveryRevertIsAttempted()
    {
        var rig = Setup();
        for (var pid = 1000; pid < 1250; pid++) rig.Processes.Add(P(pid, @"C:\Apps\browser.exe"));
        rig.Engine.Start(Command(Off() with { SuspendBackground = true }, new BackgroundRule("browser.exe", "suspend")));
        Assert.Equal(BoostSessionEngine.MaxCaptures, rig.Steps.Count(s => s.Event == "captured"));
        Assert.Contains(rig.Steps, s => s.Event == "skipped" && s.Detail!.Contains("50 more process(es)"));
        var reverts = rig.Engine.Revert();
        Assert.Equal(BoostSessionEngine.MaxCaptures, reverts.Length);
        Assert.All(reverts, r => Assert.Equal("reverted", r.State));
        Assert.Empty(rig.Processes.Suspended);
        // Recovery input above the cap is still attempted item by item, never rejected as a whole.
        var many = Enumerable.Range(0, 250).Select(i => new Captured("suspendBackground", P(5000 + i, @"C:\Apps\gone.exe"))).ToArray();
        Assert.Equal(250, rig.Engine.Recover(many).Length);
    }
    [Fact]
    public void ResumeIsVerifiedAndNeverRepeated()
    {
        var rig = Setup();
        rig.Processes.Add(P(600, @"C:\Apps\sync.exe")); rig.Processes.Add(P(601, @"C:\Apps\sync.exe"));
        rig.Engine.Start(Command(Off() with { SuspendBackground = true }, new BackgroundRule("sync.exe", "suspend")));
        rig.Processes.Suspended.Remove(600);
        rig.Processes.Sticky.Add(601);
        var reverts = rig.Engine.Revert();
        Assert.Equal(["failed", "reverted"], reverts.Select(r => r.State));
        Assert.Contains("still suspended", reverts[0].Detail);
        Assert.DoesNotContain("resume 600", rig.Processes.Calls);
    }
    [Fact]
    public void EmptyBackgroundListsAreReportedAsNotConfigured()
    {
        var rig = Setup();
        rig.Engine.Start(Command(Off() with { LowerBackground = true, SuspendBackground = true }));
        Assert.Equal(2, rig.Steps.Count(s => s.Event == "skipped" && s.Detail!.StartsWith("Not configured")));
    }
    [Fact]
    public void OwnedPlanIsCreatedOnConsentUsedAndRemovedSafely()
    {
        var power = new FakePower();
        power.Refused.Add(BoostSessionEngine.HighPerformance);
        var owned = BoostSessionEngine.CreatePlan(power);
        Assert.True(power.Exists(owned));
        Assert.Equal(FakePower.Balanced, power.Current);
        var rig = Setup(power, owned: owned);
        rig.Engine.Start(Command(Off() with { PowerPlan = true }));
        Assert.Equal(owned, power.Current);
        Assert.Throws<InvalidOperationException>(() => BoostSessionEngine.DeletePlan(power, owned));
        Assert.Equal("reverted", rig.Engine.Revert().Single().State);
        Assert.Equal(FakePower.Balanced, power.Current);
        BoostSessionEngine.DeletePlan(power, owned);
        Assert.False(power.Exists(owned));
        Assert.Throws<InvalidOperationException>(() => BoostSessionEngine.DeletePlan(power, BoostSessionEngine.HighPerformance));
        var none = new FakePower(); none.Refused.Add(BoostSessionEngine.HighPerformance); none.Refused.Add(BoostSessionEngine.Ultimate);
        Assert.Throws<InvalidOperationException>(() => BoostSessionEngine.CreatePlan(none));
    }
}
