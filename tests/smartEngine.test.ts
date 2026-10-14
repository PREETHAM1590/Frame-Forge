import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Repository } from "../electron/repository";
import { MockPlatform, type SessionChannel } from "../electron/platform";
import { BoostEngine } from "../electron/booster";
import {
  CandidateTracker,
  GameFinder,
  SmartEngine,
  looksLikeNotAGame,
  prettyName,
  toSmartSample,
} from "../electron/smart";
import {
  GameSchema,
  MonitorSampleSchema,
  type ForegroundApp,
  type HealthFacts,
  type MonitorSample,
  type ProcessTarget,
  type RunningProcess,
} from "../shared/contracts";

const GB = 1024 ** 3;
const target: ProcessTarget = {
  pid: process.pid, // alive for the whole test, so the "game closed" check passes
  startTime: "2026-10-12T10:00:00.0000000Z",
  executablePath: "C:\\Games\\Test\\game.exe",
  name: "game",
  priority: "Normal",
};
class Fake extends EventEmitter implements SessionChannel {
  sent: { command: string; [k: string]: unknown }[] = [];
  onSend: (command: { command: string }) => void = () => {};
  send(command: unknown) {
    this.sent.push(command as never);
    queueMicrotask(() => this.onSend(command as { command: string }));
  }
  killed = false;
  kill() {
    this.killed = true;
    this.emit("exit");
  }
  line(event: unknown) {
    this.emit("event", event);
  }
}
const facts = (driver = "1.0"): HealthFacts =>
  ({
    cpuName: "i5",
    gpus: [{ name: "RTX", vendor: "nvidia", driverVersion: driver, driverDate: "2026-01-01", integrated: false }],
    memory: { totalBytes: 16 * GB, availableBytes: 2 * GB, usedPercent: 90, sticks: [{ capacityBytes: 16 * GB, speedMTs: 5600, configuredMTs: 5200, bank: null, slot: null }], slots: 2 },
    battery: { present: true, onAc: true, saver: false, percent: 100 },
  }) as unknown as HealthFacts;
const processes: RunningProcess[] = [
  { image: "brave.exe", pid: 10, protected: false, workingSetBytes: 900 * 1024 ** 2, cpuPercent: 3 },
  { image: "Discord.exe", pid: 11, protected: false, workingSetBytes: 400 * 1024 ** 2, cpuPercent: 1 },
  { image: "OneDrive.exe", pid: 12, protected: false, workingSetBytes: 90 * 1024 ** 2, cpuPercent: 0.5 },
];
class TestPlatform extends MockPlatform {
  override boostAvailable = true;
  sessions: Fake[] = [];
  monitors: Fake[] = [];
  driver = "1.0";
  game = "";
  override async runningGames() {
    return [{ gameId: this.game, target }];
  }
  override async backgroundProcesses() {
    return processes;
  }
  async healthFacts() {
    return facts(this.driver);
  }
  override spawnSession() {
    const s = new Fake();
    s.onSend = ({ command }) => {
      if (command === "start") s.line({ event: "ready" });
      if (command === "stop") s.line({ event: "ended", reason: "stop", reverts: [] });
    };
    this.sessions.push(s);
    return s;
  }
  spawnMonitor() {
    const m = new Fake();
    this.monitors.push(m);
    return m;
  }
}
// A monitor reading for a CPU-bound game on a PC short of memory.
const reading = (over: Partial<{ gpu: number; core: number; mem: number }> = {}): MonitorSample =>
  MonitorSampleSchema.parse({
    at: "2026-10-15T10:00:00Z",
    counters: true,
    cpu: { total: 85, cores: [97, 90, 60, 40, 40, 30, 30, 20], performance: 100 },
    memory: { totalBytes: 16 * GB, availableBytes: Math.round((1 - (over.mem ?? 93) / 100) * 16 * GB) },
    gpu: {
      available: true,
      detail: null,
      adapters: [
        { id: "a", engine3d: over.gpu ?? 20, compute: 0, copy: 0, video: 0, dedicatedBytes: 3 * GB, sharedBytes: 0 },
        { id: "b", engine3d: 1, compute: 0, copy: 0, video: 0, dedicatedBytes: Math.round(0.1 * GB), sharedBytes: 0 },
      ],
    },
    disks: [],
    network: [],
    processes: {
      byCpu: [
        { name: "game", count: 1, cpuPercent: 40, workingSetBytes: 3 * GB },
        { name: "node", count: 4, cpuPercent: 14, workingSetBytes: GB },
        { name: "Frameforge", count: 3, cpuPercent: 2, workingSetBytes: Math.round(GB / 10) },
      ],
      byMemory: [{ name: "game", count: 1, cpuPercent: 40, workingSetBytes: 3 * GB }],
    },
    temperatures: { gpu: [], cpuCelsius: null, note: null },
  });
