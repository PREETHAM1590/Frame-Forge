import {
  BootstrapSchema,
  StateSchema,
  BackupSchema,
  requests,
  responses,
  defaultState,
  dropLegacyMechanisms,
  MechanismId,
  type Api,
  type AppEvent,
  type AppState,
  type Bootstrap,
  type FrameforgeApi,
  type Method,
  type Request,
  type Response,
} from "../shared/contracts";
import { upsertPreset } from "../shared/catalogue";
const storageKey = "frameforge-demo-v1";
export const desktopOnly = "Game booster requires the desktop app.";
let state: AppState = structuredClone(defaultState);
let backups: Bootstrap["backups"] = [];
let activity: Bootstrap["activity"] = [];
function load() {
  const raw = localStorage.getItem(storageKey);
  if (raw) {
    const saved = JSON.parse(raw) as {
      state: unknown;
      backups: unknown;
      activity: unknown;
    };
    // Older demo data may still carry the retired GPU preference / fullscreen toggles.
    state = StateSchema.parse(dropLegacyMechanisms(saved.state));
    backups = BackupSchema.array().parse(saved.backups);
    activity = BootstrapSchema.shape.activity.parse(saved.activity);
  }
}
function persist() {
  localStorage.setItem(
    storageKey,
    JSON.stringify({ state, backups, activity }),
  );
}
function log(label: string, message: string) {
  activity.unshift({
    id: crypto.randomUUID(),
    label,
    message,
    at: new Date().toISOString(),
    status: "success",
    ids: [],
    rollback: false,
  });
  activity = activity.slice(0, 500);
}
function createBackup(name: string) {
  const backup = BackupSchema.parse({
    id: crypto.randomUUID(),
    name,
    at: new Date().toISOString(),
    state: structuredClone(state),
  });
  backups.unshift(backup);
  return backup;
}
const hardware: Bootstrap["hardware"] = {
  source: "demo",
  collectedAt: new Date().toISOString(),
  cpu: "AMD Ryzen 7 7800X3D",
  cores: 16,
  gpu: ["NVIDIA GeForce RTX 4070"],
  memoryBytes: 32 * 1024 ** 3,
  freeMemoryBytes: 21 * 1024 ** 3,
  os: "Windows 11 Pro (sample)",
  drives: [
    {
      name: "C:\\ (sample)",
      totalBytes: 1024 ** 4,
      freeBytes: 684 * 1024 ** 3,
    },
  ],
  displays: ["2560 x 1440 (sample)"],
  drivers: ["NVIDIA display driver (sample)"],
  warnings: ["Sample hardware. Launch the desktop app to read this PC."],
};
function bootstrap(): Bootstrap {
  return {
    state,
    backups,
    activity,
    hardware,
    version: "1.0.0",
    capabilities: [],
    mode: "demo",
    startupSupported: false,
    boost: { session: null, available: false, watching: false },
    scan: { running: false, lastScanAt: null },
    removedGames: [],
  };
}
async function demoDispatch(method: Method, input: unknown): Promise<unknown> {
  load();
  requests[method].parse(input);
  let result: unknown;
  switch (method) {
    case "bootstrap":
      return BootstrapSchema.parse(bootstrap());
    case "refresh":
      return { ...hardware, collectedAt: new Date().toISOString() };
    case "settings":
      state = { ...state, settings: requests.settings.parse(input) };
      log("Preferences saved", "Demo preferences saved in this browser.");
      result = state;
      break;
    case "backup":
      result = createBackup(requests.backup.parse(input).name);
      log("Configuration backup created", "Demo app configuration saved.");
      break;
    case "restore": {
      const backup = backups.find(
        (b) => b.id === requests.restore.parse(input).id,
      );
      if (!backup) throw new Error("Backup not found");
      createBackup("Before configuration restore");
      state = structuredClone(backup.state);
      log("Configuration restored", "Demo app configuration restored.");
      result = state;
      break;
    }
    case "savePreset": {
      const data = requests.savePreset.parse(input);
      state = {
        ...state,
        presets: upsertPreset(state.presets, data, () => crypto.randomUUID()),
      };
      result = state;
      break;
    }
    case "removePreset":
      state = {
        ...state,
        presets: state.presets.filter(
          (p) => p.id !== requests.removePreset.parse(input).id,
        ),
      };
      result = state;
      break;
    case "removeGame": {
      const id = requests.removeGame.parse(input).id;
      state = {
        ...state,
        games: state.games.filter((g) => g.id !== id),
        gameMode:
          state.gameMode.gameId === id
            ? { active: false, gameId: null }
            : state.gameMode,
      };
      result = state;
      break;
    }
    case "profile": {
      const data = requests.profile.parse(input);
      state = {
        ...state,
        games: state.games.map((g) =>
          g.id === data.id
            ? {
                ...g,
                profile: data.profile ?? g.profile,
                boostMode: data.boostMode,
                notes: data.notes,
              }
            : g,
        ),
      };
      result = state;
      break;
    }
    case "boostConfig":
      state = { ...state, booster: requests.boostConfig.parse(input) };
      log("Game booster settings saved", "Saved in this browser only.");
      result = state;
      break;
    case "boostStatus":
      return {
        session: null,
        capabilities: {
          logicalCpus: 0,
          mechanisms: MechanismId.options.map((id) => ({
            id,
            available: false,
            detail: desktopOnly,
            active: false,
          })),
        },
        watching: false,
        ownedPowerPlan: false,
      };
    case "clearActivity":
      // Same rule as the desktop journal: keep rollback, recovery and running rows.
      activity = activity.filter(
        (a) =>
          a.rollback ||
          a.status === "recovery-needed" ||
          a.status === "running",
      );
      result = true;
      break;
    case "cancel":
      return false;
    case "restoreGame":
      throw new Error("Removed games are tracked by the desktop app.");
    case "gameIcon":
      return null;
    case "addGame":
      throw new Error("The native file picker requires the desktop app.");
    case "detectGames":
    case "scanFolder":
      throw new Error("Installed game detection requires the desktop app.");
    case "restoreStatus":
      return {
        protection: "unknown",
        policyDisabled: false,
        configLocked: false,
        frequency: { existed: false, minutes: null },
        elevated: false,
        systemDrive: "C:",
        lastAppCreatedAt: null,
        pendingFrequencyRecovery: false,
        pendingCreation: false,
        message: "Windows System Restore requires the desktop app.",
      };
    case "restorePoints":
    case "createRestorePoint":
    case "enableSystemProtection":
    case "recoverRestoreFrequency":
    case "openSystemRestore":
      throw new Error("Windows System Restore requires the desktop app.");
    case "openSettings":
      throw new Error("Opening Windows Settings requires the desktop app.");
    case "boostStart":
    case "boostStop":
    case "boostRecover":
    case "runningProcesses":
    case "boostPowerPlan":
      throw new Error(desktopOnly);
    case "networkCheck":
      throw new Error("The network check requires the desktop app.");
    case "launchSettings":
    case "launchSettingPreview":
    case "launchSettingApply":
      throw new Error("Launch settings require the desktop app.");
    default:
      throw new Error("Windows operations require the desktop app.");
  }
  state = StateSchema.parse(state);
  persist();
  return responses[method].parse(result);
}
declare global {
  interface Window {
    frameforge?: FrameforgeApi;
  }
}
export const isDesktop = !!window.frameforge;
export async function request<M extends Method>(
  method: M,
  input: Request<M>,
): Promise<Response<M>> {
  requests[method].parse(input);
  const api: Api | undefined = window.frameforge;
  const output = api
    ? await (
        (api as Api)[method] as (input: Request<M>) => Promise<Response<M>>
      )(input)
    : await demoDispatch(method, input);
  return responses[method].parse(output) as Response<M>;
}
// Main-process events (scan progress). The browser demo never receives any.
export function onEvent(callback: (event: AppEvent) => void): () => void {
  return window.frameforge?.onEvent(callback) ?? (() => {});
}
