import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import { Repository } from "../electron/repository";
import { MockPlatform, type SessionChannel } from "../electron/platform";
import { BoostEngine } from "../electron/booster";
import { AppService } from "../electron/service";
import {
  GameSchema,
  HelperResult,
  SessionEventSchema,
  type Captured,
  type MechanismResult,
  type ProcessTarget,
} from "../shared/contracts";
const target: ProcessTarget = {
  pid: 321,
  startTime: "2026-10-12T10:00:00.0000000Z",
  executablePath: "C:\\Games\\Test\\game.exe",
  name: "game",
  priority: "Normal",
};
const priorityCapture: Captured = {
  mechanism: "priority",
  process: target,
  prior: "Normal",
  applied: "High",
};
class FakeSession extends EventEmitter implements SessionChannel {
  sent: unknown[] = [];
  onSend: (command: { command: string }) => void = () => {};
  send(command: unknown) {
    this.sent.push(command);
    queueMicrotask(() => this.onSend(command as { command: string }));
  }
  kill() {
    this.emit("exit");
  }
  line(event: unknown) {
    this.emit("event", event);
  }
}
class TestPlatform extends MockPlatform {
  override boostAvailable = true;
  sessions: FakeSession[] = [];
  recovered: Captured[][] = [];
  running = [{ gameId: "", target }];
  onSpawn: (session: FakeSession) => void = () => {};
  override async runningGames() {
    return this.running;
  }
  override async boostRecover(
    captured: Captured[],
  ): Promise<MechanismResult[]> {
    this.recovered.push(captured);
    return captured.map((c) => ({
      id: c.mechanism,
      state: "reverted",
      detail: "restored",
    }));
  }
  override spawnSession() {
    const session = new FakeSession();
    this.sessions.push(session);
    this.onSpawn(session);
    return session;
  }
}
// A session helper that captures, applies and becomes ready; it ends on "stop".
function scripted(session: FakeSession) {
  session.onSend = ({ command }) => {
    if (command === "start") {
      session.line({
        event: "captured",
        mechanism: "priority",
        prior: priorityCapture,
      });
      session.line({
        event: "applied",
        mechanism: "priority",
        detail: "game (pid 321): High priority verified.",
      });
      session.line({ event: "ready" });
    } else if (command === "stop")
      session.line({
        event: "ended",
        reason: "stop",
        reverts: [{ id: "priority", state: "reverted", detail: "restored" }],
      });
  };
}
function setup(mode: "off" | "performance" = "performance") {
  const repo = new Repository(":memory:");
  const game = GameSchema.parse({
    id: crypto.randomUUID(),
    name: "Test",
    path: "C:\\Games\\Test",
    source: "steam",
    profile: "gaming",
    notes: "",
  });
  const state = repo.state();
  repo.updateState({
    ...state,
    games: [game],
    booster: { ...state.booster, mode },
  });
  const platform = new TestPlatform();
  platform.running = [{ gameId: game.id, target }];
  platform.onSpawn = scripted;
  return {
    repo,
    game,
    platform,
    engine: new BoostEngine(repo, platform, () => {}, {
      start: 1000,
      stop: 1000,
    }),
  };
}
describe("game booster sessions", () => {
  it("persists each capture before the change is reported, then reverts on stop", async () => {
    const { repo, game, platform, engine } = setup();
    platform.onSpawn = (session) => {
      session.onSend = ({ command }) => {
        if (command !== "start") return scripted(session);
        session.line({
          event: "captured",
          mechanism: "priority",
          prior: priorityCapture,
        });
        expect(repo.boostRecord()?.captured).toEqual([priorityCapture]);
        expect(repo.boostSession()?.mechanisms).toEqual([]);
        session.line({
          event: "applied",
          mechanism: "priority",
          detail: "verified",
        });
        session.line({ event: "ready" });
        scripted(session);
      };
    };
    const session = await engine.start(game.id, "manual");
    expect(session?.status).toBe("active");
    expect(session?.mode).toBe("performance");
    expect(session?.mechanisms[0]).toMatchObject({ state: "applied" });
    expect(platform.sessions[0]!.sent[0]).toMatchObject({
      command: "start",
      gamePid: 321,
      mechanisms: { priority: "High", powerPlan: true, gameMode: true },
    });
    const ended = await engine.stop();
    expect(ended?.status).toBe("ended");
    expect(ended?.endedAt).not.toBeNull();
    expect(repo.boostSession()).toBeNull();
    repo.close();
  });
  it("recovers an interrupted session on a new engine through boost-recover", async () => {
    const { repo, game, platform, engine } = setup();
    await engine.start(game.id, "manual");
    // Simulate a crash: the app restarts with the session still marked active.
    repo.recoverInterrupted();
    const restarted = new BoostEngine(repo, platform);
    const result = await restarted.recover();
    expect(platform.recovered).toEqual([[priorityCapture]]);
    expect(result?.status).toBe("ended");
    expect(repo.boostSession()).toBeNull();
    repo.close();
  });
  it("keeps a failed recovery for retry and lets the user dismiss it", async () => {
    const { repo, game, platform, engine } = setup();
    await engine.start(game.id, "manual");
    repo.recoverInterrupted();
    platform.boostRecover = async () => [
      { id: "priority", state: "failed", detail: "access denied" },
    ];
    const restarted = new BoostEngine(repo, platform);
    expect((await restarted.recover())?.status).toBe("recovery-needed");
    await expect(restarted.start(game.id, "manual")).rejects.toThrow(
      /recover/i,
    );
    expect((await restarted.recover(true))?.status).toBe("ended");
    expect(repo.boostSession()).toBeNull();
    repo.close();
  });
  it("restores from saved captures when the helper exits without reporting", async () => {
    const { repo, game, platform, engine } = setup();
    await engine.start(game.id, "manual");
    platform.sessions[0]!.kill();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(platform.recovered).toEqual([[priorityCapture]]);
    expect(repo.boostSession()).toBeNull();
    expect(engine.active).toBe(false);
    repo.close();
  });
  it("auto-boost starts once per game process and never a second session", async () => {
    const { repo, platform, engine } = setup();
    await engine.poll();
    await engine.poll();
    expect(platform.sessions).toHaveLength(1);
    expect(engine.active).toBe(true);
    platform.sessions[0]!.line({
      event: "ended",
      reason: "game-exited",
      reverts: [],
    });
    expect(engine.active).toBe(false);
    await engine.poll();
    expect(platform.sessions).toHaveLength(1);
    repo.close();
  });
  it("does nothing in Off mode", async () => {
    const { repo, game, platform, engine } = setup("off");
    expect(await engine.start(game.id, "auto")).toBeNull();
    await expect(engine.start(game.id, "manual")).rejects.toThrow(/Off/);
    await engine.poll();
    expect(platform.sessions).toHaveLength(0);
    expect(repo.boostSession()).toBeNull();
    repo.close();
  });
  it("requires a running game for manual starts", async () => {
    const { repo, game, platform, engine } = setup();
    platform.running = [];
    await expect(engine.start(game.id, "manual")).rejects.toThrow(
      /Start the game first/,
    );
    expect(platform.sessions).toHaveLength(0);
    repo.close();
  });
  it("accepts helper output with absent registry values as explicit null (C-1)", () => {
    // Exact helper JSON shapes: optimizer capture and a Game Mode capture where one value did not exist.
    const absent = {
      operation: "capture-off",
      path: "Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR",
      name: "AppCaptureEnabled",
      kind: "DWord",
      existed: false,
      value: null,
    };
    expect(
      HelperResult.safeParse({
        ok: true,
        message: "Snapshot captured.",
        snapshot: { values: [absent] },
      }).success,
    ).toBe(true);
    const line = JSON.parse(
      '{"event":"captured","mechanism":"gameMode","prior":{"mechanism":"gameMode","registry":{"values":[{"operation":"game-mode","path":"Software\\\\Microsoft\\\\GameBar","name":"AutoGameModeEnabled","kind":"DWord","existed":true,"value":0},{"operation":"game-mode","path":"Software\\\\Microsoft\\\\GameBar","name":"AllowAutoGameMode","kind":"DWord","existed":false,"value":null}]}}}',
    );
    expect(SessionEventSchema.safeParse(line).success).toBe(true);
    const missing: Partial<typeof absent> = { ...absent };
    delete missing.value;
    expect(
      HelperResult.safeParse({
        ok: true,
        message: "x",
        snapshot: { values: [missing] },
      }).success,
    ).toBe(false);
  });
  it("stops and reverts the session when a capture cannot be saved", async () => {
    const { repo, game, platform, engine } = setup();
    platform.onSpawn = (session) => {
      session.onSend = ({ command }) => {
        if (command === "start") {
          session.line({
            event: "captured",
            mechanism: "gameMode",
            prior: { mechanism: "gameMode", unexpected: true },
          });
          session.line({ event: "ready" });
        } else if (command === "stop")
          session.line({
            event: "ended",
            reason: "stop",
            reverts: [
              { id: "gameMode", state: "reverted", detail: "restored" },
            ],
          });
      };
    };
    await engine.start(game.id, "manual");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(platform.sessions[0]!.sent).toContainEqual({ command: "stop" });
    expect(repo.boostSession()).toBeNull();
    expect(
      repo
        .activity()
        .map((a) => a.message)
        .join(" "),
    ).toMatch(/invalid session helper report/);
    repo.close();
  });
  it("creates the High performance plan only on request and passes it to sessions", async () => {
    const { repo, game, platform, engine } = setup();
    const created = crypto.randomUUID();
    platform.createPowerPlan = async () => created;
    let removed = "";
    platform.deletePowerPlan = async (owned) => {
      removed = owned;
      return "removed";
    };
    expect((await engine.status()).ownedPowerPlan).toBe(false);
    expect((await engine.powerPlan("create")).ownedPowerPlan).toBe(true);
    await expect(engine.powerPlan("create")).rejects.toThrow(/already/);
    await engine.start(game.id, "manual");
    expect(platform.sessions[0]!.sent[0]).toMatchObject({ ownedPlan: created });
    await expect(engine.powerPlan("remove")).rejects.toThrow(/Stop/);
    await engine.stop();
    expect((await engine.powerPlan("remove")).ownedPowerPlan).toBe(false);
    expect(removed).toBe(created);
    repo.close();
  });
  it("quitting with an active session awaits stop and revert", async () => {
    const { repo, game, platform } = setup();
    const service = new AppService(repo, platform, {
      pickGame: async () => null,
      detectGames: async () => ({ games: [], warnings: [], launchers: [] }),
      setStartup: () => {},
      version: "test",
    });
    await service.dispatch("boostStart", { gameId: game.id, confirmed: true });
    expect(service.booster.active).toBe(true);
    await service.shutdown();
    expect(platform.sessions[0]!.sent.at(-1)).toEqual({ command: "stop" });
    expect(service.booster.active).toBe(false);
    expect(repo.boostSession()).toBeNull();
    repo.close();
  });
});
