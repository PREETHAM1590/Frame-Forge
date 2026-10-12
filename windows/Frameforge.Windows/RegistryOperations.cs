using Microsoft.Win32;
using System.Text.Json;

namespace Frameforge.Windows;
public record Setting(string Operation, string Path, string Name, string Kind);
public record ValueState(bool Existed, object? Value, string Kind);
public record CapturedValue(string Operation, string Path, string Name, string Kind, bool Existed, object? Value);
public record Snapshot(CapturedValue[] Values);
public interface IRegistryStore { ValueState Read(Setting setting); void Write(Setting setting, ValueState state); }
public sealed class WindowsRegistryStore : IRegistryStore
{
    public ValueState Read(Setting setting)
    {
        using var key = Registry.CurrentUser.OpenSubKey(setting.Path, false);
        if (key is null || !key.GetValueNames().Contains(setting.Name)) return new(false, null, setting.Kind);
        if (key.GetValueKind(setting.Name).ToString() != setting.Kind) throw new InvalidOperationException("An affected registry value has an unexpected type. No change was made.");
        return new(true, key.GetValue(setting.Name), setting.Kind);
    }
    public void Write(Setting setting, ValueState state)
    {
        using var key = Registry.CurrentUser.CreateSubKey(setting.Path, true);
        if (state.Existed) key.SetValue(setting.Name, state.Value!, setting.Kind == "String" ? RegistryValueKind.String : RegistryValueKind.DWord);
        else key.DeleteValue(setting.Name, false);
    }
}
public sealed class RegistryOperations(IRegistryStore store)
{
    public static readonly Setting[] Settings = [
        new("mouse-precision", @"Control Panel\Mouse", "MouseSpeed", "String"),
        new("mouse-precision", @"Control Panel\Mouse", "MouseThreshold1", "String"),
        new("mouse-precision", @"Control Panel\Mouse", "MouseThreshold2", "String"),
        new("capture-off", @"Software\Microsoft\Windows\CurrentVersion\GameDVR", "AppCaptureEnabled", "DWord")
    ];
    private static Setting[] Select(string[] ids)
    {
        if (ids.Length is < 1 or > 2 || ids.Distinct().Count() != ids.Length || ids.Any(id => !Settings.Any(s => s.Operation == id))) throw new InvalidOperationException("Unsupported operation selection.");
        return Settings.Where(s => ids.Contains(s.Operation)).ToArray();
    }
    private static ValueState Target(Setting setting) => new(true, setting.Kind == "String" ? "0" : 0, setting.Kind);
    private static object? Normalize(object? value, string kind)
    {
        if (value is JsonElement json) value = json.ValueKind switch { JsonValueKind.String => json.GetString(), JsonValueKind.Number => json.GetInt32(), JsonValueKind.Null => null, _ => throw new InvalidOperationException("Invalid snapshot value.") };
        if (value is null) return null;
        if (kind == "String" && value is string text && text.Length <= 100) return text;
        if (kind == "DWord" && value is int number) return number;
        throw new InvalidOperationException("Invalid registry type in snapshot.");
    }
    private static (Setting Setting, ValueState State)[] Validate(Snapshot snapshot)
    {
        if (snapshot is null || snapshot.Values is null || snapshot.Values.Length is < 1 or > 4 || snapshot.Values.Any(value => value is null)) throw new InvalidOperationException("Empty or invalid snapshot.");
        var required = Select(snapshot.Values.Select(v => v.Operation).Distinct().ToArray());
        if (required.Length != snapshot.Values.Length) throw new InvalidOperationException("Incomplete registry snapshot.");
        return required.Select(setting =>
        {
            var matches = snapshot.Values.Where(v => v.Operation == setting.Operation && v.Path == setting.Path && v.Name == setting.Name && v.Kind == setting.Kind).ToArray();
            if (matches.Length != 1) throw new InvalidOperationException("Snapshot contains an unauthorized setting.");
            var value = matches[0]; var normalized = Normalize(value.Value, value.Kind);
            if (value.Existed == (normalized is null)) throw new InvalidOperationException("Invalid snapshot presence state.");
            return (setting, new ValueState(value.Existed, normalized, value.Kind));
        }).ToArray();
    }
    public Snapshot Capture(string[] ids) => new(Select(ids).Select(setting => { var state = store.Read(setting); return new CapturedValue(setting.Operation, setting.Path, setting.Name, setting.Kind, state.Existed, state.Value); }).ToArray());
    public void Apply(string[] ids, Snapshot expected)
    {
        var states = Validate(expected); var selected = Select(ids);
        if (states.Length != selected.Length || states.Any(s => !selected.Contains(s.Setting))) throw new InvalidOperationException("Snapshot selection mismatch.");
        if (states.Any(s => store.Read(s.Setting) != s.State)) throw new InvalidOperationException("Settings changed after preview. Create a new preview.");
        foreach (var setting in selected) store.Write(setting, Target(setting));
    }
    public bool Verify(string[] ids) => Select(ids).All(setting => store.Read(setting) == Target(setting));
    public void Restore(Snapshot snapshot)
    {
        var states = Validate(snapshot);
        // Check every value before writing so external changes never trigger partial rollback.
        if (states.Any(s => { var current = store.Read(s.Setting); return current != s.State && current != Target(s.Setting); })) throw new InvalidOperationException("An affected preference changed externally. Rollback stopped to preserve it.");
        foreach (var state in states) store.Write(state.Setting, state.State);
        if (states.Any(s => store.Read(s.Setting) != s.State)) throw new InvalidOperationException("Rollback verification failed.");
    }
}
