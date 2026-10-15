import { z } from "zod";

export const OperationId = z.enum([
  "mouse-precision",
  "capture-off",
  "power-plan",
  "hardware-scheduling",
  "transparency-off",
  "shortcut-suffix-off",
  "classic-context-menu",
  "explorer-compact-mode",
  "explorer-open-this-pc",
  "explorer-no-recent",
  "jpeg-wallpaper-quality",
  "sticky-keys-shortcut-off",
  "accessibility-shortcuts-off",
  "notifications-off",
  "action-center-off",
  "storage-sense-off",
  "lock-theme-icons",
  "clean-taskbar",
  "visual-effects-light",
  "reduce-ads",
  "search-web-off",
  "onedrive-startup-off",
  "browser-background-off",
  "browser-hwaccel-off",
  "lock-screen-blur-off",
  "insider-off",
  "verbose-boot-status",
  "onedrive-sync-policy-off",
  "telemetry-minimum",
  "harden-anonymous-access",
  "background-apps-off",
  "dlss-indicator",
  "hibernate-off",
  "boot-timeout-short",
  "boot-menu-legacy",
  "boot-logo-off",
  "defender-off",
  "mitigations-off",
  "vbs-hyperv-off",
  "uac-off",
  "smartscreen-off",
  "windows-updates-off",
  "driver-updates-off",
  "browser-updates-off",
  "security-questions-off",
  "ucpd-off",
  "win11-checks-bypass",
  "sysmain-off",
  "print-off",
  "svc-diagtrack-off",
  "svc-wsearch-off",
  "svc-maps-off",
  "svc-geolocation-off",
  "svc-errorreporting-off",
  "svc-phone-off",
  "svc-linktracking-off",
  "svc-retaildemo-off",
  "photo-viewer",
  "lso-off",
  "nvidia-performance",
  "mobility-center-off",
]);
export type OperationId = z.infer<typeof OperationId>;
const Id = z.string().uuid();
const Name = z.string().trim().min(1).max(80);
export const SettingsSchema = z
  .object({
    theme: z.enum(["dark", "light"]),
    startup: z.boolean(),
    notifications: z.boolean(),
    diagnostics: z.boolean(),
    /** Scan for installed games in the background at app start, at most once per interval. */
    autoScan: z.boolean().default(true),
    autoScanHours: z.number().int().min(1).max(720).default(24),
    /** Privacy: all opt-in. Missing means off; privacyAsked missing means the first-run dialog has not been answered. */
    updateCheck: z.boolean().optional(),
    updateAutoInstall: z.boolean().optional(),
    analytics: z.boolean().optional(),
    privacyAsked: z.boolean().optional(),
    /** Closing the window keeps Frameforge in the tray (window destroyed) so auto-boost keeps working. */
    keepRunning: z.boolean().default(true),
    /** Let auto-boost open a Windows administrator prompt in the background. Off: those steps are skipped. */
    autoBoostAdmin: z.boolean().default(false),
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;
export const GameSchema = z
  .object({
    id: Id,
    name: Name,
    path: z.string().max(2048),
    source: z.enum([
      "custom",
      "steam",
      "epic",
      "gog",
      "xbox",
      "msstore",
      "ea",
      "ubisoft",
      "battlenet",
      "riot",
      "rockstar",
      "itch",
      "registry",
      "folder",
    ]),
    executablePath: z.string().max(2048).nullable().default(null),
    /** @deprecated Legacy app-only profile; hidden in the UI, kept so old backups parse. */
    profile: z.enum(["balanced", "gaming", "quiet"]),
    notes: z.string().max(500),
    boostMode: z
      .enum([
        "global",
        "off",
        "balanced",
        "performance",
        "competitive",
        "custom",
        "smart",
      ])
      .default("global"),
    /** Auto-boost starts this game's mode when it launches (the global Auto-boost switch must be on too). Missing means on. */
    autoBoost: z.boolean().optional(),
    /** Per-game override of the background apps list (missing: the global list or the suggested set decides). */
    background: z.lazy(() => BackgroundListSchema).optional(),
  })
  .strict();
export type Game = z.infer<typeof GameSchema>;
export const sourceLabels: Record<Game["source"], string> = {
  custom: "Added manually",
  steam: "Steam",
  epic: "Epic Games",
  gog: "GOG",
  xbox: "Xbox app",
  msstore: "Microsoft Store",
  ea: "EA app",
  ubisoft: "Ubisoft Connect",
  battlenet: "Battle.net",
  riot: "Riot Games",
  rockstar: "Rockstar Games",
  itch: "itch.io",
  registry: "Other installed games",
  folder: "Chosen folder",
};
// GC-11 denylist, mirrored from the C# helper (the enforcement point) for UX.
export const protectedImages = new Set(
  "system registry smss csrss wininit winlogon services lsass lsaiso svchost fontdrvhost dwm explorer sihost ctfmon audiodg spoolsv searchhost startmenuexperiencehost shellexperiencehost textinputhost runtimebroker msmpeng nissrv securityhealthservice securityhealthsystray smartscreen easyanticheat easyanticheat_eos beservice vgc vgtray faceit faceitclient esportal gameguard xigncode nvcontainer nvdisplay.container amdrsserv atiesrxx atieclxx".split(
    " ",
  ),
);
export const isProtectedImage = (image: string) =>
  protectedImages.has(image.toLowerCase().replace(/\.exe$/, ""));
export const BackgroundListSchema = z
  .array(
    z
      .object({
        image: z
          .string()
          .regex(/^[\w .()-]{1,64}\.exe$/i)
          .refine(
            (image) => !isProtectedImage(image),
            "Protected system, security and anti-cheat processes cannot be changed.",
          ),
        action: z.enum(["lower", "suspend", "close"]),
      })
      .strict(),
  )
  .max(50);
export const MechanismId = z.enum([
  "gameMode",
  "priority",
  "affinity",
  "powerPlan",
  "lowerBackground",
  "suspendBackground",
  "closeBackground",
  "timerResolution",
  "standbyPurge",
  "pauseServices",
  "gameBarCapture",
  "smartCores",
  "coreParking",
  "powerThrottling",
  "gpuPriority",
]);
export type MechanismId = z.infer<typeof MechanismId>;
const mechanismFields = {
  gameMode: z.boolean(),
  priority: z.enum(["Normal", "AboveNormal", "High"]),
  affinity: z.array(z.number().int().min(0).max(255)).max(256).nullable(),
  powerPlan: z.boolean(),
  lowerBackground: z.boolean(),
  suspendBackground: z.boolean(),
  closeBackground: z.boolean(),
  timerResolution: z.boolean(),
  pauseServices: z.boolean(),
  gameBarCapture: z.boolean(),
  smartCores: z.boolean(),
  coreParking: z.boolean(),
  powerThrottling: z.boolean(),
  // Clears Windows' cached (standby) memory once at the start. Off in every preset.
  standbyPurge: z.boolean(),
  // Raises the game's GPU scheduling priority to High (never Realtime). Off in every preset.
  gpuPriority: z.boolean(),
};
export const CustomMechanismsSchema = z
  .object({
    ...mechanismFields,
    // Added after the first release; old saved configurations omit them, so each defaults to off (GC-4).
    pauseServices: mechanismFields.pauseServices.default(false),
    gameBarCapture: mechanismFields.gameBarCapture.default(false),
    smartCores: mechanismFields.smartCores.default(false),
    coreParking: mechanismFields.coreParking.default(false),
    powerThrottling: mechanismFields.powerThrottling.default(false),
    standbyPurge: mechanismFields.standbyPurge.default(false),
    gpuPriority: mechanismFields.gpuPriority.default(false),
  })
  .strict();
/** Enhancer toggles saved on top of the selected preset mode; a missing key means "the mode decides". */
export const MechanismOverridesSchema = z
  .object(mechanismFields)
  .partial()
  .strict();
export type MechanismOverrides = z.infer<typeof MechanismOverridesSchema>;
export type CustomMechanisms = z.infer<typeof CustomMechanismsSchema>;
const BoostModeSchema = z.enum([
  "off",
  "balanced",
  "performance",
  "competitive",
  "custom",
  "smart",
]);
export type BoostMode = z.infer<typeof BoostModeSchema>;
const noMechanisms: CustomMechanisms = {
  gameMode: false,
  priority: "Normal",
  affinity: null,
  powerPlan: false,
  lowerBackground: false,
  suspendBackground: false,
  closeBackground: false,
  timerResolution: false,
  pauseServices: false,
  gameBarCapture: false,
  smartCores: false,
  coreParking: false,
  powerThrottling: false,
  standbyPurge: false,
  gpuPriority: false,
};
// What each preset mode applies. Custom uses the saved toggles.
// Nothing that opens an administrator prompt (pauseServices) is in Balanced or Performance. GPU preference and fullscreen
// optimizations are per-game launch settings, not session mechanisms. smartCores is on in Performance and Competitive only
// where Windows has no Thread Director (Windows 10 hybrid CPUs); the helper keeps it off in presets on Windows 11, and it is
// always available in Custom.
export const modeMechanisms: Record<
  Exclude<BoostMode, "custom">,
  CustomMechanisms
> = {
  off: noMechanisms,
  // Smart picks its set per game after watching it (electron/smart.ts); this entry is only the starting point.
  smart: noMechanisms,
  balanced: {
    ...noMechanisms,
    gameMode: true,
    priority: "AboveNormal",
    gameBarCapture: true,
    powerThrottling: true,
  },
  performance: {
    ...noMechanisms,
    gameMode: true,
    priority: "High",
    powerPlan: true,
    lowerBackground: true,
    gameBarCapture: true,
    powerThrottling: true,
    smartCores: true,
  },
  competitive: {
    ...noMechanisms,
    gameMode: true,
    priority: "High",
    powerPlan: true,
    lowerBackground: true,
    suspendBackground: true,
    timerResolution: true,
    gameBarCapture: true,
    powerThrottling: true,
    smartCores: true,
    coreParking: true,
    pauseServices: true,
    gpuPriority: true,
  },
};
/** The set a mode really applies: Custom is its own toggles; presets get the saved enhancer overrides on top. */
export function effectiveMechanisms(
  config: Pick<BoosterConfig, "mode" | "custom" | "overrides">,
  mode: BoostMode = config.mode,
): CustomMechanisms {
  if (mode === "custom") return config.custom;
  if (mode === "off" || mode === "smart") return noMechanisms;
  return { ...modeMechanisms[mode], ...config.overrides };
}
export const BoosterConfigSchema = z
  .object({
    mode: BoostModeSchema.default("off"),
    autoBoost: z.boolean().default(false),
    custom: CustomMechanismsSchema.default(noMechanisms),
    overrides: MechanismOverridesSchema.default({}),
    background: BackgroundListSchema.default([]),
    /** True once the user has saved their own list (even an empty one); until then Smart mode uses the suggested apps. */
    backgroundChosen: z.boolean().optional(),
  })
  .strict();
export type BoosterConfig = z.infer<typeof BoosterConfigSchema>;
export const PresetSchema = z
  .object({ id: Id, name: Name, ids: z.array(OperationId).min(1).max(64) })
  .strict();
export const StateSchema = z
  .object({
    version: z.literal(1),
    settings: SettingsSchema,
    games: z.array(GameSchema).max(500),
    presets: z.array(PresetSchema).max(50),
    /** @deprecated Legacy app-only toggle; kept so old configuration parses. */
    gameMode: z.object({ gameId: Id.nullable(), active: z.boolean() }).strict(),
    booster: BoosterConfigSchema.default({
      mode: "off",
      autoBoost: false,
      custom: noMechanisms,
      overrides: {},
      background: [],
    }),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (new Set(state.games.map((g) => g.id)).size !== state.games.length)
      ctx.addIssue({ code: "custom", message: "Duplicate games" });
    if (new Set(state.presets.map((p) => p.id)).size !== state.presets.length)
      ctx.addIssue({ code: "custom", message: "Duplicate presets" });
    if (
      state.gameMode.active &&
      !state.games.some((g) => g.id === state.gameMode.gameId)
    )
      ctx.addIssue({ code: "custom", message: "Game Mode needs a game" });
  });
export type AppState = z.infer<typeof StateSchema>;
export const defaultState: AppState = {
  version: 1,
  settings: {
    theme: "dark",
    startup: false,
    notifications: true,
    diagnostics: false,
    autoScan: true,
    autoScanHours: 24,
    keepRunning: true,
    autoBoostAdmin: false,
  },
  games: [],
  presets: [],
  gameMode: { active: false, gameId: null },
  booster: {
    mode: "smart",
    autoBoost: false,
    custom: noMechanisms,
    overrides: {},
    background: [],
  },
};
export const Status = z.enum([
  "running",
  "success",
  "failed",
  "cancelled",
  "rolled-back",
  "recovery-needed",
]);
export const ActivitySchema = z
  .object({
    id: Id,
    label: z.string().max(160),
    at: z.string(),
    status: Status,
    message: z.string().max(1000),
    ids: z.array(OperationId),
    rollback: z.boolean(),
  })
  .strict();
export type Activity = z.infer<typeof ActivitySchema>;
export const BackupSchema = z
  .object({ id: Id, name: Name, at: z.string(), state: StateSchema })
  .strict();
export type Backup = z.infer<typeof BackupSchema>;
export const HardwareSchema = z
  .object({
    source: z.enum(["windows", "fallback", "demo"]),
    collectedAt: z.string(),
    cpu: z.string(),
    gpu: z.array(z.string()),
    memoryBytes: z.number().nonnegative(),
    freeMemoryBytes: z.number().nonnegative(),
    cores: z.number().nonnegative(),
    os: z.string(),
    drives: z.array(
      z.object({
        name: z.string(),
        totalBytes: z.number().nonnegative(),
        freeBytes: z.number().nonnegative(),
      }),
    ),
    displays: z.array(z.string()),
    drivers: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();
export type Hardware = z.infer<typeof HardwareSchema>;
export const PreviewSchema = z
  .object({
    token: Id,
    expiresAt: z.string(),
    ids: z.array(OperationId),
    changes: z.array(
      z.object({
        id: OperationId,
        setting: z.string(),
        before: z.string(),
        after: z.string(),
        /** The current value already equals the target: applying writes nothing for this row. */
        alreadySet: z.boolean().default(false),
      }),
    ),
    warnings: z.array(z.string()),
    /** Highest follow-up any selected item needs, so the dialog can say what to do after applying. */
    restart: z
      .enum([
        "none",
        "wallpaper",
        "browser",
        "signin",
        "explorer",
        "signout",
        "reboot",
      ])
      .default("none"),
    /** True when applying or rolling back shows a Windows administrator prompt. */
    admin: z.boolean().default(false),
    /** Selected items that lower security and need an explicit acknowledgement. */
    security: z.array(OperationId).default([]),
  })
  .strict();
export type Preview = z.infer<typeof PreviewSchema>;
export const ProcessTargetSchema = z
  .object({
    pid: z.number().int().positive(),
    startTime: z.string().min(1).max(80),
    executablePath: z.string().min(1).max(2048),
    name: z.string().max(160),
    priority: z.enum([
      "Normal",
      "AboveNormal",
      "BelowNormal",
      "High",
      "Idle",
      "RealTime",
    ]),
  })
  .strict();
export type ProcessTarget = z.infer<typeof ProcessTargetSchema>;
export const MechanismResultSchema = z
  .object({
    id: MechanismId,
    state: z.enum([
      "applied",
      "skipped",
      "unsupported",
      "unavailable",
      "failed",
      "reverted",
      "conflict",
      // Waiting for the user to answer a Windows administrator prompt; replaced by the final result.
      "pending",
    ]),
    detail: z.string().max(500),
    /** Stable kebab-case reason for service failures and skips. */
    code: z.string().max(40).optional(),
  })
  .strict();
export type MechanismResult = z.infer<typeof MechanismResultSchema>;
export const SampleSchema = z
  .object({
    at: z.string().max(80),
    systemCpuPercent: z.number().min(0).max(100),
    availableMemoryBytes: z.number().nonnegative(),
    gameWorkingSetBytes: z.number().nonnegative(),
  })
  .strict();
export type Sample = z.infer<typeof SampleSchema>;
/** What Smart mode decided for a session: the bottleneck, why, what it changed and what to do next. */
export const BottleneckKind = z.enum([
  "cpu-bound",
  "gpu-bound",
  "memory",
  "thermal",
  "frame-capped",
  "unknown",
]);
export type BottleneckKind = z.infer<typeof BottleneckKind>;
export const SmartFlag = z.enum([
  "memory-pressure",
  "background-load",
  "thermal-limited",
  "igpu-busy",
]);
export type SmartFlag = z.infer<typeof SmartFlag>;
export const SmartVerdictSchema = z
  .object({
    classification: BottleneckKind,
    flags: z.array(SmartFlag).max(4),
    reasons: z.array(z.string().max(300)).max(12),
    advice: z.array(z.string().max(300)).max(8),
    /** The single best next step in plain language. */
    nextAction: z.string().max(300),
    chosen: z.array(z.string().max(80)).max(20),
    profileUsed: z.boolean(),
  })
  .strict();
export type SmartVerdict = z.infer<typeof SmartVerdictSchema>;
export const BoostSessionSchema = z
  .object({
    id: Id,
    gameId: Id,
    mode: BoostModeSchema.default("custom"),
    target: ProcessTargetSchema,
    startedAt: z.string(),
    endedAt: z.string().nullable().default(null),
    status: z.enum([
      "preparing",
      "active",
      "restoring",
      "recovery-needed",
      "ended",
    ]),
    message: z.string().max(1000),
    mechanisms: z.array(MechanismResultSchema).max(400).default([]),
    samples: z.array(SampleSchema).max(200).default([]),
    // True when the session did not do what was asked (start failed, a report was rejected, a revert failed).
    failed: z.boolean().default(false),
    // True when the session ended abnormally (helper crash, rejected report, failed start), whatever else failed earlier.
    abnormal: z.boolean().default(false),
    /** Smart mode: the verdict and the actions it chose (missing for other modes). */
    smart: SmartVerdictSchema.optional(),
    /** Index in `mechanisms` where the end-of-session restore results begin (older rows lack it). */
    restoreFrom: z.number().int().nonnegative().optional(),
  })
  .strict();
export type BoostSession = z.infer<typeof BoostSessionSchema>;
export const CpuTopologySchema = z
  .object({
    /** Performance and efficiency cores report different efficiency classes. */
    hybrid: z.boolean(),
    performanceCores: z.number().int().nonnegative(),
    performanceThreads: z.number().int().nonnegative(),
    efficiencyCores: z.number().int().nonnegative(),
    efficiencyThreads: z.number().int().nonnegative(),
    dualCcdX3d: z.boolean(),
    /** A hybrid CPU on Windows 11: the hardware scheduler already places games on the performance cores. */
    threadDirector: z.boolean().default(false),
    summary: z.string().max(300),
  })
  .strict();
export type CpuTopology = z.infer<typeof CpuTopologySchema>;
export const BoostCapabilitiesSchema = z
  .object({
    logicalCpus: z.number().int().nonnegative(),
    topology: CpuTopologySchema.nullish(),
    mechanisms: z.array(
      z
        .object({
          id: MechanismId,
          available: z.boolean(),
          detail: z.string().max(500),
          // Already in effect on this PC (Game Mode on, performance plan active).
          active: z.boolean(),
          /** Stable reason for the display, for example "policy" when Windows policy already does the job. */
          code: z.string().max(40).optional(),
        })
        .strict(),
    ),
    /** Windows 11's machine-wide timer setting: whether this Windows has it and whether it is on. */
    timerGlobal: z
      .object({ eligible: z.boolean(), enabled: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();
export type BoostCapabilities = z.infer<typeof BoostCapabilitiesSchema>;
export const TimerStatusSchema = z
  .object({
    /** This Windows build (11) can use the setting at all. */
    eligible: z.boolean(),
    /** GlobalTimerResolutionRequests is on right now. */
    enabled: z.boolean(),
    /** Frameforge turned it on and holds the prior value, so it can turn it back. */
    ownedByFrameforge: z.boolean(),
    /** Turned on since the last Windows start; takes effect after a restart. */
    restartRequired: z.boolean(),
  })
  .strict();
export type TimerStatus = z.infer<typeof TimerStatusSchema>;
export const PowerPlanEntrySchema = z
  .object({ guid: Id, name: z.string().max(200), active: z.boolean() })
  .strict();
export type PowerPlanEntry = z.infer<typeof PowerPlanEntrySchema>;
const BoostStatusSchema = z
  .object({
    session: BoostSessionSchema.nullable(),
    capabilities: BoostCapabilitiesSchema,
    watching: z.boolean(),
    ownedPowerPlan: z.boolean(),
    /** Plans named exactly "Frameforge High performance" that Frameforge has not recorded as its own. */
    existingPlans: z.array(PowerPlanEntrySchema).default([]),
    timer: TimerStatusSchema.default({
      eligible: false,
      enabled: false,
      ownedByFrameforge: false,
      restartRequired: false,
    }),
  })
  .strict();
export const NetworkCheckSchema = z
  .object({
    host: z.string().max(253),
    address: z.string().max(80).nullable(),
    sent: z.number().int().nonnegative(),
    received: z.number().int().nonnegative(),
    lossPercent: z.number().min(0).max(100),
    minMs: z.number().nonnegative().nullable(),
    avgMs: z.number().nonnegative().nullable(),
    maxMs: z.number().nonnegative().nullable(),
    /** Mean absolute difference between consecutive round trips. */
    jitterMs: z.number().nonnegative().nullable(),
    samples: z.array(z.number().nonnegative().nullable()).max(50),
    message: z.string().max(500),
  })
  .strict();
export type NetworkCheck = z.infer<typeof NetworkCheckSchema>;
// Letters, digits, dots and hyphens, or an IPv4/IPv6 literal. The helper validates again.
export const NetworkHost = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|[0-9A-Fa-f:.]+)$/);
/** Per-game launch settings: Windows reads them when the game starts, so they are applied and reverted explicitly. */
export const LaunchSetting = z.enum([
  "gpuPreference",
  "fullscreenOptimizations",
]);
export type LaunchSetting = z.infer<typeof LaunchSetting>;
export const LaunchResultSchema = z
  .object({
    setting: LaunchSetting,
    exe: z.string().max(2048),
    state: z.enum([
      "ready",
      "already-set",
      "applied",
      "reverted",
      "conflict",
      "unsupported",
      "failed",
    ]),
    detail: z.string().max(500),
    current: z.string().max(2048).nullable(),
    after: z.string().max(2048).nullable(),
    existed: z.boolean(),
  })
  .strict();
export type LaunchResult = z.infer<typeof LaunchResultSchema>;
export const LaunchStatusSchema = z
  .object({
    gameId: Id,
    executable: z.string().max(2048).nullable(),
    settings: z.array(
      z
        .object({
          setting: LaunchSetting,
          state: z.enum([
            "ready",
            "already-set",
            "applied",
            "conflict",
            "recovery-needed",
            "unsupported",
            "failed",
          ]),
          detail: z.string().max(500),
          current: z.string().max(2048).nullable(),
          /** Frameforge changed it and holds the prior value, so Revert is offered. */
          canRevert: z.boolean(),
          appliedAt: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type LaunchStatus = z.infer<typeof LaunchStatusSchema>;
export const LaunchPreviewSchema = z
  .object({
    setting: LaunchSetting,
    action: z.enum(["apply", "revert"]),
    exe: z.string().max(2048),
    before: z.string().max(2048).nullable(),
    after: z.string().max(2048).nullable(),
    warning: z.string().max(500),
  })
  .strict();
export type LaunchPreview = z.infer<typeof LaunchPreviewSchema>;
export const RunningProcessSchema = z
  .object({
    image: z.string().max(260),
    pid: z.number().int().nonnegative(),
    protected: z.boolean(),
    /** Working set and CPU share, when the helper could read them. */
    workingSetBytes: z.number().int().nonnegative().optional(),
    cpuPercent: z.number().min(0).max(100).optional(),
    path: z.string().max(520).optional(),
  })
  .strict();
export type RunningProcess = z.infer<typeof RunningProcessSchema>;
export const RestorePointSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    description: z.string().max(256),
    createdAt: z.string(),
  })
  .strict();
export const RestorePointsSchema = z
  .object({
    points: z.array(RestorePointSchema),
    available: z.boolean(),
    message: z.string().max(1000),
    createdSequence: z.number().int().nonnegative().nullable(),
    /** True when the user declined the administrator prompt (not an error). */
    cancelled: z.boolean().optional(),
  })
  .strict();
export type RestorePoints = z.infer<typeof RestorePointsSchema>;
export const RestoreDescription = z
  .string()
  .trim()
  .regex(/^[\p{L}\p{N} ._()-]{1,64}$/u);
export const FrequencySchema = z
  .object({ existed: z.boolean(), minutes: z.number().int().nullable() })
  .strict();
export type Frequency = z.infer<typeof FrequencySchema>;
// Subset the helper reads; the app adds its own journal state.
export const HelperRestoreStatusSchema = z
  .object({
    protection: z.enum(["enabled", "disabled", "unknown"]),
    policyDisabled: z.boolean(),
    // DisableConfig policy: restore points still work, but System Protection cannot be turned on.
    configLocked: z.boolean(),
    frequency: FrequencySchema,
    elevated: z.boolean(),
    systemDrive: z.string().regex(/^[A-Z]:$/),
  })
  .strict();
export type HelperRestoreStatus = z.infer<typeof HelperRestoreStatusSchema>;
export const RestoreStatusSchema = HelperRestoreStatusSchema.extend({
  lastAppCreatedAt: z.string().nullable(),
  pendingFrequencyRecovery: z.boolean(),
  pendingCreation: z.boolean(),
  message: z.string().max(1000),
  // When an elevated per-drive check last confirmed the system drive; a past fact, not current state.
  systemDriveConfirmedAt: z.string().nullable().default(null),
}).strict();
export type RestoreStatus = z.infer<typeof RestoreStatusSchema>;
export const RestoreOutcome = z.enum([
  "created",
  "throttled",
  "protection-disabled",
  "policy-disabled",
  "elevation-cancelled",
  "failed",
  "pending",
]);
export const CreateRestorePointResultSchema = z
  .object({
    outcome: RestoreOutcome,
    point: RestorePointSchema.nullable(),
    lastPoint: RestorePointSchema.nullable(),
    message: z.string().max(1000),
  })
  .strict();
export type CreateRestorePointResult = z.infer<
  typeof CreateRestorePointResultSchema
>;
export const DetectionSchema = z
  .object({
    games: z.array(GameSchema).max(500),
    warnings: z.array(z.string().max(1000)),
    launchers: z.array(z.string().max(80)),
    perLauncher: z.array(
      z
        .object({
          launcher: z.string().max(80),
          found: z.number().int().nonnegative(),
          skipped: z.number().int().nonnegative(),
          status: z.enum(["scanned", "not-installed", "error"]),
        })
        .strict(),
    ),
  })
  .strict();
export type Detection = z.infer<typeof DetectionSchema>;
export const BootstrapSchema = z
  .object({
    state: StateSchema,
    hardware: HardwareSchema,
    activity: z.array(ActivitySchema),
    backups: z.array(BackupSchema),
    capabilities: z.array(OperationId),
    /** When this PC last started, so "pending restart" can be told from "restarted since". */
    bootedAt: z.string().default(""),
    /** Applied optimizations whose registry values no longer match what Frameforge wrote (re-read at start and Refresh). */
    drifted: z
      .array(z.object({ activityId: Id, ids: z.array(OperationId) }).strict())
      .default([]),
    startupSupported: z.boolean(),
    version: z.string(),
    mode: z.enum(["desktop", "demo"]),
    boost: z
      .object({
        session: BoostSessionSchema.nullable(),
        available: z.boolean(),
        watching: z.boolean(),
      })
      .strict(),
    /** Game scan status: a scan may already be running when the window loads. */
    scan: z
      .object({ running: z.boolean(), lastScanAt: z.string().nullable() })
      .strict()
      .default({ running: false, lastScanAt: null }),
    /** Games the user removed; scans skip them until restored. */
    removedGames: z
      .array(
        z
          .object({
            name: z.string().max(80),
            path: z.string().max(2048),
            source: GameSchema.shape.source,
          })
          .strict(),
      )
      .max(1000)
      .default([]),
  })
  .strict();
export type Bootstrap = z.infer<typeof BootstrapSchema>;
// ---- Monitor page (live system counters) and Game Monitor (FPS) ----
const Gauge = z.number().min(0).max(100);
const Count = z.number().int().nonnegative();
const ProcessUseSchema = z
  .object({
    name: z.string().max(64),
    count: Count,
    cpuPercent: Gauge,
    workingSetBytes: Count,
  })
  .strict();
/** One second of Windows performance counters, from the helper. Nothing here is stored. */
export const MonitorSampleSchema = z
  .object({
    at: z.string().max(40),
    counters: z.boolean(),
    cpu: z
      .object({
        total: Gauge,
        cores: z.array(Gauge).max(256),
        /** Windows' % Processor Performance: the current clock as a percent of base (above 100 while boosting). */
        performance: z.number().min(0).max(1000).nullable().optional(),
      })
      .strict(),
    memory: z.object({ totalBytes: Count, availableBytes: Count }).strict(),
    gpu: z
      .object({
        available: z.boolean(),
        detail: z.string().max(300).nullable(),
        adapters: z
          .array(
            z
              .object({
                id: z.string().max(64),
                engine3d: Gauge,
                compute: Gauge,
                copy: Gauge,
                video: Gauge,
                dedicatedBytes: Count,
                sharedBytes: Count,
              })
              .strict(),
          )
          .max(4),
      })
      .strict(),
    disks: z
      .array(
        z
          .object({
            name: z.string().max(80),
            readBytesPerSec: Count,
            writeBytesPerSec: Count,
            activePercent: Gauge,
          })
          .strict(),
      )
      .max(8),
    network: z
      .array(
        z
          .object({
            name: z.string().max(80),
            downBytesPerSec: Count,
            upBytesPerSec: Count,
            linkBitsPerSec: Count,
          })
          .strict(),
      )
      .max(4),
    processes: z
      .object({
        byCpu: z.array(ProcessUseSchema).max(8),
        byMemory: z.array(ProcessUseSchema).max(8),
      })
      .strict(),
    temperatures: z
      .object({
        gpu: z
          .array(
            z
              .object({
                name: z.string().max(80),
                celsius: z.number().min(0).max(150),
              })
              .strict(),
          )
          .max(4),
        cpuCelsius: z.number().min(0).max(150).nullable(),
        note: z.string().max(200).nullable(),
      })
      .strict(),
  })
  .strict();
export type MonitorSample = z.infer<typeof MonitorSampleSchema>;
/** Was Game Mode running for the game while it was measured? "mixed" when it started or stopped during the capture. */
export const FpsBoostSchema = z.enum(["on", "off", "mixed"]);
export const FpsSummarySchema = z
  .object({
    id: Id,
    gameId: Id,
    gameName: z.string().max(80),
    at: z.string().max(40),
    durationSeconds: Count,
    frames: Count,
    avgFps: z.number().nonnegative(),
    low1Fps: z.number().nonnegative().nullable(),
    boost: FpsBoostSchema,
    // Added with the benchmark report; saved summaries from earlier versions lack them.
    low01Fps: z.number().nonnegative().nullish(),
    /** Frame time at the 99th percentile, ms. */
    p99Ms: z.number().nonnegative().nullish(),
    stutters: Count.nullish(),
    /** Average of the game's CPU and GPU use over the capture. */
    cpuPercent: Gauge.nullish(),
    gpuPercent: Gauge.nullish(),
    /** Set when the capture was a timed benchmark run of this many seconds. */
    benchmarkSeconds: Count.nullish(),
  })
  .strict();
export type FpsSummary = z.infer<typeof FpsSummarySchema>;
export const FpsStatusSchema = z
  .object({
    state: z.enum(["idle", "starting", "capturing", "unavailable", "ended"]),
    gameId: Id.nullable(),
    gameName: z.string().max(80).nullable(),
    /** Why FPS is unavailable (declined, protected, not-running, ...) or a note while capturing (no-frames). */
    code: z.string().max(40).nullable(),
    detail: z.string().max(500),
    elapsedSeconds: Count,
    fps: z.number().nonnegative().nullable(),
    avgFps: z.number().nonnegative().nullable(),
    low1Fps: z.number().nonnegative().nullable(),
    frames: Count,
    frameTimes: z.array(z.number().min(0).max(5000)).max(240),
    fpsHistory: z.array(z.number().min(0).max(100000)).max(120),
    usage: z
      .object({
        cpuPercent: Gauge,
        workingSetBytes: Count,
        gpuPercent: Gauge.nullable(),
      })
      .strict()
      .nullable(),
    boost: FpsBoostSchema,
    /** Length of the timed benchmark run in progress or just ended; null for a free capture. */
    benchmarkSeconds: Count.nullish(),
    /** The saved summary once a capture ended and was long enough to keep. */
    saved: FpsSummarySchema.nullable(),
    /** Library games running now (refreshed by fpsStatus). */
    running: z.array(Id).max(500),
  })
  .strict();
export type FpsStatus = z.infer<typeof FpsStatusSchema>;
// One JSON line from `Frameforge.Windows.exe --fps`.
export const FpsEventSchema = z.union([
  z.object({ event: z.literal("approval") }).strict(),
  z.object({ event: z.literal("ready") }).strict(),
  z
    .object({
      event: z.literal("frames"),
      frameTimesMs: z.array(z.number().min(0).max(100000)).max(2000),
    })
    .strict(),
  z
    .object({
      event: z.literal("usage"),
      cpuPercent: Gauge,
      workingSetBytes: Count,
      gpuPercent: Gauge.nullable(),
    })
    .strict(),
  z
    .object({
      event: z.literal("unavailable"),
      code: z.string().max(40),
      detail: z.string().max(500),
    })
    .strict(),
  z.object({ event: z.literal("ended"), reason: z.string().max(40) }).strict(),
]);
export type FpsEvent = z.infer<typeof FpsEventSchema>;
export const SmartProfileSchema = z
  .object({
    gameId: Id,
    gameName: z.string().max(80),
    /** CPU, GPU, driver and RAM layout; a change re-runs the observation. */
    fingerprint: z.string().max(400),
    classification: BottleneckKind,
    flags: z.array(SmartFlag).max(4),
    mechanisms: CustomMechanismsSchema,
    background: BackgroundListSchema,
    reasons: z.array(z.string().max(300)).max(12),
    advice: z.array(z.string().max(300)).max(8),
    nextAction: z.string().max(300),
    at: z.string().max(40),
    sessions: z.number().int().nonnegative(),
  })
  .strict();
export type SmartProfile = z.infer<typeof SmartProfileSchema>;
export const SmartStatusSchema = z
  .object({
    observing: z
      .object({
        gameId: Id,
        gameName: z.string().max(80),
        elapsedSeconds: Count,
        totalSeconds: Count,
      })
      .strict()
      .nullable(),
    profiles: z.array(SmartProfileSchema).max(500),
    /** A game-like program that is not in the library yet; the user decides. */
    candidate: z
      .object({ name: z.string().max(80), path: z.string().max(2048) })
      .strict()
      .nullable(),
  })
  .strict();
export type SmartStatus = z.infer<typeof SmartStatusSchema>;
// ---- PC health ----
const Nullable = <T extends z.ZodType>(schema: T) => schema.nullable();
export const HealthFactsSchema = z
  .object({
    battery: z
      .object({
        present: z.boolean(),
        onAc: z.boolean(),
        saver: z.boolean(),
        percent: Nullable(Count),
      })
      .strict(),
    powerMode: z
      .object({
        overlay: z.string().max(40),
        planGuid: Nullable(z.string().max(60)),
        planName: Nullable(z.string().max(120)),
      })
      .strict(),
    gpus: z
      .array(
        z
          .object({
            name: z.string().max(120),
            vendor: z.string().max(20),
            driverVersion: Nullable(z.string().max(40)),
            driverDate: Nullable(z.string().max(12)),
            integrated: z.boolean(),
          })
          .strict(),
      )
      .max(8),
    gpuPreferences: z
      .array(
        z
          .object({
            gameId: Id,
            exe: z.string().max(260),
            preference: Nullable(z.string().max(20)),
          })
          .strict(),
      )
      .max(100),
    nvidia: Nullable(
      z
        .object({
          name: z.string().max(80),
          driverVersion: Nullable(z.string().max(40)),
          temperatureC: Nullable(z.number()),
          clockMHz: Nullable(z.number()),
          maxClockMHz: Nullable(z.number()),
          powerDrawW: Nullable(z.number()),
          powerLimitW: Nullable(z.number()),
          pState: Nullable(z.string().max(8)),
          throttleReasons: z.array(z.string().max(40)).max(8),
        })
        .strict(),
    ),
    display: Nullable(
      z
        .object({
          width: Count,
          height: Count,
          currentHz: Count,
          maxHz: Count,
        })
        .strict(),
    ),
    memory: z
      .object({
        totalBytes: Count,
        availableBytes: Count,
        usedPercent: Count,
        sticks: z
          .array(
            z
              .object({
                capacityBytes: Count,
                speedMTs: Nullable(Count),
                configuredMTs: Nullable(Count),
                bank: Nullable(z.string().max(60)),
                slot: Nullable(z.string().max(60)),
              })
              .strict(),
          )
          .max(16),
        slots: Nullable(Count),
      })
      .strict(),
    cpuName: z.string().max(120),
    cpuPerformancePercent: Nullable(z.number()),
    drives: z
      .array(
        z
          .object({
            name: z.string().max(8),
            totalBytes: Count,
            freeBytes: Count,
            system: z.boolean(),
            mediaType: z.string().max(10),
          })
          .strict(),
      )
      .max(26),
    gameMode: Nullable(z.boolean()),
    hags: Nullable(Count),
    vbs: Nullable(z.boolean()),
    hvci: Nullable(z.boolean()),
    pendingReboot: z.array(z.string().max(60)).max(5),
    startupApps: Count,
    overlays: z.array(z.string().max(60)).max(20),
    vendorApp: Nullable(z.string().max(60)),
    topRam: z.array(ProcessUseSchema).max(8),
    topCpu: z.array(ProcessUseSchema).max(8),
  })
  .strict();
export type HealthFacts = z.infer<typeof HealthFactsSchema>;
export const HealthStatus = z.enum(["good", "warn", "bad", "unknown"]);
export type HealthStatus = z.infer<typeof HealthStatus>;
export const healthSettingsPages = [
  "graphics",
  "startup",
  "network",
  "services",
  "defender",
  "power",
  "display",
  "windowsUpdate",
  "storage",
  "gameMode",
  "coreIsolation",
] as const;
export const HealthFixSchema = z.discriminatedUnion("kind", [
  // Opens the normal reviewed Apply flow for catalogue items (reversible from Restore & backups).
  z
    .object({
      kind: z.literal("optimization"),
      ids: z.array(OperationId).min(1).max(4),
      label: z.string().max(60),
    })
    .strict(),
  // Frameforge's own per-game launch setting (GPU preference), applied and reverted by Frameforge.
  z
    .object({
      kind: z.literal("launchSetting"),
      gameId: Id,
      setting: z.literal("gpuPreference"),
      label: z.string().max(60),
    })
    .strict(),
  z
    .object({
      kind: z.literal("settings"),
      page: z.enum(healthSettingsPages),
      label: z.string().max(60),
    })
    .strict(),
  z
    .object({
      kind: z.literal("navigate"),
      page: z.enum(["Game Mode", "Optimizations", "System", "Monitor"]),
      label: z.string().max(60),
    })
    .strict(),
]);
export type HealthFix = z.infer<typeof HealthFixSchema>;
export const HealthCheckSchema = z
  .object({
    id: z.string().max(40),
    title: z.string().max(80),
    status: HealthStatus,
    /** What the reading is, in a few words ("Plugged in", "1 of 2 memory slots used"). */
    summary: z.string().max(200),
    explanation: z.string().max(500),
    impact: z.string().max(400),
    /** A fix Frameforge can apply or open; null when the answer is advice or hardware. */
    fix: Nullable(HealthFixSchema),
    steps: z.array(z.string().max(240)).max(8),
    /** True for a finding that matters before anything else (battery, vendor mode). */
    top: z.boolean(),
  })
  .strict();
export type HealthCheck = z.infer<typeof HealthCheckSchema>;
export const HealthReportSchema = z
  .object({
    at: z.string().max(40),
    score: z.number().int().min(0).max(100),
    headline: z.string().max(200),
    checks: z.array(HealthCheckSchema).max(40),
    /** The ids of the (up to three) checks to look at first. */
    topIssues: z.array(z.string().max(40)).max(3),
  })
  .strict();
export type HealthReport = z.infer<typeof HealthReportSchema>;
/** Saved A/B benchmark: the timed runs it was made from. Results are always recomputed from the runs (shared/benchmark.ts). */
export const BenchReportSchema = z
  .object({
    id: Id,
    gameId: Id,
    gameName: z.string().max(80),
    at: z.string().max(40),
    runs: z.array(FpsSummarySchema).max(40),
  })
  .strict();
export type BenchReport = z.infer<typeof BenchReportSchema>;
export const BenchDataSchema = z
  .object({
    /** Timed runs of the current, unsaved set. */
    runs: z.array(FpsSummarySchema).max(40),
    reports: z.array(BenchReportSchema).max(20),
  })
  .strict();
export const CleanupIds = [
  "userTemp",
  "windowsTemp",
  "directxShaders",
  "nvidiaShaders",
  "amdShaders",
  "intelShaders",
] as const;
export const CleanupId = z.enum(CleanupIds);
export type CleanupId = z.infer<typeof CleanupId>;
export const CleanupPreviewSchema = z
  .object({
    categories: z
      .array(
        z
          .object({
            id: CleanupId,
            label: z.string().max(80),
            present: z.boolean(),
            /** Needs Frameforge to run as administrator; it is not, so nothing was measured and nothing will be deleted. */
            needsAdmin: z.boolean(),
            shader: z.boolean(),
            /** Only files older than this many hours are touched (0 = all files). */
            minAgeHours: Count,
            bytes: z.number().nonnegative().nullable(),
            files: Count,
            folders: z.array(z.string().max(500)).max(10),
          })
          .strict(),
      )
      .max(10),
    elevated: z.boolean(),
  })
  .strict();
export type CleanupPreview = z.infer<typeof CleanupPreviewSchema>;
export const CleanupResultSchema = z
  .object({
    categories: z
      .array(
        z
          .object({
            id: CleanupId,
            label: z.string().max(80),
            freedBytes: z.number().nonnegative(),
            deleted: Count,
            skipped: Count,
            note: z.string().max(200),
          })
          .strict(),
      )
      .max(10),
    freedBytes: z.number().nonnegative(),
    deleted: Count,
    skipped: Count,
  })
  .strict();
export type CleanupResult = z.infer<typeof CleanupResultSchema>;
export const DriverVendor = z.enum(["nvidia", "amd", "intel"]);
export type DriverVendor = z.infer<typeof DriverVendor>;
export const GpuDriversSchema = z
  .object({
    adapters: z
      .array(
        z
          .object({
            name: z.string().max(160),
            vendor: z.enum(["nvidia", "amd", "intel", "other"]),
            /** Windows' own version string, for example 32.0.15.6094. */
            driverVersion: z.string().max(40),
            /** The version the vendor shows (NVIDIA 560.94), when it can be told. */
            displayVersion: z.string().max(40).nullable(),
            /** yyyy-MM-dd */
            driverDate: z.string().max(10).nullable(),
          })
          .strict(),
      )
      .max(8),
    warnings: z.array(z.string().max(200)).max(5),
  })
  .strict();
export type GpuDrivers = z.infer<typeof GpuDriversSchema>;
const Empty = z.object({}).strict();
export const UpdateStatusSchema = z
  .object({
    state: z.enum([
      "unsupported",
      "idle",
      "checking",
      "none",
      "available",
      "downloading",
      "downloaded",
      "error",
    ]),
    current: z.string().max(40),
    version: z.string().max(40).nullable(),
    /** Plain text only (tags stripped in the main process); rendered as text, never as HTML. */
    notes: z.string().max(8000),
    percent: z.number().min(0).max(100),
    error: z.string().max(500),
    /** The user chose "Install when I quit" for the downloaded update. */
    installOnQuit: z.boolean(),
    /** False when this build has no Aptabase key: the analytics toggle shows "Not available in this build". */
    analyticsAvailable: z.boolean(),
  })
  .strict();
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
export const featurePages = [
  "Dashboard",
  "Optimizations",
  "Presets",
  "Game library",
  "Game Mode",
  "Restore & backups",
  "System",
  "Monitor",
  "Activity",
  "Settings",
  "Health Check",
] as const;
const Selection = z
  .object({
    ids: z
      .array(OperationId)
      .min(1)
      .max(64)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Duplicate operations",
      ),
  })
  .strict();
export const GameIconSchema = z
  .string()
  .startsWith("data:image/png;base64,")
  .max(300_000)
  .nullable();
export const RunningGamesSchema = z.array(
  z.object({ gameId: Id, target: ProcessTargetSchema }).strict(),
);
// "Approve admin once": the optional FrameforgeBroker service (see docs/SECURITY.md). "unsupported" outside the Windows desktop build.
export const BrokerStatusSchema = z
  .object({
    state: z.enum([
      "unsupported",
      "not-installed",
      "ready",
      "needs-update",
      "unhealthy",
    ]),
    message: z.string().max(500),
    version: z.string().max(40).nullable().optional(),
  })
  .strict();
export type BrokerStatus = z.infer<typeof BrokerStatusSchema>;
export const requests = {
  bootstrap: Empty,
  refresh: Empty,
  settings: SettingsSchema,
  preview: Selection,
  confirm: z
    .object({
      token: Id,
      confirmed: z.literal(true),
      // Optimizations that lower security must be named here; the engine refuses a confirm without them.
      acknowledged: z.array(OperationId).max(64).optional(),
    })
    .strict(),
  cancel: Empty,
  rollback: z.object({ id: Id, confirmed: z.literal(true) }).strict(),
  backup: z.object({ name: Name }).strict(),
  restore: z.object({ id: Id, confirmed: z.literal(true) }).strict(),
  addGame: Empty,
  detectGames: Empty,
  restoreStatus: Empty,
  scanFolder: z.object({ confirmed: z.literal(true) }).strict(),
  restorePoints: Empty,
  createRestorePoint: z
    .object({
      name: RestoreDescription,
      confirmed: z.literal(true),
      bypassThrottle: z.boolean().default(false),
    })
    .strict(),
  enableSystemProtection: z.object({ confirmed: z.literal(true) }).strict(),
  recoverRestoreFrequency: z.object({ confirmed: z.literal(true) }).strict(),
  openSystemRestore: Empty,
  boostStatus: Empty,
  boostConfig: BoosterConfigSchema,
  boostStart: z
    .object({
      gameId: Id,
      confirmed: z.literal(true),
      /** Do not run the steps that need administrator approval (services, standby list). */
      skipAdmin: z.boolean().optional(),
    })
    .strict(),
  boostStop: z.object({ confirmed: z.literal(true) }).strict(),
  boostRecover: z
    .object({ confirmed: z.literal(true), dismiss: z.boolean().optional() })
    .strict(),
  runningProcesses: Empty,
  // Icon of a running program, by image name; the main process finds the path from the last process list.
  appIcon: z
    .object({ image: z.string().regex(/^[\w .()-]{1,64}\.exe$/i) })
    .strict(),
  // Diagnostics only: pings the host; nothing on the PC is changed.
  networkCheck: z
    .object({
      host: NetworkHost,
      count: z.number().int().min(3).max(30).default(10),
    })
    .strict(),
  launchSettings: z.object({ gameId: Id }).strict(),
  launchSettingPreview: z
    .object({
      gameId: Id,
      setting: LaunchSetting,
      action: z.enum(["apply", "revert"]),
    })
    .strict(),
  // "forget" drops Frameforge's saved prior value without touching Windows (used after an outside change).
  launchSettingApply: z
    .object({
      gameId: Id,
      setting: LaunchSetting,
      action: z.enum(["apply", "revert", "forget"]),
      confirmed: z.literal(true),
    })
    .strict(),
  // Consent-gated: create (or remove) the Frameforge copy of Windows' High performance plan.
  boostPowerPlan: z
    .object({
      // list: refresh existingPlans; adopt: record an existing same-named plan as Frameforge's; removeDuplicate: delete one.
      action: z.enum(["create", "remove", "adopt", "removeDuplicate", "list"]),
      guid: Id.optional(),
      confirmed: z.literal(true),
    })
    .strict(),
  // Consent-gated: turn Windows 11's machine-wide timer setting on (needs a restart) or put the saved prior value back.
  boostTimerGlobal: z
    .object({
      action: z.enum(["enable", "restore"]),
      confirmed: z.literal(true),
    })
    .strict(),
  // Server-side allowlist; the renderer never sends a URI or path.
  openSettings: z
    .object({
      page: z.enum(healthSettingsPages),
    })
    .strict(),
  removeGame: z.object({ id: Id }).strict(),
  // Native file dialog, opened by the main process: picks the .exe of a library game that has none (launch settings need it).
  // pathConfirmed: the game has no known folder, so the user confirmed that the file they pick is the game's own.
  chooseExecutable: z
    .object({ id: Id, pathConfirmed: z.literal(true).optional() })
    .strict(),
  // The renderer sends only a library id; the main process resolves and validates every path.
  gameIcon: z.object({ id: Id }).strict(),
  // Puts a removed game back (by its install path) and forgets the removal.
  restoreGame: z.object({ path: z.string().min(1).max(2048) }).strict(),
  profile: z
    .object({
      id: Id,
      profile: GameSchema.shape.profile.optional(),
      boostMode: GameSchema.shape.boostMode,
      autoBoost: z.boolean().optional(),
      notes: GameSchema.shape.notes,
      /** Per-game background apps; null removes the override, missing leaves it as it is. */
      background: BackgroundListSchema.nullable().optional(),
    })
    .strict(),
  // With an id, the saved custom preset is updated in place; without, a new one is added.
  savePreset: z
    .object({ id: Id.optional(), name: Name, ids: Selection.shape.ids })
    .strict(),
  removePreset: z.object({ id: Id }).strict(),
  clearActivity: z.object({ confirmed: z.literal(true) }).strict(),
  updateStatus: Empty,
  updateCheck: Empty,
  updateDownload: Empty,
  updateInstall: z.object({ when: z.enum(["now", "onQuit"]) }).strict(),
  // Anonymous page-open event; ignored unless the user opted in.
  trackUsage: z
    .object({ event: z.literal("feature_opened"), page: z.enum(featurePages) })
    .strict(),
  // Ends this user's explorer.exe; Windows starts it again. Never called automatically.
  restartExplorer: z.object({ confirmed: z.literal(true) }).strict(),
  // Settings > Administrator access. Status is read-only (never prompts); install and remove each open one Windows prompt.
  brokerStatus: Empty,
  brokerInstall: z.object({ confirmed: z.literal(true) }).strict(),
  brokerRemove: z.object({ confirmed: z.literal(true) }).strict(),
  // Live counters, read once a second only while the Monitor page is visible; monitorStop ends the helper completely.
  monitorStart: Empty,
  monitorStop: Empty,
  // Game Monitor: FPS capture needs one Windows administrator prompt, so it only starts after an explicit click.
  fpsStatus: Empty,
  fpsStart: z
    .object({
      gameId: Id,
      confirmed: z.literal(true),
      /** A timed benchmark run: stops itself after this many seconds. */
      benchmarkSeconds: z.number().int().min(20).max(300).optional(),
    })
    .strict(),
  fpsStop: z.object({ confirmed: z.literal(true) }).strict(),
  fpsHistory: z.object({ gameId: Id }).strict(),
  // PC Health Check: read-only facts evaluated into checks (the page asks; nothing is polled).
  healthCheck: Empty,
  // Smart mode: observation state, learned per-game profiles and the new-game offer. add/dismiss answer the offer.
  smartStatus: Empty,
  smartCandidate: z.object({ action: z.enum(["add", "dismiss"]) }).strict(),
  smartForget: z.object({ gameId: Id }).strict(),
  // Benchmark report: timed runs of the current set plus saved reports; saving snapshots the runs and starts a new set.
  benchData: z.object({ gameId: Id }).strict(),
  benchSave: z.object({ gameId: Id }).strict(),
  benchDiscard: z.object({ gameId: Id, confirmed: z.literal(true) }).strict(),
  // The main process asks where to save; the renderer never sends a path.
  benchExport: z
    .object({ reportId: Id, format: z.enum(["md", "csv"]) })
    .strict(),
  // Finished and live boost sessions with what each mechanism did.
  boostHistory: z.object({ gameId: Id.optional() }).strict(),
  // Cleanup: preview reads sizes only. Run deletes the named categories' contents; paths are never sent.
  cleanupPreview: Empty,
  cleanupRun: z
    .object({
      ids: z.array(CleanupId).min(1).max(6),
      confirmed: z.literal(true),
    })
    .strict(),
  gpuDrivers: Empty,
  // Opens the vendor's official driver page (fixed list, chosen in the main process).
  openDriverPage: z.object({ vendor: DriverVendor }).strict(),
};
export const responses = {
  bootstrap: BootstrapSchema,
  refresh: HardwareSchema,
  settings: StateSchema,
  preview: PreviewSchema,
  confirm: ActivitySchema,
  cancel: z.boolean(),
  rollback: ActivitySchema,
  backup: BackupSchema,
  restore: StateSchema,
  addGame: GameSchema.nullable(),
  detectGames: DetectionSchema,
  restoreStatus: RestoreStatusSchema,
  scanFolder: DetectionSchema,
  restorePoints: RestorePointsSchema,
  createRestorePoint: CreateRestorePointResultSchema,
  enableSystemProtection: RestoreStatusSchema,
  recoverRestoreFrequency: RestoreStatusSchema,
  openSystemRestore: z.boolean(),
  boostStatus: BoostStatusSchema,
  boostConfig: StateSchema,
  openSettings: z.boolean(),
  restartExplorer: z.boolean(),
  brokerStatus: BrokerStatusSchema,
  brokerInstall: BrokerStatusSchema,
  brokerRemove: BrokerStatusSchema,
  boostStart: BoostSessionSchema,
  boostStop: BoostSessionSchema.nullable(),
  boostRecover: BoostSessionSchema.nullable(),
  runningProcesses: z.array(RunningProcessSchema).max(500),
  appIcon: z.string().max(400000).nullable(),
  networkCheck: NetworkCheckSchema,
  launchSettings: LaunchStatusSchema,
  launchSettingPreview: LaunchPreviewSchema,
  launchSettingApply: LaunchStatusSchema,
  boostPowerPlan: BoostStatusSchema,
  boostTimerGlobal: BoostStatusSchema,
  removeGame: StateSchema,
  chooseExecutable: GameSchema.nullable(),
  gameIcon: GameIconSchema,
  restoreGame: StateSchema,
  profile: StateSchema,
  savePreset: StateSchema,
  removePreset: StateSchema,
  clearActivity: z.boolean(),
  updateStatus: UpdateStatusSchema,
  updateCheck: UpdateStatusSchema,
  updateDownload: UpdateStatusSchema,
  updateInstall: UpdateStatusSchema,
  trackUsage: z.boolean(),
  monitorStart: z.boolean(),
  monitorStop: z.boolean(),
  fpsStatus: FpsStatusSchema,
  fpsStart: FpsStatusSchema,
  fpsStop: FpsStatusSchema,
  fpsHistory: z.array(FpsSummarySchema).max(50),
  healthCheck: HealthReportSchema,
  smartStatus: SmartStatusSchema,
  smartCandidate: SmartStatusSchema,
  smartForget: SmartStatusSchema,
  benchData: BenchDataSchema,
  benchSave: BenchDataSchema,
  benchDiscard: BenchDataSchema,
  benchExport: z.string().max(2048).nullable(),
  boostHistory: z.array(BoostSessionSchema).max(20),
  cleanupPreview: CleanupPreviewSchema,
  cleanupRun: CleanupResultSchema,
  gpuDrivers: GpuDriversSchema,
  openDriverPage: z.boolean(),
};
export type Method = keyof typeof requests;
export type Request<M extends Method> = z.infer<(typeof requests)[M]>;
export type Response<M extends Method> = z.infer<(typeof responses)[M]>;
export type Api = {
  [M in Method]: (request: Request<M>) => Promise<Response<M>>;
};
export const EventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("scan-progress"),
      launcher: z.string().max(80),
      done: z.number().int().nonnegative(),
      total: z.number().int().positive(),
      found: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ type: z.literal("boost"), session: BoostSessionSchema }).strict(),
  z.object({ type: z.literal("update"), status: UpdateStatusSchema }).strict(),
  // Saved state changed outside the window (tray menu): reload it.
  z.object({ type: z.literal("state") }).strict(),
  z
    .object({ type: z.literal("monitor"), sample: MonitorSampleSchema })
    .strict(),
  z.object({ type: z.literal("fps"), status: FpsStatusSchema }).strict(),
  // Smart mode started or finished observing a game, or found a game-like program that is not in the library.
  z.object({ type: z.literal("smart"), status: SmartStatusSchema }).strict(),
  // A whole-PC game scan began or ended; `added` is the number of new library games.
  z
    .object({
      type: z.literal("scan"),
      phase: z.enum(["started", "finished"]),
      auto: z.boolean(),
      added: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type AppEvent = z.infer<typeof EventSchema>;
// Session toggles that moved to per-game launch settings. Saved data from before that change may still carry them.
export const legacyMechanismIds: readonly string[] = [
  "gpuPreference",
  "fullscreenOptimizations",
];
/** Removes the retired session toggles from a saved state, backup or demo payload so it still parses. */
export function dropLegacyMechanisms<T>(value: T): T {
  const custom = (
    value as { booster?: { custom?: Record<string, unknown> } } | null
  )?.booster?.custom;
  if (custom && typeof custom === "object")
    for (const id of legacyMechanismIds) delete custom[id];
  return value;
}
export type FrameforgeApi = Api & {
  onEvent: (callback: (event: AppEvent) => void) => () => void;
};
export const Envelope = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: z.string(),
          message: z.string().max(1000),
          operationId: Id.optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const RegistryValueSchema = z
  .object({
    operation: OperationId,
    path: z.string(),
    name: z.string(),
    kind: z.enum(["String", "DWord"]),
    existed: z.boolean(),
    value: z.union([z.string().max(520), z.number().int(), z.null()]),
    /** What applying writes (null = the value is removed). Absent in snapshots saved before targets were recorded. */
    target: z
      .union([z.string().max(520), z.number().int(), z.null()])
      .optional(),
    /** Adapter name for items that act on network adapters found on this PC; shown instead of the registry path. */
    label: z.string().max(160).nullable().optional(),
    /** Key levels that were missing at capture; rollback removes exactly these. */
    created: z.number().int().min(0).max(16).nullable().optional(),
  })
  .strict();
// The built-in Windows plans, by GUID. The helper (BoostSession.cs) keeps the same list; a test compares the two.
export const builtInPowerPlans: Record<string, string> = {
  "381b4222-f694-41f0-9685-ff5bb260df2e": "Balanced",
  "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c": "High performance",
  "a1841308-3541-4fab-bc81-f71556f20b4a": "Power saver",
  "e9a42b02-d5df-448d-aa00-03f14749eb61": "Ultimate performance",
};
const PlanGuid = z
  .string()
  .regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
export const SnapshotSchema = z
  .object({
    values: z.array(RegistryValueSchema).max(64),
    // Prior active power scheme, present only when power-plan was captured.
    scheme: PlanGuid.optional(),
    // The performance plan the apply switches to (High performance, Ultimate, or the Frameforge copy).
    target: PlanGuid.optional(),
    // Display names read from Windows, so custom plans are not shown as a GUID.
    schemeName: z.string().max(120).optional(),
    targetName: z.string().max(120).optional(),
  })
  .strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const TimerGlobalResultSchema = z
  .object({
    state: z.enum([
      "ready",
      "applied",
      "reverted",
      "already-set",
      "conflict",
      "failed",
      "declined",
      "timeout",
      "expired",
    ]),
    detail: z.string().max(500),
    existed: z.boolean(),
    value: z.number().int().nullable(),
  })
  .strict();
export type TimerGlobalResult = z.infer<typeof TimerGlobalResultSchema>;
export const ForegroundAppSchema = z
  .object({
    pid: z.number().int().positive(),
    image: z.string().max(260),
    path: z.string().max(2048),
    startTime: z.string().max(80),
    fullscreen: z.boolean(),
  })
  .strict();
export type ForegroundApp = z.infer<typeof ForegroundAppSchema>;
export const HelperResult = z
  .object({
    ok: z.boolean(),
    message: z.string().max(1000),
    code: z.string().max(80).optional(),
    hardware: HardwareSchema.optional(),
    snapshot: SnapshotSchema.optional(),
    verified: z.boolean().nullable().optional(),
    supported: z.array(z.string().max(64)).max(200).optional(),
    drifted: z.array(z.string().max(64)).max(200).optional(),
    restorePoints: z.array(RestorePointSchema).optional(),
    createdSequence: z.number().int().nonnegative().nullable().optional(),
    available: z.boolean().optional(),
    restoreStatus: HelperRestoreStatusSchema.optional(),
    outcome: RestoreOutcome.optional(),
    point: RestorePointSchema.optional(),
    lastPoint: RestorePointSchema.optional(),
    frequencyRestored: z.boolean().optional(),
    resultPath: z.string().max(2048).optional(),
    runningGames: RunningGamesSchema.optional(),
    backgroundProcesses: z.array(RunningProcessSchema).optional(),
    health: HealthFactsSchema.optional(),
    foreground: ForegroundAppSchema.nullable().optional(),
    capabilities: BoostCapabilitiesSchema.optional(),
    network: NetworkCheckSchema.optional(),
    cleanup: z.union([CleanupPreviewSchema, CleanupResultSchema]).optional(),
    gpuDrivers: GpuDriversSchema.optional(),
    launch: LaunchResultSchema.optional(),
    timerGlobal: TimerGlobalResultSchema.optional(),
    reverts: z.array(MechanismResultSchema).optional(),
    powerPlan: Id.optional(),
    powerPlans: z.array(PowerPlanEntrySchema).max(200).optional(),
    driveCoverage: z.enum(["confirmed", "off", "unknown"]).optional(),
    broker: BrokerStatusSchema.optional(),
  })
  .strict();
export const CapturedRegValueSchema = z
  .object({
    path: z.string().max(260),
    name: z.string().max(2048),
    kind: z.enum(["String", "DWord"]),
    existed: z.boolean(),
    value: z.union([z.string().max(2048), z.number().int(), z.null()]),
    applied: z.union([z.string().max(2048), z.number().int()]),
  })
  .strict();
export type CapturedRegValue = z.infer<typeof CapturedRegValueSchema>;
// A prior state saved by the session helper before each change (GC-10).
export const CapturedSchema = z
  .object({
    mechanism: MechanismId,
    process: ProcessTargetSchema.optional(),
    prior: z.string().max(80).optional(),
    applied: z.string().max(80).optional(),
    registry: z
      .object({
        values: z
          .array(
            RegistryValueSchema.extend({ operation: z.literal("game-mode") }),
          )
          .min(1)
          .max(2),
      })
      .strict()
      .optional(),
    /** Power scheme and setting changed by coreParking (prior/applied hold the percentages). */
    scheme: PlanGuid.optional(),
    setting: z.enum(["cpmincores", "cpmincores1", "usbsuspend"]).optional(),
    /** Prior and applied lists: paused service names, or CPU set ids (smartCores). */
    items: z.array(z.string().max(64)).max(256).optional(),
    appliedItems: z.array(z.string().max(64)).max(256).optional(),
    /** Current-user registry values written by gameBarCapture. */
    regValues: z.array(CapturedRegValueSchema).min(1).max(8).optional(),
  })
  .strict();
export type Captured = z.infer<typeof CapturedSchema>;
// One JSON line from `Frameforge.Windows.exe --session`.
export const SessionEventSchema = z.union([
  z
    .object({
      event: z.literal("captured"),
      mechanism: MechanismId,
      prior: CapturedSchema,
    })
    .strict(),
  // The change for this capture never happened (for example the suspend call failed): drop it from the saved state.
  z
    .object({
      event: z.literal("released"),
      mechanism: MechanismId,
      prior: CapturedSchema,
    })
    .strict(),
  z
    .object({
      event: z.enum([
        "applied",
        "skipped",
        "unsupported",
        "unavailable",
        "failed",
        "pending",
      ]),
      mechanism: MechanismId,
      detail: z.string().max(500),
      code: z.string().max(40).optional(),
    })
    .strict(),
  z.object({ event: z.literal("ready") }).strict(),
  // The helper starts reverting on its own (for example the game exited).
  z
    .object({
      event: z.literal("ending"),
      reason: z.enum([
        "game-exited",
        "stop",
        "parent-exited",
        "stdin-closed",
        "start-failed",
      ]),
    })
    .strict(),
  SampleSchema.extend({ event: z.literal("sample") }).strict(),
  z
    .object({
      event: z.literal("ended"),
      reason: z.enum([
        "game-exited",
        "stop",
        "parent-exited",
        "stdin-closed",
        "start-failed",
      ]),
      detail: z.string().max(1000).optional(),
      reverts: z.array(MechanismResultSchema).max(400),
    })
    .strict(),
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;
