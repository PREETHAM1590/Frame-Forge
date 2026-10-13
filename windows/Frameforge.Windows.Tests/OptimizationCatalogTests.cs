using Frameforge.Windows;
using Xunit;

public class OptimizationCatalogTests
{
    // Keyed by path and name, honours Delete targets; nothing touches the real registry, boot store or power settings.
    private sealed class Memory : IRegistryStore
    {
        public Dictionary<string, ValueState> Values { get; } = new();
        public int Writes;
        public static string Key(Setting s) => s.Path + "|" + s.Name;
        public ValueState Read(Setting s) => Values.GetValueOrDefault(Key(s), new(false, null, s.Kind));
        public void Write(Setting s, ValueState state) { Writes++; if (state.Existed) Values[Key(s)] = state; else Values.Remove(Key(s)); }
    }
    private sealed class Facts(int build = 26100, bool nvidia = true, bool tamper = false) : IFacts
    {
        public int Build() => build;
        public bool MachineKeyExists(string path) => nvidia;
        public bool TamperProtectionOn() => tamper;
    }
    private sealed class Tools : IToolRunner
    {
        public List<string> Calls { get; } = new(); public string Output = "";
        public string Run(string tool, string[] args) { Calls.Add(tool + " " + string.Join(' ', args)); return Output; }
    }
    private static readonly string[] Ops = OptimizationTable.Settings.Select(s => s.Operation).Where(o => o != "game-mode").Distinct().ToArray();
    public static IEnumerable<object[]> AllOps() => Ops.Select(o => new object[] { o });

    private static object? Different(Setting s) => s.Kind == "DWord" ? (s.Target == 7 ? 8 : 7) : "9";

    [Theory, MemberData(nameof(AllOps))]
    public void EveryOptimizationRoundTripsFromAbsent(string id)
    {
        var store = new Memory(); var engine = new RegistryOperations(store, new Facts());
        var snapshot = engine.Capture([id]);
        Assert.All(snapshot.Values, v => Assert.False(v.Existed));
        // hibernate-off reads an always-present value, covered by the present-value test below.
        if (id == "hibernate-off") return;
        engine.Apply([id], snapshot);
        Assert.True(engine.Verify([id]));
        engine.Restore(snapshot);
        Assert.Empty(store.Values);
    }

    [Theory, MemberData(nameof(AllOps))]
    public void EveryOptimizationRestoresAnExistingPriorValueExactly(string id)
    {
        var store = new Memory();
        foreach (var s in OptimizationTable.Settings.Where(s => s.Operation == id)) store.Values[Memory.Key(s)] = new(true, s.IsBcd ? "standard" : Different(s), s.Kind);
        // BCD values must be members of the allowed set for that element; Different() is only a stand-in for the fake store.
        var before = store.Values.ToDictionary(p => p.Key, p => p.Value);
        var engine = new RegistryOperations(store, new Facts());
        var snapshot = engine.Capture([id]);
        Assert.All(snapshot.Values, v => Assert.True(v.Existed));
        engine.Apply([id], snapshot);
        Assert.True(engine.Verify([id]));
        engine.Restore(snapshot);
        Assert.Equal(before, store.Values);
    }

    [Fact]
    public void TableIsConsistent()
    {
        Assert.All(OptimizationTable.Settings, s => Assert.True(s.Kind is "DWord" or "String"));
        Assert.All(OptimizationTable.Settings.Where(s => s.IsMachine || s.IsBcd), s => Assert.True(s.NeedsAdmin));
        Assert.All(OptimizationTable.Settings.Where(s => !s.IsMachine && !s.IsBcd), s => Assert.DoesNotContain("HKLM", s.Path));
        Assert.Equal(OptimizationTable.Settings.Length, OptimizationTable.Settings.Select(s => (s.Operation, s.Path, s.Name)).Distinct().Count());
        Assert.All(OptimizationTable.Security, id => Assert.True(OptimizationTable.IsAdmin(id)));
        Assert.All(OptimizationTable.Settings.Where(s => s.IsBcd), s => Assert.True(s.ReadNeedsAdmin));
        Assert.Contains("Why", typeof(OpRule).GetProperties().Select(p => p.Name));
    }

    [Fact]
    public void PrerequisitesBlockUnsuitablePcs()
    {
        Assert.Throws<InvalidOperationException>(() => new RegistryOperations(new Memory(), new Facts(build: 19045)).Capture(["classic-context-menu"]));
        Assert.Throws<InvalidOperationException>(() => new RegistryOperations(new Memory(), new Facts(nvidia: false)).Capture(["dlss-indicator"]));
        var tamper = Assert.Throws<InvalidOperationException>(() => new RegistryOperations(new Memory(), new Facts(tamper: true)).Capture(["defender-off"]));
        Assert.Contains("Tamper Protection", tamper.Message);
        new RegistryOperations(new Memory(), new Facts(tamper: false)).Capture(["defender-off"]);
        var applicable = OptimizationTable.Applicable(new Facts(build: 19045, nvidia: false));
        Assert.DoesNotContain("classic-context-menu", applicable); Assert.DoesNotContain("dlss-indicator", applicable); Assert.Contains("defender-off", applicable);
    }

