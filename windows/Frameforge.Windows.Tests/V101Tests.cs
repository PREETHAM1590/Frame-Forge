using System.ComponentModel;
using System.Text.Json;
using Frameforge.Windows;
using Xunit;

public class V101Tests
{
    private const string Sid = "S-1-5-21-1", Start = "2026-10-12T10:00:00.0000000Z";
    private static readonly ProcessTarget Game = new(100, Start, @"C:\Games\Test\game.exe", "game", "Normal");
    private static Mechanisms Off() => new(false, "Normal", null, false, false, false, false, false);
    private static SessionCommand Command(Mechanisms m, bool unattended = false, bool timerRestart = false) => new("start", Game.Pid, Game.StartTime, Game.ExecutablePath, m, [], 50, null, false, unattended, false, timerRestart);

    // ---- fakes ----
    private sealed class Processes : IProcessControl
    {
        public int LogicalCpus => 12;
        public ProcInfo[] List() => [new(Game, 1, Sid, false)];
        public ProcessTarget? Read(ProcessTarget id) => id.Pid == Game.Pid ? Game : null;
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
        public Guid Active() => new("381b4222-f694-41f0-9685-ff5bb260df2e");
        public bool Exists(Guid scheme) => true;
        public void SetActive(Guid scheme) { }
        public void Duplicate(Guid source, Guid destination, string name) { }
        public string? Name(Guid scheme) => null;
        public void Delete(Guid scheme) { }
    }
    private sealed class Timer(string? unsupported = null, TimerGlobal? global = null) : ITimerControl
    {
        public string? Unsupported => unsupported;
        public bool Request() => true;
        public void Release() { }
        public TimerGlobal Global => global ?? new(false, false);
    }
    private sealed class MemoryStore : IRegistryStore
    {
        public ValueState Read(Setting setting) => new(false, null, setting.Kind);
        public void Write(Setting setting, ValueState state) { }
    }
    private sealed class Services : IServiceStore
    {
        public Dictionary<string, ServiceInfo> Items { get; } = new(StringComparer.OrdinalIgnoreCase);
        public List<string> Calls { get; } = [];
        public Func<string, int, (bool Stays, uint Code)>? Stays { get; set; }
        // Spend the watch window for real, so a test can see how long a restart pass takes.
        public bool Sleep { get; set; }
        private readonly Dictionary<string, int> starts = new();
        public void Add(string name, bool running = true) => Items[name] = new(true, running, true, []);
        public ServiceInfo Query(string name) => Items.GetValueOrDefault(name, new(false, false, false, []));
        public bool Stop(string name, TimeSpan timeout) { Calls.Add($"stop {name}"); Items[name] = Items[name] with { Running = false }; return true; }
        public bool Start(string name, TimeSpan timeout)
        {
            Calls.Add($"start {name}");
            starts[name] = starts.GetValueOrDefault(name) + 1;
            Items[name] = Items[name] with { Running = true };
            return true;
        }
        public bool StaysRunning(string name, TimeSpan window, out uint exitCode)
        {
            if (Sleep) Thread.Sleep(window);
            var (stays, code) = Stays?.Invoke(name, starts[name]) ?? (true, 0u);
            exitCode = stays ? 0 : code;
            if (!stays) Items[name] = Items[name] with { Running = false };
            return stays;
        }
    }
    private sealed class Controllers : IControllerProbe { public bool XboxControllerConnected() => false; }
    private sealed class Purger(string? failure = null) : IMemoryPurger
    {
        public int Calls { get; private set; }
        public string? Purge() { Calls++; return failure; }
    }
    // An elevator that waits like an unanswered prompt until released or cancelled.
    private sealed class PromptElevator(Services services) : IServiceElevator
    {
        public ManualResetEventSlim Gate { get; } = new(false);
        public ManualResetEventSlim Entered { get; } = new(false);
        public List<string> Calls { get; } = [];
        public bool Cancelled { get; private set; }
        public ServiceBatch? Answer { get; set; }
        public ServiceBatch Run(string action, string[] names, CancellationToken cancel = default)
        {
            Calls.Add($"{action} {string.Join(',', names)}");
            Entered.Set();
            if (action == "start") return ServiceCommands.Execute("start", names, services, new Controllers(), stable: TimeSpan.Zero);
            // A scripted answer is a prompt that was already approved: it cannot be cancelled any more.
            if (Answer is not null) { Gate.Wait(); return Answer; }
            try { Gate.Wait(cancel); }
            catch (OperationCanceledException)
            {
                Cancelled = true;
                return new(true, [], "The boost was stopped before administrator approval, so nothing was changed.", ServiceCodes.ElevationCancelled);
            }
            return ServiceCommands.Execute(action, names, services, new Controllers(), new Purger(), TimeSpan.Zero);
        }
    }
    private sealed record Rig(Services Services, PromptElevator Elevator, List<Step> Steps, BoostSessionEngine Engine);
    private static readonly object Lock = new();
    private static Rig Setup(Func<Services, PromptElevator>? elevator = null, bool elevate = true)
    {
        var services = new Services();
        var steps = new List<Step>();
        var prompt = elevator?.Invoke(services) ?? new PromptElevator(services);
        var extras = new Extras(null, null, null, null, null, null, services, prompt, new Controllers(), 26300, elevate);
        var engine = new BoostSessionEngine(new Processes(), new Power(), new Timer(), new MemoryStore(), step => { lock (Lock) steps.Add(step); }, 999, null, extras);
        return new(services, prompt, steps, engine);
    }
    private static Step[] Of(Rig rig, string mechanism) { lock (Lock) return [.. rig.Steps.Where(s => s.Mechanism == mechanism)]; }

