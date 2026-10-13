using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace Frameforge.Windows;

// Windows 11 lets one program's high timer resolution request reach every program only while this machine-wide value is 1,
// and only after the next start-up. Frameforge changes it solely when the user asks, saves the exact prior value first, and can put it back.
// State: "ready" (read only), "applied", "reverted", "already-set", "conflict", "failed", "declined", "timeout", "expired".
public record TimerGlobalResult(string State, string Detail, bool Existed, int? Value);
public record TimerRequest(string Op, bool Existed, int? Value);

public interface IKernelTimerSetting
{
    // WrongType: the value exists but is not a DWORD, so it is left alone.
    (bool Existed, int? Value, bool WrongType) Read();
    void Write(int value);
    void Delete();
}

public sealed class WindowsKernelTimerSetting : IKernelTimerSetting
{
    private const string Key = @"SYSTEM\CurrentControlSet\Control\Session Manager\kernel", Name = "GlobalTimerResolutionRequests";
    public (bool Existed, int? Value, bool WrongType) Read()
    {
        using var key = Registry.LocalMachine.OpenSubKey(Key, false);
        if (key is null || !key.GetValueNames().Contains(Name, StringComparer.OrdinalIgnoreCase)) return (false, null, false);
        return key.GetValueKind(Name) == RegistryValueKind.DWord ? (true, (int)key.GetValue(Name)!, false) : (true, null, true);
    }
    public void Write(int value)
    {
        using var key = Registry.LocalMachine.OpenSubKey(Key, true) ?? throw new InvalidOperationException("The Windows kernel settings key could not be opened.");
        key.SetValue(Name, value, RegistryValueKind.DWord);
    }
    public void Delete()
    {
        using var key = Registry.LocalMachine.OpenSubKey(Key, true) ?? throw new InvalidOperationException("The Windows kernel settings key could not be opened.");
        key.DeleteValue(Name, false);
    }
}

public static class TimerGlobalSetting
{
    public const int Windows11Build = 22000;
    public static TimerGlobalResult Read(IKernelTimerSetting setting, int build)
    {
        if (build < Windows11Build) return new("failed", "This setting only helps on Windows 11. On Windows 10 a timer request never reaches other programs.", false, null);
        var (existed, value, wrongType) = setting.Read();
        return wrongType ? new("failed", "The setting has an unexpected type, so Frameforge leaves it alone.", true, null)
            : new("ready", value is 1 ? "Already on in Windows." : "Off in Windows.", existed, value);
    }
    // Runs inside the elevated child (or inline when the helper already runs as administrator). existed/value: the prior state Frameforge
    // read and saved before asking. enable changes it only while it still matches that; restore only while it is still what Frameforge set.
    public static TimerGlobalResult Apply(string op, bool existed, int? value, int build, IKernelTimerSetting setting)
    {
        if (op is not ("enable" or "restore")) throw new InvalidOperationException("Unsupported timer request.");
        if (build < Windows11Build) return new("failed", "This setting only helps on Windows 11.", existed, value);
        var (nowExisted, nowValue, wrongType) = setting.Read();
        if (wrongType) return new("failed", "The setting has an unexpected type, so it was left alone. Nothing was changed.", existed, value);
        if (op == "enable")
        {
            if (nowValue is 1) return new("already-set", "GlobalTimerResolutionRequests is already on. Nothing was changed.", nowExisted, nowValue);
            if (nowExisted != existed || nowValue != value) return new("conflict", "The setting changed after Frameforge read it. Nothing was changed; try again.", nowExisted, nowValue);
            setting.Write(1);
            var after = setting.Read();
            return after is { Existed: true, Value: 1 }
                ? new("applied", "GlobalTimerResolutionRequests turned on and verified. Restart Windows for it to take effect.", existed, value)
                : new("failed", "Windows did not keep the setting.", existed, value);
        }
        if (nowExisted == existed && nowValue == value) return new("reverted", "The setting is already back to its original value.", existed, value);
        if (nowValue != 1) return new("conflict", "The setting was changed outside Frameforge since it was turned on; that change was kept.", nowExisted, nowValue);
        if (existed) setting.Write(value ?? 0); else setting.Delete();
        var restored = setting.Read();
        return restored.Existed == existed && restored.Value == value
            ? new("reverted", "The setting is back to its original value and verified. Restart Windows for it to take effect.", existed, value)
            : new("failed", "Windows did not restore the original value.", existed, value);
    }

