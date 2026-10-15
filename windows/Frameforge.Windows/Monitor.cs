using System.Diagnostics;
using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Frameforge.Windows;

// Pure helpers for the live monitor and the game monitor; every parser here is unit tested with recorded counter names.
public static class MonitorMath
{
    private static readonly Regex Engine = new(@"\Apid_(\d+)_luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)_phys_(\d+)_eng_(\d+)_engtype_(.+)\z", RegexOptions.CultureInvariant);
    private static readonly Regex Memory = new(@"\Aluid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)_phys_\d+\z", RegexOptions.CultureInvariant);

    // "pid_4120_luid_0x00000000_0x0000F0F8_phys_0_eng_0_engtype_3D" -> pid, adapter, one engine's key and its Task Manager category. Null for engines that are not shown.
    public static (int Pid, string Luid, string EngineKey, string Category)? ParseEngine(string instance)
    {
        var m = Engine.Match(instance);
        if (!m.Success || !int.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var pid)) return null;
        var type = m.Groups[5].Value;
        var category = type.Equals("3D", StringComparison.OrdinalIgnoreCase) ? "3D"
            : type.StartsWith("Compute", StringComparison.OrdinalIgnoreCase) ? "Compute"
            : type.StartsWith("Copy", StringComparison.OrdinalIgnoreCase) ? "Copy"
            : type.StartsWith("Video", StringComparison.OrdinalIgnoreCase) ? "Video" : null;
        if (category is null) return null;
        var luid = m.Groups[2].Value.ToLowerInvariant();
        return (pid, luid, $"{luid}/{m.Groups[3].Value}/{m.Groups[4].Value}/{type}", category);
    }
    public static string? ParseMemoryAdapter(string instance) => Memory.Match(instance) is { Success: true } m ? m.Groups[1].Value.ToLowerInvariant() : null;

    // Task Manager's rule: one engine's load is the sum over processes; a category shows its busiest engine. onlyPid limits it to one process.
    public static Dictionary<string, Dictionary<string, double>> GpuUsage(IEnumerable<(string Instance, double Value)> engines, int? onlyPid = null)
    {
        var perEngine = new Dictionary<string, (string Luid, string Category, double Sum)>();
        foreach (var (instance, value) in engines)
        {
            if (ParseEngine(instance) is not var (pid, luid, key, category) || (onlyPid is { } only && pid != only) || double.IsNaN(value)) continue;
            perEngine[key] = (luid, category, (perEngine.TryGetValue(key, out var old) ? old.Sum : 0) + Math.Max(0, value));
        }
        var result = new Dictionary<string, Dictionary<string, double>>();
        foreach (var (luid, category, sum) in perEngine.Values)
        {
            if (!result.TryGetValue(luid, out var categories)) result[luid] = categories = new() { ["3D"] = 0, ["Compute"] = 0, ["Copy"] = 0, ["Video"] = 0 };
            categories[category] = Math.Round(Math.Min(100, Math.Max(categories[category], sum)), 1);
        }
        return result;
    }
    // A game's GPU share is its busiest engine on any adapter.
    public static double GpuPercentOf(Dictionary<string, Dictionary<string, double>> usage) => usage.Values.SelectMany(c => c.Values).DefaultIfEmpty(0).Max();

    public static bool PseudoAdapter(string name) =>
        new[] { "loopback", "isatap", "teredo", "6to4", "pseudo" }.Any(w => name.Contains(w, StringComparison.OrdinalIgnoreCase));

    // nvidia-smi --query-gpu=name,temperature.gpu --format=csv,noheader,nounits
    public static (string Name, double Celsius)[] ParseNvidiaSmi(string text)
    {
        var found = new List<(string, double)>();
        foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var comma = line.LastIndexOf(',');
            if (comma <= 0 || !double.TryParse(line[(comma + 1)..].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var c) || c is < 0 or > 150) continue;
            found.Add((line[..comma].Trim(), c));
        }
        return [.. found];
    }
    // MSAcpi_ThermalZoneTemperature reports tenths of a kelvin. Zones that read nonsense (many boards report a fixed value) are dropped.
    public static double? AcpiCelsius(IEnumerable<double> tenthsKelvin)
    {
        var plausible = tenthsKelvin.Select(t => t / 10 - 273.15).Where(c => c is > 5 and < 120).ToArray();
        return plausible.Length == 0 ? null : Math.Round(plausible.Max(), 1);
    }
}

