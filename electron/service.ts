import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  requests,
  type OperationId,
  responses,
  type Method,
  type Request,
  type Response,
  type Game,
  type Settings,
  type UpdateStatus,
  type Hardware,
  type Bootstrap,
  type Activity,
  type AppEvent,
} from "../shared/contracts.js";
import { catalogue, presets, upsertPreset } from "../shared/catalogue.js";
import { Repository } from "./repository.js";
import { OperationEngine } from "./operations.js";
import { BoostEngine } from "./booster.js";
import { RestorePointService } from "./restore.js";
import { LaunchSettingsService } from "./launchSettings.js";
import { MonitorService } from "./monitor.js";
import { FpsService } from "./fps.js";
import { evaluateHealth } from "../shared/health.js";
import { CandidateTracker, GameFinder, SmartEngine } from "./smart.js";
import { within, type DetectionResult } from "./games.js";
import { fallbackHardware, type Platform } from "./platform.js";
import {
  dismissGame,
  dismissedKey,
  lastScanKey,
  partialScanKey,
  pathKey,
  readDismissed,
  shouldAutoScan,
  toDismissed,
  undismissPaths,
} from "./scanPolicy.js";
type Handlers = { [M in Method]: (input: Request<M>) => Promise<Response<M>> };
export interface DesktopServices {
  pickGame: () => Promise<Game | null>;
  /** Opens the native file dialog in the game's folder; the chosen, resolved .exe path or null when cancelled. */
  pickExecutable?: (game: Game) => Promise<string | null>;
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
  /** PNG data URL for the icon of a running program's executable (path from the last process list), or null. */
  fileIcon?: (file: string) => Promise<string | null>;
  /** Deletes cached icons that no library game uses any more. */
  pruneIcons?: (games: Game[]) => Promise<void>;
  /** Auto-update controller; absent in dev, test mode and the browser demo. */
  updates?: {
    status: UpdateStatus;
    check(): Promise<UpdateStatus>;
    download(): Promise<UpdateStatus>;
    install(when: "now" | "onQuit"): UpdateStatus;
  };
  analyticsAvailable?: boolean;
  /** Anonymous, allowlisted usage event; the callee drops it unless the user opted in. */
  track?: (event: string, props?: Record<string, string>) => void;
}
export class AppService {
  private engine: OperationEngine;
  readonly booster: BoostEngine;
  readonly monitor: MonitorService;
  readonly fps: FpsService;
  readonly smart: SmartEngine;
  private finder: GameFinder | undefined;
  private processPaths = new Map<string, string>();
  private restorePoints: RestorePointService;
  private launch: LaunchSettingsService;
  private hardware: Hardware = fallbackHardware();
  private loggingFailed = false;
  // One scan at a time: startup, Rescan and Dashboard "Scan now" all share it.
  private scanning: Promise<DetectionResult> | null = null;
  // False once a manual request joins a startup scan, so it is reported as manual.
  private scanIsAuto = false;
  private handlers: Handlers;
  get isBusy() {
    return (
      this.engine.isBusy ||
      this.booster.isBusy ||
      this.restorePoints.isBusy ||
      this.launch.isBusy
    );
  }
  private updateStatus(): UpdateStatus {
    return (
      this.desktop.updates?.status ?? {
        state: "unsupported",
        current: this.desktop.version.slice(0, 40),
        version: null,
        notes: "",
        percent: 0,
        error: "",
        installOnQuit: false,
        analyticsAvailable: this.desktop.analyticsAvailable ?? false,
      }
    );
  }
  // App quit: stop the watcher and revert a live boost session before exiting.
  async shutdown() {
    this.monitor.stop();
    this.fps.dispose();
    this.finder?.stop();
    this.smart.cancel("Frameforge closed.");
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
    this.launch = new LaunchSettingsService(repo, platform);
    this.booster = new BoostEngine(repo, platform, (session) =>
      this.desktop.notify?.({ type: "boost", session }),
    );
    this.smart = new SmartEngine(repo, platform, {
      notify: (event) => this.desktop.notify?.(event),
      log: (label, message, status) => this.log(label, message, status),
      fps: () => this.fps.liveStats(),
    });
    // Finding games that are not in the library runs only while auto-boost is on (a 15 second foreground check).
    if (platform.foregroundApp) {
      const exe = (p: string) => p.toLowerCase();
      this.finder = new GameFinder(
        platform,
        new CandidateTracker(
          (p) =>
            this.repo
              .state()
              .games.some(
                (g) => g.executablePath && exe(g.executablePath) === exe(p),
              ),
          (p) => this.smart.dismissed().includes(exe(p)),
        ),
        (found) => {
          if (this.smart.offer(found))
            this.log(
              "Smart mode",
              `${found.name} looks like a game that is not in your library. Nothing was added.`,
            );
        },
      );
    }
    this.booster.attachSmart(this.smart, () => {
      const on =
        this.platform.boostAvailable && this.repo.state().booster.autoBoost;
      if (on) this.finder?.start();
      else this.finder?.stop();
    });
    this.booster.configure();
    this.monitor = new MonitorService(platform, (event) =>
      this.desktop.notify?.(event),
    );
    this.fps = new FpsService(platform, {
      games: () => this.repo.state().games,
      boostOn: (gameId) => {
        const session = this.repo.boostSession();
        return session?.gameId === gameId && session.status === "active";
      },
      meta: (key) => this.repo.meta(key),
      setMeta: (key, value) => this.repo.setMeta(key, value),
      log: (label, message) => this.log(label, message),
      notify: (event) => this.desktop.notify?.(event),
    });
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
    // The other direction: a restore request must not start while Game Mode or a launch setting is changing Windows.
    const noBoostInFlight = () => {
      if (this.booster.isBusy || this.launch.isBusy)
        throw new Error(
          "Wait for Game Mode or the launch setting change to finish before starting a System Restore request.",
        );
    };
    this.handlers = {
      bootstrap: async () => {
        await this.recheck();
        return this.bootstrap();
      },
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
      confirm: async ({ token, acknowledged }) => {
        noRestoreInFlight();
        const activity = await this.engine.confirm(token, acknowledged);
        if (activity.status === "success") {
          for (const id of activity.ids)
            this.desktop.track?.("optimization_applied", { id });
          // A built-in preset counts as applied when exactly its items were applied together.
          const applied = [...activity.ids].sort().join();
          const preset = presets.find(
            (p) => [...p.ids].sort().join() === applied,
          );
          if (preset)
            this.desktop.track?.("preset_applied", { id: preset.name });
        }
        return activity;
      },
      updateStatus: async () => this.updateStatus(),
      updateCheck: async () =>
        (await this.desktop.updates?.check()) ?? this.updateStatus(),
      updateDownload: async () =>
        (await this.desktop.updates?.download()) ?? this.updateStatus(),
      updateInstall: async ({ when }) => {
        if (!this.desktop.updates)
          throw new Error("Updates are not available in this build.");
        return this.desktop.updates.install(when);
      },
      trackUsage: async (usage) => {
        this.desktop.track?.(usage.event, { page: usage.page });
        return true;
      },
      cancel: async () => {
        const operation = this.engine.cancel();
        return this.restorePoints.cancel() || operation;
      },
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
        // Games missing from the backup would vanish with their saved launch-setting values, leaving Windows changed with no way to revert.
        const inBackup = new Set(backup.state.games.map((g) => g.id));
        const stuck = previous.games.filter(
          (g) => !inBackup.has(g.id) && this.launch.hasRecords(g.id),
        );
        if (stuck.length)
          throw new Error(
            `Revert the launch settings for ${stuck.map((g) => g.name).join(", ")} first (Game Mode, Launch settings). This backup does not contain ${stuck.length === 1 ? "that game" : "those games"}, so restoring it would lose the saved prior values.`,
          );
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
        this.undismiss([
          game.path,
          ...(game.executablePath ? [path.dirname(game.executablePath)] : []),
        ]);
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
          ? // Choosing a folder is explicit consent to add what is in it, removed games included.
            this.merge(result, {
              label: "Installed game scan completed",
              bypassDismissed: true,
            })
          : {
              games: [],
              warnings: ["No folder was chosen."],
              launchers: [],
              perLauncher: [],
            };
      },
      restoreGame: async ({ path: gamePath }) => {
        guard();
        const entry = this.dismissed().find(
          (d) => pathKey(d.path) === pathKey(gamePath),
        );
        if (!entry) throw new Error("That game is not in the removed list.");
        const state = this.repo.state();
        const present = state.games.some(
          (g) => pathKey(g.path) === pathKey(entry.path),
        );
        if (!present && state.games.length >= 500)
          throw new Error(
            "The library is full (500 games). Remove a game first.",
          );
        const next = present
          ? state
          : this.repo.updateState({
              ...state,
              games: [
                ...state.games,
                {
                  id: randomUUID(),
                  ...entry,
                  profile: "balanced",
                  boostMode: "global",
                  notes: "",
                },
              ],
            });
        this.undismiss([entry.path]);
        this.log(
          "Game restored",
          "A removed game was added back to the library.",
        );
        return next;
      },
      restoreStatus: async () => this.restorePoints.status(),
      restorePoints: async () => {
        noBoostInFlight();
        return this.restorePoints.list();
      },
      createRestorePoint: async ({ name, bypassThrottle }) => {
        guard();
        noBoostInFlight();
        return this.restorePoints.create(name, bypassThrottle);
      },
      enableSystemProtection: async () => {
        guard();
        noBoostInFlight();
        return this.restorePoints.enable();
      },
      recoverRestoreFrequency: async () => {
        guard();
        noBoostInFlight();
        return this.restorePoints.recoverFrequency();
      },
      openSystemRestore: async () =>
        (await this.desktop.openSystemRestore?.()) ?? false,
      openSettings: async ({ page }) => {
        if (!(await this.desktop.openSettings?.(page)))
          throw new Error("Windows could not open that settings page.");
        return true;
      },
      // Fixed action, only after a click: the helper ends this user's explorer.exe and Windows starts it again.
      restartExplorer: async () => {
        guard();
        noRestoreInFlight();
        const message = await this.platform.restartExplorer();
        this.log("Windows Explorer restarted", message);
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
      boostStart: async ({ gameId, skipAdmin }) => {
        guard();
        noRestoreInFlight();
        const session = await this.booster.start(
          gameId,
          "manual",
          undefined,
          skipAdmin,
        );
        if (!session) throw new Error("Booster mode is Off for this game.");
        this.desktop.track?.("mode_started", { mode: session.mode });
        return session;
      },
      boostStop: async () => {
        guard();
        return this.booster.stop();
      },
      boostRecover: async ({ dismiss }) => {
        guard();
        noRestoreInFlight();
        return this.booster.recover(dismiss ?? false);
      },
      runningProcesses: async () => {
        const list = await this.platform.backgroundProcesses();
        // The renderer asks for icons by image name; the paths stay here.
        this.processPaths = new Map(
          list.flatMap((p) =>
            p.path ? [[p.image.toLowerCase(), p.path] as const] : [],
          ),
        );
        return list;
      },
      appIcon: async ({ image }) => {
        const file = this.processPaths.get(image.toLowerCase());
        return (file && (await this.desktop.fileIcon?.(file))) || null;
      },
      launchSettings: async ({ gameId }) => this.launch.status(gameId),
      launchSettingPreview: async ({ gameId, setting, action }) =>
        this.launch.preview(gameId, setting, action),
      launchSettingApply: async ({ gameId, setting, action }) => {
        guard();
        noRestoreInFlight();
        return this.launch.apply(gameId, setting, action);
      },
      networkCheck: async ({ host, count }) => {
        let result;
        try {
          result = await this.platform.networkCheck(host, count);
        } catch (error) {
          // The helper refuses a loopback or unroutable target on purpose; that is an answer, not a failed request.
          if ((error as { code?: string }).code === "invalid-request") {
            this.log(
              "Network check",
              `${host}: not run. ${error instanceof Error ? error.message : ""}`.slice(
                0,
                1000,
              ),
              "cancelled",
            );
            throw Object.assign(error as Error, { logged: true });
          }
          throw error;
        }
        this.log(
          "Network check",
          `${result.host}: ${result.message}`.slice(0, 1000),
        );
        return result;
      },
      boostPowerPlan: async ({ action, guid }) => {
        guard();
        noRestoreInFlight();
        return this.booster.powerPlan(action, guid);
      },
      boostTimerGlobal: async ({ action }) => {
        guard();
        noRestoreInFlight();
        return this.booster.timerGlobal(action);
      },
      removeGame: async ({ id }) => {
        guard();
        // Removing the game would orphan its boost session's restore target.
        if (this.repo.boostSession()?.gameId === id)
          throw new Error("Stop Game Mode for this game before removing it.");
        if (this.launch.hasRecords(id))
          throw new Error(
            "Revert this game's launch settings before removing it, so the saved prior values are not lost.",
          );
        const state = this.repo.state();
        const removed = state.games.find((g) => g.id === id);
        // Remember removed games so scans do not bring them back.
        if (removed) this.dismiss(toDismissed(removed));
        return this.repo.updateState({
          ...state,
          games: state.games.filter((g) => g.id !== id),
          gameMode:
            state.gameMode.gameId === id
              ? { active: false, gameId: null }
              : state.gameMode,
        });
      },
      chooseExecutable: async ({ id, pathConfirmed }) => {
        guard();
        const game = this.repo.state().games.find((g) => g.id === id);
        if (!game) throw new Error("Game not found");
        if (this.repo.boostSession()?.gameId === id)
          throw new Error("Stop Game Mode for this game first.");
        // A saved prior value belongs to the program it was written for.
        if (this.launch.hasRecords(id))
          throw new Error(
            "Revert this game's launch settings before changing its executable, so the saved prior values stay with the right program.",
          );
        if (!game.path && !pathConfirmed)
          throw new Error(
            "This game has no known folder, so Frameforge cannot check that the file belongs to it. Confirm that you will choose the game's own .exe.",
          );
        const picked = await this.desktop.pickExecutable?.(game);
        if (!picked) return null;
        guard();
        // The dialog can stay open for a long time; a launch value may have been saved meanwhile.
        if (this.launch.hasRecords(id))
          throw new Error(
            "Revert this game's launch settings before changing its executable, so the saved prior values stay with the right program.",
          );
        if (game.path && !within(game.path, picked))
          throw new Error(
            `Choose the game's executable inside its folder (${game.path}).`,
          );
        const state = this.repo.state();
        const chosen = { ...game, executablePath: picked };
        this.repo.updateState({
          ...state,
          games: state.games.map((g) => (g.id === id ? chosen : g)),
        });
        this.log(
          "Game executable chosen",
          `${game.name}: launch settings can now use ${path.basename(picked)}.`,
        );
        return chosen;
      },
      gameIcon: async ({ id }) => {
        const game = this.repo.state().games.find((g) => g.id === id);
        return (game && (await this.desktop.gameIcon?.(game))) || null;
      },
      profile: async ({
        id,
        profile,
        boostMode,
        autoBoost,
        notes,
        background,
      }) => {
        guard();
        const state = this.repo.state();
        if (!state.games.some((g) => g.id === id))
          throw new Error("Game not found");
        return this.repo.updateState({
          ...state,
          games: state.games.map((g) =>
            g.id === id
              ? {
                  ...g,
                  profile: profile ?? g.profile,
                  boostMode,
                  autoBoost: autoBoost ?? g.autoBoost,
                  notes,
                  // null removes the per-game list; missing leaves it as it is.
                  ...(background === null
                    ? { background: undefined }
                    : background
                      ? { background }
                      : {}),
                }
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
      monitorStart: async () => this.monitor.start(),
      monitorStop: async () => this.monitor.stop(),
      fpsStatus: async () => this.fps.status(),
      fpsStart: async ({ gameId }) => this.fps.start(gameId),
      fpsStop: async () => this.fps.stop(),
      fpsHistory: async ({ gameId }) => this.fps.history(gameId),
      healthCheck: async () => {
        if (!this.platform.healthFacts)
          throw new Error("The PC Health Check needs the Windows helper.");
        const games = this.repo.state().games;
        const facts = await this.platform.healthFacts(games);
        // A capture with Game Mode on and one with it off, for any game, is a real before/after pair.
        const seen = new Set(
          games.flatMap((g) => this.fps.history(g.id).map((h) => h.boost)),
        );
        return evaluateHealth(facts, {
          games: games.map((g) => ({
            id: g.id,
            name: g.name,
            executablePath: g.executablePath,
          })),
          hasAbPair: seen.has("on") && seen.has("off"),
        });
      },
      smartStatus: async () => this.smart.status(),
      smartCandidate: async ({ action }) => {
        guard();
        if (action === "dismiss") {
          this.smart.dismiss();
          return this.smart.status();
        }
        const found = this.smart.take();
        if (!found) return this.smart.status();
        const state = this.repo.state();
        if (
          !state.games.some(
            (g) => g.executablePath?.toLowerCase() === found.path.toLowerCase(),
          )
        ) {
          const game: Game = {
            id: randomUUID(),
            name: found.name,
            path: path.dirname(found.path),
            source: "custom",
            executablePath: found.path,
            profile: "balanced",
            notes: "Added after Smart mode noticed it running fullscreen.",
            boostMode: "smart",
          };
          this.repo.updateState({ ...state, games: [...state.games, game] });
          this.log(
            "Game added",
            `${found.name} was added to the library (Smart mode).`,
          );
        }
        this.booster.configure();
        return this.smart.status();
      },
      smartForget: async ({ gameId }) => {
        this.smart.forget(gameId);
        return this.smart.status();
      },
    };
  }
  private dismissed() {
    return readDismissed(this.repo.meta(dismissedKey));
  }
  private dismiss(game: ReturnType<typeof toDismissed>) {
    this.repo.setMeta(dismissedKey, dismissGame(this.dismissed(), game));
  }
  private undismiss(
    paths: string[],
    direction: "ancestors" | "both" = "ancestors",
  ) {
    const list = this.dismissed();
    const next = undismissPaths(list, paths, direction);
    if (next.length !== list.length) this.repo.setMeta(dismissedKey, next);
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
    if (this.scanning) {
      if (!auto) this.scanIsAuto = false;
      return this.scanning;
    }
    this.scanIsAuto = auto;
    this.scanning = (async () => {
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
          label: this.scanIsAuto
            ? "Automatic game scan completed"
            : "Installed game scan completed",
          full: true,
          // Only a source that failed makes the scan partial; informational warnings do not.
          partial: result.perLauncher.some((row) => row.status === "error"),
        });
        added = Math.max(0, this.repo.state().games.length - before);
        // Icons of games that are gone (or whose art changed) are no longer needed.
        void this.desktop
          .pruneIcons?.(this.repo.state().games)
          .catch(() => undefined);
        return merged;
      } finally {
        this.scanning = null;
        this.tell({
          type: "scan",
          phase: "finished",
          auto: this.scanIsAuto,
          added,
        });
      }
    })();
    return this.scanning;
  }
  /** Startup scan: runs when no scan is on record or the last one is older than the interval. Never throws. */
  async autoScan(now = Date.now()): Promise<void> {
    try {
      const settings = this.repo.state().settings;
      if (
        !shouldAutoScan(
          this.repo.meta(lastScanKey),
          settings,
          now,
          this.repo.meta(partialScanKey) === true,
        )
      )
        return;
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
    options: {
      label: string;
      /** A whole-PC scan: records when it ran (and whether a source failed). */
      full?: boolean;
      partial?: boolean;
      /** Add games even if the user removed them (an explicit folder scan). */
      bypassDismissed?: boolean;
    },
  ): DetectionResult {
    const state = this.repo.state();
    const dismissed = new Set(
      options.bypassDismissed
        ? []
        : this.dismissed().map((d) => pathKey(d.path)),
    );
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
    this.booster.configure();
    if (options.bypassDismissed)
      this.undismiss(added.map((g) => g.path).filter(Boolean), "both");
    if (options.full) {
      this.repo.setMeta(lastScanKey, new Date().toISOString());
      this.repo.setMeta(partialScanKey, options.partial === true);
    }
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
            `${skipped} game${skipped === 1 ? "" : "s"} you removed earlier ${skipped === 1 ? "was" : "were"} not added back. Restore ${skipped === 1 ? "it" : "one"} under Removed games.`,
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
  // Applied, revert-prone optimizations (security trade-offs and anything that needs a restart) are re-read here, at start and on Refresh.
  private drifted: { activityId: string; ids: OperationId[] }[] = [];
  private async recheck() {
    const proneIds = new Set(
      catalogue
        .filter((o) => o.tier === "security" || o.restart === "reboot")
        .map((o) => o.id),
    );
    const live = this.repo
      .activity()
      .filter((a) => a.status === "success" && a.rollback)
      .map((a) => ({ ...a, ids: a.ids.filter((id) => proneIds.has(id)) }))
      .filter((a) => a.ids.length > 0);
    if (!live.length || !this.platform.recheck) {
      this.drifted = [];
      return;
    }
    try {
      const bad = new Set(
        await this.platform.recheck([...new Set(live.flatMap((a) => a.ids))]),
      );
      this.drifted = live
        .map((a) => ({
          activityId: a.id,
          ids: a.ids.filter((id) => bad.has(id)),
        }))
        .filter((a) => a.ids.length > 0);
    } catch {
      // A failed check proves nothing either way; keep the previous answer.
    }
  }
  async refresh(): Promise<Hardware> {
    await this.recheck();
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
      bootedAt: new Date(Date.now() - os.uptime() * 1000).toISOString(),
      drifted: this.drifted,
      startupSupported: this.desktop.startupSupported ?? false,
      version: this.desktop.version,
      mode: "desktop",
      boost: {
        session: this.repo.boostSession(),
        available: this.platform.boostAvailable,
        watching: this.booster.watching,
      },
      removedGames: this.dismissed().map(({ name, path: p, source }) => ({
        name,
        path: p,
        source,
      })),
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
      // Games, the global switch and the per-game switches all feed the background watcher.
      this.booster.configure();
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
          ![
            "bootstrap",
            "clearActivity",
            "cancel",
            "gameIcon",
            "monitorStart",
            "monitorStop",
            "fpsStatus",
            "fpsHistory",
          ].includes(key)
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
      // An expected refusal has already been recorded in its own words.
      if (!(error as { logged?: boolean }).logged)
        this.log(
          "Request failed",
          `${key} did not complete. Review the action and retry.`,
          "failed",
        );
      throw error;
    }
  }
}
