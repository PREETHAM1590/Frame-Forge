import { randomUUID } from "node:crypto";
import path from "node:path";
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
import { upsertPreset } from "../shared/catalogue.js";
import { Repository } from "./repository.js";
import { OperationEngine } from "./operations.js";
import { BoostEngine } from "./booster.js";
import { RestorePointService } from "./restore.js";
import type { DetectionResult } from "./games.js";
import { fallbackHardware, type Platform } from "./platform.js";
import {
  dismissPath,
  dismissedKey,
  lastScanKey,
  pathKey,
  readDismissed,
  shouldAutoScan,
} from "./scanPolicy.js";
type Handlers = { [M in Method]: (input: Request<M>) => Promise<Response<M>> };
export interface DesktopServices {
  pickGame: () => Promise<Game | null>;
  detectGames: () => Promise<DetectionResult>;
  /** Opens the native folder dialog and scans the chosen folder; null when cancelled. */
  scanFolder: () => Promise<DetectionResult | null>;
  setStartup: (enabled: boolean) => void;
  /** Windows' real launch-at-sign-in state; absent where it cannot be read. */
  startupEnabled?: () => boolean;
  version: string;
  startupSupported?: boolean;
  openSystemRestore?: () => Promise<boolean>;
  notify?: (event: AppEvent) => void;
  openSettings?: (page: Request<"openSettings">["page"]) => Promise<boolean>;
  /** PNG data URL for a library game's icon, or null. */
  gameIcon?: (game: Game) => Promise<string | null>;
}
export class AppService {
  private engine: OperationEngine;
  readonly booster: BoostEngine;
  private restorePoints: RestorePointService;
  private hardware: Hardware = fallbackHardware();
  private loggingFailed = false;
  // One scan at a time: startup, Rescan and Dashboard "Scan now" all share it.
  private scanning: Promise<DetectionResult> | null = null;
  private handlers: Handlers;
  get isBusy() {
    return (
      this.engine.isBusy || this.booster.isBusy || this.restorePoints.isBusy
    );
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
    this.restorePoints = new RestorePointService(repo, platform);
    this.booster = new BoostEngine(repo, platform, (session) =>
      this.desktop.notify?.({ type: "boost", session }),
    );
    this.booster.configure();
    const guard = () => {
      if (this.engine.isBusy)
        throw new Error("Wait for the Windows operation to finish.");
    };
    // Engine changes and restore requests both write Windows state; never overlap them.
    const noRestoreInFlight = () => {
      if (this.restorePoints.isBusy)
        throw new Error(
          "Wait for the System Restore request to finish before changing Windows settings.",
        );
    };
    this.handlers = {
      bootstrap: async () => this.bootstrap(),
      refresh: async () => this.refresh(),
      settings: async (settings: Settings) => {
        guard();
        const previous = this.repo.state();
        // Compare with Windows' real state when readable; the stored value may be stale.
        const readable =
          this.desktop.startupSupported && this.desktop.startupEnabled;
        const current = readable
          ? this.desktop.startupEnabled!()
          : previous.settings.startup;
        if (settings.startup !== current) {
          this.desktop.setStartup(settings.startup);
          if (readable && this.desktop.startupEnabled!() !== settings.startup)
            throw new Error("Windows did not accept the sign-in change.");
        }
        const state = (() => {
          try {
            return this.repo.updateState({ ...previous, settings });
          } catch (e) {
            if (settings.startup !== current) this.desktop.setStartup(current);
            throw e;
          }
        })();
        this.log("Preferences saved", "App preferences updated locally.");
        return state;
      },
      preview: async ({ ids }) => this.engine.preview(ids),
      confirm: async ({ token }) => {
        noRestoreInFlight();
        return this.engine.confirm(token);
      },
      cancel: async () => this.engine.cancel(),
      rollback: async ({ id }) => {
        noRestoreInFlight();
        return this.engine.rollback(id);
      },
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
        // A restore replaces the library and booster config under a live session.
        if (this.booster.active || this.repo.boostSession())
          throw new Error(
            "Stop or recover the Game Mode session before restoring a configuration backup.",
          );
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
        this.booster.configure();
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
        // Adding a game by hand undoes an earlier removal.
        this.undismiss(game.path);
        this.log("Game added", "A local game was added to the library.");
        return game;
      },
      detectGames: async () => {
        guard();
        return this.scan(false);
      },
      scanFolder: async () => {
        guard();
        const result = await this.desktop.scanFolder();
        guard();
        return result
          ? this.merge(result, { label: "Installed game scan completed" })
          : {
              games: [],
              warnings: ["No folder was chosen."],
              launchers: [],
              perLauncher: [],
            };
      },
      restoreStatus: async () => this.restorePoints.status(),
      restorePoints: async () => this.restorePoints.list(),
      createRestorePoint: async ({ name, bypassThrottle }) => {
        guard();
        return this.restorePoints.create(name, bypassThrottle);
      },
      enableSystemProtection: async () => {
        guard();
        return this.restorePoints.enable();
      },
      recoverRestoreFrequency: async () => {
        guard();
        return this.restorePoints.recoverFrequency();
      },
      openSystemRestore: async () =>
        (await this.desktop.openSystemRestore?.()) ?? false,
      openSettings: async ({ page }) => {
        if (!(await this.desktop.openSettings?.(page)))
          throw new Error("Windows could not open that settings page.");
        return true;
      },
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
      boostPowerPlan: async ({ action }) => {
        guard();
        return this.booster.powerPlan(action);
      },
      removeGame: async ({ id }) => {
        guard();
        // Removing the game would orphan its boost session's restore target.
        if (this.repo.boostSession()?.gameId === id)
          throw new Error("Stop Game Mode for this game before removing it.");
        const state = this.repo.state();
        const removed = state.games.find((g) => g.id === id);
        // Remember removed games so scans do not bring them back.
        if (removed) this.dismiss(removed.path);
        return this.repo.updateState({
          ...state,
          games: state.games.filter((g) => g.id !== id),
          gameMode:
            state.gameMode.gameId === id
              ? { active: false, gameId: null }
              : state.gameMode,
        });
      },
      gameIcon: async ({ id }) => {
        const game = this.repo.state().games.find((g) => g.id === id);
        return (game && (await this.desktop.gameIcon?.(game))) || null;
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
      savePreset: async (input) => {
        guard();
        const state = this.repo.state();
        return this.repo.updateState({
          ...state,
          presets: upsertPreset(state.presets, input, randomUUID),
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
  private dismissed() {
    return readDismissed(this.repo.meta(dismissedKey));
  }
  private dismiss(gamePath: string) {
    this.repo.setMeta(dismissedKey, dismissPath(this.dismissed(), gamePath));
  }
  private undismiss(gamePath: string) {
    const list = this.dismissed();
    if (list.includes(pathKey(gamePath)))
      this.repo.setMeta(
        dismissedKey,
        list.filter((p) => p !== pathKey(gamePath)),
      );
  }
  // A closed window must not fail a scan.
  private tell(event: AppEvent) {
    try {
      this.desktop.notify?.(event);
    } catch {
      /* best effort */
    }
  }
  /** Whole-PC scan: shares an in-flight scan, adds new games, records the time and tells the window. */
  private scan(auto: boolean): Promise<DetectionResult> {
    this.scanning ??= (async () => {
      this.tell({
        type: "scan",
        phase: "started",
        auto,
        added: 0,
      });
      let added = 0;
      try {
        const result = await this.desktop.detectGames();
        if (this.engine.isBusy)
          throw new Error("Wait for the Windows operation to finish.");
        const before = this.repo.state().games.length;
        const merged = this.merge(result, {
          label: auto
            ? "Automatic game scan completed"
            : "Installed game scan completed",
          full: true,
        });
        added = Math.max(0, this.repo.state().games.length - before);
        return merged;
      } finally {
        this.scanning = null;
        this.tell({ type: "scan", phase: "finished", auto, added });
      }
    })();
    return this.scanning;
  }
  /** Startup scan: runs when no scan is on record or the last one is older than the interval. Never throws. */
  async autoScan(now = Date.now()): Promise<void> {
    try {
      const settings = this.repo.state().settings;
      if (!shouldAutoScan(this.repo.meta(lastScanKey), settings, now)) return;
      await this.scan(true);
    } catch (error) {
      this.log(
        "Automatic game scan failed",
        `The startup scan did not finish: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}. It will retry next launch.`,
        "failed",
      );
    }
  }
  // Adds scanned games the library does not have yet (matched by install path) and logs the scan.
  private merge(
    result: DetectionResult,
    options: { label: string; full?: boolean },
  ): DetectionResult {
    const state = this.repo.state();
    const dismissed = new Set(this.dismissed());
    const known = [
      ...state.games.map((g) => g.path.toLowerCase()),
      ...dismissed,
    ];
    const skipped = result.games.filter((g) =>
      dismissed.has(g.path.toLowerCase()),
    ).length;
    const generic = (source: string) =>
      source === "registry" || source === "folder" || source === "msstore";
    const nested = (a: string, b: string) =>
      a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
    // A generic (registry/folder/store) hit inside, or above, a library game is the same game.
    const added = result.games.filter((g) => {
      const key = g.path.toLowerCase();
      return (
        !known.includes(key) &&
        !(generic(g.source) && known.some((other) => nested(key, other)))
      );
    });
    // A launcher-specific hit upgrades a library entry that was first found generically.
    const upgrades = new Map(
      result.games
        .filter((g) => !generic(g.source))
        .map((g) => [g.path.toLowerCase(), g]),
    );
    const library = state.games.map((old) => {
      const better = upgrades.get(old.path.toLowerCase());
      return better && generic(old.source)
        ? {
            ...old,
            source: better.source,
            executablePath: old.executablePath ?? better.executablePath,
          }
        : old;
    });
    const combined = [...library, ...added].slice(0, 500);
    const dropped = library.length + added.length - combined.length;
    this.repo.updateState({ ...state, games: combined });
    if (options.full) this.repo.setMeta(lastScanKey, new Date().toISOString());
    this.log(
      options.label,
      `${combined.length - state.games.length} new of ${result.games.length} found. Scanned: ${result.launchers.length ? result.launchers.join(", ") : "no supported launchers"}.${skipped ? ` ${skipped} previously removed game${skipped === 1 ? " was" : "s were"} left out.` : ""}`,
    );
    const warnings = [
      ...result.warnings,
      ...(dropped > 0
        ? [
            `The library is full (500 games). ${dropped} found game${dropped === 1 ? " was" : "s were"} not added. Remove games you no longer play and rescan.`,
          ]
        : []),
      ...(skipped
        ? [
            `${skipped} game${skipped === 1 ? "" : "s"} you removed earlier ${skipped === 1 ? "was" : "were"} not added back. Use Add game to restore ${skipped === 1 ? "it" : "one"}.`,
          ]
        : []),
    ];
    return warnings.length > result.warnings.length
      ? { ...result, warnings }
      : result;
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
  private probeWarning: string | null = null;
  private currentHardware(): Hardware {
    const extra = [
      ...(this.probeWarning ? [this.probeWarning] : []),
      ...(this.loggingFailed
        ? [
            "Activity logging failed. Recent actions may be missing from history.",
          ]
        : []),
    ];
    return extra.length
      ? { ...this.hardware, warnings: [...this.hardware.warnings, ...extra] }
      : this.hardware;
  }
  async refresh(): Promise<Hardware> {
    this.probeWarning =
      (await this.platform.probe?.().catch(() => null)) ?? null;
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
    const state = this.repo.state();
    // Show Windows' real sign-in state; the next settings save stores it.
    const startup =
      this.desktop.startupSupported && this.desktop.startupEnabled
        ? this.desktop.startupEnabled()
        : state.settings.startup;
    return {
      state: { ...state, settings: { ...state.settings, startup } },
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
      scan: {
        running: this.scanning !== null,
        lastScanAt: (this.repo.meta(lastScanKey) as string | null) ?? null,
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
          !["bootstrap", "clearActivity", "cancel", "gameIcon"].includes(key)
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
