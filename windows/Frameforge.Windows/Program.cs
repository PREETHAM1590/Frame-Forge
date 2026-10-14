using System.ComponentModel;
using System.Text.Json;
using Frameforge.Windows;

// Nulls are written explicitly (registry snapshots need `value: null`); records opt out per member.
var options = HelperJson.Options;
// GC-7: the elevated instance has no stdin; it answers through the validated result file.
if (OperatingSystem.IsWindows() && args is ["--elevated", ..]) Environment.Exit(RestoreCommands.RunElevatedChild(args[1..], value => JsonSerializer.Serialize(value, options)));
if (OperatingSystem.IsWindows() && args is ["--elevated-services", ..]) Environment.Exit(ServiceCommands.RunElevatedChild(args[1..], value => JsonSerializer.Serialize(value, options)));
if (OperatingSystem.IsWindows() && args is ["--elevated-timer", ..]) Environment.Exit(TimerGlobalSetting.RunElevatedChild(args[1..], value => JsonSerializer.Serialize(value, options)));
if (OperatingSystem.IsWindows() && args is ["--elevated-optimize", ..]) Environment.Exit(WindowsAdminGateway.RunChild(args[1..], value => JsonSerializer.Serialize(value, options)));
if (OperatingSystem.IsWindows() && args is ["--session"]) { SessionRunner.Host(); return; }
object response;
try
{
    if (!OperatingSystem.IsWindows()) throw new InvalidOperationException("Windows is required.");
    // Node writes UTF-8; the console code page would garble non-ASCII names.
    var input = new StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false));
    var line = input.ReadLine();
    if (line is null || line.Length > 1048576) throw new InvalidOperationException("Invalid request size.");
    var request = JsonSerializer.Deserialize<Request>(line, options) ?? throw new InvalidOperationException("Missing request.");
    // Frameforge may send a second line, "cancel", while an administrator prompt is still unanswered: the request is withdrawn.
    if (request.Command == "elevated") new Thread(() => { while (input.ReadLine() is { } next) if (next == "cancel") RestoreCommands.RequestCancel.Cancel(); }) { IsBackground = true }.Start();
    Guid? owned = request.OwnedPlan is null ? null : Guid.TryParse(request.OwnedPlan, out var plan) ? plan : throw new InvalidOperationException("Invalid power plan.");
    var ids = request.Ids ?? [];
    var facts = new WindowsFacts();
    var engine = new Optimizations(new RegistryOperations(new WindowsRegistryStore(), facts), new WindowsPowerStore(), owned, new WindowsAdminGateway(), RestoreCommands.IsElevated());
    BoostSessionEngine Booster() => new(new WindowsProcessControl(), new WindowsPowerStore(), new WindowsTimerControl(), new WindowsRegistryStore(), _ => { }, Environment.ProcessId, owned, Extras.Windows(request.Elevate));
    response = request.Command switch
    {
        "hardware" when ids.Length == 0 && request.Snapshot is null => new { ok = true, message = "Read-only Windows discovery.", hardware = HardwareDiscovery.Collect() },
        "capture" when request.Snapshot is null => new { ok = true, message = "Snapshot captured.", snapshot = engine.Capture(ids) },
        "apply" when request.Snapshot is not null => Apply(engine, ids, request.Snapshot),
        "supported" when ids.Length == 0 && request.Snapshot is null => new { ok = true, message = "Applicable optimizations read.", supported = OptimizationTable.Applicable(facts) },
        "recheck" when ids.Length > 0 && request.Snapshot is null => new { ok = true, message = "Applied settings re-read.", drifted = engine.Drifted(ids) },
        "defender-status" when ids.Length == 0 && request.Snapshot is null => new { ok = true, message = DefenderStatus.Describe() },
        "restart-explorer" when ids.Length == 0 && request.Snapshot is null => new { ok = true, message = ExplorerRestart.Run() > 0 ? "Windows Explorer was restarted." : "Windows Explorer was not found for this user." },
        "verify" when request.Snapshot is null => new { ok = true, message = "Verification completed.", verified = engine.Verify(ids) },
        "restore" when ids.Length == 0 && request.Snapshot is not null && !request.Force => Restore(engine, request.Snapshot),
        "restore-status" when ids.Length == 0 && request.Elevated is null => new RestorePoints(new WindowsRestoreStore()).StatusResult(),
        "elevated" when request.Elevated is not null => RestoreCommands.Run(request.Elevated),
        "elevated-result" when request.ResultPath is not null => RestoreCommands.ReadResult(request.ResultPath),
        "running-games" when request.Games is not null => new { ok = true, message = "Running library games read.", runningGames = WindowsProcesses.RunningGames(request.Games) },
        "background-processes" => new { ok = true, message = "Running processes read.", backgroundProcesses = WindowsProcessControl.Entries() },
        "boost-capabilities" => new { ok = true, message = "Booster capabilities read.", capabilities = BoostSessionEngine.Capabilities(new WindowsPowerStore(), new WindowsTimerControl(), Environment.ProcessorCount, new WindowsRegistryStore(), owned, Extras.Windows(), request.TimerRestartPending) },
        // Untrusted input bound, above the per-session capture cap; every item is attempted.
        "boost-recover" when request.Captured is { Length: <= 1000 } captured && captured.All(c => c is not null) => new { ok = true, message = "Saved booster changes checked.", reverts = Booster().Recover(captured) },
        "boost-recover" => throw new InvalidOperationException("Too many or invalid saved booster changes (limit 1000)."),
        // Reads the machine-wide timer setting, or changes it through one administrator prompt (enable/restore, with the prior value Frameforge saved).
        "timer-global" when request.Timer is not null => new { ok = true, message = "Timer setting checked.", timerGlobal = TimerGlobalSetting.Run(request.Timer, Environment.OSVersion.Version.Build, new WindowsKernelTimerSetting()) },
        "launch-setting" when request.Launch is not null => new { ok = true, message = "Launch setting checked.", launch = LaunchSettings.Run(request.Launch, new WindowsRegistryAccess(), new WindowsGpuInfo()) },
        "network-check" when request.Host is not null => new { ok = true, message = "Network check completed.", network = NetworkCheck.Run(request.Host, request.Count, new WindowsPinger(), new WindowsResolver()) },
        // Frameforge records the destination GUID before asking, so a created plan is never left unrecorded.
        "power-create-plan" when owned is { } destination => CreatePlan(destination),
        "power-list-plans" => new { ok = true, message = "Power plans read.", powerPlans = BoostSessionEngine.SameNamePlans(new WindowsPowerStore()) },
        "power-delete-duplicate" when owned is { } duplicate => new { ok = true, message = BoostSessionEngine.DeleteDuplicate(new WindowsPowerStore(), duplicate) },
        "power-delete-plan" when owned is { } ownedPlan => new { ok = true, message = BoostSessionEngine.DeletePlan(new WindowsPowerStore(), ownedPlan) },
        _ => throw new InvalidOperationException("Unsupported helper request.")
    };
}
catch (Exception error)
{
    response = new
    {
        ok = false,
        code = error switch { PlanNotCreatedException => "plan-not-created", InvalidOperationException => "invalid-request", Win32Exception { NativeErrorCode: 5 } => "access-denied", _ => "windows-error" },
        message = error is InvalidOperationException ? error.Message : "Windows could not complete the request. Check permissions and hardware availability."
    };
}
Console.WriteLine(JsonSerializer.Serialize(response, options));
static object CreatePlan(Guid destination) { BoostSessionEngine.CreatePlan(new WindowsPowerStore(), destination); return new { ok = true, message = "Frameforge High performance plan created and verified. The active plan was not changed.", powerPlan = destination.ToString() }; }
static object Apply(Optimizations engine, string[] ids, OptimizationSnapshot snapshot) { var verified = engine.Apply(ids, snapshot); return new { ok = true, message = "Preferences written.", verified }; }
static object Restore(Optimizations engine, OptimizationSnapshot snapshot) { var note = engine.Restore(snapshot); return new { ok = true, message = note is null ? "Snapshot restored and verified." : "Snapshot restored and verified. " + note }; }
record Request(string Command, string[]? Ids, OptimizationSnapshot? Snapshot, bool Force = false, GameRef[]? Games = null, Captured[]? Captured = null, string? OwnedPlan = null, ElevatedRequest? Elevated = null, string? ResultPath = null, bool Elevate = true, string? Host = null, int Count = 0, LaunchRequest? Launch = null, TimerRequest? Timer = null, bool TimerRestartPending = false);
