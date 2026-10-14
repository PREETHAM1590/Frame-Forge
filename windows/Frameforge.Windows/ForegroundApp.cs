using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Frameforge.Windows;

// `foreground`: which program has the foreground window and whether that window covers its whole monitor (fullscreen or borderless).
// Read-only. Frameforge uses it to notice a game that is not in the library yet; it never touches the program.
public sealed record ForegroundInfo(int Pid, string Image, string Path, string StartTime, bool Fullscreen);

public static class ForegroundApp
{
    // Windows shell and desktop surfaces can cover the monitor without being a game.
    static readonly HashSet<string> Shell = new(StringComparer.OrdinalIgnoreCase)
    {
        "explorer", "dwm", "searchhost", "shellexperiencehost", "startmenuexperiencehost", "lockapp", "applicationframehost", "textinputhost", "frameforge", "frameforge.windows", "electron"
    };
    public static bool IsShell(string name) => Shell.Contains(name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name[..^4] : name);
    // The window rectangle equals (or exceeds) the monitor rectangle.
    public static bool Covers((int L, int T, int R, int B) window, (int L, int T, int R, int B) monitor) =>
        window.L <= monitor.L && window.T <= monitor.T && window.R >= monitor.R && window.B >= monitor.B;

    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);

    public static ForegroundInfo? Read()
    {
        var window = GetForegroundWindow();
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out var pid) == 0 || pid == 0) return null;
        if (!GetWindowRect(window, out var rect)) return null;
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        var monitor = MonitorFromWindow(window, 2);
        var fullscreen = monitor != IntPtr.Zero && GetMonitorInfoW(monitor, ref info) &&
            Covers((rect.Left, rect.Top, rect.Right, rect.Bottom), (info.Monitor.Left, info.Monitor.Top, info.Monitor.Right, info.Monitor.Bottom));
        using var handle = WindowsProcesses.Open((int)pid, WindowsProcesses.QueryLimited);
        var target = handle is null ? null : WindowsProcesses.Read(handle, (int)pid);
        if (target is null || IsShell(target.Name) || ProcessSafety.Denied(target.Name)) return null;
        return new((int)pid, System.IO.Path.GetFileName(target.ExecutablePath), target.ExecutablePath, target.StartTime, fullscreen);
    }
}
