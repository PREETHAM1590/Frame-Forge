using System.Runtime.InteropServices;

namespace Frameforge.Windows;

/// <summary>
/// The NVIDIA driver's global (base) profile, read and written one DWORD setting at a time through NVAPI's driver settings (DRS) interface.
/// Get returns null when the profile holds no value of its own for the setting (the driver default applies); Delete puts it back to that state.
/// </summary>
public interface INvidiaProfile
{
    bool Available();
    uint? Get(uint settingId);
    void Set(uint settingId, uint value);
    void Delete(uint settingId);
}

/// <summary>The only NVAPI settings Frameforge reads or writes, with the public NvApiDriverSettings.h value each one is set to.</summary>
public static class NvidiaSettings
{
    public const uint PreferredPstate = 0x1057EB71, PrerenderLimit = 0x007BA09E;
    public static readonly uint[] Allowed = [PreferredPstate, PrerenderLimit];
    public static string Name(uint id) => $"0x{id:X8}";
    public static bool TryParse(string name, out uint id)
    {
        id = 0;
        return name.Length == 10 && name.StartsWith("0x", StringComparison.Ordinal) && uint.TryParse(name[2..], System.Globalization.NumberStyles.AllowHexSpecifier, null, out id) && Allowed.Contains(id);
    }
    public static string Describe(uint id) => id == PreferredPstate
        ? "NVIDIA global profile, Power management mode (1 = Prefer maximum performance)"
        : "NVIDIA global profile, Maximum pre-rendered frames (1 = one frame ahead)";
}

/// <summary>NVAPI through nvapi64.dll's single exported entry point; the driver ships the DLL, and every call fails cleanly when it is absent.</summary>
public sealed class NvApiProfile : INvidiaProfile
{
    private const int Ok = 0, SettingNotFound = -160, StructSize = 12320, Version = 0x13020, SettingId = 4100, SettingType = 4104, CurrentValue = 8220;
    [DllImport("nvapi64.dll", EntryPoint = "nvapi_QueryInterface", CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr QueryInterface(uint id);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int Init();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int NewSession(out IntPtr session);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int OnSession(IntPtr session);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int BaseProfile(IntPtr session, out IntPtr profile);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int GetSetting(IntPtr session, IntPtr profile, uint id, IntPtr setting, ref uint count);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int SetSetting(IntPtr session, IntPtr profile, IntPtr setting);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int DeleteSetting(IntPtr session, IntPtr profile, uint id);

    private static T Fn<T>(uint id) where T : Delegate
    {
        IntPtr pointer;
        try { pointer = QueryInterface(id); } catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException) { throw new InvalidOperationException("The NVIDIA driver settings interface is not available on this PC.", error); }
        return pointer == IntPtr.Zero ? throw new InvalidOperationException("The NVIDIA driver does not offer this settings call.") : Marshal.GetDelegateForFunctionPointer<T>(pointer);
    }
    private static void Check(int result, string what) { if (result != Ok) throw new InvalidOperationException($"The NVIDIA driver refused to {what} (NVAPI status {result})."); }

    private static T WithSession<T>(Func<IntPtr, IntPtr, T> use)
    {
        Check(Fn<Init>(0x0150E828)(), "start its settings interface");
        Check(Fn<NewSession>(0x0694D52E)(out var session), "open a settings session");
        try
        {
            Check(Fn<OnSession>(0x375DBD6B)(session), "load its profiles");
            Check(Fn<BaseProfile>(0xDA8466A0)(session, out var profile), "find the global profile");
            return use(session, profile);
        }
        finally { Fn<OnSession>(0xDAD9CFF8)(session); }
    }
    private static IntPtr Buffer(uint id)
    {
        var buffer = Marshal.AllocHGlobal(StructSize);
        for (var i = 0; i < StructSize; i += 4) Marshal.WriteInt32(buffer, i, 0);
        Marshal.WriteInt32(buffer, 0, Version); Marshal.WriteInt32(buffer, SettingId, (int)id);
        return buffer;
    }

    public bool Available()
    {
        try { return WithSession((_, _) => true); } catch (InvalidOperationException) { return false; }
    }
    public uint? Get(uint settingId)
    {
        if (!NvidiaSettings.Allowed.Contains(settingId)) throw new InvalidOperationException("Unsupported NVIDIA setting.");
        return WithSession<uint?>((session, profile) =>
        {
            var buffer = Buffer(settingId);
            try
            {
                uint count = 0;
                var result = Fn<GetSetting>(0x73BF8338)(session, profile, settingId, buffer, ref count);
                if (result == SettingNotFound) return null;
                Check(result, "read a setting");
                if (Marshal.ReadInt32(buffer, SettingType) != 0) throw new InvalidOperationException("The NVIDIA setting has an unexpected type.");
                return (uint)Marshal.ReadInt32(buffer, CurrentValue);
            }
            finally { Marshal.FreeHGlobal(buffer); }
        });
    }
    public void Set(uint settingId, uint value)
    {
        if (!NvidiaSettings.Allowed.Contains(settingId)) throw new InvalidOperationException("Unsupported NVIDIA setting.");
        WithSession((session, profile) =>
        {
            var buffer = Buffer(settingId);
            try
            {
                Marshal.WriteInt32(buffer, SettingType, 0); Marshal.WriteInt32(buffer, CurrentValue, (int)value);
                Check(Fn<SetSetting>(0x577DD202)(session, profile, buffer), "write a setting");
                Check(Fn<OnSession>(0xFCBC7E14)(session), "save the profile");
                return true;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        });
    }
    public void Delete(uint settingId)
    {
        if (!NvidiaSettings.Allowed.Contains(settingId)) throw new InvalidOperationException("Unsupported NVIDIA setting.");
        WithSession((session, profile) =>
        {
            var result = Fn<DeleteSetting>(0xE4A26362)(session, profile, settingId);
            if (result != SettingNotFound) Check(result, "remove a setting");
            Check(Fn<OnSession>(0xFCBC7E14)(session), "save the profile");
            return true;
        });
    }
}
