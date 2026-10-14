namespace Frameforge.Windows;

/// <summary>
/// One registry value, boot-store element or power setting an optimization owns. HKCU paths carry no prefix (kept from the first release);
/// machine paths start with "HKLM\"; boot entries are "bcdedit {entry}" with the element in Name. Target is the DWORD written, Text the string written,
/// Delete means the target state is "absent". OwnKey is how many levels of keys the write may create (and rollback removes again when empty).
/// Via names a fixed non-registry writer ("hibernate" = powercfg /hibernate on|off).
/// </summary>
public record Setting(string Operation, string Path, string Name, string Kind, int Target = 0, string? Text = null, bool Delete = false, int OwnKey = 0, string? Via = null)
{
    public const string Machine = @"HKLM\", BcdPrefix = "bcdedit ";
    public bool IsMachine => Path.StartsWith(Machine, StringComparison.Ordinal);
    public bool IsBcd => Path.StartsWith(BcdPrefix, StringComparison.Ordinal);
    public bool NeedsAdmin => IsMachine || IsBcd;
    /// <summary>Reading needs administrator rights only for the boot store.</summary>
    public bool ReadNeedsAdmin => IsBcd;
}

/// <summary>Per-optimization prerequisites checked at capture and apply (never at rollback). Tamper blocks Defender changes.</summary>
public record OpRule(int MinBuild = 0, string? RequiresKey = null, bool Tamper = false, string Why = "", string[]? AlsoKeys = null, string? Service = null);

public interface IFacts
{
    int Build(); bool MachineKeyExists(string path); bool TamperProtectionOn();
    /// <summary>Why this service cannot be stopped right now (running dependents, Windows refuses), or null when it can or is not running.</summary>
    string? ServiceBlocker(string name) => null;
}

