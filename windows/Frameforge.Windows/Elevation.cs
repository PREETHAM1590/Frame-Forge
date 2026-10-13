using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace Frameforge.Windows;

// A small request file sits next to the result file. The elevated child changes nothing unless the request file still exists
// and is fresh, so an administrator prompt that is answered after the parent gave up, was stopped, or died changes nothing.
public static class ElevationRequest
{
    public const int NotFreshExitCode = 3;
    private const string Marker = "frameforge-request";
    public static string PathFor(string resultPath) => Path.ChangeExtension(resultPath, ".req");
    public static void Create(string resultPath, TimeSpan validFor, DateTime? now = null)
    {
        var seconds = (int)Math.Clamp(validFor.TotalSeconds, 1, 600);
        using var file = new FileStream(PathFor(resultPath), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        file.Write(Encoding.ASCII.GetBytes($"{Marker} {(now ?? DateTime.UtcNow).Ticks} {seconds}"));
    }
    // Parent side: withdraws the request. Anything approved from now on exits without changing anything.
    public static void Withdraw(string resultPath) => RestoreCommands.TryDelete(PathFor(resultPath));
    // Child side: the request is present, written by us a moment ago and not older than the time the parent allowed.
    public static bool Fresh(string resultPath, DateTime? now = null)
    {
        try
        {
            var path = PathFor(resultPath);
            var info = new FileInfo(path);
            if (!info.Exists || info.Length is 0 or > 100 || info.Attributes.HasFlag(FileAttributes.ReparsePoint)) return false;
            var parts = File.ReadAllText(path).Split(' ');
            if (parts.Length != 3 || parts[0] != Marker || !long.TryParse(parts[1], out var ticks) || !int.TryParse(parts[2], out var seconds) || seconds is < 1 or > 600) return false;
            var age = (now ?? DateTime.UtcNow) - new DateTime(ticks, DateTimeKind.Utc);
            return age >= TimeSpan.FromSeconds(-5) && age <= TimeSpan.FromSeconds(seconds);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or OverflowException) { return false; }
    }
}

public interface IElevatedChild : IDisposable
{
    bool WaitForExit(TimeSpan timeout);
    int? ExitCode { get; }
}
public interface IElevatedLauncher
{
    // Blocks while the consent prompt is open. Throws Win32Exception (1223) when the user declines.
    IElevatedChild? Start(IReadOnlyList<string> arguments);
}
public sealed class WindowsElevatedLauncher : IElevatedLauncher
{
    private sealed class Child(Process process) : IElevatedChild
    {
        public bool WaitForExit(TimeSpan timeout) => process.WaitForExit(timeout);
        public int? ExitCode => RestoreCommands.ExitCode(process);
        public void Dispose() => process.Dispose();
    }
    // GC-7: never concatenate arguments; ArgumentList is honoured by ShellExecuteEx.
    public IElevatedChild? Start(IReadOnlyList<string> arguments)
    {
        var info = new ProcessStartInfo { FileName = Environment.ProcessPath!, UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        return Process.Start(info) is { } process ? new Child(process) : null;
    }
}

public enum ElevationStatus { Done, Declined, NotApproved, Cancelled, Rejected, Expired, ChildTimeout, NoChild }
// Text is the elevated child's result file when Status is Done.
public sealed record ElevationOutcome(ElevationStatus Status, string? Text = null);

public static class ElevatedCall
{
    // Waits for the prompt to be answered; after that the child's own work gets childWait. Cancel (the user pressed Stop) and the
    // approval budget both withdraw the request first, so a prompt that is answered later is harmless.
    public static ElevationOutcome Run(IElevatedLauncher launcher, string flag, string action, string[] args, TimeSpan approvalBudget, TimeSpan childWait, CancellationToken cancel,
        TimeSpan? grace = null, string? directory = null)
    {
        var resultPath = WindowsServiceElevator.NewResultPath(directory);
        ElevationRequest.Create(resultPath, approvalBudget + TimeSpan.FromSeconds(10));
        var keep = false;
        try
        {
            var launch = Task.Run(() => launcher.Start([flag, action, resultPath, .. args]));
            var abandoned = ElevationStatus.Done;
            try { if (!launch.Wait(approvalBudget, cancel)) abandoned = ElevationStatus.NotApproved; }
            catch (OperationCanceledException) { abandoned = ElevationStatus.Cancelled; }
            catch (AggregateException) { /* The launch failed or was declined; handled below. */ }
            if (abandoned != ElevationStatus.Done)
            {
                ElevationRequest.Withdraw(resultPath);
                // The prompt may have been answered this very moment. A child that is already running may have passed its check.
                if (!launch.Wait(grace ?? TimeSpan.FromSeconds(3))) return new(abandoned);
            }
            IElevatedChild? child;
            try { child = launch.GetAwaiter().GetResult(); }
            catch (Win32Exception error) when (error.NativeErrorCode == 1223) { return new(ElevationStatus.Declined); }
            if (child is null) return new(ElevationStatus.NoChild);
            using (child)
            {
                if (!child.WaitForExit(childWait))
                {
                    // The child may still write its result; the file stays and is swept later.
                    keep = true;
                    return new(ElevationStatus.ChildTimeout);
                }
                var code = child.ExitCode;
                if (code == ElevationRequest.NotFreshExitCode) return new(abandoned != ElevationStatus.Done ? abandoned : ElevationStatus.Expired);
                if (code == 2) return new(ElevationStatus.Rejected);
            }
            // A cancel that arrived after the child had started its work: the work is done, so report it.
            return new(ElevationStatus.Done, File.ReadAllText(resultPath));
        }
        finally
        {
            ElevationRequest.Withdraw(resultPath);
            if (!keep) RestoreCommands.TryDelete(resultPath);
        }
    }

    // Child side of every elevated entry point: the result file must be ours and the request still valid.
    // Returns the open result file, or null with the exit code to use (2: rejected file, 3: request not fresh).
    public static FileStream? OpenResult(string path, out int exitCode)
    {
        exitCode = 2;
        if (!RestoreCommands.ValidResultPath(path)) return null;
        if (!ElevationRequest.Fresh(path)) { exitCode = ElevationRequest.NotFreshExitCode; return null; }
        var file = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.None);
        // Reject a swapped file or a junction anywhere in the path before an elevated write.
        if (file.Length != 0 || !string.Equals(RestoreCommands.FinalPath(file.SafeFileHandle), path, StringComparison.OrdinalIgnoreCase)) { file.Dispose(); return null; }
        return file;
    }
}
