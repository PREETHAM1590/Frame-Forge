import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  ipcMain,
  nativeImage,
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
import { EventSchema } from "../shared/contracts.js";
import { settingsTarget } from "./settingsPages.js";
import { userDataOverride } from "./userData.js";
import { GameIcons, maxIconBytes } from "./icons.js";
import { UpdateManager } from "./updater.js";
import { Analytics, validAppKey } from "./analytics.js";
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
let tray: Tray | null = null;
let updates: UpdateManager | undefined;
let updater: { autoInstallOnAppQuit: boolean } | undefined;
let repo: Repository;
let activeService: AppService | undefined;
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
  app.on("second-instance", () => {
    window?.restore();
    window?.focus();
  });
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
          app.setLoginItemSettings({ openAtLogin: enabled });
        },
        // Read back so the toggle follows changes made in Task Manager > Startup.
        startupEnabled: () =>
          app.isPackaged && app.getLoginItemSettings().openAtLogin,
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
        notify: (event) => window?.webContents.send("frameforge:event", event),
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
          defaultId: 0,
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
            return { ok: true, data: await service.dispatch(method, input) };
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
          }
        });
        window.on("closed", () => {
          window = null;
        });
        // Background scan once the UI is up; due-ness (first launch / interval / setting) is decided in the service.
        window.webContents.once("did-finish-load", () => {
          setTimeout(() => void service.autoScan(), 1500);
        });
        if (dev) void window.loadURL(allowedUrl);
        else void window.loadFile(rendererFile);
      }
      createWindow();
      if (!testMode) {
        try {
          tray = new Tray(
            nativeImage
              .createFromPath(path.join(here, "../../dist/icon.png"))
              .resize({ width: 16, height: 16 }),
          );
          tray.setToolTip("Frameforge");
          const show = () => {
            if (!window) createWindow();
            window?.show();
            window?.focus();
          };
          tray.on("click", show);
          tray.setContextMenu(
            Menu.buildFromTemplate([
              { label: "Open Frameforge", click: show },
              {
                label: "Check for updates",
                enabled: !!updates,
                click: () => {
                  show();
                  void updates?.check();
                },
              },
              { type: "separator" },
              { label: "Quit", click: () => app.quit() },
            ]),
          );
        } catch {
          /* the tray is a convenience */
        }
      }
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
  app.on("window-all-closed", () => app.quit());
  let quitting = false;
  app.on("before-quit", (event) => {
    // "Install when I quit" (this update or the setting); electron-updater reads the flag at quit time.
    if (updater && repo)
      updater.autoInstallOnAppQuit =
        repo.state().settings.updateAutoInstall === true ||
        updates?.status.installOnQuit === true;
    if (activeService?.isBusy) event.preventDefault();
    else if (activeService?.booster.active && !quitting) {
      // Revert the live boost session before exiting; app.quit() re-enters once it has ended.
      event.preventDefault();
      quitting = true;
      void activeService.shutdown().finally(() => app.quit());
    } else activeService?.booster.dispose();
  });
  app.on("will-quit", () => repo?.close());
}
