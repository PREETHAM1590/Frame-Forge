using System.ComponentModel;
using Frameforge.Windows;
using Xunit;

public class BoostCleanupTests
{
    private const string Sid = "S-1-5-21-1", Start = "2026-10-12T10:00:00.0000000Z";
    private const long MB = 1024 * 1024, GB = 1024 * MB;
    private static ProcessTarget P(int pid, string path) => new(pid, Start, path, Path.GetFileNameWithoutExtension(path), "Normal");
    private static readonly ProcessTarget Game = P(100, @"C:\Games\Test\game.exe");
    // A real executable on this machine, so the relaunch path check (File.Exists) holds.
    private static readonly string RealExe = Environment.ProcessPath!;

    private sealed class Fake : IProcessControl, IMemory
    {
        public Dictionary<int, ProcInfo> Running { get; } = new() { [Game.Pid] = new(Game, 1, Sid, false) };
        public Dictionary<int, long> Sets { get; } = new();
        public HashSet<int> Stubborn { get; } = [];
        public HashSet<int> Protected { get; } = [];
        public HashSet<int> Closing { get; } = [];
        public List<string> Calls { get; } = [];
        public List<int> Suspended { get; } = [];
        public long Available { get; set; } = 6 * GB;
        public long Total { get; set; } = 16 * GB;
        public int LogicalCpus => 8;
        public void Add(int pid, string path, long workingSet = 0, int session = 1, string? sid = Sid, bool critical = false)
        {
            Running[pid] = new(P(pid, path), session, sid, critical);
            Sets[pid] = workingSet;
        }
        public (long Available, long Total) Read() => (Available, Total);
        public ProcInfo[] List() => [.. Running.Values];
        public ProcessTarget? Read(ProcessTarget id) => Running.TryGetValue(id.Pid, out var p) && p.Target.StartTime == id.StartTime ? p.Target : null;
        public void SetPriority(ProcessTarget id, string priority) { }
        public ulong GetAffinity(ProcessTarget id) => 0xFF;
        public void SetAffinity(ProcessTarget id, ulong mask) { }
        public bool Suspend(ProcessTarget id) { Calls.Add($"suspend {id.Pid}"); Suspended.Add(id.Pid); return true; }
        public void Resume(ProcessTarget id) { Calls.Add($"resume {id.Pid}"); Suspended.Remove(id.Pid); }
        public (int Suspended, int Total) Threads(ProcessTarget id) => (Suspended.Contains(id.Pid) ? 2 : 0, 2);
        public int Close(ProcessTarget[] ids) => 0;
        public void PostClose(ProcessTarget[] ids) { foreach (var id in ids) { Calls.Add($"wm_close {id.Pid}"); if (!Stubborn.Contains(id.Pid)) Closing.Add(id.Pid); } }
        public void Terminate(ProcessTarget id) { Calls.Add($"terminate {id.Pid}"); Remove(id.Pid); }
        public long WorkingSet(ProcessTarget id) => Sets.GetValueOrDefault(id.Pid);
        public bool TrimWorkingSet(ProcessTarget id)
        {
            if (Protected.Contains(id.Pid)) return false;
            Calls.Add($"trim {id.Pid}");
            Available += Sets[id.Pid] * 3 / 4;
            Sets[id.Pid] /= 4;
            return true;
        }
        public bool Launch(string path) { Calls.Add($"launch {path}"); return true; }
        // The app exits shortly after the polite request; the pause is where time passes in the test.
        public void Pause()
        {
            foreach (var pid in Closing.ToArray()) { Available += Sets.GetValueOrDefault(pid); Remove(pid); }
            Closing.Clear();
        }
        private void Remove(int pid) => Running.Remove(pid);
    }
    private sealed record Rig(Fake Processes, List<Step> Steps, BoostSessionEngine Engine, List<int> Pauses);
    private static Rig Setup(bool memory = true)
    {
        var fake = new Fake();
        var steps = new List<Step>();
        var pauses = new List<int>();
        var engine = new BoostSessionEngine(fake, new NoPower(), new NoTimer(), new NoRegistry(), steps.Add, 999,
            extras: memory ? new Extras(Memory: fake) : new Extras(), sleep: ms => { pauses.Add(ms); fake.Pause(); });
        return new(fake, steps, engine, pauses);
    }
    private static Mechanisms Off(string priority = "Normal") => new(false, priority, null, false, false, false, false, false);
    private static SessionCommand Command(CleanupPlan plan, Mechanisms? m = null, bool unattended = false, params BackgroundRule[] background) =>
        new("start", Game.Pid, Game.StartTime, Game.ExecutablePath, m ?? Off(), background, 50, Cleanup: plan, Unattended: unattended);
    private static string Detail(Rig rig, string id) => rig.Steps.Single(s => s.Mechanism == id && s.Event != "captured").Detail!;

