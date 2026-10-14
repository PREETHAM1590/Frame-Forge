import { describe, expect, it } from "vitest";
import {
  StartupItemSchema,
  requests,
  type StartupHelperList,
  type StartupItem,
  type StartupWriteResult,
} from "../shared/contracts";
import { Repository } from "../electron/repository";
import { MockPlatform, type StartupSetCall } from "../electron/platform";
import { StartupService } from "../electron/startup";

const item = (over: Partial<StartupItem> = {}): StartupItem => ({
  id: "hkcu-run|Discord",
  name: "Discord",
  command: "C:\\d.exe",
  path: "C:\\d.exe",
  publisher: "Discord Inc.",
  source: "hkcu-run",
  scope: "user",
  enabled: true,
  canToggle: true,
  sizeBytes: 1000,
  impact: "low",
  critical: false,
  criticalReason: null,
  approved: null,
  note: null,
  ...over,
});
const disabledHex = "030000000000000000000000";
class Fake extends MockPlatform {
  items: StartupItem[] = [item()];
  calls: StartupSetCall[] = [];
  next: StartupWriteResult | null = null;
  gateSeen: string | null = null;
  override async startupList(): Promise<StartupHelperList> {
    return { items: this.items, warnings: [] };
  }
  override async startupSet(call: StartupSetCall) {
    this.calls.push(call);
    this.gateSeen = this.elevation.current;
    if (this.next) return this.next;
    const i = this.items.find((x) => x.id === call.id)!;
    const after =
      call.op === "restore"
        ? (call.next ?? null)
        : call.enable
          ? "020000000000000000000000"
          : disabledHex;
    i.approved = after;
    i.enabled =
      call.op === "restore"
        ? !after || parseInt(after.slice(0, 2), 16) % 2 === 0
        : !!call.enable;
    return {
      state: "applied" as const,
      detail: "ok",
      before: call.expect,
      after,
    };
  }
}
const setup = () => {
  const repo = new Repository(":memory:");
  const platform = new Fake();
  const logs: Array<[string, string, string | undefined]> = [];
  const svc = new StartupService(repo, platform, (l, m, s) =>
    logs.push([l, m, s]),
  );
  return { repo, platform, logs, svc };
};

describe("startup IPC validation", () => {
  it("accepts only the documented request shapes", () => {
    expect(requests.startupList.safeParse({}).success).toBe(true);
    expect(requests.startupList.safeParse({ path: "x" }).success).toBe(false);
    expect(
      requests.startupSet.safeParse({ id: "hkcu-run|A", enabled: false })
        .success,
    ).toBe(true);
    // The renderer can never send a registry path, a hex value or a delete flag.
    expect(
      requests.startupSet.safeParse({
        id: "hkcu-run|A",
        enabled: false,
        value: "00",
      }).success,
    ).toBe(false);
    expect(
      requests.startupSet.safeParse({ id: "hkcu-run|A", enabled: "no" })
        .success,
    ).toBe(false);
    expect(
      requests.startupSet.safeParse({ id: "x".repeat(301), enabled: true })
        .success,
    ).toBe(false);
    expect(
      requests.startupSet.safeParse({
        id: "hkcu-run|A",
        enabled: false,
        acknowledged: false,
      }).success,
    ).toBe(false);
    expect(requests.startupUndo.safeParse({ id: "ab" }).success).toBe(false);
  });
  it("rejects malformed helper items", () => {
    expect(StartupItemSchema.safeParse(item()).success).toBe(true);
    expect(
      StartupItemSchema.safeParse(item({ source: "evil" as never })).success,
    ).toBe(false);
    expect(StartupItemSchema.safeParse(item({ approved: "ZZ" })).success).toBe(
      false,
    );
  });
});

