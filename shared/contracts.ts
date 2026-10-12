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
    source: z.enum([
      "custom",
      "steam",
      "epic",
      "gog",
      "xbox",
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
    profile: z.enum(["balanced", "gaming", "quiet"]),
    notes: z.string().max(500),
  })
  .strict();
export type Game = z.infer<typeof GameSchema>;
export const sourceLabels: Record<Game["source"], string> = {
  custom: "Added manually",
  steam: "Steam",
  epic: "Epic Games",
  gog: "GOG",
  xbox: "Xbox app",
  ea: "EA app",
  ubisoft: "Ubisoft Connect",
  battlenet: "Battle.net",
  riot: "Riot Games",
  rockstar: "Rockstar Games",
  itch: "itch.io",
  registry: "Other installed games",
  folder: "Chosen folder",
};
export const PresetSchema = z
  .object({ id: Id, name: Name, ids: z.array(OperationId).min(1).max(8) })
  .strict();
export const StateSchema = z
  .object({
    version: z.literal(1),
    settings: SettingsSchema,
    games: z.array(GameSchema).max(500),
    presets: z.array(PresetSchema).max(50),
    gameMode: z.object({ gameId: Id.nullable(), active: z.boolean() }).strict(),
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
export const BoostSessionSchema = z
  .object({
    id: Id,
    gameId: Id,
    target: ProcessTargetSchema,
    startedAt: z.string(),
    status: z.enum([
      "preparing",
      "active",
      "restoring",
      "recovery-needed",
      "ended",
    ]),
    message: z.string().max(1000),
  })
  .strict();
export type BoostSession = z.infer<typeof BoostSessionSchema>;
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
  scanFolder: z.object({ confirmed: z.literal(true) }).strict(),
  restorePoints: Empty,
  createRestorePoint: z
    .object({ name: Name, confirmed: z.literal(true) })
    .strict(),
  boostTargets: z.object({ gameId: Id }).strict(),
  boostStart: z
    .object({
      gameId: Id,
      target: ProcessTargetSchema,
      confirmed: z.literal(true),
    })
    .strict(),
  boostStop: z.object({ confirmed: z.literal(true) }).strict(),
  removeGame: z.object({ id: Id }).strict(),
  profile: z
    .object({
      id: Id,
      profile: GameSchema.shape.profile,
      notes: GameSchema.shape.notes,
    })
    .strict(),
  gameMode: z.object({ gameId: Id.nullable(), active: z.boolean() }).strict(),
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
  scanFolder: DetectionSchema,
  restorePoints: RestorePointsSchema,
  createRestorePoint: RestorePointsSchema,
  boostTargets: z.array(ProcessTargetSchema),
  boostStart: BoostSessionSchema,
  boostStop: BoostSessionSchema.nullable(),
  removeGame: StateSchema,
  profile: StateSchema,
  gameMode: StateSchema,
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
]);
export type AppEvent = z.infer<typeof EventSchema>;
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
    processes: z.array(ProcessTargetSchema).optional(),
    boostSnapshot: ProcessTargetSchema.optional(),
  })
  .strict();
