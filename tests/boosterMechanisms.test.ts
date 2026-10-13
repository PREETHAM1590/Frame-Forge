import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { Repository } from "../electron/repository";
import { MockPlatform, type SessionChannel } from "../electron/platform";
import { BoostEngine } from "../electron/booster";
import {
  BackupSchema,
  CapturedSchema,
  CustomMechanismsSchema,
  MechanismId,
  NetworkCheckSchema,
  SessionEventSchema,
  StateSchema,
  defaultState,
  modeMechanisms,
  requests,
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
const newIds = [
  "pauseServices",
  "gameBarCapture",
  "smartCores",
  "coreParking",
  "powerThrottling",
] as const;
// The same JSON the C# tests assert the helper writes (BoosterMechanismTests.NewJsonShapesMatchWhatNodeSendsAndExpects).
const helperLines = {
  gameBar: `{"mechanism":"gameBarCapture","regValues":[{"path":"Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\GameDVR","name":"AppCaptureEnabled","kind":"DWord","existed":false,"value":null,"applied":0}]}`,
  services: `{"mechanism":"pauseServices","items":["DiagTrack"]}`,
  parking: `{"mechanism":"coreParking","prior":"4","applied":"100","scheme":"396783ca-20d2-459f-b042-4722bc020d51","setting":"cpmincores"}`,
};
const csharpMechanismKeys =
  "gameMode,priority,affinity,powerPlan,lowerBackground,suspendBackground,closeBackground,timerResolution,pauseServices,gameBarCapture,smartCores,coreParking,powerThrottling".split(
    ",",
  );
describe("second-pass booster contracts", () => {
  it("keeps the mechanism keys identical to what the C# helper accepts", () => {
    expect(Object.keys(CustomMechanismsSchema.shape).sort()).toEqual(
      [...csharpMechanismKeys].sort(),
    );
    expect(MechanismId.options).toEqual(expect.arrayContaining([...newIds]));
  });
  it("parses the captured shapes the helper writes", () => {
    for (const line of Object.values(helperLines))
      expect(CapturedSchema.safeParse(JSON.parse(line)).success, line).toBe(
        true,
      );
    const event = {
      event: "captured",
      mechanism: "pauseServices",
      prior: JSON.parse(helperLines.services),
    };
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
    // Strict: nothing unknown, bounded lists.
    expect(
      CapturedSchema.safeParse({ mechanism: "pauseServices", extra: 1 })
        .success,
    ).toBe(false);
    expect(
      CapturedSchema.safeParse({
        mechanism: "smartCores",
        items: Array.from({ length: 300 }, String),
      }).success,
    ).toBe(false);
    expect(
      CapturedSchema.safeParse({
        mechanism: "coreParking",
        scheme: "not-a-guid",
      }).success,
    ).toBe(false);
    expect(
      SessionEventSchema.safeParse({
        event: "applied",
        mechanism: "smartCores",
        detail: "ok",
      }).success,
    ).toBe(true);
  });
  it("GC-4: configurations and backups saved before these mechanisms still parse, with them off", () => {
    const old = {
      ...defaultState,
      booster: {
        mode: "custom",
        autoBoost: true,
        custom: {
          gameMode: true,
          priority: "High",
          affinity: null,
          powerPlan: false,
          lowerBackground: true,
          suspendBackground: false,
          closeBackground: false,
          timerResolution: false,
        },
        background: [],
      },
    };
    const parsed = StateSchema.parse(old);
    // The first-pass session toggles are gone; their keys are rejected by the schema and removed by the migration below.
    expect(Object.keys(parsed.booster.custom)).not.toContain("gpuPreference");
    expect(parsed.booster.custom).toMatchObject({
      gameMode: true,
      priority: "High",
      ...Object.fromEntries(newIds.map((id) => [id, false])),
    });
    expect(
      BackupSchema.safeParse({
        id: crypto.randomUUID(),
        name: "Old",
        at: new Date().toISOString(),
        state: old,
      }).success,
    ).toBe(true);
    const dir = mkdtempSync(path.join(os.tmpdir(), "frameforge-v2-"));
    const file = path.join(dir, "old.db");
    try {
      new Repository(file).close();
      const db = new DatabaseSync(file);
      db.prepare("UPDATE configuration SET payload=? WHERE id=1").run(
        JSON.stringify(old),
      );
      db.close();
      const repo = new Repository(file);
      expect(repo.state().booster.custom.pauseServices).toBe(false);
      repo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("migration 4 drops the legacy GPU preference and fullscreen keys from configuration and backups", () => {
    const legacy = {
      ...defaultState,
      booster: {
        ...defaultState.booster,
        mode: "custom",
        custom: {
          ...defaultState.booster.custom,
          gameMode: true,
          gpuPreference: true,
          fullscreenOptimizations: true,
        },
      },
    };
    expect(StateSchema.safeParse(legacy).success).toBe(false);
    const dir = mkdtempSync(path.join(os.tmpdir(), "frameforge-v4-"));
    const file = path.join(dir, "legacy.db");
    try {
      const repo = new Repository(file);
      repo.backup("Before");
      repo.close();
      const db = new DatabaseSync(file);
      db.prepare("UPDATE configuration SET payload=? WHERE id=1").run(
        JSON.stringify(legacy),
      );
      db.prepare("UPDATE backups SET payload=?").run(JSON.stringify(legacy));
      db.exec("PRAGMA user_version=3");
      db.close();
      const migrated = new Repository(file);
      expect(migrated.state().booster.custom.gameMode).toBe(true);
      expect(Object.keys(migrated.state().booster.custom)).not.toContain(
        "fullscreenOptimizations",
      );
      expect(migrated.backups()).toHaveLength(1);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("wires the mechanisms into modes as researched", () => {
    const on = (mode: keyof typeof modeMechanisms) =>
      newIds.filter((id) => modeMechanisms[mode][id]);
    expect(on("off")).toEqual([]);
    expect(on("balanced").sort()).toEqual(
      ["gameBarCapture", "powerThrottling"].sort(),
    );
    expect(on("performance").sort()).toEqual(
      ["gameBarCapture", "powerThrottling", "smartCores"].sort(),
    );
    expect(on("competitive").sort()).toEqual(
      [
        "coreParking",
        "gameBarCapture",
        "pauseServices",
        "powerThrottling",
        "smartCores",
      ].sort(),
    );
    // Nothing that opens an administrator prompt before Competitive. GPU preference and fullscreen optimizations are
    // per-game launch settings and exist in no mode.
    expect(modeMechanisms.balanced.pauseServices).toBe(false);
    expect(modeMechanisms.performance.pauseServices).toBe(false);
    expect(MechanismId.options).not.toContain("gpuPreference");
    expect(MechanismId.options).not.toContain("fullscreenOptimizations");
    expect(Object.keys(modeMechanisms.competitive)).not.toContain(
      "gpuPreference",
    );
    // Smart cores is a preset default only where Windows has no Thread Director (the helper keeps it off in presets on Windows 11).
    expect(modeMechanisms.balanced.smartCores).toBe(false);
  });
  it("validates network check requests and results", () => {
    expect(
      requests.networkCheck.parse({ host: "example.com", count: 10 }),
    ).toEqual({ host: "example.com", count: 10 });
    expect(requests.networkCheck.parse({ host: "1.1.1.1" }).count).toBe(10);
    for (const host of [
      "",
      "a b",
      "x/y",
      "http://x",
      ";rm",
      "-x",
      "a".repeat(254),
    ])
      expect(
        requests.networkCheck.safeParse({ host, count: 10 }).success,
        host,
      ).toBe(false);
    expect(
      requests.networkCheck.safeParse({ host: "x.com", count: 31 }).success,
    ).toBe(false);
    expect(
      requests.networkCheck.safeParse({ host: "x.com", count: 10, shell: 1 })
        .success,
    ).toBe(false);
    expect(
      NetworkCheckSchema.safeParse({
        host: "x.com",
        address: null,
        sent: 0,
        received: 0,
        lossPercent: 100,
        minMs: null,
        avgMs: null,
        maxMs: null,
        jitterMs: null,
        samples: [],
        message: "no",
      }).success,
    ).toBe(true);
  });
});
class FakeSession extends EventEmitter implements SessionChannel {
  sent: Array<Record<string, unknown>> = [];
  onSend: (command: { command: string }) => void = () => {};
  killed = false;
  send(command: unknown) {
    this.sent.push(command as Record<string, unknown>);
    queueMicrotask(() => this.onSend(command as { command: string }));
  }
  kill() {
    this.killed = true;
    this.emit("exit");
  }
  line(event: unknown) {
    this.emit("event", event);
  }
}
const servicesCapture: Captured = {
  mechanism: "pauseServices",
  items: ["DiagTrack", "Spooler"],
};
class TestPlatform extends MockPlatform {
  override boostAvailable = true;
  sessions: FakeSession[] = [];
  recovered: Array<{ captured: Captured[]; interactive: boolean | undefined }> =
    [];
  running = [{ gameId: "", target }];
  onSpawn: (session: FakeSession) => void = () => {};
  revertState: MechanismResult["state"] = "reverted";
  override async runningGames() {
    return this.running;
  }
  override async boostRecover(
    captured: Captured[],
    _owned?: string | null,
    interactive?: boolean,
  ): Promise<MechanismResult[]> {
    this.recovered.push({ captured, interactive });
    // Without an administrator prompt the services step stays pending.
    return [...captured].reverse().map((c) => ({
      id: c.mechanism,
      state:
        c.mechanism === "pauseServices" && interactive === false
          ? "failed"
          : this.revertState,
      detail: "x",
    }));
  }
  override spawnSession() {
    const session = new FakeSession();
    this.sessions.push(session);
    this.onSpawn(session);
    return session;
  }
}
function setup(
  mode: "competitive" | "performance" = "competitive",
  source: "steam" | "xbox" | "msstore" = "steam",
  timeouts = { start: 50, stop: 50, elevated: 400 },
) {
  const repo = new Repository(":memory:");
  const game = {
    id: crypto.randomUUID(),
    name: "Test",
    path: "C:\\Games\\Test",
    source,
    executablePath: null,
    profile: "gaming" as const,
    notes: "",
    boostMode: "global" as const,
  };
  const state = repo.state();
  repo.updateState({
    ...state,
    games: [game],
    booster: { ...state.booster, mode },
  });
  const platform = new TestPlatform();
  platform.running = [{ gameId: game.id, target }];
  const engine = new BoostEngine(repo, platform, () => {}, timeouts);
  return { repo, game, platform, engine };
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A helper that journals the services step, waits (the administrator prompt) and then reports ready.
function promptSession(session: FakeSession, promptMs: number, endMs = 0) {
  session.onSend = ({ command }) => {
    if (command === "start") {
      session.line({
        event: "captured",
        mechanism: "pauseServices",
        prior: servicesCapture,
      });
      setTimeout(() => {
        session.line({
          event: "applied",
          mechanism: "pauseServices",
          detail: "Paused 2 service(s).",
        });
        session.line({ event: "ready" });
      }, promptMs);
    } else if (command === "stop")
      setTimeout(
        () =>
          session.line({
            event: "ended",
            reason: "stop",
            reverts: [{ id: "pauseServices", state: "reverted", detail: "ok" }],
          }),
        endMs,
      );
  };
}
describe("booster engine with services and automatic runs", () => {
  it("sends the new mechanisms, marks store games and never lets auto-boost prompt", async () => {
    const manual = setup("competitive", "xbox");
    manual.platform.onSpawn = (s) => promptSession(s, 0);
    await manual.engine.start(manual.game.id, "manual");
    const start = manual.platform.sessions[0]!.sent[0]!;
    expect(start).toMatchObject({
      command: "start",
      storeGame: true,
      unattended: false,
      mechanisms: { pauseServices: true, coreParking: true, smartCores: true },
    });
    await manual.engine.stop();

    const auto = setup("competitive", "steam");
    auto.platform.onSpawn = (s) => promptSession(s, 0);
    await auto.engine.start(auto.game.id, "auto", target);
    expect(auto.platform.sessions[0]!.sent[0]).toMatchObject({
      storeGame: false,
      unattended: true,
    });
    await auto.engine.stop();
    const store = setup("competitive", "msstore");
    store.platform.onSpawn = (s) => promptSession(s, 0);
    await store.engine.start(store.game.id, "manual");
    expect(store.platform.sessions[0]!.sent[0]).toMatchObject({
      storeGame: true,
    });
    await store.engine.stop();
  });
  it("waits for the administrator prompt on a manual start but not on auto-boost", async () => {
    const manual = setup();
    manual.platform.onSpawn = (s) => promptSession(s, 150);
    const session = await manual.engine.start(manual.game.id, "manual");
    expect(session?.status).toBe("active");
    expect(manual.platform.sessions[0]!.killed).toBe(false);
    await manual.engine.stop();

    // Auto-boost has no prompt to wait for: a helper that is silent past the plain start budget is killed.
    const auto = setup();
    auto.platform.onSpawn = (s) => promptSession(s, 150);
    const result = await auto.engine.start(auto.game.id, "auto", target);
    expect(auto.platform.sessions[0]!.killed).toBe(true);
    expect(result?.status).not.toBe("active");
  });
  it("tells the user up front that Windows will ask for administrator approval", async () => {
    const first = async (
      mode: "competitive" | "performance",
      reason: "manual" | "auto",
    ) => {
      const messages: string[] = [];
      const { engine, game, platform } = setup(mode);
      (
        engine as unknown as { notify: (s: { message: string }) => void }
      ).notify = (s) => messages.push(s.message);
      platform.onSpawn = (s) => promptSession(s, 0);
      await engine.start(game.id, reason, target);
      await engine.stop();
      return messages[0];
    };
    expect(await first("competitive", "manual")).toContain(
      "administrator approval",
    );
    expect(await first("competitive", "auto")).not.toContain(
      "administrator approval",
    );
    expect(await first("performance", "manual")).not.toContain(
      "administrator approval",
    );
  });
  it("gives a stop the time the revert prompt needs instead of killing the helper", async () => {
    const { engine, game, platform } = setup();
    platform.onSpawn = (s) => promptSession(s, 0, 150);
    await engine.start(game.id, "manual");
    const ended = await engine.stop();
    expect(platform.sessions[0]!.killed).toBe(false);
    expect(ended?.status).toBe("ended");
    expect(platform.recovered).toEqual([]);
  });
  it("recovers at startup without a prompt, leaves services pending, then restarts them on an explicit retry", async () => {
    const { engine, game, platform, repo } = setup();
    // A session that died with services paused.
    platform.onSpawn = (s) => {
      promptSession(s, 0);
    };
    await engine.start(game.id, "manual");
    platform.sessions[0]!.kill();
    await delay(20);
    expect(repo.boostSession()?.status).toBe("recovery-needed");
    // The exit handler's automatic recovery was unattended.
    expect(platform.recovered.at(-1)?.interactive).toBe(false);
    const restarted = new BoostEngine(repo, platform, () => {}, {
      start: 50,
      stop: 50,
    });
    const startup = await restarted.recoverAtStartup();
    expect(platform.recovered.at(-1)).toMatchObject({ interactive: false });
    expect(startup?.status).toBe("recovery-needed");
    expect(startup?.message).toContain("could not restore");
    expect(repo.boostRecord()?.captured).toEqual([servicesCapture]);
    // Retry from the UI is interactive.
    const retried = await restarted.recover();
    expect(platform.recovered.at(-1)).toMatchObject({ interactive: true });
    expect(retried?.status).toBe("ended");
    expect(repo.boostSession()).toBeNull();
  });
  it("persists the new capture shapes and drops them once reverted", async () => {
    const { repo, game } = setup();
    const captured: Captured[] = Object.values(helperLines).map((line) =>
      CapturedSchema.parse(JSON.parse(line)),
    );
    repo.saveBoostSession(
      {
        id: crypto.randomUUID(),
        gameId: game.id,
        mode: "competitive",
        target,
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "active",
        message: "x",
        mechanisms: [],
        samples: [],
        failed: false,
        abnormal: false,
      },
      captured,
    );
    expect(repo.boostRecord()?.captured).toEqual(captured);
    repo.recoverInterrupted();
    const platform = new TestPlatform();
    const engine = new BoostEngine(repo, platform, () => {});
    expect((await engine.recover())?.status).toBe("ended");
    expect(platform.recovered[0]!.captured).toEqual(captured);
    expect(repo.boostSession()).toBeNull();
  });
});
