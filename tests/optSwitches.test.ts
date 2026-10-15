import { describe, expect, it } from "vitest";
import { OperationEngine } from "../electron/operations";
import { Repository } from "../electron/repository";
import { MockPlatform } from "../electron/platform";
import type { OperationId, Snapshot } from "../shared/contracts";

const value = (operation: OperationId, now: string, target: string) => ({
  operation,
  path: "p",
  name: operation,
  kind: "String" as const,
  existed: true,
  value: now,
  target,
});
// A fake Windows: each item is "on" when its stored value equals "0".
function fake(ids: OperationId[], held: Record<string, string>) {
  const platform = new MockPlatform();
  platform.capabilities = ids;
  const restores: Snapshot[] = [];
  platform.capture = async (list: OperationId[]) => ({
    values: list.map((id) => value(id, held[id] ?? "1", "0")),
  });
  platform.restore = (async (snapshot: Snapshot) => {
    restores.push(snapshot);
  }) as unknown as MockPlatform["restore"];
  return { platform, restores };
}
describe("optimization status (read-only)", () => {
  it("maps on, off and unknown without ever capturing boot-store items", async () => {
    const { platform } = fake(
      ["mouse-precision", "capture-off", "boot-timeout-short"],
      { "mouse-precision": "0" },
    );
    const asked: OperationId[][] = [];
    const capture = platform.capture;
    platform.capture = async (ids) => (asked.push(ids), capture(ids));
    const engine = new OperationEngine(new Repository(":memory:"), platform);
    const state = Object.fromEntries(
      (await engine.status()).map((s) => [s.id, s.state]),
    );
    expect(state).toEqual({
      "mouse-precision": "on",
      "capture-off": "off",
      "boot-timeout-short": "unknown",
    });
    expect(asked.flat()).not.toContain("boot-timeout-short");
  });
  it("one unreadable item does not blank the others", async () => {
    const { platform } = fake(["mouse-precision", "capture-off"], {});
    const capture = platform.capture;
    platform.capture = async (ids) => {
      if (ids.length > 1 || ids[0] === "capture-off") throw new Error("x");
      return capture(ids);
    };
    const engine = new OperationEngine(new Repository(":memory:"), platform);
    const state = Object.fromEntries(
      (await engine.status()).map((s) => [s.id, s.state]),
    );
    expect(state).toEqual({
      "mouse-precision": "off",
      "capture-off": "unknown",
    });
  });
});
describe("batched turn-offs", () => {
  async function two() {
    const { platform, restores } = fake(["mouse-precision", "capture-off"], {});
    const repo = new Repository(":memory:");
    const engine = new OperationEngine(repo, platform);
    const a = await engine.confirm(
      (await engine.preview(["mouse-precision"])).token,
    );
    const b = await engine.confirm(
      (await engine.preview(["capture-off"])).token,
    );
    return { engine, repo, restores, a, b };
  }
  it("restores several journal rows through ONE platform restore, one row each", async () => {
    const { engine, repo, restores, a, b } = await two();
    const done = await engine.rollbackBatch([
      { id: a.id, ids: a.ids },
      { id: b.id, ids: b.ids },
    ]);
    expect(restores).toHaveLength(1);
    expect(restores[0]!.values.map((v) => v.operation).sort()).toEqual([
      "capture-off",
      "mouse-precision",
    ]);
    expect(done.map((d) => d.status)).toEqual(["rolled-back", "rolled-back"]);
    expect(repo.activity().filter((x) => x.rollback)).toHaveLength(0);
  });
  it("a declined step leaves every row restorable", async () => {
    const { engine, repo, a, b } = await two();
    const { NotApplied } = await import("../electron/platform");
    (engine as unknown as { platform: MockPlatform }).platform.restore =
      async () => {
        throw new NotApplied("administrator approval was declined");
      };
    await expect(
      engine.rollbackBatch([
        { id: a.id, ids: a.ids },
        { id: b.id, ids: b.ids },
      ]),
    ).rejects.toThrow(/Rollback not done/);
    expect(repo.activity().filter((x) => x.rollback)).toHaveLength(2);
  });
  it("refuses rows that overlap instead of guessing", async () => {
    const { platform } = fake(["mouse-precision"], {});
    const repo = new Repository(":memory:");
    const engine = new OperationEngine(repo, platform);
    const a = await engine.confirm(
      (await engine.preview(["mouse-precision"])).token,
    );
    await expect(
      engine.rollbackBatch([
        { id: a.id, ids: a.ids },
        { id: a.id, ids: a.ids },
      ]),
    ).rejects.toThrow();
  });
});

