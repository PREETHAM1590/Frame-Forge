using System.ComponentModel;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Frameforge.Windows;

// Everything the second-pass mechanisms need from Windows, so tests can supply fakes. A missing member makes its mechanism
// report "unsupported" instead of guessing.
public sealed record Extras(
    IRegistryAccess? Registry = null, IPowerSettings? PowerSettings = null, IPowerThrottling? Throttling = null, ICpuTopology? Topology = null,
    ICpuSets? CpuSets = null, IGpuInfo? Gpus = null, IServiceStore? Services = null, IServiceElevator? Elevator = null, IControllerProbe? Controllers = null,
    int Build = 0,
    // False for automatic recovery: it must never open an administrator prompt the user did not ask for.
    bool Elevate = true)
{
    public static Extras Windows(bool elevate = true) => new(new WindowsRegistryAccess(), new WindowsPowerSettings(), new WindowsPowerThrottling(), new WindowsCpuTopology(),
        new WindowsCpuSets(), new WindowsGpuInfo(), new WindowsServiceStore(), new WindowsServiceElevator(), new WindowsControllerProbe(), Environment.OSVersion.Version.Build, elevate);
}

public sealed partial class BoostSessionEngine
{
    public const string AutoSkipServices = "Auto-boost never opens an administrator prompt. Start the boost yourself to pause services.";
    private const int PowerThrottlingBuild = 16299;
    private const uint ExecutionSpeed = 1;
    private ServicePlan? servicePlan;
    private Captured? serviceCapture;

    private static MechanismResult Unsupported(string id, string reason) => new(id, "unsupported", reason);
    private static object? NormReg(object? value) => value is JsonElement json
        ? json.ValueKind switch { JsonValueKind.Number => json.GetInt32(), JsonValueKind.String => json.GetString(), _ => null }
        : value;
    private static string Join(IEnumerable<string> items) => string.Join(", ", items);

