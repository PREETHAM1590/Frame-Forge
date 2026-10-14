// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { OperationEngine } from "../electron/operations";
import { Repository } from "../electron/repository";
import { MockPlatform } from "../electron/platform";
import { ApplyFlowDialog } from "../src/views/optimizations/ApplyFlowDialog";
import type { ApplyFlow } from "../src/views/optimizations/useApplyFlow";
import type { Preview, Snapshot } from "../shared/contracts";

const reg = (
  value: string | null,
  target: string | null,
  name: string,
): Snapshot["values"][number] => ({
  operation: "capture-off",
  path: "test",
  name,
  kind: "String",
  existed: value !== null,
  value,
  target,
});

describe("preview marks rows that already match the target", () => {
  it("flags only the matching rows", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform(true);
    platform.capture = async () => ({
      values: [reg("1", "1", "a"), reg("0", "1", "b")],
    });
    const preview = await new OperationEngine(repo, platform).preview([
      "capture-off",
    ]);
    expect(preview.changes.map((c) => c.alreadySet)).toEqual([true, false]);
    repo.close();
  });
});

const flowWith = (alreadySet: boolean[]) => {
  const preview = {
    token: "t",
    expiresAt: "2026-10-14T00:00:00.000Z",
    ids: ["capture-off"],
    changes: alreadySet.map((a, i) => ({
      id: "capture-off",
      setting: `s${i}`,
      before: "1",
      after: "1",
      alreadySet: a,
    })),
    warnings: [],
    restart: "none",
    admin: false,
    security: [],
  } as unknown as Preview;
  return {
    selection: ["capture-off"],
    preview,
    result: null,
    applying: false,
    previewLoading: false,
    skipped: [],
    confirmed: true,
    understood: false,
    typedName: "",
    restoreOffer: false,
    createPoint: false,
    noPoint: null,
    stale: false,
    planDialog: false,
    close: vi.fn(),
    apply: vi.fn(),
    setConfirmed: vi.fn(),
  } as unknown as ApplyFlow;
};
const dialog = (alreadySet: boolean[]) =>
  render(
    <ApplyFlowDialog
      flow={flowWith(alreadySet)}
      run={vi.fn() as never}
      pending={false}
      restoreRequests={0}
      navigate={vi.fn()}
    />,
  );

describe("apply dialog", () => {
  afterEach(cleanup);
  it("excludes already-set rows from the count and keeps apply enabled", () => {
    dialog([true, false]);
    expect(screen.getByText("1 change")).toBeInTheDocument();
    expect(screen.getAllByText("Already set")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Confirm & apply" }),
    ).toBeEnabled();
  });
  it("reads Nothing to change and disables apply when every row is set", () => {
    dialog([true, true]);
    expect(screen.getByText("0 changes")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Nothing to change" }),
    ).toBeDisabled();
  });
});
