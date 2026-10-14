import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildModel,
  defaultOverlay,
  fpsHint,
  overlayRect,
  overlayVisible,
  resolveOverlay,
} from "../shared/overlay";
import { OverlayManager, type OverlayDeps } from "../electron/overlay";
import { SettingsSchema, defaultState } from "../shared/contracts";
import { trayModel } from "../electron/background";

const capturing = {
  state: "capturing" as const,
  fps: 143.6,
  low1Fps: 90.2,
  frameTimes: Array.from({ length: 100 }, (_, i) => 5 + (i % 7)),
};
const adapter = (engine3d: number) => ({
  id: "a",
  engine3d,
  compute: 0,
  copy: 0,
  video: 0,
  dedicatedBytes: 0,
  sharedBytes: 0,
});
const sample = {
  cpu: { total: 41.6, cores: [] },
  memory: { totalBytes: 16e9, availableBytes: 4e9 },
  gpu: {
    available: true,
    detail: null,
    adapters: [adapter(20), adapter(77.4)],
  },
} as never;

describe("overlay config", () => {
  it("falls back to defaults for missing or unusable saved values", () => {
    expect(resolveOverlay(undefined)).toEqual(defaultOverlay);
    expect(resolveOverlay({ scale: 9 })).toEqual(defaultOverlay);
    expect(resolveOverlay({ corner: "bottom-right" }).corner).toBe(
      "bottom-right",
    );
    expect(defaultOverlay.enabled).toBe(false);
  });
  it("is optional in settings so older saved data and settings payloads stay valid", () => {
    const rest: Record<string, unknown> = { ...defaultState.settings };
    delete rest.overlay;
    expect(SettingsSchema.safeParse(rest).success).toBe(true);
    expect(
      SettingsSchema.safeParse({ ...rest, overlay: { opacity: 5 } }).success,
    ).toBe(false);
  });
});

describe("overlay placement and visibility", () => {
  const display = { x: 1920, y: 0, width: 2560, height: 1440 };
  it("anchors to the chosen corner of the game's display", () => {
    expect(overlayRect(display, "top-left", 1)).toMatchObject({
      x: 1936,
      y: 16,
    });
    const br = overlayRect(display, "bottom-right", 2);
    expect(br.x + br.width).toBe(1920 + 2560 - 16);
    expect(br.y + br.height).toBe(1440 - 16);
  });
  it("shows during a boost when enabled; the tray override wins either way", () => {
    const on = { ...defaultOverlay, enabled: true };
    expect(overlayVisible(on, true, null)).toBe(true);
    expect(overlayVisible(on, false, null)).toBe(false);
    expect(overlayVisible(defaultOverlay, true, null)).toBe(false);
    expect(overlayVisible(defaultOverlay, false, true)).toBe(true);
    expect(overlayVisible(on, true, false)).toBe(false);
  });
});

describe("overlay model", () => {
  const now = new Date(2026, 9, 15, 9, 5);
  it("shows live FPS, low, graph and system readings", () => {
    const m = buildModel(defaultOverlay, capturing, sample, now);
    expect(m).toMatchObject({
      fps: 144,
      low1: 90,
      hint: null,
      cpu: 42,
      gpu: 77,
      ram: 75,
      clock: null,
    });
    expect(m.graph).toHaveLength(60);
  });
  it("without a capture shows system readings and the FPS hint", () => {
    const m = buildModel(defaultOverlay, null, sample, now);
    expect(m).toMatchObject({ fps: null, low1: null, graph: null, cpu: 42 });
    expect(m.hint).toBe(fpsHint);
    expect(
      buildModel(
        { ...defaultOverlay, fps: false, low1: false, graph: false },
        null,
        null,
        now,
      ).hint,
    ).toBeNull();
  });
  it("leaves unmeasured values null and adds the clock only when asked", () => {
    const m = buildModel(
      { ...defaultOverlay, clock: true },
      capturing,
      null,
      now,
    );
    expect([m.cpu, m.gpu, m.ram]).toEqual([null, null, null]);
    expect(m.clock).toMatch(/\d/);
  });
});

