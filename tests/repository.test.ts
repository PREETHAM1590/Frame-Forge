import { describe, expect, it } from "vitest";
import { Repository } from "../electron/repository";
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
});
