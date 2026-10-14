using System.ComponentModel;
using System.Text.Json;
using Frameforge.Windows;
using Xunit;

public class MonitorTests
{
    private const string Luid = "0x00000000_0x0000f0f8";
    private static string Engine(int pid, int eng, string type, string luid = "0x00000000_0x0000F0F8") => $"pid_{pid}_luid_{luid}_phys_0_eng_{eng}_engtype_{type}";

    [Fact]
    public void EngineInstanceNamesAreParsedAndUnshownEnginesDropped()
    {
        var parsed = MonitorMath.ParseEngine(Engine(4120, 0, "3D"));
        Assert.Equal((4120, Luid, $"{Luid}/0/0/3D", "3D"), parsed);
        Assert.Equal("Video", MonitorMath.ParseEngine(Engine(7, 3, "VideoDecode"))!.Value.Category);
        Assert.Equal("Compute", MonitorMath.ParseEngine(Engine(7, 1, "Compute_0"))!.Value.Category);
        Assert.Equal("Copy", MonitorMath.ParseEngine(Engine(7, 2, "Copy"))!.Value.Category);
        Assert.Null(MonitorMath.ParseEngine(Engine(7, 9, "Security")));
        Assert.Null(MonitorMath.ParseEngine("garbage"));
        Assert.Null(MonitorMath.ParseEngine("pid_x_luid_0x1_0x2_phys_0_eng_0_engtype_3D"));
    }

    [Fact]
    public void GpuLoadSumsProcessesPerEngineThenShowsTheBusiestEngine()
    {
        var usage = MonitorMath.GpuUsage([
            (Engine(1, 0, "3D"), 30.0), (Engine(2, 0, "3D"), 25.5), // one engine, two programs: 55.5
            (Engine(3, 1, "3D"), 10.0),                              // another 3D engine: lower
            (Engine(1, 2, "Copy"), 4.0),
            (Engine(9, 0, "3D", "0x00000000_0x00000001"), 80.0)      // a second adapter stays separate
        ]);
        Assert.Equal(55.5, usage[Luid]["3D"]);
        Assert.Equal(4.0, usage[Luid]["Copy"]);
        Assert.Equal(0, usage[Luid]["Video"]);
        Assert.Equal(80.0, usage["0x00000000_0x00000001"]["3D"]);
    }

    [Fact]
    public void GpuLoadIsClampedAndCanBeLimitedToOneProcess()
    {
        var items = new (string, double)[] { (Engine(1, 0, "3D"), 70.0), (Engine(2, 0, "3D"), 70.0), (Engine(2, 5, "Compute_0"), 12.0) };
        Assert.Equal(100.0, MonitorMath.GpuUsage(items)[Luid]["3D"]);
        var game = MonitorMath.GpuUsage(items, 2);
        Assert.Equal(70.0, game[Luid]["3D"]);
        Assert.Equal(70.0, MonitorMath.GpuPercentOf(game));
        Assert.Equal(0, MonitorMath.GpuPercentOf(MonitorMath.GpuUsage(items, 999)));
    }

    [Fact]
    public void AdapterMemoryInstanceIsMatchedToTheSameAdapterKey() =>
        Assert.Equal(Luid, MonitorMath.ParseMemoryAdapter("luid_0x00000000_0x0000F0F8_phys_0"));

    [Fact]
    public void NvidiaSmiOutputIsParsedAndBadLinesSkipped()
    {
        var gpus = MonitorMath.ParseNvidiaSmi("NVIDIA GeForce RTX 4050 Laptop GPU, 59\r\nbroken line\r\nOther, GPU, 71\r\nNo reading, [N/A]\r\n");
        Assert.Equal([("NVIDIA GeForce RTX 4050 Laptop GPU", 59.0), ("Other, GPU", 71.0)], gpus);
        Assert.Empty(MonitorMath.ParseNvidiaSmi(""));
    }

    [Fact]
    public void AcpiTemperatureIsTenthsOfKelvinAndNonsenseIsDropped()
    {
        Assert.Equal(51.9, MonitorMath.AcpiCelsius([3000.0, 3250.5]));
        Assert.Null(MonitorMath.AcpiCelsius([2732.0])); // 0 C: a board that reports a fixed placeholder
        Assert.Null(MonitorMath.AcpiCelsius([]));
    }

