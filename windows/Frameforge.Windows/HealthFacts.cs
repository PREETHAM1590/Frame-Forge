using System.Diagnostics;
using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Frameforge.Windows;

// `health`: read-only facts about this PC for the PC Health Check page. Nothing is changed and nothing needs administrator rights.
// The meaning of the facts (good/warn/bad, wording, fixes) is decided in TypeScript (shared/health.ts) and tested there with fakes.
public static class HealthFacts
{
    public sealed record Battery(bool Present, bool OnAc, bool Saver, int? Percent);
    public sealed record PowerMode(string Overlay, string? PlanGuid, string? PlanName);
    public sealed record Gpu(string Name, string Vendor, string? DriverVersion, string? DriverDate, bool Integrated);
    public sealed record GpuPreference(string GameId, string Exe, string? Preference);
    public sealed record Nvidia(string Name, string? DriverVersion, double? TemperatureC, double? ClockMHz, double? MaxClockMHz, double? PowerDrawW, double? PowerLimitW, string? PState, string[] ThrottleReasons);
    public sealed record Display(int Width, int Height, int CurrentHz, int MaxHz);
    public sealed record Stick(long CapacityBytes, int? SpeedMTs, int? ConfiguredMTs, string? Bank, string? Slot);
    public sealed record Memory(long TotalBytes, long AvailableBytes, int UsedPercent, Stick[] Sticks, int? Slots);
    public sealed record Drive(string Name, long TotalBytes, long FreeBytes, bool System, string MediaType);
    public sealed record Consumer(string Name, int Count, double CpuPercent, long WorkingSetBytes);
    public sealed record Snapshot(Battery Battery, PowerMode PowerMode, Gpu[] Gpus, GpuPreference[] GpuPreferences, Nvidia? Nvidia, Display? Display, Memory Memory,
        string CpuName, double? CpuPerformancePercent, Drive[] Drives, bool? GameMode, int? Hags, bool? Vbs, bool? Hvci, string[] PendingReboot, int StartupApps, string[] Overlays,
        string? VendorApp, Consumer[] TopRam, Consumer[] TopCpu);