public sealed record ProcessUsage(string Name, int Count, double CpuPercent, long WorkingSetBytes);

// Turns two reads of cumulative process CPU time into percentages of the whole machine, grouped by program name.
public sealed class ProcessTracker
{
    private Dictionary<int, long> previous = [];
    private long previousAt;
    public (ProcessUsage[] ByCpu, ProcessUsage[] ByMemory) Update(IReadOnlyList<(int Pid, string Name, long CpuTicks, long WorkingSet)> now, long at, int cores, int top = 8)
    {
        var elapsed = previousAt == 0 ? 0 : at - previousAt;
        var groups = new Dictionary<string, (int Count, double Cpu, long Memory)>(StringComparer.OrdinalIgnoreCase);
        foreach (var (pid, name, ticks, memory) in now)
        {
            var cpu = elapsed > 0 && previous.TryGetValue(pid, out var before) && ticks >= before ? 100.0 * (ticks - before) / (elapsed * Math.Max(1, cores)) : 0;
            var old = groups.GetValueOrDefault(name);
            groups[name] = (old.Count + 1, old.Cpu + cpu, old.Memory + memory);
        }
        previous = now.ToDictionary(p => p.Pid, p => p.CpuTicks);
        previousAt = at;
        var all = groups.Select(g => new ProcessUsage(g.Key.Length > 64 ? g.Key[..64] : g.Key, g.Value.Count, Math.Round(Math.Min(100, g.Value.Cpu), 1), g.Value.Memory)).ToArray();
        return ([.. all.OrderByDescending(p => p.CpuPercent).ThenByDescending(p => p.WorkingSetBytes).Take(top)], [.. all.OrderByDescending(p => p.WorkingSetBytes).Take(top)]);
    }
}

// Windows performance counters through PDH (the API behind Get-Counter and Task Manager). Counter paths are English whatever the display language.
public sealed class PdhQuery : IDisposable
{
    private IntPtr query;
    public PdhQuery() { if (PdhOpenQuery(null, IntPtr.Zero, out query) != 0) throw new InvalidOperationException("Windows performance counters are not available."); }
    // Null when this PC has no such counter (for example GPU counters without a WDDM 2 driver).
    public IntPtr? Add(string path) => PdhAddEnglishCounterW(query, path, IntPtr.Zero, out var counter) == 0 ? counter : null;
    public bool Collect() => PdhCollectQueryData(query) == 0;
    [StructLayout(LayoutKind.Sequential)] private struct Item { public IntPtr Name; public uint Status; public double Value; }
    public static (string Name, double Value)[] Read(IntPtr counter)
    {
        uint size = 0, count = 0;
        if (PdhGetFormattedCounterArrayW(counter, 0x200, ref size, ref count, IntPtr.Zero) != 0x800007D2 || size == 0 || size > 16 * 1024 * 1024) return [];
        var buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            if (PdhGetFormattedCounterArrayW(counter, 0x200, ref size, ref count, buffer) != 0) return [];
            var items = new List<(string, double)>();
            var stride = Marshal.SizeOf<Item>();
            for (var i = 0; i < count; i++)
            {
                var item = Marshal.PtrToStructure<Item>(buffer + i * stride);
                if (item.Status is 0 or 1 && Marshal.PtrToStringUni(item.Name) is { } name) items.Add((name, item.Value));
            }
            return [.. items];
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    public void Dispose() { if (query != IntPtr.Zero) { PdhCloseQuery(query); query = IntPtr.Zero; } }
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] private static extern uint PdhOpenQuery(string? source, IntPtr user, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] private static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr user, out IntPtr counter);
    [DllImport("pdh.dll")] private static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll")] private static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint size, ref uint count, IntPtr buffer);
    [DllImport("pdh.dll")] private static extern uint PdhCloseQuery(IntPtr query);
}

