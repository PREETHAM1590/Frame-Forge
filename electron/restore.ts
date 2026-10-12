import {
  FrequencySchema,
  type Activity,
  type CreateRestorePointResult,
  type Frequency,
  type RestorePoints,
  type RestoreStatus,
} from "../shared/contracts.js";
import type { Repository } from "./repository.js";
import type {
  Platform,
  PlatformCreateResult,
  PlatformRestoreStatus,
} from "./platform.js";
export const overrideLabel = "Restore point throttle override";
const metaKey = "restore_meta";
const bypassValue: Frequency = { existed: true, minutes: 0 };
const same = (a: Frequency, b: Frequency) =>
  a.existed === b.existed && (a.minutes ?? null) === (b.minutes ?? null);
const outcomeLog: Record<
  CreateRestorePointResult["outcome"],
  [string, Activity["status"]]
> = {
  created: ["Windows restore point created", "success"],
  throttled: ["Restore point skipped: Windows 24-hour limit", "cancelled"],
  "protection-disabled": ["System Protection is off", "failed"],
  "policy-disabled": ["System Restore is disabled by policy", "failed"],
  "elevation-cancelled": ["Restore point cancelled", "cancelled"],
  failed: ["Restore point not created", "failed"],
};
const declined = "Administrator approval was declined. Nothing was changed.";
export class RestorePointService {
  // Bypass is only accepted after Windows throttled a normal request in this session.
  private lastThrottledAt: number | null = null;
  private busy = false;
  get isBusy() {
    return this.busy;
  }
  constructor(
    private repo: Repository,
    private platform: Platform,
  ) {}
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy)
      throw new Error("A System Restore request is already running.");
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }
  private withAppState(status: PlatformRestoreStatus): RestoreStatus {
    const meta = this.repo.meta(metaKey) as { lastAppCreatedAt?: unknown };
    return {
      ...status,
      lastAppCreatedAt:
        typeof meta?.lastAppCreatedAt === "string"
          ? meta.lastAppCreatedAt
          : null,
      pendingFrequencyRecovery:
        this.repo.pendingJournal(overrideLabel) !== null,
    };
  }
  async status(): Promise<RestoreStatus> {
    return this.withAppState(await this.platform.restoreStatus());
  }
  list(): Promise<RestorePoints> {
    return this.platform.restoreList();
  }
  async create(
    name: string,
    bypass: boolean,
  ): Promise<CreateRestorePointResult> {
    if (bypass && this.lastThrottledAt === null)
      throw new Error("Retry the normal creation first.");
    return this.exclusive(async () => {
      // Read unelevated before the elevated call so the original value is journalled first.
      const status = await this.platform.restoreStatus();
      if (status.policyDisabled)
        return this.record(
          {
            outcome: "policy-disabled",
            point: null,
            lastPoint: null,
            message: status.message,
            frequencyRestored: null,
          },
          status,
        );
      const journal = bypass
        ? this.repo.journal(
            overrideLabel,
            { frequency: status.frequency },
            "Restore point limit lifted temporarily; the original frequency is saved.",
          )
        : null;
      let result: PlatformCreateResult;
      try {
        result = await this.platform.restoreCreate(
          name,
          bypass,
          status.frequency,
        );
      } catch (error) {
        this.repo.log(
          outcomeLog.failed[0],
          error instanceof Error ? error.message : "Restore point failed.",
          "failed",
        );
        throw error;
      } finally {
        if (journal) await this.finishJournal(journal, status.frequency);
      }
      return this.record(result, status);
    });
  }
  private async finishJournal(id: string, original: Frequency) {
    let current: Frequency | null = null;
    try {
      current = (await this.platform.restoreStatus()).frequency;
    } catch {
      /* Unreadable state stays visible for recovery. */
    }
    if (current && same(current, original))
      this.repo.finish(
        id,
        "success",
        "The original restore point frequency is back in place.",
        false,
      );
    else
      this.repo.finish(
        id,
        "recovery-needed",
        "The original restore point frequency was not confirmed. Restore it from Restore & backups.",
        false,
      );
  }
  private record(
    result: PlatformCreateResult,
    status: PlatformRestoreStatus,
  ): CreateRestorePointResult {
    let message = result.message;
    if (result.outcome === "created") {
      this.lastThrottledAt = null;
      this.repo.setMeta(metaKey, {
        lastAppCreatedAt: result.point?.createdAt ?? new Date().toISOString(),
      });
    }
    if (result.outcome === "throttled") {
      this.lastThrottledAt = Date.now();
      const minutes = status.frequency.minutes ?? 1440;
      const last = result.lastPoint
        ? new Date(result.lastPoint.createdAt).toLocaleString()
        : "an unknown time";
      message = `Windows allows one app-created restore point every ${minutes === 1440 ? "24 hours by default" : `${minutes} minutes on this PC`}; the last one was at ${last}.`;
    }
    if (result.frequencyRestored === false)
      message +=
        " The original restore point frequency was not confirmed; use the recovery action.";
    const [label, activity] = outcomeLog[result.outcome];
    this.repo.log(label, message, activity);
    return {
      outcome: result.outcome,
      point: result.point,
      lastPoint: result.lastPoint,
      message,
    };
  }
  async enable(): Promise<RestoreStatus> {
    return this.exclusive(async () => {
      const before = await this.platform.restoreStatus();
      if (before.policyDisabled)
        throw new Error("System Restore is turned off by policy on this PC.");
      // The drive comes from the helper, never from the renderer.
      const after = await this.platform.restoreEnable(before.systemDrive);
      if (!after) {
        this.repo.log("System Protection unchanged", declined, "cancelled");
        return this.withAppState({ ...before, message: declined });
      }
      const on = after.protection === "enabled";
      this.repo.log(
        on ? "System Protection turned on" : "System Protection not confirmed",
        after.message,
        on ? "success" : "failed",
      );
      return this.withAppState(after);
    });
  }
  async recoverFrequency(): Promise<RestoreStatus> {
    return this.exclusive(async () => {
      const pending = this.repo.pendingJournal(overrideLabel);
      const current = await this.platform.restoreStatus();
      if (!pending) return this.withAppState(current);
      const original = FrequencySchema.parse(
        (pending.snapshot as { frequency?: unknown } | null)?.frequency,
      );
      if (same(current.frequency, original)) {
        this.repo.finish(
          pending.id,
          "success",
          "The original restore point frequency is back in place.",
          false,
        );
        return this.withAppState(current);
      }
      // GC-10: only undo our own bypass value; preserve any external change.
      if (!same(current.frequency, bypassValue)) {
        this.repo.finish(
          pending.id,
          "failed",
          "The restore point frequency was changed outside Frameforge. That change was preserved.",
          false,
        );
        return this.withAppState(current);
      }
      const after = await this.platform.restoreFrequencySet(original);
      if (!after)
        return this.withAppState({
          ...current,
          message:
            "Administrator approval was declined. The restore point limit is still lifted.",
        });
      if (same(after.frequency, original))
        this.repo.finish(
          pending.id,
          "success",
          "The original restore point frequency was restored and verified.",
          false,
        );
      return this.withAppState(after);
    });
  }
}
