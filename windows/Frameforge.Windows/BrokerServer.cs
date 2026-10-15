using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Frameforge.Windows;

public interface IBrokerLog { void Write(string line); }

// Admin-only log in %ProgramData%\Frameforge\Broker. One line per request: who (pid, token user), what (operation and action, argument
// count) and how it ended. Argument values are never written: they can hold names the user typed.
public sealed class BrokerFileLog(string path) : IBrokerLog
{
    private readonly object gate = new();
    public void Write(string line)
    {
        lock (gate)
        {
            try
            {
                var info = new FileInfo(path);
                if (info.Exists && info.Length > 1024 * 1024) File.Move(path, path + ".1", true);
                File.AppendAllText(path, $"{DateTime.UtcNow:O} {line}{Environment.NewLine}", Encoding.UTF8);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { /* Logging never stops a request. */ }
        }
    }
}

public sealed record BrokerJob(string Op, string Action, string[] Args, int ClientPid);
// Code: "ok", "rejected" (the child refused its result file), "not-fresh", "timeout" or "failed".
public sealed record BrokerOutcome(string Code, string? Text = null);

public interface IBrokerExecutor
{
    // line receives each JSON line of a streaming operation (frame capture). stop ends a stream early.
    Task<BrokerOutcome> RunAsync(BrokerJob job, Action<string> line, CancellationToken stop);
}

public static class BrokerPipeSecurity
{
    // SYSTEM and Administrators may open the pipe; so may the one person who approved the install. Everyone else, and anything
    // arriving over the network, is refused by Windows before a byte is read.
    public static PipeSecurity Build(SecurityIdentifier owner)
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(owner, PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
        return security;
    }
}

public static class BrokerPipe
{
    private const uint Duplex = 3, Overlapped = 0x40000000, FirstInstance = 0x00080000, RejectRemote = 8, MaxInstances = 16;
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBuffer, uint inBuffer, uint timeout, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);

    // The very first instance of the name asks Windows to fail if anyone created the name before; the service then does not start
    // and nothing can pretend to be the broker through a name that existed first.
    public static NamedPipeServerStream Create(string name, PipeSecurity security, bool first)
    {
        var descriptor = security.GetSecurityDescriptorBinaryForm();
        var memory = Marshal.AllocHGlobal(descriptor.Length);
        try
        {
            Marshal.Copy(descriptor, 0, memory, descriptor.Length);
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = memory };
            var handle = CreateNamedPipeW(@"\\.\pipe\" + name, Duplex | Overlapped | (first ? FirstInstance : 0), RejectRemote, MaxInstances, 65536, 65536, 0, ref attributes);
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
        }
        finally { Marshal.FreeHGlobal(memory); }
    }
    public static int ClientPid(NamedPipeServerStream pipe) => GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var pid) ? (int)pid : 0;
    public static int ServerPid(PipeStream pipe) => GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var pid) ? (int)pid : 0;

    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ProcessIdToSessionId(uint pid, out uint session);
    public static string? ImagePath(int pid)
    {
        var process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (process == IntPtr.Zero) return null;
        try
        {
            var name = new StringBuilder(1024);
            var size = (uint)name.Capacity;
            return QueryFullProcessImageNameW(process, 0, name, ref size) ? name.ToString() : null;
        }
        finally { CloseHandle(process); }
    }
    public static int Session(int pid) => ProcessIdToSessionId((uint)pid, out var session) ? (int)session : -1;
    // The token user of this connection (not of a pid that may be reused): the server impersonates at identification level only.
    public static string? ClientSid(NamedPipeServerStream pipe)
    {
        try
        {
            string? sid = null;
            pipe.RunAsClient(() => sid = WindowsIdentity.GetCurrent(TokenAccessLevels.Query).User?.Value);
            return sid;
        }
        catch (Exception error) when (error is IOException or InvalidOperationException) { return null; }
    }
}

// One conversation per connection: any number of pings (at most three), then one request. The broker runs one mutating operation at a
// time (the same one-at-a-time rule the app's elevation gate keeps) and one frame capture at a time.
public sealed class BrokerServer(BrokerConfig config, IBrokerExecutor executor, IBrokerLog log, RequestGuard? guard = null)
{
    private readonly RequestGuard guard = guard ?? new RequestGuard();
    private readonly SemaphoreSlim mutating = new(1, 1), capture = new(1, 1);
    public static readonly TimeSpan FirstFrameWait = TimeSpan.FromSeconds(5), BusyWait = TimeSpan.FromSeconds(15);

