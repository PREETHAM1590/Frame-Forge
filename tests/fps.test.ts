import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FpsAccumulator, frameStats, minFramesForLow } from "../shared/fps";
import {
  defaultState,
  FpsEventSchema,
  MonitorSampleSchema,
  type AppEvent,
  type Game,
} from "../shared/contracts";
import { FpsService, minSummaryFrames } from "../electron/fps";
import { MonitorService } from "../electron/monitor";
import { MockPlatform, type SessionChannel } from "../electron/platform";

describe("FPS math", () => {
  it("averages by total time, not by the mean of frame rates", () => {
    // 198 frames at 10 ms and 2 at 100 ms: 2180 ms for 200 frames.
    const times = [...Array(198).fill(10), 100, 100];
    const stats = frameStats(times);
    expect(stats.frames).toBe(200);
    expect(stats.avgFps).toBeCloseTo(200000 / 2180, 6);
  });
  it("1% low is the average FPS of the slowest 1% of frames", () => {
    const times = [...Array(198).fill(10), 100, 100];
    expect(frameStats(times).low1Fps).toBeCloseTo(10, 6);
    // 1000 frames: the 10 slowest are 20 ms (50 FPS) and the rest 8 ms.
    const many = [...Array(990).fill(8), ...Array(10).fill(20)];
    expect(frameStats(many).low1Fps).toBeCloseTo(50, 6);
    expect(frameStats(many).avgFps).toBeCloseTo(1000000 / (990 * 8 + 200), 6);
  });
  it("takes part of a bin when the slowest 1% does not fill it", () => {
    // 200 frames: 2 slowest are needed, three frames share the slowest bin (30 ms) and one is slower.
    const times = [...Array(196).fill(10), 30, 30, 30, 50];
    // slowest two: 50 and 30 -> mean 40 ms -> 25 FPS
    expect(frameStats(times).low1Fps).toBeCloseTo(25, 6);
  });
  it("shows no 1% low until there are enough frames to mean something", () => {
    expect(frameStats(Array(minFramesForLow - 1).fill(10)).low1Fps).toBeNull();
    expect(frameStats(Array(minFramesForLow).fill(10)).low1Fps).toBeCloseTo(
      100,
      6,
    );
    expect(frameStats([]).avgFps).toBeNull();
  });
  it("ignores impossible frame times and keeps bounded history", () => {
    const acc = new FpsAccumulator(5, 3);
    expect(acc.add([0, -4, Number.NaN, Infinity])).toBeNull();
    expect(acc.frames).toBe(0);
    expect(acc.add([16, 16, 16, 16, 16, 16, 16])).toBeCloseTo(62.5, 6);
    expect(acc.recent).toHaveLength(5);
    for (let i = 0; i < 5; i++) acc.add([10]);
    expect(acc.perSecond).toHaveLength(3);
    expect(acc.perSecond.at(-1)).toBeCloseTo(100, 6);
  });
  it("a stutter in an otherwise smooth run drags the 1% low but barely the average", () => {
    const acc = new FpsAccumulator();
    for (let s = 0; s < 60; s++)
      acc.add([...Array(s === 30 ? 57 : 60).fill(1000 / 60)]);
    acc.add([120, 120, 120]);
    expect(acc.avgFps!).toBeGreaterThan(55);
    expect(acc.low1Fps!).toBeLessThan(acc.avgFps!);
  });
});

const channel = () => {
  const emitter = new EventEmitter();
  const fake = Object.assign(emitter, {
    sent: [] as unknown[],
    killed: false,
    send: (c: unknown) => fake.sent.push(c),
    kill: () => {
      fake.killed = true;
    },
    say: (event: unknown) => emitter.emit("event", event),
  });
  return fake as unknown as SessionChannel & {
    sent: unknown[];
    killed: boolean;
    say(event: unknown): void;
    emit(event: string): boolean;
  };
};
const game: Game = {
  id: crypto.randomUUID(),
  name: "Test Game",
  path: "C:/Games/Test",
  source: "custom",
  executablePath: "C:/Games/Test/game.exe",
  profile: "balanced",
  boostMode: "global",
  notes: "",
};
class FakePlatform extends MockPlatform {
  fps = channel();
  monitor = channel();
  alive = true;
  override async runningGames() {
    return this.alive
      ? [
          {
            gameId: game.id,
            target: {
              pid: 42,
              startTime: "2026-10-14T10:00:00.0000000Z",
              executablePath: game.executablePath!,
              name: "game",
              priority: "Normal" as const,
            },
          },
        ]
      : [];
  }
  spawnFps() {
    return this.fps;
  }
  spawnMonitor() {
    return this.monitor;
  }
}
function fpsHarness(boost: boolean | (() => boolean) = false) {
  const platform = new FakePlatform();
  const meta = new Map<string, unknown>();
  const events: AppEvent[] = [];
  const logs: string[][] = [];
  let now = 1_000_000;
  const service = new FpsService(platform, {
    games: () => [game],
    boostOn: () => (typeof boost === "function" ? boost() : boost),
    meta: (k) => meta.get(k) ?? null,
    setMeta: (k, v) => void meta.set(k, v),
    log: (label, message) => logs.push([label, message]),
    notify: (e) => events.push(e),
    now: () => now,
  });
  return {
    platform,
    service,
    meta,
    events,
    logs,
    tick: (ms: number) => (now += ms),
  };
}
const steady = (n = 60) => ({
  event: "frames",
  frameTimesMs: Array(n).fill(1000 / n),
});

