using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace Frameforge.Windows;

public enum Signature { Unsigned, Valid, Invalid }

public static class Authenticode
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct FileInfo { public int Size; public string Path; public IntPtr File; public IntPtr Subject; }
    [StructLayout(LayoutKind.Sequential)]
    private struct TrustData { public int Size; public IntPtr Policy, Client; public int UiChoice, Revocation, UnionChoice; public IntPtr File; public int StateAction; public IntPtr State; public IntPtr Url; public int Flags, UiContext; }
    [DllImport("wintrust.dll", CharSet = CharSet.Unicode)] private static extern int WinVerifyTrust(IntPtr window, ref Guid action, ref TrustData data);
    private static Guid GenericVerify = new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    // Unsigned: no embedded signature (the current state of Frameforge releases). Valid: a signature that chains to a trusted root and
    // matches the file. Invalid: signed but broken or untrusted, which is never acceptable for a file that will run as SYSTEM.
    public static Signature Check(string path)
    {
        try { _ = X509Certificate.CreateFromSignedFile(path); }
        catch (CryptographicException) { return Signature.Unsigned; }
        var info = new FileInfo { Size = Marshal.SizeOf<FileInfo>(), Path = path };
        var file = Marshal.AllocHGlobal(info.Size);
        try
        {
            Marshal.StructureToPtr(info, file, false);
            var data = new TrustData { Size = Marshal.SizeOf<TrustData>(), UiChoice = 2, UnionChoice = 1, File = file };
            return WinVerifyTrust(IntPtr.Zero, ref GenericVerify, ref data) == 0 ? Signature.Valid : Signature.Invalid;
        }
        finally { Marshal.DestroyStructure<FileInfo>(file); Marshal.FreeHGlobal(file); }
    }
}