    // ---- F1: a started service must stay running ----
    [Fact]
    public void AServiceThatStartsAndDiesIsRetriedOnceThenReportedFailedWithItsExitCode()
    {
        var services = new Services();
        services.Add("SysMain", running: false); services.Add("DiagTrack", running: false); services.Add("Spooler", running: false);
        // SysMain dies after both starts (as it did on the QA PC); DiagTrack dies once and then stays; Spooler is fine.
        services.Stays = (name, starts) => name switch { "SysMain" => (false, 87u), "DiagTrack" => (starts > 1, 1067u), _ => (true, 0u) };
        var batch = ServiceCommands.Execute("start", ["SysMain", "DiagTrack", "Spooler"], services, new Controllers(), stable: TimeSpan.Zero);
        var sys = batch.Outcomes[0];
        Assert.Equal(("failed", "stopped-again"), (sys.State, sys.Code));
        Assert.Contains("87", sys.Detail);
        Assert.Equal(2, services.Calls.Count(c => c == "start SysMain"));
        Assert.Equal("started", batch.Outcomes[1].State);
        Assert.Equal(2, services.Calls.Count(c => c == "start DiagTrack"));
        Assert.Equal("started", batch.Outcomes[2].State);
        Assert.Equal(1, services.Calls.Count(c => c == "start Spooler"));
    }
    [Fact]
    public void RestartingManyServicesWatchesThemInOneSharedWindowNotOneEach()
    {
        var services = new Services { Sleep = true };
        var names = new[] { "DiagTrack", "SysMain", "Spooler", "lfsvc", "PhoneSvc", "TrkWks" };
        foreach (var name in names) services.Add(name, running: false);
        var window = TimeSpan.FromMilliseconds(400);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var batch = ServiceCommands.Execute("start", names, services, new Controllers(), stable: window);
        clock.Stop();
        Assert.All(batch.Outcomes, o => Assert.Equal("started", o.State));
        // Six separate windows would take 2.4 s; one shared window takes about 0.4 s.
        Assert.True(clock.Elapsed < TimeSpan.FromMilliseconds(1200), clock.Elapsed.ToString());
        // A service that died during the watch is the only one restarted, and its second try gets its own watch.
        var one = new Services { Sleep = true };
        foreach (var name in names) one.Add(name, running: false);
        one.Stays = (name, starts) => name == "SysMain" && starts == 1 ? (false, 87u) : (true, 0u);
        var again = ServiceCommands.Execute("start", names, one, new Controllers(), stable: window);
        Assert.All(again.Outcomes, o => Assert.Equal("started", o.State));
        Assert.Equal(2, one.Calls.Count(c => c == "start SysMain"));
        Assert.Equal(1, one.Calls.Count(c => c == "start DiagTrack"));
        Assert.Contains("second try", again.Outcomes.Single(o => o.Name == "SysMain").Detail);
    }
    [Fact]
    public void ADyingServiceKeepsTheJournalSoRetryIsOffered()
    {
        var rig = Setup(s => new PromptElevator(s) { Answer = null });
        rig.Services.Add("SysMain", running: false);
        rig.Services.Stays = (_, _) => (false, 87u);
        var result = rig.Engine.Recover([new Captured("pauseServices", Items: ["SysMain"])]).Single();
        Assert.Equal(("failed", "stopped-again"), (result.State, result.Code));
        Assert.Contains("SysMain", result.Detail);
        Assert.Contains("Retry recovery", result.Detail);
        // A service that stays running is reported as restored.
        rig.Services.Stays = null;
        rig.Services.Items["SysMain"] = rig.Services.Items["SysMain"] with { Running = false };
        Assert.Equal("reverted", rig.Engine.Recover([new Captured("pauseServices", Items: ["SysMain"])]).Single().State);
    }

