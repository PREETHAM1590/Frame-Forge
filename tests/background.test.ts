import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { Repository } from "../electron/repository";
import {
  MockPlatform,
  type GameWatch,
  type RunningGame,
  type SessionChannel,
} from "../electron/platform";
import { BoostEngine } from "../electron/booster";
import {
  BoostNotices,
  closeToTray,
  migrateLoginItem,
  startsHidden,
  testHooksEnabled,
  trayModel,
} from "../electron/background";
import {
  GameSchema,
  type BoostSession,
  type ProcessTarget,
} from "../shared/contracts";

const target: ProcessTarget = {
  pid: 4242,
  startTime: "2026-10-14T10:00:00.0000000Z",
  executablePath: "C:/Games/Test/game.exe",
  name: "game",
  priority: "Normal",
};
class Helper extends EventEmitter implements SessionChannel {
  sent: Array<Record<string, unknown>> = [];
  send(command: unknown) {
    const c = command as { command: string };
    this.sent.push(c);
    queueMicrotask(() => {
      if (c.command === "start") this.emit("event", { event: "ready" });
      if (c.command === "stop")
        this.emit("event", { event: "ended", reason: "stop", reverts: [] });
    });
  }
  kill() {
    this.emit("exit");
  }
  gameExited() {
    this.emit("event", { event: "ended", reason: "game-exited", reverts: [] });
  }
}
class Fake extends MockPlatform {
  override boostAvailable = true;
  helpers: Helper[] = [];
  report: (found: RunningGame[]) => void = () => {};
  updates: string[][] = [];
  closed = 0;
  watchers = 0;
  watchGames(onRunning: (found: RunningGame[]) => void): GameWatch {
    this.watchers++;
    this.report = onRunning;
    return {
      update: (games) => this.updates.push(games.map((g) => g.id)),
      close: () => this.closed++,
    };
  }
  override spawnSession() {
    const h = new Helper();
    this.helpers.push(h);
    return h;
  }
}
function seed(opts: { autoBoost?: boolean; gameAuto?: boolean } = {}) {
  const repo = new Repository(":memory:");
  const game = GameSchema.parse({
    id: crypto.randomUUID(),
    name: "Test",
    path: "C:/Games/Test",
    executablePath: "C:/Games/Test/game.exe",
    source: "custom",
    profile: "gaming",
    notes: "",
    boostMode: "performance",
    autoBoost: opts.gameAuto,
  });
  const state = repo.state();
  repo.updateState({
    ...state,
    games: [game],
    booster: {
      ...state.booster,
      mode: "balanced",
      autoBoost: opts.autoBoost ?? true,
    },
  });
  const platform = new Fake();
  const sessions: BoostSession[] = [];
  const engine = new BoostEngine(repo, platform, (s) => sessions.push(s), {
    start: 1000,
    stop: 1000,
  });
  return { repo, game, platform, engine, sessions };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("auto-boost watcher", () => {
  it("starts the game's own mode when the watcher reports it, and reverts on exit", async () => {
    const { game, platform, engine, sessions } = seed();
    engine.configure();
    expect(platform.watchers).toBe(1);
    expect(platform.updates).toEqual([[game.id]]);
    platform.report([{ gameId: game.id, target }]);
    await settle();
    expect(engine.active).toBe(true);
    expect(sessions.at(-1)).toMatchObject({
      status: "active",
      mode: "performance",
      gameId: game.id,
    });
    platform.helpers[0]!.gameExited();
    await settle();
    expect(engine.active).toBe(false);
    expect(sessions.at(-1)?.status).toBe("ended");
    // The same running instance never starts a second session.
    platform.report([{ gameId: game.id, target }]);
    await settle();
    expect(platform.helpers).toHaveLength(1);
    // A new launch of the game does.
    platform.report([{ gameId: game.id, target: { ...target, pid: 4300 } }]);
    await settle();
    expect(platform.helpers).toHaveLength(2);
    engine.dispose();
  });

  it("does not watch when the global switch is off, and stops when it goes off", async () => {
    const off = seed({ autoBoost: false });
    off.engine.configure();
    expect(off.platform.watchers).toBe(0);
    expect(off.engine.watching).toBe(false);
    const on = seed();
    on.engine.configure();
    expect(on.engine.watching).toBe(true);
    const state = on.repo.state();
    on.repo.updateState({
      ...state,
      booster: { ...state.booster, autoBoost: false },
    });
    on.engine.configure();
    expect(on.platform.closed).toBe(1);
    expect(on.engine.watching).toBe(false);
  });

  it("leaves out a game whose own Auto-boost is off, and ignores a stale report for it", async () => {
    const { repo, game, platform, engine } = seed({ gameAuto: false });
    engine.configure();
    // Nothing eligible, so no helper process is kept at all.
    expect(platform.watchers).toBe(0);
    const state = repo.state();
    repo.updateState({
      ...state,
      games: state.games.map((g) => ({ ...g, autoBoost: true })),
    });
    engine.configure();
    expect(platform.watchers).toBe(1);
    repo.updateState({
      ...repo.state(),
      games: repo.state().games.map((g) => ({ ...g, autoBoost: false })),
    });
    platform.report([{ gameId: game.id, target }]);
    await settle();
    expect(platform.helpers).toHaveLength(0);
    engine.dispose();
  });

  it("tells the watcher when the library changes, and nothing when it does not", () => {
    const { repo, game, platform, engine } = seed();
    engine.configure();
    engine.configure();
    expect(platform.updates).toHaveLength(1);
    const extra = GameSchema.parse({
      ...game,
      id: crypto.randomUUID(),
      path: "C:/Games/Other",
      executablePath: "C:/Games/Other/o.exe",
    });
    repo.updateState({
      ...repo.state(),
      games: [...repo.state().games, extra],
    });
    engine.configure();
    expect(platform.updates).toHaveLength(2);
    engine.dispose();
    expect(platform.closed).toBe(1);
  });

  it("never asks for administrator approval in the background unless the user opted in", async () => {
    const quiet = seed();
    quiet.engine.configure();
    quiet.platform.report([{ gameId: quiet.game.id, target }]);
    await settle();
    expect(quiet.platform.helpers[0]!.sent[0]).toMatchObject({
      command: "start",
      unattended: true,
    });
    quiet.engine.dispose();
    const opted = seed();
    const state = opted.repo.state();
    opted.repo.updateState({
      ...state,
      settings: { ...state.settings, autoBoostAdmin: true },
    });
    opted.engine.configure();
    opted.platform.report([{ gameId: opted.game.id, target }]);
    await settle();
    expect(opted.platform.helpers[0]!.sent[0]).toMatchObject({
      unattended: false,
    });
    opted.engine.dispose();
  });

  it("starts a game that launched during another session once that one ends", async () => {
    vi.useFakeTimers();
    try {
      const { repo, game, platform, engine } = seed();
      const other = GameSchema.parse({
        ...game,
        id: crypto.randomUUID(),
        name: "Other",
        executablePath: "C:/Games/Other/o.exe",
      });
      repo.updateState({
        ...repo.state(),
        games: [...repo.state().games, other],
      });
      engine.configure();
      platform.report([{ gameId: game.id, target }]);
      await vi.advanceTimersByTimeAsync(50);
      expect(engine.active).toBe(true);
      // The second game starts while the first is boosted: ignored for now, remembered.
      platform.report([
        { gameId: game.id, target },
        { gameId: other.id, target: { ...target, pid: 77 } },
      ]);
      await vi.advanceTimersByTimeAsync(50);
      expect(platform.helpers).toHaveLength(1);
      platform.helpers[0]!.gameExited();
      await vi.advanceTimersByTimeAsync(3000);
      expect(platform.helpers).toHaveLength(2);
      engine.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("background mode helpers", () => {
  it("re-registers an old sign-in entry with --hidden, and only that", () => {
    const login = (plain: boolean, hidden: boolean) => {
      const register = vi.fn();
      const done = migrateLoginItem({
        enabled: (h) => (h ? hidden : plain),
        register,
      });
      return { done, register };
    };
    expect(login(true, false)).toMatchObject({ done: true });
    expect(login(true, false).register).toHaveBeenCalled();
    // Already hidden, or sign-in is off: left alone.
    expect(login(false, true).register).not.toHaveBeenCalled();
    expect(login(false, false).register).not.toHaveBeenCalled();
    expect(login(true, true).register).not.toHaveBeenCalled();
  });
  it("exposes test hooks only in test mode, and in a packaged build only when asked", () => {
    expect(testHooksEnabled({}, false)).toBe(false);
    expect(testHooksEnabled({ FRAMEFORGE_TEST_MODE: "1" }, false)).toBe(true);
    expect(testHooksEnabled({ FRAMEFORGE_TEST_MODE: "1" }, true)).toBe(false);
    expect(
      testHooksEnabled(
        { FRAMEFORGE_TEST_MODE: "1", FRAMEFORGE_TEST_HOOKS: "1" },
        true,
      ),
    ).toBe(true);
    expect(testHooksEnabled({ FRAMEFORGE_TEST_HOOKS: "1" }, true)).toBe(false);
  });
  it("closes to the tray only while keeping Frameforge running and not quitting", () => {
    expect(closeToTray(true, false)).toBe(true);
    expect(closeToTray(false, false)).toBe(false);
    expect(closeToTray(true, true)).toBe(false);
  });
  it("starts hidden for --hidden when it can live in the tray", () => {
    expect(startsHidden(["app.exe", "--hidden"], true)).toBe(true);
    expect(startsHidden(["app.exe", "--hidden"], false)).toBe(false);
    expect(startsHidden(["app.exe"], true)).toBe(false);
  });
  it("builds the tray menu from the saved state and the live session", () => {
    const actions = {
      open: vi.fn(),
      toggleAutoBoost: vi.fn(),
      stopBoost: vi.fn(),
      checkUpdates: vi.fn(),
      quit: vi.fn(),
    };
    const idle = trayModel(
      { autoBoost: true, mode: "performance", session: null },
      actions,
    );
    expect(idle.tooltip).toContain("auto-boost on");
    const label = (m: typeof idle, text: string) =>
      m.items.find((i) => i.label?.startsWith(text))!;
    expect(label(idle, "Auto-boost").checked).toBe(true);
    expect(label(idle, "Mode:").label).toBe("Mode: Performance");
    expect(label(idle, "Stop boost").enabled).toBe(false);
    expect(label(idle, "Check for updates").enabled).toBe(true);
    label(idle, "Check for updates").click!();
    expect(actions.checkUpdates).toHaveBeenCalledOnce();
    const session = {
      id: crypto.randomUUID(),
      gameId: crypto.randomUUID(),
      mode: "competitive",
      status: "active",
      failed: false,
    } as BoostSession;
    const busy = trayModel(
      { autoBoost: false, mode: "balanced", session, gameName: "Doom" },
      actions,
    );
    expect(busy.tooltip).toContain("Competitive boost active for Doom");
    expect(label(busy, "Stop boost").enabled).toBe(true);
    label(busy, "Stop boost").click!();
    label(busy, "Open").click!();
    label(busy, "Quit").click!();
    label(busy, "Auto-boost").click!();
    expect(actions.stopBoost).toHaveBeenCalled();
    expect(actions.open).toHaveBeenCalled();
    expect(actions.quit).toHaveBeenCalled();
    expect(actions.toggleAutoBoost).toHaveBeenCalled();
  });
  it("announces a boost once when it starts and when it ends", () => {
    const notices = new BoostNotices();
    const base = {
      id: crypto.randomUUID(),
      mode: "performance",
      failed: false,
    } as BoostSession;
    expect(notices.next({ ...base, status: "preparing" }, "Doom")).toBeNull();
    expect(notices.next({ ...base, status: "active" }, "Doom")?.body).toBe(
      "Boost started for Doom (Performance)",
    );
    expect(notices.next({ ...base, status: "active" }, "Doom")).toBeNull();
    expect(notices.next({ ...base, status: "ended" }, "Doom")?.body).toBe(
      "Boost ended, everything restored",
    );
    expect(notices.next({ ...base, status: "ended" }, "Doom")).toBeNull();
    // A manual session ending unannounced (never active here) stays quiet.
    expect(
      notices.next(
        { ...base, id: crypto.randomUUID(), status: "ended" },
        "Doom",
      ),
    ).toBeNull();
  });
});
