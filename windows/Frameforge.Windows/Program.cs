using System.ComponentModel;
using System.Text.Json;
using Frameforge.Windows;

// Nulls are written explicitly (registry snapshots need `value: null`); records opt out per member.
var options = HelperJson.Options;
if (OperatingSystem.IsWindows() && args is ["--session"]) { SessionRunner.Host(); return; }
object response;
try
{
    if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("Windows is required.");
    var line = Console.ReadLine();
    if (line is null || line.Length > 1048576) throw new InvalidOperationException("Invalid request size.");
    var request = JsonSerializer.Deserialize<Request>(line, options) ?? throw new InvalidOperationException("Missing request.");
    var engine = new RegistryOperations(new WindowsRegistryStore());
    var ids = request.Ids ?? [];
    Guid? owned = request.OwnedPlan is null ? null : Guid.TryParse(request.OwnedPlan, out var plan) ? plan : throw new InvalidOperationException("Invalid power plan.");
    BoostSessionEngine Booster() => new(new WindowsProcessControl(), new WindowsPowerStore(), new WindowsTimerControl(), new WindowsRegistryStore(), _ => { }, Environment.ProcessId, owned);
    response = request.Command switch
    {
        "hardware" when ids.Length == 0 && request.Snapshot is null => new { ok = true, message = "Read-only Windows discovery.", hardware = HardwareDiscovery.Collect() },
        "capture" when request.Snapshot is null => new { ok = true, message = "Snapshot captured.", snapshot = engine.Capture(ids) },
        "apply" when request.Snapshot is not null => Apply(engine, ids, request.Snapshot),
        "verify" when request.Snapshot is null => new { ok = true, message = "Verification completed.", verified = engine.Verify(ids) },
        "restore" when ids.Length == 0 && request.Snapshot is not null && !request.Force => Restore(engine, request.Snapshot),
        "running-games" when request.Games is not null => new { ok = true, message = "Running library games read.", runningGames = WindowsProcesses.RunningGames(request.Games) },
        "background-processes" => new { ok = true, message = "Running processes read.", backgroundProcesses = WindowsProcessControl.Entries() },
        "boost-capabilities" => new { ok = true, message = "Booster capabilities read.", capabilities = BoostSessionEngine.Capabilities(new WindowsPowerStore(), new WindowsTimerControl(), Environment.ProcessorCount, new WindowsRegistryStore(), owned) },
        // Untrusted input bound, above the per-session capture cap; every item is attempted.
        "boost-recover" when request.Captured is { Length: <= 1000 } => new { ok = true, message = "Saved booster changes checked.", reverts = Booster().Recover(request.Captured) },
        "power-create-plan" => new { ok = true, message = "Frameforge High performance plan created. The active plan was not changed.", powerPlan = BoostSessionEngine.CreatePlan(new WindowsPowerStore()).ToString() },
        "power-delete-plan" when owned is { } ownedPlan => new { ok = true, message = BoostSessionEngine.DeletePlan(new WindowsPowerStore(), ownedPlan) },
        _ => throw new InvalidOperationException("Unsupported helper request.")
    };
}
catch (Exception error)
{
    response = new
    {
        ok = false,
        code = error switch { InvalidOperationException => "invalid-request", Win32Exception { NativeErrorCode: 5 } => "access-denied", _ => "windows-error" },
        message = error is InvalidOperationException ? error.Message : "Windows could not complete the request. Check permissions and hardware availability."
    };
}
Console.WriteLine(JsonSerializer.Serialize(response, options));
static object Apply(RegistryOperations engine, string[] ids, Snapshot snapshot) { engine.Apply(ids, snapshot); return new { ok = true, message = "Preferences written." }; }
static object Restore(RegistryOperations engine, Snapshot snapshot) { engine.Restore(snapshot); return new { ok = true, message = "Snapshot restored and verified." }; }
record Request(string Command, string[]? Ids, Snapshot? Snapshot, bool Force = false, GameRef[]? Games = null, Captured[]? Captured = null, string? OwnedPlan = null);