    private sealed class NoPower : IPowerStore
    {
        public Guid Active() => Guid.Empty; public bool Exists(Guid scheme) => false; public void SetActive(Guid scheme) { }
        public void Duplicate(Guid source, Guid destination, string name) { } public string? Name(Guid scheme) => null; public void Delete(Guid scheme) { }
    }
    private sealed class NoTimer : ITimerControl { public string? Unsupported => null; public bool Request() => true; public void Release() { } }
    private sealed class NoRegistry : IRegistryStore
    {
        public ValueState Read(Setting setting) => new(false, null, setting.Kind);
        public void Write(Setting setting, ValueState state) { }
    }

    [Fact]
    public void PoliteCloseEndsNothingByForceAndIsNotReopenedByDefault()
    {
        var rig = Setup();
        rig.Processes.Add(200, @"C:\Apps\big.exe", 500 * MB);
        rig.Engine.Start(Command(new(Rules: [new("big.exe", "close")])));
        Assert.Equal(["wm_close 200"], rig.Processes.Calls.Where(c => c != "wm_close 100"));
        Assert.DoesNotContain(rig.Processes.Running.Keys, k => k == 200);
        Assert.Contains("closed 1 process(es)", Detail(rig, "closeBackground"));
        Assert.Contains("not reopened", Detail(rig, "closeBackground"));
        Assert.DoesNotContain(rig.Steps, s => s.Event == "captured");
    }

    [Fact]
    public void StubbornAppIsLeftRunningUnlessTheRuleSaysEnd()
    {
        var rig = Setup();
        rig.Processes.Add(200, @"C:\Apps\polite.exe", 10 * MB);
        rig.Processes.Add(201, @"C:\Apps\forced.exe", 10 * MB);
        rig.Processes.Stubborn.Add(200); rig.Processes.Stubborn.Add(201);
        rig.Engine.Start(Command(new(Rules: [new("polite.exe", "close"), new("forced.exe", "end")], GraceSeconds: 2)));
        Assert.Contains(200, rig.Processes.Running.Keys);
        Assert.DoesNotContain(201, rig.Processes.Running.Keys);
        Assert.DoesNotContain("terminate 200", rig.Processes.Calls);
        Assert.Contains("terminate 201", rig.Processes.Calls);
        var skipped = rig.Steps.Single(s => s.Event == "skipped" && s.Detail!.StartsWith("polite.exe"));
        Assert.Equal("still-open", skipped.Code);
        Assert.Contains("Left running", skipped.Detail);
        Assert.Contains("had to be ended", rig.Steps.Single(s => s.Detail!.StartsWith("forced.exe")).Detail);
    }

    [Fact]
    public void ClosedAppsAreReopenedAfterTheSessionOnlyWhenAskedAndNotAlreadyRunning()
    {
        var rig = Setup();
        rig.Processes.Add(200, RealExe, 10 * MB);
        var name = Path.GetFileName(RealExe);
        rig.Engine.Start(Command(new(Rules: [new(name, "close")], Relaunch: true)));
        var item = rig.Steps.Single(s => s.Event == "captured").Prior!;
        Assert.Equal(RealExe, item.Launch);
        Assert.Contains("reopened when the session ends", rig.Steps.Single(s => s.Event == "applied").Detail);
        var result = rig.Engine.Revert().Single();
        Assert.Equal("reverted", result.State);
        Assert.Contains($"launch {RealExe}", rig.Processes.Calls);

        // Something already runs from that path: not started a second time.
        var again = Setup();
        again.Processes.Add(300, RealExe);
        var skipped = again.Engine.Recover([item]).Single();
        Assert.Contains("already running", skipped.Detail);
        Assert.DoesNotContain(again.Processes.Calls, c => c.StartsWith("launch"));
    }