    // Anything the executor does not finish in time is reported as a timeout; the operation's own process is killed by the executor.
    public async Task HandleAsync(Stream pipe, ClientInfo client, CancellationToken cancel)
    {
        async Task Fail(string code, string? nonce = null)
        {
            try { await BrokerProtocol.WriteAsync(pipe, new BrokerReply(BrokerProtocol.Version, "error", nonce, false, code), cancel).ConfigureAwait(false); }
            catch (Exception error) when (error is IOException or ObjectDisposedException or OperationCanceledException) { }
        }
        if (ClientPolicy.Reject(client, config) is { } denied)
        {
            log.Write($"pid={client.Pid} refused client: {denied}");
            await Fail(denied).ConfigureAwait(false);
            return;
        }
        try
        {
            BrokerRequest? request = null;
            for (var pings = 0; ; pings++)
            {
                using var wait = CancellationTokenSource.CreateLinkedTokenSource(cancel);
                wait.CancelAfter(FirstFrameWait);
                byte[]? frame;
                try { frame = await BrokerProtocol.ReadAsync(pipe, BrokerProtocol.MaxRequestBytes, wait.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) when (!cancel.IsCancellationRequested) { return; }
                if (frame is null) return;
                request = BrokerProtocol.Parse<BrokerRequest>(frame);
                if (request is null || request.V != BrokerProtocol.Version) { await Fail("bad-request").ConfigureAwait(false); return; }
                if (request.Type != "ping") break;
                if (pings >= 3 || !RequestGuard.ValidNonce(request.Nonce)) { await Fail("bad-request", request.Nonce).ConfigureAwait(false); return; }
                await BrokerProtocol.WriteAsync(pipe, new BrokerReply(BrokerProtocol.Version, "pong", request.Nonce, Pid: Environment.ProcessId, Version: BrokerProtocol.AppVersion), cancel).ConfigureAwait(false);
            }
            if (request is not { Type: "request" }) { await Fail("bad-request", request?.Nonce).ConfigureAwait(false); return; }
            var rejected = guard.Check(request.Nonce, request.Ts) ?? BrokerAllowlist.Reject(request.Op, request.Action, request.Args);
            if (rejected is not null)
            {
                log.Write($"pid={client.Pid} sid={client.Sid} op={Clip(request.Op)} action={Clip(request.Action)} refused: {rejected}");
                await Fail(rejected, request.Nonce).ConfigureAwait(false);
                return;
            }
            await RunAsync(pipe, client, request, cancel).ConfigureAwait(false);
        }
        catch (Exception error) when (error is InvalidDataException or IOException or ObjectDisposedException or OperationCanceledException)
        {
            log.Write($"pid={client.Pid} connection ended: {error.GetType().Name}");
        }
    }
    private static string Clip(string? text) => text is null ? "-" : new string([.. text.Where(c => char.IsAsciiLetterOrDigit(c) || c == '-').Take(32)]);

    private async Task RunAsync(Stream pipe, ClientInfo client, BrokerRequest request, CancellationToken cancel)
    {
        var streaming = request.Op == "--elevated-fps";
        var slot = streaming ? capture : mutating;
        if (!await slot.WaitAsync(BusyWait, cancel).ConfigureAwait(false))
        {
            log.Write($"pid={client.Pid} op={request.Op} refused: busy");
            await BrokerProtocol.WriteAsync(pipe, new BrokerReply(BrokerProtocol.Version, "error", request.Nonce, false, "busy"), cancel).ConfigureAwait(false);
            return;
        }
        var clock = Stopwatch.StartNew();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        try
        {
            // A capture ends when the client says "stop" or goes away. Other operations always run to completion: killing a half-applied change is worse.
            Task? listener = null;
            if (streaming)
                listener = Task.Run(async () =>
                {
                    try { while (await BrokerProtocol.ReadAsync(pipe, BrokerProtocol.MaxRequestBytes, stop.Token).ConfigureAwait(false) is { } frame) if (BrokerProtocol.Parse<BrokerRequest>(frame)?.Type == "stop") break; }
                    catch (Exception error) when (error is IOException or InvalidDataException or ObjectDisposedException or OperationCanceledException) { }
                    try { stop.Cancel(); } catch (ObjectDisposedException) { }
                });
            // One writer, in order: lines of a capture and then the closing frame.
            var outgoing = System.Threading.Channels.Channel.CreateUnbounded<BrokerReply>();
            var writer = Task.Run(async () =>
            {
                await foreach (var reply in outgoing.Reader.ReadAllAsync(cancel).ConfigureAwait(false)) await BrokerProtocol.WriteAsync(pipe, reply, cancel).ConfigureAwait(false);
            }, CancellationToken.None);
            BrokerOutcome outcome;
            try
            {
                outcome = await executor.RunAsync(new BrokerJob(request.Op!, request.Action!, request.Args!, client.Pid),
                    text => outgoing.Writer.TryWrite(new BrokerReply(BrokerProtocol.Version, "line", request.Nonce, Text: text)), streaming ? stop.Token : CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception error) when (error is Win32Exception or InvalidOperationException or IOException or UnauthorizedAccessException) { outcome = new("failed"); }
            log.Write($"pid={client.Pid} sid={client.Sid} op={request.Op} action={Clip(request.Action)} args={request.Args!.Length} result={outcome.Code} ms={clock.ElapsedMilliseconds}");
            outgoing.Writer.TryWrite(outcome.Code == "ok"
                ? new BrokerReply(BrokerProtocol.Version, streaming ? "end" : "result", request.Nonce, true, "ok", streaming ? null : outcome.Text)
                : new BrokerReply(BrokerProtocol.Version, "error", request.Nonce, false, outcome.Code));
            outgoing.Writer.Complete();
            await writer.ConfigureAwait(false);
            stop.Cancel();
            if (listener is not null) await listener.ConfigureAwait(false);
        }
        finally { slot.Release(); }
    }

    // Accepts connections until cancelled. createPipe(first) returns a new server instance of the pipe.
    public async Task RunAsync(Func<bool, NamedPipeServerStream> createPipe, CancellationToken cancel)
    {
        using var live = new SemaphoreSlim(12);
        for (var first = true; !cancel.IsCancellationRequested; first = false)
        {
            await live.WaitAsync(cancel).ConfigureAwait(false);
            var pipe = createPipe(first);
            try { await pipe.WaitForConnectionAsync(cancel).ConfigureAwait(false); }
            catch { pipe.Dispose(); live.Release(); throw; }
            _ = Task.Run(async () =>
            {
                try
                {
                    var pid = BrokerPipe.ClientPid(pipe);
                    var info = new ClientInfo(pid, BrokerPipe.Session(pid), pid > 0 ? BrokerPipe.ImagePath(pid) : null, BrokerPipe.ClientSid(pipe));
                    await HandleAsync(pipe, info, cancel).ConfigureAwait(false);
                }
                catch (Exception error) { log.Write($"connection failed: {error.GetType().Name}"); }
                finally { pipe.Dispose(); live.Release(); }
            }, CancellationToken.None);
        }
    }
}

// Starts the helper's own elevated child (this same exe, from the install directory) with a result file and request file that the broker
// creates under a directory only SYSTEM and Administrators can write. Nothing the client sent is used as a path.
public sealed class ChildExecutor(string exe, string runDirectory, IBrokerLog log) : IBrokerExecutor
{
    private static readonly Dictionary<string, TimeSpan> Budgets = new()
    {
        ["--elevated"] = TimeSpan.FromSeconds(140), ["--elevated-services"] = TimeSpan.FromSeconds(190), ["--elevated-timer"] = TimeSpan.FromSeconds(25),
        ["--elevated-optimize"] = TimeSpan.FromSeconds(140), ["--elevated-fps"] = FpsChild.HardLimit + TimeSpan.FromMinutes(1)
    };
    public async Task<BrokerOutcome> RunAsync(BrokerJob job, Action<string> line, CancellationToken stop)
    {
        var budget = Budgets[job.Op];
        var resultPath = WindowsServiceElevator.NewResultPath(runDirectory);
        try
        {
            ElevationRequest.Create(resultPath, TimeSpan.FromSeconds(30));
            var info = new ProcessStartInfo { FileName = exe, UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
            info.ArgumentList.Add(job.Op);
            info.ArgumentList.Add(job.Action);
            info.ArgumentList.Add(resultPath);
            // The capture's "parent" is the pipe client itself: it ends when that helper ends.
            foreach (var (argument, index) in job.Args.Select((a, i) => (a, i))) info.ArgumentList.Add(job.Op == "--elevated-fps" && index == 2 ? job.ClientPid.ToString(System.Globalization.CultureInfo.InvariantCulture) : argument);
            using var process = Process.Start(info) ?? throw new InvalidOperationException("The administrator step could not start.");
            if (job.Op == "--elevated-fps") return await Tail(process, resultPath, line, stop, budget).ConfigureAwait(false);
            using var timeout = new CancellationTokenSource(budget);
            try { await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false); }
            catch (OperationCanceledException)
            {
                try { process.Kill(true); } catch (Exception error) when (error is InvalidOperationException or Win32Exception) { }
                log.Write($"{job.Op} timed out and was ended");
                return new("timeout");
            }
            return process.ExitCode switch
            {
                0 => new("ok", await File.ReadAllTextAsync(resultPath, Encoding.UTF8).ConfigureAwait(false)),
                ElevationRequest.NotFreshExitCode => new("not-fresh"),
                2 => new("rejected"),
                _ => new("failed")
            };
        }
        finally
        {
            ElevationRequest.Withdraw(resultPath);
            RestoreCommands.TryDelete(FpsChild.StopFile(resultPath));
            RestoreCommands.TryDelete(resultPath);
        }
    }

    // The capture child appends one JSON line at a time; relay complete lines until it ends, the client stops, or the budget runs out.
    private static async Task<BrokerOutcome> Tail(Process process, string resultPath, Action<string> line, CancellationToken stop, TimeSpan budget)
    {
        using var file = new FileStream(resultPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var pending = new StringBuilder();
        var buffer = new byte[16384];
        var decoder = Encoding.UTF8.GetDecoder();
        var clock = Stopwatch.StartNew();
        var stopFile = FpsChild.StopFile(resultPath);
        var stopped = false;
        while (true)
        {
            int read;
            while ((read = file.Read(buffer, 0, buffer.Length)) > 0)
            {
                var chars = new char[decoder.GetCharCount(buffer, 0, read)];
                pending.Append(chars, 0, decoder.GetChars(buffer, 0, read, chars, 0));
                if (pending.Length > 1_000_000) pending.Clear();
            }
            for (int cut; (cut = IndexOf(pending)) >= 0;)
            {
                var text = pending.ToString(0, cut).Trim();
                pending.Remove(0, cut + 1);
                if (text.Length is > 0 and <= 65536) line(text);
            }
            if (process.HasExited) return new(process.ExitCode switch { 0 => "ok", ElevationRequest.NotFreshExitCode => "not-fresh", 2 => "rejected", _ => "failed" });
            if ((stop.IsCancellationRequested || clock.Elapsed > budget) && !stopped) { stopped = true; File.WriteAllBytes(stopFile, []); clock.Restart(); budget = TimeSpan.FromSeconds(6); }
            // The child ends within a second of the stop file; after six seconds it is ended.
            if (stopped && clock.Elapsed > budget) { try { process.Kill(true); } catch (Exception error) when (error is InvalidOperationException or Win32Exception) { } return new("ok"); }
            await Task.Delay(100, CancellationToken.None).ConfigureAwait(false);
        }
    }
    private static int IndexOf(StringBuilder text) { for (var i = 0; i < text.Length; i++) if (text[i] == '\n') return i; return -1; }
}

// Runs the pipe server inside the Windows service. Refuses to start unless it is the exact exe in the admin-only install folder and
// the HKLM configuration written at install time is present.
public sealed class BrokerService : ServiceBase
{
    private CancellationTokenSource? cancel;
    private Task? loop;
    public BrokerService() { ServiceName = BrokerProtocol.ServiceName; CanStop = true; AutoLog = false; }
    public static string DataDirectory => BrokerPaths.DataDir(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData));
    protected override void OnStart(string[] args)
    {
        var log = new BrokerFileLog(Path.Combine(DataDirectory, "broker.log"));
        try
        {
            var denied = BrokerPaths.VerifyInstallLocation(Environment.ProcessPath ?? "", Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));
            if (denied is not null) throw new InvalidOperationException(denied);
            var config = BrokerConfig.Load() ?? throw new InvalidOperationException("The broker is not configured.");
            if (!BrokerPaths.ValidOwnerSid(config.OwnerSid)) throw new InvalidOperationException("The configured owner is not an ordinary account.");
            var run = Path.Combine(DataDirectory, "run");
            BrokerInstaller.ProtectDirectory(run);
            var server = new BrokerServer(config, new ChildExecutor(Environment.ProcessPath!, run, log), log);
            var security = BrokerPipeSecurity.Build(new SecurityIdentifier(config.OwnerSid));
            cancel = new CancellationTokenSource();
            loop = Task.Run(async () =>
            {
                try { await server.RunAsync(first => BrokerPipe.Create(BrokerProtocol.PipeName, security, first), cancel.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) { }
                catch (Exception error) { log.Write($"server stopped: {error.GetType().Name} {error.Message}"); Environment.Exit(1); }
            });
            log.Write($"broker {BrokerProtocol.AppVersion} started for {config.OwnerSid}");
        }
        catch (Exception error)
        {
            log.Write($"broker refused to start: {error.Message}");
            throw;
        }
    }
    protected override void OnStop()
    {
        cancel?.Cancel();
        try { loop?.Wait(TimeSpan.FromSeconds(5)); } catch (AggregateException) { }
    }
}