    [Fact]
    public void PseudoNetworkAdaptersAreRecognised()
    {
        Assert.True(MonitorMath.PseudoAdapter("isatap.{ABC}"));
        Assert.True(MonitorMath.PseudoAdapter("Loopback Pseudo-Interface 1"));
        Assert.False(MonitorMath.PseudoAdapter("Realtek PCIe GbE Family Controller"));
    }

    [Fact]
    public void ProcessCpuIsAShareOfTheWholeMachineGroupedByName()
    {
        var tracker = new ProcessTracker();
        var second = 10_000_000L; // 100 ns ticks
        tracker.Update([(1, "game", 0, 100), (2, "chrome", 0, 50), (3, "chrome", 0, 70), (4, "idle", 0, 10)], second, 4);
        var (cpu, memory) = tracker.Update([
            (1, "game", 2 * second, 100), // two CPU seconds in one second on 4 cores: 50%
            (2, "chrome", second / 2, 50), (3, "chrome", second / 2, 70), // 0.5 + 0.5: 25%
            (4, "idle", 0, 10), (5, "new", 9 * second, 5)                 // a new process has no earlier read, so no CPU yet
        ], 2 * second, 4);
        Assert.Equal(("game", 50.0), (cpu[0].Name, cpu[0].CpuPercent));
        Assert.Equal(("chrome", 2, 25.0), (cpu[1].Name, cpu[1].Count, cpu[1].CpuPercent));
        Assert.Equal(0, cpu.Single(p => p.Name == "new").CpuPercent);
        Assert.Equal("chrome", memory[0].Name); // 50 + 70 beats 100
        Assert.Equal(100, memory[1].WorkingSetBytes);
    }

    [Fact]
    public void LiveCountersReadThisPc()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var pdh = new PdhQuery();
        var cpu = pdh.Add(@"\Processor(*)\% Processor Time");
        Assert.NotNull(cpu);
        Assert.False(pdh.Add(@"\No Such Category(*)\Nothing").HasValue);
        pdh.Collect(); Thread.Sleep(250); pdh.Collect();
        var values = PdhQuery.Read(cpu!.Value);
        Assert.Contains(values, v => v.Name == "_Total" && v.Value is >= 0 and <= 100.5);
        Assert.True(values.Count(v => v.Name != "_Total") >= 1);
    }

    [Fact]
    public void HostSamplesUntilStopAndReportsReadyFirst()
    {
        var lines = new List<object>();
        var input = new BlockingReader();
        var run = Task.Run(() => MonitorHost.Run(input, lines.Add, () => new { @event = "sample" }, 20));
        Thread.Sleep(150);
        input.Send("{\"command\":\"stop\"}");
        Assert.True(run.Wait(2000));
        Assert.Equal("ready", JsonSerializer.SerializeToElement(lines[0]).GetProperty("event").GetString());
        Assert.True(lines.Count >= 3);
    }
}

// A stdin that stays open until the test closes it.
internal sealed class BlockingReader : TextReader
{
    private readonly System.Collections.Concurrent.BlockingCollection<string?> lines = [];
    public void Send(string? line) => lines.Add(line);
    public override string? ReadLine() => lines.Take();
}

public class FpsTests
{
    // Frames at fixed spacing, as ETW would deliver them (timestamps in ms).
    private static void Frames(PresentTracker tracker, int pid, string source, ulong chain, double start, double step, int count)
    {
        for (var i = 0; i < count; i++) tracker.OnPresent(pid, source, chain, start + i * step);
    }

    [Fact]
    public void PresentTimestampsBecomeFrameTimes()
    {
        var tracker = new PresentTracker(100);
        Frames(tracker, 100, "dxgi", 0xABC, 1000, 16.667, 5);
        var frames = tracker.Drain();
        Assert.Equal(4, frames.Length); // the first present only starts the clock
        Assert.All(frames, f => Assert.Equal(16.667, f, 3));
        Assert.Empty(tracker.Drain());
    }

    [Fact]
    public void OtherProcessesAreIgnored()
    {
        var tracker = new PresentTracker(100);
        Frames(tracker, 200, "dxgi", 1, 0, 10, 50);
        Assert.Empty(tracker.Drain());
    }