    [Fact]
    public void RollbackIgnoresPrerequisitesSoItAlwaysWorks()
    {
        var store = new Memory(); var snapshot = new RegistryOperations(store, new Facts()).Capture(["defender-off"]);
        new RegistryOperations(store, new Facts()).Apply(["defender-off"], snapshot);
        new RegistryOperations(store, new Facts(tamper: true)).Restore(snapshot);
        Assert.Empty(store.Values);
    }

    [Fact]
    public void ExternalChangeStopsRollbackAndSnapshotsCannotTargetOtherKeys()
    {
        var store = new Memory(); var engine = new RegistryOperations(store, new Facts());
        var snapshot = engine.Capture(["uac-off"]); engine.Apply(["uac-off"], snapshot);
        var key = Memory.Key(OptimizationTable.Settings.Single(s => s.Operation == "uac-off")); store.Values[key] = new(true, 1, "DWord");
        Assert.Throws<InvalidOperationException>(() => engine.Restore(snapshot));
        Assert.Equal(1, store.Values[key].Value);
        Assert.Throws<InvalidOperationException>(() => engine.Restore(snapshot with { Values = [snapshot.Values[0] with { Path = @"HKLM\SOFTWARE\Evil" }] }));
    }

    [Fact]
    public void DeleteTargetsAreVerifiedAsAbsent()
    {
        var store = new Memory(); var setting = OptimizationTable.Settings.Single(s => s.Operation == "onedrive-startup-off");
        store.Values[Memory.Key(setting)] = new(true, @"""C:\Users\x\OneDrive.exe"" /background", "String");
        var engine = new RegistryOperations(store, new Facts()); var snapshot = engine.Capture(["onedrive-startup-off"]);
        Assert.False(engine.Verify(["onedrive-startup-off"])); engine.Apply(["onedrive-startup-off"], snapshot);
        Assert.True(engine.Verify(["onedrive-startup-off"])); Assert.Empty(store.Values);
        engine.Restore(snapshot); Assert.Equal(@"""C:\Users\x\OneDrive.exe"" /background", store.Values[Memory.Key(setting)].Value);
    }

    [Fact]
    public void WindowsRevertingAWriteIsReportedByVerification()
    {
        var store = new Memory(); var engine = new RegistryOperations(store, new Facts());
        var snapshot = engine.Capture(["uac-off"]); engine.Apply(["uac-off"], snapshot);
        store.Values[Memory.Key(OptimizationTable.Settings.Single(s => s.Operation == "uac-off"))] = new(true, 1, "DWord");
        Assert.False(engine.Verify(["uac-off"]));
    }

    [Fact]
    public void BcdParsingAndCommandsAreFixed()
    {
        const string output = "Windows Boot Loader\n-------------------\nidentifier              {current}\nquietboot               Yes\nbootmenupolicy          Standard\n";
        Assert.Equal("on", BcdStore.Parse(output, "quietboot")); Assert.Equal("standard", BcdStore.Parse(output, "bootmenupolicy"));
        Assert.Null(BcdStore.Parse(output, "timeout"));
        Assert.Throws<InvalidOperationException>(() => BcdStore.Parse("quietboot  Ja\n", "quietboot"));
        var tools = new Tools(); var bcd = new BcdStore(tools);
        bcd.Set("{current}", "quietboot", "on"); bcd.Delete("{bootmgr}", "timeout");
        Assert.Equal(["bcdedit /set {current} quietboot on", "bcdedit /deletevalue {bootmgr} timeout"], tools.Calls);
        Assert.Throws<InvalidOperationException>(() => bcd.Set("{current}", "quietboot", "on & calc"));
        Assert.Throws<InvalidOperationException>(() => bcd.Set("{current}", "nx", "off"));
        Assert.Throws<InvalidOperationException>(() => bcd.Set("{default}", "quietboot", "off"));
        Assert.Throws<InvalidOperationException>(() => bcd.Get("{current} /v", "quietboot"));
        Assert.Throws<InvalidOperationException>(() => new SystemTools().Run("cmd", ["/c", "calc"]));
    }

    [Fact]
    public void BootAndHibernationWritesUseOnlyFixedArguments()
    {
        var tools = new Tools(); var store = new WindowsRegistryStore(tools);
        var hibernate = OptimizationTable.Settings.Single(s => s.Operation == "hibernate-off");
        store.Write(hibernate, new(true, 0, "DWord")); store.Write(hibernate, new(true, 1, "DWord"));
        Assert.Throws<InvalidOperationException>(() => store.Write(hibernate, new(true, 5, "DWord")));
        Assert.Throws<InvalidOperationException>(() => store.Write(hibernate, new(false, null, "DWord")));
        Assert.Equal(["powercfg /hibernate off", "powercfg /hibernate on"], tools.Calls);
        tools.Calls.Clear(); tools.Output = "quietboot  No\n";
        var logo = OptimizationTable.Settings.Single(s => s.Operation == "boot-logo-off");
        Assert.Equal(new ValueState(true, "off", "String"), store.Read(logo));
        store.Write(logo, new(false, null, "String")); store.Write(logo, new(true, "on", "String"));
        Assert.Equal(["bcdedit /enum {current}", "bcdedit /deletevalue {current} quietboot", "bcdedit /set {current} quietboot on"], tools.Calls);
    }

    private sealed class Gateway(Func<AdminRequest, AdminResult> run) : IAdminGateway
    {
        public List<AdminRequest> Requests { get; } = new();
        public AdminResult Run(AdminRequest request) { Requests.Add(request); return run(request); }
    }
    private sealed class NoPower : IPowerStore
    {
        public Guid Active() => throw new NotSupportedException(); public bool Exists(Guid scheme) => false; public void SetActive(Guid scheme) => throw new NotSupportedException();
        public void Duplicate(Guid source, Guid destination, string name) => throw new NotSupportedException();
        public string? Name(Guid scheme) => null; public void Delete(Guid scheme) => throw new NotSupportedException();
    }

    [Fact]
    public void MachineSettingsRouteThroughTheAdministratorGatewayAndUserSettingsDoNot()
    {
        var store = new Memory(); var machine = new Memory();
        var inner = new RegistryOperations(machine, new Facts());
        var gateway = new Gateway(request => AdminCommands.Execute(request, inner));
        var engine = new Optimizations(new RegistryOperations(store, new Facts()), new NoPower(), null, gateway, false);
        var snapshot = engine.Capture(["transparency-off", "boot-logo-off", "lock-screen-blur-off"]);
        // Only the boot store needs administrator rights to be read; HKLM values are read in-process.
        Assert.Equal(["capture"], gateway.Requests.Select(r => r.Command)); Assert.Equal(["boot-logo-off"], gateway.Requests[0].Ids);
        var verified = engine.Apply(["transparency-off", "boot-logo-off", "lock-screen-blur-off"], snapshot);
        Assert.True(verified);
        var apply = gateway.Requests.Last(); Assert.Equal("apply", apply.Command);
        Assert.Equal(["boot-logo-off", "lock-screen-blur-off"], apply.Ids.OrderBy(i => i));
        Assert.All(apply.Values!, v => Assert.NotEqual("transparency-off", v.Operation));
        Assert.Single(store.Values); // the user value was written locally, the rest in the "elevated" store
        Assert.Equal(2, machine.Values.Count);
        engine.Restore(snapshot);
        Assert.Equal("restore", gateway.Requests.Last().Command);
        Assert.Empty(store.Values); Assert.Empty(machine.Values);
    }

    [Fact]
    public void DecliningTheAdministratorPromptLeavesEverythingUntouched()
    {
        var store = new Memory();
        var gateway = new Gateway(_ => throw new InvalidOperationException("Administrator approval was declined. Nothing was changed."));
        var engine = new Optimizations(new RegistryOperations(store, new Facts()), new NoPower(), null, gateway, false);
        var snapshot = engine.Capture(["transparency-off", "lock-screen-blur-off"]);
        Assert.Throws<InvalidOperationException>(() => engine.Apply(["transparency-off", "lock-screen-blur-off"], snapshot));
        Assert.Equal(0, store.Writes);
    }

    [Fact]
    public void TheElevatedStepRefusesUserSettingsAndMalformedRequests()
    {
        var engine = new RegistryOperations(new Memory(), new Facts());
        Assert.Throws<InvalidOperationException>(() => AdminCommands.Execute(new("capture", ["transparency-off"], null), engine));
        Assert.Throws<InvalidOperationException>(() => AdminCommands.Execute(new("capture", [], null), engine));
        Assert.Throws<InvalidOperationException>(() => AdminCommands.Execute(new("run", ["uac-off"], null), engine));
        Assert.Throws<InvalidOperationException>(() => AdminCommands.Execute(new("apply", ["uac-off"], null), engine));
        Assert.Equal(2, WindowsAdminGateway.RunChild(["C:\\not-a-result-file.json", "{}"], _ => ""));
        Assert.Equal(2, WindowsAdminGateway.RunChild(["only-one"], _ => ""));
    }

    [Fact]
    public void ApplyReportsFalseWhenTheElevatedReReadDisagrees()
    {
        var machine = new Memory(); var inner = new RegistryOperations(machine, new Facts());
        var gateway = new Gateway(request => { var result = AdminCommands.Execute(request, inner); if (request.Command == "apply") foreach (var s in OptimizationTable.Settings.Where(s => s.Operation == "uac-off")) machine.Values[Memory.Key(s)] = new(true, 1, "DWord"); return request.Command == "apply" ? result with { Verified = inner.Verify(request.Ids) } : result; });
        var engine = new Optimizations(new RegistryOperations(new Memory(), new Facts()), new NoPower(), null, gateway, false);
        var snapshot = engine.Capture(["uac-off"]);
        Assert.False(engine.Apply(["uac-off"], snapshot));
    }
}
