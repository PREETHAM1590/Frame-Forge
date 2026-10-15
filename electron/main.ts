import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  globalShortcut,
  screen,
  shell,
  Tray,
  type NativeImage,
} from "electron";
import electronUpdater from "electron-updater";
import {
  initialize as aptabaseInit,
  trackEvent,
} from "@aptabase/electron/main";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Repository } from "./repository.js";
import { WindowsPlatform, MockPlatform } from "./platform.js";
import { AppService } from "./service.js";
import {
  safeExecutable,
  detectInstalledGames,
  scanGameFolder,
} from "./games.js";
import {
  EventSchema,
  type AppEvent,
  type BoostSession,
  type FpsStatus,
  type MonitorSample,
} from "../shared/contracts.js";
import { OverlayManager } from "./overlay.js";
import { createOverlayWindow, overlayInfo } from "./overlayWindow.js";
import { MonitorService } from "./monitor.js";
import { settingsTarget } from "./settingsPages.js";
import { driverPages } from "../shared/drivers.js";
import { userDataOverride } from "./userData.js";
import { GameIcons, maxIconBytes } from "./icons.js";
import { UpdateManager } from "./updater.js";
import { Analytics, validAppKey } from "./analytics.js";
import { createLogs } from "./logger.js";
import { currentIdentity, makeRedactor, type GamePaths } from "./redact.js";
import { allowedIssueUrl, validZipPath } from "./diagnostics.js";
import {
  HotkeyManager,
  foregroundWindow,
  hotkeyActions,
  overlayHook,
} from "./hotkeys.js";
import {
  BoostNotices,
  closeDecision,
  hiddenArg,
  migrateLoginItem,
  testHooksEnabled,
  startsHidden,
  trayModel,
  trayNotice,
} from "./background.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const dev = !app.isPackaged && process.argv.includes("--dev");
const rendererFile = path.join(here, "../../dist/index.html");
const allowedUrl = dev
  ? "http://127.0.0.1:5173/"
  : pathToFileURL(rendererFile).href;
