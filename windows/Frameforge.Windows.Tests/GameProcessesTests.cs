using System.ComponentModel;
using Frameforge.Windows;
using Xunit;

public class GameProcessesTests
{
    private static readonly ProcessTarget Game = new(321, "2026-10-12T10:00:00.0000000Z", @"C:\Games\Test\game.exe", "game", "Normal");
    private sealed class MemoryProcesses : IProcessStore
    {
        public Dictionary<int, ProcessTarget> Running { get; } = new() { [Game.Pid] = Game };
        public bool Refuse { get; set; }
        public IProcessSession? Open(int pid) => Running.ContainsKey(pid) ? new Session(this, pid) : null;
        private sealed class Session(MemoryProcesses store, int pid) : IProcessSession
        {
            public ProcessTarget Read() => store.Running[pid];
            public void SetPriority(string priority)
            {
                if (store.Refuse) throw new Win32Exception(5);
                store.Running[pid] = store.Running[pid] with { Priority = priority };
            }
            public void Dispose() { }
        }
    }
    [Fact]
    public void StartsVerifiesAndStopsRestoringOriginalPriority()
    {
        var store = new MemoryProcesses(); var engine = new GameProcessOperations(store);
        var started = engine.Start(Game);
        Assert.True(started.Ok); Assert.Equal(Game, started.BoostSnapshot);
        Assert.Equal("AboveNormal", store.Running[Game.Pid].Priority);
        var stopped = engine.Stop(started.BoostSnapshot!);
        Assert.True(stopped.Ok);
        Assert.Equal("Normal", store.Running[Game.Pid].Priority);
    }
    [Fact]
    public void ReportsExitedProcessWithoutChangingAnything()
    {
        var store = new MemoryProcesses(); var engine = new GameProcessOperations(store);
        store.Running.Clear();
        var start = engine.Start(Game);
        Assert.False(start.Ok); Assert.Equal("process-exited", start.Code);
        var stop = engine.Stop(Game with { Priority = "Normal" });
        Assert.True(stop.Ok); Assert.Equal("process-exited", stop.Code);
    }
    [Fact]
    public void RefusesPriorityConflictsAndExternalChangesOnStop()
    {
        var store = new MemoryProcesses(); var engine = new GameProcessOperations(store);
        store.Running[Game.Pid] = Game with { Priority = "High" };
        Assert.Equal("priority-conflict", engine.Start(Game).Code);
        Assert.Equal("High", store.Running[Game.Pid].Priority);
        Assert.Equal("priority-conflict", engine.Stop(Game).Code);
        Assert.Equal("High", store.Running[Game.Pid].Priority);
    }
    [Fact]
    public void RefusesAReusedPidWithDifferentIdentity()
    {
        var store = new MemoryProcesses(); var engine = new GameProcessOperations(store);
        store.Running[Game.Pid] = Game with { StartTime = "2026-10-12T11:00:00.0000000Z" };
        Assert.Equal("process-changed", engine.Start(Game).Code);
        store.Running[Game.Pid] = Game with { ExecutablePath = @"C:\Other\other.exe" };
        Assert.Equal("process-changed", engine.Start(Game).Code);
        Assert.Equal("Normal", store.Running[Game.Pid].Priority);
    }
    [Fact]
    public void ReportsProtectedProcessRefusalAsFailureNeverSuccess()
    {
        var store = new MemoryProcesses { Refuse = true }; var engine = new GameProcessOperations(store);
        var start = engine.Start(Game);
        Assert.False(start.Ok); Assert.Equal("change-refused", start.Code); Assert.Contains("refused", start.Message);
        store.Running[Game.Pid] = Game with { Priority = "AboveNormal" };
        var stop = engine.Stop(Game);
        Assert.False(stop.Ok); Assert.Equal("change-refused", stop.Code);
    }
    [Fact]
    public void RejectsInvalidSnapshots()
    {
        var engine = new GameProcessOperations(new MemoryProcesses());
        Assert.Throws<InvalidOperationException>(() => engine.Start(Game with { Priority = "High" }));
        Assert.Throws<InvalidOperationException>(() => engine.Start(Game with { ExecutablePath = @"\server\share\game.exe" }));
        Assert.Throws<InvalidOperationException>(() => engine.Stop(Game with { StartTime = "yesterday" }));
    }
}
