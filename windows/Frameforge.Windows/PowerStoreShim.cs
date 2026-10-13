using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Frameforge.Windows;

// MERGE NOTE: verbatim copy of IPowerStore + WindowsPowerStore from Task 4's BoostSession.cs.
// When Task 4 merges, the duplicate types fail with CS0101: delete this whole file and keep Task 4's.
public interface IPowerStore { Guid Active(); bool Exists(Guid scheme); void SetActive(Guid scheme); Guid Duplicate(Guid source, string name); void Delete(Guid scheme); }

public sealed class WindowsPowerStore : IPowerStore
{
    public Guid Active()
    {
        var error = PowerGetActiveScheme(IntPtr.Zero, out var pointer);
        if (error != 0) throw new Win32Exception((int)error);
        try { return Marshal.PtrToStructure<Guid>(pointer); } finally { LocalFree(pointer); }
    }
    public bool Exists(Guid scheme)
    {
        var buffer = Marshal.AllocHGlobal(16);
        try
        {
            for (uint index = 0; ; index++)
            {
                uint size = 16;
                var error = PowerEnumerate(IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 16, index, buffer, ref size);
                if (error == 259) return false;
                if (error != 0) throw new Win32Exception((int)error);
                if (Marshal.PtrToStructure<Guid>(buffer) == scheme) return true;
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    // Same API powercfg /setactive uses; only existing schemes are accepted.
    public void SetActive(Guid scheme)
    {
        if (!Exists(scheme)) throw new InvalidOperationException("That power plan is not present.");
        var error = PowerSetActiveScheme(IntPtr.Zero, ref scheme);
        if (error != 0) throw new Win32Exception((int)error);
    }
    // Same as powercfg /duplicatescheme, in-process: the new plan gets a fresh GUID and a Frameforge name.
    public Guid Duplicate(Guid source, string name)
    {
        var pointer = IntPtr.Zero;
        var error = PowerDuplicateScheme(IntPtr.Zero, ref source, ref pointer);
        if (error != 0) throw new Win32Exception((int)error);
        Guid created;
        try { created = Marshal.PtrToStructure<Guid>(pointer); } finally { LocalFree(pointer); }
        var text = System.Text.Encoding.Unicode.GetBytes(name + "\0");
        PowerWriteFriendlyName(IntPtr.Zero, ref created, IntPtr.Zero, IntPtr.Zero, text, (uint)text.Length);
        return created;
    }
    public void Delete(Guid scheme)
    {
        var error = PowerDeleteScheme(IntPtr.Zero, ref scheme);
        if (error != 0) throw new Win32Exception((int)error);
    }
    [DllImport("powrprof.dll")] private static extern uint PowerDuplicateScheme(IntPtr root, ref Guid source, ref IntPtr destination);
    [DllImport("powrprof.dll")] private static extern uint PowerDeleteScheme(IntPtr root, ref Guid scheme);
    [DllImport("powrprof.dll")] private static extern uint PowerWriteFriendlyName(IntPtr root, ref Guid scheme, IntPtr subgroup, IntPtr setting, byte[] buffer, uint size);
    [DllImport("powrprof.dll")] private static extern uint PowerGetActiveScheme(IntPtr root, out IntPtr scheme);
    [DllImport("powrprof.dll")] private static extern uint PowerSetActiveScheme(IntPtr root, ref Guid scheme);
    [DllImport("powrprof.dll")] private static extern uint PowerEnumerate(IntPtr root, IntPtr scheme, IntPtr subgroup, uint flags, uint index, IntPtr buffer, ref uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
}
