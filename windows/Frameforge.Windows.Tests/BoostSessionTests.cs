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
        // Per-thread suspend counts, like Windows: NtSuspendProcess adds one to every existing thread, NtResumeProcess removes one.
        public Dictionary<int, List<int>> Counts { get; } = new();
        public List<int> ThreadsOf(int pid) => Counts.TryGetValue(pid, out var t) ? t : Counts[pid] = [0, 0];
        public IEnumerable<int> Suspended => Counts.Where(kv => kv.Value.Any(c => c > 0)).Select(kv => kv.Key);
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
        public bool RefuseSuspend { get; set; }
        public bool BrokenRecheck { get; set; }
        private bool resumed;
        public bool Suspend(ProcessTarget id)
        {
            if (RefuseSuspend) throw new Win32Exception(5);
            Calls.Add($"suspend {id.Pid}"); var t = ThreadsOf(id.Pid);
            for (var i = 0; i < t.Count; i++) t[i]++;
            return t.All(c => c > 0);
        }
        public void Resume(ProcessTarget id)
        {
            Calls.Add($"resume {id.Pid}"); var t = ThreadsOf(id.Pid); resumed = true;
            for (var i = 0; i < t.Count; i++) if (t[i] > 0) t[i]--;
        }
        public (int Suspended, int Total) Threads(ProcessTarget id)
        {
            if (BrokenRecheck && resumed) throw new InvalidOperationException("thread list unavailable");
            var t = ThreadsOf(id.Pid); return (t.Count(c => c > 0), t.Count);
        }
        public int Close(ProcessTarget[] ids) { foreach (var id in ids) { Calls.Add($"close {id.Pid}"); Running.Remove(id.Pid); } return ids.Length; }
    }
    private sealed class FakePower(params Guid[] schemes) : IPowerStore
    {
        public static readonly Guid Balanced = new("381b4222-f694-41f0-9685-ff5bb260df2e");
        public List<Guid> Schemes { get; } = [Balanced, .. schemes];
        public Dictionary<Guid, string> Names { get; } = new() { [Balanced] = "Balanced" };
        public HashSet<Guid> Refused { get; } = [];
        public bool FailName { get; set; }
        public Guid Current { get; set; } = Balanced;
        public Guid Active() => Current;
        public bool Exists(Guid scheme) => Schemes.Contains(scheme);
        public Guid[] List() => [.. Schemes];
        public void SetActive(Guid scheme) => Current = scheme;
        public void Duplicate(Guid source, Guid destination, string name)
        {
            if (Refused.Contains(source)) throw new Win32Exception(87);
            Schemes.Add(destination);
            if (FailName) { Schemes.Remove(destination); throw new Win32Exception(5); }
            Names[destination] = name;
        }
        public bool ThrowName { get; set; }
        public string? Name(Guid scheme) => ThrowName ? throw new Win32Exception(5) : Names.GetValueOrDefault(scheme);
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
        // 600 was resumed by someone else; 601 was additionally suspended by another program (count 2 on every thread).
        rig.Processes.Resume(P(600, @"C:\Apps\sync.exe"));
        for (var i = 0; i < rig.Processes.ThreadsOf(601).Count; i++) rig.Processes.ThreadsOf(601)[i]++;
        rig.Processes.Calls.Clear();
        var reverts = rig.Engine.Revert();
        // N-2: still suspended by someone else is a kept external state (conflict), not a failure, and it is resumed once only.
        Assert.Equal(["conflict", "reverted"], reverts.Select(r => r.State));
        Assert.Contains("Windows or another program", reverts[0].Detail);
        Assert.Equal(["resume 601"], rig.Processes.Calls);
        Assert.All(rig.Processes.ThreadsOf(601), c => Assert.Equal(1, c));
    }
    [Fact]
    public void PartiallySuspendedAppIsResumedOnce()
    {
        // N-1: a thread created after the suspend runs; the others still hold Frameforge's suspend and must be resumed.
        var rig = Setup();
        rig.Processes.Add(P(700, @"C:\Apps\browser.exe"));
        rig.Engine.Start(Command(Off() with { SuspendBackground = true }, new BackgroundRule("browser.exe", "suspend")));
        rig.Processes.ThreadsOf(700).Add(0);
        var revert = rig.Engine.Revert().Single();
        Assert.Equal("reverted", revert.State);
        Assert.Contains("resumed", revert.Detail);
        Assert.Empty(rig.Processes.Suspended);
        Assert.Single(rig.Processes.Calls, c => c == "resume 700");
    }
    [Fact]
    public void AppsAlreadyFrozenByWindowsAreNotCapturedOrTouched()
    {
        var rig = Setup();
        rig.Processes.Add(P(800, @"C:\Apps\phone.exe"));
        rig.Processes.Counts[800] = [1, 1, 1];
        rig.Engine.Start(Command(Off() with { SuspendBackground = true }, new BackgroundRule("phone.exe", "suspend")));
        Assert.DoesNotContain(rig.Steps, s => s.Event == "captured");
        Assert.Contains(rig.Steps, s => s.Event == "skipped" && s.Detail!.Contains("already suspended"));
        Assert.Empty(rig.Engine.Revert());
        Assert.Equal([1, 1, 1], rig.Processes.Counts[800]);
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
        var owned = Guid.NewGuid();
        BoostSessionEngine.CreatePlan(power, owned);
        Assert.True(power.Exists(owned));
        Assert.Equal(BoostSessionEngine.OwnedPlanName, power.Name(owned));
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
        var refusal = Assert.Throws<PlanNotCreatedException>(() => BoostSessionEngine.CreatePlan(none, Guid.NewGuid()));
        Assert.Contains("Windows said:", refusal.Message);
        Assert.Contains("error 87", refusal.Message);
        Assert.Contains("Nothing was changed", refusal.Message);
    }
    [Fact]
    public void CreateRefusesWhileAnUnrecordedSameNamePlanExistsAndDuplicatesAreRemovedStrictly()
    {
        var older = Guid.NewGuid(); var other = Guid.NewGuid(); var user = Guid.NewGuid();
        var power = new FakePower(BoostSessionEngine.HighPerformance, older, other, user);
        power.Names[older] = BoostSessionEngine.OwnedPlanName; power.Names[other] = BoostSessionEngine.OwnedPlanName; power.Names[user] = "frameforge high performance (mine)";
        Assert.Equal([older.ToString(), other.ToString()], BoostSessionEngine.SameNamePlans(power).Select(p => p.Guid));
        var destination = Guid.NewGuid();
        var refusal = Assert.Throws<PlanNotCreatedException>(() => BoostSessionEngine.CreatePlan(power, destination));
        Assert.Contains("already exists", refusal.Message);
        Assert.False(power.Exists(destination));
        // Duplicate removal: exact name only, not active, never built-in.
        Assert.Throws<InvalidOperationException>(() => BoostSessionEngine.DeleteDuplicate(power, user));
        Assert.Throws<InvalidOperationException>(() => BoostSessionEngine.DeleteDuplicate(power, BoostSessionEngine.HighPerformance));
        power.Current = other;
        Assert.True(BoostSessionEngine.SameNamePlans(power).Single(p => p.Guid == other.ToString()).Active);
        Assert.Throws<InvalidOperationException>(() => BoostSessionEngine.DeleteDuplicate(power, other));
        BoostSessionEngine.DeleteDuplicate(power, older);
        Assert.False(power.Exists(older)); Assert.True(power.Exists(user) && power.Exists(other));
        power.Current = FakePower.Balanced;
        BoostSessionEngine.DeleteDuplicate(power, other);
        BoostSessionEngine.CreatePlan(power, destination);
        Assert.True(power.Exists(destination));
    }
    [Fact]
    public void DeleteRefusesBuiltInAndUserPlansAndNamingFailureLeavesNoCopy()
    {
        // N-4: only a plan carrying the Frameforge name is deletable, never a built-in scheme.
        var acer = new Guid("63110160-d005-4a96-85a8-a00233639354");
        var powerSaver = new Guid("a1841308-3541-4fab-bc81-f71556f20b4a");
        var power = new FakePower(acer, powerSaver);
        power.Names[acer] = "Acer";
        foreach (var plan in new[] { FakePower.Balanced, powerSaver, BoostSessionEngine.HighPerformance, BoostSessionEngine.Ultimate, acer })
            Assert.Throws<InvalidOperationException>(() => BoostSessionEngine.DeletePlan(power, plan));
        Assert.True(power.Exists(acer) && power.Exists(FakePower.Balanced) && power.Exists(powerSaver));
        // A copy whose name cannot be written is removed and creation fails.
        var failing = new FakePower { FailName = true };
        var destination = Guid.NewGuid();
        Assert.Throws<PlanNotCreatedException>(() => BoostSessionEngine.CreatePlan(failing, destination));
        Assert.False(failing.Exists(destination));
        Assert.Throws<PlanNotCreatedException>(() => BoostSessionEngine.CreatePlan(power, FakePower.Balanced));
    }
    [Fact]
    public void RecoveryToleratesARemovedFrameforgePlanAndCapabilitiesMatchTheEngine()
    {
        // nm-2: the plan was removed while a recovery was pending; the previous plan is already active, so nothing is left to do.
        var power = new FakePower();
        var rig = Setup(power);
        var removed = Guid.NewGuid();
        var item = new Captured("powerPlan", Prior: FakePower.Balanced.ToString(), Applied: removed.ToString());
        Assert.Equal("reverted", rig.Engine.Recover([item]).Single().State);
        // nm-3: Ultimate active while High performance exists means the session skips, and the capability says so.
        var both = new FakePower(BoostSessionEngine.HighPerformance, BoostSessionEngine.Ultimate) { Current = BoostSessionEngine.Ultimate };
        var plan = BoostSessionEngine.Capabilities(both, new FakeTimer(), 8, new MemoryRegistry(), null).Mechanisms.Single(m => m.Id == "powerPlan");
        Assert.True(plan.Active);
        var skip = Setup(both); skip.Engine.Start(Command(Off() with { PowerPlan = true }));
        Assert.Equal("skipped", skip.Steps.Single().Event);
        // nm-4: an unreadable value marks only its own mechanism unavailable.
        var broken = BoostSessionEngine.Capabilities(new ThrowingPower(), new FakeTimer(), 8, new MemoryRegistry(), null);
        Assert.False(broken.Mechanisms.Single(m => m.Id == "powerPlan").Available);
        Assert.True(broken.Mechanisms.Single(m => m.Id == "gameMode").Available);
    }
    private sealed class ThrowingPower : IPowerStore
    {
        public Guid Active() => throw new Win32Exception(5);
        public bool Exists(Guid scheme) => throw new Win32Exception(5);
        public void SetActive(Guid scheme) => throw new Win32Exception(5);
        public void Duplicate(Guid source, Guid destination, string name) => throw new Win32Exception(5);
        public string? Name(Guid scheme) => null;
        public void Delete(Guid scheme) => throw new Win32Exception(5);
    }
    [Fact]
    public void AFailedSuspendIsReleasedAndNeverResumed()
    {
        // nm2-4: the capture is announced first (GC-10) but released when the suspend call throws.
        var rig = Setup();
        rig.Processes.Add(P(910, @"C:\Apps\sync.exe"));
        rig.Processes.Counts[910] = [1, 0];
        rig.Processes.RefuseSuspend = true;
        rig.Engine.Start(Command(Off() with { SuspendBackground = true }, new BackgroundRule("sync.exe", "suspend")));
        Assert.Equal(["captured", "released", "failed"], rig.Steps.Select(s => s.Event));
        var revert = rig.Engine.Revert().Single();
        Assert.Equal(("reverted", "Never applied; nothing to undo."), (revert.State, revert.Detail));
        Assert.DoesNotContain(rig.Processes.Calls, c => c.StartsWith("resume"));
        Assert.Equal([1, 0], rig.Processes.Counts[910]);
    }
    [Fact]
    public void AResumeWhoseRecheckFailsIsNotReportedAsFailed()
    {
        // nm2-4: a failed re-check after a successful resume must not trigger a second resume on retry.
        var rig = Setup();
        rig.Processes.Add(P(920, @"C:\Apps\sync.exe"));
        rig.Engine.Start(Command(Off() with { SuspendBackground = true }, new BackgroundRule("sync.exe", "suspend")));
        rig.Processes.BrokenRecheck = true;
        var revert = rig.Engine.Revert().Single();
        Assert.Equal("reverted", revert.State);
        Assert.Contains("could not be re-checked", revert.Detail);
        Assert.Single(rig.Processes.Calls, c => c == "resume 920");
    }
    [Fact]
    public void PlanCreationNeverClaimsNothingChangedWhenACopyMayRemain()
    {
        // nm2-1: a verification failure after the copy is not "plan-not-created", so Frameforge keeps the record.
        var power = new FakePower { ThrowName = true };
        var destination = Guid.NewGuid();
        var error = Assert.ThrowsAny<InvalidOperationException>(() => BoostSessionEngine.CreatePlan(power, destination));
        Assert.IsNotType<PlanNotCreatedException>(error);
        Assert.IsType<PlanNotCreatedException>(Assert.ThrowsAny<InvalidOperationException>(() => BoostSessionEngine.CreatePlan(new FakePower { FailName = true }, Guid.NewGuid())));
        // Remove can clean up a recorded copy left unnamed or with the Windows source name, never a user-named plan.
        power.ThrowName = false;
        power.Names[destination] = "High performance";
        Assert.Contains("removed", BoostSessionEngine.DeletePlan(power, destination));
        var unnamed = Guid.NewGuid(); power.Schemes.Add(unnamed);
        Assert.Contains("removed", BoostSessionEngine.DeletePlan(power, unnamed));
        var user = Guid.NewGuid(); power.Schemes.Add(user); power.Names[user] = "My gaming plan";
        Assert.Throws<InvalidOperationException>(() => BoostSessionEngine.DeletePlan(power, user));
        Assert.True(power.Exists(user));
    }
}
