using System.Text.Json;
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
        // hibernate-off reads an always-present value; when Windows does not report it, capture refuses (M2).
        if (id == "hibernate-off") { Assert.Throws<InvalidOperationException>(() => engine.Capture([id])); return; }
        var snapshot = engine.Capture([id]);
        Assert.All(snapshot.Values, v => Assert.False(v.Existed));
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
        // M3: a security item that Windows reverted to a third value is set back to the captured state and reported.
        var note = engine.Restore(snapshot);
        Assert.Equal(["EnableLUA"], note); Assert.Empty(store.Values);
        Assert.Throws<InvalidOperationException>(() => engine.Restore(snapshot with { Values = [snapshot.Values[0] with { Path = @"HKLM\SOFTWARE\Evil" }] }));
    }

    [Fact]
    public void ANonSecurityValueChangedByTheUserIsStillPreservedOnRollback()
    {
        var store = new Memory(); var engine = new RegistryOperations(store, new Facts());
        var snapshot = engine.Capture(["lock-screen-blur-off"]); engine.Apply(["lock-screen-blur-off"], snapshot);
        var key = Memory.Key(OptimizationTable.Settings.Single(s => s.Operation == "lock-screen-blur-off")); store.Values[key] = new(true, 5, "DWord");
        Assert.Throws<InvalidOperationException>(() => engine.Restore(snapshot));
        Assert.Equal(5, store.Values[key].Value);
    }

    [Fact]
    public void GatewayRestoreNoteReachesTheCaller()
    {
        var machine = new Memory(); var inner = new RegistryOperations(machine, new Facts());
        var gateway = new Gateway(request => AdminCommands.Execute(request, inner));
        var engine = new Optimizations(new RegistryOperations(new Memory(), new Facts()), new NoPower(), null, gateway, false);
        var snapshot = engine.Capture(["uac-off"]); engine.Apply(["uac-off"], snapshot);
        machine.Values[Memory.Key(OptimizationTable.Settings.Single(s => s.Operation == "uac-off"))] = new(true, 1, "DWord");
        var note = engine.Restore(snapshot);
        Assert.Contains("EnableLUA", note); Assert.Empty(machine.Values);
    }

    // IKeyDepth fake: remembers the OwnKey the restore asked for.
    private sealed class Deep(int missing) : IRegistryStore, IKeyDepth
    {
        public Dictionary<string, ValueState> Values { get; } = new(); public List<int> OwnKeys { get; } = new();
        public ValueState Read(Setting s) => Values.GetValueOrDefault(Memory.Key(s), new(false, null, s.Kind));
        public void Write(Setting s, ValueState state) { OwnKeys.Add(s.OwnKey); if (state.Existed) Values[Memory.Key(s)] = state; else Values.Remove(Memory.Key(s)); }
        public int MissingKeys(Setting s) => missing;
    }

    [Fact]
    public void RollbackRemovesExactlyTheKeysTheCaptureSawMissing()
    {
        var store = new Deep(3); var engine = new RegistryOperations(store, new Facts());
        var snapshot = engine.Capture(["storage-sense-off"]);
        Assert.All(snapshot.Values, v => Assert.Equal(3, v.Created));
        engine.Apply(["storage-sense-off"], snapshot); engine.Restore(snapshot);
        Assert.Equal([3], store.OwnKeys.Skip(1)); // the apply write, then the restore with the captured count
        // A key that already existed (nothing missing) is never removed, whatever the table's bound says.
        var kept = new Deep(0); var shortcut = new RegistryOperations(kept, new Facts());
        var snap = shortcut.Capture(["shortcut-suffix-off"]); shortcut.Apply(["shortcut-suffix-off"], snap); shortcut.Restore(snap);
        Assert.Equal(0, kept.OwnKeys.Last());
        // Snapshots saved before the count existed fall back to the table.
        var legacy = new Memory(); var old = new RegistryOperations(legacy, new Facts());
        var oldSnap = old.Capture(["shortcut-suffix-off"]); Assert.All(oldSnap.Values, v => Assert.Null(v.Created));
    }

    [Fact]
    public void RealRegistryKeysCreatedByAWriteAreRemovedAgainAndPreexistingOnesKept()
    {
        var root = $@"Software\FrameforgeTest_{Guid.NewGuid():N}";
        var store = new WindowsRegistryStore(new Tools());
        var setting = new Setting("t", root + @"\A\B", "V", "DWord", 1);
        try
        {
            Assert.Equal(3, store.MissingKeys(setting));
            store.Write(setting, new(true, 1, "DWord"));
            Assert.Equal(0, store.MissingKeys(setting)); Assert.Equal(new ValueState(true, 1, "DWord"), store.Read(setting));
            store.Write(setting with { OwnKey = 3 }, new(false, null, "DWord"));
            using (var gone = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(root)) Assert.Null(gone);
            // Only the missing levels go: A existed already, so it stays.
            using (Microsoft.Win32.Registry.CurrentUser.CreateSubKey(root + @"\A")) { }
            Assert.Equal(1, store.MissingKeys(setting));
            store.Write(setting, new(true, 1, "DWord")); store.Write(setting with { OwnKey = 1 }, new(false, null, "DWord"));
            using (var a = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(root + @"\A")) Assert.NotNull(a);
            using (var b = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(root + @"\A\B")) Assert.Null(b);
        }
        finally { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(root, false); }
    }

    [Fact]
    public void HibernationIsRefusedAtCaptureWhenWindowsDoesNotReportIt()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => new RegistryOperations(new Memory(), new Facts()).Capture(["hibernate-off"]));
        Assert.Contains("cannot be restored", ex.Message);
        var store = new Memory(); store.Values[Memory.Key(OptimizationTable.Settings.Single(s => s.Operation == "hibernate-off"))] = new(true, 1, "DWord");
        Assert.True(new RegistryOperations(store, new Facts()).Capture(["hibernate-off"]).Values[0].Existed);
    }

    [Fact]
    public void RecheckFindsRevertedValuesAndSkipsTheBootStore()
    {
        var store = new Memory(); var engine = new RegistryOperations(store, new Facts());
        var ids = new[] { "uac-off", "ucpd-off", "vbs-hyperv-off" };
        var snapshot = engine.Capture(ids); engine.Apply(ids, snapshot);
        Assert.Empty(engine.Drifted(ids));
        store.Values[Memory.Key(OptimizationTable.Settings.Single(s => s.Operation == "ucpd-off"))] = new(true, 1, "DWord");
        Assert.Equal(["ucpd-off"], engine.Drifted(ids));
        store.Values.Remove(Memory.Key(OptimizationTable.Settings.Single(s => s.Operation == "vbs-hyperv-off" && s.IsBcd)));
        Assert.Equal(["ucpd-off"], engine.Drifted(ids)); // the boot store is not re-read without a prompt
    }

    [Fact]
    public void DefenderStateIsDescribedReadOnly()
    {
        Assert.Equal("Defender reports antivirus on and real-time protection off.", DefenderStatus.Describe(() => (true, false)));
        Assert.Contains("unknown", DefenderStatus.Describe(() => (null, true)));
        Assert.Contains("did not report", DefenderStatus.Describe(() => null));
    }

    [Fact]
    public void AFailedMachineStepUndoesTheCurrentUserPartWithASpecificMessage()
    {
        var store = new Memory();
        var gateway = new Gateway(_ => throw new InvalidOperationException("Administrator approval was declined. Nothing was changed."));
        var engine = new Optimizations(new RegistryOperations(store, new Facts()), new NoPower(), null, gateway, false);
        var ids = new[] { "transparency-off", "lock-screen-blur-off" };
        var snapshot = engine.Capture(ids);
        var ex = Assert.Throws<InvalidOperationException>(() => engine.Apply(ids, snapshot));
        Assert.Contains("machine-level step did not complete", ex.Message); Assert.Contains("Administrator approval was declined", ex.Message);
        Assert.Contains("were undone", ex.Message);
        Assert.Empty(store.Values); // applied first, then taken back
        Assert.Equal(2, store.Writes);
    }

    [Fact]
    public void IfTheCurrentUserPartCannotBeUndoneTheMessageSaysSo()
    {
        var store = new Memory(); var broke = false;
        var gateway = new Gateway(_ => { broke = true; store.Values[Memory.Key(OptimizationTable.Settings.Single(s => s.Operation == "transparency-off"))] = new(true, 99, "DWord"); throw new InvalidOperationException("The administrator step did not finish in time."); });
        var engine = new Optimizations(new RegistryOperations(store, new Facts()), new NoPower(), null, gateway, false);
        var ids = new[] { "transparency-off", "lock-screen-blur-off" };
        var snapshot = engine.Capture(ids);
        var ex = Assert.Throws<InvalidOperationException>(() => engine.Apply(ids, snapshot));
        Assert.True(broke); Assert.Contains("could not be undone", ex.Message); Assert.Contains("use Rollback", ex.Message);
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
        Assert.Empty(store.Values); // the current-user part was applied first and undone again
    }

    [Fact]
    public void TheElevatedStepRefusesUserSettingsAndMalformedRequests()
    {
        var engine = new RegistryOperations(new Memory(), new Facts());
        Assert.Throws<InvalidOperationException>(() => AdminCommands.Execute(new("capture", ["transparency-off"], null), engine));
        Assert.Throws<InvalidOperationException>(() => AdminCommands.Execute(new("capture", [], null), engine));
        Assert.Throws<InvalidOperationException>(() => AdminCommands.Execute(new("run", ["uac-off"], null), engine));
        Assert.Throws<InvalidOperationException>(() => AdminCommands.Execute(new("apply", ["uac-off"], null), engine));
        Assert.Equal(2, WindowsAdminGateway.RunChild(["run", "C:\\not-a-result-file.json", "{}"], _ => ""));
        Assert.Equal(2, WindowsAdminGateway.RunChild(["only-one"], _ => ""));
    }

    [Fact]
    public void TheOptimizeChildRejectsAMissingOrOldRequestBeforeChangingAnything()
    {
        var path = WindowsServiceElevator.NewResultPath();
        var json = JsonSerializer.Serialize(new AdminRequest("capture", ["uac-off"], null), HelperJson.Options);
        try
        {
            var registry = new RegistryOperations(new Memory(), new Facts());
            // No request file, then one issued five minutes ago for thirty seconds: the child must not even open the result file.
            Assert.Equal(3, WindowsAdminGateway.RunChild(["run", path, json], _ => "x", registry));
            ElevationRequest.Create(path, TimeSpan.FromSeconds(30), DateTime.UtcNow.AddMinutes(-5));
            Assert.Equal(3, WindowsAdminGateway.RunChild(["run", path, json], _ => "x", registry));
            Assert.Equal(0, new FileInfo(path).Length);
            // A fresh request is honoured.
            ElevationRequest.Withdraw(path);
            ElevationRequest.Create(path, TimeSpan.FromSeconds(30));
            Assert.Equal(0, WindowsAdminGateway.RunChild(["run", path, json], _ => "{\"ok\":true}", registry));
            Assert.NotEqual(0, new FileInfo(path).Length);
        }
        finally { ElevationRequest.Withdraw(path); File.Delete(path); }
    }

    // A prompt that is answered after the parent gave up runs the real child against a fake machine; the withdrawn request makes it change nothing.
    private sealed class LateLauncher(Memory machine) : IElevatedLauncher
    {
        public ManualResetEventSlim Answer { get; } = new(false);
        public int ChildExit { get; private set; } = -1;
        private sealed class Child(int exit) : IElevatedChild { public bool WaitForExit(TimeSpan t) => true; public int? ExitCode => exit; public void Dispose() { } }
        public IElevatedChild? Start(IReadOnlyList<string> arguments)
        {
            Answer.Wait();
            ChildExit = WindowsAdminGateway.RunChild([.. arguments.Skip(1)], v => JsonSerializer.Serialize(v, HelperJson.Options), new RegistryOperations(machine, new Facts()));
            return new Child(ChildExit);
        }
    }

    [Fact]
    public void ALateApprovalAfterTheBudgetChangesNothing()
    {
        Assert.False(RestoreCommands.IsElevated(), "test must run unelevated");
        var machine = new Memory();
        var launcher = new LateLauncher(machine);
        var gateway = new WindowsAdminGateway(TimeSpan.FromSeconds(5), launcher, TimeSpan.FromMilliseconds(200), TimeSpan.FromMilliseconds(100));
        var snapshot = new RegistryOperations(machine, new Facts()).Capture(["uac-off"]);
        var error = Assert.Throws<InvalidOperationException>(() => gateway.Run(new("apply", ["uac-off"], snapshot.Values)));
        Assert.Contains("not given in time", error.Message);
        launcher.Answer.Set(); // the stale prompt is approved now
        SpinWait.SpinUntil(() => launcher.ChildExit != -1, TimeSpan.FromSeconds(5));
        Assert.InRange(launcher.ChildExit, 2, 3); // the result file is already gone (2) or the request is (3)
        Assert.Empty(machine.Values);
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
