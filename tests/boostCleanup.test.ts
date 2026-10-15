import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import { Repository } from "../electron/repository";
import { MockPlatform, type SessionChannel } from "../electron/platform";
import { BoostEngine } from "../electron/booster";
import {
  GameSchema,
  type ProcessTarget,
  type RunningProcess,
} from "../shared/contracts";
import { planCleanup, trimMinBytes } from "../shared/boostCleanup";
import { summarizeSession } from "../shared/sessionChanges";

const target: ProcessTarget = {
  pid: 321,
  startTime: "2026-10-12T10:00:00.0000000Z",
  executablePath: "C:\\Games\\Test\\game.exe",
  name: "game",
  priority: "Normal",
};
const MB = 1024 * 1024;
const proc = (
  image: string,
  mb: number,
  extra: Partial<RunningProcess> = {},
): RunningProcess => ({
  image,
  pid: 1,
  protected: false,
  workingSetBytes: mb * MB,
  ...extra,
});

describe("planCleanup", () => {
  const processes = [
    proc("chrome.exe", 900),
    proc("small.exe", 40),
    proc("game.exe", 3000),
    proc("Discord.exe", 700),
    proc("Realtek.exe", 500),
    proc("sys.exe", 800, { protected: true }),
    proc("Steam.exe", 600),
  ];
  const plan = planCleanup({
    rules: [
      { image: "chrome.exe", action: "close" },
      { image: "Discord.exe", action: "close" },
      { image: "onedrive.exe", action: "suspend" },
      { image: "slack.exe", action: "lower" },
      { image: "stuck.exe", action: "end" },
    ],
    processes,
    gameImage: "game.exe",
    relaunch: true,
    purge: false,
  });
  it("keeps close, end and pause for the clean-up and lower for the normal toggle", () => {
    expect(plan.plan.rules.map((r) => `${r.image}:${r.action}`)).toEqual([
      "chrome.exe:close",
      "onedrive.exe:suspend",
      "stuck.exe:end",
    ]);
    expect(plan.lower).toEqual([{ image: "slack.exe", action: "lower" }]);
  });
  it("never touches voice chat, and says why", () => {
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]).toMatchObject({ image: "Discord.exe" });
    expect(plan.blocked[0]!.reason).toMatch(/voice/i);
  });
  it("trims only big, unprotected background programs that are not the game or never-touch", () => {
    expect(plan.plan.trim).toEqual(["chrome.exe"]);
    expect(plan.plan.trimMinBytes).toBe(trimMinBytes);
    expect(plan.plan.relaunch).toBe(true);
    expect(plan.plan.purge).toBe(false);
  });
});