function trustedUrl(value: string) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.href === allowedUrl;
  } catch {
    return false;
  }
}
// Test and smoke runs never touch the network: no updater, no analytics.
const testMode = process.env.FRAMEFORGE_TEST_MODE === "1";
// The Aptabase key is written at build time (tools/write-build-info.mjs) from the CI secret; absent means analytics is off.
const appKey = (() => {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(here, "build-info.json"), "utf8"),
    ) as { aptabaseKey?: unknown };
    return typeof raw.aptabaseKey === "string" ? raw.aptabaseKey : undefined;
  } catch {
    return undefined;
  }
})();
const analyticsOn = !testMode && validAppKey(appKey);
// Must run before the app is ready. It only registers local handlers; nothing is sent until an allowlisted event passes the opt-in check.
if (analyticsOn) void aptabaseInit(appKey!).catch(() => {});
let window: BrowserWindow | null = null;
let updates: UpdateManager | undefined;
let updater: { autoInstallOnAppQuit: boolean } | undefined;
let repo: Repository;
let activeService: AppService | undefined;
// Set from inside whenReady; the second-instance handler and the tray both open the window through it.
let showWindow = () => {};
let leaving = false;
let onBoost: (session: BoostSession) => void = () => {};
let refreshTray = () => {};
let hotkeys: HotkeyManager | undefined;
// In-game overlay: re-evaluated after every request, boost change and FPS update.
let syncOverlay = () => {};
let disposeOverlay = () => {};
/** Toggle the in-game overlay by hand (tray item; a hotkey can call it too). */
export let toggleOverlay = () => {};
let lastFps: FpsStatus | null = null;
// Memory: the renderer heap is capped modestly, and Chromium features Frameforge never uses stay off.
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=256");
// The GPU process is what wakes an idle tray app; this dashboard renders fine in software (idle CPU ~0.7% -> ~0.05%).
app.commandLine.appendSwitch("disable-gpu");
// Isolated profile for tests and smoke runs; must be set before the single-instance lock.
try {
  const userData = userDataOverride(process.env, app.isPackaged);
  if (userData) app.setPath("userData", userData);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  app.exit(1);
}
// Local rotating logs in <profile>\logs; every line is redacted as it is written and nothing leaves the PC.
let gameCache = { at: 0, list: [] as GamePaths[] };
const redact = makeRedactor(currentIdentity(), () => {
  if (!repo) return [];
  if (Date.now() - gameCache.at > 5000)
    try {
      gameCache = { at: Date.now(), list: repo.state().games };
    } catch {
      /* the database may be closing */
    }
  return gameCache.list;
});
const logsDir = path.join(app.getPath("userData"), "logs");
const logs = createLogs(logsDir, redact);
const log = logs.main;
// Session and update events are logged on change only.
const lastBoost = new Map<string, string>();
function logBoost(session: BoostSession) {
  if (lastBoost.get(session.id) === session.status) return;
  lastBoost.set(session.id, session.status);
  const failed = session.mechanisms.filter((m) => m.state === "failed");
  log(
    session.failed || session.abnormal ? "warn" : "info",
    "booster",
    `Session ${session.id.slice(0, 8)} ${session.status} (mode ${session.mode}${session.failed ? ", failed" : ""}${failed.length ? `, ${failed.length} mechanism(s) failed` : ""}): ${session.message}`,
  );
}
let lastUpdate = "";
function logUpdate(status: { state: string; error: string }) {
  if (lastUpdate === status.state + status.error) return;
  lastUpdate = status.state + status.error;
  log(
    status.error ? "warn" : "info",
    "updater",
    `Update state ${status.state}${status.error ? `: ${status.error}` : ""}`,
  );
}
process.on("uncaughtExceptionMonitor", (error, origin) =>
  log("error", "process", `${origin}: ${error.stack ?? error.message}`),
);
log(
  "info",
  "app",
  `Frameforge ${app.getVersion()} starting (${app.isPackaged ? "installed" : "dev"}, Windows ${os.release()}, Electron ${process.versions.electron})`,
);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(async () => {
    try {
      mkdirSync(app.getPath("userData"), { recursive: true });
      log("info", "app", "Ready");
      repo = new Repository(
        path.join(app.getPath("userData"), "frameforge.db"),
      );
      repo.recoverInterrupted();
      const helper = app.isPackaged
        ? path.join(process.resourcesPath, "windows", "Frameforge.Windows.exe")
        : path.join(here, "../../windows/publish/Frameforge.Windows.exe");
      const platform =
        process.platform === "win32" && existsSync(helper)
          ? new WindowsPlatform(helper, logs)
          : new MockPlatform();
      // Icons are shown at most ~96px; keep the cached PNGs small.
      // Scaled to fit 128px, then shrunk further until it is under the size the app serves.
      const png = (image: NativeImage) => {
        if (image.isEmpty()) return null;
        const { width, height } = image.getSize();
        let scale = Math.min(1, 128 / Math.max(width, height));
        for (let i = 0; i < 6; i++, scale *= 0.7) {
          const bytes = (
            scale < 1
              ? image.resize({
                  width: Math.max(1, Math.round(width * scale)),
                  height: Math.max(1, Math.round(height * scale)),
                  quality: "best",
                })
              : image
          ).toPNG();
          if (bytes.length <= maxIconBytes) return bytes;
        }
        return null;
      };
      const iconDir = path.join(app.getPath("userData"), "icons");
      const icons = new GameIcons({
        dir: iconDir,
        fileIcon: async (exe) =>
          png(await app.getFileIcon(exe, { size: "large" })),
        image: async (file) => png(nativeImage.createFromPath(file)),
        // Windows answers a path that does not exist with its generic executable icon.
        genericIcon: async () =>
          png(
            await app.getFileIcon(path.join(iconDir, "no-such-app.exe"), {
              size: "large",
            }),
          ),
      });
      const analytics = new Analytics(
        analyticsOn ? { trackEvent } : null,
        () => repo.state().settings.analytics === true,
      );
      if (app.isPackaged && !testMode) {
        const { autoUpdater } = electronUpdater;
        autoUpdater.setFeedURL({
          provider: "github",
          owner: "PREETHAM1590",
          repo: "Frame-Forge",
        });
        // Signature check stays off until releases are signed; see docs/CODE_SIGNING_POLICY.md.
        updater = autoUpdater;
      }
      const service = new AppService(repo, platform, {
        version: app.getVersion(),
        analyticsAvailable: analytics.available,
        get updates() {
          return updates;
        },
        track: (event, props) => analytics.track(event, props),
        gameIcon: (game) => icons.dataUrl(game),
        fileIcon: async (file) => {
          try {
            const image = await app.getFileIcon(file, { size: "normal" });
            return image.isEmpty() ? null : image.toDataURL();
          } catch {
            return null;
          }
        },
        pruneIcons: (games) => icons.prune(games),
        startupSupported: app.isPackaged,
        setStartup: (enabled) => {
          if (!app.isPackaged) {
            if (enabled)
              throw new Error(
                "Launch at sign-in is available in the installed app.",
              );
            return;
          }
          // --hidden: the sign-in launch goes straight to the tray.
          app.setLoginItemSettings({ openAtLogin: enabled, args: [hiddenArg] });
        },
        // Read back so the toggle follows changes made in Task Manager > Startup (also entries from before --hidden).
        startupEnabled: () =>
          app.isPackaged &&
          (app.getLoginItemSettings({ args: [hiddenArg] }).openAtLogin ||
            app.getLoginItemSettings().openAtLogin),
        // Fixed path, no renderer input; ShellExecute handles rstrui's own elevation.
        openSystemRestore: async () =>
          process.platform === "win32" &&
          (await shell.openPath(
            path.join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "rstrui.exe",
            ),
          )) === "",
        openSettings: async (page) => {
          if (process.platform !== "win32") return false;
          const target = settingsTarget(page, process.env.SystemRoot);
          if ("file" in target)
            return (await shell.openPath(target.file)) === "";
          await shell.openExternal(target.uri);
          return true;
        },
        // The URL comes from a fixed table keyed by vendor name, never from the window.
        openDriverPage: async (vendor) => {
          await shell.openExternal(driverPages[vendor]);
          return true;
        },
        saveFile: async (suggestedName, text) => {
          if (!window) return null;
          const result = await dialog.showSaveDialog(window, {
            title: "Save benchmark report",
            defaultPath: suggestedName,
          });
          if (result.canceled || !result.filePath) return null;
          writeFileSync(result.filePath, text, "utf8");
          return result.filePath;
        },
        detectGames: () =>
          detectInstalledGames({}, (progress) => {
            // A window closed mid-scan must not fail the scan.
            try {
              if (window && !window.isDestroyed())
                window.webContents.send(
                  "frameforge:event",
                  EventSchema.parse({ type: "scan-progress", ...progress }),
                );
            } catch {
              /* progress is best effort */
            }
          }),
        scanFolder: async () => {
          if (!window) return null;
          const result = await dialog.showOpenDialog(window, {
            title: "Choose a folder that contains games",
            properties: ["openDirectory"],
          });
          if (result.canceled || !result.filePaths[0]) return null;
          return scanGameFolder(result.filePaths[0]);
        },
        hotkeyStatus:
          process.platform === "win32"
            ? () => ({ failed: hotkeys?.failed ?? [] })
            : undefined,
        notify: (event) => {
          if (window && !window.isDestroyed())
            window.webContents.send("frameforge:event", event);
          if (event.type === "boost") {
            logBoost(event.session);
            onBoost(event.session);
          }
          // A game that is not in the library: a notification that opens the window. Adding it is the user's decision there.
          if (
            event.type === "smart" &&
            event.status.candidate &&
            repo.state().settings.notifications &&
            Notification.isSupported() &&
            !(window?.isVisible() && window.isFocused())
          ) {
            const toast = new Notification({
              title: "Frameforge",
              body: `${event.status.candidate.name} looks like a game. Add it to your library?`,
            });
            toast.on("click", () => showWindow());
            toast.show();
          }
          if (event.type === "fps") {
            lastFps = event.status;
            syncOverlay();
          }
        },
        diagnostics: {
          logsDir,
          redact,
          build: { packaged: String(app.isPackaged) },
          openLogs: async () => {
            mkdirSync(logsDir, { recursive: true });
            return (await shell.openPath(logsDir)) === "";
          },
          // Fixed GitHub new-issue page only; the service builds the URL from version and Windows build.
          openIssue: async (url) => {
            if (!allowedIssueUrl(url)) return false;
            await shell.openExternal(url);
            return true;
          },
          saveZip: async (defaultName, data) => {
            if (!window) return null;
            const result = await dialog.showSaveDialog(window, {
              title: "Save Frameforge diagnostics",
              defaultPath: path.join(app.getPath("documents"), defaultName),
              filters: [{ name: "Zip archive", extensions: ["zip"] }],
            });
            if (result.canceled || !result.filePath) return null;
            const file = validZipPath(result.filePath);
            if (!file)
              throw new Error("Choose a local folder and a .zip file name.");
            await writeFile(file, data);
            log(
              "info",
              "diagnostics",
              `Diagnostics zip saved (${data.length} bytes)`,
            );
            return path.basename(file);
          },
        },
        pickExecutable: async (game) => {
          if (!window) return null;
          const result = await dialog.showOpenDialog(window, {
            title: `Choose the executable of ${game.name}`,
            defaultPath: game.path || undefined,
            properties: ["openFile"],
            filters: [{ name: "Windows executable", extensions: ["exe"] }],
          });
          if (result.canceled || !result.filePaths[0]) return null;
          return safeExecutable(result.filePaths[0]);
        },
        pickGame: async () => {
          if (!window) return null;
          const result = await dialog.showOpenDialog(window, {
            title: "Add a game executable",
            properties: ["openFile"],
            filters: [{ name: "Windows executable", extensions: ["exe"] }],
          });
          if (result.canceled || !result.filePaths[0]) return null;
          const selected = await safeExecutable(result.filePaths[0]);
          return {
            id: randomUUID(),
            name: path.basename(selected, ".exe").slice(0, 80),
            path: path.dirname(selected),
            executablePath: selected,
            source: "custom",
            profile: "balanced",
            boostMode: "global",
            notes: "",
          };
        },
      });
      activeService = service;
      if (updater) {
        updates = new UpdateManager({
          updater: electronUpdater.autoUpdater,
          current: app.getVersion(),
          analyticsAvailable: analytics.available,
          boostActive: () => service.booster.active,
          autoCheck: () => repo.state().settings.updateCheck === true,
          notify: (status) => {
            logUpdate(status);
            window?.webContents.send(
              "frameforge:event",
              EventSchema.parse({ type: "update", status }),
            );
          },
        });
      }
      await service.refresh();
      // First run: one native dialog; both choices default to off and live in Settings > Privacy.
      if (!testMode && !repo.state().settings.privacyAsked) {
        const answer = await dialog.showMessageBox({
          type: "question",
          title: "Frameforge",
          message: "Check for updates automatically?",
          detail:
            "Update checks contact github.com only. You choose when to download and install. You can change this in Settings > Privacy." +
            (analytics.available
              ? "\n\nAnonymous usage statistics are never sent unless you tick the box below."
              : ""),
          buttons: ["Yes", "No"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
          ...(analytics.available
            ? {
                checkboxLabel:
                  "Share anonymous usage statistics to help improve Frameforge",
                checkboxChecked: false,
              }
            : {}),
        });
        const state = repo.state();
        repo.updateState({
          ...state,
          settings: {
            ...state.settings,
            privacyAsked: true,
            updateCheck: answer.response === 0,
            analytics: analytics.available && answer.checkboxChecked,
          },
        });
      }
      if (analytics.available) {
        const file = path.join(app.getPath("userData"), "last-version.txt");
        const last = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
        analytics.track("app_started", {
          version: app.getVersion(),
          os_build: os.release().split(".")[2] ?? "0",
        });
        if (last && last !== app.getVersion())
          analytics.track("update_installed", { version: app.getVersion() });
        writeFileSync(file, app.getVersion());
      }
      updates?.start();
      // GC-10: revert a boost interrupted by a crash or power loss (conflict-aware).
      await service.booster.recoverAtStartup().catch(() => null);
      ipcMain.handle(
        "frameforge:request",
        async (event, method: unknown, input: unknown) => {
          try {
            if (
              !window ||
              event.sender.id !== window.webContents.id ||
              event.senderFrame !== window.webContents.mainFrame ||
              !trustedUrl(event.senderFrame.url)
            )
              throw new Error("Untrusted renderer");
            const data = await service.dispatch(method, input);
            // Saved or restored settings may change the hotkeys.
            if (method === "settings" || method === "restore")
              hotkeys?.apply(repo.state().settings.hotkeys);
            refreshTray();
            syncOverlay();
            return { ok: true, data };
          } catch (error) {
            log(
              "error",
              "ipc",
              `${typeof method === "string" ? method.slice(0, 40) : "?"} failed: ${error instanceof Error ? error.message : "unknown error"}`,
            );
            return {
              ok: false,
              error: {
                code: "REQUEST_FAILED",
                message:
                  error instanceof Error && error.name !== "ZodError"
                    ? error.message.slice(0, 1000)
                    : "Invalid request. Check the selected values and retry.",
              },
            };
          }
        },
      );
      function createWindow() {
        Menu.setApplicationMenu(null);
        window = new BrowserWindow({
          autoHideMenuBar: true,
          width: 1360,
          height: 920,
          minWidth: 720,
          minHeight: 600,
          backgroundColor: "#101112",
          title: "Frameforge",
          icon: path.join(here, "../../dist/icon.png"),
          webPreferences: {
            preload: path.join(here, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
          },
        });
        // Renderer errors reach main.log; render crashes too.
        window.webContents.on("console-message", (event) => {
          if (event.level === "error")
            log(
              "error",
              "renderer",
              `${event.message} (${path.basename(event.sourceId)}:${event.lineNumber})`,
            );
        });
        window.webContents.on("render-process-gone", (_event, details) =>
          log("error", "renderer", `Renderer process gone: ${details.reason}`),
        );
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event, url) => {
          if (!trustedUrl(url)) event.preventDefault();
        });
        window.webContents.session.setPermissionRequestHandler(
          (_contents, _permission, callback) => callback(false),
        );
        window.on("close", (event) => {
          if (service.isBusy) {
            event.preventDefault();
            void dialog.showMessageBox(window!, {
              type: "info",
              message: "Wait for the operation or cancel it before closing.",
            });
          } else {
            const decision = closeDecision(
              keepRunning(),
              repo.state().settings.closeAction,
              leaving,
            );
            if (decision === "tray") {
              // The window is destroyed (not hidden) so only the main process stays in memory.
              noticeOnce();
            } else if (decision === "quit") {
              event.preventDefault();
              void requestQuit();
            } else if (decision === "ask") {
              event.preventDefault();
              void askOnClose();
            }
          }
        });
        // Minimized or hidden windows read nothing; the helper starts again when the window returns.
        window.on("minimize", () => service.monitor.suspend());
        window.on("hide", () => service.monitor.suspend());
        window.on("restore", () => service.monitor.resume());
        window.on("show", () => service.monitor.resume());
        window.on("closed", () => {
          // No window, no live counters.
          service.monitor.stop();
          void service.fps.stop().catch(() => null);
          // The overlay must not keep a quit-on-close app alive.
          if (!keepRunning()) disposeOverlay();
          window = null;
        });
        // Background scan once the UI is up; due-ness (first launch / interval / setting) is decided in the service.
        window.webContents.once("did-finish-load", () => {
          setTimeout(() => void service.autoScan(), 1500);
        });
        if (dev) void window.loadURL(allowedUrl);
        else void window.loadFile(rendererFile);
      }
      const keepRunning = () => repo.state().settings.keepRunning;
      // Quit fully exits; a live boost is restored first (before-quit does that), after a confirmation.
      const requestQuit = async () => {
        if (service.booster.active) {
          const answer = await dialog.showMessageBox({
            type: "question",
            title: "Frameforge",
            message: "A boost is active. Quit Frameforge?",
            detail: "Your Windows settings are restored first.",
            buttons: ["Restore and quit", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
          });
          if (answer.response !== 0) return;
        }
        app.quit();
      };
      // First close: ask once; "Remember my choice" saves it in Settings > General.
      let asking = false;
      const askOnClose = async () => {
        if (asking || !window) return;
        asking = true;
        try {
          const answer = await dialog.showMessageBox(window, {
            type: "question",
            title: "Frameforge",
            message:
              "Keep Frameforge running in the tray so auto-boost can start when you launch a game?",
            detail: "You can change this in Settings > General.",
            buttons: ["Minimize to tray", "Quit Frameforge"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            checkboxLabel: "Remember my choice",
            checkboxChecked: true,
          });
          const toTray = answer.response === 0;
          if (answer.checkboxChecked) {
            const current = repo.state();
            repo.updateState({
              ...current,
              settings: {
                ...current.settings,
                closeAction: toTray ? "tray" : "quit",
              },
            });
            pushState();
          }
          if (toTray) {
            noticeOnce();
            window?.destroy();
          } else void requestQuit();
        } finally {
          asking = false;
        }
      };
      const noticeOnce = () => {
        if (repo.meta("background.noticed") || !Notification.isSupported())
          return;
        repo.setMeta("background.noticed", true);
        new Notification({ title: "Frameforge", body: trayNotice }).show();
      };
      showWindow = () => {
        if (!window) return createWindow();
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      };
      // Tray: always present (a few MB); the menu is rebuilt from saved state whenever something changes.
      const icon = nativeImage
        .createFromPath(path.join(here, "../../dist/icon.png"))
        .resize({ width: 16, height: 16 });
      const tray = new Tray(icon);
      tray.on("click", showWindow);
      const gameName = (id: string) =>
        repo.state().games.find((g) => g.id === id)?.name;
      // Overlay counters are their own helper process, separate from the Monitor page's, and run only while the overlay is on screen.
      let sample: MonitorSample | null = null;
      const counters = new MonitorService(platform, (event: AppEvent) => {
        if (event.type === "monitor") sample = event.sample;
      });
      const overlayPage = dev
        ? { url: `${allowedUrl}overlay.html` }
        : { file: path.join(here, "../../dist/overlay.html") };
      const overlay = new OverlayManager({
        createWindow: (rect, scale) =>
          createOverlayWindow(
            { preload: path.join(here, "overlayPreload.cjs"), ...overlayPage },
            rect,
            scale,
          ),
        // The game owns the cursor while playing, so the display under it is the game's.
        gameDisplay: () =>
          screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds,
        settings: () => repo.state().settings,
        boostLive: () => service.booster.active,
        fps: () => lastFps,
        startCapture: () => {
          const id = service.booster.liveSession?.gameId;
          if (id) void service.fps.start(id).catch(() => null);
        },
        counters: {
          start: () => void counters.start(),
          stop: () => {
            counters.stop();
            sample = null;
          },
          last: () => sample,
        },
      });
      syncOverlay = () => overlay.sync();
      disposeOverlay = () => overlay.dispose();
      toggleOverlay = () => {
        overlay.toggle();
        refreshTray();
      };
      refreshTray = () => {
        const state = repo.state();
        const session = service.booster.active
          ? service.booster.liveSession
          : null;
        const model = trayModel(
          {
            autoBoost: state.booster.autoBoost,
            mode: state.booster.mode,
            session,
            gameName: session ? gameName(session.gameId) : undefined,
            overlay: overlay.shown,
          },
          {
            open: showWindow,
            toggleOverlay: () => toggleOverlay(),
            toggleAutoBoost: () => {
              // Pushes the new state to an open window right away.
              const current = repo.state();
              repo.updateState({
                ...current,
                booster: {
                  ...current.booster,
                  autoBoost: !current.booster.autoBoost,
                },
              });
              service.booster.configure();
              refreshTray();
              pushState();
            },
            stopBoost: () =>
              void service.booster
                .stop()
                .catch(() => null)
                .finally(pushState),
            checkUpdates: updates
              ? () => {
                  showWindow();
                  void updates!.check();
                }
              : undefined,
            quit: () => void requestQuit(),
          },
        );
        tray.setToolTip(model.tooltip);
        tray.setContextMenu(
          Menu.buildFromTemplate(
            model.items.map((i) =>
              i.type === "separator"
                ? { type: "separator" as const }
                : {
                    label: i.label,
                    enabled: i.enabled,
                    ...(i.checked !== undefined && {
                      type: "checkbox" as const,
                      checked: i.checked,
                    }),
                    click: i.click,
                  },
            ),
          ),
        );
      };
      const pushState = () => {
        if (window && !window.isDestroyed())
          window.webContents.send("frameforge:event", { type: "state" });
      };
      const notices = new BoostNotices();
      onBoost = (session) => {
        refreshTray();
        syncOverlay();
        const notice = notices.next(
          session,
          gameName(session.gameId) ?? "game",
        );
        if (
          notice &&
          repo.state().settings.notifications &&
          Notification.isSupported() &&
          !(window?.isVisible() && window.isFocused())
        )
          new Notification(notice).show();
      };
      service.booster.configure();
      refreshTray();
      if (process.platform === "win32") {
        const flash = (
          text: string,
          click?: { label: string; run: () => void },
        ) => {
          tray.setToolTip(`Frameforge: ${text}`);
          setTimeout(refreshTray, 4000).unref();
          if (!Notification.isSupported()) return;
          const n = new Notification({
            title: "Frameforge",
            body: text,
            silent: true,
            actions: click ? [{ type: "button", text: click.label }] : [],
          });
          if (click) {
            n.on("action", click.run);
            n.on("click", click.run);
          }
          n.show();
        };
        hotkeys = new HotkeyManager(
          globalShortcut,
          hotkeyActions({
            state: () => repo.state(),
            foreground: foregroundWindow,
            running: (games) => platform.runningGames(games),
            live: () => service.booster.active,
            start: (id, target, skipAdmin) =>
              service.booster.start(id, "manual", target, skipAdmin),
            stop: () => service.booster.stop().finally(pushState),
            setMode: (mode) => {
              const current = repo.state();
              repo.updateState({
                ...current,
                booster: { ...current.booster, mode },
              });
              service.booster.configure();
              refreshTray();
              pushState();
            },
            addGame: async (exe) => {
              const selected = await safeExecutable(exe);
              const current = repo.state();
              if (
                current.games.some(
                  (g) =>
                    g.executablePath?.toLowerCase() === selected.toLowerCase(),
                )
              )
                return;
              repo.updateState({
                ...current,
                games: [
                  ...current.games,
                  {
                    id: randomUUID(),
                    name: path.basename(selected, ".exe").slice(0, 80),
                    path: path.dirname(selected),
                    executablePath: selected,
                    source: "custom",
                    profile: "balanced",
                    boostMode: "global",
                    notes: "",
                  },
                ],
              });
              service.booster.configure();
              pushState();
              flash(`${path.basename(selected, ".exe")} added to your library`);
            },
            toggleOverlay: () => {
              if (!overlayHook.toggle) return false;
              overlayHook.toggle();
              return true;
            },
            notify: flash,
            own: {
              exe: process.execPath,
              systemRoot: process.env.SystemRoot ?? "C:\\Windows",
            },
          }),
        );
        hotkeys.apply(repo.state().settings.hotkeys);
      }
      if (app.isPackaged)
        migrateLoginItem({
          enabled: (hidden) =>
            app.getLoginItemSettings(hidden ? { args: [hiddenArg] } : {})
              .openAtLogin,
          register: () =>
            app.setLoginItemSettings({
              openAtLogin: true,
              args: [hiddenArg],
            }),
        });
      if (testHooksEnabled(process.env, app.isPackaged))
        exposeTestHooks(tray, service, repo, overlay);
      // Signed in at boot (--hidden): no window until the tray asks for one.
      if (!startsHidden(process.argv, keepRunning())) createWindow();
      app.on("activate", () => {
        if (!window) createWindow();
      });
    } catch (error) {
      log("error", "app", error instanceof Error ? error : "startup failed");
      dialog.showErrorBox(
        "Frameforge could not start",
        "Local data or startup initialization failed. Existing data has been preserved.",
      );
      app.quit();
    }
  });
  // Closing the last window quits only when "Keep running in the background" is off.
  app.on("window-all-closed", () => {
    if (!repo || !repo.state().settings.keepRunning) app.quit();
  });
  let quitting = false;
  app.on("before-quit", (event) => {
    log("info", "app", "Quitting");
    // Keep installation disarmed through refused quits and boost restoration.
    if (updater) updater.autoInstallOnAppQuit = false;
    if (activeService?.isBusy) event.preventDefault();
    else if (activeService?.booster.active && !quitting) {
      leaving = true;
      // Revert the live boost session before exiting; app.quit() re-enters once it has ended.
      event.preventDefault();
      quitting = true;
      void activeService.shutdown().finally(() => app.quit());
    } else {
      leaving = true;
      updates?.prepareQuit(repo?.state().settings.updateAutoInstall === true);
      updates?.stop();
      void activeService?.shutdown();
    }
  });
  app.on("will-quit", () => {
    hotkeys?.dispose();
    repo?.close();
  });
}
// Only with FRAMEFORGE_TEST_MODE: lets the desktop smoke test (Playwright app.evaluate) look at the tray and add a dummy library game.
function exposeTestHooks(
  tray: Tray,
  service: AppService,
  store: Repository,
  overlay: OverlayManager,
) {
  Object.assign(globalThis, {
    __frameforgeTest: {
      overlayOn: (enabled: boolean) => {
        const state = store.state();
        store.updateState({
          ...state,
          settings: {
            ...state.settings,
            overlay: { ...state.settings.overlay, enabled } as never,
          },
        });
        overlay.sync();
      },
      toggleOverlay: () => overlay.toggle(),
      // Feeds the overlay a capture-like status so a screenshot can show the FPS layout.
      fakeFps: (fps: number) => {
        lastFps = {
          state: "capturing",
          fps,
          low1Fps: Math.round(fps * 0.62),
          frameTimes: Array.from(
            { length: 60 },
            (_, i) => 1000 / fps + (i % 9 === 0 ? 6 : Math.sin(i) * 1.5),
          ),
        } as FpsStatus;
        overlay.sync();
      },
      overlay: () => {
        const win = BrowserWindow.getAllWindows().find((w) =>
          overlayInfo.has(w),
        );
        return win
          ? {
              alwaysOnTop: win.isAlwaysOnTop(),
              focusable: win.isFocusable(),
              ignoreMouse: overlayInfo.get(win)!.ignoreMouse,
              level: overlayInfo.get(win)!.alwaysOnTopLevel,
              visible: win.isVisible(),
              bounds: win.getBounds(),
            }
          : null;
      },
      tray: () => !tray.isDestroyed(),
      windows: () =>
        BrowserWindow.getAllWindows().filter((w) => !overlayInfo.has(w)).length,
      active: () => service.booster.active,
      session: () => service.booster.liveSession,
      watching: () => service.booster.watching,
      hotkeys: () => ({
        registered: hotkeys?.registered ?? [],
        failed: hotkeys?.failed ?? [],
        // Windows itself agrees the accelerators are registered.
        os: (hotkeys?.registered ?? []).every((id) =>
          globalShortcut.isRegistered(
            store.state().settings.hotkeys.bindings[id],
          ),
        ),
      }),
      monitoring: () => service.monitor.active,
      closeWindow: () =>
        BrowserWindow.getAllWindows()
          .find((w) => !overlayInfo.has(w))
          ?.close(),
      openWindow: () => showWindow(),
      stop: () => service.booster.stop(),
      // A custom mode with only a High priority, so the test changes nothing else on the PC.
      addGame: (exe: string) => {
        const state = store.state();
        store.updateState({
          ...state,
          booster: {
            ...state.booster,
            autoBoost: true,
            custom: { ...state.booster.custom, priority: "High" },
          },
          games: [
            ...state.games,
            {
              id: randomUUID(),
              name: path.basename(exe, ".exe"),
              path: path.dirname(exe),
              executablePath: exe,
              source: "custom",
              profile: "balanced",
              boostMode: "custom",
              notes: "",
            },
          ],
        });
        service.booster.configure();
      },
    },
  });
}
