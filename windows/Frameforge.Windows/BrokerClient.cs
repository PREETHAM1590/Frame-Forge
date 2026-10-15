using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32;

namespace Frameforge.Windows;

// The helper's side of "approve admin once". Every place that used to start an elevated child with a UAC prompt now asks
// ElevatedLaunchers.Default(): if the broker is installed, running, registered to this user and this helper, and answers on a pipe
// that its own service process owns, the request goes there; otherwise (and only before anything was sent) the old UAC launcher runs.
public static class ElevatedLaunchers
{
    // Set for background work (auto-boost, startup recovery): when the broker is not usable the step fails ("could not start")
    // instead of falling back to a prompt the person did not ask for.
    public static volatile bool BrokerOnly;
    public static IElevatedLauncher Default() => new BrokerAwareLauncher(BrokerLocal.ConnectReady, new WindowsElevatedLauncher(), () => BrokerOnly);
}

public sealed class BrokerAwareLauncher(Func<Stream?> connect, IElevatedLauncher uac, Func<bool> brokerOnly, Func<DateTime>? clock = null) : IElevatedLauncher
{
    // arguments: flag, action, result file, then the action's own arguments (exactly what the UAC child would get).
    public IElevatedChild? Start(IReadOnlyList<string> arguments)
    {
        var routed = arguments.Count >= 3 && BrokerAllowlist.Ops.Contains(arguments[0], StringComparer.Ordinal);
        if (!routed) return brokerOnly() ? null : uac.Start(arguments);
        var pipe = connect();
        if (pipe is null) return brokerOnly() ? null : uac.Start(arguments);
        var request = new BrokerRequest(BrokerProtocol.Version, "request", BrokerProtocol.NewNonce(), RequestGuard.Stamp((clock ?? (() => DateTime.UtcNow))()), arguments[0], arguments[1], [.. arguments.Skip(3)]);
        return new BrokerChild(pipe, request, arguments[2]);
    }
}

// Looks like the process the UAC launcher started: it finishes when the broker's answer is in the result file, and its exit code is
// 0 (answered), 2 (refused before anything ran) or 3 (the request was no longer fresh). A connection that breaks after the request
// was sent has no exit code: the step may have run, so it is never repeated through a prompt and the caller says "check before retrying".
public sealed class BrokerChild : IElevatedChild
{
    private readonly Task<int?> done;
    private readonly bool streaming;
    private static readonly string[] Refused = ["not-allowed", "invalid-arguments", "bad-nonce", "stale", "replay", "rate-limited", "busy", "other-user", "wrong-image", "bad-request", "rejected"];
    public BrokerChild(Stream pipe, BrokerRequest request, string resultPath)
    {
        streaming = request.Op == "--elevated-fps";
        done = Task.Run(() => Exchange(pipe, request, resultPath));
    }
    public bool WaitForExit(TimeSpan timeout) => done.Wait(timeout) && (done.Result is not null || streaming);
    public int? ExitCode => done.IsCompleted ? done.Result ?? (streaming ? 1 : null) : null;
    public void Dispose() { }

