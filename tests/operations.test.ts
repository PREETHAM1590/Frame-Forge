import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { BoostSessionSchema } from "../shared/contracts";
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
  it("previews the power plan by name and refuses it during a boost session", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform();
    platform.capabilities = ["power-plan"];
    platform.capture = async () => ({
      values: [],
      scheme: "381b4222-f694-41f0-9685-ff5bb260df2e",
    });
    const engine = new OperationEngine(repo, platform);
    expect((await engine.preview(["power-plan"])).changes).toEqual([
      {
        id: "power-plan",
        setting: "Active Windows power plan",
        before: "Balanced",
        after: "High performance",
      },
    ]);
    platform.capture = async () => ({
      values: [],
      scheme: "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c",
    });
    const same = await engine.preview(["power-plan"]);
    expect(same.changes[0].after).toMatch(/already active/);
    expect(same.warnings[0]).toMatch(/already the active plan/);
    repo.saveBoostSession(
      BoostSessionSchema.parse({
        id: crypto.randomUUID(),
        gameId: crypto.randomUUID(),
        mode: "performance",
        target: {
          pid: 4242,
          startTime: "2026-10-13T00:00:00.0000000Z",
          executablePath: "C:\\Games\\game.exe",
          name: "game",
          priority: "High",
        },
        startedAt: new Date().toISOString(),
        status: "active",
        message: "Boosted.",
      }),
      [],
    );
    await expect(engine.preview(["power-plan"])).rejects.toThrow(
      /Stop Game Mode/,
    );
    repo.close();
  });
  it("previews the plan the helper chose (Ultimate or the Frameforge copy) by its Windows name", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform();
    platform.capabilities = ["power-plan"];
    platform.capture = async () => ({
      values: [],
      scheme: "11111111-1111-4111-8111-111111111111",
      schemeName: "My tuned plan",
      target: "e9a42b02-d5df-448d-aa00-03f14749eb61",
    });
    const engine = new OperationEngine(repo, platform);
    expect((await engine.preview(["power-plan"])).changes[0]).toMatchObject({
      before: "My tuned plan",
      after: "Ultimate performance",
    });
    platform.capture = async () => ({
      values: [],
      scheme: "381b4222-f694-41f0-9685-ff5bb260df2e",
      target: "22222222-2222-4222-8222-222222222222",
      targetName: "Frameforge High performance",
    });
    expect((await engine.preview(["power-plan"])).changes[0]).toMatchObject({
      before: "Balanced",
      after: "Frameforge High performance",
    });
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