function harness(settings: Record<string, unknown> = {}) {
  const win = { place: vi.fn(), send: vi.fn(), destroy: vi.fn() };
  const state = {
    live: false,
    fps: null as never,
    settings: {
      ...defaultState.settings,
      overlay: { enabled: true },
      ...settings,
    },
  };
  const deps = {
    createWindow: vi.fn(() => win),
    gameDisplay: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    settings: () => state.settings as never,
    boostLive: () => state.live,
    fps: () => state.fps,
    startCapture: vi.fn(),
    counters: { start: vi.fn(), stop: vi.fn(), last: () => null },
  } satisfies OverlayDeps;
  return { win, state, deps, overlay: new OverlayManager(deps) };
}

describe("overlay lifecycle", () => {
  afterEach(() => vi.useRealTimers());
  it("creates the window when a boost starts and destroys it when it ends", () => {
    vi.useFakeTimers();
    const { overlay, state, deps, win } = harness();
    overlay.sync();
    expect(deps.createWindow).not.toHaveBeenCalled();
    state.live = true;
    overlay.sync();
    expect(deps.createWindow).toHaveBeenCalledOnce();
    expect(deps.counters.start).toHaveBeenCalledOnce();
    const sent = win.send.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(win.send.mock.calls.length).toBe(sent + 2);
    state.live = false;
    overlay.sync();
    expect(win.destroy).toHaveBeenCalledOnce();
    expect(deps.counters.stop).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2000);
    expect(win.send.mock.calls.length).toBe(sent + 2);
    expect(overlay.shown).toBe(false);
  });
  it("tray toggle shows and hides by hand, and a boost change hands control back to the setting", () => {
    const { overlay, state, deps } = harness({ overlay: { enabled: false } });
    overlay.toggle();
    expect(overlay.shown).toBe(true);
    overlay.toggle();
    expect(overlay.shown).toBe(false);
    expect(deps.createWindow).toHaveBeenCalledOnce();
    overlay.toggle();
    state.live = true;
    overlay.sync();
    expect(overlay.shown).toBe(false);
    overlay.dispose();
  });
  it("never opens an administrator prompt unless the user allowed them", () => {
    const off = harness();
    off.state.live = true;
    off.overlay.sync();
    expect(off.deps.startCapture).not.toHaveBeenCalled();
    off.overlay.dispose();
    const on = harness({ autoBoostAdmin: true });
    on.state.live = true;
    on.overlay.sync();
    on.overlay.sync();
    expect(on.deps.startCapture).toHaveBeenCalledOnce();
    on.overlay.dispose();
    const manual = harness({
      autoBoostAdmin: true,
      overlay: { enabled: false },
    });
    manual.overlay.toggle();
    expect(manual.deps.startCapture).not.toHaveBeenCalled();
    manual.overlay.dispose();
  });
  it("moves the window when the display, corner or size changes", () => {
    const { overlay, state, win } = harness();
    state.live = true;
    overlay.sync();
    overlay.sync();
    expect(win.place).not.toHaveBeenCalled();
    state.settings = {
      ...state.settings,
      overlay: { enabled: true, corner: "bottom-right" },
    } as never;
    overlay.sync();
    expect(win.place).toHaveBeenCalledOnce();
    overlay.dispose();
  });
});

describe("tray", () => {
  it("lists Toggle overlay, checked while the overlay is on", () => {
    const toggleOverlay = vi.fn();
    const base = { autoBoost: false, mode: "balanced" as const, session: null };
    const actions = {
      open() {},
      toggleAutoBoost() {},
      stopBoost() {},
      quit() {},
      toggleOverlay,
    };
    const find = (m: ReturnType<typeof trayModel>) =>
      m.items.find((i) => i.label === "Toggle overlay")!;
    expect(find(trayModel({ ...base, overlay: true }, actions)).checked).toBe(
      true,
    );
    const off = find(trayModel(base, actions));
    expect(off.checked).toBe(false);
    off.click!();
    expect(toggleOverlay).toHaveBeenCalled();
  });
});
