using System.Diagnostics;
using System.Globalization;
using System.Management;
namespace Frameforge.Windows;

public sealed record GpuAdapter(string Name, string Vendor, string DriverVersion, string? DisplayVersion, string? DriverDate);

// Read-only: Win32_VideoController plus, for NVIDIA, the version nvidia-smi prints. Nothing is downloaded, scraped or installed.
public static class GpuDrivers
{
    public static string Vendor(string? pnpDeviceId)
    {
        var id = pnpDeviceId?.ToUpperInvariant() ?? "";
        return id.Contains("VEN_10DE") ? "nvidia" : id.Contains("VEN_1002") || id.Contains("VEN_1022") ? "amd" : id.Contains("VEN_8086") ? "intel" : "other";
    }

    /// <summary>NVIDIA's WMI version 32.0.15.6094 is driver 560.94: the last five digits of the third and fourth parts together.</summary>
    public static string? NvidiaVersion(string? wmi)
    {
        var parts = wmi?.Split('.');
        if (parts is not { Length: 4 } || parts.Any(p => p.Length == 0 || !p.All(char.IsAsciiDigit))) return null;
        var digits = parts[2] + parts[3];
        if (digits.Length < 5) return null;
        digits = digits[^5..];
        return $"{digits[..3]}.{digits[3..]}";
    }

    /// <summary>A DateTime, or a CIM/DMTF string ("20260917053000.000000+330"), as yyyy-MM-dd.</summary>
    public static string? ParseDriverDate(object? value)
    {
        switch (value)
        {
            case DateTime d: return d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            case string s when s.Length >= 8 && s[..8].All(char.IsAsciiDigit):
                return DateTime.TryParseExact(s[..8], "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var cim) ? cim.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null;
            default: return null;
        }
    }

    /// <summary>Lines of "name, version" as printed by nvidia-smi --query-gpu=name,driver_version --format=csv,noheader.</summary>
    public static List<(string Name, string Version)> ParseNvidiaSmi(string? output)
    {
        var rows = new List<(string, string)>();
        foreach (var line in (output ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var cut = line.LastIndexOf(',');
            if (cut <= 0) continue;
            var name = line[..cut].Trim(); var version = line[(cut + 1)..].Trim();
            if (name.Length > 0 && version.Length > 0 && version.All(c => char.IsAsciiDigit(c) || c == '.')) rows.Add((name, version));
        }
        return rows;
    }

    static string? RunSmi()
    {
        try
        {
            var exe = Path.Combine(Environment.SystemDirectory, "nvidia-smi.exe");
            if (!File.Exists(exe)) exe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe");
            if (!File.Exists(exe)) return null;
            using var p = Process.Start(new ProcessStartInfo(exe, "--query-gpu=name,driver_version --format=csv,noheader") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true });
            if (p is null) return null;
            var text = p.StandardOutput.ReadToEndAsync();
            if (!p.WaitForExit(4000)) { try { p.Kill(); } catch (InvalidOperationException) { } return null; }
            return text.Wait(1000) ? text.Result : null;
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException or IOException) { return null; }
    }

    public static List<GpuAdapter> Merge(IEnumerable<Dictionary<string, object?>> wmi, List<(string Name, string Version)> smi)
    {
        var list = new List<GpuAdapter>();
        foreach (var row in wmi)
        {
            var pnp = Convert.ToString(row.GetValueOrDefault("PNPDeviceID"));
            // Virtual and remote adapters are not on the PCI bus.
            if (pnp is null || !pnp.StartsWith("PCI\\", StringComparison.OrdinalIgnoreCase)) continue;
            var name = Convert.ToString(row.GetValueOrDefault("Name")) ?? "Unknown adapter";
            var version = Convert.ToString(row.GetValueOrDefault("DriverVersion")) ?? "";
            var vendor = Vendor(pnp);
            string? shown = null;
            if (vendor == "nvidia") shown = smi.Where(s => string.Equals(s.Name, name, StringComparison.OrdinalIgnoreCase)).Select(s => s.Version).FirstOrDefault() ?? (smi.Count == 1 ? smi[0].Version : null) ?? NvidiaVersion(version);
            list.Add(new(name, vendor, version, shown, ParseDriverDate(row.GetValueOrDefault("DriverDate"))));
        }
        return list;
    }

    public static object Collect()
    {
        var warnings = new List<string>();
        var rows = HardwareDiscovery.Query("SELECT Name,DriverVersion,DriverDate,PNPDeviceID FROM Win32_VideoController", warnings);
        // WMI hands the date over as a DMTF string.
        foreach (var row in rows)
            if (row.GetValueOrDefault("DriverDate") is string dmtf)
            {
                try { row["DriverDate"] = ManagementDateTimeConverter.ToDateTime(dmtf); }
                catch (ArgumentException) { row["DriverDate"] = null; }
            }
        var smi = rows.Any(r => Vendor(Convert.ToString(r.GetValueOrDefault("PNPDeviceID"))) == "nvidia") ? ParseNvidiaSmi(RunSmi()) : [];
        return new { adapters = Merge(rows, smi), warnings = warnings.Distinct().ToArray() };
    }
}
