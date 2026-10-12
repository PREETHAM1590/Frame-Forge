using Frameforge.Windows;
using Xunit;

public class RegistryOperationsTests
{
    private sealed class MemoryRegistry : IRegistryStore
    {
        public Dictionary<string, ValueState> Values { get; } = new();
        public int Writes { get; private set; }
        public ValueState Read(Setting setting) => Values.GetValueOrDefault(setting.Name, new(false, null, setting.Kind));
        public void Write(Setting setting, ValueState state) { Writes++; Values[setting.Name] = state; }
    }
    [Fact]
    public void CapturesAbsentValuesAndRestoresThem()
    {
        var store = new MemoryRegistry(); var engine = new RegistryOperations(store);
        var snapshot = engine.Capture(["mouse-precision"]);
        Assert.All(snapshot.Values, value => Assert.False(value.Existed));
        engine.Apply(["mouse-precision"], snapshot);
        Assert.True(engine.Verify(["mouse-precision"]));
        engine.Restore(snapshot);
        Assert.All(snapshot.Values, value => Assert.False(store.Read(new(value.Operation, value.Path, value.Name, value.Kind)).Existed));
    }
    [Fact]
    public void RejectsArbitraryPathsAndIncompleteSnapshots()
    {
        var engine = new RegistryOperations(new MemoryRegistry());
        var snapshot = engine.Capture(["capture-off"]);
        var tampered = snapshot with { Values = [snapshot.Values[0] with { Path = "Software\\Other" }] };
        Assert.Throws<InvalidOperationException>(() => engine.Restore(tampered));
        Assert.Throws<InvalidOperationException>(() => engine.Restore(new([])));
        Assert.Throws<InvalidOperationException>(() => engine.Capture(["shell-command"]));
    }
    [Fact]
    public void RejectsExternalChangesBeforeApplyAndRollback()
    {
        var store = new MemoryRegistry(); var engine = new RegistryOperations(store);
        var snapshot = engine.Capture(["mouse-precision"]);
        store.Values["MouseSpeed"] = new(true, "2", "String");
        Assert.Throws<InvalidOperationException>(() => engine.Apply(["mouse-precision"], snapshot));
        Assert.Throws<InvalidOperationException>(() => engine.Restore(snapshot));
        Assert.Equal("2", store.Values["MouseSpeed"].Value);
    }
    [Fact]
    public void RestoresExistingValuesAndVerifiesExactKinds()
    {
        var store = new MemoryRegistry(); store.Values["AppCaptureEnabled"] = new(true, 1, "DWord");
        var engine = new RegistryOperations(store); var snapshot = engine.Capture(["capture-off"]);
        engine.Apply(["capture-off"], snapshot); Assert.True(engine.Verify(["capture-off"]));
        engine.Restore(snapshot); Assert.Equal(1, store.Values["AppCaptureEnabled"].Value);
    }
    [Fact]
    public void RejectsMaliciousSnapshotBeforeAnyWrites()
    {
        var store = new MemoryRegistry(); var engine = new RegistryOperations(store);
        var snapshot = engine.Capture(["mouse-precision"]);
        Snapshot[] invalid = [
            snapshot with { Values = [snapshot.Values[0], snapshot.Values[0], snapshot.Values[2]] },
            snapshot with { Values = [snapshot.Values[0], snapshot.Values[1]] },
            snapshot with { Values = [snapshot.Values[0] with { Kind = "DWord" }, snapshot.Values[1], snapshot.Values[2]] },
            snapshot with { Values = [snapshot.Values[0] with { Existed = true, Value = null }, snapshot.Values[1], snapshot.Values[2]] },
            snapshot with { Values = [snapshot.Values[0] with { Existed = false, Value = "1" }, snapshot.Values[1], snapshot.Values[2]] },
            snapshot with { Values = [null!] }
        ];
        foreach (var item in invalid) Assert.Throws<InvalidOperationException>(() => engine.Restore(item));
        Assert.Equal(0, store.Writes);
    }
    [Fact]
    public void RollbackChecksAllValuesBeforeWritingAny()
    {
        var store = new MemoryRegistry(); var engine = new RegistryOperations(store);
        var snapshot = engine.Capture(["mouse-precision"]); engine.Apply(["mouse-precision"], snapshot);
        store.Values["MouseThreshold2"] = new(true, "7", "String");
        var before = store.Writes;
        Assert.Throws<InvalidOperationException>(() => engine.Restore(snapshot));
        Assert.Equal(before, store.Writes); Assert.Equal("7", store.Values["MouseThreshold2"].Value);
        Assert.Equal("0", store.Values["MouseSpeed"].Value);
    }
}