// Kernel drivers are never installed to read sensors. What Windows exposes to a normal user: nvidia-smi when the NVIDIA driver ships it, and the ACPI thermal zone when readable.
public sealed class TemperatureReader
{
    private (string Name, double Celsius)[] gpu = [];
    private double? acpi;
    private long refreshedAt;
    private int running;
    private bool acpiDenied;
    public object Read()
    {
        if (Environment.TickCount64 - refreshedAt > 5000 && Interlocked.Exchange(ref running, 1) == 0) Task.Run(Refresh);
        return new
        {
            gpu = gpu.Select(g => new { name = g.Name, celsius = g.Celsius }).ToArray(),
            cpuCelsius = acpi,
            note = gpu.Length == 0 && acpi is null ? "Not available without a kernel driver. Frameforge does not install one." : (string?)null
        };
    }
    private void Refresh()
    {
        try { gpu = Nvidia(); } catch (Exception error) when (error is IOException or System.ComponentModel.Win32Exception or InvalidOperationException) { gpu = []; }
        if (!acpiDenied)
        {
            try
            {
                using var searcher = new ManagementObjectSearcher(@"root\wmi", "SELECT CurrentTemperature FROM MSAcpi_ThermalZoneTemperature");
                acpi = MonitorMath.AcpiCelsius(searcher.Get().Cast<ManagementObject>().Select(o => Convert.ToDouble(o["CurrentTemperature"], CultureInfo.InvariantCulture)));
            }
            catch (Exception error) when (error is ManagementException or UnauthorizedAccessException or COMException or InvalidCastException or FormatException) { acpi = null; acpiDenied = true; }
        }
        refreshedAt = Environment.TickCount64;
        Volatile.Write(ref running, 0);
    }
    private static (string, double)[] Nvidia()
    {
        var exe = new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"), Path.Combine(Environment.SystemDirectory, "nvidia-smi.exe") }.FirstOrDefault(File.Exists);
        if (exe is null) return [];
        using var process = Process.Start(new ProcessStartInfo(exe, "--query-gpu=name,temperature.gpu --format=csv,noheader,nounits") { RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true });
        if (process is null) return [];
        var output = process.StandardOutput.ReadToEndAsync();
        if (!process.WaitForExit(3000)) { try { process.Kill(); } catch (InvalidOperationException) { } return []; }
        return MonitorMath.ParseNvidiaSmi(output.Result);
    }
}

public sealed class MonitorSampler : IDisposable
{
    private readonly PdhQuery pdh = new();
    private readonly IntPtr? cpu, cpuPerformance, engines, dedicated, shared, diskRead, diskWrite, diskBusy, netRx, netTx, netBandwidth;
    private readonly ProcessTracker processes = new();
    private readonly TemperatureReader temperatures = new();
    public MonitorSampler()
    {
        cpu = pdh.Add(@"\Processor(*)\% Processor Time");
        cpuPerformance = pdh.Add(@"\Processor Information(_Total)\% Processor Performance");
        engines = pdh.Add(@"\GPU Engine(*)\Utilization Percentage");
        dedicated = pdh.Add(@"\GPU Adapter Memory(*)\Dedicated Usage");
        shared = pdh.Add(@"\GPU Adapter Memory(*)\Shared Usage");
        diskRead = pdh.Add(@"\PhysicalDisk(*)\Disk Read Bytes/sec");
        diskWrite = pdh.Add(@"\PhysicalDisk(*)\Disk Write Bytes/sec");
        diskBusy = pdh.Add(@"\PhysicalDisk(*)\% Disk Time");
        netRx = pdh.Add(@"\Network Interface(*)\Bytes Received/sec");
        netTx = pdh.Add(@"\Network Interface(*)\Bytes Sent/sec");
        netBandwidth = pdh.Add(@"\Network Interface(*)\Current Bandwidth");
        pdh.Collect(); // Rate counters need a first read to measure against.
        Prime();
    }
    private static long Now100ns() => Stopwatch.GetTimestamp() * 10_000_000L / Stopwatch.Frequency;
    private void Prime() => processes.Update(Snapshot(), Now100ns(), Environment.ProcessorCount);
    private static (string Name, double Value)[] Read(IntPtr? counter) => counter is { } c ? PdhQuery.Read(c) : [];
    private static Dictionary<string, double> ByName(IntPtr? counter) => Read(counter).GroupBy(r => r.Name).ToDictionary(g => g.Key, g => g.First().Value);
    private static double Percent(double value) => Math.Round(Math.Clamp(value, 0, 100), 1);