    [Fact]
    public void AnOverlaysSmallSwapChainDoesNotMixIntoTheGame()
    {
        var tracker = new PresentTracker(100);
        Frames(tracker, 100, "dxgi", 1, 0, 8.333, 120); // the game, 120 fps
        Frames(tracker, 100, "dxgi", 2, 0, 500, 2);     // an overlay presenting twice a second
        var frames = tracker.Drain();
        Assert.Equal(119, frames.Length);
        Assert.All(frames, f => Assert.Equal(8.333, f, 3));
    }

    [Fact]
    public void TheFirstPresentPathSeenIsTheOnlyOneCounted()
    {
        var tracker = new PresentTracker(100);
        tracker.OnPresent(100, "d3d9", 1, 0);
        tracker.OnPresent(100, "dxgi", 9, 5);
        tracker.OnPresent(100, "d3d9", 1, 16);
        tracker.OnPresent(100, "dxgi", 9, 21);
        Assert.Equal([16.0], tracker.Drain());
    }

    [Fact]
    public void StallsAndOutOfOrderEventsAreNotFrames()
    {
        var tracker = new PresentTracker(100);
        tracker.OnPresent(100, "dxgi", 1, 0);
        tracker.OnPresent(100, "dxgi", 1, 16);
        tracker.OnPresent(100, "dxgi", 1, 6016); // a 6 s loading screen
        tracker.OnPresent(100, "dxgi", 1, 6000); // arrived late
        tracker.OnPresent(100, "dxgi", 1, 6033);
        Assert.Equal([16.0, 17.0], tracker.Drain());
    }

    private sealed class FakeSource(Action<Action<int, string, ulong, double>> feed, bool deny = false) : IPresentSource
    {
        public void Start(Action<int, string, ulong, double> onPresent) { if (deny) throw new UnauthorizedAccessException(); feed(onPresent); }
        public void Dispose() { }
    }

    [Fact]
    public void LoopReportsReadyThenFramesThenTheStopReason()
    {
        var events = new List<JsonElement>();
        var drains = 0;
        var source = new FakeSource(on => { for (var i = 0; i < 4; i++) on(7, "dxgi", 1, 100 + i * 10.0); });
        var reason = FpsLoop.Run(source, 7, e => events.Add(JsonSerializer.SerializeToElement(e)), () => ++drains > 2 ? "game-exited" : null, 5);
        Assert.Equal("game-exited", reason);
        Assert.Equal(["ready", "frames", "frames", "ended"], events.Select(e => e.GetProperty("event").GetString()));
        Assert.Equal([10.0, 10.0, 10.0], events[1].GetProperty("frameTimesMs").EnumerateArray().Select(v => v.GetDouble()));
    }

