import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { OperationEngine } from "../electron/operations";
import { Repository } from "../electron/repository";
import { MockPlatform, WindowsPlatform } from "../electron/platform";
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
describe("confirmed reversible operations", () => {
  it("refuses unsupported operations before backup or writes", async () => {
    const repo = new Repository(":memory:");
    const engine = new OperationEngine(repo, new MockPlatform());
    await expect(engine.preview(["mouse-precision"])).rejects.toThrow(
      /unavailable/i,
    );
    expect(repo.backups()).toHaveLength(0);
    repo.close();
  });
  it("enforces single-use preview tokens and rollback", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform(true);
    const engine = new OperationEngine(repo, platform);
    const preview = await engine.preview(["mouse-precision"]);
    const result = await engine.confirm(preview.token);
    expect(result.status).toBe("success");
    expect(repo.backups()).toHaveLength(1);
    await expect(engine.confirm(preview.token)).rejects.toThrow(/preview/i);
    await engine.rollback(result.id);
    expect(repo.activity()[0].status).toBe("rolled-back");
    repo.close();
  });
  it("rejects stale previews before mutation", async () => {
    const repo = new Repository(":memory:");
    let time = 100;
    const engine = new OperationEngine(
      repo,
      new MockPlatform(true),
      () => time,
    );
    const preview = await engine.preview(["mouse-precision"]);
    time += 301000;
    await expect(engine.confirm(preview.token)).rejects.toThrow(/expired/i);
    expect(repo.activity()).toHaveLength(0);
    repo.close();
  });
  it("automatically restores a captured snapshot after failed verification", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform(true);
    platform.failVerification = true;
    const engine = new OperationEngine(repo, platform);
    const preview = await engine.preview(["capture-off"]);
    const result = await engine.confirm(preview.token);
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/restored/i);
    expect(platform.applied).toEqual([]);
    repo.close();
  });
  it("rejects external changes since preview before saving a journal or applying", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform(true);
    const engine = new OperationEngine(repo, platform);
    const preview = await engine.preview(["capture-off"]);
    vi.spyOn(platform, "capture").mockResolvedValue({ values: [] });
    await expect(engine.confirm(preview.token)).rejects.toThrow(
      /changed after preview/i,
    );
    expect(repo.activity()).toHaveLength(0);
    expect(repo.backups()).toHaveLength(0);
    expect(platform.applied).toEqual([]);
    repo.close();
  });
  it("restores when cancellation arrives during verification", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform(true);
    const engine = new OperationEngine(repo, platform);
    vi.spyOn(platform, "verify").mockImplementation(async () => {
      expect(engine.cancel()).toBe(true);
      return true;
    });
    const preview = await engine.preview(["capture-off"]);
    const result = await engine.confirm(preview.token);
    expect(result.status).toBe("cancelled");
    expect(result.rollback).toBe(false);
    expect(platform.applied).toEqual([]);
    expect(engine.isBusy).toBe(false);
    repo.close();
  });
  it("retains the journal and rollback when automatic recovery fails", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform(true);
    platform.failVerification = true;
    vi.spyOn(platform, "restore").mockRejectedValue(
      new Error("External change"),
    );
    const engine = new OperationEngine(repo, platform);
    const preview = await engine.preview(["capture-off"]);
    const result = await engine.confirm(preview.token);
    expect(result.status).toBe("recovery-needed");
    expect(result.rollback).toBe(true);
    expect(repo.operation(result.id)?.snapshot).toEqual(
      await platform.capture(["capture-off"]),
    );
    repo.clearActivity();
    expect(repo.operation(result.id)).not.toBeNull();
    expect(engine.isBusy).toBe(false);
    repo.close();
  });
});

describe("Windows helper lifecycle", () => {
  function helper() {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(() => true),
    });
    vi.mocked(spawn).mockReturnValue(
      child as unknown as ReturnType<typeof spawn>,
    );
    return child;
  }
  it("waits for helper close before rejecting cancellation", async () => {
    const child = helper();
    const platform = new WindowsPlatform("test-helper");
    const controller = new AbortController();
    let settled = false;
    const result = platform.apply(["capture-off"], controller.signal, {
      values: [],
    });
    const rejection = expect(result).rejects.toThrow(/cancelled/i);
    void result.catch(() => {
      settled = true;
    });
    controller.abort();
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    child.emit("close", null);
    await rejection;
    expect(settled).toBe(true);
  });
  it("waits for close even when the signal was already aborted", async () => {
    const child = helper();
    const controller = new AbortController();
    controller.abort();
    const result = new WindowsPlatform("test-helper").apply(
      ["capture-off"],
      controller.signal,
      { values: [] },
    );
    const rejection = expect(result).rejects.toThrow(/cancelled/i);
    child.emit("close", null);
    await rejection;
  });
  it("waits for close before rejecting helper timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = helper();
      let settled = false;
      const result = new WindowsPlatform("test-helper").capture([
        "capture-off",
      ]);
      const rejection = expect(result).rejects.toThrow(/timed out/i);
      void result.catch(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(20000);
      expect(child.kill).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      child.emit("close", null);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
