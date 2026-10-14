import {
  FrequencySchema,
  type Activity,
  type CreateRestorePointResult,
  type Frequency,
  type RestorePoints,
  type RestoreStatus,
} from "../shared/contracts.js";
import { restoreLabels, type Repository } from "./repository.js";
import type {
  Platform,
  PlatformCreateResult,
  PlatformRestoreStatus,
} from "./platform.js";
export const overrideLabel = restoreLabels.override;
export const pendingLabel = restoreLabels.pending;
const metaKey = "restore_meta";
// The last per-drive answer from an elevated Enable; unelevated reads only have the any-drive hint.
const driveKey = "restore_system_drive";
const bypassValue: Frequency = { existed: true, minutes: 0 };
// A bypass needs fresh consent: one attempt, shortly after the explained throttle.
const bypassWindowMs = 10 * 60 * 1000;
const same = (a: Frequency, b: Frequency) =>
  a.existed === b.existed && (a.minutes ?? null) === (b.minutes ?? null);
/** Windows skipped creation because a recent point exists: say which one, and that the PC is still covered. */
export function throttledMessage(
  last: { description: string; createdAt: string } | null,
  fallback: string,
): string {
  if (!last) return fallback;
  return `Windows skipped creating a new restore point because one was created recently (${last.description}, ${new Date(last.createdAt).toLocaleString()}). Your PC is still protected by that point.`;
}
const outcomeLog: Record<
  CreateRestorePointResult["outcome"],
  [string, Activity["status"]]
