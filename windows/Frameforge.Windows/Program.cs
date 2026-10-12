using System.Text.Json;
using System.Text.Json.Serialization;
using Frameforge.Windows;

var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
// GC-7: the elevated instance has no stdin; it answers through the validated result file.
if (OperatingSystem.IsWindows() && args is ["--elevated", ..]) Environment.Exit(RestoreCommands.RunElevatedChild(args[1..], value => JsonSerializer.Serialize(value, options)));
object response;
try
{
    if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("Windows is required.");
    // Node writes UTF-8; the console code page would garble non-ASCII names.
    var line = new StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false)).ReadLine();
    if (line is null || line.Length > 32768) throw new InvalidOperationException("Invalid request size.");
    var request = JsonSerializer.Deserialize<Request>(line, options) ?? throw new InvalidOperationException("Missing request.");
    var engine = new RegistryOperations(new WindowsRegistryStore());
    var ids = request.Ids ?? [];
    response = request.Command switch
    {
        "hardware" when ids.Length == 0 && request.Snapshot is null => new { ok = true, message = "Read-only Windows discovery.", hardware = HardwareDiscovery.Collect() },
        "capture" when request.Snapshot is null => new { ok = true, message = "Snapshot captured.", snapshot = engine.Capture(ids) },
        "apply" when request.Snapshot is not null => Apply(engine, ids, request.Snapshot),
        "verify" when request.Snapshot is null => new { ok = true, message = "Verification completed.", verified = engine.Verify(ids) },
        "restore" when ids.Length == 0 && request.Snapshot is not null && !request.Force => Restore(engine, request.Snapshot),
        "processes" when request.GamePath is not null && request.Target is null => new { ok = true, message = "Running game processes read.", processes = WindowsProcessStore.Find(request.GamePath, request.ExecutablePath) },
        "boost-start" when request.Target is not null => new GameProcessOperations(new WindowsProcessStore()).Start(request.Target),
        "boost-stop" when request.Target is not null => new GameProcessOperations(new WindowsProcessStore()).Stop(request.Target),
        "restore-status" when ids.Length == 0 && request.Elevated is null => new RestorePoints(new WindowsRestoreStore()).StatusResult(),
        "elevated" when request.Elevated is not null => RestoreCommands.Run(request.Elevated),
        "elevated-result" when request.ResultPath is not null => RestoreCommands.ReadResult(request.ResultPath),
        _ => throw new InvalidOperationException("Unsupported helper request.")
    };
}
catch (Exception error)
{
    response = new { ok = false, message = error is InvalidOperationException ? error.Message : "Windows could not complete the request. Check permissions and hardware availability." };
}
Console.WriteLine(JsonSerializer.Serialize(response, options));
static object Apply(RegistryOperations engine, string[] ids, Snapshot snapshot) { engine.Apply(ids, snapshot); return new { ok = true, message = "Preferences written." }; }
static object Restore(RegistryOperations engine, Snapshot snapshot) { engine.Restore(snapshot); return new { ok = true, message = "Snapshot restored and verified." }; }
record Request(string Command, string[]? Ids, Snapshot? Snapshot, bool Force = false, string? GamePath = null, string? ExecutablePath = null, ProcessTarget? Target = null, ElevatedRequest? Elevated = null, string? ResultPath = null);
