import type { AppState, OperationId, Request } from "./contracts.js";

export type Category =
  | "FPS & Latency"
  | "Privacy"
  | "Quality of Life"
  | "Storage & Boot"
  | "Security trade-offs";
/** standard: current user, no admin. advanced: machine setting or boot store, off by default. security: lowers protection, extra guardrails. */
export type Tier = "standard" | "advanced" | "security";
/** What the person has to do after applying (or rolling back) before Windows reads the new value. */
export type Restart =
  | "none"
  | "wallpaper"
  | "browser"
  | "signin"
  | "explorer"
  | "signout"
  | "reboot";
export const categories: Category[] = [
  "FPS & Latency",
  "Privacy",
  "Quality of Life",
  "Storage & Boot",
  "Security trade-offs",
];
export const restartText: Record<Restart, string> = {
  none: "Takes effect without a restart.",
  wallpaper: "Applies the next time a wallpaper is set.",
  browser: "Close and reopen Edge and Chrome for the policy to apply.",
  signin: "Takes effect the next time you sign in.",
  explorer:
    "Restart Windows Explorer (or sign out and in) for Windows to show the change.",
  signout: "Sign out and back in for Windows to read the change.",
  reboot: "Restart the PC for Windows to read the change.",
};
export interface Optimization {
  id: OperationId;
  name: string;
  category: Category;
  tier: Tier;
  risk: "Low" | "Moderate" | "High";
  impact: string;
  description: string;
  reason: string;
  settings: string[];
  prerequisites: string[];
  supported: boolean;
  /** Needs a Windows administrator prompt (HKLM, boot store, powercfg). */
  admin: boolean;
  restart: Restart;
  /** Plain-language consequence shown in red for security trade-offs. */
  consequence?: string;
  rollback: string;
  /** Windows page for manual review of unsupported entries. */
  settingsPage?: Request<"openSettings">["page"];
}
/** Catalog entries Frameforge deliberately does not toggle, listed so the choice is visible. */
export interface Unavailable {
  name: string;
  group: "FPS & Latency" | "Privacy" | "Quality of Life" | "Storage & Boot";
  status: "info-only" | "not-offered";
  reason: string;
}

const user = [
  "Windows desktop helper available",
  "Current-user registry writable",
];
const machine = [
  "Windows desktop helper available",
  "Windows administrator approval (one prompt for each apply and each rollback)",
];
const exact = (extra = "") =>
  `Restores each captured value exactly, deleting values that were absent.${extra ? " " + extra : ""}`;
const hklmNote = " Windows administrator approval is needed to restore it too.";

type Def = Omit<
  Optimization,
  "supported" | "tier" | "admin" | "restart" | "prerequisites"
> &
  Partial<Pick<Optimization, "tier" | "admin" | "restart" | "prerequisites">>;
const item = (d: Def): Optimization => ({
  supported: true,
  tier: "standard",
  admin: false,
  restart: "none",
  prerequisites: user,
  ...d,
});
const adv = (d: Def): Optimization =>
  item({ tier: "advanced", admin: true, prerequisites: machine, ...d });
const sec = (d: Omit<Def, "category" | "risk">): Optimization =>
  item({
    tier: "security",
    admin: true,
    risk: "High",
    category: "Security trade-offs",
    prerequisites: machine,
    ...d,
  });

