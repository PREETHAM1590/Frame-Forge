// The overlay's BrowserWindow: transparent, always on top, click-through, never focused. No injection or hooks into any game.
import { BrowserWindow } from "electron";
import type { OverlayWindow } from "./overlay.js";
import type { Rect } from "../shared/overlay.js";

export interface OverlayPage {
  preload: string;
  /** Dev server URL or built file; only this page is ever loaded. */
  url?: string;
  file?: string;
}
export const overlayInfo = new Map<
  BrowserWindow,
  { ignoreMouse: boolean; alwaysOnTopLevel: string }
>();

export function createOverlayWindow(
  page: OverlayPage,
  rect: Rect,
  scale: number,
): OverlayWindow & { raw: BrowserWindow } {
  const win = new BrowserWindow({
    ...rect,
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    title: "Frameforge overlay",
    webPreferences: {
      preload: page.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  // Above borderless and windowed games (and the taskbar); exclusive-fullscreen DirectX may still cover it.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true, { forward: true });
  overlayInfo.set(win, { ignoreMouse: true, alwaysOnTopLevel: "screen-saver" });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_c, _p, callback) =>
    callback(false),
  );
  const zoom = (s: number) => win.webContents.setZoomFactor(s);
  win.webContents.once("did-finish-load", () => {
    if (win.isDestroyed()) return;
    zoom(scale);
    win.showInactive();
  });
  if (page.url) void win.loadURL(page.url);
  else if (page.file) void win.loadFile(page.file);
  return {
    raw: win,
    place(next, s) {
      if (win.isDestroyed()) return;
      win.setBounds(next);
      zoom(s);
    },
    send(model) {
      if (!win.isDestroyed() && !win.webContents.isLoading())
        win.webContents.send("overlay:model", model);
    },
    destroy() {
      overlayInfo.delete(win);
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