    // ---- pure parsers (unit tested) ----
    public static string OverlayName(Guid overlay) => overlay.ToString() switch
    {
        "00000000-0000-0000-0000-000000000000" => "balanced",
        "ded574b5-45a0-4f42-8737-46345c09c238" => "best-performance",
        "961cc777-2547-4f9d-8174-7d86181b8a7a" => "best-efficiency",
        "3af9b8d9-7c97-431d-ad78-34a8bfea439f" => "gaming",
        _ => "unknown"
    };
    // "GpuPreference=2;" -> high-performance. 1 power saving, 0 let Windows decide, no entry -> null.
    public static string? ParsePreference(string? value)
    {
        if (value is null) return null;
        foreach (var part in value.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            if (part.StartsWith("GpuPreference=", StringComparison.OrdinalIgnoreCase))
                return part[14..] switch { "2" => "high-performance", "1" => "power-saving", "0" => "auto", _ => "auto" };
        return "auto";
    }
    public static string[] ThrottleReasons(string? hex)
    {
        if (hex is null) return [];
        var text = hex.Trim();
        if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) text = text[2..];
        if (!ulong.TryParse(text, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var mask)) return [];
        var reasons = new List<string>();
        if ((mask & 0x4) != 0) reasons.Add("power cap");
        if ((mask & 0x8) != 0) reasons.Add("hardware slowdown");
        if ((mask & 0x20) != 0) reasons.Add("thermal slowdown");
        if ((mask & 0x40) != 0) reasons.Add("hardware thermal slowdown");
        if ((mask & 0x80) != 0) reasons.Add("power brake");
        return [.. reasons];
    }
    private static double? Number(string? text) => text is not null && double.TryParse(text.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : null;
    // nvidia-smi --query-gpu=name,driver_version,temperature.gpu,clocks.gr,clocks.max.gr,power.draw,power.limit,pstate,<reasons> --format=csv,noheader,nounits
    public static Nvidia? ParseNvidia(string text)
    {
        var line = text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault();
        if (line is null) return null;
        var f = line.Split(',', StringSplitOptions.TrimEntries);
        if (f.Length < 8 || f[0].Length == 0 || f[0].Contains("Failed", StringComparison.OrdinalIgnoreCase)) return null;
        string? Text(int i) => i < f.Length && f[i].Length > 0 && !f[i].StartsWith('[') ? f[i] : null;
        return new(f[0].Length > 80 ? f[0][..80] : f[0], Text(1), Number(Text(2)), Number(Text(3)), Number(Text(4)), Number(Text(5)), Number(Text(6)), Text(7), ThrottleReasons(Text(8)));
    }
    // Primary display modes: the highest refresh rate Windows offers at the current resolution, within one Hz of rounding (239.76 reports as 240).
    public static int MaxHz(IEnumerable<(int W, int H, int Hz)> modes, int width, int height) =>
        modes.Where(m => m.W == width && m.H == height).Select(m => m.Hz).DefaultIfEmpty(0).Max();
    public static string Vendor(string name) =>
        name.Contains("NVIDIA", StringComparison.OrdinalIgnoreCase) ? "nvidia" : name.Contains("AMD", StringComparison.OrdinalIgnoreCase) || name.Contains("Radeon", StringComparison.OrdinalIgnoreCase) ? "amd" : name.Contains("Intel", StringComparison.OrdinalIgnoreCase) ? "intel" : "other";
    // An integrated GPU: Intel UHD/Iris/Xe, or an AMD "Radeon Graphics" / "Radeon(TM) Graphics" APU part.
    public static bool Integrated(string name) =>
        (name.Contains("Intel", StringComparison.OrdinalIgnoreCase) && !name.Contains("Arc", StringComparison.OrdinalIgnoreCase)) ||
        name.Trim().EndsWith("Radeon(TM) Graphics", StringComparison.OrdinalIgnoreCase) || name.Trim().EndsWith("Radeon Graphics", StringComparison.OrdinalIgnoreCase);
    static readonly string[] OverlayImages = ["Discord", "DiscordPTB", "DiscordCanary", "Overwolf", "OverwolfBrowser", "steamwebhelper", "GameOverlayUI", "NVIDIA Overlay", "nvsphelper64", "GeForceExperience", "RTSS", "RTSSHooksLoader64", "GameBarPresenceWriter", "XboxGameBarWidgets", "MSIAfterburner", "RadeonSoftware"];
    static readonly (string Image, string App)[] VendorApps =
    [
        ("NitroSense", "NitroSense"), ("PredatorSense", "PredatorSense"), ("LenovoVantage", "Lenovo Vantage"), ("LenovoVantageService", "Lenovo Vantage"), ("ArmouryCrate.UserSessionHelper", "Armoury Crate"),
        ("ArmouryCrate.Service", "Armoury Crate"), ("ArmouryCrateService", "Armoury Crate"), ("MSI Center", "MSI Center"), ("MSI.CentralServer", "MSI Center"), ("OmenCommandCenterBackground", "OMEN Gaming Hub"),
        ("OmenCap", "OMEN Gaming Hub"), ("AWCC", "Alienware Command Center"), ("AlienFXSubAgent", "Alienware Command Center"), ("GigabyteControlCenter", "GIGABYTE Control Center"), ("Razer Synapse 3", "Razer Synapse"),
        // Acer ships its system services under these names even when the NitroSense window is closed.
        ("AcerSystemCentralService", "Acer system software"), ("AcerCentralService", "Acer system software")
    ];
    public static string? DetectVendorApp(IEnumerable<string> images)
    {
        var set = images.ToHashSet(StringComparer.OrdinalIgnoreCase);
        return VendorApps.FirstOrDefault(v => set.Contains(v.Image)).App;
    }
    // Store apps installed for this user (package names), which find a laptop control app that is not running right now.
    static readonly (string Pattern, string App)[] VendorPackages =
    [
        ("NitroSense", "NitroSense"), ("PredatorSense", "PredatorSense"), ("LenovoVantage", "Lenovo Vantage"), ("LenovoSettings", "Lenovo Vantage"), ("ArmouryCrate", "Armoury Crate"),
        ("MSICenter", "MSI Center"), ("OmenCommandCenter", "OMEN Gaming Hub"), ("AlienwareCommandCenter", "Alienware Command Center")
    ];
    public static string? DetectVendorPackage(IEnumerable<string> packages)
    {
        var list = packages.ToArray();
        return VendorPackages.FirstOrDefault(v => list.Any(p => p.Contains(v.Pattern, StringComparison.OrdinalIgnoreCase))).App;
    }
    public static string[] DetectOverlays(IEnumerable<string> images) => [.. OverlayImages.Where(o => images.Contains(o, StringComparer.OrdinalIgnoreCase)).OrderBy(o => o, StringComparer.OrdinalIgnoreCase)];

    // ---- readers ----
    public static Snapshot Collect(GameRef[] games)
    {
        var processes = MonitorSampler.Snapshot();
        var images = processes.Select(p => p.Name).ToArray();
        var tracker = new ProcessTracker();
        long Now() => Stopwatch.GetTimestamp() * 10_000_000L / Stopwatch.Frequency;
        tracker.Update(processes, Now(), Environment.ProcessorCount);
        // The CPU performance counter and per-process CPU both need two reads; one short wait serves both.
        var perf = ReadCpuPerformance(out var afterWait);
        var (byCpu, byMemory) = tracker.Update(afterWait ?? MonitorSampler.Snapshot(), Now(), Environment.ProcessorCount, 6);
        var memory = ReadMemory();
        var nvidia = ReadNvidia();
        return new(ReadBattery(), ReadPowerMode(), ReadGpus(), ReadPreferences(games), nvidia, ReadDisplay(), memory, CpuName(), perf, ReadDrives(),
            GameMode(), Dword(Registry.LocalMachine, @"SYSTEM\CurrentControlSet\Control\GraphicsDrivers", "HwSchMode"), Vbs(out var hvci), hvci, PendingReboot(), StartupApps(),
            DetectOverlays(images), DetectVendorPackage(InstalledPackages()) ?? DetectVendorApp(images),
            [.. byMemory.Select(p => new Consumer(p.Name, p.Count, p.CpuPercent, p.WorkingSetBytes))], [.. byCpu.Select(p => new Consumer(p.Name, p.Count, p.CpuPercent, p.WorkingSetBytes))]);
    }

    [StructLayout(LayoutKind.Sequential)] private struct PowerStatus { public byte AcLine, BatteryFlag, BatteryPercent, SystemStatusFlag; public uint LifeTime, FullLifeTime; }
    [DllImport("kernel32.dll")] private static extern bool GetSystemPowerStatus(out PowerStatus status);
    [DllImport("powrprof.dll")] private static extern uint PowerGetEffectiveOverlayScheme(out Guid scheme);
    private static Battery ReadBattery()
    {
        if (!GetSystemPowerStatus(out var s)) return new(false, true, false, null);
        var present = s.BatteryFlag != 128 && s.BatteryFlag != 255;
        return new(present, s.AcLine != 0, s.SystemStatusFlag == 1, present && s.BatteryPercent <= 100 ? s.BatteryPercent : null);
    }
    private static PowerMode ReadPowerMode()
    {
        string overlay = "unknown";
        try { overlay = PowerGetEffectiveOverlayScheme(out var g) == 0 ? OverlayName(g) : "unknown"; } catch (Exception error) when (error is EntryPointNotFoundException or DllNotFoundException) { }
        string? guid = null, name = null;
        try { var store = new WindowsPowerStore(); var active = store.Active(); guid = active.ToString(); name = store.Name(active); } catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException) { }
        return new(overlay, guid, name);
    }
    private static ManagementObject[] Wmi(string scope, string query)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(new ManagementScope(scope), new ObjectQuery(query), new System.Management.EnumerationOptions { Timeout = TimeSpan.FromSeconds(6) });
            using var results = searcher.Get();
            return [.. results.Cast<ManagementObject>()];
        }
        catch (Exception error) when (error is ManagementException or UnauthorizedAccessException or COMException or InvalidCastException) { return []; }
    }
    private static string? S(ManagementBaseObject o, string name) => o[name] as string;
    private static Gpu[] ReadGpus() => [.. Wmi(@"root\CIMV2", "SELECT Name, PNPDeviceID, DriverVersion, DriverDate FROM Win32_VideoController")
        .Where(o => (S(o, "PNPDeviceID") ?? "").StartsWith(@"PCI\", StringComparison.OrdinalIgnoreCase))
        .Select(o =>
        {
            var name = (S(o, "Name") ?? "Unknown").Trim();
            string? date = null;
            try { if (S(o, "DriverDate") is { Length: >= 8 } d) date = $"{d[..4]}-{d[4..6]}-{d[6..8]}"; } catch (ArgumentOutOfRangeException) { }
            return new Gpu(name, Vendor(name), S(o, "DriverVersion"), date, Integrated(name));
        })];
    private static GpuPreference[] ReadPreferences(GameRef[] games)
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\DirectX\UserGpuPreferences", false);
        return [.. games.Where(g => g.ExecutablePath is not null).Take(100).Select(g =>
        {
            var value = key?.GetValue(g.ExecutablePath!, null) as string;
            return new GpuPreference(g.Id, Path.GetFileName(g.ExecutablePath!), ParsePreference(value));
        })];
    }
    private static Nvidia? ReadNvidia()
    {
        var exe = new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"), Path.Combine(Environment.SystemDirectory, "nvidia-smi.exe") }.FirstOrDefault(File.Exists);
        if (exe is null) return null;
        // The reasons field was renamed in newer drivers; the first form that works wins.
        foreach (var reasons in new[] { "clocks_throttle_reasons.active", "clocks_event_reasons.active" })
        {
            var parsed = RunSmi(exe, $"--query-gpu=name,driver_version,temperature.gpu,clocks.gr,clocks.max.gr,power.draw,power.limit,pstate,{reasons} --format=csv,noheader,nounits");
            if (parsed is not null) return parsed;
        }
        return RunSmi(exe, "--query-gpu=name,driver_version,temperature.gpu,clocks.gr,clocks.max.gr,power.draw,power.limit,pstate --format=csv,noheader,nounits");
    }
    private static Nvidia? RunSmi(string exe, string args)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo(exe, args) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true });
            if (process is null) return null;
            var output = process.StandardOutput.ReadToEndAsync();
            if (!process.WaitForExit(4000)) { try { process.Kill(); } catch (InvalidOperationException) { } return null; }
            return process.ExitCode == 0 ? ParseNvidia(output.Result) : null;
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException) { return null; }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DevMode
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        public ushort SpecVersion, DriverVersion, Size, DriverExtra;
        public uint Fields; public int PositionX, PositionY; public uint Orientation, FixedOutput;
        public short Color, Duplex, YResolution, TtOption, Collate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string FormName;
        public ushort LogPixels; public uint BitsPerPel, PelsWidth, PelsHeight, DisplayFlags, DisplayFrequency, IcmMethod, IcmIntent, MediaType, DitherType, Reserved1, Reserved2, PanningWidth, PanningHeight;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool EnumDisplaySettingsW(string? device, int mode, ref DevMode devMode);
    private static Display? ReadDisplay()
    {
        var current = new DevMode { Size = (ushort)Marshal.SizeOf<DevMode>() };
        if (!EnumDisplaySettingsW(null, -1, ref current)) return null;
        var modes = new List<(int, int, int)>();
        for (var i = 0; i < 2000; i++)
        {
            var mode = new DevMode { Size = (ushort)Marshal.SizeOf<DevMode>() };
            if (!EnumDisplaySettingsW(null, i, ref mode)) break;
            modes.Add(((int)mode.PelsWidth, (int)mode.PelsHeight, (int)mode.DisplayFrequency));
        }
        return new((int)current.PelsWidth, (int)current.PelsHeight, (int)current.DisplayFrequency, Math.Max((int)current.DisplayFrequency, MaxHz(modes, (int)current.PelsWidth, (int)current.PelsHeight)));
    }
    private static Memory ReadMemory()
    {
        var status = new MonitorSampler.MemoryStatus { Length = (uint)Marshal.SizeOf<MonitorSampler.MemoryStatus>() };
        MonitorSampler.GlobalMemoryStatusEx(ref status);
        var sticks = Wmi(@"root\CIMV2", "SELECT Capacity, Speed, ConfiguredClockSpeed, BankLabel, DeviceLocator FROM Win32_PhysicalMemory")
            .Select(o => new Stick(Convert.ToInt64(o["Capacity"] ?? 0L, CultureInfo.InvariantCulture), o["Speed"] is null ? null : Convert.ToInt32(o["Speed"], CultureInfo.InvariantCulture),
                o["ConfiguredClockSpeed"] is null ? null : Convert.ToInt32(o["ConfiguredClockSpeed"], CultureInfo.InvariantCulture), S(o, "BankLabel"), S(o, "DeviceLocator"))).ToArray();
        int? slots = null;
        var arrays = Wmi(@"root\CIMV2", "SELECT MemoryDevices FROM Win32_PhysicalMemoryArray");
        if (arrays.Length > 0) slots = arrays.Sum(a => a["MemoryDevices"] is null ? 0 : Convert.ToInt32(a["MemoryDevices"], CultureInfo.InvariantCulture));
        return new((long)status.TotalPhysical, (long)status.AvailablePhysical, (int)status.MemoryLoad, sticks, slots is > 0 ? slots : null);
    }
    private static string CpuName() => Wmi(@"root\CIMV2", "SELECT Name FROM Win32_Processor").Select(o => S(o, "Name")?.Trim()).FirstOrDefault() ?? "Unknown CPU";
    // "% Processor Performance" is the current clock as a percent of the base clock; it can exceed 100 while boosting.
    private static double? ReadCpuPerformance(out List<(int Pid, string Name, long CpuTicks, long WorkingSet)>? after)
    {
        after = null;
        try
        {
            using var pdh = new PdhQuery();
            var counter = pdh.Add(@"\Processor Information(_Total)\% Processor Performance");
            pdh.Collect();
            Thread.Sleep(700);
            after = MonitorSampler.Snapshot();
            if (counter is not { } c || !pdh.Collect()) return null;
            var read = PdhQuery.Read(c);
            return read.Length > 0 ? Math.Round(read[0].Value, 0) : null;
        }
        catch (InvalidOperationException) { Thread.Sleep(700); after = MonitorSampler.Snapshot(); return null; }
    }
    private static Drive[] ReadDrives()
    {
        var media = DriveMedia();
        var system = Path.GetPathRoot(Environment.SystemDirectory)?.TrimEnd('\\');
        return [.. DriveInfo.GetDrives().Where(d => d.DriveType == DriveType.Fixed && d.IsReady).Select(d =>
        {
            var name = d.Name.TrimEnd('\\');
            return new Drive(name, d.TotalSize, d.AvailableFreeSpace, string.Equals(name, system, StringComparison.OrdinalIgnoreCase), media.GetValueOrDefault(name.TrimEnd(':'), "unknown"));
        })];
    }
    // Drive letter -> "ssd" / "hdd" through the Storage namespace (partition -> disk number -> physical disk media type).
    private static Dictionary<string, string> DriveMedia()
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var disks = Wmi(@"root\Microsoft\Windows\Storage", "SELECT DeviceId, MediaType FROM MSFT_PhysicalDisk")
            .ToDictionary(o => Convert.ToInt32(o["DeviceId"], CultureInfo.InvariantCulture), o => Convert.ToInt32(o["MediaType"] ?? 0, CultureInfo.InvariantCulture) switch { 3 => "hdd", 4 => "ssd", 5 => "ssd", _ => "unknown" });
        foreach (var p in Wmi(@"root\Microsoft\Windows\Storage", "SELECT DriveLetter, DiskNumber FROM MSFT_Partition"))
        {
            var letter = p["DriveLetter"] switch { char c when c != '\0' => c, ushort u when u != 0 => (char)u, _ => '\0' };
            if (letter == '\0' || p["DiskNumber"] is null) continue;
            if (disks.TryGetValue(Convert.ToInt32(p["DiskNumber"], CultureInfo.InvariantCulture), out var kind)) result[letter.ToString()] = kind;
        }
        return result;
    }
    private static int? Dword(RegistryKey root, string path, string name) { using var key = root.OpenSubKey(path, false); return key?.GetValue(name) is int v ? v : null; }
    private static bool? GameMode() => Dword(Registry.CurrentUser, @"Software\Microsoft\GameBar", "AutoGameModeEnabled") is { } v ? v != 0 : true;
    private static bool? Vbs(out bool? hvci)
    {
        hvci = null;
        var guard = Wmi(@"root\Microsoft\Windows\DeviceGuard", "SELECT VirtualizationBasedSecurityStatus, SecurityServicesRunning FROM Win32_DeviceGuard").FirstOrDefault();
        if (guard is null) return null;
        hvci = guard["SecurityServicesRunning"] is uint[] running && running.Contains(2u);
        return guard["VirtualizationBasedSecurityStatus"] is uint status ? status == 2 : null;
    }
    private static string[] PendingReboot()
    {
        var found = new List<string>();
        bool Exists(string path) { using var key = Registry.LocalMachine.OpenSubKey(path, false); return key is not null; }
        if (Exists(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending")) found.Add("Windows servicing");
        if (Exists(@"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired")) found.Add("Windows Update");
        using var session = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager", false);
        if (session?.GetValue("PendingFileRenameOperations") is string[] { Length: > 0 }) found.Add("a pending file replace");
        return [.. found];
    }
    private static string[] InstalledPackages()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages", false);
            return key?.GetSubKeyNames() ?? [];
        }
        catch (Exception error) when (error is System.Security.SecurityException or UnauthorizedAccessException or IOException) { return []; }
    }
    private static int StartupApps()
    {
        var count = 0;
        foreach (var (root, run, approved) in new[]
        {
            (Registry.CurrentUser, @"Software\Microsoft\Windows\CurrentVersion\Run", @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"),
            (Registry.LocalMachine, @"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", @"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"),
            (Registry.LocalMachine, @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run", @"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run32")
        })
        {
            using var key = root.OpenSubKey(run, false);
            using var gate = root.OpenSubKey(approved, false);
            foreach (var name in key?.GetValueNames() ?? [])
            {
                // StartupApproved: first byte 02/06 enabled, 03/07 disabled.
                var state = gate?.GetValue(name) as byte[];
                if (state is { Length: > 0 } && (state[0] & 1) == 1) continue;
                count++;
            }
        }
        return count;
    }
}