// A preset: three items applied together, one journal row.
async function preset() {
  const ids: OperationId[] = [
    "mouse-precision",
    "capture-off",
    "transparency-off",
  ];
  const { platform, restores } = fake(ids, {});
  const repo = new Repository(":memory:");
  const engine = new OperationEngine(repo, platform);
  const row = await engine.confirm((await engine.preview(ids)).token);
  return { engine, repo, platform, restores, row };
}
describe("per-item undo", () => {
  it("turning one item off restores only that item and leaves the others on", async () => {
    const { engine, repo, restores, row } = await preset();
    const [done] = await engine.rollbackBatch([
      { id: row.id, ids: ["capture-off"] },
    ]);
    expect(restores).toHaveLength(1);
    expect(restores[0]!.values.map((v) => v.operation)).toEqual([
      "capture-off",
    ]);
    // The row stays restorable for the other two, and only for them.
    expect(done!.status).toBe("success");
    expect(done!.rollback).toBe(true);
    expect(done!.ids).toEqual(["mouse-precision", "transparency-off"]);
    const saved = repo.operation(row.id)!;
    expect(
      (saved.snapshot as Snapshot).values.map((v) => v.operation).sort(),
    ).toEqual(["mouse-precision", "transparency-off"]);
    // Undoing the rest closes the row.
    const [last] = await engine.rollbackBatch([
      { id: row.id, ids: ["mouse-precision", "transparency-off"] },
    ]);
    expect(last!.status).toBe("rolled-back");
    expect(last!.rollback).toBe(false);
  });
  it("whole-row rollback still restores the whole snapshot", async () => {
    const { engine, restores, row } = await preset();
    await engine.rollback(row.id);
    expect(restores[0]!.values).toHaveLength(3);
  });
  it("refuses items that are not part of the row", async () => {
    const { engine, row } = await preset();
    await expect(
      engine.rollbackBatch([{ id: row.id, ids: ["hibernate-off"] }]),
    ).rejects.toThrow(/not part/);
  });
});
describe("one save: turn-ons with turn-offs", () => {
  it("hands the platform one apply carrying the turn-offs' values only", async () => {
    const { engine, repo, platform, restores, row } = await preset();
    platform.capabilities = [...platform.capabilities, "hibernate-off"];
    let calls = 0;
    const apply = platform.apply.bind(platform);
    platform.apply = async (...a: Parameters<typeof apply>) => (
      calls++,
      apply(...a)
    );
    const preview = await engine.preview(["hibernate-off"]);
    const done = await engine.confirm(
      preview.token,
      [],
      [{ id: row.id, ids: ["capture-off"] }],
    );
    expect(done.status).toBe("success");
    expect(calls).toBe(1);
    expect(platform.undone!.values.map((v) => v.operation)).toEqual([
      "capture-off",
    ]);
    expect(restores).toHaveLength(0); // no second restore step
    expect(repo.operation(row.id)!.activity.ids).toEqual([
      "mouse-precision",
      "transparency-off",
    ]);
    expect(done.message).toMatch(/Turned off:/);
  });
  it("a declined step leaves every row exactly as it was", async () => {
    const { engine, repo, platform, row } = await preset();
    platform.capabilities = [...platform.capabilities, "hibernate-off"];
    const { NotApplied } = await import("../electron/platform");
    platform.apply = async () => {
      throw new NotApplied("administrator approval was declined");
    };
    const preview = await engine.preview(["hibernate-off"]);
    const done = await engine.confirm(
      preview.token,
      [],
      [{ id: row.id, ids: ["capture-off"] }],
    );
    expect(done.status).toBe("cancelled");
    expect(repo.operation(row.id)!.activity.ids).toHaveLength(3);
    expect(repo.operation(row.id)!.activity.status).toBe("success");
  });
  it("turn-offs stand when the turn-ons did not stick (the helper did both in one step)", async () => {
    const { engine, repo, platform, row } = await preset();
    platform.capabilities = [...platform.capabilities, "hibernate-off"];
    platform.failVerification = true;
    const preview = await engine.preview(["hibernate-off"]);
    const done = await engine.confirm(
      preview.token,
      [],
      [{ id: row.id, ids: ["capture-off"] }],
    );
    expect(done.status).toBe("failed");
    expect(repo.operation(row.id)!.activity.ids).not.toContain("capture-off");
  });
  it("an unclear failure marks the turn-off rows for recovery, never silently on", async () => {
    const { engine, repo, platform, row } = await preset();
    platform.capabilities = [...platform.capabilities, "hibernate-off"];
    platform.apply = async () => {
      throw new Error("helper died");
    };
    const preview = await engine.preview(["hibernate-off"]);
    await engine.confirm(
      preview.token,
      [],
      [{ id: row.id, ids: ["capture-off"] }],
    );
    expect(repo.operation(row.id)!.activity.status).toBe("recovery-needed");
  });
  it("refuses an item that is turned on and off in the same save", async () => {
    const { engine, row } = await preset();
    const preview = await engine.preview(["capture-off"]);
    await expect(
      engine.confirm(preview.token, [], [{ id: row.id, ids: ["capture-off"] }]),
    ).rejects.toThrow(/same save/);
  });
});
