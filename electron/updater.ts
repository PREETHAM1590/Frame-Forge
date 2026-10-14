import type { UpdateStatus } from "../shared/contracts.js";

/** The subset of electron-updater's AppUpdater used here, so tests can pass a fake. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(silent?: boolean, forceRunAfter?: boolean): void;
}

const hours6 = 6 * 60 * 60 * 1000;

/** Release notes arrive as HTML (GitHub body) or a list; the UI only ever gets plain text. */
export function notesToText(notes: unknown): string {
  const raw = Array.isArray(notes)
    ? notes
        .map((n) =>
          n && typeof n === "object" && "note" in n
            ? String((n as { note: unknown }).note ?? "")
            : "",
        )
        .join("\n\n")
    : typeof notes === "string"
      ? notes
      : "";
  return raw
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|li|h[1-6]|div)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 8000);
}

export interface UpdateManagerOptions {
  updater: UpdaterLike | null;
  current: string;
  analyticsAvailable: boolean;
  /** A boost session is live: never install, and skip background checks. */
  boostActive: () => boolean;
  /** Setting: check automatically (startup and every 6 hours). */
  autoCheck: () => boolean;
  notify: (status: UpdateStatus) => void;
  intervalMs?: number;
}

export class UpdateManager {
  private s: UpdateStatus;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private o: UpdateManagerOptions) {
    this.s = {
      state: o.updater ? "idle" : "unsupported",
      current: o.current,
      version: null,
      notes: "",
      percent: 0,
      error: "",
      installOnQuit: false,
      analyticsAvailable: o.analyticsAvailable,
    };
    const u = o.updater;
    if (!u) return;
    u.autoDownload = false;
    u.autoInstallOnAppQuit = false;
    u.on("update-available", ((info: {
      version: string;
      releaseNotes?: unknown;
    }) =>
      this.set({
        state: "available",
        version: String(info.version).slice(0, 40),
        notes: notesToText(info.releaseNotes),
        error: "",
      })) as never);
    u.on("update-not-available", (() =>
      this.set({ state: "none", error: "" })) as never);
    u.on("download-progress", ((p: { percent: number }) =>
      this.set({
        state: "downloading",
        percent: Math.max(0, Math.min(100, Math.round(p.percent))),
      })) as never);
    u.on("update-downloaded", (() =>
      this.set({ state: "downloaded", percent: 100 })) as never);
    u.on("error", ((e: unknown) =>
      this.set({
        state: "error",
        error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
      })) as never);
  }
  private get state(): UpdateStatus["state"] {
    return this.s.state;
  }
  get status() {
    return this.s;
  }
  private set(patch: Partial<UpdateStatus>) {
    this.s = { ...this.s, ...patch };
    this.o.notify(this.s);
  }
  /** Startup check (if allowed) and every 6 hours while running. */
  start() {
    if (!this.o.updater) return;
    const tick = () => {
      if (this.o.autoCheck() && !this.o.boostActive()) void this.check();
    };
    tick();
    this.timer = setInterval(tick, this.o.intervalMs ?? hours6);
    this.timer.unref?.();
  }
  stop() {
    clearInterval(this.timer);
  }
  async check() {
    const u = this.o.updater;
    if (!u) return this.s;
    if (this.s.state === "checking" || this.s.state === "downloading")
      return this.s;
    if (this.s.state === "downloaded") return this.s;
    this.set({ state: "checking", error: "" });
    try {
      await u.checkForUpdates();
    } catch (e) {
      // The "error" event usually fires too; make sure a thrown check never leaves "checking".
      if (this.state === "checking")
        this.set({
          state: "error",
          error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        });
    }
    // A resolved check with no event (nothing newer) is reported by "update-not-available".
    return this.s;
  }
  async download() {
    const u = this.o.updater;
    if (!u || this.s.state !== "available") return this.s;
    this.set({ state: "downloading", percent: 0, error: "" });
    try {
      await u.downloadUpdate();
    } catch (e) {
      if (this.state === "downloading")
        this.set({
          state: "error",
          error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
        });
    }
    return this.s;
  }
  install(when: "now" | "onQuit") {
    const u = this.o.updater;
    if (!u || this.s.state !== "downloaded")
      throw new Error("There is no downloaded update to install.");
    if (when === "onQuit") {
      // Only arm the installer at an actual quit, after boost cleanup. Closing to the tray is not a quit.
      this.set({ installOnQuit: true });
      return this.s;
    }
    if (this.o.boostActive())
      throw new Error(
        "Game Mode is running. Stop the session first, or choose Install when I quit.",
      );
    u.quitAndInstall(false, true);
    return this.s;
  }
  prepareQuit(autoInstall: boolean) {
    if (this.o.updater)
      this.o.updater.autoInstallOnAppQuit =
        !this.o.boostActive() && (autoInstall || this.s.installOnQuit);
  }
}
