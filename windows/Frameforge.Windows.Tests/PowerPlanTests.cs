using Frameforge.Windows;
using Xunit;

public class PowerPlanTests
{
    private static readonly Guid Balanced = new("381b4222-f694-41f0-9685-ff5bb260df2e");
    private static readonly Guid Saver = new("a1841308-3541-4fab-bc81-f71556f20b4a");
    private sealed class FakePower(params Guid[] plans) : IPowerStore
    {
        public Guid Current { get; set; } = Balanced;
        public int Sets { get; private set; }
        public Guid Active() => Current;
        public bool Exists(Guid scheme) => plans.Contains(scheme);
        public void SetActive(Guid scheme) { if (!Exists(scheme)) throw new InvalidOperationException("absent"); Sets++; Current = scheme; }
        public Guid Duplicate(Guid source, string name) => throw new NotSupportedException();
        public void Delete(Guid scheme) => throw new NotSupportedException();
    }
    private sealed class NoRegistry : IRegistryStore
    {
        public ValueState Read(Setting setting) => new(false, null, setting.Kind);
        public void Write(Setting setting, ValueState state) { }
    }
    private static Optimizations Engine(FakePower power) => new(new RegistryOperations(new NoRegistry()), power);

    [Fact]
    public void SwitchesVerifiesAndRestoresThePriorPlan()
    {
        var power = new FakePower(Balanced, Optimizations.HighPerformance);
        var engine = Engine(power);
        var snapshot = engine.Capture(["power-plan"]);
        Assert.Equal(Balanced.ToString(), snapshot.Scheme);
        Assert.Empty(snapshot.Values);
        engine.Apply(["power-plan"], snapshot);
        Assert.True(engine.Verify(["power-plan"]));
        power.Current = Balanced;
        Assert.False(engine.Verify(["power-plan"]));
        power.Current = Optimizations.HighPerformance;
        engine.Restore(snapshot);
        Assert.Equal(Balanced, power.Current);
    }

    [Fact]
    public void AbsentHighPerformancePlanIsRefusedWithoutChanges()
    {
        var power = new FakePower(Balanced);
        var error = Assert.Throws<InvalidOperationException>(() => Engine(power).Capture(["power-plan"]));
        Assert.Contains("not present", error.Message);
        Assert.Equal(0, power.Sets);
    }

    [Fact]
    public void RestoreKeepsAPlanChosenExternally()
    {
        var power = new FakePower(Balanced, Saver, Optimizations.HighPerformance);
        var engine = Engine(power);
        var snapshot = engine.Capture(["power-plan"]);
        engine.Apply(["power-plan"], snapshot);
        power.Current = Saver;
        Assert.Throws<InvalidOperationException>(() => engine.Restore(snapshot));
        Assert.Equal(Saver, power.Current);
    }

    [Fact]
    public void MixedSelectionsAndTamperedSnapshotsAreChecked()
    {
        var power = new FakePower(Balanced, Optimizations.HighPerformance);
        var engine = Engine(power);
        var snapshot = engine.Capture(["mouse-precision", "power-plan"]);
        Assert.Equal(3, snapshot.Values.Length);
        Assert.Throws<InvalidOperationException>(() => engine.Apply(["mouse-precision"], snapshot));
        Assert.Throws<InvalidOperationException>(() => engine.Apply(["power-plan"], snapshot with { Values = [] , Scheme = "not-a-guid" }));
        power.Current = Saver;
        Assert.Throws<InvalidOperationException>(() => engine.Apply(["mouse-precision", "power-plan"], snapshot));
        Assert.Equal(0, power.Sets);
    }
}
