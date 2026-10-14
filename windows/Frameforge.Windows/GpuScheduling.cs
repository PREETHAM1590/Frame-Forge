using System.Runtime.InteropServices;

namespace Frameforge.Windows;

/// <summary>Read-only WDDM 2.7 capability query. A registry override alone never proves GPU/driver support.</summary>
public static class GpuScheduling
{
    // Windows SDK d3dkmthk.h / d3dkmdt.h: KMTQAITYPE_WDDM_2_7_CAPS=70, HwSchSupported is bit 0.
    [StructLayout(LayoutKind.Sequential)]
    private struct Adapter { public uint Handle; public uint LuidLow; public int LuidHigh; public uint Sources; public int PreciseRegions; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Enumeration { public uint Count; public IntPtr Adapters; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Query { public uint Handle; public int Type; public IntPtr Data; public uint Size; }
    [DllImport("gdi32.dll")] private static extern int D3DKMTEnumAdapters2(ref Enumeration adapters);
    [DllImport("gdi32.dll")] private static extern int D3DKMTQueryAdapterInfo(ref Query query);
    [DllImport("gdi32.dll")] private static extern int D3DKMTCloseAdapter(ref uint handle);

    public static bool Supported()
    {
        if (!OperatingSystem.IsWindows() || Environment.OSVersion.Version.Build < 19041) return false;
        const int capacity = 64;
        var stride = Marshal.SizeOf<Adapter>();
        var buffer = Marshal.AllocHGlobal(capacity * stride);
        var caps = Marshal.AllocHGlobal(sizeof(uint));
        var enumeration = new Enumeration { Count = capacity, Adapters = buffer };
        var opened = false;
        try
        {
            if (D3DKMTEnumAdapters2(ref enumeration) != 0) return false;
            opened = true;
            if (enumeration.Count > capacity) return false;
            for (var i = 0; i < enumeration.Count; i++)
            {
                var adapter = Marshal.PtrToStructure<Adapter>(IntPtr.Add(buffer, i * stride));
                Marshal.WriteInt32(caps, 0);
                var query = new Query { Handle = adapter.Handle, Type = 70, Data = caps, Size = sizeof(uint) };
                if (D3DKMTQueryAdapterInfo(ref query) == 0 && (Marshal.ReadInt32(caps) & 1) != 0) return true;
            }
            return false;
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException or ExternalException) { return false; }
        finally
        {
            if (opened)
                for (var i = 0; i < Math.Min(enumeration.Count, capacity); i++)
                {
                    var adapter = Marshal.PtrToStructure<Adapter>(IntPtr.Add(buffer, i * stride));
                    if (adapter.Handle != 0) D3DKMTCloseAdapter(ref adapter.Handle);
                }
            Marshal.FreeHGlobal(caps);
            Marshal.FreeHGlobal(buffer);
        }
    }
}
