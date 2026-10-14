using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Frameforge.Windows;

// `--watch`: a cheap, long-lived game detector for auto-boost. stdin: one JSON GameRef[] per line (the library; a new line replaces it).
// stdout: {"event":"running","runningGames":[...]} whenever the set of running library games changes. Exits when stdin closes.
// Each tick only compares process image names with the library's exe names; the full path check (RunningGames) runs only on a name hit,
// and for games matched by folder (no exe name to compare) every FolderEvery ticks. Nothing is opened or changed.
public static class GameWatcher
{
    public const int TickMs = 3000, FolderEvery = 5;

    public static void Host(Stream input, TextWriter output, Func<GameRef[], RunningGame[]> scan, Func<HashSet<string>, string> hits, Func<int, Task> delay)
    {
        GameRef[] games = [];
        var changed = false;
        var reader = new StreamReader(input, new UTF8Encoding(false));
        var gate = new object();
        var open = true;
        using var first = new ManualResetEventSlim();
        var thread = new Thread(() =>
        {
            try
            {
                while (reader.ReadLine() is { } line)
                {
                    if (line.Length > 1048576) continue;
                    try
                    {
                        var next = JsonSerializer.Deserialize<GameRef[]>(line, HelperJson.Options) ?? [];
                        lock (gate) { games = next; changed = true; }
                        first.Set();
                    }
                    catch (JsonException) { }
                }
            }
            finally { lock (gate) open = false; first.Set(); }
        }) { IsBackground = true };
        thread.Start();
        // The library is the first line Frameforge sends; do not tick against an empty one.
        first.Wait(2000);
        string last = "[]", lastHits = "?";
        for (var tick = 0; ; tick++)
        {
            GameRef[] current; bool fresh;
            lock (gate) { if (!open) return; current = games; fresh = changed; changed = false; }
            if (fresh) { last = "[]"; lastHits = "?"; tick = 0; }
            RunningGame[]? found = null; var scanned = false;
            try
            {
                var wanted = current.Where(g => g.ExecutablePath is not null).Select(g => Path.GetFileNameWithoutExtension(g.ExecutablePath!)).ToHashSet(StringComparer.OrdinalIgnoreCase);
                var folder = current.Any(g => g.ExecutablePath is null);
                var now = wanted.Count > 0 ? hits(wanted) : "";
                // A full scan (every process opened) only when the set of matching pids changed, or on a folder tick.
                if (now != lastHits || (folder && tick % FolderEvery == 0))
                {
                    lastHits = now;
                    // No exe name is running and nothing is matched by folder: nothing can be running.
                    found = now == "" && !folder ? [] : scan(current);
                    scanned = true;
                }
            }
            catch (Exception error) when (error is InvalidOperationException or IOException or UnauthorizedAccessException) { }
            if (found is not null)
            {
                var json = JsonSerializer.Serialize(found, HelperJson.Options);
                if (json != last)
                {
                    last = json;
                    output.WriteLine(JsonSerializer.Serialize(new { @event = "running", runningGames = found }, HelperJson.Options));
                    output.Flush();
                }
            }
            // Trimming re-faults the whole working set on the next tick, so it is rare: after a full scan and once in a while.
            if (scanned || tick % 20 == 0) Trim();
            delay(TickMs).Wait();
        }
    }

    // The pids (sorted, comma-joined) of every process whose image name is one of `names`; "" when none.
    public static string MatchingPids(HashSet<string> names)
    {
        var all = Process.GetProcesses();
        try { return string.Join(',', all.Where(p => names.Contains(p.ProcessName)).Select(p => p.Id).Order()); }
        finally { foreach (var p in all) p.Dispose(); }
    }
    // An idle watcher should hold only a few MB: collect and give the working set back to Windows after every tick.
    private static void Trim()
    {
        GC.Collect(2, GCCollectionMode.Forced, true, true);
        EmptyWorkingSet(Process.GetCurrentProcess().Handle);
    }

    [DllImport("psapi.dll")]
    private static extern bool EmptyWorkingSet(IntPtr process);
}