function setup(seconds = 20) {
  const repo = new Repository(":memory:");
  const game = GameSchema.parse({
    id: crypto.randomUUID(),
    name: "Test",
    path: "C:\\Games\\Test",
    source: "custom",
    executablePath: "C:\\Games\\Test\\game.exe",
    profile: "balanced",
    notes: "",
    boostMode: "smart",
  });
  const state = repo.state();
  repo.updateState({ ...state, games: [game], booster: { ...state.booster, mode: "smart", autoBoost: true } });
  const platform = new TestPlatform();
  platform.game = game.id;
  const logs: string[] = [];
  const events: string[] = [];
  const smart = new SmartEngine(repo, platform, {
    notify: (e) => events.push(e.type),
    log: (_l, m) => logs.push(m),
    readSmi: async () => ({ clockPercent: 95, tempC: 65, throttled: [] }),
    seconds,
  });
  const engine = new BoostEngine(repo, platform, () => {}, { start: 1000, stop: 1000 });
  engine.attachSmart(smart);
  return { repo, game, platform, smart, engine, logs, events };
}
const watch = async (ctx: ReturnType<typeof setup>, n: number, over = {}) => {
  await vi.waitFor(() => expect(ctx.platform.monitors.length).toBeGreaterThan(0));
  const monitor = ctx.platform.monitors.at(-1)!;
  for (let i = 0; i < n; i++) monitor.line({ event: "sample", ...reading(over) });
};

