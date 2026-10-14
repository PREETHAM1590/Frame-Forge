using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Session;

namespace Frameforge.Windows;

// Turns "this program presented a frame" events into frame times. Pure, so recorded or fake events can be replayed in tests.
// Rules: only one process; one present path (DXGI or D3D9) per run, the first one seen; one swap chain, the one with the most frames
// (overlays and launchers present small extra swap chains from inside a game); a gap over 5 s (loading, alt-tab) is not a frame.
public sealed class PresentTracker(int pid)
{
    public const double StallMs = 5000;
    private readonly object gate = new();
    private readonly Dictionary<(string Source, ulong Chain), (double Last, long Total, List<double> Pending)> chains = [];
    private string? source;
    public void OnPresent(int processId, string present, ulong chain, double timestampMs)
    {
        if (processId != pid) return;
        lock (gate)
        {
            source ??= present;
            if (present != source) return;
            var key = (present, chain);
            if (!chains.TryGetValue(key, out var state)) { chains[key] = (timestampMs, 0, []); return; }
            var delta = timestampMs - state.Last;
            // Events from several threads can arrive slightly out of order; a non-positive step is not a frame.
            if (delta <= 0) return;
            state.Last = timestampMs;
            if (delta <= StallMs) { state.Total++; state.Pending.Add(Math.Round(delta, 3)); }
            chains[key] = state;
        }
    }
    // Frame times (ms) since the last call, from the swap chain that has the most frames so far.
    public double[] Drain(int max = 2000)
    {
        lock (gate)
        {
            if (chains.Count == 0) return [];
            var main = chains.OrderByDescending(c => c.Value.Total).First().Key;
            var frames = chains[main].Pending.TakeLast(max).ToArray();
            foreach (var state in chains.Values) state.Pending.Clear();
            return frames;
        }
    }
}

public interface IPresentSource : IDisposable
{
    // onPresent(processId, present path, swap chain, timestamp in ms). Throws UnauthorizedAccessException when Windows refuses a trace session.
    void Start(Action<int, string, ulong, double> onPresent);
}

// A real-time ETW session on the DirectX present events of Microsoft-Windows-DXGI (event 42, Present_Start) and Microsoft-Windows-D3D9 (event 1).
// Needs administrator rights or membership in "Performance Log Users", so it only ever runs inside the consented elevated child.
public sealed class EtwPresentSource : IPresentSource
{
    private static readonly Guid Dxgi = new("CA11C036-0102-4A2D-A6AD-F03CFED5D3C9"), D3D9 = new("783ACA0A-790E-4D7F-8451-AA850511C6B9");
    private const string Prefix = "Frameforge-Fps-";
    private TraceEventSession? session;
    private Thread? pump;
    public void Start(Action<int, string, ulong, double> onPresent)
    {
        // A session whose consumer was killed outlives it; remove ours from earlier runs.
        foreach (var name in TraceEventSession.GetActiveSessionNames().Where(n => n.StartsWith(Prefix, StringComparison.Ordinal)))
        {
            try { using var old = new TraceEventSession(name, TraceEventSessionOptions.Attach); old.Stop(); }
            catch (Exception error) when (error is InvalidOperationException or UnauthorizedAccessException or System.Runtime.InteropServices.COMException) { }
        }
        session = new TraceEventSession(Prefix + Guid.NewGuid().ToString("N")) { StopOnDispose = true };
        session.EnableProvider(Dxgi, TraceEventLevel.Informational, ulong.MaxValue);
        session.EnableProvider(D3D9, TraceEventLevel.Informational, ulong.MaxValue);
        session.Source.AllEvents += e =>
        {
            var id = (int)e.ID;
            var present = e.ProviderGuid == Dxgi && id == 42 ? "dxgi" : e.ProviderGuid == D3D9 && id == 1 ? "d3d9" : null;
            if (present is null) return;
            // The payload starts with the swap chain pointer.
            var data = e.EventData();
            ulong chain = data.Length >= 8 && e.PointerSize == 8 ? BitConverter.ToUInt64(data, 0) : data.Length >= 4 ? BitConverter.ToUInt32(data, 0) : 0;
            onPresent(e.ProcessID, present, chain, e.TimeStampRelativeMSec);
        };
        pump = new Thread(() => { try { session.Source.Process(); } catch (Exception error) when (error is InvalidOperationException or ObjectDisposedException) { } }) { IsBackground = true };
        pump.Start();
    }
    public void Dispose()
    {
        session?.Dispose();
        pump?.Join(TimeSpan.FromSeconds(3));
    }
}