class FakeSession extends EventEmitter implements SessionChannel {
  sent: Array<Record<string, unknown>> = [];
  onSend: (command: { command: string }) => void = () => {};
  send(command: unknown) {
    this.sent.push(command as Record<string, unknown>);
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
  running = [{ gameId: "", target }];
  list: RunningProcess[] = [];
  override async runningGames() {
    return this.running;
  }
  override async backgroundProcesses() {
    return this.list;
  }
  override spawnSession() {
    const session = new FakeSession();
    this.sessions.push(session);
    session.onSend = ({ command }) => {
      if (command === "start") {
        // The helper's order: apps first, then memory, then ready.
        session.line({
          event: "applied",
          mechanism: "closeBackground",
          detail: "chrome.exe: closed 9 process(es). It is not reopened.",
        });
        session.line({
          event: "applied",
          mechanism: "freeMemory",
          detail:
            "Freed 1.2 GB (from 5.1 to 6.3 GB available). Trimmed 3 background process(es) over 100 MB.",
        });
        session.line({ event: "ready" });
      } else if (command === "stop")
        session.line({ event: "ended", reason: "stop", reverts: [] });
    };
    return session;
  }
}
function setup(settings: Record<string, unknown> = {}) {
  const repo = new Repository(":memory:");
  const game = GameSchema.parse({
    id: crypto.randomUUID(),
    name: "Test",
    path: "C:\\Games\\Test",
    executablePath: "C:\\Games\\Test\\game.exe",
    source: "steam",
    profile: "gaming",
    notes: "",
  });
  const state = repo.state();
  repo.updateState({
    ...state,
    games: [game],
    settings: { ...state.settings, ...settings },
    booster: {
      ...state.booster,
      mode: "balanced",
      background: [
        { image: "chrome.exe", action: "close" },
        { image: "Discord.exe", action: "suspend" },
        { image: "slack.exe", action: "lower" },
      ],
      backgroundChosen: true,
    },
  });
  const platform = new TestPlatform();
  platform.running = [{ gameId: game.id, target }];
  platform.list = [proc("chrome.exe", 900), proc("game.exe", 3000)];
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

describe("boost start clean-up in the engine", () => {
  it("sends the clean-up with every boost, in any mode, and keeps lower for the mode", async () => {
    const { platform, engine, game } = setup();
    const session = await engine.start(game.id, "manual");
    const sent = platform.sessions[0]!.sent[0] as {
      background: unknown;
      cleanup: { rules: unknown; trim: string[]; relaunch: boolean };
    };
    expect(sent.background).toEqual([{ image: "slack.exe", action: "lower" }]);
    expect(sent.cleanup.rules).toEqual([
      { image: "chrome.exe", action: "close" },
    ]);
    expect(sent.cleanup.trim).toEqual(["chrome.exe"]);
    expect(sent.cleanup.relaunch).toBe(false);
    // A never-touch app shows as skipped, before anything the helper did, with the reason.
    expect(session?.mechanisms[0]).toMatchObject({
      id: "suspendBackground",
      state: "skipped",
      code: "never-touch",
    });
    expect(session?.mechanisms[0]!.detail).toMatch(/voice/i);
    await engine.stop();
  });
  it("reports apps closed before memory freed, honestly, in the panel and the tray", async () => {
    const { engine, game } = setup();
    const session = await engine.start(game.id, "manual");
    const ids = session!.mechanisms.map((m) => m.id);
    expect(ids.indexOf("closeBackground")).toBeLessThan(
      ids.indexOf("freeMemory"),
    );
    const summary = summarizeSession(session!);
    expect(summary.tray).toContain("Closed 1 app.");
    expect(summary.tray).toContain("Freed 1.2 GB.");
    await engine.stop();
  });
  it("says memory was already fine when nothing was tight", () => {
    const summary = summarizeSession({
      status: "active",
      mechanisms: [
        {
          id: "freeMemory",
          state: "skipped",
          code: "already-set",
          detail: "Memory was already fine: 12.0 GB of 16.0 GB available.",
        },
      ],
    });
    expect(summary.tray).toContain("Memory was already fine.");
    expect(summary.tray).not.toContain("Freed");
  });
  it("is skipped entirely when the setting is off, using the old behaviour", async () => {
    const { platform, engine, game } = setup({ boostCleanup: false });
    await engine.start(game.id, "manual");
    const sent = platform.sessions[0]!.sent[0]!;
    expect(sent.cleanup).toBeUndefined();
    expect(sent.background).toHaveLength(3);
    await engine.stop();
  });
  it("passes the reopen choice and allows the standby purge only with admin approval", async () => {
    const a = setup({ relaunchClosed: true });
    await a.engine.start(a.game.id, "manual");
    const first = a.platform.sessions[0]!.sent[0] as {
      cleanup: { relaunch: boolean; purge: boolean };
      brokerOnly: boolean;
    };
    expect(first.cleanup.relaunch).toBe(true);
    expect(first.cleanup.purge).toBe(false);
    await a.engine.stop();
    const b = setup({ autoBoostAdmin: true });
    await b.engine.start(b.game.id, "manual");
    expect(
      (b.platform.sessions[0]!.sent[0] as { cleanup: { purge: boolean } })
        .cleanup.purge,
    ).toBe(true);
    await b.engine.stop();
  });
});
