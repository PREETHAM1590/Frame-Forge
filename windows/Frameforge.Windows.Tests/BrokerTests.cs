using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Frameforge.Windows;
using Xunit;

namespace Frameforge.Windows.Tests;

public class BrokerTests
{
    private const string Sid = "S-1-5-21-111-222-333-1001";
    private static readonly string[] Dword = ["1", "0"];

    // ---- allowlist: exactly the five existing elevated children, with their own argument rules ----
    [Fact]
    public void AllowlistCoversExactlyTheFiveElevatedChildren()
    {
        Assert.Equal(["--elevated", "--elevated-services", "--elevated-timer", "--elevated-optimize", "--elevated-fps"], BrokerAllowlist.Ops);
        foreach (var other in new[] { "--elevated-broker", "--broker-service", "--session", "--monitor", "cmd.exe", "", "--ELEVATED" })
            Assert.Equal("not-allowed", BrokerAllowlist.Reject(other, "restore-list", []));
        Assert.Equal("not-allowed", BrokerAllowlist.Reject(null, "x", []));
        Assert.Equal("not-allowed", BrokerAllowlist.Reject("--elevated", null, []));
    }

    [Fact]
    public void ValidRequestsOfEachOperationPass()
    {
        Assert.Null(BrokerAllowlist.Reject("--elevated", "restore-list", []));
        Assert.Null(BrokerAllowlist.Reject("--elevated", "restore-create", ["Frameforge before tweaks", "0", "1", "1440"]));
        Assert.Null(BrokerAllowlist.Reject("--elevated", "restore-enable", ["C:"]));
        Assert.Null(BrokerAllowlist.Reject("--elevated-services", "stop", ["SysMain"]));
        Assert.Null(BrokerAllowlist.Reject("--elevated-services", "purge", []));
        Assert.Null(BrokerAllowlist.Reject("--elevated-timer", "enable", ["0", "-"]));
        Assert.Null(BrokerAllowlist.Reject("--elevated-timer", "restore", ["1", "0"]));
        Assert.Null(BrokerAllowlist.Reject("--elevated-optimize", "run", [JsonSerializer.Serialize(new AdminRequest("capture", ["sysmain-off"], null), HelperJson.Options)]));
        Assert.Null(BrokerAllowlist.Reject("--elevated-fps", "capture", ["1234", "2026-10-14T10:00:00.0000000Z", "50"]));
    }

