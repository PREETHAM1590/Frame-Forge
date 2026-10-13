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

/// <summary>
/// Routes catalogue operations: registry preferences to RegistryOperations, power-plan to the power store.
/// The plan rule and GUID list are the booster's (BoostSessionEngine): High performance, then Ultimate, then the owned plan.
/// </summary>
public sealed class Optimizations(RegistryOperations registry, IPowerStore power, Guid? ownedPlan = null)
{
    public const string PowerPlan = "power-plan";
    private static string[] Registry(string[] ids) => ids.Where(id => id != PowerPlan).ToArray();
    private static string[] Check(string[] ids)
    {
        if (ids.Length == 0 || ids.Distinct().Count() != ids.Length) throw new InvalidOperationException("Unsupported operation selection.");
        return ids;
    }
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
        return new(registryIds.Length > 0 ? registry.Capture(registryIds).Values : [], scheme, target, schemeName, targetName);
    }
    public void Apply(string[] ids, OptimizationSnapshot expected)
    {
        var registryIds = Registry(Check(ids));
        var plans = Plans(expected);
        if (ids.Contains(PowerPlan) != plans.HasValue || (registryIds.Length == 0) != (expected.Values.Length == 0)) throw new InvalidOperationException("Snapshot selection mismatch.");
        if (plans is { } expect && (power.Active() != expect.Prior || BoostSessionEngine.PlanTarget(power, ownedPlan) != expect.Target))
            throw new InvalidOperationException("Settings changed after preview. Create a new preview.");
        if (registryIds.Length > 0) registry.Apply(registryIds, new Snapshot(expected.Values));
        // Already on the target plan: nothing to write, and rollback has nothing to undo.
        if (plans is { } change && change.Prior != change.Target) power.SetActive(change.Target);
    }
    public bool Verify(string[] ids)
    {
        var registryIds = Registry(Check(ids));
        return (registryIds.Length == 0 || registry.Verify(registryIds)) && (!ids.Contains(PowerPlan) || power.Active() == BoostSessionEngine.PlanTarget(power, ownedPlan));
    }
    public void Restore(OptimizationSnapshot snapshot)
    {
        var plans = Plans(snapshot);
        if (plans is null && snapshot.Values.Length == 0) throw new InvalidOperationException("Empty or invalid snapshot.");
        // Check the plan before any write so an external choice is never overwritten: only the prior or the applied plan may be active.
        if (plans is { } saved && power.Active() is var current && current != saved.Prior && current != saved.Target)
            throw new InvalidOperationException("The power plan changed externally. Rollback stopped to preserve it.");
        if (snapshot.Values.Length > 0) registry.Restore(new Snapshot(snapshot.Values));
        if (plans is { } back && power.Active() != back.Prior)
        {
            power.SetActive(back.Prior);
            if (power.Active() != back.Prior) throw new InvalidOperationException("Rollback verification failed.");
        }
    }
}