// Service control manager calls for the one broker service. No shell strings: the binary path is built from constants and quoted.
internal static class BrokerScm
{
    private const uint ManagerAccess = 0x0001 | 0x0002, ServiceAccess = 0xF01FF, OwnProcess = 0x10, AutoStart = 2, ErrorNormal = 1, NoChange = 0xFFFFFFFF;
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenSCManagerW(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateServiceW(IntPtr manager, string name, string display, uint access, uint type, uint start, uint error, string binary, string? group, IntPtr tag, string? dependencies, string? account, string? password);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ChangeServiceConfigW(IntPtr service, uint type, uint start, uint error, string? binary, string? group, IntPtr tag, string? dependencies, string? account, string? password, string? display);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool ChangeServiceConfig2W(IntPtr service, uint level, IntPtr info);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool DeleteService(IntPtr service);
    [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);

    // Only what a game-booster helper needs when it runs as LocalSystem: restore points and the boot store (backup, restore, firmware
    // environment), the standby list (profile single process) and the plumbing every service has. Nothing else is left in its token.
    public static readonly string[] Privileges =
        ["SeChangeNotifyPrivilege", "SeCreateGlobalPrivilege", "SeImpersonatePrivilege", "SeBackupPrivilege", "SeRestorePrivilege", "SeSystemEnvironmentPrivilege", "SeProfileSingleProcessPrivilege"];

    public static void Install(string name, string display, string description, string imagePath)
    {
        var manager = OpenSCManagerW(null, null, ManagerAccess);
        if (manager == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            // Account null: LocalSystem.
            var service = CreateServiceW(manager, name, display, ServiceAccess, OwnProcess, AutoStart, ErrorNormal, imagePath, null, IntPtr.Zero, null, null, null);
            if (service == IntPtr.Zero)
            {
                var error = Marshal.GetLastWin32Error();
                if (error != 1073) throw new Win32Exception(error); // already exists: update it in place
                service = OpenServiceW(manager, name, ServiceAccess);
                if (service == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (!ChangeServiceConfigW(service, OwnProcess, AutoStart, ErrorNormal, imagePath, null, IntPtr.Zero, null, null, null, display)) { var e = Marshal.GetLastWin32Error(); CloseServiceHandle(service); throw new Win32Exception(e); }
            }
            try
            {
                Pointer(service, 1, description);                       // SERVICE_CONFIG_DESCRIPTION
                Flag(service, 3, 1);                                    // SERVICE_CONFIG_DELAYED_AUTO_START_INFO
                Pointer(service, 6, string.Join('\0', Privileges) + "\0\0"); // SERVICE_CONFIG_REQUIRED_PRIVILEGES_INFO (multi-string)
                Recovery(service);
            }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
    // A structure whose only member is a pointer to a wide string (description, required privileges).
    private static void Pointer(IntPtr service, uint level, string text)
    {
        var chars = Marshal.StringToHGlobalUni(text);
        var info = Marshal.AllocHGlobal(IntPtr.Size);
        try
        {
            Marshal.WriteIntPtr(info, chars);
            if (!ChangeServiceConfig2W(service, level, info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(info); Marshal.FreeHGlobal(chars); }
    }
    private static void Flag(IntPtr service, uint level, int value)
    {
        var info = Marshal.AllocHGlobal(4);
        try { Marshal.WriteInt32(info, value); if (!ChangeServiceConfig2W(service, level, info)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        finally { Marshal.FreeHGlobal(info); }
    }
    // Restart after a crash (5 s, then 30 s, then 60 s); the counter resets after a day.
    private static void Recovery(IntPtr service)
    {
        var actions = Marshal.AllocHGlobal(3 * 8);
        var info = Marshal.AllocHGlobal(IntPtr.Size * 4 + 8);
        try
        {
            int[] delays = [5000, 30000, 60000];
            for (var i = 0; i < 3; i++) { Marshal.WriteInt32(actions, i * 8, 1); Marshal.WriteInt32(actions, i * 8 + 4, delays[i]); } // SC_ACTION_RESTART
            for (var i = 0; i < IntPtr.Size * 4 + 8; i++) Marshal.WriteByte(info, i, 0);
            Marshal.WriteInt32(info, 0, 86400);        // dwResetPeriod
            Marshal.WriteInt32(info, IntPtr.Size * 3, 3); // cActions
            Marshal.WriteIntPtr(info, IntPtr.Size * 3 + (IntPtr.Size == 8 ? 8 : 4), actions);
            if (!ChangeServiceConfig2W(service, 2, info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(info); Marshal.FreeHGlobal(actions); }
    }
    public static void Delete(string name)
    {
        var manager = OpenSCManagerW(null, null, ManagerAccess);
        if (manager == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var service = OpenServiceW(manager, name, ServiceAccess);
            if (service == IntPtr.Zero) { var error = Marshal.GetLastWin32Error(); if (error == 1060) return; throw new Win32Exception(error); }
            try { if (!DeleteService(service)) { var error = Marshal.GetLastWin32Error(); if (error != 1072) throw new Win32Exception(error); } }
            finally { CloseServiceHandle(service); }
        }
        finally { CloseServiceHandle(manager); }
    }
    public static bool Exists(string name)
    {
        try { using var controller = new ServiceController(name); _ = controller.Status; return true; } catch (InvalidOperationException) { return false; }
    }
    public static void Stop(string name)
    {
        try
        {
            using var controller = new ServiceController(name);
            if (controller.Status is ServiceControllerStatus.Stopped) return;
            if (controller.Status is not ServiceControllerStatus.StopPending) controller.Stop();
            controller.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(30));
        }
        catch (InvalidOperationException) { /* not installed */ }
    }
    public static void Start(string name)
    {
        using var controller = new ServiceController(name);
        controller.Start();
        controller.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(30));
    }
}

public static class BrokerInstaller
{
    private const string Display = "Frameforge admin service", Description = "Runs Frameforge's allowlisted administrator steps (restore points, services, timer, optimizations, FPS capture) for the one Windows user who approved it. Safe to remove in Frameforge > Settings.";

    // ---- Pure-ish pieces, tested without touching Windows ----
    public static DirectorySecurity Protected(bool usersMayRead)
    {
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        const InheritanceFlags both = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, both, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, both, PropagationFlags.None, AccessControlType.Allow));
        if (usersMayRead) security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.ReadAndExecute, both, PropagationFlags.None, AccessControlType.Allow));
        return security;
    }
    public static void ProtectDirectory(string path, bool usersMayRead = false)
    {
        var directory = Directory.CreateDirectory(path);
        directory.SetAccessControl(Protected(usersMayRead));
    }

    // Copies the helper folder file by file and proves the copy: every byte is hashed while it is read, the destination is hashed again
    // afterwards, and the source once more, so a file swapped or changed mid-copy fails. Links are never followed or copied.
    // Returns the manifest (relative path and SHA-256 per file) that is stored next to the binaries.
    public static string CopyVerified(string source, string destination)
    {
        var manifest = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var root = new DirectoryInfo(source);
        foreach (var file in root.EnumerateFiles("*", SearchOption.AllDirectories))
        {
            if (file.Attributes.HasFlag(FileAttributes.ReparsePoint) || file.Directory!.Attributes.HasFlag(FileAttributes.ReparsePoint)) continue;
            var relative = Path.GetRelativePath(source, file.FullName);
            var target = Path.Combine(destination, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            string copied;
            using (var input = new FileStream(file.FullName, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
            {
                var buffer = new byte[81920];
                for (int read; (read = input.Read(buffer, 0, buffer.Length)) > 0;) { hash.AppendData(buffer, 0, read); output.Write(buffer, 0, read); }
                copied = Convert.ToHexString(hash.GetHashAndReset());
            }
            if (HashOf(target) != copied || HashOf(file.FullName) != copied) throw new InvalidOperationException($"A file changed while it was copied ({relative}). Nothing was installed.");
            manifest[relative] = copied;
        }
        if (!manifest.ContainsKey(BrokerPaths.ExeName)) throw new InvalidOperationException("The helper folder does not contain the helper program.");
        return string.Concat(manifest.Select(p => $"{p.Value}  {p.Key}\n"));
    }
    public static string HashOf(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    // ---- Elevated entry points ----
    private static string ProgramFiles => Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);

    // `--elevated-broker <install|remove> <resultPath> <ownerSid>`: answers in the validated result file, like every other elevated child.
    public static int RunElevatedChild(string[] argv, Func<object, string> serialize)
    {
        if (argv.Length != 3) return 2;
        using var file = ElevatedCall.OpenResult(argv[1], out var rejected);
        if (file is null) return rejected;
        object result;
        try
        {
            if (!RestoreCommands.IsElevated()) throw new InvalidOperationException("The admin service can be changed only with administrator approval.");
            result = argv[0] switch
            {
                "install" => new { ok = true, message = Install(argv[2]) },
                "remove" => new { ok = true, message = Remove() },
                _ => throw new InvalidOperationException("Unsupported admin service request.")
            };
        }
        catch (Exception error) when (error is InvalidOperationException or IOException or UnauthorizedAccessException or Win32Exception or System.ServiceProcess.TimeoutException)
        {
            result = new { ok = false, message = error is InvalidOperationException ? error.Message : $"Windows could not complete the request ({error.GetType().Name}). Nothing usable was left installed." };
        }
        file.Write(Encoding.UTF8.GetBytes(serialize(result)));
        return 0;
    }

    // `--broker-uninstall` (started with the runas verb by the uninstaller): removal only, so it needs no request file. It cannot install or
    // change anything else, and removing the service is always safe.
    public static int UninstallDirect()
    {
        try { if (!RestoreCommands.IsElevated()) return 5; Remove(); return 0; }
        catch (Exception error) when (error is InvalidOperationException or IOException or UnauthorizedAccessException or Win32Exception) { return 1; }
    }

    public static string Install(string ownerSid)
    {
        if (!BrokerPaths.ValidOwnerSid(ownerSid)) throw new InvalidOperationException("Admin access can be approved only from an ordinary Windows user account.");
        var source = Path.GetDirectoryName(Environment.ProcessPath) ?? throw new InvalidOperationException("The helper location is unknown.");
        var helper = Environment.ProcessPath!;
        var destination = BrokerPaths.InstallDir(ProgramFiles);
        if (BrokerPaths.SamePath(source, destination)) throw new InvalidOperationException("Run the approval from Frameforge, not from the installed admin service.");
        if (Authenticode.Check(Path.Combine(source, BrokerPaths.ExeName)) == Signature.Invalid) throw new InvalidOperationException("The helper's digital signature is not valid, so it was not installed as an administrator service.");
        var parent = Path.GetDirectoryName(destination)!;
        // An existing service is stopped before its folder is replaced; the copy is built and checked next to it first.
        var staging = destination + ".new-" + Guid.NewGuid().ToString("N")[..8];
        string manifest;
        ProtectDirectory(parent, usersMayRead: true);
        ProtectDirectory(staging, usersMayRead: true);
        try { manifest = CopyVerified(source, staging); File.WriteAllText(Path.Combine(staging, "manifest.sha256"), manifest, new UTF8Encoding(false)); }
        catch { TryDelete(staging); throw; }
        try
        {
            BrokerScm.Stop(BrokerProtocol.ServiceName);
            var old = destination + ".old-" + Guid.NewGuid().ToString("N")[..8];
            if (Directory.Exists(destination)) Directory.Move(destination, old);
            Directory.Move(staging, destination);
            TryDelete(old);
            using (var key = Registry.LocalMachine.CreateSubKey(BrokerProtocol.RegistryKey, true))
            {
                key.SetValue("OwnerSid", ownerSid);
                key.SetValue("ClientImage", helper);
                key.SetValue("Version", BrokerProtocol.AppVersion);
                key.SetValue("InstallDir", destination);
                key.SetValue("ManifestSha256", Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(manifest))));
                key.SetValue("Signature", Authenticode.Check(Path.Combine(destination, BrokerPaths.ExeName)).ToString());
            }
            ProtectDirectory(Path.GetDirectoryName(BrokerService.DataDirectory)!, usersMayRead: true);
            ProtectDirectory(BrokerService.DataDirectory);
            BrokerScm.Install(BrokerProtocol.ServiceName, Display, Description, BrokerPaths.ImagePath(destination));
            BrokerScm.Start(BrokerProtocol.ServiceName);
        }
        catch (Exception error) when (error is Win32Exception or InvalidOperationException or IOException or UnauthorizedAccessException or System.ServiceProcess.TimeoutException)
        {
            TryDelete(staging);
            Remove();
            throw new InvalidOperationException("Windows did not complete the admin service setup, so it was removed again. Nothing usable was left on this PC.");
        }
        return "Admin access approved. Frameforge's administrator steps no longer ask Windows each time.";
    }

    public static string Remove()
    {
        BrokerScm.Stop(BrokerProtocol.ServiceName);
        BrokerScm.Delete(BrokerProtocol.ServiceName);
        var destination = BrokerPaths.InstallDir(ProgramFiles);
        TryDelete(destination);
        try { Registry.LocalMachine.DeleteSubKeyTree(BrokerProtocol.RegistryKey, false); } catch (ArgumentException) { }
        TryDelete(BrokerService.DataDirectory);
        // The parent folders are removed only when nothing else lives there.
        TryRemoveEmpty(Path.GetDirectoryName(destination)!);
        TryRemoveEmpty(Path.GetDirectoryName(BrokerService.DataDirectory)!);
        return "Admin access removed. Administrator steps ask Windows for approval again.";
    }
    private static void TryDelete(string path)
    {
        // Only ever called with paths built from the Program Files and ProgramData constants above.
        for (var attempt = 0; attempt < 5 && Directory.Exists(path); attempt++)
        {
            try { Directory.Delete(path, true); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { Thread.Sleep(500); }
        }
    }
    private static void TryRemoveEmpty(string path)
    {
        try { if (Directory.Exists(path) && !Directory.EnumerateFileSystemEntries(path).Any()) Directory.Delete(path); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }
}

// The unelevated side of install and remove: one UAC prompt through the same request-file guard as every other elevated step. These two
// always use the Windows prompt, never the broker, so the service can only be changed by an approval the person sees.
public static class BrokerAdmin
{
    public static object Status()
    {
        var state = BrokerLocal.Status();
        return new { ok = true, message = "Admin service checked.", broker = new { state = state.State, message = state.Message, version = state.Version } };
    }
    public static object Run(string action, IElevatedLauncher? launcher = null, string? ownerSid = null, TimeSpan? approval = null, TimeSpan? childWait = null, bool? elevated = null)
    {
        if (action is not ("install" or "remove")) throw new InvalidOperationException("Unsupported admin service request.");
        var sid = ownerSid ?? WindowsIdentity.GetCurrent().User?.Value;
        if (action == "install" && !BrokerPaths.ValidOwnerSid(sid)) throw new InvalidOperationException("Admin access can be approved only from an ordinary Windows user account.");
        if (elevated ?? RestoreCommands.IsElevated()) throw new InvalidOperationException("Frameforge is already running as administrator. Start it normally to approve admin access.");
        var unchanged = "Nothing was changed.";
        var outcome = ElevatedCall.Run(launcher ?? new WindowsElevatedLauncher(), "--elevated-broker", action, [sid ?? ""], approval ?? TimeSpan.FromSeconds(120), childWait ?? TimeSpan.FromSeconds(180), default);
        switch (outcome.Status)
        {
            case ElevationStatus.Declined: throw new InvalidOperationException($"Administrator approval was declined. {unchanged}");
            case ElevationStatus.NotApproved or ElevationStatus.Cancelled: throw new InvalidOperationException($"Administrator approval was not given in time. {unchanged} A prompt that is still open does nothing now.");
            case ElevationStatus.Expired: throw new InvalidOperationException($"The administrator request expired before it was approved. {unchanged}");
            case ElevationStatus.Rejected: throw new InvalidOperationException($"The administrator step rejected its result file. {unchanged}");
            case ElevationStatus.NoChild: throw new InvalidOperationException("The administrator request could not start.");
            case ElevationStatus.ChildTimeout: throw new InvalidOperationException("The administrator step did not finish in time. Check the status below before retrying.");
        }
        string message;
        try
        {
            using var document = JsonDocument.Parse(outcome.Text is { Length: > 0 and < 4096 } text ? text : throw new JsonException());
            if (!document.RootElement.TryGetProperty("ok", out var ok) || !document.RootElement.TryGetProperty("message", out var said)) throw new JsonException();
            message = said.GetString() ?? "";
            if (ok.ValueKind != JsonValueKind.True) throw new InvalidOperationException(message);
        }
        catch (JsonException) { throw new InvalidOperationException("The administrator step returned no readable result. Check the status below before retrying."); }
        var state = BrokerLocal.Status();
        return new { ok = true, message, broker = new { state = state.State, message = state.Message, version = state.Version } };
    }
}