    // ---- Services: planned and journaled before anything else, elevated last, so the revert runs last as well. ----
    private void PlanServices(SessionCommand command)
    {
        if (extras?.Services is null || extras.Elevator is null) { Run("pauseServices", () => Unsupported("pauseServices", "Service control is not available in this build.")); return; }
        if (command.Unattended) { emit(new("skipped", "pauseServices", AutoSkipServices)); return; }
        ServicePlan plan;
        try { plan = ServicePolicy.Plan(extras.Services, command.StoreGame, extras.Controllers?.XboxControllerConnected() ?? true); }
        catch (Exception error) { emit(new("failed", "pauseServices", $"Services could not be read: {Describe(error)}")); return; }
        if (plan.Targets.Length == 0)
        {
            emit(new("skipped", "pauseServices", $"No pausable service is running. {Join(plan.Skipped.Take(4).Select(s => $"{s.Name}: {s.Detail}"))}".Trim()));
            return;
        }
        servicePlan = plan;
        // GC-10: the planned names are saved before the administrator prompt. If Frameforge dies during it, recovery starts whichever are stopped.
        serviceCapture = new Captured("pauseServices", Items: plan.Targets);
        Capture(serviceCapture);
    }
    private void PauseServices()
    {
        if (servicePlan is null || serviceCapture is null) return;
        var plan = servicePlan; var item = serviceCapture;
        Run("pauseServices", () =>
        {
            ServiceBatch batch;
            try { batch = extras!.Elevator!.Run("stop", plan.Targets); }
            catch (Exception error)
            {
                // Unknown how far it got: keep the saved names so the session end starts any that are stopped.
                return new("pauseServices", "failed", $"The administrator step failed ({Describe(error)}). Any service it stopped is restarted when the session ends.");
            }
            if (batch.Declined) { Release(item); return new("pauseServices", "skipped", "Skipped (admin declined): Windows asked for administrator approval and it was declined. No service was stopped."); }
            if (batch.Error is not null) return new("pauseServices", "failed", $"{batch.Error} Any service it stopped is restarted when the session ends.");
            var stopped = batch.Outcomes.Where(o => o.State == "stopped").Select(o => o.Name).ToArray();
            var rest = batch.Outcomes.Where(o => o.State != "stopped").Select(o => $"{o.Name}: {o.Detail}").ToArray();
            if (stopped.Length == 0) { Release(item); return new("pauseServices", batch.Outcomes.Any(o => o.State == "failed") ? "failed" : "skipped", $"No service was stopped. {Join(rest)}".Trim()); }
            // The state is re-read without elevation; Windows can restart trigger-started services on its own.
            var back = stopped.Where(n => { try { return extras.Services!.Query(n).Running; } catch (Win32Exception) { return false; } }).ToArray();
            var detail = $"Paused {stopped.Length} service(s): {Join(stopped)}. Start types are unchanged.";
            if (back.Length > 0) detail += $" Windows restarted {Join(back)} already.";
            if (rest.Length > 0) detail += $" Not paused: {Join(rest.Take(3))}.";
            return new("pauseServices", "applied", detail);
        });
    }
    private MechanismResult RevertServices(Captured item)
    {
        var names = item.Items ?? throw new InvalidOperationException("Invalid saved service list.");
        if (names.Length is 0 or > ServiceCommands.MaxServices || names.Any(n => !ServicePolicy.Allowed(n))) throw new InvalidOperationException("Invalid saved service list.");
        if (extras?.Services is null || extras.Elevator is null) throw new InvalidOperationException("Service control is not available in this build.");
        // Only services Frameforge listed and that are stopped now: one the user stopped earlier was never in the list.
        var stopped = names.Where(n => { var info = extras.Services.Query(n); return info.Exists && !info.Running; }).ToArray();
        if (stopped.Length == 0) return new("pauseServices", "reverted", "All paused services are already running.");
        if (!extras.Elevate)
            return new("pauseServices", "failed", $"Starting {Join(stopped)} needs administrator approval. Use Retry recovery, or restart Windows (start types were never changed).");
        var batch = extras.Elevator.Run("start", [.. stopped.Reverse()]);
        if (batch.Declined) return new("pauseServices", "failed", $"Administrator approval was declined, so {Join(stopped)} stay stopped. Retry recovery, or restart Windows (start types were never changed).");
        if (batch.Error is not null) return new("pauseServices", "failed", batch.Error);
        var still = stopped.Where(n => !extras.Services.Query(n).Running).ToArray();
        return still.Length == 0
            ? new("pauseServices", "reverted", $"Restarted {Join(stopped)} and verified.")
            : new("pauseServices", "failed", $"{Join(still)} did not restart. Retry recovery, or restart Windows (start types were never changed).");
    }

    // ---- Game Bar capture off ----
    private MechanismResult GameBarCapture()
    {
        if (extras?.Registry is not { } registry) return Unsupported("gameBarCapture", "Registry access is not available in this build.");
        var pending = GameBarPending(registry, out var notes, out var policyOff);
        if (pending.Count == 0)
            return new("gameBarCapture", "skipped", policyOff
                ? $"Capture and background recording are already turned off by policy (AllowGameDVR=0) and the overlay hook is off. Nothing changed. {notes}".Trim()
                : $"Game Bar capture and the overlay hook are already off. {notes}".Trim());
        var item = new Captured("gameBarCapture", RegValues: [.. pending.Select(p => new RegCapture(p.Path, p.Name, "DWord", p.Current.Existed, p.Current.Value, 0))]);
        Capture(item);
        foreach (var (path, name, _) in pending) registry.Write(path, name, "DWord", 0);
        return pending.All(p => registry.Read(p.Path, p.Name) is { Existed: true, Kind: "DWord" } v && Equals(v.Value, 0))
            ? new("gameBarCapture", "applied", $"Turned off {pending.Count} Game Bar capture/overlay value(s) for this session: {Join(pending.Select(p => p.Name))}. Game Mode and the Game Bar app stay as they are; games launched later in the session use the new values.{(policyOff ? " Machine policy already blocks capture." : "")} {notes}".TrimEnd())
            : new("gameBarCapture", "failed", "Windows did not keep the Game Bar values.");
    }
    internal static List<(string Path, string Name, RegValue Current)> GameBarPending(IRegistryAccess registry, out string notes, out bool policyOff)
    {
        policyOff = registry.ReadPolicy(BoosterPaths.DvrPolicyPath, BoosterPaths.DvrPolicyName) is 0;
        var skipped = new List<string>(); var pending = new List<(string, string, RegValue)>();
        foreach (var (path, name) in BoosterPaths.GameBarValues)
        {
            var current = registry.Read(path, name);
            if (current.Existed && current.Kind != "DWord") { skipped.Add($"{name} has an unexpected type and was left alone."); continue; }
            if (current.Existed && Equals(current.Value, 0)) continue;
            if (policyOff && BoosterPaths.GovernedByDvrPolicy(name)) continue;
            pending.Add((path, name, current));
        }
        notes = string.Join(' ', skipped);
        return pending;
    }

