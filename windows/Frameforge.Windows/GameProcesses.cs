using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Frameforge.Windows;

public record ProcessTarget(int Pid, string StartTime, string ExecutablePath, string Name, string Priority);
public record ProcessResult(bool Ok, string Message, string? Code = null, ProcessTarget? BoostSnapshot = null);
public interface IProcessSession : IDisposable
{
    ProcessTarget Read();
    void SetPriority(string priority);
}
public interface IProcessStore { IProcessSession? Open(int pid); }

public sealed class GameProcessOperations(IProcessStore store)
{
    public static void Validate(ProcessTarget target)
    {
        if (target.Pid <= 0 || string.IsNullOrWhiteSpace(target.Name) || target.Name.Length > 160 ||
            !DateTime.TryParseExact(target.StartTime, "O", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var time) || time.Kind != DateTimeKind.Utc ||
            !Path.IsPathFullyQualified(target.ExecutablePath) || target.ExecutablePath.StartsWith(@"\\", StringComparison.Ordinal) ||
            !target.ExecutablePath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || target.Priority != "Normal")
            throw new InvalidOperationException("Invalid game process snapshot.");
    }
    private static bool SameProcess(ProcessTarget current, ProcessTarget expected) => current.Pid == expected.Pid && current.StartTime == expected.StartTime &&
        string.Equals(current.ExecutablePath, expected.ExecutablePath, StringComparison.OrdinalIgnoreCase);
    public ProcessResult Start(ProcessTarget expected)
    {
        Validate(expected);
        using var process = store.Open(expected.Pid);
        if (process is null) return new(false, "The game has exited. Start it again before boosting.", "process-exited");
        var current = process.Read();
        if (!SameProcess(current, expected)) return new(false, "The selected game process changed. Refresh running games.", "process-changed");
        if (current.Priority != expected.Priority) return new(false, "The game priority changed externally. No change was made.", "priority-conflict");
        process.SetPriority("AboveNormal");
        if (process.Read().Priority != "AboveNormal") return new(false, "Windows did not retain the requested priority. Recovery remains available.", "verification-failed", current);
        return new(true, "Running game priority verified as Above normal.", BoostSnapshot: current);
    }
    public ProcessResult Stop(ProcessTarget snapshot)
    {
        Validate(snapshot);
        using var process = store.Open(snapshot.Pid);
        if (process is null) return new(true, "The game has exited; its temporary priority change ended with it.", "process-exited");
        var current = process.Read();
        if (!SameProcess(current, snapshot)) return new(true, "The original game process has exited. No other process was changed.", "process-exited");
        if (current.Priority == snapshot.Priority) return new(true, "The original game priority is already restored.");
        if (current.Priority != "AboveNormal") return new(false, "The game priority changed externally. Restore stopped to preserve that change.", "priority-conflict");
        process.SetPriority(snapshot.Priority);
        return process.Read().Priority == snapshot.Priority
            ? new(true, "The original game priority was restored and verified.")
            : new(false, "Windows could not verify the restored priority. Recovery remains available.", "verification-failed");
    }
}

public sealed class WindowsProcessStore : IProcessStore
{
    public IProcessSession? Open(int pid)
    {
        try { return new WindowsProcessSession(Process.GetProcessById(pid)); }
        catch (ArgumentException) { return null; }
    }
    private sealed class WindowsProcessSession(Process process) : IProcessSession
    {
        public ProcessTarget Read()
        {
            process.Refresh();
            if (process.HasExited) throw new InvalidOperationException("The game exited while the request was running. Retry recovery to clear its session.");
            return new(process.Id, process.StartTime.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
                LocalPaths.Resolve(process.MainModule?.FileName ?? throw new InvalidOperationException("Windows could not inspect this game executable.")),
                process.ProcessName, process.PriorityClass.ToString());
        }
        public void SetPriority(string priority)
        {
            process.PriorityClass = priority switch { "Normal" => ProcessPriorityClass.Normal, "AboveNormal" => ProcessPriorityClass.AboveNormal, _ => throw new InvalidOperationException("Unsupported priority.") };
        }
        public void Dispose() => process.Dispose();
    }
    public static ProcessTarget[] Find(string gamePath, string? executablePath)
    {
        var directory = LocalPaths.Resolve(gamePath);
        if (!Directory.Exists(directory)) throw new InvalidOperationException("The game installation folder no longer exists.");
        var executable = executablePath is null ? null : LocalPaths.Resolve(executablePath);
        if (executable is not null && (!LocalPaths.IsWithin(executable, directory) || !executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("The selected executable is outside this game installation.");
        var results = new List<ProcessTarget>();
        var store = new WindowsProcessStore();
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                try
                {
                    using var session = store.Open(process.Id);
                    if (session is null) continue;
                    var current = session.Read();
                    if (executable is not null ? string.Equals(current.ExecutablePath, executable, StringComparison.OrdinalIgnoreCase) : LocalPaths.IsWithin(current.ExecutablePath, directory)) results.Add(current);
                }
                catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException or IOException or UnauthorizedAccessException) { }
            }
        }
        return results.OrderBy(p => p.Name).ThenBy(p => p.Pid).ToArray();
    }
}

public static class LocalPaths
{
    public static bool IsWithin(string file, string directory) => file.StartsWith(directory.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    public static string Resolve(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 32760 || !Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal)) throw new InvalidOperationException("A local absolute path is required.");
        using var handle = CreateFile(Path.GetFullPath(path), 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (handle.IsInvalid) throw new IOException("The local game path could not be resolved.");
        var buffer = new StringBuilder(32768);
        var length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity) throw new IOException("The local game path could not be resolved.");
        var resolved = buffer.ToString();
        if (resolved.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Network game paths are not supported.");
        if (resolved.StartsWith(@"\\?\", StringComparison.Ordinal)) resolved = resolved[4..];
        return resolved.TrimEnd(Path.DirectorySeparatorChar);
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
}
