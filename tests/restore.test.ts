import { describe, it, expect } from "vitest";
import { Repository } from "../electron/repository";
import {
  MockPlatform,
  type PlatformCreateResult,
  type PlatformRestoreStatus,
} from "../electron/platform";
import { AppService } from "../electron/service";
import {
  RestorePointService,
  overrideLabel,
  pendingLabel,
} from "../electron/restore";
import {
  requests,
  type Frequency,
  type RestorePoints,
} from "../shared/contracts";
class RestorePlatform extends MockPlatform {
  frequency: Frequency = { existed: false, minutes: null };
  outcomes: PlatformCreateResult["outcome"][] = [];
  calls: { bypass: boolean; original: Frequency }[] = [];
  leaveBypass = false;
  duringCreate?: () => void;
  async restoreStatus(): Promise<PlatformRestoreStatus> {
    return {
      protection: "enabled",
      policyDisabled: false,
      frequency: this.frequency,
      elevated: false,
      systemDrive: "C:",
      message: "System Protection is on.",
    };
  }
  async restoreCreate(_name: string, bypass: boolean, original: Frequency) {
    this.calls.push({ bypass, original });
    if (bypass) this.frequency = { existed: true, minutes: 0 };
    this.duringCreate?.();
    if (bypass && !this.leaveBypass) this.frequency = original;
    const outcome = this.outcomes.shift() ?? "created";
    const point = {
      sequence: 5,
      description: "Frameforge",
      createdAt: new Date().toISOString(),
    };
    return {
      outcome,
      point: outcome === "created" ? point : null,
      lastPoint: outcome === "throttled" ? point : null,
      message: "Helper message.",
      frequencyRestored: bypass ? !this.leaveBypass : null,
      resultPath: outcome === "pending" ? this.pendingPath : null,
    };
  }
  async restoreFrequencySet(original: Frequency) {
    this.frequency = original;
    return this.restoreStatus();
  }
  pendingPath: string | null = null;
  laterResult: PlatformCreateResult | null = null;
  async restoreResult() {
    return this.laterResult;
  }
  points: RestorePoints["points"] = [];
  async restoreList(): Promise<RestorePoints> {
    return {
      points: this.points,
      available: true,
      message: "",
      createdSequence: null,
    };
  }
  enableFails = false;
  async restoreEnable() {
    if (this.enableFails)
      throw new Error("Windows could not turn on System Protection (error 5).");
    return this.restoreStatus();
  }
}
const setup = () => {
  const repo = new Repository(":memory:");
  const platform = new RestorePlatform();
  return { repo, platform, restore: new RestorePointService(repo, platform) };
};
const labels = (repo: Repository) =>
  repo.activity().map((a) => [a.label, a.status]);