    [Theory]
    [InlineData("--elevated", "restore-create", new[] { @"C:\Windows\x", "0", "1", "1" })] // path-shaped description
    [InlineData("--elevated", "restore-create", new[] { "ok", "2", "1", "1" })]
    [InlineData("--elevated", "restore-enable", new[] { @"C:\" })]
    [InlineData("--elevated", "format-disk", new string[0])]
    [InlineData("--elevated-services", "stop", new[] { @"..\..\evil" })]
    [InlineData("--elevated-services", "stop", new[] { "TermService" })] // not on the Game Mode allowlist
    [InlineData("--elevated-services", "purge", new[] { "SysMain" })]
    [InlineData("--elevated-timer", "enable", new[] { "1", "-" })]
    [InlineData("--elevated-timer", "enable", new[] { "0", "abc" })]
    [InlineData("--elevated-timer", "delete", new[] { "0", "-" })]
    [InlineData("--elevated-optimize", "run", new[] { "not json" })]
    [InlineData("--elevated-optimize", "run", new[] { "{\"command\":\"capture\",\"ids\":[\"mouse-precision\"]}" })] // not an administrator item
    [InlineData("--elevated-optimize", "run", new[] { "{\"command\":\"format\",\"ids\":[\"sysmain-off\"]}" })]
    [InlineData("--elevated-fps", "capture", new[] { "0", "2026-10-14T10:00:00.0000000Z", "50" })]
    [InlineData("--elevated-fps", "capture", new[] { "12", "yesterday", "50" })]
    [InlineData("--elevated-fps", "capture", new[] { @"C:\x.json", "2026-10-14T10:00:00.0000000Z", "50" })]
    [InlineData("--elevated-fps", "capture", new[] { "12", "2026-10-14T10:00:00.0000000Z" })]
    public void BadArgumentsAreRefusedBeforeAnythingRuns(string op, string action, string[] args) =>
        Assert.Equal("invalid-arguments", BrokerAllowlist.Reject(op, action, args));

    [Fact]
    public void OversizedOrNulBearingArgumentsAreRefused()
    {
        Assert.Equal("invalid-arguments", BrokerAllowlist.Reject("--elevated", "restore-list", [new string('a', 24001)]));
        Assert.Equal("invalid-arguments", BrokerAllowlist.Reject("--elevated", "restore-list", ["a\0b"]));
        Assert.Equal("invalid-arguments", BrokerAllowlist.Reject("--elevated", "restore-list", [.. Enumerable.Repeat("a", 65)]));
    }

    // ---- nonce, replay, staleness, rate ----
    [Fact]
    public void GuardRejectsReplayStaleBadNonceAndFlood()
    {
        var now = new DateTime(2026, 10, 15, 12, 0, 0, DateTimeKind.Utc);
        var guard = new RequestGuard(() => now, perMinute: 3);
        var n1 = BrokerProtocol.NewNonce();
        Assert.Null(guard.Check(n1, RequestGuard.Stamp(now)));
        Assert.Equal("replay", guard.Check(n1, RequestGuard.Stamp(now)));
        Assert.Equal("bad-nonce", guard.Check("short", RequestGuard.Stamp(now)));
        Assert.Equal("bad-nonce", guard.Check(null, RequestGuard.Stamp(now)));
        Assert.Equal("stale", guard.Check(BrokerProtocol.NewNonce(), RequestGuard.Stamp(now.AddMinutes(-2))));
        Assert.Equal("stale", guard.Check(BrokerProtocol.NewNonce(), RequestGuard.Stamp(now.AddMinutes(2))));
        Assert.Null(guard.Check(BrokerProtocol.NewNonce(), RequestGuard.Stamp(now)));
        Assert.Null(guard.Check(BrokerProtocol.NewNonce(), RequestGuard.Stamp(now)));
        Assert.Equal("rate-limited", guard.Check(BrokerProtocol.NewNonce(), RequestGuard.Stamp(now)));
        now = now.AddMinutes(2);
        Assert.Null(guard.Check(BrokerProtocol.NewNonce(), RequestGuard.Stamp(now)));
        // A nonce is remembered for five minutes only.
        now = now.AddMinutes(6);
        Assert.Null(guard.Check(n1, RequestGuard.Stamp(now)));
    }

    // ---- who may talk to the broker ----
    [Fact]
    public void OnlyTheApprovingUsersRegisteredHelperIsAdmitted()
    {
        var config = new BrokerConfig(Sid, @"C:\Users\a\AppData\Local\Programs\Frameforge\resources\windows\Frameforge.Windows.exe", "1.4.0", @"C:\Program Files\Frameforge\Broker");
        Assert.Null(ClientPolicy.Reject(new(10, 1, config.ClientImage.ToUpperInvariant(), Sid), config));
        Assert.Equal("other-user", ClientPolicy.Reject(new(10, 1, config.ClientImage, "S-1-5-21-111-222-333-1002"), config));
        Assert.Equal("other-user", ClientPolicy.Reject(new(10, 1, config.ClientImage, null), config));
        Assert.Equal("wrong-image", ClientPolicy.Reject(new(10, 1, @"C:\Temp\evil.exe", Sid), config));
        Assert.Equal("wrong-image", ClientPolicy.Reject(new(10, 1, null, Sid), config));
    }

    [Fact]
    public void PipeAccessIsSystemAdministratorsAndTheOwnerOnly()
    {
        var owner = new SecurityIdentifier(Sid);
        var rules = BrokerPipeSecurity.Build(owner).GetAccessRules(true, false, typeof(SecurityIdentifier)).Cast<PipeAccessRule>().ToList();
        var allowed = rules.Where(r => r.AccessControlType == AccessControlType.Allow).Select(r => (SecurityIdentifier)r.IdentityReference).ToList();
        Assert.Equal(3, allowed.Count);
        Assert.Contains(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), allowed);
        Assert.Contains(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), allowed);
        Assert.Contains(owner, allowed);
        foreach (var broad in new[] { WellKnownSidType.WorldSid, WellKnownSidType.AuthenticatedUserSid, WellKnownSidType.BuiltinUsersSid, WellKnownSidType.InteractiveSid, WellKnownSidType.NetworkSid })
            Assert.DoesNotContain(new SecurityIdentifier(broad, null), allowed);
        var denied = rules.Single(r => r.AccessControlType == AccessControlType.Deny);
        Assert.Equal(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), denied.IdentityReference);
        // The owner can read and write the pipe but not change its permissions or create instances.
        var ownerRule = rules.Single(r => r.IdentityReference.Equals(owner));
        Assert.False(ownerRule.PipeAccessRights.HasFlag(PipeAccessRights.ChangePermissions));
        Assert.False(ownerRule.PipeAccessRights.HasFlag(PipeAccessRights.CreateNewInstance));
    }

    // ---- where the binary lives ----
    [Fact]
    public void ServiceImagePathIsQuotedAndFixed()
    {
        var dir = BrokerPaths.InstallDir(@"C:\Program Files");
        Assert.Equal(@"C:\Program Files\Frameforge\Broker", dir);
        Assert.Equal("\"C:\\Program Files\\Frameforge\\Broker\\Frameforge.Windows.exe\" --broker-service", BrokerPaths.ImagePath(dir));
    }

