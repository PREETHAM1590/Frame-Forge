import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { OperationEngine } from "../electron/operations";
import { Repository } from "../electron/repository";
import {
  MockPlatform,
  NotApplied,
  WindowsPlatform,
} from "../electron/platform";
import { RestorePointService } from "../electron/restore";
import { adminIds } from "../shared/catalogue";
import type { Snapshot } from "../shared/contracts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const declined = new NotApplied("declined", "administrator approval declined");
const reg = (value: string | null, target: string | null, existed = true) =>
  ({
    operation: "capture-off",
    path: "test",
    name: "test",
    kind: "String",
    existed,
    value,
    target,
  }) as Snapshot["values"][number];

describe("I-1: a declined machine apply restores nothing", () => {
  it("ends as Not applied without a restore, a recovery row or a second prompt", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform(true);
    platform.apply = async () => {
      throw declined;
    };
    const restore = vi.spyOn(platform, "restore");
    const engine = new OperationEngine(repo, platform);
    const result = await engine.confirm(
      (await engine.preview(["capture-off"])).token,
    );
    expect(result.status).toBe("cancelled");
    expect(result.message).toBe(
      "Not applied — administrator approval declined. Nothing was changed.",
    );
    expect(result.rollback).toBe(false);
    expect(restore).not.toHaveBeenCalled();
    expect(repo.activity().some((a) => a.status === "recovery-needed")).toBe(
      false,
    );
    expect(engine.isBusy).toBe(false);
    repo.close();
  });
  it("still restores when the apply may have written something", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform(true);
    platform.apply = async () => {
      throw new Error("Windows helper timed out.");
    };
    const restore = vi.spyOn(platform, "restore");
    const engine = new OperationEngine(repo, platform);
    const result = await engine.confirm(
      (await engine.preview(["capture-off"])).token,
    );
    expect(result.status).toBe("failed");
    expect(restore).toHaveBeenCalledOnce();
    repo.close();
  });
});

describe("the Windows platform tells never-ran from may-have-run", () => {
  function helper(message: string) {
    const child = Object.assign(new EventEmitter(), {
      pid: 7,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(() => true),
    });
    vi.mocked(spawn).mockReturnValue(
      child as unknown as ReturnType<typeof spawn>,
    );
    queueMicrotask(() => {
      child.stdout.end(
        JSON.stringify({ ok: false, code: "invalid-request", message }),
      );
      child.emit("close", 0);
    });
  }
  const machine = adminIds[0]!;
  const snapshot = { values: [] } as Snapshot;
  it("maps a declined or expired administrator step to NotApplied", async () => {
    helper(
      "The machine-level step did not complete: Administrator approval was declined. Nothing was changed. The current-user changes made before it were undone.",
    );
    const error = await new WindowsPlatform("h")
      .apply([machine], new AbortController().signal, snapshot)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotApplied);
    expect((error as NotApplied).reason).toBe(
      "administrator approval declined",
    );
  });
  it("does not when the current-user part could not be undone", async () => {
    helper(
      "The machine-level step did not complete: Administrator approval was declined. Nothing was changed. The current-user changes made before it could not be undone (x); use Rollback.",
    );
    const error = await new WindowsPlatform("h")
      .apply([machine], new AbortController().signal, snapshot)
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(NotApplied);
  });
  it("treats a held gate (a Game Mode prompt) as NotApplied for apply and restore", async () => {
    const platform = new WindowsPlatform("h");
    platform.elevation.hold("boost");
    const apply = await platform
      .apply([machine], new AbortController().signal, snapshot)
      .catch((e: unknown) => e);
    expect(apply).toBeInstanceOf(NotApplied);
    const restore = await platform
      .restore(
        {
          values: [
            {
              operation: machine,
              path: "p",
              name: "n",
              kind: "DWord",
              existed: true,
              value: 1,
            },
          ],
        },
        false,
      )
      .catch((e: unknown) => e);
    expect(restore).toBeInstanceOf(NotApplied);
  });
});

describe("I-2: a declined rollback is not a recovery-needed row", () => {
  it("keeps the item restorable, logs it and throws a clear message", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform(true);
    const engine = new OperationEngine(repo, platform);
    const applied = await engine.confirm(
      (await engine.preview(["capture-off"])).token,
    );
    platform.restore = async () => {
      throw declined;
    };
    await expect(engine.rollback(applied.id)).rejects.toThrow(
      /Rollback not done .* administrator approval declined/,
    );
    const row = repo.operation(applied.id)!.activity;
    expect(row.status).toBe("success");
    expect(row.rollback).toBe(true);
    expect(repo.activity().some((a) => a.status === "recovery-needed")).toBe(
      false,
    );
    expect(repo.activity()[0]!.label).toBe("Rollback not done");
    expect(engine.isBusy).toBe(false);
    // A real verification failure is still recovery-needed.
    platform.restore = async () => {
      throw new Error("Rollback verification failed.");
    };
    expect((await engine.rollback(applied.id)).status).toBe("recovery-needed");
    repo.close();
  });
});

describe("QA3: values that already match", () => {
  it("reports Already set, writes nothing and leaves no rollback entry", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform(true);
    platform.capture = async () => ({ values: [reg("1", "1")] });
    const apply = vi.spyOn(platform, "apply");
    const engine = new OperationEngine(repo, platform);
    const result = await engine.confirm(
      (await engine.preview(["capture-off"])).token,
    );
    expect(result.status).toBe("success");
    expect(result.message).toMatch(/^Already set — no change/);
    expect(result.rollback).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(repo.backups()).toHaveLength(0);
    repo.close();
  });
  it("treats a removed target on an absent value as already set, and a different value as a change", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform(true);
    platform.capture = async () => ({ values: [reg(null, null, false)] });
    const engine = new OperationEngine(repo, platform);
    expect(
      (await engine.confirm((await engine.preview(["capture-off"])).token))
        .message,
    ).toMatch(/^Already set/);
    platform.capture = async () => ({ values: [reg("0", "1")] });
    const changed = await engine.confirm(
      (await engine.preview(["capture-off"])).token,
    );
    expect(changed.message).toMatch(/^Windows settings re-read/);
    expect(changed.rollback).toBe(true);
    repo.close();
  });
});

describe("QA3: a restore point prompt nobody answered", () => {
  it("Cancel sends the cancel line to the helper that is still waiting for its prompt", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 9,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(() => true),
    });
    vi.mocked(spawn).mockReturnValue(
      child as unknown as ReturnType<typeof spawn>,
    );
    const written: string[] = [];
    child.stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    const platform = new WindowsPlatform("h");
    expect(platform.cancelElevated()).toBe(false);
    const pending = platform.restoreList();
    await Promise.resolve();
    expect(platform.cancelElevated()).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(written.join("")).toMatch(/"command":"elevated".*\ncancel\n/s);
    // The helper answers "Not approved - cancelled": a cancellation, nothing pending.
    child.stdout.end(
      JSON.stringify({
        ok: true,
        code: "elevation-cancelled",
        message: "Not approved — cancelled.",
      }),
    );
    child.emit("close", 0);
    const list = await pending;
    expect(list.cancelled).toBe(true);
    expect(platform.cancelElevated()).toBe(false);
  });
  it("only a busy restore service can be cancelled", () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform();
    platform.cancelElevated = () => true;
    const service = new RestorePointService(repo, platform);
    expect(service.cancel()).toBe(false);
    repo.close();
  });
});
