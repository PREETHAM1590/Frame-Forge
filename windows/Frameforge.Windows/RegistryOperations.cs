using Microsoft.Win32;
using System.Text.Json;

namespace Frameforge.Windows;
public record ValueState(bool Existed, object? Value, string Kind);
/// <summary>Created is how many key levels above the value were missing at capture, so rollback removes exactly the keys the change created.</summary>
public record CapturedValue(string Operation, string Path, string Name, string Kind, bool Existed, object? Value, object? Target = null, int? Created = null);
public record Snapshot(CapturedValue[] Values);
public interface IRegistryStore { ValueState Read(Setting setting); void Write(Setting setting, ValueState state); }
/// <summary>Optional: stores that can say how many key levels a write would have to create.</summary>
public interface IKeyDepth { int MissingKeys(Setting setting); }
public sealed class RegistryOperations(IRegistryStore store, IFacts? facts = null)
{
    public static Setting[] Settings => OptimizationTable.Settings;
    private static Setting[] Select(string[] ids)
    {
        if (ids.Length < 1 || ids.Length > Settings.Length || ids.Distinct().Count() != ids.Length || ids.Any(id => !Settings.Any(s => s.Operation == id))) throw new InvalidOperationException("Unsupported operation selection.");
        return Settings.Where(s => ids.Contains(s.Operation)).ToArray();
    }
    internal static ValueState Target(Setting setting) => setting.Delete ? new(false, null, setting.Kind) : new(true, setting.Kind == "String" ? setting.Text ?? setting.Target.ToString(System.Globalization.CultureInfo.InvariantCulture) : setting.Target, setting.Kind);
    private static object? Normalize(object? value, string kind)
    {
        if (value is JsonElement json) value = json.ValueKind switch { JsonValueKind.String => json.GetString(), JsonValueKind.Number => json.GetInt32(), JsonValueKind.Null => null, _ => throw new InvalidOperationException("Invalid snapshot value.") };
        if (value is null) return null;
        if (kind == "String" && value is string text && text.Length <= 520) return text;
        if (kind == "DWord" && value is int number) return number;
        throw new InvalidOperationException("Invalid registry type in snapshot.");
    }
    /// <summary>Throws unless every value in the snapshot is an allowed setting with a well-formed state.</summary>
    public void Validate(Snapshot snapshot) => _ = ValidateCore(snapshot);
    private static (Setting Setting, ValueState State, int? Created)[] ValidateCore(Snapshot snapshot)
    {
        if (snapshot is null || snapshot.Values is null || snapshot.Values.Length < 1 || snapshot.Values.Length > Settings.Length || snapshot.Values.Any(value => value is null)) throw new InvalidOperationException("Empty or invalid snapshot.");
        var required = Select(snapshot.Values.Select(v => v.Operation).Distinct().ToArray());
        if (required.Length != snapshot.Values.Length) throw new InvalidOperationException("Incomplete registry snapshot.");
        return required.Select(setting =>
        {
            var matches = snapshot.Values.Where(v => v.Operation == setting.Operation && v.Path == setting.Path && v.Name == setting.Name && v.Kind == setting.Kind).ToArray();
            if (matches.Length != 1) throw new InvalidOperationException("Snapshot contains an unauthorized setting.");
            var value = matches[0]; var normalized = Normalize(value.Value, value.Kind);
            if (value.Existed == (normalized is null)) throw new InvalidOperationException("Invalid snapshot presence state.");
            if (value.Created is < 0 or > 16) throw new InvalidOperationException("Invalid snapshot key count.");
            return (setting, new ValueState(value.Existed, normalized, value.Kind), value.Created);
        }).ToArray();
    }
    private void Prerequisites(string[] ids) { if (facts is not null) foreach (var id in ids) OptimizationTable.Check(id, facts); }
    public Snapshot Capture(string[] ids) { Prerequisites(ids); return CaptureChecked(ids); }
    private Snapshot CaptureChecked(string[] ids) => new(Select(ids).Select(setting =>
    {
        var state = store.Read(setting);
        // A value that drives a non-registry writer (hibernation) must be readable now; refuse here rather than fail mid-rollback.
        if (setting.Via is not null && !state.Existed) throw new InvalidOperationException("Windows does not report this setting on this PC, so it cannot be restored later. No change was made.");
        int? created = store is IKeyDepth depth && !state.Existed ? depth.MissingKeys(setting) : null;
        return new CapturedValue(setting.Operation, setting.Path, setting.Name, setting.Kind, state.Existed, state.Value, Target(setting).Value, created);
    }).ToArray());
    public void Apply(string[] ids, Snapshot expected)
    {
        Prerequisites(ids);
        var states = ValidateCore(expected); var selected = Select(ids);
        if (states.Length != selected.Length || states.Any(s => !selected.Contains(s.Setting))) throw new InvalidOperationException("Snapshot selection mismatch.");
        if (states.Any(s => store.Read(s.Setting) != s.State)) throw new InvalidOperationException("Settings changed after preview. Create a new preview.");
        foreach (var setting in selected) store.Write(setting, Target(setting));
    }
    /// <summary>Operations whose readable settings no longer hold the value Frameforge wrote. The boot store is skipped: reading it needs a prompt.</summary>
    public string[] Drifted(string[] ids) => Select(ids).Where(s => !s.ReadNeedsAdmin && store.Read(s) != Target(s)).Select(s => s.Operation).Distinct().ToArray();
    public bool Verify(string[] ids) => Select(ids).All(setting => store.Read(setting) == Target(setting));
    /// <summary>
    /// Restores the captured state. A value that is neither the captured one nor the one Frameforge wrote stops the rollback to preserve it,
    /// except for security trade-offs: Windows (or a policy) may have reverted those, so they are cleared to the captured state and listed in the result.
    /// </summary>
    public string[] Restore(Snapshot snapshot)
    {
        var states = ValidateCore(snapshot);
        var third = new List<string>();
        // Check every value before writing so external changes never trigger partial rollback.
        foreach (var s in states)
        {
            var current = store.Read(s.Setting);
            if (current == s.State || current == Target(s.Setting)) continue;
            if (!OptimizationTable.Security.Contains(s.Setting.Operation)) throw new InvalidOperationException("An affected preference changed externally. Rollback stopped to preserve it.");
            third.Add(s.Setting.Name);
        }
        // Remove exactly the keys that were missing at capture; older snapshots fall back to the table's bound.
        foreach (var state in states) store.Write(state.Setting with { OwnKey = state.Created ?? state.Setting.OwnKey }, state.State);
        if (states.Any(s => store.Read(s.Setting) != s.State)) throw new InvalidOperationException("Rollback verification failed.");
        return third.ToArray();
    }
}