    private static readonly TimeSpan Approval = TimeSpan.FromSeconds(120), ChildWait = TimeSpan.FromSeconds(30);
    // The unelevated helper: read here, change through the elevated child (one prompt).
    public static TimerGlobalResult Run(TimerRequest request, int build, IKernelTimerSetting setting, IElevatedLauncher? launcher = null, bool? elevated = null, TimeSpan? approval = null, TimeSpan? grace = null)
    {
        if (request.Op == "read") return Read(setting, build);
        if (request.Op is not ("enable" or "restore") || (request.Existed ? request.Value is null : request.Value is not null)) throw new InvalidOperationException("Unsupported timer request.");
        if (build < Windows11Build) return Read(setting, build);
        if (elevated ?? RestoreCommands.IsElevated()) return Apply(request.Op, request.Existed, request.Value, build, setting);
        var outcome = ElevatedCall.Run(launcher ?? new WindowsElevatedLauncher(), "--elevated-timer", request.Op, [request.Existed ? "1" : "0", request.Value?.ToString(CultureInfo.InvariantCulture) ?? "-"], approval ?? Approval, ChildWait, default, grace);
        var unchanged = "Nothing was changed.";
        return outcome.Status switch
        {
            ElevationStatus.Declined => new("declined", $"Administrator approval was declined. {unchanged}", request.Existed, request.Value),
            ElevationStatus.NotApproved or ElevationStatus.Cancelled => new("timeout", $"Administrator approval was not given within 2 minutes. {unchanged} A prompt that is still open does nothing now.", request.Existed, request.Value),
            ElevationStatus.Expired => new("expired", $"The administrator request expired before it was approved. {unchanged}", request.Existed, request.Value),
            ElevationStatus.Rejected => new("failed", $"The administrator step rejected its result file. {unchanged}", request.Existed, request.Value),
            ElevationStatus.NoChild => new("failed", "The administrator request could not start.", request.Existed, request.Value),
            ElevationStatus.ChildTimeout => new("failed", "The administrator step did not finish in time. Check the setting before trying again.", request.Existed, request.Value),
            _ => Parse(outcome.Text, request)
        };
    }
    private static TimerGlobalResult Parse(string? text, TimerRequest request)
    {
        try { if (!string.IsNullOrEmpty(text) && text.Length < 4096 && JsonSerializer.Deserialize<TimerGlobalResult>(text, HelperJson.Options) is { } result) return result; }
        catch (JsonException) { /* Reported below. */ }
        return new("failed", "The administrator step returned no readable result. Check the setting before trying again.", request.Existed, request.Value);
    }

    // A DWORD of 0x80000000 or more reads back as a negative int; both the signed and the unsigned spelling round-trip to the same bits.
    public static int ParseDword(string text)
    {
        var number = long.Parse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        return number is >= int.MinValue and <= int.MaxValue ? (int)number : number is > int.MaxValue and <= uint.MaxValue ? unchecked((int)(uint)number) : throw new OverflowException();
    }
    // Entry point for `--elevated-timer <op> <resultPath> <existed 0|1> <value|->`. Writes exactly one JSON object to the result file.
    public static int RunElevatedChild(string[] argv, Func<object, string> serialize, IKernelTimerSetting? setting = null)
    {
        if (argv.Length != 4) return 2;
        using var file = ElevatedCall.OpenResult(argv[1], out var rejected);
        if (file is null) return rejected;
        TimerGlobalResult result;
        try
        {
            var existed = argv[2] == "1";
            int? value = argv[3] == "-" ? null : ParseDword(argv[3]);
            if (argv[2] is not ("0" or "1") || (existed ? value is null : value is not null)) throw new InvalidOperationException("Unsupported timer request.");
            result = Apply(argv[0], existed, value, Environment.OSVersion.Version.Build, setting ?? new WindowsKernelTimerSetting());
        }
        catch (Exception error) when (error is InvalidOperationException or FormatException or OverflowException)
        {
            result = new("failed", "The timer request was not valid. Nothing was changed.", false, null);
        }
        catch (Exception error) when (error is UnauthorizedAccessException or System.Security.SecurityException or IOException)
        {
            result = new("failed", "Windows refused the change (access denied). Nothing was changed.", false, null);
        }
        file.Write(Encoding.UTF8.GetBytes(serialize(result)));
        return 0;
    }
}
