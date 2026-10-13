import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import { Repository } from "../electron/repository";
import { MockPlatform, type SessionChannel } from "../electron/platform";
import { BoostEngine } from "../electron/booster";
import { OperationEngine } from "../electron/operations";
import { AppService } from "../electron/service";
import {
  BoostSessionSchema,
  GameSchema,
  type ProcessTarget,
} from "../shared/contracts";
const target: ProcessTarget = {
  pid: 321,
  startTime: "2026-10-12T10:00:00.0000000Z",
  executablePath: "C:\\Games\\Test\\game.exe",
  name: "game",
  priority: "Normal",
};
class Fake extends EventEmitter implements SessionChannel {
  sent: Array<{ command: string } & Record<string, unknown>> = [];
  send(command: unknown) {
    this.sent.push(command as never);
    if ((command as { command: string }).command === "start")
      queueMicrotask(() => this.emit("event", { event: "ready" }));
    if ((command as { command: string }).command === "stop")
      queueMicrotask(() =>
        this.emit("event", { event: "ended", reason: "stop", reverts: [] }),
      );
  }
  kill() {
    this.emit("exit");
  }
}
class Platform extends MockPlatform {
  override boostAvailable = true;
  sessions: Fake[] = [];
  override async runningGames() {
    return [{ gameId: gameId, target }];
  }
  override spawnSession() {
    const s = new Fake();
    this.sessions.push(s);
    return s;
  }
  override async networkCheck(): Promise<never> {
    throw Object.assign(new Error("That address is local or not routable."), {
      code: "invalid-request",
    });
  }
}
let gameId = "";
const desktop = {
  pickGame: async () => null,
  detectGames: async () => ({
    games: [],
    warnings: [],
    launchers: [],
    perLauncher: [],
  }),
  scanFolder: async () => null,
  setStartup: () => {},
  version: "test",
};
function seed(mode: "performance" | "balanced" = "performance") {
  const repo = new Repository(":memory:");
  const game = GameSchema.parse({
    id: crypto.randomUUID(),
    name: "Test",
    path: "C:\\Games\\Test",
    source: "steam",
    profile: "gaming",
    notes: "",
  });
  gameId = game.id;
  const state = repo.state();
  repo.updateState({
    ...state,
    games: [game],
    booster: { ...state.booster, mode },
  });
  return { repo, game };
}
const liveSession = () =>
  BoostSessionSchema.parse({
    id: crypto.randomUUID(),
    gameId: crypto.randomUUID(),
    mode: "performance",
    target,
    startedAt: new Date().toISOString(),
    status: "active",
    message: "Boosted.",
  });
// Applies capture-off the way the engine does, so the journal row is real.
async function applyCaptureOff(repo: Repository) {
  const platform = new MockPlatform(true);
  const engine = new OperationEngine(repo, platform);
  const preview = await engine.preview(["capture-off"]);
  return engine.confirm(preview.token);
}
describe("I-1: capture-off and the booster's Game Bar step share one value", () => {
  it("blocks capture-off apply and rollback while a boost session exists", async () => {
    const repo = new Repository(":memory:");
    const done = await applyCaptureOff(repo);
    expect(done.status).toBe("success");
    repo.saveBoostSession(liveSession(), []);
    const engine = new OperationEngine(repo, new MockPlatform(true));
    await expect(engine.preview(["capture-off"])).rejects.toThrow(
      /Stop Game Mode before changing background game capture/,
    );
    await expect(engine.rollback(done.id)).rejects.toThrow(
      /Stop Game Mode before changing background game capture/,
    );
    // Mouse precision is independent of the session.
    await expect(engine.preview(["mouse-precision"])).resolves.toBeTruthy();
    repo.close();
  });
  it("sessions skip gameBarCapture while the optimization is applied and say why", async () => {
    const { repo, game } = seed();
    await applyCaptureOff(repo);
    expect(repo.optimizationApplied("capture-off")).toBe(true);
    const platform = new Platform();
    const engine = new BoostEngine(repo, platform, () => {}, {
      start: 1000,
      stop: 1000,
    });
    const session = await engine.start(game.id, "manual");
    expect(platform.sessions[0]!.sent[0]).toMatchObject({
      mechanisms: { gameBarCapture: false, powerPlan: true },
    });
    expect(session?.mechanisms[0]).toMatchObject({
      id: "gameBarCapture",
      state: "skipped",
      detail: expect.stringMatching(/managed by an applied optimization/),
    });
    repo.close();
  });
  it("keeps the session step when the optimization is rolled back", async () => {
    const { repo, game } = seed();
    const done = await applyCaptureOff(repo);
    await new OperationEngine(repo, new MockPlatform(true)).rollback(done.id);
    expect(repo.optimizationApplied("capture-off")).toBe(false);
    const platform = new Platform();
    const engine = new BoostEngine(repo, platform, () => {}, {
      start: 1000,
      stop: 1000,
    });
    await engine.start(game.id, "manual");
    expect(platform.sessions[0]!.sent[0]).toMatchObject({
      mechanisms: { gameBarCapture: true },
    });
    repo.close();
  });
});
describe("I-4: restoring a backup with launch-setting records", () => {
  it("refuses while a game missing from the backup still has a saved prior value", async () => {
    const { repo, game } = seed("balanced");
    const service = new AppService(repo, new Platform(), desktop);
    const backup = repo.backup("Older");
    // The backup predates the game: take it out of the backup payload.
    (backup.state as { games: unknown[] }).games = [];
    repo.setMeta(`launch:${game.id}:gpuPreference`, {
      exe: "C:\\Games\\Test\\game.exe",
      existed: false,
      value: null,
      applied: "GpuPreference=2;",
      at: new Date().toISOString(),
    });
    const wipe = repo as unknown as {
      backups: () => unknown[];
    };
    const real = wipe.backups.bind(repo);
    wipe.backups = () =>
      real().map((b) => ({ ...(b as object), state: backup.state }));
    await expect(
      service.dispatch("restore", { id: backup.id, confirmed: true }),
    ).rejects.toThrow(/Revert the launch settings for Test first/);
    // The library is untouched.
    expect(repo.state().games).toHaveLength(1);
    repo.close();
  });
});
describe("F3: an expected network refusal is not a failed request", () => {
  it("logs the friendly message and not 'Request failed'", async () => {
    const { repo } = seed("balanced");
    const service = new AppService(repo, new Platform(), desktop);
    await expect(
      service.dispatch("networkCheck", { host: "127.0.0.1", count: 10 }),
    ).rejects.toThrow(/local or not routable/);
    const labels = repo.activity().map((a) => `${a.label}|${a.message}`);
    expect(
      labels.some((l) => /^Network check\|127\.0\.0\.1: not run/.test(l)),
    ).toBe(true);
    expect(labels.some((l) => l.startsWith("Request failed"))).toBe(false);
    repo.close();
  });
});
