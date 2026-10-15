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
    const done = await engine.rollbackBatch([a.id, b.id]);
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
    await expect(engine.rollbackBatch([a.id, b.id])).rejects.toThrow(
      /Rollback not done/,
    );
    expect(repo.activity().filter((x) => x.rollback)).toHaveLength(2);
  });
  it("refuses rows that overlap instead of guessing", async () => {
    const { platform } = fake(["mouse-precision"], {});
    const repo = new Repository(":memory:");
    const engine = new OperationEngine(repo, platform);
    const a = await engine.confirm(
      (await engine.preview(["mouse-precision"])).token,
    );
    await expect(engine.rollbackBatch([a.id, a.id])).rejects.toThrow();
  });
});