export const catalogue: Optimization[] = [
  item({
    id: "mouse-precision",
    name: "Consistent pointer movement",
    category: "FPS & Latency",
    risk: "Low",
    impact: "Input preference",
    description: "Turn off Windows pointer acceleration for the current user.",
    reason:
      "Makes desktop pointer movement consistent. Games using raw input may ignore this setting. No FPS improvement is claimed.",
    settings: [
      "HKCU\\Control Panel\\Mouse: MouseSpeed, MouseThreshold1, MouseThreshold2",
    ],
    restart: "signout",
    rollback:
      "Restores captured string values, including deleting previously absent values. Sign out and back in for Windows to reload the preference.",
  }),
  item({
    id: "capture-off",
    name: "Disable background game capture",
    category: "FPS & Latency",
    risk: "Moderate",
    impact: "Capture preference",
    description: "Set the current-user Game DVR capture preference to off.",
    reason:
      "Disables the capture preference used by supported Windows Game DVR configurations. Other recording apps are unaffected; no performance gain is guaranteed.",
    settings: [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR: AppCaptureEnabled",
    ],
    rollback:
      "Restores the original DWORD or removes the value if originally absent. Capture applications may need to be reopened.",
  }),
  item({
    id: "power-plan",
    name: "High performance power plan",
    category: "FPS & Latency",
    risk: "Moderate",
    impact: "Power policy",
    description:
      "Switch the active Windows power plan to a performance plan (High performance, then Ultimate performance, then Frameforge's own copy).",
    reason:
      "Lets the processor stay at higher clock states. It raises heat, fan noise and energy use, and shortens laptop battery life. No FPS improvement is claimed. Game Mode can switch plans for a single session instead; this switch stays until you roll it back. The preview names the plan it will switch to. High performance is used when present, otherwise Ultimate performance, otherwise the Frameforge High performance plan you created in Game Mode; if that plan is already active, nothing changes.",
    settings: ["Active Windows power plan (powrprof PowerSetActiveScheme)"],
    prerequisites: [
      "Windows desktop helper available",
      "A performance plan is present: Windows' High performance or Ultimate performance, or the Frameforge copy created in Game Mode (Modern Standby laptops often only have Balanced)",
    ],
    rollback:
      "Switches back to the exact plan that was active before, only while the plan it switched to is still active. A plan you chose since is kept.",
  }),
  {
    id: "hardware-scheduling",
    name: "GPU scheduling review",
    category: "FPS & Latency",
    tier: "standard",
    risk: "Moderate",
    impact: "Display preference",
    description: "Review hardware-accelerated GPU scheduling.",
    reason:
      "Results vary by driver and game. Requires platform-specific verification before implementation.",
    settings: ["Windows graphics settings"],
    prerequisites: ["Compatible GPU and driver"],
    supported: false,
    admin: false,
    restart: "none",
    rollback: "Unavailable; preview only.",
    settingsPage: "graphics",
  },
  {
    id: "startup-review",
    name: "Startup app review",
    category: "Quality of Life",
    tier: "standard",
    risk: "Low",
    impact: "Background workload",
    description: "Review software that starts when you sign in.",
    reason: "No third-party startup entries are modified by Frameforge.",
    settings: ["Third-party startup entries"],
    prerequisites: ["Manual review in Windows Settings > Apps > Startup"],
    supported: false,
    admin: false,
    restart: "none",
    rollback: "Unavailable; read-only catalogue entry.",
    settingsPage: "startup",
  },
  {
    id: "driver-review",
    name: "Graphics driver review",
    category: "FPS & Latency",
    tier: "standard",
    risk: "Moderate",
    impact: "Compatibility",
    description: "Inspect the detected driver version in System information.",
    reason:
      "Driver installation remains with the vendor. Frameforge does not download or install drivers.",
    settings: ["GPU driver"],
    prerequisites: ["Vendor installer"],
    supported: false,
    admin: false,
    restart: "none",
    rollback: "Unavailable; no driver changes.",
  },
  {
    id: "dns-tuning",
    name: "DNS configuration",
    category: "FPS & Latency",
    tier: "standard",
    risk: "Moderate",
    impact: "Name resolution",
    description: "Review your resolver configuration.",
    reason:
      "Changing DNS does not generally improve in-game latency. Automated tuning is unsupported.",
    settings: ["Network adapter DNS"],
    prerequisites: ["Network configuration review"],
    supported: false,
    admin: false,
    restart: "none",
    rollback: "Unavailable; no network changes.",
    settingsPage: "network",
  },
  {
    id: "service-tuning",
    name: "Service configuration",
    category: "FPS & Latency",
    tier: "standard",
    risk: "High",
    impact: "System stability",
    description: "Windows service modifications are not supported.",
    reason:
      "Disabling services can break security and system functionality, so Optimizations never change services or their start type. Game Mode can pause a short list of safe services for one session (stop only, restarted afterwards, with your administrator approval).",
    settings: ["Windows services"],
    prerequisites: ["Independent service-specific verification"],
    supported: false,
    admin: false,
    restart: "none",
    rollback: "Unavailable; no service changes.",
    settingsPage: "services",
  },

  // ---- Quality of Life: current user, no administrator -------------------------------------------------
  item({
    id: "transparency-off",
    name: "Turn off transparency effects",
    category: "Quality of Life",
    risk: "Low",
    impact: "Appearance",
    description:
      "Turns off transparency in the Start menu, taskbar and Settings.",
    reason:
      "A visual preference that can help older hardware. It is not an FPS gain while a game runs.",
    settings: [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize: EnableTransparency = 0 (DWORD)",
    ],
    rollback: exact("Takes effect immediately."),
  }),
  item({
    id: "classic-context-menu",
    name: "Classic right-click menu (Windows 11)",
    category: "Quality of Life",
    risk: "Low",
    impact: "File Explorer menu",
    description:
      "Shows the full Windows 10 style context menu without the extra 'Show more options' step.",
    reason:
      "Creates the per-user COM override Windows 11 honours for the new context menu. Windows 11 only.",
    settings: [
      "HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32: (Default) = empty string. The key is created and removed again on rollback.",
    ],
    prerequisites: [
      ...user,
      "Windows 11 (build 22000 or later)",
      "The key does not already exist as an empty key",
    ],
    restart: "explorer",
    rollback: exact("Removes the keys this change created."),
  }),
  item({
    id: "explorer-compact-mode",
    name: "File Explorer compact view (Windows 11)",
    category: "Quality of Life",
    risk: "Low",
    impact: "File Explorer layout",
    description: "Reduces the spacing between files and folders.",
    reason:
      "The same setting as File Explorer's 'Decrease space between items' option.",
    settings: [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced: UseCompactMode = 1 (DWORD)",
    ],
    prerequisites: [...user, "Windows 11 (build 22000 or later)"],
    restart: "explorer",
    rollback: exact(),
  }),
  item({
    id: "explorer-open-this-pc",
    name: "File Explorer opens to This PC",
    category: "Quality of Life",
    risk: "Low",
    impact: "File Explorer start page",
    description: "Opens File Explorer on This PC instead of Home.",
    reason:
      "The same setting as File Explorer's 'Open File Explorer to' option.",
    settings: [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced: LaunchTo = 1 (DWORD)",
    ],
    rollback: exact(),
  }),
  item({
    id: "shortcut-suffix-off",
    name: "Remove the '- Shortcut' suffix",
    category: "Quality of Life",
    risk: "Low",
    impact: "New shortcut names",
    description:
      "New shortcuts keep the target's name instead of adding '- Shortcut'.",
    reason: "Only affects shortcuts created after the change.",
    settings: [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\NamingTemplates: ShortcutNameTemplate = "%s.lnk" (String). The key is created and removed again on rollback.',
    ],
    prerequisites: [
      ...user,
      "The NamingTemplates key does not already exist as an empty key",
    ],
    rollback: exact("Removes the key this change created."),
  }),
  item({
    id: "sticky-keys-shortcut-off",
    name: "Turn off the Sticky Keys shortcut",
    category: "Quality of Life",
    risk: "Low",
    impact: "Accessibility shortcut",
    description:
      "Pressing Shift five times no longer opens the Sticky Keys prompt, for example in the middle of a game.",
    reason:
      "Clears only the hotkey bit of the Sticky Keys flags (value 506). Sticky Keys itself stays available in Settings.",
    settings: [
      'HKCU\\Control Panel\\Accessibility\\StickyKeys: Flags = "506" (String)',
    ],
    restart: "signout",
    rollback: exact("Sign out and back in to reload it."),
  }),
  item({
    id: "accessibility-shortcuts-off",
    name: "Turn off Filter Keys and Toggle Keys shortcuts",
    category: "Quality of Life",
    risk: "Low",
    impact: "Accessibility shortcuts",
    description:
      "Holding Shift for eight seconds or Num Lock for five no longer opens an accessibility prompt. Narrator and Magnifier are not touched.",
    reason: "Clears only the hotkey bit of each flags value (122 and 58).",
    settings: [
      'HKCU\\Control Panel\\Accessibility\\Keyboard Response: Flags = "122" (String)',
      'HKCU\\Control Panel\\Accessibility\\ToggleKeys: Flags = "58" (String)',
    ],
    restart: "signout",
    rollback: exact("Sign out and back in to reload it."),
  }),
  item({
    id: "notifications-off",
    name: "Turn off app notifications",
    category: "Quality of Life",
    risk: "Moderate",
    impact: "Notifications",
    description: "Turns off toast notifications from apps and Windows.",
    reason:
      "The same switch as Settings > System > Notifications. You will not see alerts, such as calendar or security reminders.",
    settings: [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications: ToastEnabled = 0 (DWORD)",
    ],
    rollback: exact(),
  }),
  adv({
    id: "action-center-off",
    name: "Hide the notification center",
    category: "Quality of Life",
    risk: "Moderate",
    impact: "Taskbar",
    description:
      "Removes the notification center and calendar flyout button from the taskbar (Group Policy equivalent).",
    reason:
      "Documented policy 'Remove Notifications and Action Center'. The machine policy hive is used because Windows blocks per-user policy writes without administrator rights; it applies to every user of this PC.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Explorer: DisableNotificationCenter = 1 (DWORD). The key is removed again on rollback when empty.",
    ],
    restart: "explorer",
    rollback: exact(),
  }),
  item({
    id: "storage-sense-off",
    name: "Turn off Storage Sense",
    category: "Quality of Life",
    risk: "Low",
    impact: "Automatic cleanup",
    description: "Stops Windows from cleaning temporary files automatically.",
    reason: "The same switch as Settings > System > Storage > Storage Sense.",
    settings: [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy: 01 = 0 (DWORD)",
    ],
    rollback: exact(),
  }),
  item({
    id: "lock-theme-icons",
    name: "Stop themes changing pointers and desktop icons",
    category: "Quality of Life",
    risk: "Low",
    impact: "Personalization",
    description:
      "Applying a theme keeps your mouse pointers and desktop icons.",
    reason: "The two checkboxes in Desktop Icon Settings and Mouse Properties.",
    settings: [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes: ThemeChangesMousePointers = 0, ThemeChangesDesktopIcons = 0 (DWORD)",
    ],
    rollback: exact(),
  }),
  item({
    id: "clean-taskbar",
    name: "Cleaner taskbar and search",
    category: "Quality of Life",
    risk: "Low",
    impact: "Taskbar",
    description: "Hides the taskbar search box and the Task View button.",
    reason:
      "Both are options in Settings > Personalization > Taskbar. The Widgets button is write-protected by Windows and is not touched.",
    settings: [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Search: SearchboxTaskbarMode = 0 (DWORD)",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced: ShowTaskViewButton = 0 (DWORD)",
    ],
    restart: "explorer",
    rollback: exact(),
  }),
  item({
    id: "visual-effects-light",
    name: "Lighter window animations",
    category: "Quality of Life",
    risk: "Low",
    impact: "Appearance",
    description:
      "Turns off minimize animation, taskbar animations, list shadows and Aero Peek.",
    reason:
      "A visual preference. It is not an FPS gain while a game runs in full-screen.",
    settings: [
      'HKCU\\Control Panel\\Desktop\\WindowMetrics: MinAnimate = "0" (String)',
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced: TaskbarAnimations, ListviewAlphaSelect, ListviewShadow = 0 (DWORD)",
      "HKCU\\Software\\Microsoft\\Windows\\DWM: EnableAeroPeek = 0 (DWORD)",
    ],
    restart: "signout",
    rollback: exact("Sign out and back in to reload it."),
  }),
  item({
    id: "jpeg-wallpaper-quality",
    name: "Full-quality JPEG wallpaper",
    category: "Quality of Life",
    risk: "Low",
    impact: "Wallpaper",
    description:
      "Stops Windows compressing JPEG wallpapers (quality 100 instead of 85).",
    reason: "Applies the next time a wallpaper is set.",
    settings: ["HKCU\\Control Panel\\Desktop: JPEGImportQuality = 100 (DWORD)"],
    restart: "wallpaper",
    rollback: exact(),
  }),
  item({
    id: "explorer-no-recent",
    name: "Hide recent and frequent files in Quick access",
    category: "Privacy",
    risk: "Low",
    impact: "File Explorer privacy",
    description:
      "Stops File Explorer listing recent files and frequent folders.",
    reason: "The same options as File Explorer's Privacy settings.",
    settings: [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer: ShowRecent = 0, ShowFrequent = 0 (DWORD)",
    ],
    restart: "explorer",
    rollback: exact(),
  }),

  // ---- Privacy ----------------------------------------------------------------------------------------
  item({
    id: "reduce-ads",
    name: "Reduce ads and suggestions",
    category: "Privacy",
    risk: "Low",
    impact: "Advertising and tracking",
    description:
      "Turns off the advertising ID, Start menu suggestions, silently installed suggested apps and tailored experiences.",
    reason:
      "Each value is a switch Windows Settings itself writes (Privacy and Personalization). This does not stop diagnostic data; see 'Minimum Windows diagnostic data'.",
    settings: [
      "HKCU\\...\\AdvertisingInfo: Enabled = 0",
      "HKCU\\...\\ContentDeliveryManager: SystemPaneSuggestionsEnabled, SubscribedContent-338388Enabled, SubscribedContent-338389Enabled, SubscribedContent-353698Enabled, SilentInstalledAppsEnabled, SoftLandingEnabled, RotatingLockScreenOverlayEnabled = 0",
      "HKCU\\...\\Explorer\\Advanced: ShowSyncProviderNotifications = 0",
      "HKCU\\...\\Privacy: TailoredExperiencesWithDiagnosticDataEnabled = 0",
    ],
    rollback: exact(),
  }),
  adv({
    id: "search-web-off",
    name: "No web results in Start search",
    category: "Privacy",
    risk: "Low",
    impact: "Search privacy",
    description:
      "Start search shows only local results. (The literal 'redirect web searches to the default browser' needs a third-party protocol handler and is not offered.)",
    reason:
      "Documented policy 'Turn off search box suggestions' plus Bing search toggle.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Explorer: DisableSearchBoxSuggestions = 1 (DWORD)",
    ],
    restart: "explorer",
    rollback: exact(),
  }),
  item({
    id: "onedrive-startup-off",
    name: "Do not start OneDrive at sign-in",
    category: "Privacy",
    risk: "Low",
    impact: "Background sync",
    description:
      "Removes OneDrive's sign-in entry. OneDrive stays installed and can still be started by hand.",
    reason:
      "OneDrive may add the entry again after an update or sign-in; rollback restores your exact entry.",
    settings: [
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run: OneDrive (deleted; the exact command line is captured)",
    ],
    restart: "signin",
    rollback: exact("Puts the exact original command line back."),
  }),
  adv({
    id: "browser-background-off",
    name: "Stop Edge and Chrome running in the background",
    category: "FPS & Latency",
    tier: "advanced",
    risk: "Moderate",
    impact: "Background activity",
    description:
      "Turns off background mode and Edge's startup boost so the browsers do not keep processes after you close them.",
    reason:
      "Uses the browsers' documented policies. The browsers then show 'managed by your organization'. Pages open a little slower after a cold start.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge: BackgroundModeEnabled = 0, StartupBoostEnabled = 0 (DWORD)",
      "HKLM\\SOFTWARE\\Policies\\Google\\Chrome: BackgroundModeEnabled = 0 (DWORD)",
    ],
    restart: "browser",
    rollback: exact("Removes the policy keys this change created."),
  }),
  adv({
    id: "browser-hwaccel-off",
    name: "Turn off browser hardware acceleration",
    category: "FPS & Latency",
    tier: "advanced",
    risk: "Moderate",
    impact: "Browser rendering",
    description: "Edge and Chrome draw pages on the CPU instead of the GPU.",
    reason:
      "Can help with browser glitches or free GPU memory for a game, but usually makes the browser slower. Uses the browsers' documented policies, so they show 'managed by your organization'.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge: HardwareAccelerationModeEnabled = 0",
      "HKLM\\SOFTWARE\\Policies\\Google\\Chrome: HardwareAccelerationModeEnabled = 0",
    ],
    restart: "browser",
    rollback: exact("Removes the policy keys this change created."),
  }),

  // ---- Machine settings: Advanced, administrator approval ----------------------------------------------
  adv({
    id: "lock-screen-blur-off",
    name: "Clear lock screen background",
    category: "Quality of Life",
    risk: "Low",
    impact: "Sign-in screen",
    description: "Removes the acrylic blur from the sign-in screen background.",
    reason: "Documented policy 'Show clear logon background'.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System: DisableAcrylicBackgroundOnLogon = 1 (DWORD)",
    ],
    restart: "signout",
    rollback: exact(hklmNote.trim()),
  }),
  adv({
    id: "insider-off",
    name: "Block Windows Insider builds",
    category: "Privacy",
    risk: "Moderate",
    impact: "Windows Update channel",
    description:
      "Policy that stops this PC receiving Windows Insider preview builds.",
    reason:
      "Documented policy System/AllowBuildPreview. A PC currently on an Insider build stays on it until you change the build channel.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\PreviewBuilds: AllowBuildPreview = 0 (DWORD)",
    ],
    rollback: exact(hklmNote.trim()),
  }),
  adv({
    id: "verbose-boot-status",
    name: "Show detailed startup and shutdown messages",
    category: "Storage & Boot",
    risk: "Low",
    impact: "Boot information",
    description:
      "Windows shows what it is doing while starting, shutting down, signing in and out.",
    reason: "Documented policy 'Display highly detailed status messages'.",
    settings: [
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System: VerboseStatus = 1 (DWORD)",
    ],
    restart: "reboot",
    rollback: exact(hklmNote.trim()),
  }),
  adv({
    id: "onedrive-sync-policy-off",
    name: "Turn off OneDrive file sync (policy)",
    category: "Privacy",
    risk: "Moderate",
    impact: "File sync",
    description: "Policy that prevents OneDrive syncing files for every user.",
    reason:
      "Documented policy 'Prevent the usage of OneDrive for file storage'. Files already synced stay on disk, but folders redirected to OneDrive stop syncing.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\OneDrive: DisableFileSyncNGSC = 1 (DWORD)",
    ],
    restart: "signout",
    rollback: exact(hklmNote.trim()),
  }),
  adv({
    id: "telemetry-minimum",
    name: "Minimum Windows diagnostic data",
    category: "Privacy",
    risk: "Moderate",
    impact: "Diagnostic data",
    description:
      "Sets the diagnostic data policy to the lowest level and stops feedback prompts.",
    reason:
      "Documented policy AllowTelemetry = 0. Windows Home and Pro treat 0 as the 'Required' level; only Enterprise and Education reach 'Security'. This PC may already have the value set.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection: AllowTelemetry = 0, DoNotShowFeedbackNotifications = 1 (DWORD)",
    ],
    rollback: exact(hklmNote.trim()),
  }),
  adv({
    id: "harden-anonymous-access",
    name: "Restrict anonymous network access",
    category: "Privacy",
    risk: "Moderate",
    impact: "Network security",
    description:
      "Does not allow anonymous users to list accounts and shares on this PC.",
    reason:
      "Documented security option. It can stop very old devices (some NAS boxes, Windows XP era) from browsing shares on this PC.",
    settings: [
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa: RestrictAnonymous = 1 (DWORD)",
    ],
    restart: "reboot",
    rollback: exact(hklmNote.trim()),
  }),
  adv({
    id: "background-apps-off",
    name: "Stop Microsoft Store apps running in the background",
    category: "FPS & Latency",
    risk: "Moderate",
    impact: "Background activity",
    description:
      "Policy that stops Store apps running in the background for every user.",
    reason:
      "Documented policy Privacy/LetAppsRunInBackground = 2. Apps no longer update live tiles or receive background notifications, and the per-app switches in Settings are locked.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\AppPrivacy: LetAppsRunInBackground = 2 (DWORD)",
    ],
    restart: "signout",
    rollback: exact(hklmNote.trim()),
  }),
  adv({
    id: "dlss-indicator",
    name: "Show the DLSS indicator",
    category: "FPS & Latency",
    risk: "Low",
    impact: "NVIDIA overlay",
    description:
      "Shows an on-screen indicator in games using NVIDIA DLSS, to confirm it is running.",
    reason:
      "NVIDIA's documented NGX registry key (ShowDlssIndicator = 1024). Diagnostic overlay only.",
    settings: [
      "HKLM\\SOFTWARE\\NVIDIA Corporation\\Global\\NGXCore: ShowDlssIndicator = 1024 (DWORD)",
    ],
    prerequisites: [
      ...machine,
      "NVIDIA driver with the NGXCore registry key present",
    ],
    rollback: exact(hklmNote.trim()),
  }),
  adv({
    id: "hibernate-off",
    name: "Turn off hibernation",
    category: "Storage & Boot",
    risk: "Moderate",
    impact: "Disk space, Fast Startup",
    description:
      "Deletes the hibernation file and turns hibernation off, which also turns off Fast Startup.",
    reason:
      "Frees disk space roughly the size of the installed memory. Laptops lose Hibernate. Uses powercfg /hibernate off.",
    settings: [
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power: HibernateEnabled (read) via 'powercfg /hibernate off'",
    ],
    restart: "reboot",
    rollback: exact(
      "Runs 'powercfg /hibernate on' when it was on before, which recreates the file." +
        hklmNote,
    ),
  }),
  adv({
    id: "boot-timeout-short",
    name: "Shorter boot menu timeout",
    category: "Storage & Boot",
    risk: "Moderate",
    impact: "Startup",
    description:
      "The operating-system choice screen waits 2 seconds instead of 30. Pressing an arrow key stops the countdown.",
    reason:
      "Changes the boot manager's timeout with 'bcdedit /set {bootmgr} timeout 2'. Only visible when more than one operating system is installed.",
    settings: ["Boot store {bootmgr}: timeout = 2 (bcdedit)"],
    prerequisites: [
      ...machine,
      "The boot store can be read (BIOS/UEFI Windows boot)",
    ],
    restart: "reboot",
    rollback: exact(
      "Writes the original timeout back with bcdedit, or deletes the element when it was absent." +
        hklmNote,
    ),
  }),
  adv({
    id: "boot-menu-legacy",
    name: "Legacy boot menu (F8 options)",
    category: "Storage & Boot",
    risk: "Moderate",
    impact: "Startup recovery options",
    description:
      "Brings back the F8 Advanced Boot Options menu, including Safe Mode.",
    reason:
      "Sets bootmenupolicy to Legacy (Microsoft documents Legacy and Standard). Fast SSD startups may leave too little time to press F8.",
    settings: ["Boot store {current}: bootmenupolicy = legacy (bcdedit)"],
    restart: "reboot",
    rollback: exact(
      "Writes the original policy back with bcdedit, or deletes the element when it was absent." +
        hklmNote,
    ),
  }),
  adv({
    id: "boot-logo-off",
    name: "Hide the Windows boot logo",
    category: "Storage & Boot",
    risk: "Moderate",
    impact: "Startup screen",
    description:
      "Replaces the Windows logo and spinner at startup with a plain screen. Boot time does not change.",
    reason:
      "Sets quietboot on. Microsoft notes that quiet boot can hide boot error information (bug check data), which makes startup problems harder to diagnose.",
    settings: ["Boot store {current}: quietboot = on (bcdedit)"],
    restart: "reboot",
    rollback: exact(
      "Writes the original value back with bcdedit, or deletes the element when it was absent." +
        hklmNote,
    ),
  }),

  // ---- Security trade-offs: every one lowers protection ----------------------------------------------
  sec({
    id: "defender-off",
    name: "Turn off Microsoft Defender Antivirus",
    impact: "Malware protection",
    description:
      "Writes the Defender policies for turning off the antivirus and real-time protection. The effect is not guaranteed: current Defender platforms ignore DisableAntiSpyware, and real-time protection can stay on.",
    reason:
      "Documented Defender policies DisableAntiSpyware and DisableRealtimeMonitoring; only the real-time monitoring policy matters on current Windows, and Tamper Protection must be off. Frameforge confirms that the policy values were written and shows what Defender itself reports before and after (read-only); it does not confirm that Defender is actually off. Check Windows Security afterwards.",
    consequence:
      "Your PC will no longer be protected from viruses and ransomware by Windows. Only do this if another antivirus replaces it.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender: DisableAntiSpyware = 1",
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Real-Time Protection: DisableRealtimeMonitoring = 1",
    ],
    prerequisites: [
      ...machine,
      "Tamper Protection is off (Frameforge only reads it and never bypasses it)",
    ],
    restart: "reboot",
    rollback: exact(hklmNote.trim()),
    settingsPage: "defender",
  }),
  sec({
    id: "mitigations-off",
    name: "Turn off CPU security mitigations",
    impact: "Spectre/Meltdown protection",
    description:
      "Disables the Spectre variant 2 and Meltdown mitigations in the kernel.",
    reason:
      "Microsoft's documented registry override (KB4072698). The speed change varies by CPU and is not claimed.",
    consequence:
      "Malicious code on this PC could read memory it should not see, such as passwords. The risk is highest for browsers and virtual machines.",
    settings: [
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management: FeatureSettingsOverride = 3, FeatureSettingsOverrideMask = 3 (DWORD)",
    ],
    restart: "reboot",
    rollback: exact(hklmNote.trim()),
  }),
  sec({
    id: "vbs-hyperv-off",
    name: "Turn off VBS, Memory integrity and the hypervisor",
    impact: "Virtualization-based security",
    description:
      "Turns off virtualization-based security and the Hyper-V hypervisor launch.",
    reason:
      "DeviceGuard policy keys plus bcdedit hypervisorlaunchtype off. Windows may keep it on if it is locked by UEFI. Frameforge re-reads the registry values when it opens or refreshes and flags a change, but it does not confirm from here that VBS or the hypervisor is really off; check Windows Security > Device security after restarting. Hyper-V, WSL 2 and Windows Sandbox stop working.",
    consequence:
      "Removes a layer that blocks kernel-level malware and vulnerable drivers. Virtual machines using Hyper-V, WSL 2 and Windows Sandbox will not start.",
    settings: [
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard: EnableVirtualizationBasedSecurity = 0",
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity: Enabled = 0",
      "Boot store {current}: hypervisorlaunchtype = off (bcdedit)",
    ],
    restart: "reboot",
    rollback: exact(hklmNote.trim()),
  }),
  sec({
    id: "uac-off",
    name: "Turn off User Account Control",
    impact: "Admin prompts",
    description:
      "Sets EnableLUA to 0 so Windows stops asking before admin tasks.",
    reason:
      "Documented policy. Microsoft Store apps and some built-in apps stop working while it is off.",
    consequence:
      "Any program you run gets full administrator power without asking. Malware needs no prompt to change Windows.",
    settings: [
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System: EnableLUA = 0 (DWORD)",
    ],
    restart: "reboot",
    rollback: exact(hklmNote.trim()),
  }),
  sec({
    id: "smartscreen-off",
    name: "Turn off Windows SmartScreen",
    impact: "Download and site protection",
    description: "Policy that turns off SmartScreen checks for files and apps.",
    reason: "Documented policy 'Configure Windows Defender SmartScreen'.",
    consequence:
      "Windows will no longer warn you about dangerous downloads or unrecognised apps.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System: EnableSmartScreen = 0 (DWORD)",
    ],
    rollback: exact(hklmNote.trim()),
  }),
  sec({
    id: "windows-updates-off",
    name: "Turn off automatic Windows updates",
    impact: "Security updates",
    description: "Policy that stops Windows installing updates automatically.",
    reason: "Documented Windows Update policy NoAutoUpdate.",
    consequence:
      "Security fixes will not install unless you update by hand, so known holes stay open.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU: NoAutoUpdate = 1 (DWORD)",
    ],
    rollback: exact(hklmNote.trim()),
  }),
  sec({
    id: "driver-updates-off",
    name: "Stop Windows installing driver updates",
    impact: "Driver updates",
    description: "Policy that keeps drivers out of Windows quality updates.",
    reason: "Documented policy ExcludeWUDriversInQualityUpdate.",
    consequence:
      "Driver security and stability fixes from Windows Update are skipped; you must update drivers yourself.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate: ExcludeWUDriversInQualityUpdate = 1 (DWORD)",
    ],
    rollback: exact(hklmNote.trim()),
  }),
  sec({
    id: "browser-updates-off",
    name: "Stop Edge and Chrome updating",
    impact: "Browser security updates",
    description: "Policy that disables automatic updates for Edge and Chrome.",
    reason:
      "Documented Microsoft Edge Update and Google Update policy UpdateDefault = 0.",
    consequence:
      "Browser security fixes are not installed, and browsers are the most attacked software on a PC.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\EdgeUpdate: UpdateDefault = 0 (DWORD)",
      "HKLM\\SOFTWARE\\Policies\\Google\\Update: UpdateDefault = 0 (DWORD)",
    ],
    rollback: exact(hklmNote.trim()),
  }),
  sec({
    id: "security-questions-off",
    name: "Turn off local-account security questions",
    impact: "Account recovery",
    description:
      "Policy that stops Windows offering security questions for local-account password reset.",
    reason:
      "Documented policy 'Prevent the use of security questions for local accounts'. You must have another way to recover the account.",
    consequence:
      "If you forget a local account's password and have no other recovery method, you may lose access to the account.",
    settings: [
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System: NoLocalPasswordResetQuestions = 1 (DWORD)",
    ],
    rollback: exact(hklmNote.trim()),
  }),
  sec({
    id: "ucpd-off",
    name: "Turn off the User Choice Protection Driver",
    impact: "Default app protection",
    description:
      "Sets the UCPD driver's start type to disabled so other tools can change default apps and file associations.",
    reason:
      "The driver's service Start value is 4 (disabled). Windows may re-enable it through a scheduled task. Frameforge re-reads the Start value when it opens or refreshes and flags a change, but it does not check the driver itself.",
    consequence:
      "Malware could change your default browser or file associations without your knowledge.",
    settings: [
      "HKLM\\SYSTEM\\CurrentControlSet\\Services\\UCPD: Start = 4 (DWORD)",
    ],
    restart: "reboot",
    rollback: exact(hklmNote.trim()),
  }),
  sec({
    id: "win11-checks-bypass",
    name: "Allow Windows 11 on unsupported hardware",
    impact: "Setup requirements",
    description:
      "Lets Windows 11 upgrades run on a PC with an unsupported TPM or CPU.",
    reason:
      "Microsoft's documented MoSetup value AllowUpgradesWithUnsupportedTPMOrCPU. Has no effect on a PC that already meets the requirements.",
    consequence:
      "Microsoft does not support this setup: updates are not guaranteed and drivers may be missing.",
    settings: [
      "HKLM\\SYSTEM\\Setup\\MoSetup: AllowUpgradesWithUnsupportedTPMOrCPU = 1 (DWORD)",
    ],
    rollback: exact(hklmNote.trim()),
  }),
];

