import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
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
let window: BrowserWindow | null = null;
let repo: Repository;
let activeService: AppService | undefined;
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
      const service = new AppService(repo, platform, {
        version: app.getVersion(),
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
            notes: "",
          };
        },
      });
      activeService = service;
      await service.refresh();
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
        window = new BrowserWindow({
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
        if (dev) void window.loadURL(allowedUrl);
        else void window.loadFile(rendererFile);
      }
      createWindow();
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
  app.on("before-quit", (event) => {
    if (activeService?.isBusy) event.preventDefault();
  });
  app.on("will-quit", () => repo?.close());
}
