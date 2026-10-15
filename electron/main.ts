import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
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
import { EventSchema, type BoostSession } from "../shared/contracts.js";
import { settingsTarget } from "./settingsPages.js";
import { driverPages } from "../shared/drivers.js";
import { userDataOverride } from "./userData.js";
import { GameIcons, maxIconBytes } from "./icons.js";
import { UpdateManager } from "./updater.js";
import { Analytics, validAppKey } from "./analytics.js";
import {
  BoostNotices,
  closeToTray,
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
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(async () => {
    try {
      mkdirSync(app.getPath("userData"), { recursive: true });
      repo = new Repository(
        path.join(app.getPath("userData"), "frameforge.db"),
      );
      repo.recoverInterrupted();
      const helper = app.isPackaged
        ? path.join(process.resourcesPath, "windows", "Frameforge.Windows.exe")
        : path.join(here, "../../windows/publish/Frameforge.Windows.exe");
      const platform =
        process.platform === "win32" && existsSync(helper)
          ? new WindowsPlatform(helper)
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
        notify: (event) => {
          if (window && !window.isDestroyed())
            window.webContents.send("frameforge:event", event);
          if (event.type === "boost") onBoost(event.session);
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
          notify: (status) =>
            window?.webContents.send(
              "frameforge:event",
              EventSchema.parse({ type: "update", status }),
            ),
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
            refreshTray();
            return { ok: true, data };
          } catch (error) {
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
          } else if (closeToTray(keepRunning(), leaving)) {
            // The window is destroyed (not hidden) so only the main process stays in memory.
            noticeOnce();
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
          },
          {
            open: showWindow,
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
            quit: () => app.quit(),
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
        exposeTestHooks(tray, service, repo);
      // Signed in at boot (--hidden): no window until the tray asks for one.
      if (!startsHidden(process.argv, keepRunning())) createWindow();
      app.on("activate", () => {
        if (!window) createWindow();
      });
    } catch {
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
  app.on("will-quit", () => repo?.close());
}
// Only with FRAMEFORGE_TEST_MODE: lets the desktop smoke test (Playwright app.evaluate) look at the tray and add a dummy library game.
function exposeTestHooks(tray: Tray, service: AppService, store: Repository) {
  Object.assign(globalThis, {
    __frameforgeTest: {
      tray: () => !tray.isDestroyed(),
      windows: () => BrowserWindow.getAllWindows().length,
      active: () => service.booster.active,
      session: () => service.booster.liveSession,
      watching: () => service.booster.watching,
      monitoring: () => service.monitor.active,
      closeWindow: () => BrowserWindow.getAllWindows()[0]?.close(),
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
