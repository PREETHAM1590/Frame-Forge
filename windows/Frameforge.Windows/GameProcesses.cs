using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Frameforge.Windows;

public record ProcessTarget(int Pid, string StartTime, string ExecutablePath, string Name, string Priority);
public record GameRef(string Id, string Path, string? ExecutablePath);
public record RunningGame(string GameId, ProcessTarget Target);

public static class ProcessSafety
{
    // GC-11 hard denylist (image names without .exe). Mirrored in shared/contracts.ts for UX; this is the enforcement point.
    public static readonly HashSet<string> Denylist = new(StringComparer.OrdinalIgnoreCase)
    {
        "system", "registry", "smss", "csrss", "wininit", "winlogon", "services", "lsass", "lsaiso", "svchost", "fontdrvhost", "dwm", "explorer",
        "sihost", "ctfmon", "audiodg", "spoolsv", "searchhost", "startmenuexperiencehost", "shellexperiencehost", "textinputhost", "runtimebroker",
        "msmpeng", "nissrv", "securityhealthservice", "securityhealthsystray", "smartscreen", "easyanticheat", "easyanticheat_eos", "beservice", "vgc",
        "vgtray", "faceit", "faceitclient", "esportal", "gameguard", "xigncode", "nvcontainer", "nvdisplay.container", "amdrsserv", "atiesrxx", "atieclxx"
    };
    public static bool Denied(string image) => Denylist.Contains(image.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? image[..^4] : image);
}

public static class WindowsProcesses
{
    public const uint QueryLimited = 0x1000, SetInformation = 0x0200, SuspendResume = 0x0800, Terminate = 0x0001, Synchronize = 0x00100000;
    private const uint StillActive = 259;
    // Returns null when no process has this pid; access refusals surface as Win32Exception so callers can report them.
    public static SafeProcessHandle? Open(int pid, uint access)
    {
        var raw = OpenProcess(access, false, (uint)pid);
        if (raw != IntPtr.Zero) return new SafeProcessHandle(raw, true);
        var error = Marshal.GetLastWin32Error();
        return error == 87 ? null : throw new Win32Exception(error);
    }
    // Null when the process has exited, including an exited process kept alive by another handle.
    public static ProcessTarget? Read(SafeProcessHandle handle, int pid)
    {
        if (!GetExitCodeProcess(handle, out var exitCode) || exitCode != StillActive) return null;
        var image = new StringBuilder(32768); var size = (uint)image.Capacity;
        if (!QueryFullProcessImageNameW(handle, 0, image, ref size) || !GetProcessTimes(handle, out var created, out _, out _, out _)) throw new InvalidOperationException("Windows could not inspect this process.");
        var path = LocalPaths.Resolve(image.ToString());
        return new(pid, DateTime.FromFileTimeUtc(created).ToString("O", CultureInfo.InvariantCulture), path, Path.GetFileNameWithoutExtension(path), PriorityName(GetPriorityClass(handle)));
    }
    public static bool Same(ProcessTarget current, ProcessTarget expected) => current.Pid == expected.Pid && current.StartTime == expected.StartTime &&
        string.Equals(current.ExecutablePath, expected.ExecutablePath, StringComparison.OrdinalIgnoreCase);
    // Fails closed: an unreadable flag counts as critical.
    public static bool IsCritical(SafeProcessHandle handle) => !IsProcessCritical(handle, out var critical) || critical;
    public static string PriorityName(uint value) => value switch
    {
        0x20 => "Normal", 0x8000 => "AboveNormal", 0x4000 => "BelowNormal", 0x80 => "High", 0x40 => "Idle", 0x100 => "RealTime",
        _ => throw new InvalidOperationException("Windows could not read the process priority.")
    };
    // RealTime is never set.
    public static uint PriorityValue(string name) => name switch
    {
        "Normal" => 0x20, "AboveNormal" => 0x8000, "BelowNormal" => 0x4000, "High" => 0x80, "Idle" => 0x40,
        _ => throw new InvalidOperationException("Unsupported priority.")
    };
    public static RunningGame[] RunningGames(GameRef[] games)
    {
        if (games.Length > 500) throw new InvalidOperationException("Too many games.");
        var resolved = new List<(string Id, string Directory, string? Executable)>();
        foreach (var game in games)
        {
            try
            {
                if (!Guid.TryParse(game.Id, out _)) continue;
                var directory = LocalPaths.Resolve(game.Path);
                var executable = game.ExecutablePath is null ? null : LocalPaths.Resolve(game.ExecutablePath);
                if (executable is not null && (!LocalPaths.IsWithin(executable, directory) || !executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))) continue;
                resolved.Add((game.Id, directory, executable));
            }
            catch (Exception error) when (error is IOException or InvalidOperationException or UnauthorizedAccessException) { }
        }
        var found = new List<(string Id, ProcessTarget Target, bool Window, long WorkingSet)>();
        if (resolved.Count == 0) return [];
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                try
                {
                    // Scans only read, so the handle is query-limited.
                    using var handle = Open(process.Id, QueryLimited);
                    if (handle is null) continue;
                    var current = Read(handle, process.Id);
                    if (current is null || ProcessSafety.Denied(current.Name) || IsCritical(handle)) continue;
                    foreach (var game in resolved)
                    {
                        var match = game.Executable is not null
                            ? string.Equals(current.ExecutablePath, game.Executable, StringComparison.OrdinalIgnoreCase)
                            : LocalPaths.IsWithin(current.ExecutablePath, game.Directory) && !current.Name.Contains("crash", StringComparison.OrdinalIgnoreCase) && !current.Name.Contains("launcher", StringComparison.OrdinalIgnoreCase);
                        if (match) found.Add((game.Id, current, process.MainWindowHandle != IntPtr.Zero, process.WorkingSet64));
                    }
                }
                catch (Exception error) when (error is Win32Exception or InvalidOperationException or IOException or UnauthorizedAccessException) { }
            }
        }
        return found.GroupBy(f => f.Id).Select(g => g.OrderByDescending(f => f.Window).ThenByDescending(f => f.WorkingSet).First()).Select(f => new RunningGame(f.Id, f.Target)).ToArray();
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(SafeProcessHandle handle, out uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(SafeProcessHandle handle, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(SafeProcessHandle handle, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetPriorityClass(SafeProcessHandle handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessCritical(SafeProcessHandle handle, out bool critical);
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