public static class FpsLoop
{
    // Reports the frames of one process once per interval until stopReason returns a reason. The first line says "ready" only after the trace is running.
    public static string Run(IPresentSource source, int pid, Action<object> write, Func<string?> stopReason, int intervalMs = 1000)
    {
        var tracker = new PresentTracker(pid);
        try { source.Start(tracker.OnPresent); }
        catch (Exception error) when (error is UnauthorizedAccessException or InvalidOperationException or System.Runtime.InteropServices.COMException or IOException)
        {
            write(new { @event = "unavailable", code = "etw-denied", detail = "Windows did not allow a graphics trace session. FPS capture needs administrator approval or membership in the Performance Log Users group." });
            return "unavailable";
        }
        write(new { @event = "ready" });
        string? reason;
        while ((reason = stopReason()) is null)
        {
            Thread.Sleep(intervalMs);
            var frames = tracker.Drain();
            write(new { @event = "frames", frameTimesMs = frames });
        }
        write(new { @event = "ended", reason });
        return reason;
    }
}

public static class FpsChild
{
    public static readonly TimeSpan HardLimit = TimeSpan.FromHours(6);
    public static string StopFile(string resultPath) => Path.ChangeExtension(resultPath, ".stop");

    // argv: capture, result file, game pid, game start time, parent pid. Runs elevated; nothing is traced unless the request file is still fresh.
    public static int RunElevated(string[] argv, Func<IPresentSource>? sourceFactory = null)
    {
        if (argv.Length != 5 || argv[0] != "capture" || !int.TryParse(argv[2], NumberStyles.None, CultureInfo.InvariantCulture, out var game) || game <= 0 ||
            !int.TryParse(argv[4], NumberStyles.None, CultureInfo.InvariantCulture, out var parent) || parent <= 0 ||
            !DateTime.TryParseExact(argv[3], "O", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var started) || started.Kind != DateTimeKind.Utc) return 2;
        using var file = ElevatedCall.OpenResult(argv[1], out var rejected, FileShare.Read);
        if (file is null) return rejected;
        var stopFile = StopFile(argv[1]);
        var begun = Stopwatch.StartNew();
        void Write(object value)
        {
            file.Write(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value, value.GetType(), HelperJson.Options) + "\n"));
            file.Flush();
        }
        using var source = (sourceFactory ?? (() => new EtwPresentSource()))();
        FpsLoop.Run(source, game, Write, () =>
            File.Exists(stopFile) ? "stop" :
            Exited(game, started) ? "game-exited" :
            Exited(parent, null) ? "parent-exited" :
            begun.Elapsed > HardLimit ? "limit" : null);
        return 0;
    }
    private static bool Exited(int pid, DateTime? startedUtc)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            if (process.HasExited) return true;
            // A reused pid is a different program.
            return startedUtc is { } expected && Math.Abs((process.StartTime.ToUniversalTime() - expected).TotalSeconds) > 2;
        }
        catch (ArgumentException) { return true; }
        catch (Exception error) when (error is InvalidOperationException or Win32Exception) { return false; }
    }
}

public sealed record FpsStart(string Command, int GamePid = 0, string? GameStartTime = null, int ParentPid = 0);

public static class FpsHost
{
    public static readonly TimeSpan ApprovalBudget = TimeSpan.FromSeconds(120);
    private static readonly HashSet<string> Forwarded = ["ready", "frames", "unavailable", "ended"];

