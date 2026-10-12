import { randomUUID } from "node:crypto";
import {
  requests,
  responses,
  type Method,
  type Request,
  type Response,
  type Game,
  type Settings,
  type Hardware,
  type Bootstrap,
  type Activity,
  type AppEvent,
} from "../shared/contracts.js";
import { Repository } from "./repository.js";
import { OperationEngine } from "./operations.js";
import { BoostEngine } from "./booster.js";
import type { DetectionResult } from "./games.js";
import { fallbackHardware, type Platform } from "./platform.js";
const restorePointsUnavailable = {
  points: [],
  available: false,
  createdSequence: null,
  message: "Windows restore points are not available in this build yet.",
};
type Handlers = { [M in Method]: (input: Request<M>) => Promise<Response<M>> };
export interface DesktopServices {
  pickGame: () => Promise<Game | null>;
  detectGames: () => Promise<DetectionResult>;
  setStartup: (enabled: boolean) => void;
  version: string;
  startupSupported?: boolean;
  notify?: (event: AppEvent) => void;
}
export class AppService {
  private engine: OperationEngine;
  readonly booster: BoostEngine;
  private hardware: Hardware = fallbackHardware();
  private loggingFailed = false;
  private handlers: Handlers;
  get isBusy() {
    return this.engine.isBusy || this.booster.isBusy;
  }
  // App quit: stop the watcher and revert a live boost session before exiting.
  async shutdown() {
    this.booster.dispose();
    if (this.booster.active) await this.booster.stop();
  }
  constructor(
    private repo: Repository,
    private platform: Platform,
    private desktop: DesktopServices,
  ) {
    this.engine = new OperationEngine(repo, platform);
    this.booster = new BoostEngine(repo, platform, (session) =>
      this.desktop.notify?.({ type: "boost", session }),
    );
    this.booster.configure();
    const guard = () => {
      if (this.engine.isBusy)
        throw new Error("Wait for the Windows operation to finish.");
    };
    this.handlers = {
      bootstrap: async () => this.bootstrap(),
      refresh: async () => this.refresh(),
      settings: async (settings: Settings) => {
        guard();
        const previous = this.repo.state();
        if (settings.startup !== previous.settings.startup)
          this.desktop.setStartup(settings.startup);
        const state = (() => {
          try {
            return this.repo.updateState({ ...previous, settings });
          } catch (e) {
            if (settings.startup !== previous.settings.startup)
              this.desktop.setStartup(previous.settings.startup);
            throw e;
          }
        })();
        this.log("Preferences saved", "App preferences updated locally.");
        return state;
      },
      preview: async ({ ids }) => this.engine.preview(ids),
      confirm: async ({ token }) => this.engine.confirm(token),
      cancel: async () => this.engine.cancel(),
      rollback: async ({ id }) => this.engine.rollback(id),
      backup: async ({ name }) => {
        guard();
        const result = this.repo.backup(name);
        this.log(
          "Configuration backup created",
          "App settings, game profiles and custom presets saved.",
        );
        return result;
      },
      restore: async ({ id }) => {
        guard();
        const backup = this.repo.backups().find((b) => b.id === id);
        if (!backup) throw new Error("Backup not found");
        const previous = this.repo.state();
        this.desktop.setStartup(backup.state.settings.startup);
        const state = (() => {
          try {
            return this.repo.restore(id);
          } catch (e) {
            this.desktop.setStartup(previous.settings.startup);
            throw e;
          }
        })();
        this.log(
          "Configuration restored",
          "App configuration restored; Windows registry state was not changed.",
        );
        return state;
      },
      addGame: async () => {
        guard();
        const game = await this.desktop.pickGame();
        if (!game) return null;
        guard();
        const state = this.repo.state();
        if (
          state.games.some(
            (g) => g.path.toLowerCase() === game.path.toLowerCase(),
          )
        )
          throw new Error("That game is already in your library.");
        this.repo.updateState({ ...state, games: [...state.games, game] });
        this.log("Game added", "A local game was added to the library.");
        return game;
      },
      detectGames: async () => {
        guard();
        const result = await this.desktop.detectGames();
        guard();
        const state = this.repo.state();
        const added = result.games.filter(
          (g) =>
            !state.games.some(
              (old) => old.path.toLowerCase() === g.path.toLowerCase(),
            ),
        );
        const combined = [...state.games, ...added].slice(0, 500);
        this.repo.updateState({ ...state, games: combined });
        this.log(
          "Installed game scan completed",
          `${combined.length - state.games.length} new of ${result.games.length} found. Scanned: ${result.launchers.length ? result.launchers.join(", ") : "no supported launchers"}.`,
        );
        return {
          games: result.games,
          warnings: result.warnings,
          launchers: result.launchers,
        };
      },
      restorePoints: async () => restorePointsUnavailable,
      createRestorePoint: async () => restorePointsUnavailable,
      boostStatus: async () => this.booster.status(),
      boostConfig: async (booster) => {
        guard();
        const state = this.repo.updateState({ ...this.repo.state(), booster });
        this.booster.configure();
        this.log(
          "Game booster settings saved",
          `Mode ${booster.mode}; auto-boost ${booster.autoBoost ? "on" : "off"}; ${booster.background.length} background app rule(s).`,
        );
        return state;
      },
      boostStart: async ({ gameId }) => {
        guard();
        const session = await this.booster.start(gameId, "manual");
        if (!session) throw new Error("Booster mode is Off for this game.");
        return session;
      },
      boostStop: async () => {
        guard();
        return this.booster.stop();
      },
      boostRecover: async ({ dismiss }) => {
        guard();
        return this.booster.recover(dismiss ?? false);
      },
      runningProcesses: async () => this.platform.backgroundProcesses(),
      removeGame: async ({ id }) => {
        guard();
        const state = this.repo.state();
        return this.repo.updateState({
          ...state,
          games: state.games.filter((g) => g.id !== id),
          gameMode:
            state.gameMode.gameId === id
              ? { active: false, gameId: null }
              : state.gameMode,
        });
      },
      profile: async ({ id, profile, boostMode, notes }) => {
        guard();
        const state = this.repo.state();
        if (!state.games.some((g) => g.id === id))
          throw new Error("Game not found");
        return this.repo.updateState({
          ...state,
          games: state.games.map((g) =>
            g.id === id
              ? { ...g, profile: profile ?? g.profile, boostMode, notes }
              : g,
          ),
        });
      },
      savePreset: async ({ name, ids }) => {
        guard();
        const state = this.repo.state();
        return this.repo.updateState({
          ...state,
          presets: [...state.presets, { id: randomUUID(), name, ids }],
        });
      },
      removePreset: async ({ id }) => {
        guard();
        const state = this.repo.state();
        return this.repo.updateState({
          ...state,
          presets: state.presets.filter((p) => p.id !== id),
        });
      },
      clearActivity: async () => {
        guard();
        this.repo.clearActivity();
        return true;
      },
    };
  }
  private log(
    label: string,
    message: string,
    status: Activity["status"] = "success",
  ): void {
    try {
      this.repo.log(label, message, status);
    } catch {
      this.loggingFailed = true;
    }
  }
  private currentHardware(): Hardware {
    return this.loggingFailed
      ? {
          ...this.hardware,
          warnings: [
            ...this.hardware.warnings,
            "Activity logging failed. Recent actions may be missing from history.",
          ],
        }
      : this.hardware;
  }
  async refresh(): Promise<Hardware> {
    try {
      this.hardware = await this.platform.hardware();
    } catch {
      this.hardware = fallbackHardware(
        "Windows discovery failed. Runtime readings are shown; retry Refresh.",
      );
    }
    return this.currentHardware();
  }
  bootstrap(): Bootstrap {
    return {
      state: this.repo.state(),
      hardware: this.currentHardware(),
      activity: this.repo.activity(),
      backups: this.repo.backups(),
      capabilities: this.platform.capabilities,
      startupSupported: this.desktop.startupSupported ?? false,
      version: this.desktop.version,
      mode: "desktop",
      boost: {
        session: this.repo.boostSession(),
        available: this.platform.boostAvailable,
        watching: this.booster.watching,
      },
    };
  }
  async dispatch(method: unknown, input: unknown): Promise<unknown> {
    if (typeof method !== "string" || !Object.hasOwn(requests, method))
      throw new Error("Unknown IPC method");
    if (JSON.stringify(input)?.length > 32768)
      throw new Error("IPC request too large");
    const key = method as Method;
    const parsed = requests[key].parse(input);
    const handler = this.handlers[key] as (
      input: typeof parsed,
    ) => Promise<unknown>;
    const start = performance.now();
    try {
      const result = responses[key].parse(await handler(parsed));
      const labels: Partial<Record<Method, string>> = {
        removeGame: "Game removed",
        profile: "Game profile saved",
        savePreset: "Custom preset saved",
        removePreset: "Custom preset removed",
      };
      if (labels[key])
        this.log(labels[key]!, "App configuration updated locally.");
      try {
        if (
          this.repo.state().settings.diagnostics &&
          !["bootstrap", "clearActivity", "cancel"].includes(key)
        )
          this.log(
            "Local diagnostics",
            `${key} completed in ${Math.round(performance.now() - start)} ms.`,
          );
      } catch {
        this.loggingFailed = true;
      }
      return result;
    } catch (error) {
      this.log(
        "Request failed",
        `${key} did not complete. Review the action and retry.`,
        "failed",
      );
      throw error;
    }
  }
}