/** Ids that lower security: never in a preset, never selectable for a custom preset. */
export const securityIds: OperationId[] = catalogue
  .filter((o) => o.tier === "security")
  .map((o) => o.id);
/** Ids that need a Windows administrator prompt. */
export const adminIds: OperationId[] = catalogue
  .filter((o) => o.admin)
  .map((o) => o.id);
/** Ids whose boot-store values can only be read with administrator rights. */
export const bootStoreIds: OperationId[] = catalogue
  .filter((o) => o.settings.some((s) => s.startsWith("Boot store")))
  .map((o) => o.id);
/** Ids Frameforge can apply, preview and roll back. */
export const applicableIds: OperationId[] = catalogue
  .filter((o) => o.supported)
  .map((o) => o.id);

export const unavailable: Unavailable[] = [
  {
    name: "Optimize NVIDIA Performance",
    group: "FPS & Latency",
    status: "info-only",
    reason:
      "NVIDIA driver profile settings have no documented registry interface.",
  },
  {
    name: "Optimize Device Affinities",
    group: "FPS & Latency",
    status: "info-only",
    reason:
      "Per-device interrupt affinity can leave a device without interrupts and has no measured benefit.",
  },
  {
    name: "Optimize Integrated Intel GPU",
    group: "FPS & Latency",
    status: "info-only",
    reason: "Vendor driver settings; no documented keys.",
  },
  {
    name: "Optimize Message Signal Interrupts",
    group: "FPS & Latency",
    status: "info-only",
    reason:
      "MSI changes can make a device unbootable, and no benefit is documented.",
  },
  {
    name: "Optimize Network Performance",
    group: "FPS & Latency",
    status: "info-only",
    reason:
      "Nagle, throttling and QoS tweaks are placebo or harmful (see research); adapter advanced properties cannot be captured and verified safely without administrator access.",
  },
  {
    name: "Disable Large Send Offloads",
    group: "FPS & Latency",
    status: "info-only",
    reason:
      "An adapter-driver property that needs an adapter restart; not verifiable here.",
  },
  {
    name: "Optimize Storage & Memory",
    group: "FPS & Latency",
    status: "info-only",
    reason:
      "Windows already manages these values; no measured benefit on SSDs.",
  },
  {
    name: "Enable Old NVIDIA Sharpening",
    group: "FPS & Latency",
    status: "info-only",
    reason:
      "No documented registry key; requires an NVIDIA GPU and verification.",
  },
  {
    name: "Enhance NVIDIA Privacy / Disable NVIDIA Telemetry",
    group: "Privacy",
    status: "info-only",
    reason:
      "No documented keys; the telemetry service is not present on current drivers.",
  },
  {
    name: "Disable Dynamic Interrupt Steering",
    group: "FPS & Latency",
    status: "info-only",
    reason: "The exact kernel value is not documented.",
  },
  {
    name: "Enable Modern Windows Memory Management",
    group: "FPS & Latency",
    status: "info-only",
    reason:
      "The original description is incomplete, so the change cannot be defined.",
  },
  {
    name: "Disable Windows Services",
    group: "FPS & Latency",
    status: "not-offered",
    reason:
      "Permanent service disabling can break Windows; Game Mode pauses only an allowlist temporarily.",
  },
  {
    name: "Disable Superfetch (SysMain)",
    group: "FPS & Latency",
    status: "not-offered",
    reason: "Research rejects a permanent disable; evidence is mixed.",
  },
  {
    name: "Optimize SMB",
    group: "Privacy",
    status: "info-only",
    reason:
      "The exact change is not defined; SMB1 is already absent on current Windows.",
  },
  {
    name: "Disable VPN Support",
    group: "Privacy",
    status: "info-only",
    reason:
      "No documented switch exists; [unverified] service changes would break other networking.",
  },
  {
    name: "Unlock EU Privacy Mode",
    group: "Privacy",
    status: "info-only",
    reason: "Region spoofing has no documented mechanism. [unverified]",
  },
  {
    name: "Disable Fax And Print",
    group: "Quality of Life",
    status: "info-only",
    reason:
      "Stopping the print spooler breaks printing; exact components are unclear.",
  },
  {
    name: "Disable Live Tiles",
    group: "Quality of Life",
    status: "info-only",
    reason: "Windows 11 has no live tiles.",
  },
  {
    name: "Optimize Context Menu",
    group: "Quality of Life",
    status: "info-only",
    reason:
      "Adds shell verbs that run takeown and icacls; not a single reversible value.",
  },
  {
    name: "Disable HomeGroup",
    group: "Quality of Life",
    status: "info-only",
    reason: "HomeGroup was removed from Windows 10 version 1803.",
  },
  {
    name: "Disable Lock Power Option",
    group: "Quality of Life",
    status: "info-only",
    reason:
      "The setting could not be confirmed in documentation or on this PC. [unverified]",
  },
  {
    name: "Disable Lock Screen",
    group: "Quality of Life",
    status: "info-only",
    reason:
      "The policy only works on Enterprise and Education editions. [unverified]",
  },
  {
    name: "Disable My People",
    group: "Quality of Life",
    status: "info-only",
    reason: "My People was removed in Windows 11.",
  },
  {
    name: "Disable Touch Settings",
    group: "Quality of Life",
    status: "info-only",
    reason: "No documented switch. [unverified]",
  },
  {
    name: "Disable Windows Focus Assist",
    group: "Quality of Life",
    status: "info-only",
    reason: "Stored in an undocumented binary blob. [unverified]",
  },
  {
    name: "Disable Windows Mobility Center",
    group: "Quality of Life",
    status: "info-only",
    reason: "The policy path could not be confirmed. [unverified]",
  },
  {
    name: "Increase Taskbar Transparency",
    group: "Quality of Life",
    status: "info-only",
    reason: "Undocumented. [unverified]",
  },
  {
    name: "Show All Taskbar Tray Icons",
    group: "Quality of Life",
    status: "info-only",
    reason: "The EnableAutoTray value is ignored by Windows 11. [unverified]",
  },
  {
    name: "Disable Disk Quotas",
    group: "Storage & Boot",
    status: "info-only",
    reason: "Quotas are off by default and are set per volume.",
  },
  {
    name: "Enable Classic Windows Photo Viewer",
    group: "Quality of Life",
    status: "info-only",
    reason: "Needs default-app association changes that Windows protects.",
  },
  {
    name: "Install Process Explorer / Enhanced Registry Editor",
    group: "Quality of Life",
    status: "not-offered",
    reason:
      "Would download and install software; Frameforge does not install third-party tools.",
  },
  {
    name: "VALOFLANT promotion",
    group: "Quality of Life",
    status: "not-offered",
    reason: "A promotion, not a Windows optimization.",
  },
];