    private async Task<int?> Exchange(Stream pipe, BrokerRequest request, string resultPath)
    {
        using var cancel = new CancellationTokenSource();
        FileStream? lines = null;
        try
        {
            // The same freshness guard the UAC child enforces: a withdrawn request (Stop, timeout) sends nothing.
            if (!ElevationRequest.Fresh(resultPath)) return ElevationRequest.NotFreshExitCode;
            await BrokerProtocol.WriteAsync(pipe, request).ConfigureAwait(false);
            Task? watcher = null;
            if (streaming)
            {
                lines = new FileStream(resultPath, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
                var stopFile = FpsChild.StopFile(resultPath);
                watcher = Task.Run(async () =>
                {
                    try
                    {
                        while (!cancel.IsCancellationRequested)
                        {
                            if (File.Exists(stopFile)) { await BrokerProtocol.WriteAsync(pipe, new BrokerRequest(BrokerProtocol.Version, "stop")).ConfigureAwait(false); return; }
                            await Task.Delay(100, cancel.Token).ConfigureAwait(false);
                        }
                    }
                    catch (Exception error) when (error is IOException or ObjectDisposedException or OperationCanceledException) { }
                });
            }
            try
            {
                while (await BrokerProtocol.ReadAsync(pipe, BrokerProtocol.MaxReplyBytes).ConfigureAwait(false) is { } frame)
                {
                    var reply = BrokerProtocol.Parse<BrokerReply>(frame);
                    if (reply is null || reply.V != BrokerProtocol.Version || reply.Nonce != request.Nonce && reply.Type != "error") return null;
                    switch (reply.Type)
                    {
                        case "line" when lines is not null && reply.Text is { } text:
                            await lines.WriteAsync(Encoding.UTF8.GetBytes(text + "\n")).ConfigureAwait(false);
                            await lines.FlushAsync().ConfigureAwait(false);
                            break;
                        case "end": return 0;
                        case "result" when reply.Text is { } body:
                            await File.WriteAllTextAsync(resultPath, body, new UTF8Encoding(false)).ConfigureAwait(false);
                            return 0;
                        case "error":
                            return reply.Code == "not-fresh" ? ElevationRequest.NotFreshExitCode : Refused.Contains(reply.Code) ? 2 : null;
                        default: return null;
                    }
                }
                return null;
            }
            finally { cancel.Cancel(); if (watcher is not null) await watcher.ConfigureAwait(false); }
        }
        catch (Exception error) when (error is IOException or InvalidDataException or ObjectDisposedException or UnauthorizedAccessException) { return null; }
        finally { lines?.Dispose(); pipe.Dispose(); }
    }
}

// Read-only facts about the broker from this user's side. Never opens a prompt, never needs administrator rights.
public static class BrokerLocal
{
    private const uint ScmConnect = 1, ServiceQueryStatus = 4, Running = 4;
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenSCManagerW(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatusEx(IntPtr service, int level, byte[] buffer, int size, out int needed);
    [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);

    // Exists / running / process id, from the service control manager (readable by any signed-in user).
    public static (bool Exists, bool Running, int Pid) QueryService()
    {
        var manager = OpenSCManagerW(null, null, ScmConnect);
        if (manager == IntPtr.Zero) return (false, false, 0);
        try
        {
            var service = OpenServiceW(manager, BrokerProtocol.ServiceName, ServiceQueryStatus);
            if (service == IntPtr.Zero) return (false, false, 0);
            try
            {
                // SERVICE_STATUS_PROCESS: state at 4, process id at 28.
                var buffer = new byte[36];
                return QueryServiceStatusEx(service, 0, buffer, buffer.Length, out _) ? (true, BitConverter.ToUInt32(buffer, 4) == Running, BitConverter.ToInt32(buffer, 28)) : (true, false, 0);
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
    public static string? ServiceImagePath()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\" + BrokerProtocol.ServiceName, false);
            return key?.GetValue("ImagePath") as string;
        }
        catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { return null; }
    }
    public static string ExpectedImagePath => BrokerPaths.ImagePath(BrokerPaths.InstallDir(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles)));
    private static string UserSid => WindowsIdentity.GetCurrent().User?.Value ?? "";

    // Connects, checks that the process on the other end of the pipe is the broker service's own process, and pings.
    private static async Task<(NamedPipeClientStream? Pipe, string? Version)> OpenAsync(int servicePid)
    {
        var pipe = new NamedPipeClientStream(".", BrokerProtocol.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await pipe.ConnectAsync(timeout.Token).ConfigureAwait(false);
            if (servicePid <= 0 || BrokerPipe.ServerPid(pipe) != servicePid) { pipe.Dispose(); return (null, null); }
            var nonce = BrokerProtocol.NewNonce();
            await BrokerProtocol.WriteAsync(pipe, new BrokerRequest(BrokerProtocol.Version, "ping", nonce), timeout.Token).ConfigureAwait(false);
            var frame = await BrokerProtocol.ReadAsync(pipe, BrokerProtocol.MaxRequestBytes, timeout.Token).ConfigureAwait(false);
            var reply = frame is null ? null : BrokerProtocol.Parse<BrokerReply>(frame);
            if (reply is { Type: "pong", V: BrokerProtocol.Version } && reply.Nonce == nonce && reply.Pid == servicePid) return (pipe, reply.Version);
        }
        catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException or OperationCanceledException or TimeoutException) { }
        pipe.Dispose();
        return (null, null);
    }

    // The decision and, when the broker is ready, the open pipe (the caller owns it).
    public static (BrokerState State, Stream? Pipe) Probe(bool keepPipe)
    {
        var (exists, running, pid) = QueryService();
        var image = ServiceImagePath();
        var config = BrokerConfig.Load();
        var helper = Environment.ProcessPath ?? "";
        NamedPipeClientStream? pipe = null;
        string? brokerVersion = null;
        bool? ping = null;
        // Talk to the pipe only when everything the administrator wrote at install time already checks out.
        if (exists && running && config is not null && string.Equals(image, ExpectedImagePath, StringComparison.OrdinalIgnoreCase))
        {
            (pipe, brokerVersion) = OpenAsync(pid).GetAwaiter().GetResult();
            ping = pipe is not null;
        }
        var state = BrokerStatusCheck.Evaluate(new BrokerFacts(exists, running, image, config, ExpectedImagePath, helper, UserSid, BrokerProtocol.AppVersion, ping, brokerVersion));
        if (state.State == "ready" && keepPipe) return (state, pipe);
        pipe?.Dispose();
        return (state, null);
    }
    public static Stream? ConnectReady() => Probe(true).Pipe;
    public static BrokerState Status() => Probe(false).State;
}
