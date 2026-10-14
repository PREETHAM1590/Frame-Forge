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
  killed = false;
  kill() {
    this.killed = true;
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
  owned: Array<string | null> = [];
  probes = 0;
  setOwnedPlan(guid: string | null) {
    this.owned.push(guid);
  }
  async probe() {
    this.probes++;
    return null;
  }
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
  it("holds the elevation gate while paused services restart after the game exits on its own", async () => {
    const { repo, game, platform, engine } = setup();
    const services: Captured = {
      mechanism: "pauseServices",
      items: ["svc"],
      appliedItems: [],
    };
    platform.onSpawn = (session) => {
      session.onSend = ({ command }) => {
        if (command !== "start") return;
        session.line({
          event: "captured",
          mechanism: "pauseServices",
          prior: services,
        });
        session.line({ event: "ready" });
      };
    };
    await engine.start(game.id, "manual");
    const gate = platform.elevation;
    expect(gate.current).toBeNull();
    const session = platform.sessions[0]!;
    session.line({ event: "ending", reason: "game-exited" });
    expect(gate.current).toBe("boost");
    expect(() => gate.hold("optimize")).toThrow();
    session.line({
      event: "ended",
      reason: "game-exited",
      reverts: [{ id: "pauseServices", state: "reverted", detail: "ok" }],
    });
    expect(gate.current).toBeNull();
    expect(() => gate.hold("optimize")).not.toThrow();
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
    // N-3: the later "ready" must not turn this into a successful start.
    const result = await engine.start(game.id, "manual");
    expect(result?.status).toBe("ended");
    expect(result?.failed).toBe(true);
    expect(result?.message).toMatch(/could not save/);
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
    let created = "";
    // nm-1: the GUID is recorded before the helper is asked to create the plan.
    platform.createPowerPlan = async (destination) => {
      expect(repo.meta("booster.powerPlan")).toBe(destination);
      created = destination;
    };
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
  it("re-probes optimization support with the owned plan after the plan is created or removed", async () => {
    const { platform, engine } = setup();
    platform.createPowerPlan = async () => {};
    platform.deletePowerPlan = async () => "removed";
    await engine.powerPlan("create");
    expect(platform.owned.at(-1)).toMatch(/^[0-9a-f-]{36}$/);
    expect(platform.probes).toBe(1);
    await engine.powerPlan("remove");
    expect(platform.owned.at(-1)).toBeNull();
    expect(platform.probes).toBe(2);
  });
  it("keeps the plan record only when the helper could not confirm the outcome", async () => {
    const { repo, platform, engine } = setup();
    platform.createPowerPlan = async () => {
      throw Object.assign(new Error("Windows did not allow it"), {
        code: "plan-not-created",
      });
    };
    await expect(engine.powerPlan("create")).rejects.toThrow(/did not allow/);
    expect(repo.meta("booster.powerPlan")).toBeNull();
    platform.createPowerPlan = async () => {
      throw new Error("Windows helper timed out.");
    };
    await expect(engine.powerPlan("create")).rejects.toThrow(/timed out/);
    expect(repo.meta("booster.powerPlan")).not.toBeNull();
    repo.close();
  });
  it("retries only failed reverts and blocks plan removal while a recovery is pending", async () => {
    const { repo, game, platform, engine } = setup();
    const suspend: Captured = {
      mechanism: "suspendBackground",
      process: { ...target, pid: 900, name: "sync" },
    };
    platform.onSpawn = (session) => {
      session.onSend = ({ command }) => {
        if (command !== "start") return;
        session.line({
          event: "captured",
          mechanism: "suspendBackground",
          prior: suspend,
        });
        session.line({
          event: "captured",
          mechanism: "priority",
          prior: priorityCapture,
        });
        session.line({ event: "ready" });
        // Reverse order: priority failed, the resume succeeded and must never be repeated.
        session.line({
          event: "ended",
          reason: "game-exited",
          reverts: [
            { id: "priority", state: "failed", detail: "access denied" },
            { id: "suspendBackground", state: "reverted", detail: "resumed" },
          ],
        });
      };
    };
    repo.setMeta("booster.powerPlan", crypto.randomUUID());
    await engine.start(game.id, "manual");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repo.boostRecord()?.captured).toEqual([priorityCapture]);
    await expect(engine.powerPlan("remove")).rejects.toThrow(/recovery/);
    await engine.recover();
    expect(platform.recovered).toEqual([[priorityCapture]]);
    repo.close();
  });
  it("says so when a mode had nothing to change on this PC", async () => {
    const { repo, game, platform, engine } = setup();
    platform.onSpawn = (session) => {
      session.onSend = ({ command }) => {
        if (command === "start") {
          session.line({
            event: "skipped",
            mechanism: "gameMode",
            detail: "already on",
          });
          session.line({ event: "ready" });
        }
      };
    };
    const session = await engine.start(game.id, "manual");
    expect(session?.message).toMatch(/nothing needed changing/);
    repo.close();
  });
  it("nm2-2: an aborted start is not killed by the start timer while it reverts", async () => {
    const { repo, game, platform } = setup();
    const engine = new BoostEngine(repo, platform, () => {}, {
      start: 30,
      stop: 1000,
    });
    platform.onSpawn = (session) => {
      session.onSend = ({ command }) => {
        if (command === "start")
          session.line({ event: "captured", mechanism: "gameMode", prior: {} });
        else if (command === "stop")
          // The revert takes longer than the start timeout.
          setTimeout(
            () =>
              session.line({
                event: "ended",
                reason: "stop",
                reverts: [
                  { id: "gameMode", state: "reverted", detail: "restored" },
                ],
              }),
            80,
          );
      };
    };
    const result = await engine.start(game.id, "manual");
    expect(platform.sessions[0]!.killed).toBe(false);
    expect(result).toMatchObject({ status: "ended", failed: true });
    expect(result?.message).toMatch(/could not save/);
    repo.close();
  });
  it("nm2-2: recovery after a helper crash stays failed and says so", async () => {
    const { repo, game, platform } = setup();
    const events: { status: string; failed: boolean; message: string }[] = [];
    const engine = new BoostEngine(repo, platform, (s) => events.push(s), {
      start: 1000,
      stop: 1000,
    });
    await engine.start(game.id, "manual");
    platform.sessions[0]!.kill();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repo.boostRecord()).toBeNull();
    expect(platform.recovered).toEqual([[priorityCapture]]);
    // The final session is ended but failed, with a truthful message, so the UI shows a warning.
    expect(events.at(-1)).toMatchObject({ status: "ended", failed: true });
    expect(events.at(-1)?.message).toMatch(/did not finish normally/);
    expect(repo.activity()[0]).toMatchObject({ status: "failed" });
    repo.close();
  });
  it("nm2-2: an aborted start whose helper hangs after stop is killed by the stop timer", async () => {
    const { repo, game, platform } = setup();
    const engine = new BoostEngine(repo, platform, () => {}, {
      start: 1000,
      stop: 30,
    });
    platform.onSpawn = (session) => {
      session.onSend = ({ command }) => {
        if (command === "start") {
          session.line({
            event: "captured",
            mechanism: "priority",
            prior: priorityCapture,
          });
          session.line({ event: "not-a-real-event" });
        }
        // The helper never answers "stop".
      };
    };
    const result = await engine.start(game.id, "manual");
    expect(platform.sessions[0]!.killed).toBe(true);
    expect(result).toMatchObject({ failed: true });
    // Not busy: a following operation runs instead of queueing forever.
    await expect(engine.recover()).resolves.toBeDefined();
    repo.close();
  });
  it("nm2-2: a crash after an early mechanism failure is still reported as abnormal", async () => {
    const { repo, game, platform } = setup();
    const events: { failed: boolean; message: string }[] = [];
    const engine = new BoostEngine(repo, platform, (s) => events.push(s), {
      start: 1000,
      stop: 1000,
    });
    platform.onSpawn = (session) => {
      session.onSend = ({ command }) => {
        if (command === "start") {
          session.line({
            event: "failed",
            mechanism: "gameMode",
            detail: "could not apply",
          });
          session.line({
            event: "captured",
            mechanism: "priority",
            prior: priorityCapture,
          });
          session.line({ event: "ready" });
        }
      };
    };
    await engine.start(game.id, "manual");
    platform.sessions[0]!.kill();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.at(-1)).toMatchObject({ failed: true });
    expect(events.at(-1)?.message).toMatch(/did not finish normally/);
    repo.close();
  });
  it("nm2-3: a revert that reports no results is never shown as restored", async () => {
    const { repo, game, platform, engine } = setup();
    platform.onSpawn = (session) => {
      scripted(session);
      const start = session.onSend;
      session.onSend = (command) => {
        if (command.command === "stop")
          session.line({
            event: "ended",
            reason: "stop",
            detail:
              "Revert stopped unexpectedly: Windows could not complete the change.",
            reverts: [],
          });
        else start(command);
      };
    };
    await engine.start(game.id, "manual");
    const ended = await engine.stop();
    expect(ended).toMatchObject({ status: "recovery-needed", failed: true });
    expect(ended?.message).toMatch(/did not report every revert/);
    expect(repo.boostRecord()?.captured).toEqual([priorityCapture]);
    await engine.recover();
    expect(platform.recovered).toEqual([[priorityCapture]]);
    repo.close();
  });
  it("nm2-4/nm2-5: released captures are dropped and completed reverts are not retried after a rejected report", async () => {
    const { repo, game, platform, engine } = setup();
    const suspend: Captured = {
      mechanism: "suspendBackground",
      process: { ...target, pid: 901, name: "sync" },
    };
    platform.onSpawn = (session) => {
      session.onSend = ({ command }) => {
        if (command !== "start") return;
        // Helper list: [rejected gameMode, priority, suspend (released)].
        session.line({ event: "captured", mechanism: "gameMode", prior: {} });
        session.line({
          event: "captured",
          mechanism: "priority",
          prior: priorityCapture,
        });
        session.line({
          event: "captured",
          mechanism: "suspendBackground",
          prior: suspend,
        });
        session.line({
          event: "released",
          mechanism: "suspendBackground",
          prior: suspend,
        });
        expect(repo.boostRecord()?.captured).toEqual([priorityCapture]);
        // Reverse order: suspend (never applied), priority reverted, the rejected capture failed.
        session.line({
          event: "ended",
          reason: "stop",
          reverts: [
            {
              id: "suspendBackground",
              state: "reverted",
              detail: "Never applied; nothing to undo.",
            },
            { id: "priority", state: "reverted", detail: "restored" },
            { id: "gameMode", state: "failed", detail: "access denied" },
          ],
        });
      };
    };
    const result = await engine.start(game.id, "manual");
    expect(result).toMatchObject({ status: "recovery-needed", failed: true });
    // The completed priority revert is not kept for retry; the failed one was never saved by Frameforge.
    expect(repo.boostRecord()?.captured).toEqual([]);
    repo.close();
  });
  it("quitting with an active session awaits stop and revert", async () => {
    const { repo, game, platform } = setup();
    const service = new AppService(repo, platform, {
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
