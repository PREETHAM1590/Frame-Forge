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

public record Mechanisms(bool GameMode, string Priority, int[]? Affinity, bool PowerPlan, bool LowerBackground, bool SuspendBackground, bool CloseBackground, bool TimerResolution);
public record BackgroundRule(string Image, string Action);
public record SessionCommand(string Command, int GamePid = 0, string? GameStartTime = null, string? GamePath = null, Mechanisms? Mechanisms = null, BackgroundRule[]? Background = null, int ParentPid = 0, string? OwnedPlan = null);
// Prior state saved before a change. Applied is what Frameforge set, so a revert only happens while it is still in place.
// Only these optional members omit nulls; registry snapshots keep an explicit `value: null` for absent values.
public record Captured(string Mechanism, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ProcessTarget? Process = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Prior = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Applied = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Snapshot? Registry = null);
public record MechanismResult(string Id, string State, string Detail);
public record Step(string Event, string Mechanism, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Detail = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Captured? Prior = null);
public record Ended(string Event, string Reason, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Detail, MechanismResult[] Reverts);
public record ProcInfo(ProcessTarget Target, int SessionId, string? Sid, bool Critical);
// Active: the mechanism's effect is already in place on this PC (for example Game Mode already on).
public record Capability(string Id, bool Available, string Detail, bool Active = false);
public record BoostCapabilities(int LogicalCpus, Capability[] Mechanisms);
public record ProcessEntry(string Image, int Pid, bool Protected);
public static class HelperJson
{
    public static readonly JsonSerializerOptions Options = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
}

public interface IPowerStore { Guid Active(); bool Exists(Guid scheme); void SetActive(Guid scheme); Guid Duplicate(Guid source, string name); void Delete(Guid scheme); }
public interface ITimerControl { string? Unsupported { get; } bool Request(); void Release(); }
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
    void Resume(ProcessTarget identity);
    // True only when every thread of the process is suspended.
    bool IsSuspended(ProcessTarget identity);
    int Close(ProcessTarget[] identities);
}

