using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace Frameforge.Windows;

public record Mechanisms(bool GameMode, string Priority, int[]? Affinity, bool PowerPlan, bool LowerBackground, bool SuspendBackground, bool CloseBackground, bool TimerResolution,
    bool PauseServices = false, bool GameBarCapture = false, bool SmartCores = false, bool CoreParking = false, bool PowerThrottling = false, bool StandbyPurge = false, bool GpuPriority = false);
public record BackgroundRule(string Image, string Action);
// StoreGame: the game comes from the Xbox app or Microsoft Store. Unattended: auto-boost, which must not open an administrator prompt.
// Preset: a preset mode rather than Custom; smart core targeting stays off in presets on Windows 11 hybrid CPUs.
public record SessionCommand(string Command, int GamePid = 0, string? GameStartTime = null, string? GamePath = null, Mechanisms? Mechanisms = null, BackgroundRule[]? Background = null, int ParentPid = 0, string? OwnedPlan = null,
    bool StoreGame = false, bool Unattended = false, bool Preset = false, bool TimerRestartPending = false, bool BrokerOnly = false);
// Prior state saved before a change. Applied is what Frameforge set, so a revert only happens while it is still in place.
// Only these optional members omit nulls; registry snapshots keep an explicit `value: null` for absent values.
public record Captured(string Mechanism, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ProcessTarget? Process = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Prior = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Applied = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Snapshot? Registry = null,
    // Second-pass mechanisms: the scheme and setting changed by coreParking, listed names (paused services, CPU set ids) and current-user registry values.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Scheme = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Setting = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string[]? Items = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string[]? AppliedItems = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] RegCapture[]? RegValues = null);
public record MechanismResult(string Id, string State, string Detail, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Code = null);
public record Step(string Event, string Mechanism, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Detail = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Captured? Prior = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Code = null);
public record Ended(string Event, string Reason, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Detail, MechanismResult[] Reverts);
public record ProcInfo(ProcessTarget Target, int SessionId, string? Sid, bool Critical);
// Active: the mechanism's effect is already in place on this PC (for example Game Mode already on).
// Code: a stable reason for the display, for example "policy" when Windows policy already does what the mechanism would do.
public record Capability(string Id, bool Available, string Detail, bool Active = false, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Code = null);
// Windows 11 only lets a timer request reach other programs when GlobalTimerResolutionRequests is 1. Eligible: this Windows build has the setting.
public record TimerGlobal(bool Eligible, bool Enabled);
public record BoostCapabilities(int LogicalCpus, Capability[] Mechanisms, CpuTopology? Topology = null, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] TimerGlobal? TimerGlobal = null);
public record ProcessEntry(string Image, int Pid, bool Protected,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? WorkingSetBytes = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] double? CpuPercent = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Path = null);
// Reported as code "plan-not-created": the helper verified no plan copy exists, so the recorded GUID can be dropped.
public sealed class PlanNotCreatedException(string message) : InvalidOperationException(message);
public static class HelperJson
{
    public static readonly JsonSerializerOptions Options = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
}

public sealed record NamedPlan(string Guid, string Name, bool Active);
public interface IPowerStore
{
    Guid Active(); bool Exists(Guid scheme); void SetActive(Guid scheme);
    // Copies source into the caller-chosen destination GUID and names it; on a naming failure the copy is deleted and this throws.
    void Duplicate(Guid source, Guid destination, string name);
    string? Name(Guid scheme);
    void Delete(Guid scheme);
    // Every scheme GUID on this PC (read-only).
    Guid[] List() => [];
}
public interface ITimerControl
{
    string? Unsupported { get; }
    bool Request();
    void Release();
    TimerGlobal Global => new(false, false);
}
public interface IProcessControl
{
    int LogicalCpus { get; }
    ProcInfo[] List();
    // Null when the process exited or the pid now belongs to another process.
    ProcessTarget? Read(ProcessTarget identity);
    void SetPriority(ProcessTarget identity, string priority);
    ulong GetAffinity(ProcessTarget identity);
    void SetAffinity(ProcessTarget identity, ulong mask);
    bool Suspend(ProcessTarget identity);
    // One NtResumeProcess, the exact counterpart of one NtSuspendProcess (each thread's suspend count drops by one).
    void Resume(ProcessTarget identity);
    // Suspended and total thread counts.
    (int Suspended, int Total) Threads(ProcessTarget identity);
    int Close(ProcessTarget[] identities);
}

