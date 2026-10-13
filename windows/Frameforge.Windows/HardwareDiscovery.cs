using System.Management;
namespace Frameforge.Windows;
public static class HardwareDiscovery
{
    private static List<Dictionary<string, object?>> Query(string query, List<string> warnings, string scope = @"root\CIMV2")
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(new ManagementScope(scope), new ObjectQuery(query), new System.Management.EnumerationOptions { Timeout = TimeSpan.FromSeconds(4), ReturnImmediately = false });
            using var results = searcher.Get();
            return results.Cast<ManagementObject>().Select(item => { using (item) return item.Properties.Cast<PropertyData>().ToDictionary(p => p.Name, p => (object?)p.Value); }).ToList();
        }
        catch { warnings.Add("Some Windows hardware readings were unavailable."); return []; }
    }
    /// <summary>EDID strings arrive as a zero-padded ushort array.</summary>
    public static string? Edid(object? value)
    {
        if (value is not ushort[] codes) return null;
        var text = new string(codes.TakeWhile(c => c != 0).Select(c => (char)c).ToArray()).Trim();
        return text.Length > 0 ? text : null;
    }
    public static object Collect()
    {
        var warnings = new List<string>();
        var cpu = Query("SELECT Name,NumberOfLogicalProcessors FROM Win32_Processor", warnings);
        var gpu = Query("SELECT Name,DriverVersion,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate FROM Win32_VideoController", warnings);
        var system = Query("SELECT Caption,Version,TotalVisibleMemorySize,FreePhysicalMemory FROM Win32_OperatingSystem", warnings).FirstOrDefault();
        // Win32_DesktopMonitor only says "Generic PnP Monitor"; WmiMonitorID carries the EDID name (readable unelevated).
        var monitors = Query("SELECT UserFriendlyName,ManufacturerName FROM WmiMonitorID WHERE Active=TRUE", warnings, @"root\WMI");
        var drives = new List<object>();
        foreach (var drive in DriveInfo.GetDrives()) { try { if (drive.IsReady && drive.DriveType == DriveType.Fixed) drives.Add(new { name = drive.Name, totalBytes = drive.TotalSize, freeBytes = drive.AvailableFreeSpace }); } catch { warnings.Add("A drive reading was unavailable."); } }
        return new
        {
            source = "windows",
            collectedAt = DateTimeOffset.UtcNow.ToString("O"),
            cpu = string.Join(" / ", cpu.Select(c => Convert.ToString(c.GetValueOrDefault("Name")))),
            cores = cpu.Sum(c => Convert.ToInt32(c.GetValueOrDefault("NumberOfLogicalProcessors"))),
            gpu = gpu.Select(g => Convert.ToString(g.GetValueOrDefault("Name")) ?? "Unavailable").ToArray(),
            memoryBytes = Convert.ToInt64(system?.GetValueOrDefault("TotalVisibleMemorySize") ?? 0) * 1024,
            freeMemoryBytes = Convert.ToInt64(system?.GetValueOrDefault("FreePhysicalMemory") ?? 0) * 1024,
            os = $"{system?.GetValueOrDefault("Caption")} {system?.GetValueOrDefault("Version")}",
            drives,
            // WMI offers no reliable monitor-to-adapter join, so names and active modes are listed separately.
            displays = monitors.Select(m => Edid(m.GetValueOrDefault("UserFriendlyName")) ?? Edid(m.GetValueOrDefault("ManufacturerName")) ?? "Unnamed display")
                .Concat(gpu.Where(g => g.GetValueOrDefault("CurrentHorizontalResolution") is not null).Select(g =>
                    $"{g.GetValueOrDefault("CurrentHorizontalResolution")} x {g.GetValueOrDefault("CurrentVerticalResolution")} @ {g.GetValueOrDefault("CurrentRefreshRate")} Hz on {g.GetValueOrDefault("Name")}"))
                .ToArray(),
            drivers = gpu.Select(g => $"{g.GetValueOrDefault("Name")}: {g.GetValueOrDefault("DriverVersion")}").ToArray(),
            warnings = warnings.Distinct().ToArray()
        };
    }
}