    // ---- Per-exe current-user values: GPU preference and fullscreen optimizations ----
    private MechanismResult ExeValue(string id, ProcessTarget game)
    {
        if (extras?.Registry is not { } registry) return Unsupported(id, "Registry access is not available in this build.");
        var gpu = id == "gpuPreference";
        if (gpu && (extras.Gpus?.Count() ?? 0) < 2) return Unsupported(id, "Only one graphics adapter is installed, so there is nothing to choose between.");
        var exe = game.ExecutablePath;
        if (!BoosterPaths.ValidExe(exe)) return Unsupported(id, "The game's executable path is not a local .exe file.");
        var path = gpu ? BoosterPaths.GpuPreferences : BoosterPaths.Layers;
        var current = registry.Read(path, exe);
        if (current.Existed && current.Kind != "String") return new(id, "skipped", "The existing value has an unexpected type; it was left alone.");
        var prior = current.Value as string;
        if (gpu ? BoosterPaths.HasGpuPreference(prior) : BoosterPaths.HasFsoOff(prior)) return new(id, "skipped", gpu ? "This game already prefers the high-performance GPU." : "Fullscreen optimizations are already off for this game.");
        var next = gpu ? BoosterPaths.WithGpuPreference(prior) : BoosterPaths.WithFsoOff(prior);
        Capture(new(id, RegValues: [new RegCapture(path, exe, "String", current.Existed, prior, next)]));
        registry.Write(path, exe, "String", next);
        if (registry.Read(path, exe) is not { Existed: true, Kind: "String" } now || !Equals(now.Value, next)) return new(id, "failed", "Windows did not keep the value.");
        return new(id, "applied", gpu
            ? $"High-performance GPU preference set for {Path.GetFileName(exe)} and verified. Windows reads it when the game next creates its graphics device, and it is removed when this session ends, so a game that is already running keeps its current GPU."
            : $"Fullscreen optimizations turned off for {Path.GetFileName(exe)} and verified. Windows reads this when the game starts and it is removed when this session ends, so an already running game is not affected.");
    }