// ownedPlan: a plan Frameforge created with the user's consent (GUID recorded in SQLite), allowlisted next to the Windows plans.
public sealed partial class BoostSessionEngine(IProcessControl processes, IPowerStore power, ITimerControl timer, IRegistryStore registry, Action<Step> emit, int selfPid, Guid? ownedPlan = null, Extras? extras = null)
{
    public static readonly Guid HighPerformance = new("8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"), Ultimate = new("e9a42b02-d5df-448d-aa00-03f14749eb61");
    public const string OwnedPlanName = "Frameforge High performance";
    // Windows' built-in schemes are never deleted (Balanced, Power saver, High performance, Ultimate).
    public static readonly Guid[] BuiltInPlans = [new("381b4222-f694-41f0-9685-ff5bb260df2e"), new("a1841308-3541-4fab-bc81-f71556f20b4a"), HighPerformance, Ultimate];
    // Bounds the saved state of one session; further background matches are skipped with a visible reason.
    public const int MaxCaptures = 200;
    private static readonly string[] Ranks = ["Idle", "BelowNormal", "Normal", "AboveNormal", "High"];
    private static readonly string[] GameModeIds = ["game-mode"];
    private static readonly Regex Image = new(@"^[\w .()-]{1,64}\.exe$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private readonly List<Captured> captured = [];
    private readonly RegistryOperations gameBar = new(registry);
    private bool timerHeld, timerRestartPending;

    public static string? TimerSupport(int build, object? globalFlag)
    {
        if (build < 19041) return null;
        if (build < 22000) return "On Windows 10 version 2004 and later a timer request only affects the requesting process, so it cannot reach the game.";
        return globalFlag is 1 ? null : "On Windows 11 a program's timer request only reaches the whole system when Windows' GlobalTimerResolutionRequests setting is on. It is off here. Frameforge can turn it on for you (administrator approval, then a restart).";
    }
    public static Guid? PlanTarget(IPowerStore power, Guid? owned) =>
        power.Exists(HighPerformance) ? HighPerformance : power.Exists(Ultimate) ? Ultimate : owned is { } o && power.Exists(o) ? o : null;
    private static string PlanName(Guid plan) => plan == HighPerformance ? "High performance" : plan == Ultimate ? "Ultimate performance" : OwnedPlanName;
    // Windows treats absent GameBar values as on, so only an explicit 0 means Game Mode is off.
    private static bool GameModeOn(Snapshot current) => current.Values.All(v => !v.Existed || Equals(Norm(v.Value), 1));
    private static object? Norm(object? value) => value is JsonElement json
        ? json.ValueKind switch { JsonValueKind.Number => json.GetInt32(), JsonValueKind.String => json.GetString(), _ => null }
        : value;
    private bool PerformancePlan(Guid plan) => IsPerformancePlan(plan, ownedPlan);
    private static bool IsPerformancePlan(Guid plan, Guid? owned) => plan == HighPerformance || plan == Ultimate || plan == owned;
    // Each read is independent, so one unreadable value marks only its own mechanism unavailable.
    private static Capability Safe(string id, Func<Capability> read)
    {
        try { return read(); }
        catch (Exception error) { return new(id, false, $"Could not be read: {Describe(error)}"); }
    }
    public const string TimerRestartNote = "Turned on in Windows, but Windows reads GlobalTimerResolutionRequests only at start-up. Restart Windows to finish (choose Restart, not Shut down: Fast Startup keeps the old session); until then a timer request cannot reach the game.";
    public static BoostCapabilities Capabilities(IPowerStore power, ITimerControl timer, int cpus, IRegistryStore registry, Guid? ownedPlan, Extras? extras = null, bool timerRestartPending = false)
    {
        var timerReason = timer.Unsupported;
        if (timerReason is null && timerRestartPending) timerReason = TimerRestartNote;
        return new(cpus, [
            Safe("gameMode", () => GameModeOn(new RegistryOperations(registry).Capture(GameModeIds)) is var on && on
                ? new("gameMode", true, "Already on in Windows; a session leaves it as it is.", true)
                : new("gameMode", true, "Off in Windows; a session turns it on and restores it afterwards.")),
            // Active mirrors the engine: any performance plan already active means the session skips this step.
            Safe("powerPlan", () => PlanTarget(power, ownedPlan) is { } plan
                ? new("powerPlan", true, IsPerformancePlan(power.Active(), ownedPlan) ? "A performance power plan is already active." : $"{PlanName(plan)} plan present.", IsPerformancePlan(power.Active(), ownedPlan))
                : new("powerPlan", false, "High performance plan not present")),
            new("priority", true, "Normal, Above normal or High. Real-time is never used."),
            new("affinity", cpus > 0, $"{Math.Min(cpus, 64)} logical CPUs selectable."),
            new("lowerBackground", true, "Selected apps run at Below normal during the session."),
            new("suspendBackground", true, "Selected apps are suspended and resumed afterwards."),
            new("closeBackground", true, "Selected apps are closed and not reopened."),
            new("timerResolution", timerReason is null, timerReason ?? "0.5 ms timer requested for the session."),
            .. ExtraCapabilities(power, extras)
        ], ReadTopology(extras), timer.Global);
    }
    // Explicit, consent-gated: copies Windows' High performance (or Ultimate) template into a new plan. The active plan is not changed.
    // destination is generated and recorded by Frameforge before this call, so a created plan is never left unrecorded.
    // Throws PlanNotCreatedException only when it verified that no copy exists; any other failure may leave the recorded copy,
    // which Remove can then clean up.
    public static void CreatePlan(IPowerStore power, Guid destination)
    {
        // An unrecorded plan with our name (earlier profile, reinstall) must be adopted or removed, never duplicated.
        if (SameNamePlans(power).Length > 0) throw new PlanNotCreatedException($"A power plan named \"{OwnedPlanName}\" already exists on this PC. Use it or remove the duplicate instead of creating another. Nothing was changed.");
        if (BuiltInPlans.Contains(destination) || power.Exists(destination)) throw new PlanNotCreatedException("Invalid destination for the new power plan. Nothing was changed.");
        Win32Exception? refused = null;
        foreach (var source in new[] { HighPerformance, Ultimate })
        {
            try { power.Duplicate(source, destination, OwnedPlanName); }
            catch (Win32Exception error) when (!SafeExists(power, destination)) { refused = error; continue; }
            catch (Win32Exception error) { throw new InvalidOperationException($"Windows left an unverified copy of the plan ({Describe(error)}). Use Remove Frameforge plan to clean it up."); }
            try
            {
                if (power.Exists(destination) && power.Name(destination) == OwnedPlanName) return;
                // Never leave an unverified copy behind.
                if (power.Exists(destination)) power.Delete(destination);
                if (power.Exists(destination)) throw new InvalidOperationException("Windows did not remove an unverified copy of the plan.");
            }
            catch (Exception error) when (error is Win32Exception or InvalidOperationException)
            {
                throw new InvalidOperationException($"The new plan could not be verified ({Describe(error)}). Use Remove Frameforge plan to clean it up.");
            }
        }
        // Windows' own answer is shown so the user sees the real reason (Modern Standby PCs commonly refuse).
        var reason = refused is null ? "" : $" Windows said: {refused.Message} (error {refused.NativeErrorCode}).";
        throw new PlanNotCreatedException($"Windows did not allow creating a High performance plan on this PC (common on Modern Standby devices).{reason} Nothing was changed.");
    }
    // Non-built-in plans with exactly the Frameforge name. Read-only; the caller decides which one (if any) is recorded as owned.
    public static NamedPlan[] SameNamePlans(IPowerStore power)
    {
        var active = power.Active();
        var found = new List<NamedPlan>();
        foreach (var plan in power.List())
        {
            if (BuiltInPlans.Contains(plan)) continue;
            string? name;
            try { name = power.Name(plan); } catch (Win32Exception) { continue; }
            if (name == OwnedPlanName) found.Add(new(plan.ToString(), name, plan == active));
        }
        return [.. found];
    }
    // Removes one duplicate: exact Frameforge name only, never built-in, never the active plan.
    public static string DeleteDuplicate(IPowerStore power, Guid plan)
    {
        if (BuiltInPlans.Contains(plan)) throw new InvalidOperationException("Only a plan named Frameforge High performance can be removed.");
        if (!power.Exists(plan)) return "That plan was already removed.";
        if (power.Name(plan) != OwnedPlanName) throw new InvalidOperationException("That power plan is not named Frameforge High performance, so it was not removed.");
        if (power.Active() == plan) throw new InvalidOperationException("That plan is active. Switch to another power plan first.");
        power.Delete(plan);
        if (power.Exists(plan)) throw new InvalidOperationException("Windows did not remove the duplicate plan.");
        return "Duplicate Frameforge High performance plan removed and verified.";
    }
    private static bool SafeExists(IPowerStore power, Guid scheme) { try { return power.Exists(scheme); } catch (Win32Exception) { return true; } }
    // A copy left unnamed (helper killed between copy and naming) still carries a Windows source name, or none.
    private static bool OwnedName(IPowerStore power, string? name)
    {
        if (string.IsNullOrEmpty(name) || name == OwnedPlanName) return true;
        var sources = new List<string> { "High performance", "Ultimate Performance" };
        foreach (var source in new[] { HighPerformance, Ultimate })
            try { if (power.Name(source) is { } n) sources.Add(n); } catch (Win32Exception) { }
        return sources.Contains(name, StringComparer.OrdinalIgnoreCase);
    }
    // Removes only the plan Frameforge created and recorded: never a built-in scheme, never a user-named plan, never while active.
    public static string DeletePlan(IPowerStore power, Guid owned)
    {
        if (BuiltInPlans.Contains(owned)) throw new InvalidOperationException("Only the plan Frameforge created can be removed.");
        if (!power.Exists(owned)) return "The Frameforge plan was already removed.";
        if (!OwnedName(power, power.Name(owned))) throw new InvalidOperationException("That power plan was not created by Frameforge, so it was not removed.");
        if (power.Active() == owned) throw new InvalidOperationException("The Frameforge plan is active. Switch to another power plan or stop the boost first.");
        power.Delete(owned);
        if (power.Exists(owned)) throw new InvalidOperationException("Windows did not remove the Frameforge plan.");
        return "Frameforge High performance plan removed and verified.";
    }

    // deferElevated: the administrator prompt (services, standby list) runs on its own thread, so the session reports ready while it is open.
    public void Start(SessionCommand command, bool deferElevated = false)
    {
        timerRestartPending = command.TimerRestartPending;
        var mechanisms = command.Mechanisms ?? throw new InvalidOperationException("Missing booster mechanisms.");
        var identity = Valid(new ProcessTarget(command.GamePid, command.GameStartTime ?? "", command.GamePath ?? "", Path.GetFileNameWithoutExtension(command.GamePath ?? ""), "Normal"));
        var rules = command.Background ?? [];
        if (rules.Length > 50 || rules.Any(r => r is null || !Image.IsMatch(r.Image) || ProcessSafety.Denied(r.Image) || r.Action is not ("lower" or "suspend" or "close"))) throw new InvalidOperationException("Invalid background process list.");
        if (mechanisms.Priority is not ("Normal" or "AboveNormal" or "High")) throw new InvalidOperationException("Unsupported game priority.");
        if (ProcessSafety.Denied(identity.Name)) throw new InvalidOperationException("This process is protected. Frameforge does not boost system, security or anti-cheat processes.");
        var game = processes.Read(identity) ?? throw new InvalidOperationException("The game is not running. Start it again before boosting.");
        var all = processes.List();
        var info = all.FirstOrDefault(p => WindowsProcesses.Same(p.Target, game));
        if (info is null || info.Critical || info.SessionId == 0) throw new InvalidOperationException("This process is protected. Frameforge does not boost system processes.");
        // The services are planned and journaled first (the oldest entry, so crash recovery sees them), but the administrator
        // prompt itself runs after every other mechanism, so the game is already boosted while the prompt is open.
        if (mechanisms.PauseServices) PlanServices(command);
        if (mechanisms.StandbyPurge) PlanPurge(command);
        if (mechanisms.GameMode) Run("gameMode", GameMode);
        if (mechanisms.PowerPlan) Run("powerPlan", PowerPlan);
        if (mechanisms.PowerPlan && UsbSuspendOff() is { } usb) emit(new(usb.State, usb.Id, usb.Detail, Code: usb.Code));
        if (mechanisms.TimerResolution) Run("timerResolution", Timer);
        if (mechanisms.Priority != "Normal") Run("priority", () => Rank(game.Priority) >= Rank(mechanisms.Priority)
            ? new("priority", "skipped", $"{game.Name} already runs at {game.Priority}; not lowered.")
            : SetPriority("priority", game, mechanisms.Priority));
        if (mechanisms.Affinity is { Length: > 0 } cpus) Run("affinity", () => Affinity(game, cpus));
        if (mechanisms.GameBarCapture) Run("gameBarCapture", GameBarCapture);
        if (mechanisms.PowerThrottling) Run("powerThrottling", () => PowerThrottling(game));
        if (mechanisms.GpuPriority) Run("gpuPriority", () => GpuPriority(game));
        if (mechanisms.SmartCores) Run("smartCores", () => SmartCoresStep(game, mechanisms.Affinity is { Length: > 0 }, command.Preset));
        if (mechanisms.CoreParking) Run("coreParking", CoreParking);
        foreach (var rule in rules) Background(rule, mechanisms, info, command.ParentPid, all);
        foreach (var (action, id, on) in new[] { ("lower", "lowerBackground", mechanisms.LowerBackground), ("suspend", "suspendBackground", mechanisms.SuspendBackground), ("close", "closeBackground", mechanisms.CloseBackground) })
            if (on && !rules.Any(r => r.Action == action)) emit(new("skipped", id, "Not configured: no background apps are selected for this action. Pick apps on the Game Mode page."));
        BeginElevated(deferElevated);
    }
    public MechanismResult[] Revert()
    {
        CancelElevated();
        var results = Recover([.. captured]);
        captured.Clear();
        return results;
    }
    // Captures whose change never happened (the suspend call failed): kept in order so results stay one per capture, never undone.
    private readonly HashSet<Captured> notApplied = new(ReferenceEqualityComparer.Instance);
    private void Release(Captured item) { notApplied.Add(item); emit(new("released", item.Mechanism, Prior: item)); }
    // Reverse order of capture; every item is attempted (RevertOne never throws) and checks that Frameforge's value is still in place.
    // Results stay one per capture in reverse capture order (Node aligns them by index), but the services restart opens an
    // administrator prompt, so it is performed after every other revert: nothing else waits on the user.
    public MechanismResult[] Recover(Captured[] items)
    {
        var order = items.Reverse().ToArray();
        var results = new MechanismResult[order.Length];
        foreach (var servicesPass in new[] { false, true })
            for (var i = 0; i < order.Length; i++)
                if ((order[i]?.Mechanism == "pauseServices") == servicesPass) results[i] = RevertOne(order[i]);
        return results;
    }

    private void Capture(Captured item) { captured.Add(item); emit(new("captured", item.Mechanism, Prior: item)); }
    private void Run(string id, Func<MechanismResult> work)
    {
        MechanismResult result;
        try { result = work(); }
        catch (Exception error) { result = new(id, "failed", Describe(error)); }
        emit(new(result.State, result.Id, result.Detail, Code: result.Code));
    }
    public static string Describe(Exception error) => error switch
    {
        Win32Exception { NativeErrorCode: 5 } => "Windows refused the change (access denied). Nothing was changed.",
        InvalidOperationException or IOException => error.Message,
        _ => "Windows could not complete the change."
    };
    private static int Rank(string priority) => priority == "RealTime" ? int.MaxValue : Array.IndexOf(Ranks, priority);
    private static string Label(ProcessTarget p) => $"{p.Name} (pid {p.Pid})";

    private MechanismResult GameMode()
    {
        // Re-read at session start; never assumed from an earlier capability check.
        var snapshot = gameBar.Capture(GameModeIds);
        if (GameModeOn(snapshot))
            return new("gameMode", "skipped", snapshot.Values.Any(v => !v.Existed) ? "Windows Game Mode is already on (Windows default)." : "Windows Game Mode is already on.");
        Capture(new("gameMode", Registry: snapshot));
        gameBar.Apply(GameModeIds, snapshot);
        return gameBar.Verify(GameModeIds) ? new("gameMode", "applied", "Windows Game Mode was off; turned on and verified.") : new("gameMode", "failed", "Windows did not keep the Game Mode values.");
    }
    private MechanismResult PowerPlan()
    {
        if (PlanTarget(power, ownedPlan) is not { } target) return new("powerPlan", "unavailable", "High performance plan not present");
        var prior = power.Active();
        if (PerformancePlan(prior)) return new("powerPlan", "skipped", "A performance power plan is already active.");
        Capture(new("powerPlan", Prior: prior.ToString(), Applied: target.ToString()));
        power.SetActive(target);
        return power.Active() == target
            ? new("powerPlan", "applied", $"{PlanName(target)} power plan active and verified.")
            : new("powerPlan", "failed", "Windows did not keep the power plan.");
    }
    // Plan-only: while Frameforge's own plan is the active one, its plugged-in USB selective suspend is turned off, so USB devices
    // (mouse, keyboard, headset) are never put to sleep mid-game. Windows' built-in plans and other plans are never edited.
    // Returns null when this does not apply (another plan is active), so nothing is reported.
    private MechanismResult? UsbSuspendOff()
    {
        try
        {
            if (ownedPlan is not { } owned || extras?.PowerSettings is not { } settings) return null;
            var scheme = power.Active();
            if (scheme != owned) return null;
            if (settings.ReadAc(scheme, BoosterPaths.SubUsb, BoosterPaths.UsbSuspend) is not { } current)
                return new("powerPlan", "skipped", "Frameforge plan: this PC's plan does not expose USB selective suspend.");
            if (current == 0) return new("powerPlan", "skipped", "Frameforge plan: USB selective suspend is already off.");
            Capture(new("powerPlan", Prior: current.ToString(CultureInfo.InvariantCulture), Applied: "0", Scheme: scheme.ToString(), Setting: "usbsuspend"));
            settings.WriteAc(scheme, BoosterPaths.SubUsb, BoosterPaths.UsbSuspend, 0);
            if (power.Active() == scheme) power.SetActive(scheme);
            return settings.ReadAc(scheme, BoosterPaths.SubUsb, BoosterPaths.UsbSuspend) == 0
                ? new("powerPlan", "applied", "Frameforge plan: USB selective suspend switched off for the session (plan only) and verified.")
                : new("powerPlan", "failed", "Frameforge plan: Windows did not keep the USB selective suspend value.");
        }
        catch (Exception error) { return new("powerPlan", "failed", $"Frameforge plan: {Describe(error)}"); }
    }
    private MechanismResult RevertUsbSuspend(Captured item)
    {
        if (extras?.PowerSettings is not { } settings) throw new InvalidOperationException("Power setting access is not available in this build.");
        if (!Guid.TryParse(item.Scheme, out var scheme) || scheme != ownedPlan || !uint.TryParse(item.Prior, NumberStyles.None, CultureInfo.InvariantCulture, out var prior) || prior > 1 || item.Applied != "0")
            throw new InvalidOperationException("Invalid saved USB selective suspend value.");
        if (settings.ReadAc(scheme, BoosterPaths.SubUsb, BoosterPaths.UsbSuspend) is not { } current) return new("powerPlan", "reverted", "The plan or setting no longer exists; nothing to restore.");
        if (current == prior) return new("powerPlan", "reverted", $"USB selective suspend already back to {prior}.");
        if (current != 0) return new("powerPlan", "conflict", $"USB selective suspend was changed outside Frameforge to {current}; kept.");
        settings.WriteAc(scheme, BoosterPaths.SubUsb, BoosterPaths.UsbSuspend, prior);
        if (power.Active() == scheme) power.SetActive(scheme);
        return settings.ReadAc(scheme, BoosterPaths.SubUsb, BoosterPaths.UsbSuspend) == prior
            ? new("powerPlan", "reverted", "USB selective suspend restored and verified.")
            : new("powerPlan", "failed", "Windows did not restore USB selective suspend.");
    }
    private MechanismResult Timer()
    {
        if (timer.Unsupported is { } reason) return new("timerResolution", "unsupported", reason);
        if (timerRestartPending) return new("timerResolution", "unsupported", TimerRestartNote);
        Capture(new("timerResolution"));
        timerHeld = true;
        return timer.Request() ? new("timerResolution", "applied", "0.5 ms timer resolution requested and verified.") : new("timerResolution", "failed", "Windows did not grant the timer resolution.");
    }
    private MechanismResult SetPriority(string id, ProcessTarget process, string priority)
    {
        Capture(new(id, process, process.Priority, priority));
        processes.SetPriority(process, priority);
        return processes.Read(process)?.Priority == priority
            ? new(id, "applied", $"{Label(process)}: {priority} priority verified.")
            : new(id, "failed", $"{Label(process)}: Windows did not keep {priority} priority.");
    }
    private MechanismResult Affinity(ProcessTarget game, int[] cpus)
    {
        // ponytail: one 64-bit affinity mask (processor group 0); CPU sets per group if >64-CPU machines matter.
        var limit = Math.Min(processes.LogicalCpus, 64);
        if (cpus.Length > 64 || cpus.Any(c => c < 0 || c >= limit)) return new("affinity", "failed", $"Only CPUs 0 to {limit - 1} exist on this PC.");
        var mask = cpus.Aggregate(0UL, (m, c) => m | 1UL << c);
        var prior = processes.GetAffinity(game);
        if (prior == mask) return new("affinity", "skipped", "The game already uses exactly these CPUs.");
        Capture(new("affinity", game, prior.ToString(CultureInfo.InvariantCulture), mask.ToString(CultureInfo.InvariantCulture)));
        processes.SetAffinity(game, mask);
        return processes.GetAffinity(game) == mask ? new("affinity", "applied", $"Game limited to {cpus.Length} CPUs and verified.") : new("affinity", "failed", "Windows did not keep the CPU affinity.");
    }
    private void Background(BackgroundRule rule, Mechanisms mechanisms, ProcInfo game, int parentPid, ProcInfo[] all)
    {
        var (id, enabled) = rule.Action switch { "lower" => ("lowerBackground", mechanisms.LowerBackground), "suspend" => ("suspendBackground", mechanisms.SuspendBackground), _ => ("closeBackground", mechanisms.CloseBackground) };
        if (!enabled) { emit(new("skipped", id, $"{rule.Image}: this action is not part of the selected mode.")); return; }
        var parentPath = all.FirstOrDefault(p => p.Target.Pid == parentPid)?.Target.ExecutablePath;
        // GC-11: same session and owner as the game, never critical, denylisted, the game, Frameforge or this helper.
        var matches = all.Where(p => p.Sid is not null && p.Sid == game.Sid && p.SessionId == game.SessionId && p.SessionId != 0 && !p.Critical &&
            !ProcessSafety.Denied(p.Target.Name) && p.Target.Pid != game.Target.Pid && p.Target.Pid != selfPid && p.Target.Pid != parentPid &&
            !string.Equals(p.Target.ExecutablePath, parentPath, StringComparison.OrdinalIgnoreCase) && !p.Target.Name.StartsWith("Frameforge", StringComparison.OrdinalIgnoreCase) &&
            string.Equals(Path.GetFileName(p.Target.ExecutablePath), rule.Image, StringComparison.OrdinalIgnoreCase)).Select(p => p.Target).ToArray();
        if (matches.Length == 0) { emit(new("skipped", id, $"{rule.Image}: not running in your session, or protected.")); return; }
        if (id == "closeBackground")
        {
            Run(id, () => processes.Close(matches) is var closed && closed == matches.Length
                ? new(id, "applied", $"{rule.Image}: closed {closed} process(es). Not reversible: it is not reopened after the session.")
                : new(id, "failed", $"{rule.Image}: closed {closed} of {matches.Length} process(es)."));
            return;
        }
        for (var index = 0; index < matches.Length; index++)
        {
            var process = matches[index];
            if (captured.Count >= MaxCaptures)
            {
                emit(new("skipped", id, $"{rule.Image}: {matches.Length - index} more process(es) not changed; the session limit of {MaxCaptures} saved changes was reached."));
                return;
            }
            Run(id, () =>
            {
                if (id == "lowerBackground")
                    return Rank(process.Priority) <= Rank("BelowNormal") || process.Priority == "RealTime"
                        ? new(id, "skipped", $"{Label(process)}: already at {process.Priority}; not changed.")
                        : SetPriority(id, process, "BelowNormal");
                // Already frozen (Windows suspends packaged apps; other tools can too): not ours to change or resume.
                var (suspended, total) = processes.Threads(process);
                if (total > 0 && suspended == total) return new(id, "skipped", $"{Label(process)}: already suspended by Windows or another program; not changed.");
                var item = new Captured(id, process);
                Capture(item);
                bool verified;
                // A suspend call that threw did not suspend anything: release the capture so it is never "resumed".
                try { verified = processes.Suspend(process); }
                catch { Release(item); throw; }
                return verified ? new(id, "applied", $"{Label(process)}: suspended and verified.") : new(id, "failed", $"{Label(process)}: suspension could not be verified. It is resumed when the session ends.");
            });
        }
    }

    private MechanismResult RevertOne(Captured item)
    {
        var id = item?.Mechanism ?? "";
        if (item is not null && notApplied.Contains(item)) return new(id, "reverted", "Never applied; nothing to undo.");
        try
        {
            return id switch
            {
                "gameMode" => RevertGameMode(item!),
                "powerPlan" => item!.Setting == "usbsuspend" ? RevertUsbSuspend(item) : RevertPower(item),
                "timerResolution" => RevertTimer(),
                "priority" or "lowerBackground" => RevertPriority(item!),
                "affinity" => RevertAffinity(item!),
                "suspendBackground" => RevertSuspend(item!),
                "pauseServices" => RevertServices(item!),
                "gameBarCapture" => RevertRegValues(item!),
                "powerThrottling" => RevertPowerThrottling(item!),
                "gpuPriority" => RevertGpuPriority(item!),
                "smartCores" => RevertSmartCores(item!),
                "coreParking" => RevertCoreParking(item!),
                // Node only sends known mechanism ids; the ones without a revert (close) are reported under their own id.
                _ => new(id, "failed", "This saved change has no revert; nothing was changed.")
            };
        }
        catch (Exception error) { return new(id, "failed", Describe(error)); }
    }
    private MechanismResult RevertGameMode(Captured item)
    {
        if (item.Registry?.Values is not { Length: > 0 } values || values.Any(v => v?.Operation != "game-mode")) throw new InvalidOperationException("Invalid saved Game Mode values.");
        // Decide from values, not exception text: restore only while Frameforge's values (1) are still in place.
        var current = gameBar.Capture(GameModeIds).Values;
        if (current.All(c => values.Any(v => v.Name == c.Name && v.Existed == c.Existed && Equals(Norm(v.Value), Norm(c.Value)))))
            return new("gameMode", "reverted", "Windows Game Mode values are already restored.");
        if (!gameBar.Verify(GameModeIds)) return new("gameMode", "conflict", "Game Mode values were changed outside Frameforge; that change was kept.");
        gameBar.Restore(item.Registry);
        return new("gameMode", "reverted", "Windows Game Mode values restored and verified.");
    }
    private MechanismResult RevertPower(Captured item)
    {
        if (!Guid.TryParse(item.Prior, out var prior) || !Guid.TryParse(item.Applied, out var applied)) throw new InvalidOperationException("Invalid saved power plan.");
        var current = power.Active();
        // Checked before the allowlist so a removed Frameforge plan never blocks a recovery that has nothing left to do.
        if (current == prior) return new("powerPlan", "reverted", "The previous power plan is already active.");
        if (!PerformancePlan(applied)) throw new InvalidOperationException("Invalid saved power plan.");
        if (current != applied) return new("powerPlan", "conflict", "The power plan was changed outside Frameforge; that change was kept.");
        if (!power.Exists(prior)) return new("powerPlan", "failed", "The previous power plan no longer exists.");
        power.SetActive(prior);
        return power.Active() == prior ? new("powerPlan", "reverted", "Previous power plan restored and verified.") : new("powerPlan", "failed", "Windows did not restore the previous power plan.");
    }
    private MechanismResult RevertTimer()
    {
        if (!timerHeld) return new("timerResolution", "reverted", "The timer request ended with the session helper process.");
        timer.Release(); timerHeld = false;
        return new("timerResolution", "reverted", "Timer resolution request released.");
    }
    private MechanismResult RevertPriority(Captured item)
    {
        var process = Valid(item.Process);
        if (Rank(item.Prior ?? "") < 0 || Rank(item.Applied ?? "") < 0) throw new InvalidOperationException("Invalid saved priority.");
        var current = processes.Read(process);
        if (current is null) return new(item.Mechanism, "reverted", $"{Label(process)}: exited; nothing to restore.");
        if (current.Priority == item.Prior) return new(item.Mechanism, "reverted", $"{Label(process)}: already at {item.Prior}.");
        if (current.Priority != item.Applied) return new(item.Mechanism, "conflict", $"{Label(process)}: priority changed outside Frameforge to {current.Priority}; kept.");
        processes.SetPriority(process, item.Prior!);
        return processes.Read(process)?.Priority == item.Prior
            ? new(item.Mechanism, "reverted", $"{Label(process)}: {item.Prior} priority restored and verified.")
            : new(item.Mechanism, "failed", $"{Label(process)}: Windows did not restore {item.Prior} priority.");
    }
    private MechanismResult RevertAffinity(Captured item)
    {
        var process = Valid(item.Process);
        if (!ulong.TryParse(item.Prior, NumberStyles.None, CultureInfo.InvariantCulture, out var prior) || !ulong.TryParse(item.Applied, NumberStyles.None, CultureInfo.InvariantCulture, out var applied) || prior == 0) throw new InvalidOperationException("Invalid saved CPU affinity.");
        if (processes.Read(process) is null) return new("affinity", "reverted", $"{Label(process)}: exited; nothing to restore.");
        var current = processes.GetAffinity(process);
        if (current == prior) return new("affinity", "reverted", $"{Label(process)}: CPU affinity already restored.");
        if (current != applied) return new("affinity", "conflict", $"{Label(process)}: CPU affinity changed outside Frameforge; kept.");
        processes.SetAffinity(process, prior);
        return processes.GetAffinity(process) == prior ? new("affinity", "reverted", $"{Label(process)}: CPU affinity restored and verified.") : new("affinity", "failed", $"{Label(process)}: Windows did not restore the CPU affinity.");
    }
    private MechanismResult RevertSuspend(Captured item)
    {
        var process = Valid(item.Process);
        if (processes.Read(process) is null) return new("suspendBackground", "reverted", $"{Label(process)}: exited; nothing to resume.");
        // No thread suspended at all: our suspension is already gone. Otherwise resume exactly once, the counterpart of our one suspend,
        // even if only some threads are suspended (threads created after the suspend start unsuspended). Node drops a capture once it
        // reverted or conflicted, so a retry never resumes twice.
        if (processes.Threads(process).Suspended == 0) return new("suspendBackground", "reverted", $"{Label(process)}: already running; not resumed again.");
        processes.Resume(process);
        int suspended, total;
        // The resume happened; an unreadable re-check must not turn it into a failure that a retry would resume again.
        try { (suspended, total) = processes.Threads(process); }
        catch (Exception error) when (error is Win32Exception or InvalidOperationException or ArgumentException)
        { return new("suspendBackground", "reverted", $"{Label(process)}: resumed; the result could not be re-checked."); }
        return total > 0 && suspended == total
            ? new("suspendBackground", "conflict", $"{Label(process)}: still suspended by Windows or another program after Frameforge's resume; left as it is.")
            : new("suspendBackground", "reverted", $"{Label(process)}: resumed and verified.");
    }
    private static ProcessTarget Valid(ProcessTarget? target)
    {
        if (target is null || target.Pid <= 0 || target.Name is null || target.Name.Length > 160 ||
            !DateTime.TryParseExact(target.StartTime, "O", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var time) || time.Kind != DateTimeKind.Utc ||
            target.ExecutablePath is null || !Path.IsPathFullyQualified(target.ExecutablePath) || target.ExecutablePath.StartsWith(@"\\", StringComparison.Ordinal) ||
            !target.ExecutablePath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Invalid process identity.");
        return target;
    }
}

public static class SessionRunner
{
    // Reverts on game exit, stop, stdin EOF (Frameforge closed or crashed) or parent exit, then reports and returns.
    public static string Run(TextReader input, Action<object> write, BoostSessionEngine engine, SessionCommand start, WaitHandle? game, WaitHandle? parent, Func<object>? sample, int sampleMs = 30000)
    {
        string reason; string? detail = null;
        try
        {
            engine.Start(start, deferElevated: true);
            write(new { @event = "ready" });
            var done = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            if (game is not null) Task.Run(() => { game.WaitOne(); done.TrySetResult("game-exited"); });
            if (parent is not null) Task.Run(() => { parent.WaitOne(); done.TrySetResult("parent-exited"); });
            Task.Run(() =>
            {
                try
                {
                    while (input.ReadLine() is { } line)
                        if (line.Contains("\"stop\"", StringComparison.Ordinal)) { done.TrySetResult("stop"); return; }
                }
                catch (IOException) { }
                done.TrySetResult("stdin-closed");
            });
            while (!done.Task.Wait(sampleMs)) if (sample is not null) write(sample());
            reason = done.Task.Result;
        }
        catch (Exception error) { reason = "start-failed"; detail = BoostSessionEngine.Describe(error); }
        MechanismResult[] reverts;
        // Tells Frameforge the revert (and any administrator prompt in it) is starting, so it takes the elevation gate like a user Stop.
        write(new { @event = "ending", reason });
        // Revert never throws per item; this guard keeps "ended" (and the exit) reachable even on an unexpected fault.
        try { reverts = engine.Revert(); }
        catch (Exception error) { reverts = []; detail = $"Revert stopped unexpectedly: {BoostSessionEngine.Describe(error)}"; }
        write(new Ended("ended", reason, detail, reverts));
        return reason;
    }

    public static void Host()
    {
        var options = HelperJson.Options;
        var gate = new object();
        void Write(object value)
        {
            // A closed pipe must never stop the revert.
            lock (gate) { try { Console.Out.WriteLine(JsonSerializer.Serialize(value, value.GetType(), options)); Console.Out.Flush(); } catch (IOException) { } }
        }
        var line = Console.ReadLine();
        if (line is null || line.Length > 65536) return;
        var command = JsonSerializer.Deserialize<SessionCommand>(line, options);
        if (command?.Command != "start") return;
        ElevatedLaunchers.BrokerOnly = command.BrokerOnly;
        Guid? owned = Guid.TryParse(command.OwnedPlan, out var plan) ? plan : null;
        SafeProcessHandle? game = null, parent = null;
        // Fail closed before any change: the session must be able to watch both the game and Frameforge.
        string? refused = null;
        try { game = WindowsProcesses.Open(command.GamePid, WindowsProcesses.Synchronize | WindowsProcesses.QueryLimited); }
        catch (Win32Exception) { refused = "Windows refused access to the game process (it may be protected). Nothing was changed."; }
        try { parent = WindowsProcesses.Open(command.ParentPid, WindowsProcesses.Synchronize); }
        catch (Win32Exception) { }
        if (game is null) refused ??= "The game is not running. Nothing was changed.";
        if (parent is null) refused ??= "Frameforge's own process could not be watched, so the boost did not start. Nothing was changed.";
        if (refused is not null)
        {
            Write(new Ended("ended", "start-failed", refused, []));
            game?.Dispose(); parent?.Dispose();
            return;
        }
        using var gameWait = Wait(game!);
        using var parentWait = Wait(parent!);
        var engine = new BoostSessionEngine(new WindowsProcessControl(), new WindowsPowerStore(), new WindowsTimerControl(), new WindowsRegistryStore(), step => Write(step), Environment.ProcessId, owned, Extras.Windows());
        var sampler = new Sampler(command.GamePid);
        Run(Console.In, Write, engine, command, gameWait, parentWait, sampler.Sample);
        game!.Dispose(); parent!.Dispose();
    }
    private static WaitHandle Wait(SafeProcessHandle handle) => new ManualResetEvent(false) { SafeWaitHandle = new SafeWaitHandle(handle.DangerousGetHandle(), false) };

    private sealed class Sampler
    {
        private readonly int pid; private long idle, kernel, user;
        public Sampler(int pid) { this.pid = pid; GetSystemTimes(out idle, out kernel, out user); }
        public object Sample()
        {
            GetSystemTimes(out var i, out var k, out var u);
            var total = k - kernel + (u - user); var busy = total - (i - idle);
            (idle, kernel, user) = (i, k, u);
            var memory = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
            GlobalMemoryStatusEx(ref memory);
            long workingSet = 0;
            try { using var process = Process.GetProcessById(pid); workingSet = process.WorkingSet64; } catch (Exception error) when (error is ArgumentException or InvalidOperationException) { }
            return new { @event = "sample", at = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture), systemCpuPercent = total > 0 ? Math.Clamp(Math.Round(100.0 * busy / total, 1), 0, 100) : 0, availableMemoryBytes = memory.AvailablePhysical, gameWorkingSetBytes = workingSet };
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus { public uint Length, MemoryLoad; public ulong TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile, TotalVirtual, AvailableVirtual, AvailableExtendedVirtual; }
    [DllImport("kernel32.dll")] private static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
    [DllImport("kernel32.dll")] private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
}

public sealed class WindowsProcessControl : IProcessControl
{
    public int LogicalCpus => Environment.ProcessorCount;
    // The verified handle pins the pid, so the second handle opened by pid reaches the same process.
    internal static SafeProcessHandle Verified(ProcessTarget identity, uint access)
    {
        var handle = WindowsProcesses.Open(identity.Pid, WindowsProcesses.QueryLimited | access);
        var current = handle is null ? null : WindowsProcesses.Read(handle, identity.Pid);
        if (current is not null && WindowsProcesses.Same(current, identity)) return handle!;
        handle?.Dispose();
        throw new InvalidOperationException($"{identity.Name} has exited.");
    }
    public ProcessTarget? Read(ProcessTarget identity)
    {
        using var handle = WindowsProcesses.Open(identity.Pid, WindowsProcesses.QueryLimited);
        var current = handle is null ? null : WindowsProcesses.Read(handle, identity.Pid);
        return current is not null && WindowsProcesses.Same(current, identity) ? current : null;
    }
    public void SetPriority(ProcessTarget identity, string priority)
    {
        using var handle = Verified(identity, WindowsProcesses.SetInformation);
        if (!SetPriorityClass(handle, WindowsProcesses.PriorityValue(priority))) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public ulong GetAffinity(ProcessTarget identity)
    {
        using var handle = Verified(identity, 0);
        if (!GetProcessAffinityMask(handle, out var mask, out _)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return (ulong)mask;
    }
    public void SetAffinity(ProcessTarget identity, ulong mask)
    {
        using var handle = Verified(identity, WindowsProcesses.SetInformation);
        if (!SetProcessAffinityMask(handle, (UIntPtr)mask)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public bool Suspend(ProcessTarget identity)
    {
        using var handle = Verified(identity, WindowsProcesses.SuspendResume);
        var status = NtSuspendProcess(handle);
        if (status != 0) throw new InvalidOperationException($"{identity.Name}: Windows refused to suspend it (status 0x{status:X8}).");
        // NtSuspendProcess succeeded, so this process is suspended: a failed re-read means "unverified", never "not applied".
        try { return Count(identity.Pid) is var (suspended, total) && total > 0 && suspended == total; }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or Win32Exception) { return false; }
    }
    public void Resume(ProcessTarget identity)
    {
        using var handle = Verified(identity, WindowsProcesses.SuspendResume);
        var status = NtResumeProcess(handle);
        if (status != 0) throw new InvalidOperationException($"{identity.Name}: Windows refused to resume it (status 0x{status:X8}).");
    }
    public (int Suspended, int Total) Threads(ProcessTarget identity)
    {
        using var handle = Verified(identity, 0);
        return Count(identity.Pid);
    }
    private static (int Suspended, int Total) Count(int pid)
    {
        using var process = Process.GetProcessById(pid);
        var threads = process.Threads.Cast<ProcessThread>().ToArray();
        return (threads.Count(t => t.ThreadState == System.Diagnostics.ThreadState.Wait && t.WaitReason == ThreadWaitReason.Suspended), threads.Length);
    }
    public int Close(ProcessTarget[] identities)
    {
        var open = new List<(SafeProcessHandle Handle, Process Process)>();
        try
        {
            foreach (var identity in identities)
            {
                var handle = Verified(identity, WindowsProcesses.Synchronize | WindowsProcesses.Terminate);
                var process = Process.GetProcessById(identity.Pid);
                open.Add((handle, process));
                process.CloseMainWindow();
            }
            var deadline = DateTime.UtcNow.AddSeconds(5);
            foreach (var (handle, _) in open)
            {
                using var wait = new ManualResetEvent(false) { SafeWaitHandle = new SafeWaitHandle(handle.DangerousGetHandle(), false) };
                if (!wait.WaitOne(TimeSpan.FromMilliseconds(Math.Max(0, (deadline - DateTime.UtcNow).TotalMilliseconds))))
                {
                    TerminateProcess(handle, 1);
                    wait.WaitOne(2000);
                }
            }
            return open.Count(o => o.Process.HasExited);
        }
        finally { foreach (var (handle, process) in open) { handle.Dispose(); process.Dispose(); } }
    }
    public ProcInfo[] List()
    {
        var results = new List<ProcInfo>();
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                try
                {
                    using var handle = WindowsProcesses.Open(process.Id, WindowsProcesses.QueryLimited);
                    var current = handle is null ? null : WindowsProcesses.Read(handle, process.Id);
                    if (current is null) continue;
                    results.Add(new(current, process.SessionId, Sid(handle!), WindowsProcesses.IsCritical(handle!)));
                }
                catch (Exception error) when (error is Win32Exception or InvalidOperationException or IOException or UnauthorizedAccessException) { }
            }
        }
        return [.. results];
    }
    public static ProcessEntry[] Entries()
    {
        var session = Process.GetCurrentProcess().SessionId;
        var sid = WindowsIdentity.GetCurrent().User?.Value;
        // Two reads a moment apart give each program its share of the CPU; memory is the second read.
        var first = MonitorSampler.Snapshot().ToDictionary(p => p.Pid, p => p.CpuTicks);
        var started = Stopwatch.GetTimestamp();
        Thread.Sleep(500);
        var second = MonitorSampler.Snapshot().ToDictionary(p => p.Pid);
        var seconds = Math.Max(0.1, (Stopwatch.GetTimestamp() - started) / (double)Stopwatch.Frequency);
        (long? Ws, double? Cpu) Use(int pid) => second.TryGetValue(pid, out var now)
            ? (now.WorkingSet, first.TryGetValue(pid, out var before) && now.CpuTicks >= before ? Math.Round(Math.Clamp((now.CpuTicks - before) / 1e7 / seconds / Environment.ProcessorCount * 100, 0, 100), 1) : null)
            : (null, null);
        return new WindowsProcessControl().List()
            .Select(p => (Process: p, Use: Use(p.Target.Pid)))
            .Select(x => new ProcessEntry(Path.GetFileName(x.Process.Target.ExecutablePath), x.Process.Target.Pid,
                x.Process.Critical || x.Process.Sid is null || x.Process.Sid != sid || x.Process.SessionId != session || ProcessSafety.Denied(x.Process.Target.Name) || x.Process.Target.Name.StartsWith("Frameforge", StringComparison.OrdinalIgnoreCase),
                x.Use.Ws, x.Use.Cpu, x.Process.Target.ExecutablePath.Length <= 520 ? x.Process.Target.ExecutablePath : null))
            .Where(e => e.Image.Length <= 64)
            .OrderBy(e => e.Image, StringComparer.OrdinalIgnoreCase).Take(500).ToArray();
    }
    // Null (treated as protected) when the owner cannot be read.
    private static string? Sid(SafeProcessHandle handle)
    {
        if (!OpenProcessToken(handle, 0x0008, out var token)) return null;
        try { using var identity = new WindowsIdentity(token); return identity.User?.Value; }
        catch (Exception error) when (error is ArgumentException or UnauthorizedAccessException or SecurityException) { return null; }
        finally { CloseHandle(token); }
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetPriorityClass(SafeProcessHandle handle, uint priorityClass);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessAffinityMask(SafeProcessHandle handle, out UIntPtr process, out UIntPtr system);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetProcessAffinityMask(SafeProcessHandle handle, UIntPtr mask);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(SafeProcessHandle handle, uint exitCode);
    [DllImport("ntdll.dll")] private static extern int NtSuspendProcess(SafeProcessHandle handle);
    [DllImport("ntdll.dll")] private static extern int NtResumeProcess(SafeProcessHandle handle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(SafeProcessHandle handle, uint access, out IntPtr token);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}

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
    // Same as powercfg /duplicatescheme, in-process, into the caller's GUID (a non-NULL destination pointer is used as-is).
    public void Duplicate(Guid source, Guid destination, string name)
    {
        var pointer = Marshal.AllocHGlobal(16);
        try
        {
            Marshal.StructureToPtr(destination, pointer, false);
            var error = PowerDuplicateScheme(IntPtr.Zero, ref source, ref pointer);
            if (error != 0) throw new Win32Exception((int)error);
        }
        finally { Marshal.FreeHGlobal(pointer); }
        var text = System.Text.Encoding.Unicode.GetBytes(name + "\0");
        var named = PowerWriteFriendlyName(IntPtr.Zero, ref destination, IntPtr.Zero, IntPtr.Zero, text, (uint)text.Length);
        if (named != 0)
        {
            // An unnamed copy could not be told apart from Windows' own plan: remove it, and say so if that fails too.
            if (PowerDeleteScheme(IntPtr.Zero, ref destination) != 0)
                throw new InvalidOperationException("Windows created the plan copy but could neither name nor remove it. Use Remove Frameforge plan to clean it up.");
            throw new Win32Exception((int)named);
        }
    }
    public Guid[] List()
    {
        var found = new List<Guid>();
        var buffer = Marshal.AllocHGlobal(16);
        try
        {
            for (uint index = 0; ; index++)
            {
                uint size = 16;
                var error = PowerEnumerate(IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 16, index, buffer, ref size);
                if (error == 259) return [.. found];
                if (error != 0) throw new Win32Exception((int)error);
                found.Add(Marshal.PtrToStructure<Guid>(buffer));
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    public string? Name(Guid scheme)
    {
        uint size = 0;
        if (PowerReadFriendlyName(IntPtr.Zero, ref scheme, IntPtr.Zero, IntPtr.Zero, null, ref size) != 0 || size == 0 || size > 4096) return null;
        var buffer = new byte[size];
        return PowerReadFriendlyName(IntPtr.Zero, ref scheme, IntPtr.Zero, IntPtr.Zero, buffer, ref size) == 0
            ? System.Text.Encoding.Unicode.GetString(buffer, 0, (int)size).TrimEnd('\0')
            : null;
    }
    public void Delete(Guid scheme)
    {
        var error = PowerDeleteScheme(IntPtr.Zero, ref scheme);
        if (error != 0) throw new Win32Exception((int)error);
    }
    [DllImport("powrprof.dll")] private static extern uint PowerDuplicateScheme(IntPtr root, ref Guid source, ref IntPtr destination);
    [DllImport("powrprof.dll")] private static extern uint PowerDeleteScheme(IntPtr root, ref Guid scheme);
    [DllImport("powrprof.dll")] private static extern uint PowerWriteFriendlyName(IntPtr root, ref Guid scheme, IntPtr subgroup, IntPtr setting, byte[] buffer, uint size);
    [DllImport("powrprof.dll")] private static extern uint PowerReadFriendlyName(IntPtr root, ref Guid scheme, IntPtr subgroup, IntPtr setting, byte[]? buffer, ref uint size);
    [DllImport("powrprof.dll")] private static extern uint PowerGetActiveScheme(IntPtr root, out IntPtr scheme);
    [DllImport("powrprof.dll")] private static extern uint PowerSetActiveScheme(IntPtr root, ref Guid scheme);
    [DllImport("powrprof.dll")] private static extern uint PowerEnumerate(IntPtr root, IntPtr scheme, IntPtr subgroup, uint flags, uint index, IntPtr buffer, ref uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
}

public sealed class WindowsTimerControl : ITimerControl
{
    public const string KernelKey = @"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\kernel", Flag = "GlobalTimerResolutionRequests";
    public string? Unsupported => BoostSessionEngine.TimerSupport(Environment.OSVersion.Version.Build, Registry.GetValue(KernelKey, Flag, null));
    public TimerGlobal Global => new(Environment.OSVersion.Version.Build >= 22000, Registry.GetValue(KernelKey, Flag, null) is 1);
    public bool Request() => NtSetTimerResolution(5000, true, out _) == 0 && NtQueryTimerResolution(out _, out var finest, out var current) == 0 && current <= Math.Max(5000u, finest);
    public void Release() => NtSetTimerResolution(5000, false, out _);
    [DllImport("ntdll.dll")] private static extern int NtSetTimerResolution(uint desired, bool set, out uint current);
    [DllImport("ntdll.dll")] private static extern int NtQueryTimerResolution(out uint coarsest, out uint finest, out uint current);
}