> = {
  created: ["Windows restore point created", "success"],
  throttled: ["Restore point skipped: a recent point exists", "cancelled"],
  "protection-disabled": ["System Protection is off", "failed"],
  "policy-disabled": ["System Restore is disabled by policy", "failed"],
  "elevation-cancelled": ["Restore point cancelled", "cancelled"],
  failed: ["Restore point not created", "failed"],
  pending: ["Restore point pending verification", "running"],
};
const declined = "Administrator approval was declined. Nothing was changed.";
type PendingSnapshot = { resultPath: string | null; name: string; at: string };
export class RestorePointService {
  private lastThrottledAt: number | null = null;
  private busy = false;
  get isBusy() {
    return this.busy;
  }
  constructor(
    private repo: Repository,
    private platform: Platform,
  ) {}
  // Every elevated request takes the shared gate too, so two administrator prompts never open together.
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy)
      throw new Error("A System Restore request is already running.");
    this.platform.elevation.hold("restore");
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
      this.platform.elevation.release("restore");
    }
  }
  /** Withdraws the request whose Windows prompt is still open, so a late approval changes nothing. */
  cancel() {
    return this.busy && (this.platform.cancelElevated?.() ?? false);
  }
  // A dated past confirmation: shown as "confirmed <time>", dropped by any read that says off or unknown.
  private confirmedAt(status: PlatformRestoreStatus): string | null {
    const saved = this.repo.meta(driveKey) as {
      at?: unknown;
      drive?: unknown;
    } | null;
    if (status.protection !== "enabled") {
      if (saved?.at) this.forgetDrive();
      return null;
    }
    return typeof saved?.at === "string" && saved.drive === status.systemDrive
      ? saved.at
      : null;
  }
  private confirmDrive(drive: string) {
    this.repo.setMeta(driveKey, { at: new Date().toISOString(), drive });
  }
  private forgetDrive() {
    this.repo.setMeta(driveKey, {});
  }
  private withAppState(status: PlatformRestoreStatus): RestoreStatus {
    const meta = this.repo.meta(metaKey) as { lastAppCreatedAt?: unknown };
    return {
      protection: status.protection,
      policyDisabled: status.policyDisabled,
      configLocked: status.configLocked,
      frequency: status.frequency,
      elevated: status.elevated,
      systemDrive: status.systemDrive,
      message: status.message,
      systemDriveConfirmedAt: this.confirmedAt(status),
      lastAppCreatedAt:
        typeof meta?.lastAppCreatedAt === "string"
          ? meta.lastAppCreatedAt
          : null,
      pendingFrequencyRecovery:
        this.repo.pendingJournal(overrideLabel) !== null,
      pendingCreation: this.repo.pendingJournal(pendingLabel) !== null,
    };
  }
  async status(): Promise<RestoreStatus> {
    const status = await this.platform.restoreStatus();
    if (!this.busy) await this.checkPending(status);
    return this.withAppState(status);
  }
  // Reads the result an elevated child wrote after the helper stopped waiting.
  private async checkPending(status: PlatformRestoreStatus) {
    const pending = this.repo.pendingJournal(pendingLabel);
    const snapshot = pending?.snapshot as PendingSnapshot | undefined;
    if (!pending || !snapshot?.resultPath) return;
    let result: PlatformCreateResult | null = null;
    try {
      result = await this.platform.restoreResult(snapshot.resultPath);
    } catch {
      /* Still unverified; the row stays visible. */
    }
    if (!result) return;
    const message = this.record(result, status).message;
    this.repo.finish(
      pending.id,
      result.outcome === "created" ? "success" : "failed",
      message,
      false,
    );
  }
  // Listing opens an administrator prompt as well, so it is exclusive like the other elevated requests.
  list(): Promise<RestorePoints> {
    return this.exclusive(() => this.listNow());
  }
  private async listNow(): Promise<RestorePoints> {
    const points = await this.platform.restoreList();
    // A pending creation without a result file is verified against the real list.
    const pending = this.repo.pendingJournal(pendingLabel);
    const snapshot = pending?.snapshot as PendingSnapshot | undefined;
    if (pending && snapshot && points.available) {
      const since = Date.parse(snapshot.at) - 60000;
      const point = points.points.find(
        (p) =>
          p.description === snapshot.name && Date.parse(p.createdAt) >= since,
      );
      if (point)
        this.repo.finish(
          pending.id,
          "success",
          `Verified restore point #${point.sequence} "${point.description}".`,
          false,
        );
      else if (!snapshot.resultPath)
        this.repo.finish(
          pending.id,
          "failed",
          "No matching restore point was found. Create a new one.",
          false,
        );
    }
    return points;
  }
  async create(
    name: string,
    bypass: boolean,
  ): Promise<CreateRestorePointResult> {
    if (
      bypass &&
      (this.lastThrottledAt === null ||
        Date.now() - this.lastThrottledAt > bypassWindowMs)
    )
      throw new Error("Retry the normal creation first.");
    return this.exclusive(async () => {
      if (bypass) this.lastThrottledAt = null;
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
            resultPath: null,
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
      const at = new Date().toISOString();
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
      if (result.outcome === "pending") {
        this.repo.journal(
          pendingLabel,
          { resultPath: result.resultPath, name, at } satisfies PendingSnapshot,
          result.message,
        );
        return this.response(result);
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
        "The original restore point frequency was not confirmed. Open Restore & backups and choose Restore the original limit.",
        false,
      );
  }
  private response(result: PlatformCreateResult): CreateRestorePointResult {
    return {
      outcome: result.outcome,
      point: result.point,
      lastPoint: result.lastPoint,
      message: result.message,
    };
  }
  private record(
    result: PlatformCreateResult,
    status: PlatformRestoreStatus,
  ): CreateRestorePointResult {
    let message = result.message;
    if (result.driveCoverage === "confirmed")
      this.confirmDrive(status.systemDrive);
    else if (result.driveCoverage) this.forgetDrive();
    const [label, activity] = outcomeLog[result.outcome];
    if (result.outcome === "created") {
      this.lastThrottledAt = null;
      const point = result.point;
      this.repo.setMeta(metaKey, {
        lastAppCreatedAt: point?.createdAt ?? new Date().toISOString(),
      });
      if (point)
        message = `Restore point #${point.sequence} "${point.description}" created ${new Date(point.createdAt).toLocaleString()} and verified in the Windows list.`;
      // Coverage is reported as the helper saw it; an unconfirmed or "off" reading must stay visible next to the success.
      if (result.driveCoverage === "off")
        message += ` Frameforge's check reads System Protection as off for ${status.systemDrive}, so this point may not cover the system drive. Check System Properties > System Protection.`;
      else if (result.driveCoverage === "unknown")
        message += ` Coverage of ${status.systemDrive} could not be confirmed.`;
    }
    if (result.outcome === "throttled") {
      this.lastThrottledAt = Date.now();
      message = throttledMessage(result.lastPoint, result.message);
    }
    if (result.frequencyRestored === false)
      message +=
        " The original restore point frequency was not confirmed; use the recovery action.";
    this.repo.log(label, message, activity);
    return this.response({ ...result, message });
  }
  async enable(): Promise<RestoreStatus> {
    return this.exclusive(async () => {
      const before = await this.platform.restoreStatus();
      if (before.policyDisabled)
        throw new Error("System Restore is turned off by policy on this PC.");
      if (before.configLocked)
        throw new Error(
          "Turning on System Protection is blocked by policy on this PC.",
        );
      let after: PlatformRestoreStatus | null;
      try {
        // The drive comes from the helper, never from the renderer.
        after = await this.platform.restoreEnable(before.systemDrive);
      } catch (error) {
        this.repo.log(
          "System Protection not turned on",
          error instanceof Error
            ? error.message
            : "Windows refused the change.",
          "failed",
        );
        throw error;
      }
      if (!after) {
        this.repo.log("System Protection unchanged", declined, "cancelled");
        return this.withAppState({ ...before, message: declined });
      }
      // Still running: no outcome to record yet; the next status refresh shows it.
      if (after.pending) return this.withAppState(after);
      if (after.systemDriveConfirmed) this.confirmDrive(after.systemDrive);
      else this.forgetDrive();
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
      if (!after) {
        const message =
          "Administrator approval was declined. The restore point limit is still lifted.";
        this.repo.log("Restore point limit not restored", message, "cancelled");
        return this.withAppState({ ...current, message });
      }
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