describe("Windows restore points", () => {
  it("rejects a throttle bypass without a prior throttled result", async () => {
    const repo = new Repository(":memory:");
    const platform = new RestorePlatform();
    const service = new AppService(repo, platform, {
      pickGame: async () => null,
      detectGames: async () => ({ games: [], warnings: [], launchers: [] }),
      setStartup: () => {},
      version: "test",
    });
    await expect(
      service.dispatch("createRestorePoint", {
        name: "Frameforge 2026-10-13",
        confirmed: true,
        bypassThrottle: true,
      }),
    ).rejects.toThrow("Retry the normal creation first");
    await expect(
      service.dispatch("createRestorePoint", {
        name: '"; calc',
        confirmed: true,
      }),
    ).rejects.toThrow();
    expect(platform.calls).toEqual([]);
    expect(
      requests.createRestorePoint.safeParse({
        name: "x".repeat(65),
        confirmed: true,
      }).success,
    ).toBe(false);
    repo.close();
  });
  it("journals the bypass with the original value and finishes it after verification", async () => {
    const { repo, platform, restore } = setup();
    platform.frequency = { existed: true, minutes: 1440 };
    platform.outcomes = ["throttled", "created"];
    const first = await restore.create("Frameforge", false);
    expect(first.outcome).toBe("throttled");
    expect(first.message).toContain("every 24 hours by default");
    let duringCreate: unknown;
    platform.duringCreate = () => {
      duringCreate = repo.pendingJournal(overrideLabel);
    };
    const second = await restore.create("Frameforge", true);
    expect(second.outcome).toBe("created");
    expect(duringCreate).toMatchObject({
      snapshot: { frequency: { existed: true, minutes: 1440 } },
    });
    expect(platform.calls[1]).toEqual({
      bypass: true,
      original: { existed: true, minutes: 1440 },
    });
    expect(labels(repo)).toEqual(
      expect.arrayContaining([
        ["Restore point skipped: Windows 24-hour limit", "cancelled"],
        [overrideLabel, "success"],
        ["Windows restore point created", "success"],
      ]),
    );
    expect(second.message).toContain('#5 "Frameforge"');
    const status = await restore.status();
    expect(status.pendingFrequencyRecovery).toBe(false);
    expect(status.lastAppCreatedAt).not.toBeNull();
    // Consent covers one attempt only.
    await expect(restore.create("Frameforge", true)).rejects.toThrow(
      "Retry the normal creation first",
    );
    repo.close();
  });
  it("keeps a creation that outlives the helper and verifies it later", async () => {
    const { repo, platform, restore } = setup();
    platform.outcomes = ["pending"];
    platform.pendingPath = "C:\\Temp\\frameforge-0123.json";
    const result = await restore.create("Frameforge", false);
    expect(result.outcome).toBe("pending");
    expect((await restore.status()).pendingCreation).toBe(true);
    platform.laterResult = {
      outcome: "created",
      point: {
        sequence: 9,
        description: "Frameforge",
        createdAt: "2026-10-13T10:00:00.000Z",
      },
      lastPoint: null,
      message: "Windows restore point created and verified.",
      frequencyRestored: null,
      resultPath: null,
    };
    const status = await restore.status();
    expect(status.pendingCreation).toBe(false);
    expect(status.lastAppCreatedAt).toBe("2026-10-13T10:00:00.000Z");
    expect(labels(repo)).toEqual(
      expect.arrayContaining([
        [pendingLabel, "success"],
        ["Windows restore point created", "success"],
      ]),
    );
    repo.close();
  });
  it("verifies a timed-out creation against the restore point list", async () => {
    const { repo, platform, restore } = setup();
    platform.outcomes = ["pending"];
    await restore.create("Frameforge", false);
    repo.recoverInterrupted();
    expect(
      repo.activity().find((a) => a.label === pendingLabel)?.message,
    ).toContain("Restore & backups");
    platform.points = [
      {
        sequence: 3,
        description: "Frameforge",
        createdAt: new Date().toISOString(),
      },
    ];
    await restore.list();
    expect(labels(repo)).toContainEqual([pendingLabel, "success"]);
    expect((await restore.status()).pendingCreation).toBe(false);
    repo.close();
  });
  it("logs a failed System Protection change", async () => {
    const { repo, platform, restore } = setup();
    platform.enableFails = true;
    await expect(restore.enable()).rejects.toThrow("error 5");
    expect(labels(repo)).toContainEqual([
      "System Protection not turned on",
      "failed",
    ]);
    repo.close();
  });
  it("surfaces and recovers a frequency that was not restored", async () => {
    const { repo, platform, restore } = setup();
    platform.outcomes = ["throttled", "failed"];
    platform.leaveBypass = true;
    await restore.create("Frameforge", false);
    const result = await restore.create("Frameforge", true);
    expect(result.outcome).toBe("failed");
    expect(result.message).toContain("use the recovery action");
    expect(labels(repo)).toContainEqual([overrideLabel, "recovery-needed"]);
    expect((await restore.status()).pendingFrequencyRecovery).toBe(true);
    const recovered = await restore.recoverFrequency();
    expect(platform.frequency).toEqual({ existed: false, minutes: null });
    expect(recovered.pendingFrequencyRecovery).toBe(false);
    expect(labels(repo)).toContainEqual([overrideLabel, "success"]);
    repo.close();
  });
  it("keeps an interrupted bypass visible after restart and preserves external changes", async () => {
    const { repo, platform, restore } = setup();
    repo.journal(
      overrideLabel,
      { frequency: { existed: false, minutes: null } },
      "Restore point limit lifted temporarily.",
    );
    repo.recoverInterrupted();
    expect(repo.activity()[0]?.message).toContain("Restore the original limit");
    expect((await restore.status()).pendingFrequencyRecovery).toBe(true);
    platform.frequency = { existed: true, minutes: 30 };
    const status = await restore.recoverFrequency();
    expect(platform.frequency).toEqual({ existed: true, minutes: 30 });
    expect(status.pendingFrequencyRecovery).toBe(false);
    expect(labels(repo)).toContainEqual([overrideLabel, "failed"]);
    repo.close();
  });
  it("records a declined administrator prompt as a normal outcome", async () => {
    const { repo, platform, restore } = setup();
    platform.outcomes = ["elevation-cancelled"];
    const result = await restore.create("Frameforge", false);
    expect(result.outcome).toBe("elevation-cancelled");
    expect(labels(repo)).toContainEqual([
      "Restore point cancelled",
      "cancelled",
    ]);
    repo.close();
  });
  it("reports the mock platform honestly", async () => {
    const repo = new Repository(":memory:");
    const restore = new RestorePointService(repo, new MockPlatform());
    expect((await restore.status()).protection).toBe("unknown");
    expect((await restore.list()).available).toBe(false);
    await expect(restore.create("Frameforge", false)).rejects.toThrow(
      "Windows helper",
    );
    repo.close();
  });
});