    [Fact]
    public void BrokerRefusesToRunFromAnywhereButItsInstallFolder()
    {
        var pf = Path.Combine(Path.GetTempPath(), "ff-" + Guid.NewGuid().ToString("N"));
        var install = BrokerPaths.InstallDir(pf);
        Directory.CreateDirectory(install);
        try
        {
            var exe = Path.Combine(install, BrokerPaths.ExeName);
            File.WriteAllText(exe, "x");
            Assert.Null(BrokerPaths.VerifyInstallLocation(exe, pf));
            Assert.Null(BrokerPaths.VerifyInstallLocation(exe.ToUpperInvariant().Replace(pf.ToUpperInvariant(), pf), pf));
            Assert.NotNull(BrokerPaths.VerifyInstallLocation(@"C:\Users\someone\AppData\Local\Programs\Frameforge\resources\windows\Frameforge.Windows.exe", pf));
            Assert.NotNull(BrokerPaths.VerifyInstallLocation(Path.Combine(install, "..", "Other", BrokerPaths.ExeName), pf));
            Assert.NotNull(BrokerPaths.VerifyInstallLocation(Path.Combine(install, "sub", BrokerPaths.ExeName), pf));
        }
        finally { Directory.Delete(pf, true); }
    }

    [Fact]
    public void WritableByOthersFindsEveryNonAdministratorWriter()
    {
        FileSystemAccessRule Rule(SecurityIdentifier sid, FileSystemRights rights, AccessControlType type = AccessControlType.Allow) =>
            new(sid, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, type);
        var users = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var me = new SecurityIdentifier(Sid);
        Assert.Empty(BrokerPaths.WritableByOthers([Rule(system, FileSystemRights.FullControl), Rule(admins, FileSystemRights.FullControl), Rule(users, FileSystemRights.ReadAndExecute)]));
        Assert.Equal([users.Value], BrokerPaths.WritableByOthers([Rule(users, FileSystemRights.Modify)]));
        Assert.Equal([me.Value], BrokerPaths.WritableByOthers([Rule(me, FileSystemRights.WriteData)]));
        Assert.Equal([me.Value], BrokerPaths.WritableByOthers([Rule(me, FileSystemRights.ChangePermissions)]));
        Assert.Empty(BrokerPaths.WritableByOthers([Rule(users, FileSystemRights.Modify, AccessControlType.Deny)]));
    }

    [Fact]
    public void InstallFoldersAreProtectedFromOrdinaryUsers()
    {
        foreach (var usersRead in new[] { true, false })
        {
            var rules = BrokerInstaller.Protected(usersRead).GetAccessRules(true, false, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToList();
            Assert.Empty(BrokerPaths.WritableByOthers(rules));
            Assert.Equal(usersRead, rules.Any(r => r.IdentityReference.Equals(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null))));
            Assert.True(BrokerInstaller.Protected(usersRead).AreAccessRulesProtected);
        }
    }

    [Theory]
    [InlineData("S-1-5-21-111-222-333-1001", true)]
    [InlineData("S-1-12-1-111-222-333-444", true)]
    [InlineData("S-1-5-18", false)]
    [InlineData("S-1-5-32-544", false)]
    [InlineData("S-1-1-0", false)]
    [InlineData("S-1-5-21-111-222-333-500", false)]
    [InlineData("S-1-5-21-111-222-333-513", false)]
    [InlineData("nonsense", false)]
    [InlineData(null, false)]
    public void OwnerMustBeAnOrdinaryAccount(string? sid, bool valid) => Assert.Equal(valid, BrokerPaths.ValidOwnerSid(sid));