    internal static List<(int Pid, string Name, long CpuTicks, long WorkingSet)> Snapshot()
    {
        var list = new List<(int, string, long, long)>();
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                try
                {
                    if (process.Id == 0) continue;
                    list.Add((process.Id, process.ProcessName, process.TotalProcessorTime.Ticks, process.WorkingSet64));
                }
                catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException or NotSupportedException) { /* Protected or just exited: left out. */ }
            }
        }
        return list;
    }

    public object Sample()
    {
        var ok = pdh.Collect();
        var cores = Read(cpu);
        var perCore = cores.Where(c => c.Name != "_Total" && int.TryParse(c.Name, out _)).OrderBy(c => int.Parse(c.Name, CultureInfo.InvariantCulture)).Select(c => Percent(c.Value)).ToArray();
        var total = cores.Where(c => c.Name == "_Total").Select(c => Percent(c.Value)).DefaultIfEmpty(perCore.Length > 0 ? Math.Round(perCore.Average(), 1) : 0).First();
        var memory = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
        GlobalMemoryStatusEx(ref memory);

        object gpu;
        if (engines is null) gpu = new { available = false, detail = "This PC does not expose GPU performance counters (a WDDM 2.0 or newer graphics driver provides them).", adapters = Array.Empty<object>() };
        else
        {
            var load = MonitorMath.GpuUsage(Read(engines));
            var dedicatedUse = Read(dedicated).Select(r => (Luid: MonitorMath.ParseMemoryAdapter(r.Name), r.Value)).Where(r => r.Luid is not null).GroupBy(r => r.Luid!).ToDictionary(g => g.Key, g => g.Sum(r => r.Value));
            var sharedUse = Read(shared).Select(r => (Luid: MonitorMath.ParseMemoryAdapter(r.Name), r.Value)).Where(r => r.Luid is not null).GroupBy(r => r.Luid!).ToDictionary(g => g.Key, g => g.Sum(r => r.Value));
            var ids = load.Keys.Concat(dedicatedUse.Keys).Concat(sharedUse.Keys).Distinct()
                // Virtual adapters (Microsoft Basic Render and similar) hold almost no memory; a real GPU holds dedicated memory or a visible share.
                .Where(id => dedicatedUse.GetValueOrDefault(id) > 0 || sharedUse.GetValueOrDefault(id) >= 64 * 1024 * 1024)
                .OrderBy(k => k, StringComparer.Ordinal).Take(4).ToArray();
            gpu = new
            {
                available = true,
                detail = (string?)null,
                adapters = ids.Select(id => new
                {
                    id,
                    engine3d = load.GetValueOrDefault(id)?["3D"] ?? 0,
                    compute = load.GetValueOrDefault(id)?["Compute"] ?? 0,
                    copy = load.GetValueOrDefault(id)?["Copy"] ?? 0,
                    video = load.GetValueOrDefault(id)?["Video"] ?? 0,
                    dedicatedBytes = (long)dedicatedUse.GetValueOrDefault(id),
                    sharedBytes = (long)sharedUse.GetValueOrDefault(id)
                }).ToArray()
            };
        }

        var read = ByName(diskRead); var write = ByName(diskWrite); var busy = ByName(diskBusy);
        var disks = read.Keys.Where(n => n != "_Total").OrderBy(n => n, StringComparer.OrdinalIgnoreCase).Take(8)
            .Select(n => new { name = n, readBytesPerSec = (long)read[n], writeBytesPerSec = (long)write.GetValueOrDefault(n), activePercent = Percent(busy.GetValueOrDefault(n)) }).ToArray();

        var rx = ByName(netRx); var tx = ByName(netTx); var bandwidth = ByName(netBandwidth);
        var network = rx.Keys.Where(n => !MonitorMath.PseudoAdapter(n) && bandwidth.GetValueOrDefault(n) > 0)
            .OrderByDescending(n => rx[n] + tx.GetValueOrDefault(n)).ThenBy(n => n, StringComparer.OrdinalIgnoreCase).Take(4)
            .Select(n => new { name = n.Length > 80 ? n[..80] : n, downBytesPerSec = (long)rx[n], upBytesPerSec = (long)tx.GetValueOrDefault(n), linkBitsPerSec = (long)bandwidth.GetValueOrDefault(n) }).ToArray();

        var (byCpu, byMemory) = processes.Update(Snapshot(), Now100ns(), Environment.ProcessorCount);
        return new
        {
            @event = "sample",
            at = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            counters = ok,
            cpu = new { total, cores = perCore, performance = Read(cpuPerformance).Where(r => r.Name == "_Total").Select(r => (double?)Math.Round(Math.Clamp(r.Value, 0, 1000))).FirstOrDefault() },
            memory = new { totalBytes = (long)memory.TotalPhysical, availableBytes = (long)memory.AvailablePhysical },
            gpu,
            disks,
            network,
            processes = new { byCpu, byMemory },
            temperatures = temperatures.Read()
        };
    }
    public void Dispose() => pdh.Dispose();
    [StructLayout(LayoutKind.Sequential)]
    internal struct MemoryStatus { public uint Length, MemoryLoad; public ulong TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile, TotalVirtual, AvailableVirtual, AvailableExtendedVirtual; }
    [DllImport("kernel32.dll")] internal static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
}