    // The unelevated side: asks for one consent prompt (through the shared freshness guard), then forwards the child's frame lines to Frameforge
    // and adds the game's own CPU, memory and GPU use. "stop" (or a closed pipe) asks the child to stop through a file it polls.
    public static void Run(TextReader input, Action<object> write, IElevatedLauncher launcher, FpsStart start, Func<FpsStart, (string Code, string Detail)?> checkGame,
        Func<object>? usage, TimeSpan? approvalBudget = null, TimeSpan? readyWait = null, int pollMs = 200, string? directory = null)
    {
        var refused = checkGame(start);
        if (refused is { } r) { write(new { @event = "unavailable", code = r.Code, detail = r.Detail }); return; }
        using var stop = new CancellationTokenSource();
        Task.Run(() =>
        {
            try { while (input.ReadLine() is { } line) if (line.Contains("\"stop\"", StringComparison.Ordinal)) break; }
            catch (IOException) { }
            try { stop.Cancel(); } catch (ObjectDisposedException) { }
        });
        var budget = approvalBudget ?? ApprovalBudget;
        var resultPath = WindowsServiceElevator.NewResultPath(directory);
        var stopFile = FpsChild.StopFile(resultPath);
        ElevationRequest.Create(resultPath, budget + TimeSpan.FromSeconds(10));
        try
        {
            write(new { @event = "approval" });
            var launch = Task.Run(() => launcher.Start(["--elevated-fps", "capture", resultPath, start.GamePid.ToString(CultureInfo.InvariantCulture), start.GameStartTime!, start.ParentPid.ToString(CultureInfo.InvariantCulture)]));
            var abandoned = (string?)null;
            try { if (!launch.Wait(budget, stop.Token)) abandoned = "not-approved"; }
            catch (OperationCanceledException) { abandoned = "cancelled"; }
            catch (AggregateException) { /* Failed or declined; handled below. */ }
            if (abandoned is not null)
            {
                ElevationRequest.Withdraw(resultPath);
                // The prompt may have been answered this very moment; a child that already started has passed its check or will exit without tracing.
                if (!launch.Wait(TimeSpan.FromSeconds(3))) { write(new { @event = "unavailable", code = abandoned, detail = abandoned == "cancelled" ? "FPS capture was cancelled before it was approved. Nothing was changed." : "Administrator approval was not given in time. FPS capture did not start and nothing was changed." }); return; }
            }
            IElevatedChild? child;
            try { child = launch.GetAwaiter().GetResult(); }
            catch (Win32Exception error) when (error.NativeErrorCode == 1223) { write(new { @event = "unavailable", code = "declined", detail = "Administrator approval was declined. FPS capture reads Windows' graphics present events, which needs it. Nothing was changed." }); return; }
            catch (Win32Exception) { write(new { @event = "unavailable", code = "no-child", detail = "The administrator request could not start." }); return; }
            if (child is null) { write(new { @event = "unavailable", code = "no-child", detail = "The administrator request could not start." }); return; }
            using (child) Tail(child, resultPath, stopFile, stop.Token, write, usage, readyWait ?? TimeSpan.FromSeconds(20), pollMs);
        }
        finally
        {
            ElevationRequest.Withdraw(resultPath);
            RestoreCommands.TryDelete(stopFile);
            RestoreCommands.TryDelete(resultPath);
        }
    }

