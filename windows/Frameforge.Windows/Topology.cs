using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Frameforge.Windows;

// One logical processor. EfficiencyClass is Windows' own number: the highest class on a hybrid CPU is the performance class.
public record LogicalCpu(int Group, int Index, int Core, int EfficiencyClass, int CpuSetId);
public record CpuTopology(bool Hybrid, int PerformanceCores, int PerformanceThreads, int EfficiencyCores, int EfficiencyThreads, bool DualCcdX3d, string Summary);
public interface ICpuTopology { string CpuName { get; } LogicalCpu[] Cpus(); }
public interface ICpuSets
{
    // The process's default CPU set ids; empty when none is set.
    int[] Get(ProcessTarget identity);
    // An empty array clears the default CPU set.
    void Set(ProcessTarget identity, int[] ids);
}

// Pure decisions about the CPU layout, so they are testable without Windows.
public static class SmartCores
{
    public const int MinPerformanceThreads = 6;
    private static readonly Regex DualCcd = new(@"\b(?:79[05]0|99[05]0)X3D\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    // ponytail: matched by model name; read the L3 layout (one cache per CCD) if AMD ships another dual-CCD X3D part.
    public static bool IsDualCcdX3d(string cpuName) => DualCcd.IsMatch(cpuName ?? "");
    public static CpuTopology Describe(string cpuName, LogicalCpu[] cpus)
    {
        var classes = cpus.Select(c => c.EfficiencyClass).Distinct().Order().ToArray();
        var dual = IsDualCcdX3d(cpuName);
        if (classes.Length < 2)
            return new(false, 0, 0, 0, 0, dual, $"{cpus.Select(c => (c.Group, c.Core)).Distinct().Count()} cores, {cpus.Length} threads; all cores are the same type (not a hybrid CPU).");
        var best = classes[^1];
        var performance = cpus.Where(c => c.EfficiencyClass == best).ToArray();
        var efficiency = cpus.Where(c => c.EfficiencyClass != best).ToArray();
        int Cores(IEnumerable<LogicalCpu> set) => set.Select(c => (c.Group, c.Core)).Distinct().Count();
        var p = Cores(performance); var e = Cores(efficiency);
        return new(true, p, performance.Length, e, efficiency.Length, dual, $"{p} performance cores ({performance.Length} threads) + {e} efficiency cores ({efficiency.Length} threads).");
    }
    // Null reason means the game can be limited to the performance cores; ids are the CPU set ids to use.
    public static (int[] Ids, string? Skip) Plan(string cpuName, LogicalCpu[] cpus)
    {
        if (IsDualCcdX3d(cpuName)) return ([], "Dual-CCD Ryzen X3D parts rely on AMD's V-Cache driver to choose the game's cores; Frameforge does not override it.");
        var topology = Describe(cpuName, cpus);
        if (!topology.Hybrid) return ([], "This CPU is not hybrid (all cores are the same type), so there is nothing to target.");
        if (topology.PerformanceThreads < MinPerformanceThreads) return ([], $"Only {topology.PerformanceThreads} performance-core threads; fewer than {MinPerformanceThreads} could hurt CPU-heavy games.");
        var best = cpus.Max(c => c.EfficiencyClass);
        return (cpus.Where(c => c.EfficiencyClass == best).Select(c => c.CpuSetId).Order().ToArray(), null);
    }
}

public sealed class WindowsCpuTopology : ICpuTopology
{
    public string CpuName
    {
        get
        {
            try { return Registry.GetValue(@"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString", null) as string ?? ""; }
            catch (Exception error) when (error is System.Security.SecurityException or IOException or UnauthorizedAccessException) { return ""; }
        }
    }
    public LogicalCpu[] Cpus()
    {
        var sets = CpuSetEntries();
        var result = new List<LogicalCpu>();
        var core = 0;
        foreach (var (efficiency, groups) in Cores())
        {
            foreach (var (group, mask) in groups)
                for (var bit = 0; bit < 64; bit++)
                    if ((mask >> bit & 1) == 1)
                        result.Add(new(group, bit, core, efficiency, sets.TryGetValue((group, bit), out var id) ? id : throw new InvalidOperationException("Windows did not list a CPU set for every logical processor.")));
            core++;
        }
        return [.. result];
    }
    // GetLogicalProcessorInformationEx(RelationProcessorCore): per core, EfficiencyClass and the group masks of its logical processors.
    private static List<(int Efficiency, List<(int Group, ulong Mask)> Groups)> Cores()
    {
        uint size = 0;
        GetLogicalProcessorInformationEx(0, IntPtr.Zero, ref size);
        if (size == 0 || size > 1 << 20) throw new Win32Exception(Marshal.GetLastWin32Error());
        var buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            if (!GetLogicalProcessorInformationEx(0, buffer, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var cores = new List<(int, List<(int, ulong)>)>();
            for (var offset = 0; offset + 32 <= size;)
            {
                var length = Marshal.ReadInt32(buffer, offset + 4);
                if (length < 32 || offset + length > size) throw new InvalidOperationException("Windows returned an unreadable processor list.");
                if (Marshal.ReadInt32(buffer, offset) == 0)
                {
                    var efficiency = Marshal.ReadByte(buffer, offset + 9);
                    var groups = new List<(int, ulong)>();
                    var count = (ushort)Marshal.ReadInt16(buffer, offset + 30);
                    for (var g = 0; g < count; g++)
                        groups.Add(((ushort)Marshal.ReadInt16(buffer, offset + 32 + g * 16 + 8), (ulong)Marshal.ReadInt64(buffer, offset + 32 + g * 16)));
                    cores.Add((efficiency, groups));
                }
                offset += length;
            }
            return cores;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    // GetSystemCpuSetInformation: SYSTEM_CPU_SET_INFORMATION is 32 bytes: Size@0 Type@4 Id@8 Group@12 LogicalProcessorIndex@14.
    private static Dictionary<(int Group, int Index), int> CpuSetEntries()
    {
        uint size = 0;
        GetSystemCpuSetInformation(IntPtr.Zero, 0, out size, IntPtr.Zero, 0);
        if (size == 0 || size > 1 << 20) throw new Win32Exception(Marshal.GetLastWin32Error());
        var buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            if (!GetSystemCpuSetInformation(buffer, size, out size, IntPtr.Zero, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var result = new Dictionary<(int, int), int>();
            for (var offset = 0; offset + 32 <= size;)
            {
                var length = Marshal.ReadInt32(buffer, offset);
                if (length < 32 || offset + length > size) throw new InvalidOperationException("Windows returned an unreadable CPU set list.");
                if (Marshal.ReadInt32(buffer, offset + 4) == 0)
                    result[((ushort)Marshal.ReadInt16(buffer, offset + 12), Marshal.ReadByte(buffer, offset + 14))] = Marshal.ReadInt32(buffer, offset + 8);
                offset += length;
            }
            return result;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetLogicalProcessorInformationEx(int relationship, IntPtr buffer, ref uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetSystemCpuSetInformation(IntPtr information, uint length, out uint returned, IntPtr process, uint flags);
}

public sealed class WindowsCpuSets : ICpuSets
{
    private const uint SetLimited = 0x2000;
    public int[] Get(ProcessTarget identity)
    {
        using var handle = WindowsProcessControl.Verified(identity, 0);
        GetProcessDefaultCpuSets(handle, null, 0, out var required);
        if (required == 0) return [];
        if (required > 4096) throw new InvalidOperationException("Windows reported an unexpected number of CPU sets.");
        var ids = new uint[required];
        if (!GetProcessDefaultCpuSets(handle, ids, required, out required)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return ids.Take((int)required).Select(i => (int)i).ToArray();
    }
    public void Set(ProcessTarget identity, int[] ids)
    {
        using var handle = WindowsProcessControl.Verified(identity, SetLimited);
        var values = ids.Select(i => (uint)i).ToArray();
        if (!SetProcessDefaultCpuSets(handle, values.Length == 0 ? null : values, (uint)values.Length)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessDefaultCpuSets(Microsoft.Win32.SafeHandles.SafeProcessHandle process, uint[]? ids, uint count, out uint required);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetProcessDefaultCpuSets(Microsoft.Win32.SafeHandles.SafeProcessHandle process, uint[]? ids, uint count);
}