export const presets = [
  {
    name: "Beginner",
    description:
      "Start with one input preference and the accessibility pop-up shortcut.",
    ids: ["mouse-precision", "sticky-keys-shortcut-off"],
  },
  {
    name: "Recommended",
    description:
      "Consistent pointer movement, the High performance plan, fewer pop-ups and fewer ads.",
    ids: [
      "mouse-precision",
      "power-plan",
      "sticky-keys-shortcut-off",
      "reduce-ads",
    ],
  },
  {
    name: "Balanced",
    description:
      "Input consistency, capture preference and fewer ads. No power plan change.",
    ids: ["mouse-precision", "capture-off", "reduce-ads"],
  },
  {
    name: "Gaming",
    description:
      "Input, capture and power plan, plus no accessibility shortcuts opening over a game.",
    ids: [
      "mouse-precision",
      "capture-off",
      "power-plan",
      "sticky-keys-shortcut-off",
      "accessibility-shortcuts-off",
    ],
  },
] as const;

/** Preset names are unique, case-insensitively, across built-in and custom presets. */
export const presetNameTaken = (
  list: AppState["presets"],
  name: string,
  exceptId?: string,
) => {
  const key = name.trim().toLowerCase();
  return (
    presets.some((p) => p.name.toLowerCase() === key) ||
    list.some((p) => p.id !== exceptId && p.name.toLowerCase() === key)
  );
};
/** Saves a custom preset: updates in place when `id` is given, otherwise appends. Throws on a name clash or a security item. */
export function upsertPreset(
  list: AppState["presets"],
  input: { id?: string; name: string; ids: OperationId[] },
  newId: () => string,
): AppState["presets"] {
  const name = input.name.trim();
  if (presetNameTaken(list, name, input.id))
    throw new Error(
      `A preset named "${name}" already exists. Choose a different name.`,
    );
  if (input.ids.some((id) => securityIds.includes(id)))
    throw new Error(
      "Security trade-offs are never part of a preset. Apply them one at a time.",
    );
  if (!input.id) return [...list, { id: newId(), name, ids: input.ids }];
  if (!list.some((p) => p.id === input.id))
    throw new Error("Preset not found. It may have been removed.");
  return list.map((p) =>
    p.id === input.id ? { id: p.id, name, ids: input.ids } : p,
  );
}