    [Fact]
    public void NeverTouchesTheGameItsSiblingsOtherUsersOrOtherSessions()
    {
        var rig = Setup();
        rig.Processes.Add(110, @"C:\Games\Test\game.exe", 900 * MB); // second process of the game's program
        rig.Processes.Add(111, @"C:\Apps\other.exe", 900 * MB, sid: "S-1-5-21-2");
        rig.Processes.Add(112, @"C:\Apps\other.exe", 900 * MB, session: 0);
        rig.Processes.Add(113, @"C:\Apps\other.exe", 900 * MB, critical: true);
        rig.Processes.Add(114, @"C:\Windows\System32\csrss.exe", 900 * MB);
        rig.Processes.Add(50, @"C:\Frameforge\Frameforge.exe", 900 * MB); // our own app (the parent)
        rig.Processes.Add(115, @"C:\Apps\Frameforge Helper.exe", 900 * MB);
        rig.Engine.Start(Command(new(Rules: [new("game.exe", "end"), new("other.exe", "end"), new("Frameforge.exe", "end")],
            Trim: ["game.exe", "other.exe", "csrss.exe", "Frameforge.exe", "Frameforge Helper.exe"])));
        Assert.DoesNotContain(rig.Processes.Calls, c => c.StartsWith("terminate") || c.StartsWith("trim") || c.StartsWith("wm_close"));
        Assert.Equal(8, rig.Processes.Running.Count);
    }

    [Fact]
    public void TrimsOnlyListedBigProcessesAndReportsWhatWasRefused()
    {
        var rig = Setup();
        rig.Processes.Add(200, @"C:\Apps\big.exe", 800 * MB);
        rig.Processes.Add(201, @"C:\Apps\big.exe", 50 * MB); // under the threshold
        rig.Processes.Add(202, @"C:\Apps\locked.exe", 400 * MB); rig.Processes.Protected.Add(202);
        rig.Processes.Add(203, @"C:\Apps\unlisted.exe", 900 * MB);
        rig.Engine.Start(Command(new(Trim: ["big.exe", "locked.exe"])));
        Assert.Equal(["trim 200"], rig.Processes.Calls);
        var detail = Detail(rig, "freeMemory");
        Assert.Contains("Trimmed 1 background process(es) over 100 MB", detail);
        Assert.Contains("1 refused by Windows", detail);
    }

    [Fact]
    public void ReportsTheMeasuredAmountFreedFromBeforeToAfter()
    {
        var rig = Setup();
        rig.Processes.Available = 5 * GB; rig.Processes.Total = 16 * GB;
        rig.Processes.Add(200, @"C:\Apps\big.exe", 2000 * MB);
        rig.Engine.Start(Command(new(Trim: ["big.exe"])));
        var step = rig.Steps.Single(s => s.Mechanism == "freeMemory");
        Assert.Equal("applied", step.Event);
        Assert.StartsWith("Freed 1.5 GB (from 5.0 to 6.5 GB available).", step.Detail);
        Assert.Contains(1000, rig.Pauses); // the pages need a moment to reach the standby list
    }

    [Fact]
    public void SaysMemoryWasAlreadyFineWhenNothingWasTightAndNothingMoved()
    {
        var rig = Setup();
        rig.Processes.Available = 12 * GB;
        rig.Engine.Start(Command(new(Trim: ["big.exe"])));
        var step = rig.Steps.Single(s => s.Mechanism == "freeMemory");
        Assert.Equal("skipped", step.Event);
        Assert.Equal("already-set", step.Code);
        Assert.StartsWith("Memory was already fine: 12.0 GB of 16.0 GB available", step.Detail);
        Assert.DoesNotContain(rig.Steps, s => s.Mechanism == "standbyPurge");
    }

