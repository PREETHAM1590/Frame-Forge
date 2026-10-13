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
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;
export const GameSchema = z
  .object({
    id: Id,
    name: Name,
    path: z.string().max(2048),
    source: z.enum(["custom", "steam", "epic", "gog", "xbox"]),
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
};
// What each preset mode applies. Custom uses the saved toggles.
export const modeMechanisms: Record<
  Exclude<BoostMode, "custom">,
  CustomMechanisms
> = {
  off: noMechanisms,
  balanced: { ...noMechanisms, gameMode: true, priority: "AboveNormal" },
  performance: {
    ...noMechanisms,
    gameMode: true,
    priority: "High",
    powerPlan: true,
    lowerBackground: true,
  },
  competitive: {
    ...noMechanisms,
    gameMode: true,
    priority: "High",
    powerPlan: true,
    lowerBackground: true,
    suspendBackground: true,
    timerResolution: true,
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
  })
  .strict();
export type BoostSession = z.infer<typeof BoostSessionSchema>;
export const BoostCapabilitiesSchema = z
  .object({
    logicalCpus: z.number().int().nonnegative(),
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
  })
  .strict();
export type RestorePoints = z.infer<typeof RestorePointsSchema>;
export const DetectionSchema = z
  .object({
    games: z.array(GameSchema).max(500),
    warnings: z.array(z.string().max(1000)),
    launchers: z.array(z.string().max(80)),
  })
  .strict();
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
  restorePoints: Empty,
  createRestorePoint: z
    .object({ name: Name, confirmed: z.literal(true) })
    .strict(),
  boostStatus: Empty,
  boostConfig: BoosterConfigSchema,
  boostStart: z.object({ gameId: Id, confirmed: z.literal(true) }).strict(),
  boostStop: z.object({ confirmed: z.literal(true) }).strict(),
  boostRecover: z
    .object({ confirmed: z.literal(true), dismiss: z.boolean().optional() })
    .strict(),
  runningProcesses: Empty,
  // Consent-gated: create (or remove) the Frameforge copy of Windows' High performance plan.
  boostPowerPlan: z
    .object({
      action: z.enum(["create", "remove"]),
      confirmed: z.literal(true),
    })
    .strict(),
  removeGame: z.object({ id: Id }).strict(),
  profile: z
    .object({
      id: Id,
      profile: GameSchema.shape.profile.optional(),
      boostMode: GameSchema.shape.boostMode,
      notes: GameSchema.shape.notes,
    })
    .strict(),
  savePreset: z.object({ name: Name, ids: Selection.shape.ids }).strict(),
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
  restorePoints: RestorePointsSchema,
  createRestorePoint: RestorePointsSchema,
  boostStatus: BoostStatusSchema,
  boostConfig: StateSchema,
  boostStart: BoostSessionSchema,
  boostStop: BoostSessionSchema.nullable(),
  boostRecover: BoostSessionSchema.nullable(),
  runningProcesses: z.array(RunningProcessSchema).max(500),
  boostPowerPlan: BoostStatusSchema,
  removeGame: StateSchema,
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
export const SnapshotSchema = z
  .object({ values: z.array(RegistryValueSchema).max(4) })
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
    runningGames: z
      .array(z.object({ gameId: Id, target: ProcessTargetSchema }).strict())
      .optional(),
    backgroundProcesses: z.array(RunningProcessSchema).optional(),
    capabilities: BoostCapabilitiesSchema.optional(),
    reverts: z.array(MechanismResultSchema).optional(),
    powerPlan: Id.optional(),
  })
  .strict();
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
// One-way main -> renderer events. Task 3 adds its "scan-progress" member here.
export const EventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boost"), session: BoostSessionSchema }).strict(),
]);
export type AppEvent = z.infer<typeof EventSchema>;