describe("FpsService", () => {
  it("runs approval, capture and a saved summary, and releases the prompt gate", async () => {
    const h = fpsHarness(true);
    const started = await h.service.start(game.id);
    expect(started.state).toBe("starting");
    expect(h.platform.elevation.current).toBe("fps");
    expect(h.platform.fps.sent[0]).toMatchObject({
      command: "start",
      gamePid: 42,
      gameStartTime: "2026-10-14T10:00:00.0000000Z",
      parentPid: process.pid,
    });
    h.platform.fps.say({ event: "approval" });
    h.platform.fps.say({ event: "ready" });
    expect(h.platform.elevation.current).toBeNull();
    for (let s = 0; s < 12; s++) {
      h.tick(1000);
      h.platform.fps.say(steady());
      h.platform.fps.say({
        event: "usage",
        cpuPercent: 31.5,
        workingSetBytes: 2_000_000_000,
        gpuPercent: 77,
      });
    }
    const live = await h.service.status();
    expect(live.state).toBe("capturing");
    expect(live.fps).toBeCloseTo(60, 6);
    expect(live.avgFps).toBeCloseTo(60, 6);
    expect(live.usage?.gpuPercent).toBe(77);
    expect(live.frames).toBe(720);
    h.tick(400);
    h.platform.fps.say({ event: "ended", reason: "game-exited" });
    const done = await h.service.status();
    expect(done.state).toBe("ended");
    expect(done.saved).toMatchObject({
      gameId: game.id,
      avgFps: 60,
      boost: "on",
      durationSeconds: 12,
    });
    expect(h.service.history(game.id)).toHaveLength(1);
    expect(h.logs[0][0]).toBe("FPS capture saved");
    expect(h.logs[0][1]).toContain("Test Game: 60 FPS average");
    expect(h.logs[0][1]).toContain("Game Mode on");
    expect(h.platform.fps.killed).toBe(true);
    expect(h.events.at(-1)).toMatchObject({
      type: "fps",
      status: { state: "ended" },
    });
  });
  it("keeps only the latest 30 summaries per game and does not save a short capture", async () => {
    const h = fpsHarness();
    for (let i = 0; i < 31; i++) {
      h.platform.fps = channel();
      await h.service.start(game.id);
      h.platform.fps.say({ event: "ready" });
      for (let s = 0; s < 11; s++) {
        h.tick(1000);
        h.platform.fps.say(steady(60));
      }
      h.platform.fps.say({ event: "ended", reason: "stop" });
    }
    expect(h.service.history(game.id)).toHaveLength(30);
    expect(h.service.history(game.id)[0].boost).toBe("off");
    // Too short: three seconds.
    h.platform.fps = channel();
    await h.service.start(game.id);
    h.platform.fps.say({ event: "ready" });
    h.tick(3000);
    h.platform.fps.say(steady(60));
    h.platform.fps.say({ event: "ended", reason: "stop" });
    const status = await h.service.status();
    expect(status.saved).toBeNull();
    expect(status.detail).toContain("Too short to save");
    expect(minSummaryFrames).toBe(120);
    expect(h.service.history(game.id)).toHaveLength(30);
  });
  it("marks a capture mixed when Game Mode changed while it ran", async () => {
    let boost = false;
    const h = fpsHarness(() => boost);
    await h.service.start(game.id);
    h.platform.fps.say({ event: "ready" });
    h.tick(6000);
    h.platform.fps.say(steady(130));
    boost = true;
    h.tick(6000);
    h.platform.fps.say(steady(130));
    h.platform.fps.say({ event: "ended", reason: "stop" });
    expect((await h.service.status()).saved?.boost).toBe("mixed");
  });
  it.each([
    ["declined", "Administrator approval was declined."],
    ["protected", "Windows will not let Frameforge inspect this game."],
    ["etw-denied", "Windows did not allow a graphics trace session."],
  ])("reports %s honestly and frees the gate", async (code, detail) => {
    const h = fpsHarness();
    await h.service.start(game.id);
    h.platform.fps.say({ event: "approval" });
    h.platform.fps.say({ event: "unavailable", code, detail });
    const s = await h.service.status();
    expect(s).toMatchObject({ state: "unavailable", code, detail });
    expect(h.platform.elevation.current).toBeNull();
    expect(h.platform.fps.killed).toBe(true);
    expect(h.logs).toHaveLength(0);
  });
  it("says why when no frames arrive", async () => {
    const h = fpsHarness();
    await h.service.start(game.id);
    h.platform.fps.say({ event: "ready" });
    h.tick(16000);
    h.platform.fps.say({ event: "frames", frameTimesMs: [] });
    const s = await h.service.status();
    expect(s.state).toBe("capturing");
    expect(s.code).toBe("no-frames");
    expect(s.detail).toMatch(/Vulkan and OpenGL/);
    h.platform.fps.say(steady());
    expect((await h.service.status()).code).toBeNull();
  });
  it("refuses a second capture, a missing game, an open prompt and a stopped game", async () => {
    const h = fpsHarness();
    await h.service.start(game.id);
    await expect(h.service.start(game.id)).rejects.toThrow(/already running/);
    h.service.dispose();
    h.platform.alive = false;
    await expect(h.service.start(game.id)).rejects.toThrow(/is not running/);
    await expect(h.service.start(crypto.randomUUID())).rejects.toThrow(
      /not in the library/,
    );
    h.platform.alive = true;
    h.platform.elevation.hold("restore");
    await expect(h.service.start(game.id)).rejects.toThrow(
      /System Restore request is waiting/,
    );
    expect(h.platform.elevation.current).toBe("restore");
  });
  it("stop sends the stop command and resolves with the helper's ended report", async () => {
    const h = fpsHarness();
    await h.service.start(game.id);
    h.platform.fps.say({ event: "ready" });
    h.platform.fps.say(steady());
    const pending = h.service.stop();
    expect(h.platform.fps.sent.at(-1)).toEqual({ command: "stop" });
    h.platform.fps.say({ event: "ended", reason: "stop" });
    expect((await pending).state).toBe("ended");
  });
  it("a helper that dies mid-capture ends the capture instead of hanging", async () => {
    const h = fpsHarness();
    await h.service.start(game.id);
    h.platform.fps.emit("exit");
    expect((await h.service.status()).state).toBe("unavailable");
    expect(h.platform.elevation.current).toBeNull();
  });
  it("ignores lines that do not match the helper contract", async () => {
    const h = fpsHarness();
    await h.service.start(game.id);
    h.platform.fps.say({ event: "frames", frameTimesMs: "nope" });
    h.platform.fps.say({ event: "evil" });
    h.platform.fps.say("text");
    expect((await h.service.status()).state).toBe("starting");
    expect(FpsEventSchema.safeParse({ event: "ready", extra: 1 }).success).toBe(
      false,
    );
  });
});