    [Fact]
    public void LoopSaysWhenWindowsRefusesTheTraceSession()
    {
        var events = new List<JsonElement>();
        FpsLoop.Run(new FakeSource(_ => { }, deny: true), 7, e => events.Add(JsonSerializer.SerializeToElement(e)), () => "stop", 5);
        Assert.Equal("unavailable", events.Single().GetProperty("event").GetString());
        Assert.Equal("etw-denied", events.Single().GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("capture", "x", "100", "2026-10-14T10:00:00.0000000Z", "50")]
    [InlineData("capture", "x", "-1", "2026-10-14T10:00:00.0000000Z", "50")]
    [InlineData("capture", "x", "100", "not a time", "50")]
    [InlineData("capture", "x", "100", "2026-10-14T10:00:00.0000000Z", "0")]
    [InlineData("rm", "x", "100", "2026-10-14T10:00:00.0000000Z", "50")]
    public void TheElevatedChildRefusesBadArguments(string a, string b, string c, string d, string e)
    {
        Assert.Equal(2, FpsChild.RunElevated([a, b, c, d, e]));
        Assert.Equal(2, FpsChild.RunElevated(["capture"]));
    }

    [Fact]
    public void TheElevatedChildTracesNothingWithoutAFreshRequest()
    {
        var path = WindowsServiceElevator.NewResultPath();
        try
        {
            var traced = false;
            // The result file exists and is empty, but no request file was written: the child must exit before starting a session.
            var code = FpsChild.RunElevated(["capture", path, "100", "2026-10-14T10:00:00.0000000Z", "50"], () => { traced = true; return new FakeSource(_ => { }); });
            Assert.Equal(ElevationRequest.NotFreshExitCode, code);
            Assert.False(traced);
        }
        finally { File.Delete(path); }
    }

    // ---- the unelevated side, with a fake administrator prompt ----
    private sealed class Child(Func<bool> exited, int code = 0) : IElevatedChild
    {
        public bool WaitForExit(TimeSpan timeout) => exited();
        public int? ExitCode => code;
        public void Dispose() { }
    }
    private sealed class Launcher(Func<IReadOnlyList<string>, IElevatedChild?> start) : IElevatedLauncher
    {
        public List<string> Arguments = [];
        public IElevatedChild? Start(IReadOnlyList<string> arguments) { Arguments = [.. arguments]; return start(arguments); }
    }
    private static readonly FpsStart Game = new("start", 100, "2026-10-14T10:00:00.0000000Z", 50);
    private static List<JsonElement> RunHost(Launcher launcher, Func<FpsStart, (string, string)?>? check = null, Func<object>? usage = null, TimeSpan? ready = null)
    {
        var events = new List<JsonElement>();
        var input = new BlockingReader();
        try { FpsHost.Run(input, e => { lock (events) events.Add(JsonSerializer.SerializeToElement(e)); }, launcher, Game, check ?? (_ => null), usage, TimeSpan.FromSeconds(5), ready ?? TimeSpan.FromSeconds(5), 10); }
        finally { input.Send(null); }
        return events;
    }
    private static string[] Names(List<JsonElement> events) => [.. events.Select(e => e.GetProperty("event").GetString()!)];

    [Fact]
    public void ADeclinedPromptIsReportedAndNothingElseHappens()
    {
        var launcher = new Launcher(_ => throw new Win32Exception(1223));
        var events = RunHost(launcher);
        Assert.Equal(["approval", "unavailable"], Names(events));
        Assert.Equal("declined", events[1].GetProperty("code").GetString());
    }

    [Fact]
    public void AProtectedGameNeverOpensAPrompt()
    {
        var launcher = new Launcher(_ => throw new InvalidOperationException("must not start"));
        var events = RunHost(launcher, _ => ("protected", "anti-cheat"));
        Assert.Equal(["unavailable"], Names(events));
        Assert.Equal("protected", events[0].GetProperty("code").GetString());
        Assert.Empty(launcher.Arguments);
    }

    [Fact]
    public void FramesFromTheChildAreForwardedAndUnknownLinesDropped()
    {
        var launcher = new Launcher(args =>
        {
            File.AppendAllText(args[2], "{\"event\":\"ready\"}\n{\"event\":\"evil\",\"x\":1}\nnot json\n{\"event\":\"frames\",\"frameTimesMs\":[16.6,16.7]}\n{\"event\":\"ended\",\"reason\":\"game-exited\"}\n");
            return new Child(() => true);
        });
        var events = RunHost(launcher, usage: () => new { @event = "usage", cpuPercent = 5.0, workingSetBytes = 1L, gpuPercent = (double?)null });
        Assert.Equal(["approval", "ready", "frames", "ended"], Names(events));
        Assert.Equal(2, events[2].GetProperty("frameTimesMs").GetArrayLength());
        // The child is started with the elevated flag, the capture action, the game and Frameforge's own pid, and its own request file beside the result file.
        Assert.Equal(["--elevated-fps", "capture"], launcher.Arguments.Take(2));
        Assert.Equal(["100", "2026-10-14T10:00:00.0000000Z", "50"], launcher.Arguments.Skip(3));
    }

    [Fact]
    public void AnExpiredRequestIsReportedWhenTheChildExitsWithoutStarting()
    {
        var launcher = new Launcher(_ => new Child(() => true, ElevationRequest.NotFreshExitCode));
        var events = RunHost(launcher);
        Assert.Equal(["approval", "unavailable"], Names(events));
        Assert.Equal("expired", events[1].GetProperty("code").GetString());
    }

    [Fact]
    public void AChildThatNeverStartsMeasuringIsStopped()
    {
        var launcher = new Launcher(_ => new Child(() => false));
        var events = RunHost(launcher, ready: TimeSpan.FromMilliseconds(100));
        Assert.Equal("helper-timeout", events.Last().GetProperty("code").GetString());
    }
}