// One running program's share, for the game monitor.
public sealed class GameUsageSampler : IDisposable
{
    private readonly int pid;
    private readonly PdhQuery pdh = new();
    private readonly IntPtr? engines;
    private TimeSpan cpuBefore; private long at;
    public GameUsageSampler(int pid)
    {
        this.pid = pid;
        engines = pdh.Add(@"\GPU Engine(*)\Utilization Percentage");
        pdh.Collect();
        (cpuBefore, at) = (Cpu(), Stopwatch.GetTimestamp());
    }
    private TimeSpan Cpu() { try { using var p = Process.GetProcessById(pid); return p.TotalProcessorTime; } catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { return cpuBefore; } }
    public object Sample()
    {
        var now = Stopwatch.GetTimestamp();
        var cpu = Cpu();
        var seconds = (now - at) / (double)Stopwatch.Frequency;
        var percent = seconds > 0 ? (cpu - cpuBefore).TotalSeconds / seconds / Environment.ProcessorCount * 100 : 0;
        (cpuBefore, at) = (cpu, now);
        long ws = 0;
        try { using var p = Process.GetProcessById(pid); ws = p.WorkingSet64; } catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { }
        double? gpu = null;
        if (engines is { } e && pdh.Collect()) gpu = Math.Round(MonitorMath.GpuPercentOf(MonitorMath.GpuUsage(PdhQuery.Read(e), pid)), 1);
        return new { @event = "usage", cpuPercent = Math.Round(Math.Clamp(percent, 0, 100), 1), workingSetBytes = ws, gpuPercent = gpu };
    }
    public void Dispose() => pdh.Dispose();
}

public static class MonitorHost
{
    // One sample a second until Frameforge says "stop", closes the pipe or exits. The page being hidden stops the whole process, so nothing runs in the background.
    public static void Run(TextReader input, Action<object> write, Func<object> sample, int intervalMs = 1000)
    {
        var done = new ManualResetEventSlim();
        Task.Run(() =>
        {
            try { while (input.ReadLine() is { } line) if (line.Contains("\"stop\"", StringComparison.Ordinal)) break; }
            catch (IOException) { }
            done.Set();
        });
        write(new { @event = "ready" });
        while (!done.Wait(intervalMs)) write(sample());
    }
    public static void Host()
    {
        var gate = new object();
        void Write(object value) { lock (gate) { try { Console.Out.WriteLine(JsonSerializer.Serialize(value, value.GetType(), HelperJson.Options)); Console.Out.Flush(); } catch (IOException) { } } }
        using var sampler = new MonitorSampler();
        Run(Console.In, Write, sampler.Sample);
    }
}