describe("Smart mode engine", () => {
  it("maps a monitor reading to classifier input and spots the integrated GPU", () => {
    const s = toSmartSample(reading({ gpu: 20 }), "game.exe", { clockPercent: 90, tempC: 70, throttled: ["power cap"] });
    expect(s).toMatchObject({ gpu3d: 20, maxCore: 97, saturatedCores: 2, busyAdapterIntegrated: false, gameWorkingSetBytes: 3 * GB, gpuClockPercent: 90 });
    // Frameforge and the game itself are not background load.
    expect(s.backgroundCpu).toBe(14);
    const igpu = MonitorSampleSchema.parse({ ...reading(), gpu: { available: true, detail: null, adapters: [
      { id: "a", engine3d: 5, compute: 0, copy: 0, video: 0, dedicatedBytes: 3 * GB, sharedBytes: 0 },
      { id: "b", engine3d: 80, compute: 0, copy: 0, video: 0, dedicatedBytes: Math.round(0.1 * GB), sharedBytes: 0 },
    ] } });
    expect(toSmartSample(igpu, "game.exe", null).busyAdapterIntegrated).toBe(true);
  });

  it("watches an unknown game first, changes nothing, then starts with only what helps and saves a profile", async () => {
    const ctx = setup(20);
    const first = await ctx.engine.start(ctx.game.id, "auto", target);
    expect(first).toBeNull();
    expect(ctx.smart.observing).toBe(true);
    expect(ctx.platform.sessions).toHaveLength(0);
    expect(ctx.smart.status().observing).toMatchObject({ gameName: "Test", totalSeconds: 20 });
    await watch(ctx, 20);
    await vi.waitFor(() => expect(ctx.repo.boostSession()?.status).toBe("active"));
    const session = ctx.repo.boostSession()!;
    expect(session.mode).toBe("smart");
    expect(session.smart).toMatchObject({ classification: "cpu-bound", profileUsed: false });
    expect(session.smart!.flags).toEqual(expect.arrayContaining(["memory-pressure", "background-load"]));
    expect(session.smart!.reasons.join(" ")).toMatch(/CPU is the limit/);
    // What the helper was told: CPU-bound mechanisms, never Game Mode, and the suggested apps without any saved list.
    const start = ctx.platform.sessions[0]!.sent.find((c) => c.command === "start")!;
    expect(start.mechanisms).toMatchObject({ priority: "High", coreParking: true, gameMode: false, gpuPriority: false, lowerBackground: true });
    const images = (start.background as { image: string }[]).map((b) => b.image);
    expect(images).toContain("brave.exe");
    expect(images).not.toContain("Discord.exe");
    // Learned and saved.
    const profile = ctx.smart.profile(ctx.game.id)!;
    expect(profile.classification).toBe("cpu-bound");
    expect(profile.fingerprint).toMatch(/i5/);
    expect(ctx.events).toContain("smart");
    await ctx.engine.stop();
  });

  it("reuses the saved profile at once, and watches again when the hardware or driver changed", async () => {
    const ctx = setup(20);
    await ctx.engine.start(ctx.game.id, "auto", target);
    await watch(ctx, 20);
    await vi.waitFor(() => expect(ctx.repo.boostSession()?.status).toBe("active"));
    await ctx.engine.stop();
    await vi.waitFor(() => expect(ctx.repo.boostSession()?.status).not.toBe("active"));
    // Second launch: immediate session, labelled as using the profile.
    const again = await ctx.engine.start(ctx.game.id, "auto", { ...target, startTime: "2026-10-12T11:00:00.0000000Z" });
    expect(again?.smart?.profileUsed).toBe(true);
    expect(ctx.smart.profile(ctx.game.id)!.sessions).toBe(2);
    await ctx.engine.stop();
    await vi.waitFor(() => expect(ctx.repo.boostSession()?.status).not.toBe("active"));
    // A new driver: the fingerprint no longer matches, so it watches again instead of reusing.
    ctx.platform.driver = "2.0";
    // The fingerprint is cached for ten minutes in real use; a new engine models the next day.
    const next = new SmartEngine(ctx.repo, ctx.platform, { notify: () => {}, log: () => {}, seconds: 20 });
    const engine = new BoostEngine(ctx.repo, ctx.platform, () => {}, { start: 1000, stop: 1000 });
    engine.attachSmart(next);
    expect(await engine.start(ctx.game.id, "auto", { ...target, startTime: "2026-10-12T12:00:00.0000000Z" })).toBeNull();
    expect(next.observing).toBe(true);
    next.cancel();
  });

  it("Stop during the watch cancels it and changes nothing; a manual start explains the wait", async () => {
    const ctx = setup(20);
    await expect(ctx.engine.start(ctx.game.id, "manual", target)).rejects.toThrow(/watching Test for about a minute/);
    expect(ctx.smart.observing).toBe(true);
    await expect(ctx.engine.start(ctx.game.id, "manual", target)).rejects.toThrow(/already watching/);
    expect(await ctx.engine.stop()).toBeNull();
    expect(ctx.smart.observing).toBe(false);
    expect(ctx.platform.sessions).toHaveLength(0);
    expect(ctx.repo.boostSession()).toBeNull();
  });

  it("does not save a profile from too little data", async () => {
    const ctx = setup(10);
    await ctx.engine.start(ctx.game.id, "auto", target);
    await watch(ctx, 10);
    await vi.waitFor(() => expect(ctx.repo.boostSession()?.status).toBe("active"));
    expect(ctx.smart.profile(ctx.game.id)).toBeNull();
    expect(ctx.logs.join(" ")).toMatch(/Not saved: too little data/);
    await ctx.engine.stop();
  });

  it("forgets a profile", async () => {
    const ctx = setup(20);
    await ctx.engine.start(ctx.game.id, "auto", target);
    await watch(ctx, 20);
    await vi.waitFor(() => expect(ctx.smart.profile(ctx.game.id)).not.toBeNull());
    ctx.smart.forget(ctx.game.id);
    expect(ctx.smart.profile(ctx.game.id)).toBeNull();
    await ctx.engine.stop();
  });
});