public static class OptimizationTable
{
    private const string Cv = @"Software\Microsoft\Windows\CurrentVersion", Adv = Cv + @"\Explorer\Advanced", Cdm = Cv + @"\ContentDeliveryManager";
    private const string Edge = @"HKLM\SOFTWARE\Policies\Microsoft\Edge", Chrome = @"HKLM\SOFTWARE\Policies\Google\Chrome", ExplorerPolicy = @"HKLM\SOFTWARE\Policies\Microsoft\Windows\Explorer";
    private const string WinPolicy = @"HKLM\SOFTWARE\Policies\Microsoft\Windows", WuPolicy = WinPolicy + @"\WindowsUpdate";
    private const string Mm = @"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management", Dg = @"HKLM\SYSTEM\CurrentControlSet\Control\DeviceGuard";
    private const string Defender = @"HKLM\SOFTWARE\Policies\Microsoft\Windows Defender";
    private const string Svcs = @"HKLM\SYSTEM\CurrentControlSet\Services", PvCap = @"HKLM\SOFTWARE\Microsoft\Windows Photo Viewer\Capabilities\FileAssociations", PvProgId = "PhotoViewer.FileAssoc.Tiff";
    // Start type through the service manager (ChangeServiceConfig), read back from the registry value; State is the run state (stop on apply, start again on rollback only when it ran).
    private static Setting Sv(string op, string service) => new(op, Svcs + @"\" + service, "Start", "DWord", 4, Via: "service-config");
    private static Setting Ss(string op, string service) => new(op, Svcs + @"\" + service, "State", "DWord", 0, Via: "service-stop");
    /// <summary>Operation id to the Windows service it turns off. Every service here is on the Game Mode allowlist and not on the never-touch list (a test checks it).</summary>
    public static readonly Dictionary<string, string> ServiceOps = new()
    {
        ["sysmain-off"] = "SysMain", ["print-off"] = "Spooler", ["svc-diagtrack-off"] = "DiagTrack", ["svc-wsearch-off"] = "WSearch", ["svc-maps-off"] = "MapsBroker",
        ["svc-geolocation-off"] = "lfsvc", ["svc-errorreporting-off"] = "WerSvc", ["svc-phone-off"] = "PhoneSvc", ["svc-linktracking-off"] = "TrkWks", ["svc-retaildemo-off"] = "RetailDemo",
    };
    private static Setting D(string op, string path, string name, int target, int own = 0) => new(op, path, name, "DWord", target, OwnKey: own);
    private static Setting S(string op, string path, string name, string text, int own = 0) => new(op, path, name, "String", Text: text, OwnKey: own);
    private static Setting B(string op, string entry, string element, string value) => new(op, BcdPrefix + entry, element, "String", Text: value);
    private const string BcdPrefix = Setting.BcdPrefix;

    public static readonly Setting[] Settings = [
        // First release.
        new("mouse-precision", @"Control Panel\Mouse", "MouseSpeed", "String"),
        new("mouse-precision", @"Control Panel\Mouse", "MouseThreshold1", "String"),
        new("mouse-precision", @"Control Panel\Mouse", "MouseThreshold2", "String"),
        new("capture-off", Cv + @"\GameDVR", "AppCaptureEnabled", "DWord"),
        new("game-mode", @"Software\Microsoft\GameBar", "AutoGameModeEnabled", "DWord", 1),
        new("game-mode", @"Software\Microsoft\GameBar", "AllowAutoGameMode", "DWord", 1),
        // Current user, no administrator. (Software\Policies under HKCU is write-protected for non-administrators, so policy-based items are machine items below.)
        D("transparency-off", Cv + @"\Themes\Personalize", "EnableTransparency", 0),
        S("shortcut-suffix-off", Cv + @"\Explorer\NamingTemplates", "ShortcutNameTemplate", "%s.lnk", 1),
        S("classic-context-menu", @"Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\InprocServer32", "", "", 2),
        D("explorer-compact-mode", Adv, "UseCompactMode", 1),
        D("explorer-open-this-pc", Adv, "LaunchTo", 1),
        D("explorer-no-recent", Cv + @"\Explorer", "ShowRecent", 0),
        D("explorer-no-recent", Cv + @"\Explorer", "ShowFrequent", 0),
        D("jpeg-wallpaper-quality", @"Control Panel\Desktop", "JPEGImportQuality", 100),
        S("sticky-keys-shortcut-off", @"Control Panel\Accessibility\StickyKeys", "Flags", "506"),
        S("accessibility-shortcuts-off", @"Control Panel\Accessibility\Keyboard Response", "Flags", "122"),
        S("accessibility-shortcuts-off", @"Control Panel\Accessibility\ToggleKeys", "Flags", "58"),
        D("notifications-off", Cv + @"\PushNotifications", "ToastEnabled", 0),
        D("action-center-off", ExplorerPolicy, "DisableNotificationCenter", 1, 1),
        D("storage-sense-off", Cv + @"\StorageSense\Parameters\StoragePolicy", "01", 0),
        D("lock-theme-icons", Cv + @"\Themes", "ThemeChangesMousePointers", 0),
        D("lock-theme-icons", Cv + @"\Themes", "ThemeChangesDesktopIcons", 0),
        D("clean-taskbar", Cv + @"\Search", "SearchboxTaskbarMode", 0),
        D("clean-taskbar", Adv, "ShowTaskViewButton", 0),
        S("visual-effects-light", @"Control Panel\Desktop\WindowMetrics", "MinAnimate", "0"),
        D("visual-effects-light", Adv, "TaskbarAnimations", 0),
        D("visual-effects-light", Adv, "ListviewAlphaSelect", 0),
        D("visual-effects-light", Adv, "ListviewShadow", 0),
        D("visual-effects-light", @"Software\Microsoft\Windows\DWM", "EnableAeroPeek", 0),
        D("reduce-ads", Cv + @"\AdvertisingInfo", "Enabled", 0),
        D("reduce-ads", Cdm, "SystemPaneSuggestionsEnabled", 0),
        D("reduce-ads", Cdm, "SubscribedContent-338388Enabled", 0),
        D("reduce-ads", Cdm, "SubscribedContent-338389Enabled", 0),
        D("reduce-ads", Cdm, "SubscribedContent-353698Enabled", 0),
        D("reduce-ads", Cdm, "SilentInstalledAppsEnabled", 0),
        D("reduce-ads", Cdm, "SoftLandingEnabled", 0),
        D("reduce-ads", Cdm, "RotatingLockScreenOverlayEnabled", 0),
        D("reduce-ads", Adv, "ShowSyncProviderNotifications", 0),
        D("reduce-ads", Cv + @"\Privacy", "TailoredExperiencesWithDiagnosticDataEnabled", 0),
        D("search-web-off", ExplorerPolicy, "DisableSearchBoxSuggestions", 1, 1),
        new("onedrive-startup-off", Cv + @"\Run", "OneDrive", "String", Delete: true),
        D("browser-background-off", Edge, "BackgroundModeEnabled", 0, 2),
        D("browser-background-off", Edge, "StartupBoostEnabled", 0, 2),
        D("browser-background-off", Chrome, "BackgroundModeEnabled", 0, 2),
        D("browser-hwaccel-off", Edge, "HardwareAccelerationModeEnabled", 0, 2),
        D("browser-hwaccel-off", Chrome, "HardwareAccelerationModeEnabled", 0, 2),
        // Machine settings, Advanced: administrator approval for every write.
        D("lock-screen-blur-off", WinPolicy + @"\System", "DisableAcrylicBackgroundOnLogon", 1, 1),
        D("insider-off", WinPolicy + @"\PreviewBuilds", "AllowBuildPreview", 0, 1),
        D("verbose-boot-status", @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "VerboseStatus", 1),
        D("onedrive-sync-policy-off", WinPolicy + @"\OneDrive", "DisableFileSyncNGSC", 1, 1),
        D("telemetry-minimum", WinPolicy + @"\DataCollection", "AllowTelemetry", 0, 1),
        D("telemetry-minimum", WinPolicy + @"\DataCollection", "DoNotShowFeedbackNotifications", 1, 1),
        D("harden-anonymous-access", @"HKLM\SYSTEM\CurrentControlSet\Control\Lsa", "RestrictAnonymous", 1),
        D("background-apps-off", WinPolicy + @"\AppPrivacy", "LetAppsRunInBackground", 2, 1),
        D("dlss-indicator", @"HKLM\SOFTWARE\NVIDIA Corporation\Global\NGXCore", "ShowDlssIndicator", 1024),
        new("hibernate-off", @"HKLM\SYSTEM\CurrentControlSet\Control\Power", "HibernateEnabled", "DWord", 0, Via: "hibernate"),
        B("boot-timeout-short", "{bootmgr}", "timeout", "2"),
        B("boot-menu-legacy", "{current}", "bootmenupolicy", "legacy"),
        B("boot-logo-off", "{current}", "quietboot", "on"),
        // Windows services: start type disabled through the service manager, then stopped. Rollback restores the exact start type, then starts it again if it was running.
        Sv("sysmain-off", "SysMain"), Ss("sysmain-off", "SysMain"),
        Sv("print-off", "Spooler"), Ss("print-off", "Spooler"),
        Sv("svc-diagtrack-off", "DiagTrack"), Ss("svc-diagtrack-off", "DiagTrack"),
        Sv("svc-wsearch-off", "WSearch"), Ss("svc-wsearch-off", "WSearch"),
        Sv("svc-maps-off", "MapsBroker"), Ss("svc-maps-off", "MapsBroker"),
        Sv("svc-geolocation-off", "lfsvc"), Ss("svc-geolocation-off", "lfsvc"),
        Sv("svc-errorreporting-off", "WerSvc"), Ss("svc-errorreporting-off", "WerSvc"),
        Sv("svc-phone-off", "PhoneSvc"), Ss("svc-phone-off", "PhoneSvc"),
        Sv("svc-linktracking-off", "TrkWks"), Ss("svc-linktracking-off", "TrkWks"),
        Sv("svc-retaildemo-off", "RetailDemo"), Ss("svc-retaildemo-off", "RetailDemo"),
        // Windows Photo Viewer: registers the built-in viewer for more image types (Default Programs capabilities); no default app is changed.
        S("photo-viewer", PvCap, ".bmp", PvProgId), S("photo-viewer", PvCap, ".dib", PvProgId), S("photo-viewer", PvCap, ".gif", PvProgId),
        S("photo-viewer", PvCap, ".jfif", PvProgId), S("photo-viewer", PvCap, ".jpe", PvProgId), S("photo-viewer", PvCap, ".jpeg", PvProgId),
        S("photo-viewer", PvCap, ".jpg", PvProgId), S("photo-viewer", PvCap, ".jxr", PvProgId), S("photo-viewer", PvCap, ".png", PvProgId),
        // Security trade-offs: same engine, extra guardrails in the app.
        D("defender-off", Defender, "DisableAntiSpyware", 1, 1),
        D("defender-off", Defender + @"\Real-Time Protection", "DisableRealtimeMonitoring", 1, 2),
        D("mitigations-off", Mm, "FeatureSettingsOverride", 3),
        D("mitigations-off", Mm, "FeatureSettingsOverrideMask", 3),
        D("vbs-hyperv-off", Dg, "EnableVirtualizationBasedSecurity", 0, 1),
        D("vbs-hyperv-off", Dg + @"\Scenarios\HypervisorEnforcedCodeIntegrity", "Enabled", 0, 2),
        B("vbs-hyperv-off", "{current}", "hypervisorlaunchtype", "off"),
        D("uac-off", @"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "EnableLUA", 0),
        D("smartscreen-off", WinPolicy + @"\System", "EnableSmartScreen", 0, 1),
        D("windows-updates-off", WuPolicy + @"\AU", "NoAutoUpdate", 1, 2),
        D("driver-updates-off", WuPolicy, "ExcludeWUDriversInQualityUpdate", 1, 1),
        D("browser-updates-off", @"HKLM\SOFTWARE\Policies\Microsoft\EdgeUpdate", "UpdateDefault", 0, 1),
        D("browser-updates-off", @"HKLM\SOFTWARE\Policies\Google\Update", "UpdateDefault", 0, 2),
        D("security-questions-off", WinPolicy + @"\System", "NoLocalPasswordResetQuestions", 1, 1),
        D("ucpd-off", @"HKLM\SYSTEM\CurrentControlSet\Services\UCPD", "Start", 4),
        D("win11-checks-bypass", @"HKLM\SYSTEM\Setup\MoSetup", "AllowUpgradesWithUnsupportedTPMOrCPU", 1, 1),
    ];

    /// <summary>Optimizations that lower security. The app asks for an explicit acknowledgement before applying them.</summary>
    public static readonly string[] Security = ["defender-off", "mitigations-off", "vbs-hyperv-off", "uac-off", "smartscreen-off", "windows-updates-off", "driver-updates-off", "browser-updates-off", "security-questions-off", "ucpd-off", "win11-checks-bypass"];

    public static readonly Dictionary<string, OpRule> Rules = new(ServiceOps.ToDictionary(p => p.Key, p => new OpRule(RequiresKey: @"SYSTEM\CurrentControlSet\Services\" + p.Value, Why: $"The {p.Value} service is not installed on this PC.", Service: p.Value)))
    {
        ["photo-viewer"] = new(RequiresKey: @"SOFTWARE\Microsoft\Windows Photo Viewer\Capabilities\FileAssociations", AlsoKeys: [@"SOFTWARE\Classes\" + PvProgId], Why: "Windows Photo Viewer is not registered on this PC (its capabilities or file association entry is missing)."),
        ["classic-context-menu"] = new(MinBuild: 22000, Why: "The classic menu switch only exists on Windows 11."),
        ["explorer-compact-mode"] = new(MinBuild: 22000, Why: "Compact mode is a Windows 11 File Explorer option."),
        ["dlss-indicator"] = new(RequiresKey: @"SOFTWARE\NVIDIA Corporation\Global\NGXCore", Why: "The NVIDIA DLSS registry key is not present; an NVIDIA GPU and driver are required."),
        ["defender-off"] = new(Tamper: true, Why: "Tamper Protection is on. Turn off Tamper Protection in Windows Security first; Frameforge never bypasses it."),
    };

    public static bool IsAdmin(string id) => Settings.Any(s => s.Operation == id && s.NeedsAdmin);
    public static bool ReadNeedsAdmin(string id) => Settings.Any(s => s.Operation == id && s.ReadNeedsAdmin);

    /// <summary>Throws when this PC cannot take the optimization (wrong Windows, missing GPU key, Tamper Protection).</summary>
    public static void Check(string id, IFacts facts)
    {
        if (!Rules.TryGetValue(id, out var rule)) return;
        if (rule.MinBuild > 0 && facts.Build() < rule.MinBuild) throw new InvalidOperationException(rule.Why + " No change was made.");
        if (rule.RequiresKey is not null && !facts.MachineKeyExists(rule.RequiresKey)) throw new InvalidOperationException(rule.Why + " No change was made.");
        if (rule.Tamper && facts.TamperProtectionOn()) throw new InvalidOperationException(rule.Why + " No change was made.");
        if (rule.AlsoKeys is not null && rule.AlsoKeys.Any(k => !facts.MachineKeyExists(k))) throw new InvalidOperationException(rule.Why + " No change was made.");
        if (rule.Service is not null && facts.ServiceBlocker(rule.Service) is { } blocker) throw new InvalidOperationException($"{blocker} No change was made.");
    }
    /// <summary>Ids whose static prerequisites hold here (Tamper Protection is a runtime state, shown at preview instead).</summary>
    public static string[] Applicable(IFacts facts) => Settings.Select(s => s.Operation).Distinct().Where(id =>
    {
        if (!Rules.TryGetValue(id, out var rule)) return true;
        return (rule.MinBuild == 0 || facts.Build() >= rule.MinBuild) && (rule.RequiresKey is null || facts.MachineKeyExists(rule.RequiresKey)) && (rule.AlsoKeys is null || rule.AlsoKeys.All(facts.MachineKeyExists));
    }).ToArray();
}
