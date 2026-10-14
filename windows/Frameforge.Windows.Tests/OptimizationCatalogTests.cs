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
        // Service run state is read from the service manager the same way: a service that is not reported cannot be restored later.
        if (id == "hibernate-off" || OptimizationTable.ServiceOps.ContainsKey(id)) { Assert.Throws<InvalidOperationException>(() => engine.Capture([id])); return; }
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
    // ---- Windows services and Photo Viewer -------------------------------------------------------------

    /// <summary>Models the service manager: Start in the registry (written through ChangeServiceConfig) and a run state.</summary>
    private sealed class ServiceWorld : IRegistryStore
    {
        public readonly Dictionary<string, (int Start, bool Running)> Services = new();
        public readonly List<string> Calls = new();
        private static string Name(Setting s) => s.Path[(s.Path.LastIndexOf('\\') + 1)..];
        public ValueState Read(Setting s)
        {
            if (!Services.TryGetValue(Name(s), out var svc)) return new(false, null, "DWord");
            return new(true, s.Via == "service-stop" ? (svc.Running ? 1 : 0) : svc.Start, "DWord");
        }
        public void Write(Setting s, ValueState state)
        {
            var svc = Services[Name(s)]; var v = (int)state.Value!;
            if (s.Via == "service-config") { Calls.Add($"config {Name(s)} {v}"); Services[Name(s)] = svc with { Start = v }; }
            else { Calls.Add($"{(v == 0 ? "stop" : "start")} {Name(s)}"); Services[Name(s)] = svc with { Running = v == 1 }; }
        }
    }

    [Theory]
    [InlineData(2, true)]
    [InlineData(3, true)]
    [InlineData(3, false)]
    [InlineData(4, false)]
    public void ServiceOptimizationDisablesStopsThenRestoresExactStartTypeAndState(int start, bool running)
    {
        var world = new ServiceWorld(); world.Services["SysMain"] = (start, running);
        var engine = new RegistryOperations(world, new Facts());
        var snapshot = engine.Capture(["sysmain-off"]);
        Assert.Equal(2, snapshot.Values.Length);
        engine.Apply(["sysmain-off"], snapshot);
        Assert.True(engine.Verify(["sysmain-off"]));
        Assert.Equal((4, false), world.Services["SysMain"]);
        // The start type is disabled before the stop, so the manager never restarts it in between.
        Assert.Equal("config SysMain 4", world.Calls[0]);
        world.Calls.Clear();
        engine.Restore(snapshot);
        Assert.Equal((start, running), world.Services["SysMain"]);
        // Start type first, then the run state; a service that was not running is never started.
        Assert.Equal("config SysMain " + start, world.Calls[0]);
        Assert.Equal(running, world.Calls.Contains("start SysMain"));
    }

    [Fact]
    public void ServiceOptimizationRefusesAnUnreportedServiceAndABlockedStop()
    {
        var engine = new RegistryOperations(new ServiceWorld(), new Facts());
        Assert.Throws<InvalidOperationException>(() => engine.Capture(["print-off"]));
        var blocked = new RegistryOperations(new ServiceWorld(), new BlockedFacts());
        var error = Assert.Throws<InvalidOperationException>(() => blocked.Capture(["print-off"]));
        Assert.Contains("depends on", error.Message);
        Assert.Contains("No change was made", error.Message);
    }

    private sealed class BlockedFacts : IFacts
    {
        public int Build() => 26100;
        public bool MachineKeyExists(string path) => true;
        public bool TamperProtectionOn() => false;
        public string? ServiceBlocker(string name) => $"The running service Fax depends on {name}.";
    }

    [Fact]
    public void ServiceRollbackRefusesAStartTypeChangedBySomeoneElse()
    {
        var world = new ServiceWorld(); world.Services["DiagTrack"] = (2, true);
        var engine = new RegistryOperations(world, new Facts());
        var snapshot = engine.Capture(["svc-diagtrack-off"]); engine.Apply(["svc-diagtrack-off"], snapshot);
        world.Services["DiagTrack"] = (3, false);
        world.Calls.Clear();
        Assert.Throws<InvalidOperationException>(() => engine.Restore(snapshot));
        Assert.Empty(world.Calls);
    }

    [Fact]
    public void EveryServiceItemIsOnTheGameModeAllowlistAndNotOnTheNeverTouchList()
    {
        foreach (var (op, service) in OptimizationTable.ServiceOps)
        {
            Assert.False(ServicePolicy.Denied(service), $"{service} is on the never-touch list");
            Assert.True(ServicePolicy.Allowed(service), $"{service} is not on the allowlist");
            Assert.Equal(2, OptimizationTable.Settings.Count(s => s.Operation == op));
            Assert.All(OptimizationTable.Settings.Where(s => s.Operation == op), s => Assert.EndsWith(@"\Services\" + service, s.Path));
            Assert.True(OptimizationTable.IsAdmin(op));
        }
    }

    [Fact]
    public void ServiceWritesGoOnlyThroughTheServiceManagerAndRejectOddValues()
    {
        var services = new FakeServices(); var config = new FakeConfig();
        var store = new WindowsRegistryStore(new Tools(), services, config);
        var start = OptimizationTable.Settings.First(s => s.Operation == "sysmain-off" && s.Via == "service-config");
        var state = OptimizationTable.Settings.First(s => s.Operation == "sysmain-off" && s.Via == "service-stop");
        store.Write(start, new(true, 4, "DWord")); store.Write(state, new(true, 0, "DWord")); store.Write(state, new(true, 1, "DWord"));
        Assert.Equal(["config SysMain 4"], config.Log.ToArray()); Assert.Equal(["stop SysMain", "start SysMain"], services.Log.ToArray());
        Assert.Throws<InvalidOperationException>(() => store.Write(start, new(true, 1, "DWord")));
        Assert.Throws<InvalidOperationException>(() => store.Write(start, new(false, null, "DWord")));
        Assert.Throws<InvalidOperationException>(() => store.Write(state, new(true, 2, "DWord")));
        Assert.Equal(new ValueState(true, 1, "DWord"), store.Read(state));
        services.Running = false; Assert.Equal(new ValueState(true, 0, "DWord"), store.Read(state));
        services.Exists = false; Assert.False(store.Read(state).Existed);
        services.Exists = true; services.StopWorks = false;
        Assert.Throws<InvalidOperationException>(() => store.Write(state, new(true, 0, "DWord")));
    }

    private sealed class FakeConfig : IServiceConfig { public List<string> Log = new(); public void SetStartType(string name, int start) => Log.Add($"config {name} {start}"); }
    private sealed class FakeServices : IServiceStore
    {
        public List<string> Log = new(); public bool Running = true, Exists = true, StopWorks = true;
        public ServiceInfo Query(string name) => new(Exists, Running, true, []);
        public bool Stop(string name, TimeSpan timeout) { Log.Add("stop " + name); return StopWorks; }
        public bool Start(string name, TimeSpan timeout) { Log.Add("start " + name); return true; }
    }

    [Fact]
    public void PhotoViewerNeedsItsRegistrationAndLeavesTheTiffEntriesAlone()
    {
        Assert.Throws<InvalidOperationException>(() => new RegistryOperations(new Memory(), new Facts(nvidia: false)).Capture(["photo-viewer"]));
        var settings = OptimizationTable.Settings.Where(s => s.Operation == "photo-viewer").ToArray();
        Assert.DoesNotContain(settings, s => s.Name is ".tif" or ".tiff");
        Assert.All(settings, s => Assert.Equal("PhotoViewer.FileAssoc.Tiff", s.Text));
        // The dotted extension is the registry value name; an existing user entry for one type is restored exactly.
        var store = new Memory(); var existing = settings.First(s => s.Name == ".jpg");
        store.Values[Memory.Key(existing)] = new(true, "SomethingElse", "String");
        var engine = new RegistryOperations(store, new Facts());
        var snapshot = engine.Capture(["photo-viewer"]); engine.Apply(["photo-viewer"], snapshot);
        Assert.Equal("PhotoViewer.FileAssoc.Tiff", store.Values[Memory.Key(existing)].Value);
        engine.Restore(snapshot);
        Assert.Equal(new ValueState(true, "SomethingElse", "String"), store.Values[Memory.Key(existing)]);
        Assert.Single(store.Values);
    }
}
