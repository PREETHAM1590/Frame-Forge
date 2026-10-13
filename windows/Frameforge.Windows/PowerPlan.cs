using System.ComponentModel;
using System.Text.Json.Serialization;

namespace Frameforge.Windows;

/// <summary>
/// Wire snapshot: registry values plus, for power-plan, the scheme that was active before (Scheme), the performance plan
/// the apply switches to (Target) and their display names. Target is fixed at preview time and re-checked on apply.
/// </summary>
public record OptimizationSnapshot(
    CapturedValue[] Values,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Scheme = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Target = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? SchemeName = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? TargetName = null);

/// <summary>One machine-level request handed to the administrator step: capture, apply (writes then re-reads), verify or restore.</summary>
public record AdminRequest(string Command, string[] Ids, CapturedValue[]? Values);
public record AdminResult(CapturedValue[]? Values, bool Verified);
/// <summary>Runs an <see cref="AdminRequest"/> with administrator rights (one approval per call) or throws InvalidOperationException.</summary>
public interface IAdminGateway { AdminResult Run(AdminRequest request); }

/// <summary>
/// Routes catalogue operations: registry preferences to RegistryOperations, power-plan to the power store.
/// The plan rule and GUID list are the booster's (BoostSessionEngine): High performance, then Ultimate, then the owned plan.
/// Machine-level settings (HKLM, boot store, powercfg) go to the administrator gateway unless this process already is elevated
/// or no gateway is wired (tests). Current-user settings never leave this process: an elevated account may be a different user.
/// </summary>
public sealed class Optimizations(RegistryOperations registry, IPowerStore power, Guid? ownedPlan = null, IAdminGateway? admin = null, bool elevated = false)
{
    public const string PowerPlan = "power-plan";
    private bool Remote => admin is not null && !elevated;
    private static string[] Registry(string[] ids) => ids.Where(id => id != PowerPlan).ToArray();
    private static string[] Check(string[] ids)
    {
        if (ids.Length == 0 || ids.Distinct().Count() != ids.Length) throw new InvalidOperationException("Unsupported operation selection.");
        return ids;
    }
    private static CapturedValue[] Of(CapturedValue[] values, string[] ids) => values.Where(v => ids.Contains(v.Operation)).ToArray();
    private static Guid? Plan(string? text, string what) =>
        text is null ? null : Guid.TryParse(text, out var plan) ? plan : throw new InvalidOperationException($"Invalid saved {what}.");
    private (Guid Prior, Guid Target)? Plans(OptimizationSnapshot snapshot)
    {
        if (snapshot?.Values is null || snapshot.Values.Any(v => v is null)) throw new InvalidOperationException("Empty or invalid snapshot.");
        if (Plan(snapshot.Scheme, "power plan") is not { } prior) return null;
        // Snapshots saved before the target was recorded always meant High performance.
        return (prior, Plan(snapshot.Target, "target power plan") ?? BoostSessionEngine.HighPerformance);
    }
    private string? NameOf(Guid plan) { try { return power.Name(plan); } catch (Win32Exception) { return null; } }
    private CapturedValue[] CaptureRegistry(string[] registryIds)
    {
        if (registryIds.Length == 0) return [];
        // Reading machine registry values needs no rights; only the boot store does.
        var remote = Remote ? registryIds.Where(OptimizationTable.ReadNeedsAdmin).ToArray() : [];
        var direct = registryIds.Except(remote).ToArray();
        var values = new List<CapturedValue>();
        if (direct.Length > 0) values.AddRange(registry.Capture(direct).Values);
        if (remote.Length > 0) values.AddRange(admin!.Run(new("capture", remote, null)).Values ?? throw new InvalidOperationException("The administrator step returned no snapshot."));
        // Table order keeps the snapshot stable whichever way each part was read.
        return RegistryOperations.Settings.Select(s => values.FirstOrDefault(v => v.Operation == s.Operation && v.Path == s.Path && v.Name == s.Name)).Where(v => v is not null).ToArray()!;
    }
    public OptimizationSnapshot Capture(string[] ids)
    {
        var registryIds = Registry(Check(ids));
        string? scheme = null, target = null, schemeName = null, targetName = null;
        if (ids.Contains(PowerPlan))
        {
            // Never duplicates a scheme: a PC without a performance plan gets a clear refusal.
            var plan = BoostSessionEngine.PlanTarget(power, ownedPlan) ?? throw new InvalidOperationException("High performance plan not present on this PC.");
            var active = power.Active();
            (scheme, target, schemeName, targetName) = (active.ToString(), plan.ToString(), NameOf(active), NameOf(plan));
        }
        return new(CaptureRegistry(registryIds), scheme, target, schemeName, targetName);
    }
    /// <summary>Applies the selection. Returns the administrator step's own post-write re-read when one ran, otherwise null.</summary>
    public bool? Apply(string[] ids, OptimizationSnapshot expected)
    {
        var registryIds = Registry(Check(ids));
        var plans = Plans(expected);
        if (ids.Contains(PowerPlan) != plans.HasValue || (registryIds.Length == 0) != (expected.Values.Length == 0)) throw new InvalidOperationException("Snapshot selection mismatch.");
        if (plans is { } expect && (power.Active() != expect.Prior || BoostSessionEngine.PlanTarget(power, ownedPlan) != expect.Target))
            throw new InvalidOperationException("Settings changed after preview. Create a new preview.");
        var machine = Remote ? registryIds.Where(OptimizationTable.IsAdmin).ToArray() : [];
        var local = registryIds.Except(machine).ToArray();
        bool? verified = null;
        // Machine part first: when the approval is declined nothing has changed yet.
        if (machine.Length > 0) verified = admin!.Run(new("apply", machine, Of(expected.Values, machine))).Verified;
        if (local.Length > 0) registry.Apply(local, new Snapshot(Of(expected.Values, local)));
        // Already on the target plan: nothing to write, and rollback has nothing to undo.
        if (plans is { } change && change.Prior != change.Target) power.SetActive(change.Target);
        return verified;
    }
    public bool Verify(string[] ids)
    {
        var registryIds = Registry(Check(ids));
        var remote = Remote ? registryIds.Where(OptimizationTable.ReadNeedsAdmin).ToArray() : [];
        var direct = registryIds.Except(remote).ToArray();
        return (direct.Length == 0 || registry.Verify(direct)) && (remote.Length == 0 || admin!.Run(new("verify", remote, null)).Verified) &&
            (!ids.Contains(PowerPlan) || power.Active() == BoostSessionEngine.PlanTarget(power, ownedPlan));
    }
    public void Restore(OptimizationSnapshot snapshot)
    {
        var plans = Plans(snapshot);
        if (plans is null && snapshot.Values.Length == 0) throw new InvalidOperationException("Empty or invalid snapshot.");
        // Check the plan before any write so an external choice is never overwritten: only the prior or the applied plan may be active.
        if (plans is { } saved && power.Active() is var current && current != saved.Prior && current != saved.Target)
            throw new InvalidOperationException("The power plan changed externally. Rollback stopped to preserve it.");
        if (snapshot.Values.Length > 0)
        {
            registry.Validate(new Snapshot(snapshot.Values));
            var machine = Remote ? snapshot.Values.Where(v => OptimizationTable.IsAdmin(v.Operation)).ToArray() : [];
            var local = snapshot.Values.Except(machine).ToArray();
            if (machine.Length > 0) admin!.Run(new("restore", machine.Select(v => v.Operation).Distinct().ToArray(), machine));
            if (local.Length > 0) registry.Restore(new Snapshot(local));
        }
        if (plans is { } back && power.Active() != back.Prior)
        {
            power.SetActive(back.Prior);
            if (power.Active() != back.Prior) throw new InvalidOperationException("Rollback verification failed.");
        }
    }
}

/// <summary>The work an administrator step does for one request. Used inline when already elevated and by the elevated child process.</summary>
public static class AdminCommands
{
    public static AdminResult Execute(AdminRequest request, RegistryOperations registry)
    {
        if (request is null || request.Ids is null || request.Ids.Length is 0 or > 24 || !request.Ids.All(OptimizationTable.IsAdmin)) throw new InvalidOperationException("Unsupported administrator request.");
        switch (request.Command)
        {
            case "capture": return new(registry.Capture(request.Ids).Values, true);
            case "apply":
                registry.Apply(request.Ids, new Snapshot(request.Values ?? throw new InvalidOperationException("Missing snapshot.")));
                // Windows (or a policy) may revert a write; the re-read is the only thing that counts.
                return new(null, registry.Verify(request.Ids));
            case "verify": return new(null, registry.Verify(request.Ids));
            case "restore":
                registry.Restore(new Snapshot(request.Values ?? throw new InvalidOperationException("Missing snapshot.")));
                return new(null, true);
            default: throw new InvalidOperationException("Unsupported administrator request.");
        }
    }
}