// ownedPlan: a plan Frameforge created with the user's consent (GUID recorded in SQLite), allowlisted next to the Windows plans.
public sealed class BoostSessionEngine(IProcessControl processes, IPowerStore power, ITimerControl timer, IRegistryStore registry, Action<Step> emit, int selfPid, Guid? ownedPlan = null)
{
    public static readonly Guid HighPerformance = new("8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"), Ultimate = new("e9a42b02-d5df-448d-aa00-03f14749eb61");
    public const string OwnedPlanName = "Frameforge High performance";
    // Bounds the saved state of one session; further background matches are skipped with a visible reason.
    public const int MaxCaptures = 200;
    private static readonly string[] Ranks = ["Idle", "BelowNormal", "Normal", "AboveNormal", "High"];
    private static readonly string[] GameModeIds = ["game-mode"];
    private static readonly Regex Image = new(@"^[\w .()-]{1,64}\.exe$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private readonly List<Captured> captured = [];
    private readonly RegistryOperations gameBar = new(registry);
    private bool timerHeld;

    public static string? TimerSupport(int build, object? globalFlag)
    {
        if (build < 19041) return null;
        if (build < 22000) return "On Windows 10 version 2004 and later a timer request only affects the requesting process, so it cannot reach the game.";
        return globalFlag is 1 ? null : "Since Windows 10 version 2004 a timer request only affects the requesting process unless GlobalTimerResolutionRequests is enabled. Frameforge does not change that machine-wide setting.";
    }
    private static Guid? PlanTarget(IPowerStore power, Guid? owned) =>
        power.Exists(HighPerformance) ? HighPerformance : power.Exists(Ultimate) ? Ultimate : owned is { } o && power.Exists(o) ? o : null;
    private static string PlanName(Guid plan) => plan == HighPerformance ? "High performance" : plan == Ultimate ? "Ultimate performance" : OwnedPlanName;
    // Windows treats absent GameBar values as on, so only an explicit 0 means Game Mode is off.
    private static bool GameModeOn(Snapshot current) => current.Values.All(v => !v.Existed || Equals(Norm(v.Value), 1));
    private static object? Norm(object? value) => value is JsonElement json
        ? json.ValueKind switch { JsonValueKind.Number => json.GetInt32(), JsonValueKind.String => json.GetString(), _ => null }
        : value;
    public static BoostCapabilities Capabilities(IPowerStore power, ITimerControl timer, int cpus, IRegistryStore registry, Guid? ownedPlan)
    {
        var target = PlanTarget(power, ownedPlan);
        var timerReason = timer.Unsupported;
        var gameModeOn = GameModeOn(new RegistryOperations(registry).Capture(GameModeIds));
        return new(cpus, [
            new("gameMode", true, gameModeOn ? "Already on in Windows; a session leaves it as it is." : "Off in Windows; a session turns it on and restores it afterwards.", gameModeOn),
            new("powerPlan", target is not null, target is { } plan ? $"{PlanName(plan)} plan present." : "High performance plan not present", target is { } t && power.Active() == t),
            new("priority", true, "Normal, Above normal or High. Real-time is never used."),
            new("affinity", cpus > 0, $"{Math.Min(cpus, 64)} logical CPUs selectable."),
            new("lowerBackground", true, "Selected apps run at Below normal during the session."),
            new("suspendBackground", true, "Selected apps are suspended and resumed afterwards."),
            new("closeBackground", true, "Selected apps are closed and not reopened."),
            new("timerResolution", timerReason is null, timerReason ?? "0.5 ms timer requested for the session."),
            new("standbyPurge", false, "Needs administrator rights and SeProfileSingleProcessPrivilege. Frameforge runs without elevation.")
        ]);
    }
    // Explicit, consent-gated: copies Windows' High performance (or Ultimate) template into a new plan. The active plan is not changed.
    public static Guid CreatePlan(IPowerStore power)
    {
        foreach (var source in new[] { HighPerformance, Ultimate })
        {
            Guid created;
            try { created = power.Duplicate(source, OwnedPlanName); }
            catch (Win32Exception) { continue; }
            if (power.Exists(created)) return created;
        }
        throw new InvalidOperationException("Windows did not allow creating a High performance plan on this PC (common on Modern Standby devices). Nothing was changed.");
    }
    // Removes only the plan Frameforge created, and never while it is active.
    public static string DeletePlan(IPowerStore power, Guid owned)
    {
        if (owned == HighPerformance || owned == Ultimate) throw new InvalidOperationException("Only the plan Frameforge created can be removed.");
        if (!power.Exists(owned)) return "The Frameforge plan was already removed.";
        if (power.Active() == owned) throw new InvalidOperationException("The Frameforge plan is active. Switch to another power plan or stop the boost first.");
        power.Delete(owned);
        if (power.Exists(owned)) throw new InvalidOperationException("Windows did not remove the Frameforge plan.");
        return "Frameforge High performance plan removed and verified.";
    }

    public void Start(SessionCommand command)
    {
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
        if (mechanisms.GameMode) Run("gameMode", GameMode);
        if (mechanisms.PowerPlan) Run("powerPlan", PowerPlan);
        if (mechanisms.TimerResolution) Run("timerResolution", Timer);
        if (mechanisms.Priority != "Normal") Run("priority", () => Rank(game.Priority) >= Rank(mechanisms.Priority)
            ? new("priority", "skipped", $"{game.Name} already runs at {game.Priority}; not lowered.")
            : SetPriority("priority", game, mechanisms.Priority));
        if (mechanisms.Affinity is { Length: > 0 } cpus) Run("affinity", () => Affinity(game, cpus));
        foreach (var rule in rules) Background(rule, mechanisms, info, command.ParentPid, all);
        foreach (var (action, id, on) in new[] { ("lower", "lowerBackground", mechanisms.LowerBackground), ("suspend", "suspendBackground", mechanisms.SuspendBackground), ("close", "closeBackground", mechanisms.CloseBackground) })
            if (on && !rules.Any(r => r.Action == action)) emit(new("skipped", id, "Not configured: no background apps are selected for this action. Pick apps on the Game Mode page."));
    }
    public MechanismResult[] Revert()
    {
        var results = Recover([.. captured]);
        captured.Clear();
        return results;
    }
    // Reverse order of capture; every item is attempted (RevertOne never throws) and checks that Frameforge's value is still in place.
    public MechanismResult[] Recover(Captured[] items) => items.Reverse().Select(RevertOne).ToArray();

    private void Capture(Captured item) { captured.Add(item); emit(new("captured", item.Mechanism, Prior: item)); }
    private void Run(string id, Func<MechanismResult> work)
    {
        MechanismResult result;
        try { result = work(); }
        catch (Exception error) { result = new(id, "failed", Describe(error)); }
        emit(new(result.State, result.Id, result.Detail));
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
        if (prior == HighPerformance || prior == Ultimate || prior == ownedPlan) return new("powerPlan", "skipped", "A performance power plan is already active.");
        Capture(new("powerPlan", Prior: prior.ToString(), Applied: target.ToString()));
        power.SetActive(target);
        return power.Active() == target
            ? new("powerPlan", "applied", $"{PlanName(target)} power plan active and verified.")
            : new("powerPlan", "failed", "Windows did not keep the power plan.");
    }
    private MechanismResult Timer()
    {
        if (timer.Unsupported is { } reason) return new("timerResolution", "unsupported", reason);
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
                Capture(new(id, process));
                return processes.Suspend(process) ? new(id, "applied", $"{Label(process)}: suspended and verified.") : new(id, "failed", $"{Label(process)}: suspension could not be verified. It is resumed when the session ends.");
            });
        }
    }

    private MechanismResult RevertOne(Captured item)
    {
        var id = item?.Mechanism ?? "";
        try
        {
            return id switch
            {
                "gameMode" => RevertGameMode(item!),
                "powerPlan" => RevertPower(item!),
                "timerResolution" => RevertTimer(),
                "priority" or "lowerBackground" => RevertPriority(item!),
                "affinity" => RevertAffinity(item!),
                "suspendBackground" => RevertSuspend(item!),
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
        if (!Guid.TryParse(item.Prior, out var prior) || !Guid.TryParse(item.Applied, out var applied) || (applied != HighPerformance && applied != Ultimate && applied != ownedPlan)) throw new InvalidOperationException("Invalid saved power plan.");
        var current = power.Active();
        if (current == prior) return new("powerPlan", "reverted", "The previous power plan is already active.");
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
        // Not suspended any more: already resumed (an earlier revert or another program); never resume twice.
        if (!processes.IsSuspended(process)) return new("suspendBackground", "reverted", $"{Label(process)}: already running; not resumed again.");
        processes.Resume(process);
        return processes.IsSuspended(process)
            ? new("suspendBackground", "failed", $"{Label(process)}: still suspended after resume. Another program may also have suspended it.")
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
            engine.Start(start);
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
        var engine = new BoostSessionEngine(new WindowsProcessControl(), new WindowsPowerStore(), new WindowsTimerControl(), new WindowsRegistryStore(), step => Write(step), Environment.ProcessId, owned);
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
    private static SafeProcessHandle Verified(ProcessTarget identity, uint access)
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
        return AllThreadsSuspended(identity.Pid);
    }
    public void Resume(ProcessTarget identity)
    {
        using var handle = Verified(identity, WindowsProcesses.SuspendResume);
        var status = NtResumeProcess(handle);
        if (status != 0) throw new InvalidOperationException($"{identity.Name}: Windows refused to resume it (status 0x{status:X8}).");
    }
    public bool IsSuspended(ProcessTarget identity)
    {
        using var handle = Verified(identity, 0);
        return AllThreadsSuspended(identity.Pid);
    }
    private static bool AllThreadsSuspended(int pid)
    {
        using var process = Process.GetProcessById(pid);
        var threads = process.Threads.Cast<ProcessThread>().ToArray();
        return threads.Length > 0 && threads.All(t => t.ThreadState == System.Diagnostics.ThreadState.Wait && t.WaitReason == ThreadWaitReason.Suspended);
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
        return new WindowsProcessControl().List()
            .Select(p => new ProcessEntry(Path.GetFileName(p.Target.ExecutablePath), p.Target.Pid,
                p.Critical || p.Sid is null || p.Sid != sid || p.SessionId != session || ProcessSafety.Denied(p.Target.Name) || p.Target.Name.StartsWith("Frameforge", StringComparison.OrdinalIgnoreCase)))
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

public sealed class WindowsTimerControl : ITimerControl
{
    public string? Unsupported => BoostSessionEngine.TimerSupport(Environment.OSVersion.Version.Build,
        Registry.GetValue(@"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\kernel", "GlobalTimerResolutionRequests", null));
    public bool Request() => NtSetTimerResolution(5000, true, out _) == 0 && NtQueryTimerResolution(out _, out var finest, out var current) == 0 && current <= Math.Max(5000u, finest);
    public void Release() => NtSetTimerResolution(5000, false, out _);
    [DllImport("ntdll.dll")] private static extern int NtSetTimerResolution(uint desired, bool set, out uint current);
    [DllImport("ntdll.dll")] private static extern int NtQueryTimerResolution(out uint coarsest, out uint finest, out uint current);
}