    // ---- file copy and signature ----
    [Fact]
    public void CopyVerifiedCopiesEveryFileAndHashesIt()
    {
        var root = Path.Combine(Path.GetTempPath(), "ff-" + Guid.NewGuid().ToString("N"));
        var source = Path.Combine(root, "src");
        var target = Path.Combine(root, "dst");
        Directory.CreateDirectory(Path.Combine(source, "sub"));
        try
        {
            File.WriteAllText(Path.Combine(source, BrokerPaths.ExeName), "exe");
            File.WriteAllText(Path.Combine(source, "sub", "a.dll"), "dll");
            var manifest = BrokerInstaller.CopyVerified(source, target);
            Assert.Equal("dll", File.ReadAllText(Path.Combine(target, "sub", "a.dll")));
            Assert.Contains($"{BrokerInstaller.HashOf(Path.Combine(source, BrokerPaths.ExeName))}  {BrokerPaths.ExeName}", manifest);
            Assert.Equal(2, manifest.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length);
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public void CopyWithoutTheHelperProgramIsRefused()
    {
        var root = Path.Combine(Path.GetTempPath(), "ff-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "src"));
        try
        {
            File.WriteAllText(Path.Combine(root, "src", "a.dll"), "dll");
            Assert.Throws<InvalidOperationException>(() => BrokerInstaller.CopyVerified(Path.Combine(root, "src"), Path.Combine(root, "dst")));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public void AuthenticodeTellsUnsignedFromSigned()
    {
        var file = Path.GetTempFileName();
        try
        {
            File.WriteAllText(file, "not a program");
            Assert.Equal(Signature.Unsigned, Authenticode.Check(file));
        }
        finally { File.Delete(file); }
        Assert.Equal(Signature.Valid, Authenticode.Check(typeof(object).Assembly.Location));
    }

    // ---- status decision ----
    private static BrokerFacts Facts(Func<BrokerFacts, BrokerFacts>? change = null)
    {
        const string helper = @"C:\Users\a\AppData\Local\Programs\Frameforge\resources\windows\Frameforge.Windows.exe";
        var expected = BrokerPaths.ImagePath(@"C:\Program Files\Frameforge\Broker");
        var facts = new BrokerFacts(true, true, expected, new BrokerConfig(Sid, helper, "1.4.0", @"C:\Program Files\Frameforge\Broker"), expected, helper, Sid, "1.4.0", true, "1.4.0");
        return change?.Invoke(facts) ?? facts;
    }
    [Fact]
    public void StatusIsReadyOnlyWhenEverythingChecksOut()
    {
        Assert.Equal("ready", BrokerStatusCheck.Evaluate(Facts()).State);
        Assert.Equal("not-installed", BrokerStatusCheck.Evaluate(Facts(f => f with { ServiceExists = false, Config = null, Running = false })).State);
        Assert.Equal("unhealthy", BrokerStatusCheck.Evaluate(Facts(f => f with { Config = null })).State);
        Assert.Equal("unhealthy", BrokerStatusCheck.Evaluate(Facts(f => f with { ImagePath = "\"C:\\Users\\a\\evil.exe\" --broker-service" })).State);
        Assert.Equal("needs-update", BrokerStatusCheck.Evaluate(Facts(f => f with { UserSid = "S-1-5-21-111-222-333-1002" })).State);
        Assert.Equal("needs-update", BrokerStatusCheck.Evaluate(Facts(f => f with { HelperPath = @"D:\moved\Frameforge.Windows.exe" })).State);
        Assert.Equal("needs-update", BrokerStatusCheck.Evaluate(Facts(f => f with { AppVersion = "1.5.0" })).State);
        Assert.Equal("needs-update", BrokerStatusCheck.Evaluate(Facts(f => f with { BrokerVersion = "1.3.0" })).State);
        Assert.Equal("unhealthy", BrokerStatusCheck.Evaluate(Facts(f => f with { Running = false })).State);
        Assert.Equal("unhealthy", BrokerStatusCheck.Evaluate(Facts(f => f with { PingOk = false })).State);
    }

    // ---- the real pipe, with a fake executor ----
    private sealed class Executor(Func<BrokerJob, Action<string>, CancellationToken, BrokerOutcome> run) : IBrokerExecutor
    {
        public List<BrokerJob> Jobs = [];
        public Task<BrokerOutcome> RunAsync(BrokerJob job, Action<string> line, CancellationToken stop) { Jobs.Add(job); return Task.FromResult(run(job, line, stop)); }
    }
    private sealed class Log : IBrokerLog { public List<string> Lines = []; public void Write(string line) { lock (Lines) Lines.Add(line); } }

    private sealed class Rig : IDisposable
    {
        public readonly string Name = "FrameforgeBrokerTest" + Guid.NewGuid().ToString("N");
        public readonly CancellationTokenSource Stop = new();
        public readonly Log Log = new();
        public readonly Executor Executor;
        private readonly Task loop;
        public Rig(Func<BrokerJob, Action<string>, CancellationToken, BrokerOutcome> run, string? image = null, TimeSpan? busyWait = null)
        {
            Executor = new(run);
            var me = WindowsIdentity.GetCurrent().User!;
            var config = new BrokerConfig(me.Value, image ?? Environment.ProcessPath!, "1.4.0", "x");
            var server = new BrokerServer(config, Executor, Log, busyWait: busyWait);
            var security = BrokerPipeSecurity.Build(me);
            // In the service the creator is SYSTEM (full control); here the creator is the unelevated test user.
            security.AddAccessRule(new PipeAccessRule(me, PipeAccessRights.FullControl, AccessControlType.Allow));
            loop = Task.Run(async () => { try { await server.RunAsync(first => BrokerPipe.Create(Name, security, first), Stop.Token); } catch (OperationCanceledException) { } });
        }
        public NamedPipeClientStream Connect()
        {
            var pipe = new NamedPipeClientStream(".", Name, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
            pipe.Connect(5000);
            return pipe;
        }
        public void Dispose() { Stop.Cancel(); try { loop.Wait(2000); } catch (AggregateException) { } }
    }
    private static BrokerRequest Request(string op, string action, params string[] args) =>
        new(BrokerProtocol.Version, "request", BrokerProtocol.NewNonce(), RequestGuard.Stamp(DateTime.UtcNow), op, action, args);
    private static async Task<BrokerReply> Read(Stream pipe)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        return BrokerProtocol.Parse<BrokerReply>((await BrokerProtocol.ReadAsync(pipe, BrokerProtocol.MaxReplyBytes, timeout.Token))!)!;
    }

    [Fact]
    public async Task PipeAnswersPingAndRunsAnAllowedRequest()
    {
        using var rig = new Rig((job, _, _) => new("ok", "{\"ok\":true,\"message\":\"done\"}"));
        await using var pipe = rig.Connect();
        var ping = new BrokerRequest(BrokerProtocol.Version, "ping", BrokerProtocol.NewNonce());
        await BrokerProtocol.WriteAsync(pipe, ping);
        var pong = await Read(pipe);
        Assert.Equal("pong", pong.Type);
        Assert.Equal(ping.Nonce, pong.Nonce);
        Assert.Equal(Environment.ProcessId, BrokerPipe.ServerPid(pipe));
        var request = Request("--elevated", "restore-list");
        await BrokerProtocol.WriteAsync(pipe, request);
        var result = await Read(pipe);
        Assert.Equal(("result", request.Nonce, "{\"ok\":true,\"message\":\"done\"}"), (result.Type, result.Nonce, result.Text));
        Assert.Equal("--elevated", Assert.Single(rig.Executor.Jobs).Op);
        Assert.Contains(rig.Log.Lines, l => l.Contains("op=--elevated action=restore-list") && l.Contains("result=ok"));
    }

    [Fact]
    public async Task PipeRefusesDisallowedAndReplayedRequestsWithoutRunningAnything()
    {
        using var rig = new Rig((_, _, _) => new("ok", "{}"));
        var bad = Request("--elevated", "restore-create", @"C:\Windows\x", "0", "1", "1");
        await using (var pipe = rig.Connect())
        {
            await BrokerProtocol.WriteAsync(pipe, bad);
            Assert.Equal("invalid-arguments", (await Read(pipe)).Code);
        }
        await using (var pipe = rig.Connect())
        {
            await BrokerProtocol.WriteAsync(pipe, Request("rundll32.exe", "x"));
            Assert.Equal("not-allowed", (await Read(pipe)).Code);
        }
        var good = Request("--elevated", "restore-list");
        await using (var pipe = rig.Connect())
        {
            await BrokerProtocol.WriteAsync(pipe, good);
            Assert.Equal("result", (await Read(pipe)).Type);
        }
        await using (var pipe = rig.Connect())
        {
            await BrokerProtocol.WriteAsync(pipe, good);
            Assert.Equal("replay", (await Read(pipe)).Code);
        }
        await using (var pipe = rig.Connect())
        {
            await BrokerProtocol.WriteAsync(pipe, good with { Nonce = BrokerProtocol.NewNonce(), Ts = RequestGuard.Stamp(DateTime.UtcNow.AddMinutes(-10)) });
            Assert.Equal("stale", (await Read(pipe)).Code);
        }
        Assert.Single(rig.Executor.Jobs);
    }

    [Fact]
    public async Task PipeRefusesAClientThatIsNotTheRegisteredHelper()
    {
        using var rig = new Rig((_, _, _) => new("ok", "{}"), image: @"C:\Somewhere\else\Frameforge.Windows.exe");
        await using var pipe = rig.Connect();
        await BrokerProtocol.WriteAsync(pipe, Request("--elevated", "restore-list"));
        Assert.Equal("wrong-image", (await Read(pipe)).Code);
        Assert.Empty(rig.Executor.Jobs);
    }

    [Fact]
    public async Task PipeRejectsOversizedFramesAndRunsOneOperationAtATime()
    {
        using var rig = new Rig((_, _, _) => { Thread.Sleep(800); return new("ok", "{}"); });
        await using (var pipe = rig.Connect())
        {
            await pipe.WriteAsync(BitConverter.GetBytes(BrokerProtocol.MaxRequestBytes + 1));
            await pipe.FlushAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            Assert.Null(await BrokerProtocol.ReadAsync(pipe, BrokerProtocol.MaxReplyBytes, timeout.Token).ContinueWith(t => t.IsCompletedSuccessfully ? t.Result : null));
        }
        var started = DateTime.UtcNow;
        async Task One()
        {
            await using var pipe = rig.Connect();
            await BrokerProtocol.WriteAsync(pipe, Request("--elevated", "restore-list"));
            Assert.Equal("result", (await Read(pipe)).Type);
        }
        await Task.WhenAll(One(), One());
        Assert.True(DateTime.UtcNow - started >= TimeSpan.FromMilliseconds(1500), "the two operations overlapped");
    }

    [Fact]
    public async Task CaptureReplacesTheParentWithThePipeClientAndStopsOnRequest()
    {
        using var rig = new Rig((job, line, stop) =>
        {
            line("{\"event\":\"ready\"}");
            stop.WaitHandle.WaitOne(5000);
            line("{\"event\":\"ended\",\"reason\":\"stop\"}");
            return new("ok");
        });
        await using var pipe = rig.Connect();
        await BrokerProtocol.WriteAsync(pipe, Request("--elevated-fps", "capture", "1234", "2026-10-14T10:00:00.0000000Z", "50"));
        Assert.Equal("{\"event\":\"ready\"}", (await Read(pipe)).Text);
        await BrokerProtocol.WriteAsync(pipe, new BrokerRequest(BrokerProtocol.Version, "stop"));
        Assert.Contains("ended", (await Read(pipe)).Text);
        Assert.Equal("end", (await Read(pipe)).Type);
    }

    // ---- the helper side: routing, fallback, fail closed ----
    private sealed class Uac(IElevatedChild? child = null) : IElevatedLauncher
    {
        public int Starts;
        public IElevatedChild? Start(IReadOnlyList<string> arguments) { Starts++; return child; }
    }

    [Fact]
    public void WithoutABrokerTheUacLauncherRunsAsBefore()
    {
        var uac = new Uac();
        var launcher = new BrokerAwareLauncher(() => null, uac, () => false);
        launcher.Start(["--elevated-services", "stop", "x.json", "SysMain"]);
        Assert.Equal(1, uac.Starts);
    }

    [Fact]
    public void BackgroundWorkFailsClosedInsteadOfPrompting()
    {
        var uac = new Uac();
        var launcher = new BrokerAwareLauncher(() => null, uac, () => true);
        Assert.Null(launcher.Start(["--elevated-services", "stop", "x.json", "SysMain"]));
        Assert.Null(launcher.Start(["--elevated-broker", "install", "x.json", Sid]));
        Assert.Equal(0, uac.Starts);
    }

    [Fact]
    public void ThingsOutsideTheAllowlistNeverGoToTheBroker()
    {
        var uac = new Uac();
        var asked = 0;
        var launcher = new BrokerAwareLauncher(() => { asked++; return null; }, uac, () => false);
        launcher.Start(["--elevated-broker", "install", "x.json", Sid]);
        Assert.Equal((1, 0), (uac.Starts, asked));
    }

    private static string ResultFile()
    {
        var path = Path.Combine(Path.GetTempPath(), $"frameforge-{Guid.NewGuid():N}.json");
        File.WriteAllBytes(path, []);
        ElevationRequest.Create(path, TimeSpan.FromSeconds(60));
        return path;
    }

    [Fact]
    public async Task BrokerRoutedRequestFillsTheResultFileAndDoesNotPrompt()
    {
        using var rig = new Rig((_, _, _) => new("ok", "{\"ok\":true,\"message\":\"routed\"}"));
        var uac = new Uac();
        var result = ResultFile();
        try
        {
            var launcher = new BrokerAwareLauncher(rig.Connect, uac, () => false);
            using var child = launcher.Start(["--elevated", "restore-list", result])!;
            Assert.True(child.WaitForExit(TimeSpan.FromSeconds(10)));
            Assert.Equal(0, child.ExitCode);
            Assert.Equal("{\"ok\":true,\"message\":\"routed\"}", File.ReadAllText(result));
            Assert.Equal(0, uac.Starts);
            await Task.CompletedTask;
        }
        finally { ElevationRequest.Withdraw(result); File.Delete(result); }
    }

    [Fact]
    public void AWithdrawnRequestSendsNothing()
    {
        using var rig = new Rig((_, _, _) => new("ok", "{}"));
        var result = ResultFile();
        try
        {
            ElevationRequest.Withdraw(result);
            using var child = new BrokerAwareLauncher(rig.Connect, new Uac(), () => false).Start(["--elevated", "restore-list", result])!;
            Assert.True(child.WaitForExit(TimeSpan.FromSeconds(10)));
            Assert.Equal(ElevationRequest.NotFreshExitCode, child.ExitCode);
            Assert.Empty(rig.Executor.Jobs);
        }
        finally { File.Delete(result); }
    }

    [Fact]
    public void ARefusalMapsToTheRejectedExitCode()
    {
        using var rig = new Rig((_, _, _) => new("ok", "{}"));
        var result = ResultFile();
        try
        {
            // A request the broker's own allowlist refuses (the helper already validated, so this is a version mismatch in practice).
            using var child = new BrokerAwareLauncher(rig.Connect, new Uac(), () => false).Start(["--elevated", "format-disk", result])!;
            Assert.True(child.WaitForExit(TimeSpan.FromSeconds(10)));
            Assert.Equal(2, child.ExitCode);
        }
        finally { ElevationRequest.Withdraw(result); File.Delete(result); }
    }

    [Fact]
    public void AConnectionThatBreaksAfterSendingIsNeverRepeatedThroughAPrompt()
    {
        using var rig = new Rig((_, _, _) => new("timeout"));
        var uac = new Uac();
        var result = ResultFile();
        try
        {
            using var child = new BrokerAwareLauncher(rig.Connect, uac, () => false).Start(["--elevated-services", "stop", result, "SysMain"])!;
            // The broker answered "timeout": the step may have run, so the caller is told it did not finish and nothing is retried.
            Assert.False(child.WaitForExit(TimeSpan.FromSeconds(10)));
            Assert.Equal(0, uac.Starts);
        }
        finally { ElevationRequest.Withdraw(result); File.Delete(result); }
    }

    [Fact]
    public void FramesRoundTripAndRefuseBadLengths()
    {
        var stream = new MemoryStream();
        BrokerProtocol.WriteAsync(stream, new BrokerReply(1, "pong", "n")).GetAwaiter().GetResult();
        stream.Position = 0;
        Assert.Equal("pong", BrokerProtocol.Parse<BrokerReply>(BrokerProtocol.ReadAsync(stream, 1000).GetAwaiter().GetResult()!)!.Type);
        Assert.Null(BrokerProtocol.ReadAsync(stream, 1000).GetAwaiter().GetResult());
        foreach (var length in new[] { 0, -1, 1001 })
        {
            var bad = new MemoryStream(BitConverter.GetBytes(length));
            Assert.ThrowsAsync<InvalidDataException>(() => BrokerProtocol.ReadAsync(bad, 1000)).GetAwaiter().GetResult();
        }
        Assert.ThrowsAsync<InvalidDataException>(() => BrokerProtocol.ReadAsync(new MemoryStream([5, 0, 0, 0, 1]), 1000)).GetAwaiter().GetResult();
        Assert.Null(BrokerProtocol.Parse<BrokerRequest>(Encoding.UTF8.GetBytes("{\"v\":1,\"type\":\"request\",\"extra\":1}")));
    }

    // ---- security-lowering items never use the broker ----
    private static string OptimizeJson(string command, params string[] ids) => JsonSerializer.Serialize(new AdminRequest(command, ids, null), HelperJson.Options);

    [Fact]
    public void EverySecurityItemIsRefusedByTheBrokerForEveryCommand()
    {
        Assert.NotEmpty(OptimizationTable.Security);
        foreach (var id in OptimizationTable.Security)
        {
            foreach (var command in BrokerAllowlist.OptimizeCommands)
            {
                Assert.Equal("not-allowed", BrokerAllowlist.Reject("--elevated-optimize", "run", [OptimizeJson(command, id)]));
                // One security item inside an otherwise fine batch taints the whole request.
                Assert.Equal("not-allowed", BrokerAllowlist.Reject("--elevated-optimize", "run", [OptimizeJson(command, "sysmain-off", id)]));
            }
        }
        Assert.Null(BrokerAllowlist.Reject("--elevated-optimize", "run", [OptimizeJson("apply", "sysmain-off")]));
    }

    [Fact]
    public void ABrokerChildRefusesSecurityItemsAgain()
    {
        foreach (var id in OptimizationTable.Security)
        {
            var result = ResultFile();
            try
            {
                var code = WindowsAdminGateway.RunChild(["run", result, OptimizeJson("apply", id)], v => JsonSerializer.Serialize(v, HelperJson.Options), viaBroker: true);
                Assert.Equal(0, code);
                var reply = JsonSerializer.Deserialize<AdminReply>(File.ReadAllText(result), HelperJson.Options)!;
                Assert.False(reply.Ok);
                Assert.Contains("own Windows approval", reply.Message);
            }
            finally { ElevationRequest.Withdraw(result); File.Delete(result); }
        }
    }

    [Fact]
    public void SecurityItemsGoToTheWindowsPromptEvenWhenTheBrokerIsReady()
    {
        var connected = 0;
        var uac = new Uac();
        var launcher = ElevatedLaunchers.ForOptimize(["sysmain-off", "uac-off"], () => { connected++; return null; }, uac);
        launcher.Start(["--elevated-optimize", "run", "x.json", "{}"]);
        Assert.Equal((1, 0), (uac.Starts, connected));
        // Other items still try the broker first.
        ElevatedLaunchers.ForOptimize(["sysmain-off"], () => { connected++; return null; }, uac).Start(["--elevated-optimize", "run", "x.json", "{}"]);
        Assert.Equal(1, connected);
    }

    [Fact]
    public void SecurityItemsDoNothingInBackgroundBrokerOnlyMode()
    {
        ElevatedLaunchers.BrokerOnly = true;
        try
        {
            var uac = new Uac();
            Assert.Null(ElevatedLaunchers.ForOptimize(["defender-off"], () => null, uac).Start(["--elevated-optimize", "run", "x.json", "{}"]));
            Assert.Equal(0, uac.Starts);
        }
        finally { ElevatedLaunchers.BrokerOnly = false; }
    }

    // ---- rate and replay are tracked per client ----
    [Fact]
    public void OneNoisyProcessCannotStarveAnother()
    {
        var now = new DateTime(2026, 10, 15, 12, 0, 0, DateTimeKind.Utc);
        var guard = new RequestGuard(() => now, perMinute: 2);
        ClientInfo Client(int pid) => new(pid, 1, "x", Sid);
        string? Ask(int pid) => guard.Check(BrokerProtocol.NewNonce(), RequestGuard.Stamp(now), Client(pid));
        Assert.Null(Ask(10));
        Assert.Null(Ask(10));
        Assert.Equal("rate-limited", Ask(10));
        Assert.Null(Ask(11));
        Assert.Null(Ask(11));
        // The account as a whole is capped at four times the per-process limit.
        Assert.Null(Ask(12));
        Assert.Null(Ask(12));
        Assert.Null(Ask(13));
        Assert.Null(Ask(13));
        Assert.Equal("rate-limited", Ask(14));
    }

    [Fact]
    public void ANonceIsAReplayEvenFromAnotherProcessOfTheSameAccountAndTheMemoryIsCapped()
    {
        var now = new DateTime(2026, 10, 15, 12, 0, 0, DateTimeKind.Utc);
        var guard = new RequestGuard(() => now, perMinute: 100000);
        var nonce = BrokerProtocol.NewNonce();
        Assert.Null(guard.Check(nonce, RequestGuard.Stamp(now), new(10, 1, "x", Sid)));
        Assert.Equal("replay", guard.Check(nonce, RequestGuard.Stamp(now), new(11, 1, "x", Sid)));
        for (var i = 0; i < RequestGuard.MaxRemembered + 50; i++)
        {
            now = now.AddMilliseconds(1);
            Assert.Null(guard.Check(BrokerProtocol.NewNonce(), RequestGuard.Stamp(now), new(10, 1, "x", Sid)));
        }
        // The oldest nonces fell out of the capped memory; this is bounded, not unbounded growth.
        Assert.Null(guard.Check(nonce, RequestGuard.Stamp(now), new(10, 1, "x", Sid)));
    }

    // ---- log retention ----
    [Fact]
    public void TheLogKeepsThreeRotations()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ff-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var path = Path.Combine(dir, "broker.log");
            var log = new BrokerFileLog(path) { MaxBytes = 100 };
            for (var round = 1; round <= 6; round++) log.Write($"round-{round} " + new string('x', 120));
            Assert.Contains("round-6", File.ReadAllText(path));
            Assert.Contains("round-5", File.ReadAllText(path + ".1"));
            Assert.Contains("round-4", File.ReadAllText(path + ".2"));
            Assert.Contains("round-3", File.ReadAllText(path + ".3"));
            Assert.False(File.Exists(path + ".4"));
        }
        finally { Directory.Delete(dir, true); }
    }

    // ---- a busy broker never leaks a stale result to a background caller ----
    [Fact]
    public async Task ABusyBrokerGivesBackgroundWorkARefusalAndNeverAResultFileRead()
    {
        var release = new ManualResetEventSlim();
        using var rig = new Rig((_, _, _) => { release.Wait(10000); return new("ok", "{\"ok\":true,\"message\":\"first\"}"); }, busyWait: TimeSpan.FromMilliseconds(200));
        await using var first = rig.Connect();
        await BrokerProtocol.WriteAsync(first, Request("--elevated", "restore-list"));
        SpinWait.SpinUntil(() => rig.Executor.Jobs.Count == 1, 5000);
        ElevatedLaunchers.BrokerOnly = true;
        try
        {
            var uac = new Uac();
            var launcher = new BrokerAwareLauncher(rig.Connect, uac, () => true);
            var outcome = ElevatedCall.Run(launcher, "--elevated", "restore-list", [], TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10), default);
            // Refused before anything ran: not "Done", no text from the (empty) result file, and no prompt.
            Assert.Equal(ElevationStatus.Rejected, outcome.Status);
            Assert.Null(outcome.Text);
            Assert.Equal(0, uac.Starts);
            Assert.Single(rig.Executor.Jobs);
        }
        finally { ElevatedLaunchers.BrokerOnly = false; release.Set(); }
        Assert.Contains("first", (await Read(first)).Text);
    }
}
