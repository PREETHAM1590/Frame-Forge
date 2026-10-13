using System.Text.Json.Serialization;

namespace Frameforge.Windows;

/// <summary>Wire snapshot: registry values plus, for power-plan, the scheme that was active before.</summary>
public record OptimizationSnapshot(
    CapturedValue[] Values,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Scheme = null);

/// <summary>Routes catalogue operations: registry preferences to RegistryOperations, power-plan to the power store.</summary>
public sealed class Optimizations(RegistryOperations registry, IPowerStore power)
{
    public const string PowerPlan = "power-plan";
    public static readonly Guid HighPerformance = new("8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c");
    private static string[] Registry(string[] ids) => ids.Where(id => id != PowerPlan).ToArray();
    private static string[] Check(string[] ids)
    {
        if (ids.Length == 0 || ids.Distinct().Count() != ids.Length) throw new InvalidOperationException("Unsupported operation selection.");
        return ids;
    }
    private static Guid? Prior(OptimizationSnapshot snapshot)
    {
        if (snapshot?.Values is null || snapshot.Values.Any(v => v is null)) throw new InvalidOperationException("Empty or invalid snapshot.");
        if (snapshot.Scheme is null) return null;
        return Guid.TryParse(snapshot.Scheme, out var prior) ? prior : throw new InvalidOperationException("Invalid saved power plan.");
    }
    public OptimizationSnapshot Capture(string[] ids)
    {
        var registryIds = Registry(Check(ids));
        string? scheme = null;
        if (ids.Contains(PowerPlan))
        {
            // Never duplicates a scheme: a PC without the built-in plan gets a clear refusal.
            if (!power.Exists(HighPerformance)) throw new InvalidOperationException("High performance plan not present on this PC.");
            scheme = power.Active().ToString();
        }
        return new(registryIds.Length > 0 ? registry.Capture(registryIds).Values : [], scheme);
    }
    public void Apply(string[] ids, OptimizationSnapshot expected)
    {
        var registryIds = Registry(Check(ids));
        var prior = Prior(expected);
        if (ids.Contains(PowerPlan) != prior.HasValue || (registryIds.Length == 0) != (expected.Values.Length == 0)) throw new InvalidOperationException("Snapshot selection mismatch.");
        if (prior is { } before && power.Active() != before) throw new InvalidOperationException("Settings changed after preview. Create a new preview.");
        if (registryIds.Length > 0) registry.Apply(registryIds, new Snapshot(expected.Values));
        // Already High performance: nothing to write, and rollback has nothing to undo.
        if (prior is { } plan && plan != HighPerformance) power.SetActive(HighPerformance);
    }
    public bool Verify(string[] ids)
    {
        var registryIds = Registry(Check(ids));
        return (registryIds.Length == 0 || registry.Verify(registryIds)) && (!ids.Contains(PowerPlan) || power.Active() == HighPerformance);
    }
    public void Restore(OptimizationSnapshot snapshot)
    {
        var prior = Prior(snapshot);
        if (prior is null && snapshot.Values.Length == 0) throw new InvalidOperationException("Empty or invalid snapshot.");
        // Check the plan before any write so an external choice is never overwritten.
        if (prior is { } before && power.Active() is var current && current != before && current != HighPerformance)
            throw new InvalidOperationException("The power plan changed externally. Rollback stopped to preserve it.");
        if (snapshot.Values.Length > 0) registry.Restore(new Snapshot(snapshot.Values));
        if (prior is { } plan && power.Active() != plan)
        {
            power.SetActive(plan);
            if (power.Active() != plan) throw new InvalidOperationException("Rollback verification failed.");
        }
    }
}