    // ---- Power throttling (EcoQoS) opt-out for the game process ----
    private MechanismResult PowerThrottling(ProcessTarget game)
    {
        if (extras?.Throttling is not { } throttling) return Unsupported("powerThrottling", "Power throttling control is not available in this build.");
        if (extras.Build is > 0 and < PowerThrottlingBuild) return Unsupported("powerThrottling", "Needs Windows 10 version 1709 or later.");
        if (throttling.Get(game) is not { } prior) return Unsupported("powerThrottling", "Windows did not report this process's power throttling state, so the prior state cannot be saved.");
        if ((prior.Control & ExecutionSpeed) != 0 && (prior.State & ExecutionSpeed) == 0) return new("powerThrottling", "skipped", "The game already opted out of power throttling.");
        Capture(new("powerThrottling", game, $"{prior.Control}:{prior.State}", $"{ExecutionSpeed}:0"));
        throttling.Set(game, ExecutionSpeed, 0);
        return throttling.Get(game) is { } now && now.Control == ExecutionSpeed && now.State == 0
            ? new("powerThrottling", "applied", $"{Label(game)}: power throttling opted out and verified.")
            : new("powerThrottling", "failed", $"{Label(game)}: Windows did not keep the power throttling setting.");
    }
    private MechanismResult RevertPowerThrottling(Captured item)
    {
        var process = Valid(item.Process);
        var prior = Pair(item.Prior); var applied = Pair(item.Applied);
        if (extras?.Throttling is not { } throttling) throw new InvalidOperationException("Power throttling control is not available in this build.");
        if (processes.Read(process) is null) return new("powerThrottling", "reverted", $"{Label(process)}: exited; nothing to restore.");
        var current = throttling.Get(process) ?? throw new InvalidOperationException("Windows did not report the power throttling state.");
        if (current == prior) return new("powerThrottling", "reverted", $"{Label(process)}: power throttling already restored.");
        if (current != applied) return new("powerThrottling", "conflict", $"{Label(process)}: power throttling changed outside Frameforge; kept.");
        throttling.Set(process, prior.Control, prior.State);
        return throttling.Get(process) == prior
            ? new("powerThrottling", "reverted", $"{Label(process)}: power throttling restored and verified.")
            : new("powerThrottling", "failed", $"{Label(process)}: Windows did not restore the power throttling state.");
    }
    private static (uint Control, uint State) Pair(string? text)
    {
        var parts = (text ?? "").Split(':');
        if (parts.Length != 2 || !uint.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var control) || !uint.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var state))
            throw new InvalidOperationException("Invalid saved power throttling state.");
        return (control, state);
    }

    // ---- Smart core targeting (CPU sets) ----
    private MechanismResult SmartCoresStep(ProcessTarget game, bool affinitySelected)
    {
        if (extras?.Topology is not { } topology || extras.CpuSets is not { } sets) return Unsupported("smartCores", "CPU set control is not available in this build.");
        if (affinitySelected) return new("smartCores", "skipped", "Game CPU affinity is selected, which already decides the game's CPUs; smart cores did not change them.");
        var (ids, skip) = SmartCores.Plan(topology.CpuName, topology.Cpus());
        if (skip is not null) return Unsupported("smartCores", skip);
        var prior = sets.Get(game);
        if (prior.Length > 0) return new("smartCores", "skipped", $"{Label(game)} already has its own CPU set; not changed.");
        Capture(new("smartCores", game, Items: [], AppliedItems: [.. ids.Select(i => i.ToString(CultureInfo.InvariantCulture))]));
        sets.Set(game, ids);
        return sets.Get(game).Order().SequenceEqual(ids)
            ? new("smartCores", "applied", $"{Label(game)}: limited to {ids.Length} performance-core threads (CPU sets) and verified.")
            : new("smartCores", "failed", $"{Label(game)}: Windows did not keep the CPU set.");
    }
    private MechanismResult RevertSmartCores(Captured item)
    {
        var process = Valid(item.Process);
        var prior = Ids(item.Items); var applied = Ids(item.AppliedItems);
        if (extras?.CpuSets is not { } sets) throw new InvalidOperationException("CPU set control is not available in this build.");
        if (processes.Read(process) is null) return new("smartCores", "reverted", $"{Label(process)}: exited; nothing to restore.");
        var current = sets.Get(process).Order().ToArray();
        if (current.SequenceEqual(prior.Order())) return new("smartCores", "reverted", $"{Label(process)}: CPU set already restored.");
        if (!current.SequenceEqual(applied.Order())) return new("smartCores", "conflict", $"{Label(process)}: CPU set changed outside Frameforge; kept.");
        sets.Set(process, prior);
        return sets.Get(process).Order().SequenceEqual(prior.Order())
            ? new("smartCores", "reverted", $"{Label(process)}: CPU set restored and verified.")
            : new("smartCores", "failed", $"{Label(process)}: Windows did not restore the CPU set.");
    }
    private static int[] Ids(string[]? items) => items is null || items.Length > 256 || items.Any(i => !int.TryParse(i, NumberStyles.None, CultureInfo.InvariantCulture, out _))
        ? throw new InvalidOperationException("Invalid saved CPU set.") : items.Select(i => int.Parse(i, CultureInfo.InvariantCulture)).ToArray();

    // ---- Core parking: plugged-in minimum unparked cores = 100 on the active scheme ----
    private MechanismResult CoreParking()
    {
        if (extras?.PowerSettings is not { } settings || extras.Topology is not { } topology) return Unsupported("coreParking", "Power setting access is not available in this build.");
        if (SmartCores.IsDualCcdX3d(topology.CpuName)) return Unsupported("coreParking", "Dual-CCD Ryzen X3D parts rely on parking the non-V-Cache cores for games; forcing 100% would defeat that, so Frameforge leaves it alone.");
        var hybrid = false;
        try { hybrid = SmartCores.Describe(topology.CpuName, topology.Cpus()).Hybrid; } catch (Exception error) when (error is Win32Exception or InvalidOperationException) { }
        // Read after the power plan step: that step may have switched schemes.
        var scheme = power.Active();
        var targets = new List<Guid> { BoosterPaths.CpMinCores };
        // On hybrid CPUs the performance cores are efficiency class 1, which has its own setting.
        if (hybrid && settings.ReadAc(scheme, BoosterPaths.CpMinCores1) is not null) targets.Add(BoosterPaths.CpMinCores1);
        var parts = new List<MechanismResult>();
        foreach (var setting in targets)
        {
            var name = BoosterPaths.SettingName(setting);
            try
            {
                if (settings.ReadAc(scheme, setting) is not { } current) { parts.Add(Unsupported("coreParking", $"{name}: this power plan does not expose the setting.")); continue; }
                if (current >= 100) { parts.Add(new("coreParking", "skipped", $"{name}: already {current}%; parking is already off.")); continue; }
                Capture(new("coreParking", Prior: current.ToString(CultureInfo.InvariantCulture), Applied: "100", Scheme: scheme.ToString(), Setting: name));
                settings.WriteAc(scheme, setting, 100);
                if (power.Active() == scheme) power.SetActive(scheme);
                parts.Add(settings.ReadAc(scheme, setting) == 100
                    ? new("coreParking", "applied", $"{name}: plugged-in minimum unparked cores raised from {current}% to 100% and verified. Battery settings are untouched.")
                    : new("coreParking", "failed", $"{name}: Windows did not keep the value."));
            }
            catch (Exception error) { parts.Add(new("coreParking", "failed", $"{name}: {Describe(error)}")); }
        }
        var state = parts.Any(p => p.State == "failed") ? "failed" : parts.Any(p => p.State == "applied") ? "applied" : parts.All(p => p.State == "unsupported") ? "unsupported" : "skipped";
        return new("coreParking", state, string.Join(' ', parts.Select(p => p.Detail)));
    }
    private MechanismResult RevertCoreParking(Captured item)
    {
        if (extras?.PowerSettings is not { } settings) throw new InvalidOperationException("Power setting access is not available in this build.");
        if (!Guid.TryParse(item.Scheme, out var scheme) || !uint.TryParse(item.Prior, NumberStyles.None, CultureInfo.InvariantCulture, out var prior) || item.Applied != "100" || prior > 100)
            throw new InvalidOperationException("Invalid saved core parking value.");
        var setting = BoosterPaths.SettingGuid(item.Setting);
        // The scheme Frameforge changed, not whichever is active now.
        if (settings.ReadAc(scheme, setting) is not { } current) return new("coreParking", "reverted", "The power plan or setting no longer exists; nothing to restore.");
        if (current == prior) return new("coreParking", "reverted", $"{item.Setting}: already back to {prior}%.");
        if (current != 100) return new("coreParking", "conflict", $"{item.Setting}: changed outside Frameforge to {current}%; kept.");
        settings.WriteAc(scheme, setting, prior);
        if (power.Active() == scheme) power.SetActive(scheme);
        return settings.ReadAc(scheme, setting) == prior ? new("coreParking", "reverted", $"{item.Setting}: restored to {prior}% and verified.") : new("coreParking", "failed", $"{item.Setting}: Windows did not restore {prior}%.");
    }

    // ---- Registry-value reverts ----
    private MechanismResult RevertRegValues(Captured item)
    {
        if (extras?.Registry is not { } registry) throw new InvalidOperationException("Registry access is not available in this build.");
        if (item.RegValues is not { Length: > 0 and <= 8 } values) throw new InvalidOperationException("Invalid saved registry values.");
        var id = item.Mechanism;
        var results = new List<MechanismResult>();
        foreach (var saved in values)
        {
            var applied = NormReg(saved.Applied); var prior = NormReg(saved.Value);
            var allowed = id switch
            {
                "gameBarCapture" => BoosterPaths.GameBarValues.Contains((saved.Path, saved.Name)) && saved.Kind == "DWord" && applied is 0 && (prior is null or int),
                "gpuPreference" => saved.Path == BoosterPaths.GpuPreferences && BoosterPaths.ValidExe(saved.Name) && saved.Kind == "String" && applied is string && (prior is null or string),
                "fullscreenOptimizations" => saved.Path == BoosterPaths.Layers && BoosterPaths.ValidExe(saved.Name) && saved.Kind == "String" && applied is string && (prior is null or string),
                _ => false
            };
            if (!allowed || saved.Existed == (prior is null)) throw new InvalidOperationException("Invalid saved registry value.");
            var current = registry.Read(saved.Path, saved.Name);
            var atPrior = current.Existed == saved.Existed && (!saved.Existed || (current.Kind == saved.Kind && Equals(current.Value, prior)));
            if (atPrior) { results.Add(new(id, "reverted", $"{saved.Name}: already restored.")); continue; }
            if (!(current.Existed && current.Kind == saved.Kind && Equals(current.Value, applied))) { results.Add(new(id, "conflict", $"{saved.Name}: changed outside Frameforge; kept.")); continue; }
            if (saved.Existed) registry.Write(saved.Path, saved.Name, saved.Kind, prior!); else registry.Delete(saved.Path, saved.Name);
            var after = registry.Read(saved.Path, saved.Name);
            results.Add(after.Existed == saved.Existed && (!saved.Existed || Equals(after.Value, prior))
                ? new(id, "reverted", $"{saved.Name}: restored{(saved.Existed ? "" : " (it did not exist before)")} and verified.")
                : new(id, "failed", $"{saved.Name}: Windows did not restore it."));
        }
        var state = results.Any(r => r.State == "failed") ? "failed" : results.Any(r => r.State == "conflict") ? "conflict" : "reverted";
        return new(id, state, string.Join(' ', results.Select(r => r.Detail)));
    }

    // ---- Per-PC applicability, shown on the mode cards ----
    internal static Capability[] ExtraCapabilities(IPowerStore power, Extras? extras)
    {
        var list = new List<Capability>();
        Capability Run(string id, Func<Capability> read) => Safe(id, read);
        list.Add(Run("pauseServices", () =>
        {
            if (extras?.Services is null) return new("pauseServices", false, "Service control is not available in this build.");
            var plan = ServicePolicy.Plan(extras.Services, false, extras.Controllers?.XboxControllerConnected() ?? true);
            return plan.Targets.Length > 0
                ? new("pauseServices", true, $"{plan.Targets.Length} running service(s) can be paused: {Join(plan.Targets)}. Windows asks for administrator approval once at the start and once at the end of a boost. Games from the Xbox app or Microsoft Store keep their Xbox services.")
                : new("pauseServices", false, "None of the pausable services are running right now.");
        }));
        list.Add(Run("gameBarCapture", () =>
        {
            if (extras?.Registry is null) return new("gameBarCapture", false, "Registry access is not available in this build.");
            var pending = GameBarPending(extras.Registry, out var notes, out var policyOff);
            return pending.Count == 0
                ? new("gameBarCapture", true, policyOff ? "Capture is already turned off by policy (AllowGameDVR=0) and the overlay hook is off; nothing to change." : "Capture and the overlay hook are already off.", true)
                : new("gameBarCapture", true, $"Turns off {Join(pending.Select(p => p.Name))} for the session. Game Mode stays on and the Game Bar app stays installed.");
        }));
        list.Add(Run("smartCores", () =>
        {
            if (extras?.Topology is null) return new("smartCores", false, "CPU set control is not available in this build.");
            var cpus = extras.Topology.Cpus();
            var topology = SmartCores.Describe(extras.Topology.CpuName, cpus);
            var (ids, skip) = SmartCores.Plan(extras.Topology.CpuName, cpus);
            return skip is not null ? new("smartCores", false, skip) : new("smartCores", true, $"{topology.Summary} The game is steered to {ids.Length} performance-core threads with CPU sets.");
        }));
        list.Add(Run("coreParking", () =>
        {
            if (extras?.PowerSettings is null || extras.Topology is null) return new("coreParking", false, "Power setting access is not available in this build.");
            if (SmartCores.IsDualCcdX3d(extras.Topology.CpuName)) return new("coreParking", false, "Dual-CCD Ryzen X3D parts rely on core parking for games; Frameforge leaves it alone.");
            var scheme = power.Active();
            var current = extras.PowerSettings.ReadAc(scheme, BoosterPaths.CpMinCores);
            if (current is null) return new("coreParking", false, "The active power plan does not expose the setting.");
            return current >= 100
                ? new("coreParking", true, "Plugged-in core parking is already off (100% unparked).", true)
                : new("coreParking", true, $"Plugged-in minimum unparked cores is {current}% on the active plan; the session raises it to 100% and restores it. Battery settings are untouched.");
        }));
        list.Add(Run("powerThrottling", () => extras?.Throttling is null
            ? new("powerThrottling", false, "Power throttling control is not available in this build.")
            : extras.Build is > 0 and < PowerThrottlingBuild
                ? new("powerThrottling", false, "Needs Windows 10 version 1709 or later.")
                : new("powerThrottling", true, "Asks Windows not to treat the game as efficiency (EcoQoS) work. Applies to the game process only and ends with it.")));
        list.Add(Run("gpuPreference", () =>
        {
            if (extras?.Gpus is null) return new("gpuPreference", false, "Graphics adapter detection is not available in this build.");
            var count = extras.Gpus.Count();
            return count >= 2
                ? new("gpuPreference", true, $"{count} graphics adapters found. Sets the game's high-performance GPU preference for the session. Windows reads it when the game starts its graphics, so it helps a game that starts during the session; it is removed afterwards.")
                : new("gpuPreference", false, "Only one graphics adapter is installed, so there is nothing to choose between.");
        }));
        list.Add(new("fullscreenOptimizations", true, "Opt-in advanced. Turns off fullscreen optimizations for the game's executable for the session. Windows reads it when the game starts. Some games lose Auto HDR or variable refresh rate."));
        return [.. list];
    }
    internal static CpuTopology? ReadTopology(Extras? extras)
    {
        try { return extras?.Topology is { } t ? SmartCores.Describe(t.CpuName, t.Cpus()) : null; }
        catch (Exception error) when (error is Win32Exception or InvalidOperationException or DllNotFoundException) { return null; }
    }
}