const sample = {
  at: "2026-10-14T10:00:00.0000000Z",
  counters: true,
  cpu: { total: 12.5, cores: [10, 15] },
  memory: { totalBytes: 16e9, availableBytes: 8e9 },
  gpu: { available: true, detail: null, adapters: [] },
  disks: [],
  network: [],
  processes: { byCpu: [], byMemory: [] },
  temperatures: { gpu: [], cpuCelsius: null, note: "Not available." },
};
describe("MonitorService", () => {
  it("starts one helper, forwards valid samples, drops bad ones and ends the helper on stop", () => {
    const platform = new FakePlatform();
    const events: AppEvent[] = [];
    const monitor = new MonitorService(platform, (e) => events.push(e));
    expect(monitor.start()).toBe(true);
    expect(monitor.start()).toBe(true);
    platform.monitor.say({ event: "ready" });
    platform.monitor.say({ event: "sample", ...sample });
    platform.monitor.say({ event: "sample", ...sample, cpu: { total: 500 } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "monitor",
      sample: { cpu: { total: 12.5 } },
    });
    expect(monitor.stop()).toBe(true);
    expect(platform.monitor.killed).toBe(true);
    expect(platform.monitor.sent.at(-1)).toEqual({ command: "stop" });
    platform.monitor.say({ event: "sample", ...sample });
    expect(events).toHaveLength(1);
    expect(monitor.active).toBe(false);
    expect(monitor.stop()).toBe(false);
  });
  it("a minimized window ends the helper and a restored one brings it back only if the page still wants it", () => {
    const platform = new FakePlatform();
    const monitor = new MonitorService(platform, vi.fn());
    monitor.suspend();
    monitor.resume();
    expect(monitor.active).toBe(false);
    monitor.start();
    const first = platform.monitor;
    monitor.suspend();
    expect(first.killed).toBe(true);
    expect(monitor.active).toBe(false);
    platform.monitor = channel();
    monitor.resume();
    expect(monitor.active).toBe(true);
    monitor.stop();
    monitor.resume();
    expect(monitor.active).toBe(false);
  });
  it("is unavailable without the Windows helper", () => {
    const monitor = new MonitorService(new MockPlatform(), vi.fn());
    expect(() => monitor.start()).toThrow(/Windows helper/);
  });
  it("accepts what the helper really sends", () => {
    expect(MonitorSampleSchema.safeParse(sample).success).toBe(true);
    void defaultState;
  });
});
