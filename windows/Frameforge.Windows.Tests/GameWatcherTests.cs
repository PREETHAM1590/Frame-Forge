using System.IO.Pipes;
using System.Text.Json;
using Frameforge.Windows;
using Xunit;

public class GameWatcherTests
{
    [Fact]
    public void ScansOnlyWhenTheMatchingProcessesChangeAndReportsStartAndExit()
    {
        using var server = new AnonymousPipeServerStream(PipeDirection.Out);
        using var client = new AnonymousPipeClientStream(PipeDirection.In, server.ClientSafePipeHandle);
        var id = Guid.NewGuid().ToString();
        var writer = new StreamWriter(server) { AutoFlush = true };
        writer.WriteLine(JsonSerializer.Serialize(new[] { new GameRef(id, @"C:\Games\T", @"C:\Games\T\game.exe") }, HelperJson.Options));
        // Pids matching "game" at each tick: nothing, nothing, started, still running, still running, gone.
        var seen = new Queue<string>(["", "", "42", "42", "42", ""]);
        var scans = 0;
        var target = new ProcessTarget(42, "2026-10-14T10:00:00.0000000Z", @"C:\Games\T\game.exe", "game", "Normal");
        var output = new StringWriter();
        var ticks = 0;
        GameWatcher.Host(client, output,
            _ => { scans++; return [new RunningGame(id, target)]; },
            names => { Assert.Contains("game", names); return seen.Dequeue(); },
            _ => { if (++ticks == 6) writer.Dispose(); return Task.CompletedTask; });
        var lines = output.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(1, scans);
        Assert.Equal(2, lines.Length);
        Assert.Contains(id, lines[0]);
        Assert.Contains("\"runningGames\":[]", lines[1]);
    }
}
