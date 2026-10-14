import { describe, expect, it } from "vitest";
import { outcomeOf } from "../src/views/optimizations/ResultStep";
import type { Activity } from "../shared/contracts";

const row = (status: Activity["status"], message = "m"): Activity => ({
  id: "1",
  label: "x",
  at: "2026-01-01T00:00:00.000Z",
  status,
  message,
  ids: [],
  rollback: false,
});
describe("apply flow result states", () => {
  it("tells applied, partial, reverted, failed, cancelled and recovery apart", () => {
    expect(outcomeOf(row("success"), 0).key).toBe("applied");
    expect(outcomeOf(row("success"), 2).key).toBe("partial");
    expect(
      outcomeOf(row("failed", "Windows reverted or did not keep the change"), 0)
        .key,
    ).toBe("reverted");
    expect(
      outcomeOf(row("failed", "The operation did not complete"), 0).key,
    ).toBe("failed");
    expect(outcomeOf(row("cancelled"), 0).key).toBe("cancelled");
    expect(outcomeOf(row("recovery-needed"), 0).key).toBe("recovery");
  });
});