describe("finding games that are not in the library", () => {
  const app = (over: Partial<ForegroundApp> = {}): ForegroundApp => ({
    pid: 500,
    image: "Hades2.exe",
    path: "D:\\Games\\Hades II\\Hades2.exe",
    startTime: "t",
    fullscreen: true,
    ...over,
  });
  const tracker = () => new CandidateTracker(() => false, () => false);
  it("offers a fullscreen program that keeps the GPU busy for 30 seconds", () => {
    const t = tracker();
    expect(t.feed(app(), 70, 0)).toBeNull();
    expect(t.feed(app(), 70, 29000)).toBeNull();
    expect(t.feed(app(), 70, 31000)).toEqual({ name: "Hades2", path: "D:\\Games\\Hades II\\Hades2.exe" });
    // Offered once per process.
    expect(t.feed(app(), 70, 60000)).toBeNull();
  });
  it("starts over when the GPU is idle, the window is not fullscreen or another program is in front", () => {
    const t = tracker();
    t.feed(app(), 70, 0);
    expect(t.feed(app(), 10, 20000)).toBeNull(); // GPU idle: resets
    expect(t.feed(app(), 70, 21000)).toBeNull();
    expect(t.feed(app(), 70, 45000)).toBeNull(); // only 24 s since the restart
    expect(t.feed(app({ fullscreen: false }), 90, 80000)).toBeNull();
    expect(t.feed(app({ pid: 600 }), 90, 81000)).toBeNull();
    expect(t.feed(app({ pid: 600 }), 90, 112000)).not.toBeNull();
  });
  it("ignores library games, dismissed programs, browsers, players and launchers", () => {
    const inLibrary = new CandidateTracker(() => true, () => false);
    inLibrary.feed(app(), 90, 0);
    expect(inLibrary.feed(app(), 90, 40000)).toBeNull();
    const dismissed = new CandidateTracker(() => false, () => true);
    dismissed.feed(app(), 90, 0);
    expect(dismissed.feed(app(), 90, 40000)).toBeNull();
    for (const image of ["chrome.exe", "vlc.exe", "obs64.exe", "steam.exe", "Spotify.exe", "Code.exe", "mstsc.exe"]) {
      expect(looksLikeNotAGame(image), image).toBe(true);
      const t = tracker();
      t.feed(app({ image }), 90, 0);
      expect(t.feed(app({ image }), 90, 40000), image).toBeNull();
    }
    expect(looksLikeNotAGame("VALORANT-Win64-Shipping.exe")).toBe(false);
  });
  it("makes a readable name", () => {
    expect(prettyName("VALORANT-Win64-Shipping.exe")).toBe("VALORANT");
    expect(prettyName("Hades2.exe")).toBe("Hades2");
    expect(prettyName("elden_ring.exe")).toBe("elden ring");
  });
  it("the finder reads GPU load only while a candidate is in front, and the offer is the user's to accept", async () => {
    const platform = new (class extends MockPlatform {
      monitors: Fake[] = [];
      front: ForegroundApp | null = app();
      async foregroundApp() {
        return this.front;
      }
      spawnMonitor() {
        const m = new Fake();
        this.monitors.push(m);
        return m;
      }
    })();
    const found: unknown[] = [];
    const t = new CandidateTracker(() => false, () => false, { seconds: 0 });
    const finder = new GameFinder(platform, t, (f) => found.push(f));
    await finder.tick();
    expect(platform.monitors).toHaveLength(1);
    const gpu = (n: number) => platform.monitors[0]!.line({ event: "sample", ...reading({ gpu: n }) });
    gpu(80);
    gpu(80);
    expect(found).toHaveLength(1);
    // A desktop in front closes the monitor again.
    platform.front = null;
    await finder.tick();
    expect(platform.monitors[0]!.killed).toBe(true);
    finder.stop();
  });
});
