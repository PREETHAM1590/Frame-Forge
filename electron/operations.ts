import { randomUUID } from "node:crypto";
import { catalogue } from "../shared/catalogue.js";
import {
  SnapshotSchema,
  builtInPowerPlans,
  type Activity,
  type OperationId,
  type Preview,
  type Snapshot,
} from "../shared/contracts.js";
import type { Platform } from "./platform.js";
import { Repository } from "./repository.js";
const planName = (scheme: string, name?: string) =>
  name ?? builtInPowerPlans[scheme.toLowerCase()] ?? `Custom plan ${scheme}`;
// Snapshots saved before the target was recorded always meant High performance.
const targetPlan = (snapshot: Snapshot) =>
  (snapshot.target ?? "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c").toLowerCase();
const alreadyOnTarget = (snapshot: Snapshot) =>
  snapshot.scheme?.toLowerCase() === targetPlan(snapshot);
const targetLabel = (snapshot: Snapshot) =>
  planName(targetPlan(snapshot), snapshot.targetName);
export class OperationEngine {
  private previews = new Map<
    string,
    { ids: OperationId[]; expires: number; snapshot: Snapshot }
  >();
  private controller: AbortController | null = null;
  private busy = false;
  constructor(
    private repo: Repository,
    private platform: Platform,
    private now = Date.now,
  ) {}
  get isBusy() {
    return this.busy;
  }
  private supported(ids: OperationId[]) {
    if (
      !ids.length ||
      ids.some((id) => !this.platform.capabilities.includes(id))
    )
      throw new Error("This operation is unavailable on this installation.");
  }
  // A boost session restores the plan it found when it ends, which would undo this switch.
  // The session also writes the same Game Bar capture value, so capture-off waits for it too.
  // Rolling back the power plan is deliberately not blocked (a recovery path); rolling back capture-off is.
  private noBoost(ids: OperationId[]) {
    if (!this.repo.boostSession()) return;
    if (ids.includes("power-plan"))
      throw new Error(
        "Stop Game Mode before changing the power plan; its session restores the plan when it ends.",
      );
    if (ids.includes("capture-off"))
      throw new Error(
        "Stop Game Mode before changing background game capture; the session writes the same Windows value and would undo or overwrite the change.",
      );
  }
  async preview(ids: OperationId[]): Promise<Preview> {
    this.supported(ids);
    this.noBoost(ids);
    if (this.busy) throw new Error("Another operation is running.");
    const snapshot = await this.platform.capture(ids);
    const token = randomUUID();
    const expires = this.now() + 300000;
    for (const [key, value] of this.previews)
      if (value.expires < this.now()) this.previews.delete(key);
    if (this.previews.size >= 20) this.previews.clear();
    this.previews.set(token, { ids, expires, snapshot });
    return {
      token,
      expiresAt: new Date(expires).toISOString(),
      ids,
      changes: [
        ...snapshot.values.map((value) => ({
          id: value.operation,
          setting: `${value.path} / ${value.name}`,
          before: value.existed ? String(value.value) : "Not set",
          after: value.kind === "String" ? "0" : "0 (DWORD)",
        })),
        ...(snapshot.scheme
          ? [
              {
                id: "power-plan" as const,
                setting: "Active Windows power plan",
                before: planName(snapshot.scheme, snapshot.schemeName),
                after: alreadyOnTarget(snapshot)
                  ? `${targetLabel(snapshot)} (already active; no change)`
                  : targetLabel(snapshot),
              },
            ]
          : []),
      ],
      warnings: [
        ...(alreadyOnTarget(snapshot)
          ? [
              `${targetLabel(snapshot)} is already the active plan. Applying leaves the power plan unchanged.`,
            ]
          : []),
        ...ids.map((id) => catalogue.find((o) => o.id === id)!.rollback),
      ],
    };
  }
  cancel() {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }
  async confirm(token: string): Promise<Activity> {
    if (this.busy) throw new Error("Another operation is running.");
    const preview = this.previews.get(token);
    this.previews.delete(token);
    if (!preview) throw new Error("Preview not found. Create a new preview.");
    if (preview.expires < this.now())
      throw new Error("Preview expired. Review the settings again.");
    this.supported(preview.ids);
    this.noBoost(preview.ids);
    this.busy = true;
    this.controller = new AbortController();
    let record: Activity | undefined;
    try {
      const current = await this.platform.capture(preview.ids);
      if (JSON.stringify(current) !== JSON.stringify(preview.snapshot))
        throw new Error(
          "Windows settings changed after preview. Review a new preview.",
        );
      const backup = this.repo.backup("Before Windows preferences");
      record = this.repo.beginOperation(preview.ids, current, backup.id);
      if (this.controller.signal.aborted) throw new Error("Cancelled");
      await this.platform.apply(preview.ids, this.controller.signal, current);
      if (this.controller.signal.aborted) throw new Error("Cancelled");
      if (!(await this.platform.verify(preview.ids)))
        throw new Error("Verification failed");
      if (this.controller.signal.aborted) throw new Error("Cancelled");
      return this.repo.finish(
        record.id,
        "success",
        alreadyOnTarget(current)
          ? `Windows settings re-read and verified. ${targetLabel(current)} was already active, so the power plan was not changed.`
          : "Windows settings re-read and verified. See the operation details for when Windows reloads them.",
      );
    } catch (e) {
      if (!record) throw e;
      try {
        await this.platform.restore(preview.snapshot, false);
        return this.repo.finish(
          record.id,
          this.controller.signal.aborted ? "cancelled" : "failed",
          "The operation did not complete. The captured Windows state was restored.",
          false,
        );
      } catch {
        return this.repo.finish(
          record.id,
          "recovery-needed",
          "The operation did not complete and automatic recovery failed. Inspect the saved snapshot and retry rollback.",
        );
      }
    } finally {
      this.controller = null;
      this.busy = false;
    }
  }
  async rollback(id: string): Promise<Activity> {
    if (this.busy) throw new Error("Another operation is running.");
    const row = this.repo.operation(id);
    if (!row || !row.activity.rollback)
      throw new Error("No restorable snapshot for this operation.");
    if (row.activity.ids.includes("capture-off")) this.noBoost(["capture-off"]);
    // The probe hides power-plan when High performance is missing, but going back to the prior plan needs only the helper.
    if (
      row.activity.ids.some(
        (id) =>
          !this.platform.capabilities.includes(id) &&
          !(id === "power-plan" && this.platform.probe),
      )
    )
      throw new Error("This operation is unavailable on this installation.");
    this.busy = true;
    try {
      await this.platform.restore(SnapshotSchema.parse(row.snapshot), false);
      return this.repo.finish(
        id,
        "rolled-back",
        "The captured Windows state was restored and verified.",
        false,
      );
    } catch {
      return this.repo.finish(
        id,
        "recovery-needed",
        "Rollback could not finish. Settings may have been changed externally; review the Windows preferences before retrying.",
      );
    } finally {
      this.busy = false;
    }
  }
}
