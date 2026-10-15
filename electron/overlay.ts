// In-game overlay lifecycle. The window exists only while it is shown; hiding destroys it (and the counter helper behind it).
import {
  buildModel,
  overlayRect,
  overlayVisible,
  resolveOverlay,
  type OverlayConfig,
  type Rect,
} from "../shared/overlay.js";
import type {
  FpsStatus,
  MonitorSample,
  Settings,
} from "../shared/contracts.js";

/** Text refreshes twice a second; the frame-time graph rides on the same message (well under the 10 Hz cap). */
export const overlayTickMs = 500;

export interface OverlayWindow {
  place(rect: Rect, scale: number): void;
  send(model: ReturnType<typeof buildModel>): void;
  destroy(): void;
}
export interface OverlayDeps {
  createWindow(rect: Rect, scale: number): OverlayWindow;
  /** Bounds of the display the game is on. */
  gameDisplay(): Rect;
  settings(): Settings;
  boostLive(): boolean;
  fps(): FpsStatus | null;
  /** Opens the FPS capture (one Windows administrator prompt). Only called when the user allowed admin prompts. */
  startCapture(): void;
  /** System counters, running only while the overlay is shown. */
  counters: { start(): void; stop(): void; last(): MonitorSample | null };
  now?: () => Date;
}

export class OverlayManager {
  private win: OverlayWindow | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private manual: boolean | null = null;
  private wasLive = false;
  private captureTried = false;
  private placed = "";
  constructor(private deps: OverlayDeps) {}
  private config(): OverlayConfig {
    return resolveOverlay(this.deps.settings().overlay);
  }
  get shown() {
    return this.win !== null;
  }
  /** Tray menu: flips what is on screen right now. */
  toggle() {
    this.manual = !this.win;
    this.sync();
  }
  /** Call whenever settings, the boost session or the capture may have changed. */
  sync() {
    const live = this.deps.boostLive();
    // The tray override lasts until the boost starts or ends; then the setting decides again.
    if (live !== this.wasLive) this.manual = null;
    this.wasLive = live;
    const want = overlayVisible(this.config(), live, this.manual);
    if (want && !this.win) this.show();
    else if (!want && this.win) this.hide();
    else if (this.win) this.tick();
  }
  private show() {
    const config = this.config();
    const rect = overlayRect(
      this.deps.gameDisplay(),
      config.corner,
      config.scale,
    );
    this.win = this.deps.createWindow(rect, config.scale);
    this.placed = JSON.stringify([rect, config.scale]);
    try {
      this.deps.counters.start();
    } catch {
      /* no helper (development build): the overlay still shows what it has */
    }
    this.timer = setInterval(() => this.tick(), overlayTickMs);
    this.timer.unref?.();
    // An automatic show may start the capture only when the user allowed administrator prompts in the background.
    const fps = this.deps.fps();
    if (
      this.manual === null &&
      this.deps.settings().autoBoostAdmin &&
      (config.fps || config.low1 || config.graph) &&
      !this.captureTried &&
      fps?.state !== "starting" &&
      fps?.state !== "capturing"
    ) {
      this.captureTried = true;
      this.deps.startCapture();
    }
    this.tick();
  }
  private hide() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.win?.destroy();
    this.win = null;
    this.captureTried = false;
    this.deps.counters.stop();
  }
  private tick() {
    if (!this.win) return;
    const config = this.config();
    const rect = overlayRect(
      this.deps.gameDisplay(),
      config.corner,
      config.scale,
    );
    const key = JSON.stringify([rect, config.scale]);
    if (key !== this.placed) {
      this.placed = key;
      this.win.place(rect, config.scale);
    }
    this.win.send(
      buildModel(
        config,
        this.deps.fps(),
        this.deps.counters.last(),
        (this.deps.now ?? (() => new Date()))(),
      ),
    );
  }
  dispose() {
    if (this.win) this.hide();
  }
}