    // ---- F2: the request file ----
    [Fact]
    public void TheRequestIsFreshOnlyWhileItExistsAndIsRecent()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ff-req-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var result = Path.Combine(dir, $"frameforge-{Guid.NewGuid():N}.json");
            File.WriteAllText(result, "");
            Assert.False(ElevationRequest.Fresh(result));
            var now = DateTime.UtcNow;
            ElevationRequest.Create(result, TimeSpan.FromSeconds(120), now);
            Assert.True(ElevationRequest.Fresh(result, now.AddSeconds(30)));
            Assert.True(ElevationRequest.Fresh(result, now.AddSeconds(120)));
            Assert.False(ElevationRequest.Fresh(result, now.AddSeconds(121)));
            Assert.False(ElevationRequest.Fresh(result, now.AddMinutes(-1)));
            ElevationRequest.Withdraw(result);
            Assert.False(ElevationRequest.Fresh(result, now));
            File.WriteAllText(ElevationRequest.PathFor(result), "frameforge-request nonsense 120");
            Assert.False(ElevationRequest.Fresh(result));
            File.WriteAllText(ElevationRequest.PathFor(result), $"frameforge-request {now.Ticks} 99999");
            Assert.False(ElevationRequest.Fresh(result, now));
        }
        finally { Directory.Delete(dir, true); }
    }
    // The launcher blocks like a consent prompt; "approve" starts the child, which runs the real child entry point against fakes.
    private sealed class PromptLauncher(IServiceStore store) : IElevatedLauncher
    {
        public ManualResetEventSlim Opened { get; } = new(false);
        public ManualResetEventSlim Answer { get; } = new(false);
        public bool Decline { get; set; }
        public int ChildExit { get; private set; } = -1;
        public int StartCount { get; private set; }
        public sealed class Child(int exit) : IElevatedChild
        {
            public bool WaitForExit(TimeSpan timeout) => true;
            public int? ExitCode => exit;
            public void Dispose() { }
        }
        public IElevatedChild? Start(IReadOnlyList<string> arguments)
        {
            StartCount++;
            Opened.Set();
            Answer.Wait();
            if (Decline) throw new Win32Exception(1223);
            var args = arguments.ToArray();
            ChildExit = ServiceCommands.RunElevatedChild(args[1..], v => JsonSerializer.Serialize(v, HelperJson.Options), store, new Controllers(), new Purger());
            return new Child(ChildExit);
        }
    }
    private static string[] Stopped(Services s) => [.. s.Calls];
    [Fact]
    public async Task StoppingWhileThePromptIsOpenWithdrawsTheRequestSoALateApprovalChangesNothing()
    {
        var services = new Services();
        services.Add("DiagTrack");
        var launcher = new PromptLauncher(services);
        var elevator = new WindowsServiceElevator(TimeSpan.FromSeconds(5), launcher, TimeSpan.FromSeconds(30), TimeSpan.FromMilliseconds(100), elevated: false);
        using var cancel = new CancellationTokenSource();
        var run = Task.Run(() => elevator.Run("stop", ["DiagTrack"], cancel.Token));
        Assert.True(launcher.Opened.Wait(5000));
        cancel.Cancel();
        var batch = await run;
        Assert.True(batch.Declined);
        Assert.Equal("elevation-cancelled", batch.Code);
        Assert.Contains("stopped", batch.Error);
        // The user approves the lingering prompt afterwards: the child finds no request and exits without touching anything.
        launcher.Answer.Set();
        SpinWait.SpinUntil(() => launcher.ChildExit >= 0, 5000);
        Assert.InRange(launcher.ChildExit, 2, 3);
        Assert.Empty(services.Calls);
        Assert.True(services.Query("DiagTrack").Running);
    }
    [Fact]
    public void AnUnansweredPromptEndsWithAClearMessageAndNoChange()
    {
        var services = new Services();
        services.Add("DiagTrack");
        var launcher = new PromptLauncher(services);
        var elevator = new WindowsServiceElevator(TimeSpan.FromSeconds(5), launcher, TimeSpan.FromMilliseconds(150), TimeSpan.FromMilliseconds(100), elevated: false);
        var batch = elevator.Run("stop", ["DiagTrack"]);
        Assert.True(batch.Declined);
        Assert.Equal("elevation-timeout", batch.Code);
        Assert.Contains("not given", batch.Error);
        Assert.Contains("does nothing now", batch.Error);
        launcher.Answer.Set();
        SpinWait.SpinUntil(() => launcher.ChildExit >= 0, 5000);
        Assert.InRange(launcher.ChildExit, 2, 3);
        Assert.Empty(services.Calls);
    }
    [Fact]
    public void AnApprovedPromptRunsTheChildOnceAndReturnsItsResult()
    {
        var services = new Services();
        services.Add("DiagTrack"); services.Add("SysMain");
        var launcher = new PromptLauncher(services);
        launcher.Answer.Set();
        var elevator = new WindowsServiceElevator(TimeSpan.FromSeconds(5), launcher, TimeSpan.FromSeconds(30), elevated: false);
        var batch = elevator.Run("stop-purge", ["DiagTrack", "SysMain"]);
        Assert.False(batch.Declined);
        Assert.Equal(["stopped", "stopped"], batch.Outcomes.Select(o => o.State));
        Assert.Equal("purged", batch.Purge?.State);
        Assert.Equal(0, launcher.ChildExit);
        Assert.Equal(1, launcher.StartCount);
    }
    [Fact]
    public void ADeclinedPromptIsReportedAsDeclined()
    {
        var services = new Services();
        var launcher = new PromptLauncher(services) { Decline = true };
        launcher.Answer.Set();
        var batch = new WindowsServiceElevator(TimeSpan.FromSeconds(5), launcher, TimeSpan.FromSeconds(30), elevated: false).Run("start", ["DiagTrack"]);
        Assert.True(batch.Declined);
        Assert.Equal("elevation-cancelled", batch.Code);
        Assert.Contains("declined", batch.Error);
    }
    [Fact]
    public void TheChildRejectsAMissingOrOldRequestBeforeChangingAnything()
    {
        var services = new Services();
        services.Add("DiagTrack");
        var path = WindowsServiceElevator.NewResultPath();
        try
        {
            // No request file at all.
            Assert.Equal(3, ServiceCommands.RunElevatedChild(["stop", path, "DiagTrack"], v => JsonSerializer.Serialize(v), services, new Controllers(), new Purger()));
            // A request issued five minutes ago for two minutes.
            ElevationRequest.Create(path, TimeSpan.FromSeconds(120), DateTime.UtcNow.AddMinutes(-5));
            Assert.Equal(3, ServiceCommands.RunElevatedChild(["stop", path, "DiagTrack"], v => JsonSerializer.Serialize(v), services, new Controllers(), new Purger()));
            Assert.Empty(services.Calls);
            // A fresh one is honoured.
            ElevationRequest.Withdraw(path);
            ElevationRequest.Create(path, TimeSpan.FromSeconds(120));
            Assert.Equal(0, ServiceCommands.RunElevatedChild(["stop", path, "DiagTrack"], v => JsonSerializer.Serialize(v), services, new Controllers(), new Purger()));
            Assert.Equal(["stop DiagTrack"], services.Calls);
        }
        finally { ElevationRequest.Withdraw(path); File.Delete(path); }
    }
    [Fact]
    public void RestorePointElevationUsesTheSameGuard()
    {
        var path = WindowsServiceElevator.NewResultPath();
        try
        {
            Assert.Equal(3, RestoreCommands.RunElevatedChild(["restore-list", path], v => "{}"));
            ElevationRequest.Create(path, TimeSpan.FromSeconds(30), DateTime.UtcNow.AddMinutes(-2));
            Assert.Equal(3, RestoreCommands.RunElevatedChild(["restore-list", path], v => "{}"));
        }
        finally { ElevationRequest.Withdraw(path); File.Delete(path); }
    }

    // ---- F2: the session goes active while approval is pending, and Stop cancels it ----
    [Fact]
    public void TheSessionIsReadyWhileTheServicesPromptIsOpenAndStopCancelsIt()
    {
        var rig = Setup();
        rig.Services.Add("DiagTrack"); rig.Services.Add("SysMain");
        rig.Engine.Start(Command(Off() with { PauseServices = true }), deferElevated: true);
        // Start returned although the prompt has not been answered.
        Assert.True(rig.Elevator.Entered.Wait(5000));
        Assert.Contains(Of(rig, "pauseServices"), s => s.Event == "pending");
        Assert.DoesNotContain(Of(rig, "pauseServices"), s => s.Event is "applied" or "failed" or "skipped");
        var reverts = rig.Engine.Revert();
        Assert.True(rig.Elevator.Cancelled);
        var final = Of(rig, "pauseServices").Last(s => s.Event is not ("captured" or "released" or "pending"));
        Assert.Equal("skipped", final.Event);
        Assert.Contains("stopped before administrator approval", final.Detail);
        // The journal was released, nothing was stopped, and nothing needed a second prompt.
        Assert.Contains(Of(rig, "pauseServices"), s => s.Event == "released");
        Assert.Contains("Never applied", reverts.Single().Detail);
        Assert.Empty(rig.Services.Calls);
        Assert.Equal(["stop DiagTrack,SysMain"], rig.Elevator.Calls);
    }
    [Fact]
    public void ApprovingAfterTheSessionIsActiveAppliesAndTheEndRestartsTheServices()
    {
        var rig = Setup();
        rig.Services.Add("DiagTrack"); rig.Services.Add("SysMain");
        rig.Engine.Start(Command(Off() with { PauseServices = true }), deferElevated: true);
        rig.Elevator.Gate.Set();
        SpinWait.SpinUntil(() => Of(rig, "pauseServices").Any(s => s.Event == "applied"), 5000);
        Assert.False(rig.Services.Query("DiagTrack").Running);
        var reverts = rig.Engine.Revert();
        Assert.Equal("reverted", reverts.Single().State);
        Assert.True(rig.Services.Query("DiagTrack").Running);
        Assert.Equal(["stop DiagTrack,SysMain", "start SysMain,DiagTrack"], rig.Elevator.Calls);
    }
    [Fact]
    public void AnApprovalThatLandsDuringTheCancelStillGetsItsServicesRestarted()
    {
        var rig = Setup(s => new PromptElevator(s));
        rig.Services.Add("DiagTrack");
        // The child was already approved when Stop arrived: the step returns real outcomes after the cancel.
        rig.Elevator.Answer = new ServiceBatch(false, [new("DiagTrack", "stopped", "Stopped.")]);
        rig.Engine.Start(Command(Off() with { PauseServices = true }), deferElevated: true);
        Assert.True(rig.Elevator.Entered.Wait(5000));
        rig.Services.Items["DiagTrack"] = rig.Services.Items["DiagTrack"] with { Running = false };
        rig.Elevator.Gate.Set();
        var reverts = rig.Engine.Revert();
        Assert.Equal("reverted", reverts.Single().State);
        Assert.True(rig.Services.Query("DiagTrack").Running);
    }

    // ---- standby list purge ----
    [Fact]
    public void ThePurgeRunsOnceAfterTheStopsAndOnlyWhenAsked()
    {
        var services = new Services();
        services.Add("DiagTrack");
        var purger = new Purger();
        var batch = ServiceCommands.Execute("stop-purge", ["DiagTrack"], services, new Controllers(), purger, TimeSpan.Zero);
        Assert.Equal(1, purger.Calls);
        Assert.Equal("stopped", batch.Outcomes.Single().State);
        Assert.Equal("purged", batch.Purge?.State);
        var alone = ServiceCommands.Execute("purge", [], services, new Controllers(), purger, TimeSpan.Zero);
        Assert.Equal(2, purger.Calls);
        Assert.Empty(alone.Outcomes);
        // Plain stop and start never purge.
        Assert.Null(ServiceCommands.Execute("start", ["DiagTrack"], services, new Controllers(), purger, TimeSpan.Zero).Purge);
        Assert.Equal(2, purger.Calls);
        // A failing purge is reported, not hidden.
        var failed = ServiceCommands.Execute("purge", [], services, new Controllers(), new Purger("Windows refused (status 0xC0000061)."), TimeSpan.Zero);
        Assert.Equal(("failed", "purge-failed"), (failed.Purge!.State, failed.Purge.Code));
        Assert.Throws<InvalidOperationException>(() => ServiceCommands.Execute("purge", ["DiagTrack"], services, new Controllers(), purger));
        Assert.Throws<InvalidOperationException>(() => ServiceCommands.Execute("stop", [], services, new Controllers(), purger));
        Assert.Throws<InvalidOperationException>(() => ServiceCommands.Execute("stop-purge", ["RpcSs"], services, new Controllers(), purger));
    }
    [Fact]
    public void ThePurgeIsAnOptInStepWithItsOwnResultAndNeverRunsUnattended()
    {
        var rig = Setup();
        rig.Engine.Start(Command(Off() with { StandbyPurge = true }), deferElevated: true);
        Assert.True(rig.Elevator.Entered.Wait(5000));
        Assert.Contains(Of(rig, "standbyPurge"), s => s.Event == "pending");
        rig.Elevator.Gate.Set();
        SpinWait.SpinUntil(() => Of(rig, "standbyPurge").Any(s => s.Event == "applied"), 5000);
        Assert.Equal(["purge "], rig.Elevator.Calls);
        Assert.Contains("harmless", Of(rig, "standbyPurge").Last().Detail);
        // Nothing to revert: the purge captures nothing.
        Assert.Empty(rig.Engine.Revert());
        Assert.DoesNotContain(rig.Steps, s => s.Event == "captured");

        var auto = Setup();
        auto.Engine.Start(Command(Off() with { StandbyPurge = true }, unattended: true), deferElevated: true);
        Assert.Equal("skipped", Of(auto, "standbyPurge").Single().Event);
        Assert.Empty(auto.Elevator.Calls);

        // Services and the purge share one prompt.
        var both = Setup();
        both.Services.Add("DiagTrack");
        both.Engine.Start(Command(Off() with { PauseServices = true, StandbyPurge = true }), deferElevated: true);
        both.Elevator.Gate.Set();
        SpinWait.SpinUntil(() => Of(both, "standbyPurge").Any(s => s.Event == "applied"), 5000);
        Assert.Equal(["stop-purge DiagTrack"], both.Elevator.Calls);
    }
    [Fact]
    public void AFailedOrDeclinedPurgeIsReportedHonestly()
    {
        var failed = Setup(s => new PromptElevator(s) { Answer = new ServiceBatch(false, [], Purge: new("standby-list", "failed", "Windows refused to clear the standby list (status 0xC0000061).", "purge-failed")) });
        failed.Engine.Start(Command(Off() with { StandbyPurge = true }), deferElevated: true);
        failed.Elevator.Gate.Set();
        SpinWait.SpinUntil(() => Of(failed, "standbyPurge").Any(s => s.Event == "failed"), 5000);
        Assert.Equal("purge-failed", Of(failed, "standbyPurge").Last().Code);
        var declined = Setup(s => new PromptElevator(s) { Answer = new ServiceBatch(true, [], "Administrator approval was declined.", "elevation-cancelled") });
        declined.Engine.Start(Command(Off() with { StandbyPurge = true }), deferElevated: true);
        declined.Elevator.Gate.Set();
        SpinWait.SpinUntil(() => Of(declined, "standbyPurge").Any(s => s.Event == "skipped"), 5000);
        Assert.Contains("Nothing was cleared", Of(declined, "standbyPurge").Last().Detail);
    }
    [Fact]
    public void StandbyPurgeIsOfferedWhereAnAdministratorPromptExists()
    {
        var with = BoostSessionEngine.Capabilities(new Power(), new Timer(), 12, new MemoryStore(), null, new Extras(Elevator: new PromptElevator(new Services())));
        var purge = with.Mechanisms.Single(c => c.Id == "standbyPurge");
        Assert.True(purge.Available);
        Assert.Contains("harmless", purge.Detail);
        var without = BoostSessionEngine.Capabilities(new Power(), new Timer(), 12, new MemoryStore(), null, null);
        Assert.False(without.Mechanisms.Single(c => c.Id == "standbyPurge").Available);
    }

    // The Node side validates every field strictly: an optional member must be left out, never written as null.
    [Fact]
    public void CapabilitiesSerializeTheWayNodeParsesThem()
    {
        var caps = BoostSessionEngine.Capabilities(new Power(), new Timer(null, new(true, false)), 12, new MemoryStore(), null);
        var json = JsonSerializer.Serialize(caps, HelperJson.Options);
        Assert.DoesNotContain("\"code\":null", json);
        Assert.DoesNotContain("\"code\"", json);
        Assert.Contains("\"timerGlobal\":{\"eligible\":true,\"enabled\":false}", json);
        Assert.Equal("{\"id\":\"gameBarCapture\",\"available\":true,\"detail\":\"d\",\"active\":true,\"code\":\"policy\"}", JsonSerializer.Serialize(new Capability("gameBarCapture", true, "d", true, "policy"), HelperJson.Options));
        Assert.DoesNotContain("timerGlobal", JsonSerializer.Serialize(new BoostCapabilities(1, []), HelperJson.Options));
    }

    // ---- timer resolution on Windows 11 ----
    [Fact]
    public void TheTimerCapabilityExplainsWhatIsMissingAndWhatToDo()
    {
        var reason = BoostSessionEngine.TimerSupport(26300, null);
        Assert.Contains("GlobalTimerResolutionRequests", reason);
        Assert.Contains("restart", reason);
        Assert.Null(BoostSessionEngine.TimerSupport(26300, 1));
        Assert.Contains("only affects the requesting process", BoostSessionEngine.TimerSupport(19045, 1));
        var off = BoostSessionEngine.Capabilities(new Power(), new Timer(reason, new(true, false)), 12, new MemoryStore(), null).Mechanisms.Single(c => c.Id == "timerResolution");
        Assert.False(off.Available);
        // Turned on but not restarted yet: still unavailable, and the session does not pretend.
        var pending = BoostSessionEngine.Capabilities(new Power(), new Timer(null, new(true, true)), 12, new MemoryStore(), null, null, timerRestartPending: true);
        Assert.False(pending.Mechanisms.Single(c => c.Id == "timerResolution").Available);
        Assert.Equal(new TimerGlobal(true, true), pending.TimerGlobal);
        var ready = BoostSessionEngine.Capabilities(new Power(), new Timer(null, new(true, true)), 12, new MemoryStore(), null);
        Assert.True(ready.Mechanisms.Single(c => c.Id == "timerResolution").Available);
        var steps = new List<Step>();
        var engine = new BoostSessionEngine(new Processes(), new Power(), new Timer(), new MemoryStore(), steps.Add, 999);
        engine.Start(Command(Off() with { TimerResolution = true }, timerRestart: true));
        var result = steps.Last(s => s.Mechanism == "timerResolution");
        Assert.Equal("unsupported", result.Event);
        Assert.Contains("Restart Windows", result.Detail);
        Assert.DoesNotContain(steps, s => s.Event == "captured");
    }
    private sealed class KernelSetting(bool existed, int? value, bool wrongType = false) : IKernelTimerSetting
    {
        public bool Existed { get; private set; } = existed;
        public int? Value { get; private set; } = value;
        public List<string> Writes { get; } = [];
        public (bool Existed, int? Value, bool WrongType) Read() => (Existed, Value, wrongType);
        public void Write(int v) { Writes.Add($"write {v}"); Existed = true; Value = v; }
        public void Delete() { Writes.Add("delete"); Existed = false; Value = null; }
    }
    [Fact]
    public void EnablingSavesThePriorStateAndRestoreBringsItBackExactly()
    {
        // Absent before: enable writes 1, restore deletes it again.
        var absent = new KernelSetting(false, null);
        Assert.Equal("applied", TimerGlobalSetting.Apply("enable", false, null, 26300, absent).State);
        Assert.Equal((true, 1), (absent.Existed, absent.Value));
        Assert.Equal("reverted", TimerGlobalSetting.Apply("restore", false, null, 26300, absent).State);
        Assert.Equal(["write 1", "delete"], absent.Writes);
        // Present as 0 before: restore writes 0, never deletes.
        var zero = new KernelSetting(true, 0);
        Assert.Equal("applied", TimerGlobalSetting.Apply("enable", true, 0, 26300, zero).State);
        Assert.Equal("reverted", TimerGlobalSetting.Apply("restore", true, 0, 26300, zero).State);
        Assert.Equal((true, 0), (zero.Existed, zero.Value));
        Assert.Equal(["write 1", "write 0"], zero.Writes);
    }
    [Fact]
    public void TheTimerSettingIsNeverChangedWhenItIsAlreadyOnChangedMeanwhileOrOnWindows10()
    {
        var on = new KernelSetting(true, 1);
        Assert.Equal("already-set", TimerGlobalSetting.Apply("enable", true, 1, 26300, on).State);
        Assert.Empty(on.Writes);
        var moved = new KernelSetting(true, 0);
        Assert.Equal("conflict", TimerGlobalSetting.Apply("enable", false, null, 26300, moved).State);
        Assert.Empty(moved.Writes);
        // Restore keeps a value somebody else changed after Frameforge turned it on.
        var other = new KernelSetting(true, 5);
        Assert.Equal("conflict", TimerGlobalSetting.Apply("restore", false, null, 26300, other).State);
        Assert.Empty(other.Writes);
        var ten = new KernelSetting(false, null);
        Assert.Equal("failed", TimerGlobalSetting.Apply("enable", false, null, 19045, ten).State);
        Assert.Empty(ten.Writes);
        var odd = new KernelSetting(true, null, wrongType: true);
        Assert.Equal("failed", TimerGlobalSetting.Apply("enable", true, null, 26300, odd).State);
        Assert.Throws<InvalidOperationException>(() => TimerGlobalSetting.Apply("delete", false, null, 26300, ten));
        Assert.Equal("ready", TimerGlobalSetting.Read(new KernelSetting(false, null), 26300).State);
        Assert.Equal("failed", TimerGlobalSetting.Read(new KernelSetting(false, null), 19045).State);
    }
    private sealed class TimerLauncher(IKernelTimerSetting setting) : IElevatedLauncher
    {
        public ManualResetEventSlim Answer { get; } = new(false);
        public int ChildExit { get; private set; } = -1;
        public IElevatedChild? Start(IReadOnlyList<string> arguments)
        {
            Answer.Wait();
            var args = arguments.ToArray();
            Assert.Equal("--elevated-timer", args[0]);
            ChildExit = TimerGlobalSetting.RunElevatedChild(args[1..], v => JsonSerializer.Serialize(v, HelperJson.Options), setting);
            return new PromptLauncher.Child(ChildExit);
        }
    }
    [Fact]
    public void TheTimerChangeGoesThroughOneGuardedPromptAndLateApprovalDoesNothing()
    {
        var setting = new KernelSetting(false, null);
        var launcher = new TimerLauncher(setting);
        launcher.Answer.Set();
        var done = TimerGlobalSetting.Run(new("enable", false, null), 26300, setting, launcher, elevated: false);
        Assert.Equal("applied", done.State);
        Assert.Equal(1, setting.Value);
        // An unanswered prompt: nothing changes, even when it is approved later.
        var idle = new KernelSetting(false, null);
        var late = new TimerLauncher(idle);
        var timeout = TimerGlobalSetting.Run(new("enable", false, null), 26300, idle, late, elevated: false, approval: TimeSpan.FromMilliseconds(150), grace: TimeSpan.FromMilliseconds(100));
        Assert.Equal("timeout", timeout.State);
        Assert.Contains("2 minutes", timeout.Detail);
        late.Answer.Set();
        SpinWait.SpinUntil(() => late.ChildExit >= 0, 5000);
        Assert.InRange(late.ChildExit, 2, 3);
        Assert.Empty(idle.Writes);
        Assert.Equal("ready", TimerGlobalSetting.Run(new("read", false, null), 26300, idle).State);
        Assert.Throws<InvalidOperationException>(() => TimerGlobalSetting.Run(new("enable", true, null), 26300, idle, elevated: false));
    }
}
