using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace Frameforge.Windows;

public record AdminReply(bool Ok, string Message, CapturedValue[]? Values = null, bool Verified = false);

/// <summary>
/// GC-7 for machine optimizations: the helper starts itself with the runas verb and reads a validated result file. The request travels as
/// one JSON argument (no string is built by hand), and the child accepts only allowlisted machine settings through RegistryOperations.
/// </summary>
public sealed class WindowsAdminGateway(TimeSpan? childWait = null) : IAdminGateway
{
    private readonly TimeSpan wait = childWait ?? TimeSpan.FromSeconds(150);
    private const int MaxArgument = 24000;

    public AdminResult Run(AdminRequest request)
    {
        var registry = new RegistryOperations(new WindowsRegistryStore(), new WindowsFacts());
        if (RestoreCommands.IsElevated()) return AdminCommands.Execute(request, registry);
        // Refuse malformed requests here, before any administrator prompt.
        if (request.Ids is null || request.Ids.Length is 0 or > 24 || !request.Ids.All(OptimizationTable.IsAdmin)) throw new InvalidOperationException("Unsupported administrator request.");
        var json = JsonSerializer.Serialize(request, HelperJson.Options);
        if (json.Length > MaxArgument) throw new InvalidOperationException("The administrator request is too large.");
        var resultPath = WindowsServiceElevator.NewResultPath();
        var keep = false;
        try
        {
            var info = new ProcessStartInfo { FileName = Environment.ProcessPath!, UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden };
            foreach (var argument in new[] { "--elevated-optimize", resultPath, json }) info.ArgumentList.Add(argument);
            Process? child;
            try { child = Process.Start(info); }
            catch (Win32Exception error) when (error.NativeErrorCode == 1223) { throw new InvalidOperationException("Administrator approval was declined. Nothing was changed."); }
            using (child)
            {
                if (child is null) throw new InvalidOperationException("The administrator request could not start.");
                if (!child.WaitForExit(wait)) { keep = true; throw new InvalidOperationException("The administrator step did not finish in time. Check the setting before retrying."); }
                if (RestoreCommands.ExitCode(child) == 2) throw new InvalidOperationException("The administrator step rejected its result file. Nothing was changed.");
            }
            var text = File.ReadAllText(resultPath);
            if (text.Length is 0 or > 1024 * 1024) throw new InvalidOperationException("The administrator step returned no result.");
            AdminReply? reply;
            try { reply = JsonSerializer.Deserialize<AdminReply>(text, HelperJson.Options); } catch (JsonException) { reply = null; }
            if (reply is null) throw new InvalidOperationException("Unreadable administrator result.");
            if (!reply.Ok) throw new InvalidOperationException(reply.Message);
            return new(reply.Values, reply.Verified);
        }
        finally { if (!keep) { try { File.Delete(resultPath); } catch (IOException) { } catch (UnauthorizedAccessException) { } } }
    }

    // Entry point for `--elevated-optimize <resultPath> <json>`. Writes exactly one JSON object to the result file.
    public static int RunChild(string[] argv, Func<object, string> serialize)
    {
        if (argv.Length != 2 || argv[1].Length > MaxArgument || !RestoreCommands.ValidResultPath(argv[0])) return 2;
        using var file = new FileStream(argv[0], FileMode.Open, FileAccess.Write, FileShare.None);
        if (file.Length != 0 || !string.Equals(RestoreCommands.FinalPath(file.SafeFileHandle), argv[0], StringComparison.OrdinalIgnoreCase)) return 2;
        AdminReply reply;
        try
        {
            var request = JsonSerializer.Deserialize<AdminRequest>(argv[1], HelperJson.Options) ?? throw new InvalidOperationException("Missing request.");
            var result = AdminCommands.Execute(request, new RegistryOperations(new WindowsRegistryStore(), new WindowsFacts()));
            reply = new(true, "Done.", result.Values, result.Verified);
        }
        catch (Exception error) when (error is InvalidOperationException or JsonException) { reply = new(false, error is JsonException ? "Invalid administrator request." : error.Message); }
        catch (Exception) { reply = new(false, "Windows could not complete the request. Check permissions."); }
        file.Write(Encoding.UTF8.GetBytes(serialize(reply)));
        return 0;
    }
}

/// <summary>Restarts the Windows shell. Fixed action: only this user's explorer.exe from the Windows folder is ended; Windows starts it again.</summary>
public static class ExplorerRestart
{
    public static int Run()
    {
        var expected = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
        var count = 0;
        foreach (var process in Process.GetProcessesByName("explorer"))
        {
            using (process)
            {
                try
                {
                    if (process.SessionId != Process.GetCurrentProcess().SessionId || !string.Equals(process.MainModule?.FileName, expected, StringComparison.OrdinalIgnoreCase)) continue;
                    process.Kill(); count++;
                }
                catch (Exception error) when (error is Win32Exception or InvalidOperationException) { /* another user's or already gone */ }
            }
        }
        return count;
    }
}
