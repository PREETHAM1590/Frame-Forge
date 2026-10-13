import { z } from "zod";

export const OperationId = z.enum([
  "mouse-precision",
  "capture-off",
  "power-plan",
  "hardware-scheduling",
  "startup-review",
  "driver-review",
  "dns-tuning",
  "service-tuning",
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
      ])
      .default("global"),
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
]);
export type MechanismId = z.infer<typeof MechanismId>;
export const CustomMechanismsSchema = z
  .object({
    gameMode: z.boolean(),
    priority: z.enum(["Normal", "AboveNormal", "High"]),
    affinity: z.array(z.number().int().min(0).max(255)).max(256).nullable(),
    powerPlan: z.boolean(),
    lowerBackground: z.boolean(),
    suspendBackground: z.boolean(),
    closeBackground: z.boolean(),
    timerResolution: z.boolean(),
    // Added with the second booster pass; old saved configurations omit them, so each defaults to off (GC-4).
    pauseServices: z.boolean().default(false),
    gameBarCapture: z.boolean().default(false),
    smartCores: z.boolean().default(false),
    coreParking: z.boolean().default(false),
    powerThrottling: z.boolean().default(false),
  })
  .strict();
export type CustomMechanisms = z.infer<typeof CustomMechanismsSchema>;
const BoostModeSchema = z.enum([
  "off",
  "balanced",
  "performance",
  "competitive",
  "custom",
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
  },
};
export const BoosterConfigSchema = z
  .object({
    mode: BoostModeSchema.default("off"),
    autoBoost: z.boolean().default(false),
    custom: CustomMechanismsSchema.default(noMechanisms),
    background: z
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
      .max(50)
      .default([]),
  })
  .strict();
export type BoosterConfig = z.infer<typeof BoosterConfigSchema>;
export const PresetSchema = z
  .object({ id: Id, name: Name, ids: z.array(OperationId).min(1).max(8) })
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
  },
  games: [],
  presets: [],
  gameMode: { active: false, gameId: null },
  booster: {
    mode: "off",
    autoBoost: false,
    custom: noMechanisms,
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
      }),
    ),
    warnings: z.array(z.string()),
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
        })
        .strict(),
    ),
  })
  .strict();
export type BoostCapabilities = z.infer<typeof BoostCapabilitiesSchema>;
const BoostStatusSchema = z
  .object({
    session: BoostSessionSchema.nullable(),
    capabilities: BoostCapabilitiesSchema,
    watching: z.boolean(),
    ownedPowerPlan: z.boolean(),
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
const Empty = z.object({}).strict();
const Selection = z
  .object({
    ids: z
      .array(OperationId)
      .min(1)
      .max(8)
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
export const requests = {
  bootstrap: Empty,
  refresh: Empty,
  settings: SettingsSchema,
  preview: Selection,
  confirm: z.object({ token: Id, confirmed: z.literal(true) }).strict(),
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
  boostStart: z.object({ gameId: Id, confirmed: z.literal(true) }).strict(),
  boostStop: z.object({ confirmed: z.literal(true) }).strict(),
  boostRecover: z
    .object({ confirmed: z.literal(true), dismiss: z.boolean().optional() })
    .strict(),
  runningProcesses: Empty,
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
      action: z.enum(["create", "remove"]),
      confirmed: z.literal(true),
    })
    .strict(),
  // Server-side allowlist; the renderer never sends a URI or path.
  openSettings: z
    .object({ page: z.enum(["graphics", "startup", "network", "services"]) })
    .strict(),
  removeGame: z.object({ id: Id }).strict(),
  // The renderer sends only a library id; the main process resolves and validates every path.
  gameIcon: z.object({ id: Id }).strict(),
  // Puts a removed game back (by its install path) and forgets the removal.
  restoreGame: z.object({ path: z.string().min(1).max(2048) }).strict(),
  profile: z
    .object({
      id: Id,
      profile: GameSchema.shape.profile.optional(),
      boostMode: GameSchema.shape.boostMode,
      notes: GameSchema.shape.notes,
    })
    .strict(),
  // With an id, the saved custom preset is updated in place; without, a new one is added.
  savePreset: z
    .object({ id: Id.optional(), name: Name, ids: Selection.shape.ids })
    .strict(),
  removePreset: z.object({ id: Id }).strict(),
  clearActivity: z.object({ confirmed: z.literal(true) }).strict(),
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
  boostStart: BoostSessionSchema,
  boostStop: BoostSessionSchema.nullable(),
  boostRecover: BoostSessionSchema.nullable(),
  runningProcesses: z.array(RunningProcessSchema).max(500),
  networkCheck: NetworkCheckSchema,
  launchSettings: LaunchStatusSchema,
  launchSettingPreview: LaunchPreviewSchema,
  launchSettingApply: LaunchStatusSchema,
  boostPowerPlan: BoostStatusSchema,
  removeGame: StateSchema,
  gameIcon: GameIconSchema,
  restoreGame: StateSchema,
  profile: StateSchema,
  savePreset: StateSchema,
  removePreset: StateSchema,
  clearActivity: z.boolean(),
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
    value: z.union([z.string().max(100), z.number().int(), z.null()]),
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
    values: z.array(RegistryValueSchema).max(4),
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
export const HelperResult = z
  .object({
    ok: z.boolean(),
    message: z.string().max(1000),
    code: z.string().max(80).optional(),
    hardware: HardwareSchema.optional(),
    snapshot: SnapshotSchema.optional(),
    verified: z.boolean().optional(),
    restorePoints: z.array(RestorePointSchema).optional(),
    createdSequence: z.number().int().nonnegative().nullable().optional(),
    available: z.boolean().optional(),
    restoreStatus: HelperRestoreStatusSchema.optional(),
    outcome: RestoreOutcome.optional(),
    point: RestorePointSchema.optional(),
    lastPoint: RestorePointSchema.optional(),
    frequencyRestored: z.boolean().optional(),
    resultPath: z.string().max(2048).optional(),
    runningGames: z
      .array(z.object({ gameId: Id, target: ProcessTargetSchema }).strict())
      .optional(),
    backgroundProcesses: z.array(RunningProcessSchema).optional(),
    capabilities: BoostCapabilitiesSchema.optional(),
    network: NetworkCheckSchema.optional(),
    launch: LaunchResultSchema.optional(),
    reverts: z.array(MechanismResultSchema).optional(),
    powerPlan: Id.optional(),
    driveCoverage: z.enum(["confirmed", "off", "unknown"]).optional(),
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
    setting: z.enum(["cpmincores", "cpmincores1"]).optional(),
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
      ]),
      mechanism: MechanismId,
      detail: z.string().max(500),
      code: z.string().max(40).optional(),
    })
    .strict(),
  z.object({ event: z.literal("ready") }).strict(),
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
