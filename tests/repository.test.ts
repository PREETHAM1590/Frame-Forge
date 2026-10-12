import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { Repository } from "../electron/repository";
import { migrations } from "../electron/migrations";
import { BoostSessionSchema, type ProcessTarget } from "../shared/contracts";
describe("SQLite migrations and configuration recovery", () => {
  it("persists validated configuration and restores named backups transactionally", () => {
    const repo = new Repository(":memory:");
    const initial = repo.state();
    const backup = repo.backup("Before preferences");
    repo.updateState({
      ...initial,
      settings: { ...initial.settings, theme: "light" },
    });
    expect(repo.state().settings.theme).toBe("light");
    repo.restore(backup.id);
    expect(repo.state()).toEqual(initial);
    expect(repo.backups()).toHaveLength(2);
    repo.close();
  });
  it("rejects malformed restore data and preserves configuration", () => {
    const repo = new Repository(":memory:");
    expect(() => repo.updateState({ version: 55 } as never)).toThrow();
    expect(() => repo.restore(crypto.randomUUID())).toThrow();
    expect(repo.state().version).toBe(1);
    repo.close();
  });
  it("retains durable recovery journal independently from configuration backups", () => {
    const repo = new Repository(":memory:");
    const row = repo.beginOperation(
      ["mouse-precision"],
      { values: [] },
      "backup",
    );
    expect(repo.activity()[0].status).toBe("running");
    repo.recoverInterrupted();
    expect(repo.activity()[0].status).toBe("recovery-needed");
    expect(repo.operation(row.id)?.snapshot).toEqual({ values: [] });
    repo.close();
  });
  it("keeps restorable, running and recovery records beyond the ordinary history limit", () => {
    const repo = new Repository(":memory:");
    const restored = repo.beginOperation(
      ["mouse-precision"],
      { values: [] },
      "backup",
    );
    repo.finish(restored.id, "success", "Verified");
    const recovery = repo.beginOperation(
      ["capture-off"],
      { values: [] },
      "backup",
    );
    repo.finish(recovery.id, "recovery-needed", "Retry recovery", false);
    const running = repo.beginOperation(
      ["mouse-precision"],
      { values: [] },
      "backup",
    );
    repo.finish(running.id, "running", "In progress", false);
    for (let i = 0; i < 510; i++) repo.log("Diagnostics", `Entry ${i}`);
    const activity = repo.activity();
    expect(activity.map((row) => row.id)).toEqual(
      expect.arrayContaining([restored.id, recovery.id, running.id]),
    );
    expect(
      activity.filter(
        (row) =>
          !row.rollback && !["running", "recovery-needed"].includes(row.status),
      ),
    ).toHaveLength(500);
    repo.close();
  });
  it("migrates v1 payloads: custom game exe paths move to executablePath in configuration and backups", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "frameforge-repo-"));
    const file = path.join(dir, "v1.db");
    const exe = "C:\\Games\\X\\x.exe";
    const v1 = (gamePath: string) =>
      JSON.stringify({
        version: 1,
        settings: {
          theme: "dark",
          startup: false,
          notifications: true,
          diagnostics: false,
        },
        games: [
          {
            id: crypto.randomUUID(),
            name: "X",
            path: gamePath,
            source: "custom",
            profile: "gaming",
            notes: "",
          },
          {
            id: crypto.randomUUID(),
            name: "Steam",
            path: "C:\\Steam\\common\\Y",
            source: "steam",
            profile: "balanced",
            notes: "",
          },
        ],
        presets: [],
        gameMode: { gameId: null, active: false },
      });
    const old = new DatabaseSync(file);
    old.exec(migrations[0] as string);
    old.exec("PRAGMA user_version=1");
    old
      .prepare("INSERT INTO configuration(id,payload) VALUES(1,?)")
      .run(v1(exe));
    old
      .prepare("INSERT INTO backups(id,name,at,payload) VALUES(?,?,?,?)")
      .run(
        crypto.randomUUID(),
        "old",
        new Date().toISOString(),
        v1(exe.toUpperCase()),
      );
    old.close();
    const repo = new Repository(file);
    const [custom, steam] = repo.state().games;
    expect(custom).toMatchObject({
      path: "C:\\Games\\X",
      executablePath: exe,
    });
    expect(steam).toMatchObject({
      path: "C:\\Steam\\common\\Y",
      executablePath: null,
    });
    expect(repo.backups()[0]?.state.games[0]).toMatchObject({
      path: "C:\\GAMES\\X",
      executablePath: exe.toUpperCase(),
    });
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it("persists boost sessions and marks interrupted ones as recovery-needed", () => {
    const repo = new Repository(":memory:");
    const target: ProcessTarget = {
      pid: 5,
      startTime: "2026-10-12T10:00:00.0000000Z",
      executablePath: "C:\\g\\g.exe",
      name: "g",
      priority: "Normal",
    };
    const session = BoostSessionSchema.parse({
      id: crypto.randomUUID(),
      gameId: crypto.randomUUID(),
      target,
      startedAt: new Date().toISOString(),
      status: "active",
      message: "ok",
    });
    expect(repo.boostSession()).toBeNull();
    const captured = [
      {
        mechanism: "priority" as const,
        process: target,
        prior: "Normal",
        applied: "High",
      },
    ];
    repo.saveBoostSession(session, captured);
    expect(repo.boostRecord()).toEqual({ session, captured });
    repo.recoverInterrupted();
    expect(repo.boostSession()?.status).toBe("recovery-needed");
    repo.saveBoostSession({ ...session, status: "ended" }, captured);
    expect(repo.boostSession()).toBeNull();
    repo.close();
  });
  it("GC-4: a v1 state and a Task 1 boost_sessions row both parse", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "frameforge-repo-"));
    const file = path.join(dir, "v2.db");
    const target: ProcessTarget = {
      pid: 7,
      startTime: "2026-10-12T10:00:00.0000000Z",
      executablePath: "C:\\g\\g.exe",
      name: "g",
      priority: "Normal",
    };
    const gameId = crypto.randomUUID();
    const old = new DatabaseSync(file);
    old.exec(migrations[0] as string);
    old.exec(
      "CREATE TABLE boost_sessions (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, message TEXT NOT NULL, payload TEXT NOT NULL);",
    );
    old.exec("PRAGMA user_version=2");
    old.prepare("INSERT INTO configuration(id,payload) VALUES(1,?)").run(
      JSON.stringify({
        version: 1,
        settings: {
          theme: "dark",
          startup: false,
          notifications: true,
          diagnostics: false,
        },
        games: [
          {
            id: gameId,
            name: "X",
            path: "C:\\Games\\X",
            executablePath: null,
            source: "custom",
            profile: "gaming",
            notes: "",
          },
        ],
        presets: [],
        gameMode: { gameId: null, active: false },
      }),
    );
    old
      .prepare(
        "INSERT INTO boost_sessions(id,game_id,status,started_at,message,payload) VALUES(?,?,?,?,?,?)",
      )
      .run(
        crypto.randomUUID(),
        gameId,
        "active",
        "2026-10-12T10:00:01.000Z",
        "Game priority raised to Above normal and verified.",
        JSON.stringify(target),
      );
    old.close();
    const repo = new Repository(file);
    const state = repo.state();
    expect(state.games[0]).toMatchObject({
      profile: "gaming",
      boostMode: "global",
    });
    expect(state.booster).toEqual({
      mode: "off",
      autoBoost: false,
      custom: expect.objectContaining({ priority: "Normal", affinity: null }),
      background: [],
    });
    expect(repo.boostRecord()).toMatchObject({
      session: {
        mode: "custom",
        target,
        endedAt: null,
        mechanisms: [],
        samples: [],
      },
      captured: [
        {
          mechanism: "priority",
          process: target,
          prior: "Normal",
          applied: "AboveNormal",
        },
      ],
    });
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
