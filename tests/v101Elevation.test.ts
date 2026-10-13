import { EventEmitter } from "node:events";
import os from "node:os";
import { afterEach, describe, it, expect, vi } from "vitest";
import { Repository } from "../electron/repository";
import {
  ElevationGate,
  MockPlatform,
  type SessionChannel,
} from "../electron/platform";
import { BoostEngine } from "../electron/booster";
import { AppService } from "../electron/service";
import {
  CustomMechanismsSchema,
  GameSchema,
  defaultState,
  responses,
  type BoostCapabilities,
  type TimerGlobalResult,
  type ProcessTarget,
} from "../shared/contracts";

const target: ProcessTarget = {
  pid: 321,
  startTime: "2026-10-12T10:00:00.0000000Z",
  executablePath: "C:/Games/Test/game.exe",
  name: "game",
  priority: "Normal",
};
class Fake extends EventEmitter implements SessionChannel {
  sent: Array<{ command: string } & Record<string, unknown>> = [];
  onSend: (command: { command: string }) => void = () => {};
  send(command: unknown) {
    this.sent.push(command as never);
    queueMicrotask(() => this.onSend(command as { command: string }));
  }
  kill() {
    this.emit("exit");
  }
  line(event: unknown) {
    this.emit("event", event);
  }
}
const servicesCapture = {
  mechanism: "pauseServices" as const,
  items: ["DiagTrack"],
};
class Platform extends MockPlatform {
  override boostAvailable = true;
  sessions: Fake[] = [];
  gameId = "";
  timerCalls: Array<Record<string, unknown>> = [];
  timerValue: { existed: boolean; value: number | null } = {
    existed: false,
    value: null,
  };
  nextTimer: TimerGlobalResult | Error | null = null;
  capabilityCalls: Array<[string | null, boolean | undefined]> = [];
  override async runningGames() {
    return [{ gameId: this.gameId, target }];
  }
  override async boostCapabilities(
    ownedPlan?: string | null,
    timerRestartPending?: boolean,
  ): Promise<BoostCapabilities> {
    this.capabilityCalls.push([ownedPlan ?? null, timerRestartPending]);
    return {
      logicalCpus: 12,
      mechanisms: [],
      timerGlobal: { eligible: true, enabled: this.timerValue.value === 1 },
    };
  }
  override async timerGlobal(call: {
    op: "read" | "enable" | "restore";
    existed?: boolean;
    value?: number | null;
  }): Promise<TimerGlobalResult> {
    this.timerCalls.push(call);
    if (call.op === "read")
      return {
        state: "ready",
        detail: "Off in Windows.",
        existed: this.timerValue.existed,
        value: this.timerValue.value,
      };
    const next = this.nextTimer;
    this.nextTimer = null;
    if (next instanceof Error) throw next;
    if (next) return next;
    if (call.op === "enable") {
      this.timerValue = { existed: true, value: 1 };
      return {
        state: "applied",
        detail: "Turned on. Restart Windows.",
        existed: !!call.existed,
        value: call.value ?? null,
      };
    }
    this.timerValue = {
      existed: !!call.existed,
      value: call.value ?? null,
    };
    return {
      state: "reverted",
      detail: "Back to the original value.",
      existed: !!call.existed,
      value: call.value ?? null,
    };
  }
  override async boostRecover() {
    return [];
  }
  override spawnSession() {
    const s = new Fake();
    this.sessions.push(s);
    return s;
  }
}
function seed(mode: "competitive" | "performance" | "custom" = "competitive") {
  const repo = new Repository(":memory:");
  const game = GameSchema.parse({
    id: crypto.randomUUID(),
    name: "Test",
    path: "C:/Games/Test",
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
  const platform = new Platform();
  platform.gameId = game.id;
  return { repo, game, platform };
}
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
// A helper that waits for the administrator prompt after reporting ready.
function waiting(s: Fake) {
  s.onSend = ({ command }) => {
    if (command === "start") {
      s.line({
        event: "captured",
        mechanism: "pauseServices",
        prior: servicesCapture,
      });
      s.line({
        event: "pending",
        mechanism: "pauseServices",
        detail: "Waiting for administrator approval to pause services.",
      });
      s.line({ event: "ready" });
    } else if (command === "stop")
      s.line({
        event: "ended",
        reason: "stop",
        reverts: [{ id: "pauseServices", state: "reverted", detail: "ok" }],
      });
  };
}
// A helper with nothing to wait for.
function plain(s: Fake) {
  s.onSend = ({ command }) => {
    if (command === "start") s.line({ event: "ready" });
    if (command === "stop")
      s.line({ event: "ended", reason: "stop", reverts: [] });
  };
}
// Every session the platform spawns behaves like `script`; the helper is also handed back to the test.
function spawnWith(platform: Platform, script: (s: Fake) => void) {
  const original = platform.spawnSession.bind(platform);
  const helpers: Fake[] = [];
  platform.spawnSession = () => {
    const s = original();
    script(s);
    helpers.push(s);
    return s;
  };
  return helpers;
}
afterEach(() => vi.restoreAllMocks());

describe("one administrator prompt at a time", () => {
  it("lets the same user take the gate again and refuses another", async () => {
    const gate = new ElevationGate();
    gate.hold("restore");
    gate.hold("restore");
    expect(() => gate.hold("timer")).toThrow(
      /System Restore request is waiting.*never open together/,
    );
    gate.release("timer");
    expect(gate.current).toBe("restore");
    gate.release("restore");
    await expect(
      gate.with("boost", async () => {
        expect(gate.current).toBe("boost");
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    expect(gate.current).toBeNull();
  });
  it("holds the gate from a manual services start until the answer, and again while services stay paused", async () => {
    const { repo, game, platform } = seed();
    const engine = new BoostEngine(repo, platform, () => {}, {
      start: 1000,
      stop: 1000,
    });
    const helpers = spawnWith(platform, waiting);
    const session = await engine.start(game.id, "manual");
    expect(session?.status).toBe("active");
    expect(session?.message).toMatch(/Waiting for administrator approval/);
    expect(platform.elevation.current).toBe("boost");
    const helper = helpers[0]!;
    // The prompt is answered: services are paused, so the end-of-session restart may still ask. The gate stays.
    helper.line({
      event: "applied",
      mechanism: "pauseServices",
      detail: "Paused 1 service(s).",
    });
    expect(platform.elevation.current).toBe("boost");
    await engine.stop();
    expect(platform.elevation.current).toBeNull();
    repo.close();
  });
  it("releases the gate when the prompt is declined and nothing stays paused", async () => {
    const { repo, game, platform } = seed();
    const engine = new BoostEngine(repo, platform, () => {}, {
      start: 1000,
      stop: 1000,
    });
    const helpers = spawnWith(platform, waiting);
    await engine.start(game.id, "manual");
    const helper = helpers[0]!;
    expect(platform.elevation.current).toBe("boost");
    helper.line({
      event: "released",
      mechanism: "pauseServices",
      prior: servicesCapture,
    });
    helper.line({
      event: "skipped",
      mechanism: "pauseServices",
      detail: "Skipped (admin declined).",
    });
    expect(platform.elevation.current).toBeNull();
    await engine.stop();
    repo.close();
  });
  it("refuses a manual services start while a restore prompt is open, and auto-boost never takes the gate", async () => {
    const { repo, game, platform } = seed();
    const engine = new BoostEngine(repo, platform, () => {}, {
      start: 1000,
      stop: 1000,
    });
    platform.elevation.hold("restore");
    await expect(engine.start(game.id, "manual")).rejects.toThrow(
      /System Restore request is waiting/,
    );
    expect(repo.boostSession()).toBeNull();
    expect(platform.sessions).toHaveLength(0);
    // Auto-boost opens no prompt, so it is not blocked.
    spawnWith(platform, plain);
    const auto = await engine.start(game.id, "auto", target);
    expect(auto?.status).toBe("active");
    await engine.stop();
    repo.close();
  });
  it("refuses interactive recovery with paused services while another prompt is open", async () => {
    const { repo, game, platform } = seed();
    repo.saveBoostSession(
      {
        id: crypto.randomUUID(),
        gameId: game.id,
        mode: "competitive",
        target,
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "recovery-needed",
        message: "x",
        mechanisms: [],
        samples: [],
        failed: true,
        abnormal: false,
      },
      [servicesCapture],
    );
    const engine = new BoostEngine(repo, platform, () => {});
    platform.elevation.hold("timer");
    await expect(engine.recover()).rejects.toThrow(/timer setting is waiting/);
    platform.elevation.release("timer");
    const result = await engine.recover();
    expect(result?.status).toBe("ended");
    expect(platform.elevation.current).toBeNull();
    repo.close();
  });
});

describe("request mutual exclusion at the service", () => {
  it("keeps restore requests, Game Mode starts and power plans from overlapping", async () => {
    const { repo, platform } = seed("performance");
    const service = new AppService(repo, platform, desktop);
    // A restore request in flight: the list opens an administrator prompt.
    let release!: () => void;
    platform.restoreList = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            points: [],
            available: true,
            message: "none",
            createdSequence: null,
          });
      });
    const listing = service.dispatch("restorePoints", {});
    await vi.waitFor(() => expect(platform.elevation.current).toBe("restore"));
    // A second list is refused (it used to run concurrently), and so are the Windows-changing booster requests.
    await expect(service.dispatch("restorePoints", {})).rejects.toThrow(
      /already running/,
    );
    await expect(
      service.dispatch("boostStart", {
        gameId: platform.gameId,
        confirmed: true,
      }),
    ).rejects.toThrow(/System Restore request to finish/);
    await expect(
      service.dispatch("boostRecover", { confirmed: true }),
    ).rejects.toThrow(/System Restore request to finish/);
    await expect(
      service.dispatch("boostPowerPlan", { action: "create", confirmed: true }),
    ).rejects.toThrow(/System Restore request to finish/);
    await expect(
      service.dispatch("boostTimerGlobal", {
        action: "enable",
        confirmed: true,
      }),
    ).rejects.toThrow(/System Restore request to finish/);
    release();
    await listing;
    expect(platform.elevation.current).toBeNull();
    repo.close();
  });
  it("refuses restore requests while Game Mode is starting or a launch setting is changing", async () => {
    const { repo, game, platform } = seed("performance");
    const service = new AppService(repo, platform, desktop);
    const helpers = spawnWith(platform, () => {});
    // The helper has not answered yet, so the booster is busy.
    const starting = service.dispatch("boostStart", {
      gameId: game.id,
      confirmed: true,
    });
    await vi.waitFor(() => expect(helpers).toHaveLength(1));
    const helper = helpers[0]!;
    for (const [method, input] of [
      ["restorePoints", {}],
      ["createRestorePoint", { name: "Frameforge test", confirmed: true }],
      ["enableSystemProtection", { confirmed: true }],
      ["recoverRestoreFrequency", { confirmed: true }],
    ] as const)
      await expect(service.dispatch(method, input)).rejects.toThrow(
        /Wait for Game Mode/,
      );
    helper.line({ event: "ready" });
    await starting;
    helper.line({ event: "ended", reason: "stop", reverts: [] });
    repo.close();
  });
});

describe("timer resolution opt-in on Windows 11", () => {
  it("saves the prior value before the prompt and keeps it until Turn back off", async () => {
    const { repo, platform } = seed();
    const order: string[] = [];
    const real = platform.timerGlobal.bind(platform);
    platform.timerGlobal = async (call) => {
      if (call.op === "enable")
        order.push(
          `record=${JSON.stringify(repo.meta("booster.timerGlobal"))}`,
        );
      return real(call);
    };
    const engine = new BoostEngine(repo, platform, () => {});
    const status = await engine.timerGlobal("enable");
    // Recorded before the elevated call, as pending, with the exact prior state.
    expect(order[0]).toMatch(/"existed":false,"value":null.*"pending":true/);
    expect(platform.timerCalls.at(-1)).toMatchObject({
      op: "enable",
      existed: false,
      value: null,
    });
    expect(repo.meta("booster.timerGlobal")).toMatchObject({
      existed: false,
      value: null,
    });
    expect(
      (repo.meta("booster.timerGlobal") as { pending?: boolean }).pending,
    ).toBeUndefined();
    expect(status.timer).toEqual({
      eligible: true,
      enabled: true,
      ownedByFrameforge: true,
      restartRequired: true,
    });
    expect(platform.elevation.current).toBeNull();
    // Turning it back restores exactly the saved value and forgets the record.
    const back = await engine.timerGlobal("restore");
    expect(platform.timerCalls.at(-1)).toMatchObject({
      op: "restore",
      existed: false,
      value: null,
    });
    expect(repo.meta("booster.timerGlobal")).toBeNull();
    expect(back.timer.ownedByFrameforge).toBe(false);
    expect(back.timer.enabled).toBe(false);
    repo.close();
  });
  it("asks for a restart until Windows has restarted after the change", async () => {
    const { repo, platform } = seed();
    const engine = new BoostEngine(repo, platform, () => {});
    await engine.timerGlobal("enable");
    expect((await engine.status()).timer.restartRequired).toBe(true);
    // The capability probe is told, so the helper reports the mechanism unavailable until then.
    expect(platform.capabilityCalls.at(-1)?.[1]).toBe(true);
    // Windows started a minute after the setting was written.
    const record = repo.meta("booster.timerGlobal") as { appliedAt: string };
    vi.spyOn(os, "uptime").mockReturnValue(
      (Date.now() - Date.parse(record.appliedAt)) / 1000 - 60,
    );
    // Uptime shorter than the age of the record means the PC restarted since.
    expect((await engine.status()).timer.restartRequired).toBe(false);
    repo.close();
  });
  it("drops the record and says why when the prompt is declined or nothing was changed", async () => {
    const { repo, platform } = seed();
    const engine = new BoostEngine(repo, platform, () => {});
    platform.nextTimer = {
      state: "declined",
      detail: "Administrator approval was declined. Nothing was changed.",
      existed: false,
      value: null,
    };
    await expect(engine.timerGlobal("enable")).rejects.toThrow(
      /declined. Nothing was changed/,
    );
    expect(repo.meta("booster.timerGlobal")).toBeNull();
    expect(repo.activity().some((a) => a.message.includes("not changed"))).toBe(
      true,
    );
    expect(platform.elevation.current).toBeNull();
    repo.close();
  });
  it("keeps the saved value when the answer is lost but Windows shows the setting on", async () => {
    const { repo, platform } = seed();
    const engine = new BoostEngine(repo, platform, () => {});
    platform.nextTimer = {
      state: "failed",
      detail: "The administrator step returned no readable result.",
      existed: false,
      value: null,
    };
    platform.timerValue = { existed: true, value: 1 };
    // Simulate: the read before sees it off, the read after sees it on.
    let reads = 0;
    const real = platform.timerGlobal.bind(platform);
    platform.timerGlobal = async (call) => {
      if (call.op === "read" && ++reads === 1)
        return { state: "ready", detail: "Off.", existed: false, value: null };
      return real(call);
    };
    await expect(engine.timerGlobal("enable")).rejects.toThrow(/no readable/);
    expect(repo.meta("booster.timerGlobal")).toMatchObject({
      existed: false,
      value: null,
    });
    repo.close();
  });
  it("refuses while a session exists, when already on, and twice in a row", async () => {
    const { repo, game, platform } = seed();
    const engine = new BoostEngine(repo, platform, () => {});
    platform.timerValue = { existed: true, value: 1 };
    await expect(engine.timerGlobal("enable")).rejects.toThrow(
      /already on in Windows/,
    );
    expect(repo.meta("booster.timerGlobal")).toBeNull();
    platform.timerValue = { existed: false, value: null };
    await engine.timerGlobal("enable");
    await expect(engine.timerGlobal("enable")).rejects.toThrow(
      /already turned this on/,
    );
    await engine.timerGlobal("restore");
    await expect(engine.timerGlobal("restore")).rejects.toThrow(
      /has not turned this setting on/,
    );
    repo.saveBoostSession(
      {
        id: crypto.randomUUID(),
        gameId: game.id,
        mode: "performance",
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
      [],
    );
    await expect(engine.timerGlobal("enable")).rejects.toThrow(
      /Stop the boost session/,
    );
    repo.close();
  });
  it("tells the session helper when a restart is still pending", async () => {
    const { repo, game, platform } = seed();
    const engine = new BoostEngine(repo, platform, () => {}, {
      start: 1000,
      stop: 1000,
    });
    await engine.timerGlobal("enable");
    spawnWith(platform, plain);
    await engine.start(game.id, "auto", target);
    expect(platform.sessions[0]!.sent[0]).toMatchObject({
      timerRestartPending: true,
    });
    await engine.stop();
    repo.close();
  });
  it("answers through the validated IPC method and demo mode refuses it", async () => {
    const { repo, platform } = seed();
    const service = new AppService(repo, platform, desktop);
    const status = (await service.dispatch("boostTimerGlobal", {
      action: "enable",
      confirmed: true,
    })) as { timer: { ownedByFrameforge: boolean } };
    expect(status.timer.ownedByFrameforge).toBe(true);
    await expect(
      service.dispatch("boostTimerGlobal", { action: "enable" }),
    ).rejects.toThrow();
    expect(
      responses.boostStatus.safeParse({
        session: null,
        capabilities: { logicalCpus: 0, mechanisms: [] },
        watching: false,
        ownedPowerPlan: false,
      }).success,
    ).toBe(true);
    repo.close();
  });
});

describe("standby purge and the new session states", () => {
  it("is a custom opt-in that older saved configurations default to off", () => {
    const old = {
      gameMode: false,
      priority: "Normal",
      affinity: null,
      powerPlan: false,
      lowerBackground: false,
      suspendBackground: false,
      closeBackground: false,
      timerResolution: false,
    };
    expect(CustomMechanismsSchema.parse(old).standbyPurge).toBe(false);
    expect(defaultState.booster.custom.standbyPurge).toBe(false);
  });
  it("shows a pending prompt row that the final result replaces", async () => {
    const { repo, game, platform } = seed("custom");
    repo.updateState({
      ...repo.state(),
      booster: {
        ...repo.state().booster,
        custom: { ...repo.state().booster.custom, standbyPurge: true },
      },
    });
    const engine = new BoostEngine(repo, platform, () => {}, {
      start: 1000,
      stop: 1000,
    });
    const helpers = spawnWith(platform, (helper) => {
      helper.onSend = ({ command }) => {
        if (command === "start") {
          helper.line({
            event: "pending",
            mechanism: "standbyPurge",
            detail: "Waiting for administrator approval.",
          });
          helper.line({ event: "ready" });
        }
        if (command === "stop")
          helper.line({ event: "ended", reason: "stop", reverts: [] });
      };
    });
    const session = await engine.start(game.id, "manual");
    expect(platform.sessions[0]!.sent[0]).toMatchObject({
      mechanisms: { standbyPurge: true },
    });
    expect(session?.mechanisms).toEqual([
      expect.objectContaining({ id: "standbyPurge", state: "pending" }),
    ]);
    expect(platform.elevation.current).toBe("boost");
    helpers[0]!.line({
      event: "applied",
      mechanism: "standbyPurge",
      detail: "Cleared the standby memory list once.",
    });
    expect(repo.boostSession()?.mechanisms).toEqual([
      expect.objectContaining({ id: "standbyPurge", state: "applied" }),
    ]);
    // Nothing to revert, so nothing keeps the gate.
    expect(platform.elevation.current).toBeNull();
    await engine.stop();
    repo.close();
  });
});