describe("StartupService", () => {
  it("disables, records the prior value (absent) and undoes it exactly", async () => {
    const { svc, platform, logs, repo } = setup();
    const status = await svc.set("hkcu-run|Discord", false, false);
    expect(platform.calls[0]).toMatchObject({
      op: "set",
      enable: false,
      expect: null,
      machine: false,
    });
    expect(status.items[0]!.enabled).toBe(false);
    expect(status.changes.map((c) => c.id)).toEqual(["hkcu-run|Discord"]);
    expect(logs[0]![0]).toBe("Startup program disabled");
    // No administrator gate for a current-user item.
    expect(platform.gateSeen).toBeNull();
    const back = await svc.undo("hkcu-run|Discord");
    expect(platform.calls[1]).toMatchObject({
      op: "restore",
      expect: disabledHex,
      next: null,
    });
    expect(back.items[0]!.approved).toBeNull();
    expect(back.changes).toEqual([]);
    expect(repo.meta("startup.changes")).toBeNull();
    expect(logs.at(-1)![0]).toBe("Startup change undone");
  });
  it("keeps the true original when changed twice", async () => {
    const { svc, platform } = setup();
    platform.items = [item({ approved: "060000000000000000000000" })];
    await svc.set("hkcu-run|Discord", false, false);
    await svc.set("hkcu-run|Discord", true, false);
    await svc.undo("hkcu-run|Discord");
    expect(platform.calls.at(-1)).toMatchObject({
      op: "restore",
      next: "060000000000000000000000",
    });
  });
  it("warns, not blocks: a protected item needs acknowledgement only to turn off", async () => {
    const { svc, platform } = setup();
    platform.items = [
      item({
        id: "hklm-run|SecurityHealth",
        name: "SecurityHealth",
        source: "hklm-run",
        scope: "machine",
        critical: true,
        criticalReason: "Security software.",
      }),
    ];
    await expect(
      svc.set("hklm-run|SecurityHealth", false, false),
    ).rejects.toThrow(/protected/);
    expect(platform.calls).toHaveLength(0);
    await svc.set("hklm-run|SecurityHealth", false, true);
    // Machine-wide: the shared administrator gate was held for the write and released after.
    expect(platform.gateSeen).toBe("startup");
    expect(platform.elevation.current).toBeNull();
    expect(platform.calls[0]!.machine).toBe(true);
  });
  it("refuses listed-only and unknown items", async () => {
    const { svc, platform } = setup();
    platform.items = [
      item({ id: "task|\\X", source: "task", canToggle: false }),
    ];
    await expect(svc.set("task|\\X", false, true)).rejects.toThrow(
      /only lists/,
    );
    await expect(svc.set("hkcu-run|Gone", false, true)).rejects.toThrow(
      /no longer listed/,
    );
  });
  it("records nothing and logs honestly when the write did not happen", async () => {
    for (const state of [
      "declined",
      "conflict",
      "timeout",
      "expired",
    ] as const) {
      const { svc, platform, logs, repo } = setup();
      platform.next = {
        state,
        detail: `Nothing was changed (${state}).`,
        before: null,
        after: null,
      };
      await expect(svc.set("hkcu-run|Discord", false, false)).rejects.toThrow(
        /Nothing was changed/,
      );
      expect(repo.meta("startup.changes")).toBeNull();
      expect(logs.at(-1)![2]).toBe("cancelled");
    }
    const { svc, platform, logs } = setup();
    platform.next = {
      state: "failed",
      detail: "Windows did not keep it.",
      before: null,
      after: null,
    };
    await expect(svc.set("hkcu-run|Discord", false, false)).rejects.toThrow();
    expect(logs.at(-1)![2]).toBe("failed");
  });
  it("drops the saved change when undo finds the value changed elsewhere", async () => {
    const { svc, platform, repo } = setup();
    await svc.set("hkcu-run|Discord", false, false);
    platform.next = {
      state: "conflict",
      detail: "Changed elsewhere.",
      before: null,
      after: null,
    };
    await expect(svc.undo("hkcu-run|Discord")).rejects.toThrow(
      /Changed elsewhere/,
    );
    expect(repo.meta("startup.changes")).toBeNull();
    await expect(svc.undo("hkcu-run|Discord")).rejects.toThrow(
      /no saved change/,
    );
  });
  it("does not run two changes at once", async () => {
    const { svc } = setup();
    const first = svc.set("hkcu-run|Discord", false, false);
    await expect(svc.set("hkcu-run|Discord", false, false)).rejects.toThrow(
      /Wait/,
    );
    await first;
  });
});