    [Theory]
    [InlineData(1.5, 16, true)]   // under 2 GB
    [InlineData(3.5, 16, true)]   // under 25%
    [InlineData(6.0, 16, false)]
    [InlineData(3.0, 8, false)]   // 37%, over 2 GB
    public void TightMeansUnderAQuarterOrUnderTwoGb(double availableGb, int totalGb, bool tight) =>
        Assert.Equal(tight, BoostSessionEngine.Tight((long)(availableGb * GB), totalGb * GB));

    [Fact]
    public void PurgeIsConsideredOnlyWhenAllowedAndMemoryIsStillTight()
    {
        var tight = Setup();
        tight.Processes.Available = 1 * GB;
        tight.Engine.Start(Command(new(Purge: true), unattended: true));
        Assert.Contains(tight.Steps, s => s.Mechanism == "standbyPurge"); // considered (this rig has no administrator step, so it reports that)
        Assert.Contains("tight", Detail(tight, "freeMemory"));

        var notAllowed = Setup();
        notAllowed.Processes.Available = 1 * GB;
        notAllowed.Engine.Start(Command(new(Purge: false), unattended: true));
        Assert.DoesNotContain(notAllowed.Steps, s => s.Mechanism == "standbyPurge");

        var fine = Setup();
        fine.Engine.Start(Command(new(Purge: true), unattended: true));
        Assert.DoesNotContain(fine.Steps, s => s.Mechanism == "standbyPurge");
    }

    [Fact]
    public void CleanupRunsBeforeAnyOtherChange()
    {
        var rig = Setup();
        rig.Processes.Add(200, @"C:\Apps\big.exe", 500 * MB);
        rig.Engine.Start(Command(new(Rules: [new("big.exe", "close")], Trim: ["big.exe"]), Off("High")));
        var order = rig.Steps.Where(s => s.Event != "captured").Select(s => s.Mechanism).ToList();
        Assert.True(order.IndexOf("closeBackground") < order.IndexOf("freeMemory"));
        Assert.True(order.IndexOf("freeMemory") < order.IndexOf("priority"));
    }

    [Fact]
    public void PausedAppsAreSuspendedWhateverTheModeAndResumedOnStop()
    {
        var rig = Setup();
        rig.Processes.Add(200, @"C:\Apps\sync.exe", 30 * MB);
        rig.Engine.Start(Command(new(Rules: [new("sync.exe", "suspend")])));
        Assert.Equal([200], rig.Processes.Suspended);
        Assert.Contains(rig.Steps, s => s.Mechanism == "suspendBackground" && s.Event == "applied");
        Assert.Equal("reverted", rig.Engine.Revert().Single().State);
        Assert.Empty(rig.Processes.Suspended);
    }

    [Fact]
    public void RulesHandledByTheCleanupAreNotReprocessedByTheModeToggles()
    {
        var rig = Setup();
        rig.Processes.Add(200, @"C:\Apps\big.exe", 30 * MB);
        var mode = Off() with { SuspendBackground = true, CloseBackground = true };
        rig.Engine.Start(Command(new(Rules: [new("big.exe", "close")]), mode, false, new BackgroundRule("big.exe", "close")));
        Assert.Single(rig.Steps, s => s.Mechanism == "closeBackground" && s.Detail!.StartsWith("big.exe"));
        Assert.DoesNotContain(rig.Steps, s => s.Detail!.Contains("not part of the selected mode") || s.Detail!.Contains("Not configured"));
    }

    [Fact]
    public void WithoutAMemoryReadingNothingIsTrimmedAndItSaysSo()
    {
        var rig = Setup(memory: false);
        rig.Processes.Add(200, @"C:\Apps\big.exe", 800 * MB);
        rig.Engine.Start(Command(new(Trim: ["big.exe"])));
        Assert.Equal("unsupported", rig.Steps.Single(s => s.Mechanism == "freeMemory").Event);
        Assert.DoesNotContain(rig.Processes.Calls, c => c.StartsWith("trim"));
    }

    [Fact]
    public void RejectsAnInvalidRuleAction() =>
        Assert.Throws<InvalidOperationException>(() => Setup().Engine.Start(Command(new(), null, false, new BackgroundRule("a.exe", "nuke"))));
}