    private static void Tail(IElevatedChild child, string resultPath, string stopFile, CancellationToken stop, Action<object> write, Func<object>? usage, TimeSpan readyWait, int pollMs)
    {
        using var file = new FileStream(resultPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var pending = new StringBuilder();
        var buffer = new byte[16384];
        var decoder = Encoding.UTF8.GetDecoder();
        bool ready = false, ended = false, stopping = false;
        var clock = Stopwatch.StartNew();
        TimeSpan stoppedAt = TimeSpan.Zero, lastUsage = TimeSpan.Zero;
        void Drain()
        {
            int read;
            while ((read = file.Read(buffer, 0, buffer.Length)) > 0)
            {
                var chars = new char[decoder.GetCharCount(buffer, 0, read)];
                pending.Append(chars, 0, decoder.GetChars(buffer, 0, read, chars, 0));
                if (pending.Length > 1_000_000) { pending.Clear(); return; }
            }
            while (true)
            {
                var all = pending.ToString();
                var cut = all.IndexOf('\n');
                if (cut < 0) break;
                var line = all[..cut].Trim();
                pending.Remove(0, cut + 1);
                if (line.Length is 0 or > 65536) continue;
                try
                {
                    using var document = JsonDocument.Parse(line);
                    if (document.RootElement.ValueKind != JsonValueKind.Object || !document.RootElement.TryGetProperty("event", out var name) || name.GetString() is not { } kind || !Forwarded.Contains(kind)) continue;
                    if (kind == "ready") ready = true;
                    if (kind == "ended") ended = true;
                    write(document.RootElement.Clone());
                }
                catch (JsonException) { /* A damaged line is dropped. */ }
            }
        }
        while (true)
        {
            Drain();
            if (ended) return;
            if (child.WaitForExit(TimeSpan.Zero))
            {
                Drain();
                if (!ended)
                {
                    var code = child.ExitCode;
                    if (!ready) write(new { @event = "unavailable", code = code == ElevationRequest.NotFreshExitCode ? "expired" : code == 2 ? "rejected" : "helper-exited", detail = code == ElevationRequest.NotFreshExitCode ? "The administrator request expired before it was approved. Nothing was changed." : "The capture helper stopped before it started measuring." });
                    else write(new { @event = "ended", reason = stopping ? "stop" : "helper-exited" });
                }
                return;
            }
            if (!ready && clock.Elapsed > readyWait)
            {
                File.WriteAllBytes(stopFile, []);
                write(new { @event = "unavailable", code = "helper-timeout", detail = "The capture helper did not start measuring in time." });
                return;
            }
            if (stop.IsCancellationRequested && !stopping)
            {
                stopping = true;
                stoppedAt = clock.Elapsed;
                try { File.WriteAllBytes(stopFile, []); } catch (IOException) { }
            }
            // The child stops within a second of the stop file; after 6 s Frameforge reports the end anyway (the child also leaves when its parent does).
            if (stopping && clock.Elapsed - stoppedAt > TimeSpan.FromSeconds(6)) { write(new { @event = "ended", reason = "stop" }); return; }
            if (usage is not null && ready && !stopping && clock.Elapsed - lastUsage >= TimeSpan.FromSeconds(1)) { lastUsage = clock.Elapsed; write(usage()); }
            Thread.Sleep(pollMs);
        }
    }

    public static void Host()
    {
        var gate = new object();
        void Write(object value) { lock (gate) { try { Console.Out.WriteLine(JsonSerializer.Serialize(value, value.GetType(), HelperJson.Options)); Console.Out.Flush(); } catch (IOException) { } } }
        var line = Console.ReadLine();
        if (line is null || line.Length > 65536) return;
        FpsStart? start;
        try { start = JsonSerializer.Deserialize<FpsStart>(line, HelperJson.Options); } catch (JsonException) { return; }
        if (start is not { Command: "start", GamePid: > 0, ParentPid: > 0, GameStartTime: { } }) return;
        using var sampler = TryUsage(start.GamePid);
        Run(Console.In, Write, new WindowsElevatedLauncher(), start, Check, sampler is null ? null : sampler.Sample);
    }
    private static GameUsageSampler? TryUsage(int pid) { try { return new GameUsageSampler(pid); } catch (InvalidOperationException) { return null; } }

    // Fails closed: a game Windows will not let Frameforge inspect is protected (often anti-cheat), and its identity cannot be confirmed.
    public static (string Code, string Detail)? Check(FpsStart start)
    {
        try
        {
            using var handle = WindowsProcesses.Open(start.GamePid, WindowsProcesses.QueryLimited);
            var current = handle is null ? null : WindowsProcesses.Read(handle, start.GamePid);
            return current is not null && current.StartTime == start.GameStartTime ? null : ("not-running", "The game is not running. FPS capture did not start.");
        }
        catch (Win32Exception) { return ("protected", "Windows will not let Frameforge inspect this game, which usually means anti-cheat protection. FPS capture was not started."); }
    }
}
