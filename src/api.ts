import {
  BootstrapSchema,
  StateSchema,
  BackupSchema,
  requests,
  responses,
  defaultState,
  type Api,
  type AppState,
  type Bootstrap,
  type Method,
  type Request,
  type Response,
} from "../shared/contracts";
const storageKey = "frameforge-demo-v1";
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
    state = StateSchema.parse(saved.state);
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
    version: "0.1.0",
    capabilities: [],
    mode: "demo",
    startupSupported: false,
    boost: { session: null, available: false },
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
        presets: [...state.presets, { ...data, id: crypto.randomUUID() }],
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
            ? { ...g, profile: data.profile, notes: data.notes }
            : g,
        ),
      };
      result = state;
      break;
    }
    case "gameMode":
      state = StateSchema.parse({
        ...state,
        gameMode: requests.gameMode.parse(input),
      });
      log("Profile session updated", "App-only session; no Windows changes.");
      result = state;
      break;
    case "clearActivity":
      activity = activity.filter((a) => a.rollback);
      result = true;
      break;
    case "cancel":
      return false;
    case "addGame":
      throw new Error("The native file picker requires the desktop app.");
    case "detectGames":
      throw new Error("Installed game detection requires the desktop app.");
    case "restoreStatus":
      return {
        protection: "unknown",
        policyDisabled: false,
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
    case "boostTargets":
    case "boostStart":
    case "boostStop":
      throw new Error("Game booster requires the desktop app.");
    default:
      throw new Error(
        "Windows operations are unavailable in browser demo mode.",
      );
  }
  state = StateSchema.parse(state);
  persist();
  return responses[method].parse(result);
}
declare global {
  interface Window {
    frameforge?: Api;
  }
}
export const isDesktop = !!window.frameforge;
export async function request<M extends Method>(
  method: M,
  input: Request<M>,
): Promise<Response<M>> {
  requests[method].parse(input);
  const api = window.frameforge;
  const output = api
    ? await (api[method] as (input: Request<M>) => Promise<Response<M>>)(input)
    : await demoDispatch(method, input);
  return responses[method].parse(output) as Response<M>;
}
