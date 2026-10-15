import { randomUUID } from "node:crypto";
import {
  catalogue,
  bootStoreIds,
  restartText,
  serviceOpIds,
  type Restart,
} from "../shared/catalogue.js";
import {
  SnapshotSchema,
  builtInPowerPlans,
  type Activity,
  type OperationId,
  type Preview,
  type Snapshot,
} from "../shared/contracts.js";
import { NotApplied, type Platform } from "./platform.js";
import { Repository } from "./repository.js";
const restartOrder: Restart[] = [
  "none",
  "wallpaper",
  "browser",
  "signin",
  "explorer",
  "signout",
  "reboot",
];
const itemOf = (id: OperationId) => catalogue.find((o) => o.id === id)!;
const highestRestart = (ids: OperationId[]): Restart =>
  ids
    .map((id) => itemOf(id).restart)
    .reduce(
      (a, b) => (restartOrder.indexOf(b) > restartOrder.indexOf(a) ? b : a),
      "none" as Restart,
    );
// What a value becomes: the exact target from the helper, or the legacy "0" for snapshots saved before targets were recorded.
const afterText = (value: Snapshot["values"][number]) =>
  value.target === undefined
    ? value.kind === "String"
      ? "0"
      : "0 (DWORD)"
    : value.target === null
      ? "Removed (not set)"
      : value.kind === "String"
        ? `"${value.target}"`
        : `${value.target} (DWORD)`;
// The helper's own words for a refused or failed step (for example a declined or failed administrator step), kept short.
const detail = (error: unknown) =>
  error instanceof Error &&
  error.message &&
  !["Cancelled", "Verification failed"].includes(error.message) &&
  /^(The machine-level step|Administrator|The administrator)/.test(
    error.message,
  )
    ? `: ${error.message.slice(0, 400)}`
    : "";
const planName = (scheme: string, name?: string) =>
  name ?? builtInPowerPlans[scheme.toLowerCase()] ?? `Custom plan ${scheme}`;
// Snapshots saved before the target was recorded always meant High performance.
const targetPlan = (snapshot: Snapshot) =>
  (snapshot.target ?? "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c").toLowerCase();
export const alreadyOnTarget = (snapshot: Snapshot) =>
  snapshot.scheme?.toLowerCase() === targetPlan(snapshot);
// Every captured value already equals what applying would write (and the plan, if any, is active): applying changes nothing.
export const sameAsTarget = (v: Snapshot["values"][number]) =>
  v.target !== undefined &&
  (v.target === null ? !v.existed : v.existed && v.value === v.target);
const alreadySet = (snapshot: Snapshot) =>
  (snapshot.values.length > 0 || !!snapshot.scheme) &&
  snapshot.values.every(sameAsTarget) &&
  (!snapshot.scheme || alreadyOnTarget(snapshot));
const targetLabel = (snapshot: Snapshot) =>
  planName(targetPlan(snapshot), snapshot.targetName);
// Per-item undo: a journal row keeps one snapshot for everything applied together, and every value names its item, so an
// item's slice (and what is left for the others) is derived from it. Rows saved before this existed split the same way.
const planFields = (snapshot: Snapshot) => ({
  ...(snapshot.scheme ? { scheme: snapshot.scheme } : {}),
  ...(snapshot.target ? { target: snapshot.target } : {}),
  ...(snapshot.schemeName ? { schemeName: snapshot.schemeName } : {}),
  ...(snapshot.targetName ? { targetName: snapshot.targetName } : {}),
});
const sliceOf = (snapshot: Snapshot, ids: OperationId[]): Snapshot => ({
  values: snapshot.values.filter((v) => ids.includes(v.operation)),
  ...(ids.includes("power-plan") ? planFields(snapshot) : {}),
});
const restOf = (snapshot: Snapshot, ids: OperationId[]): Snapshot => ({
  values: snapshot.values.filter((v) => !ids.includes(v.operation)),
  ...(ids.includes("power-plan") ? {} : planFields(snapshot)),
});
/** Which items of one journal row to turn off. */
export interface UndoItem {
  id: string;
  ids: OperationId[];
}
interface UndoPart {
  activity: Activity;
  ids: OperationId[];
  slice: Snapshot;
  /** What stays restorable on the row; null when the whole row is being undone. */
  rest: Snapshot | null;
  left: OperationId[];
}
interface UndoPlan {
  parts: UndoPart[];
  merged: Snapshot;
}
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
    if (ids.some((id) => serviceOpIds.includes(id)))
      throw new Error(
        "Stop Game Mode before changing a Windows service; its session stops and restarts services and would undo or fight the change.",
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
    // Read-only: what Defender itself reports, shown beside the policy change.
    const defender = ids.includes("defender-off")
      ? await this.platform.defenderStatus?.().catch(() => null)
      : null;
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
          setting: value.label ?? `${value.path} / ${value.name}`,
          before: value.existed ? String(value.value) : "Not set",
          after: afterText(value),
          alreadySet: sameAsTarget(value),
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
                alreadySet: alreadyOnTarget(snapshot),
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
        ...(defender ? [`Windows Defender now: ${defender}`] : []),
        ...ids.map((id) => itemOf(id).rollback),
        ...ids
          .filter((id) => itemOf(id).consequence)
          .map((id) => `${itemOf(id).name}: ${itemOf(id).consequence}`),
        ...(highestRestart(ids) !== "none"
          ? [restartText[highestRestart(ids)]]
          : []),
        ...(ids.some((id) => itemOf(id).admin)
          ? [
              "This change needs administrator rights, so Windows will ask for approval. Frameforge only asks for the machine settings listed above.",
            ]
          : []),
      ],
      restart: highestRestart(ids),
      admin: ids.some((id) => itemOf(id).admin),
      security: ids.filter((id) => itemOf(id).tier === "security"),
    };
  }
  cancel() {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }
  /**
   * Applies a preview and, in the same save, turns off `undo` items. The machine-level halves of both go to the helper as ONE
   * request, so the person approves once.
   */
  async confirm(
    token: string,
    acknowledged: OperationId[] = [],
    undo: UndoItem[] = [],
  ): Promise<Activity> {
    if (this.busy) throw new Error("Another operation is running.");
    const preview = this.previews.get(token);
    this.previews.delete(token);
    if (!preview) throw new Error("Preview not found. Create a new preview.");
    if (preview.expires < this.now())
      throw new Error("Preview expired. Review the settings again.");
    this.supported(preview.ids);
    this.noBoost(preview.ids);
    // Security trade-offs are applied only when the person named each one; the dialog cannot be skipped by a stray call.
    const missing = preview.ids.filter(
      (id) => itemOf(id).tier === "security" && !acknowledged.includes(id),
    );
    if (missing.length)
      throw new Error(
        `Acknowledge that this lowers your PC's security first: ${missing.map((id) => itemOf(id).name).join(", ")}.`,
      );
    const plan = undo.length ? this.planUndo(undo) : null;
    if (plan?.parts.some((p) => p.ids.some((id) => preview.ids.includes(id))))
      throw new Error("An item cannot be turned on and off in the same save.");
    this.busy = true;
    this.controller = new AbortController();
    let record: Activity | undefined;
    let notKept = false;
    let undoRan = false;
    let undoNote: string | void = undefined;
    const undoText = plan
      ? ` Turned off: ${plan.parts
          .flatMap((p) => p.ids)
          .map((id) => itemOf(id).name)
          .join(", ")}.`
      : "";
    try {
      const current = await this.platform.capture(preview.ids, true);
      if (JSON.stringify(current) !== JSON.stringify(preview.snapshot))
        throw new Error(
          "Windows settings changed after preview. Review a new preview.",
        );
      // Nothing to write: no backup, and no rollback entry that could ever change anything.
      if (alreadySet(current)) {
        if (plan) await this.runUndo(plan);
        const row = this.repo.beginOperation(preview.ids, current, "");
        return this.repo.finish(
          row.id,
          "success",
          "Already set — no change. Windows already has these values, so nothing was written.",
          false,
        );
      }
      const backup = this.repo.backup("Before Windows preferences");
      record = this.repo.beginOperation(preview.ids, current, backup.id);
      if (this.controller.signal.aborted) throw new Error("Cancelled");
      undoNote = await this.platform.apply(
        preview.ids,
        this.controller.signal,
        current,
        plan?.merged,
      );
      undoRan = true;
      if (this.controller.signal.aborted) throw new Error("Cancelled");
      if (!(await this.platform.verify(preview.ids))) {
        notKept = true;
        throw new Error("Verification failed");
      }
      if (this.controller.signal.aborted) throw new Error("Cancelled");
      const after = preview.ids.includes("defender-off")
        ? await this.platform.defenderStatus?.().catch(() => null)
        : null;
      if (plan) this.finishUndo(plan, undoNote);
      return this.repo.finish(
        record.id,
        "success",
        (alreadyOnTarget(current)
          ? `Windows settings re-read and verified. ${targetLabel(current)} was already active, so the power plan was not changed.`
          : `Windows settings re-read and verified.${after ? ` Windows Defender now: ${after} Only the policy values are verified, not that Defender is off.` : ""} ${restartText[highestRestart(preview.ids)]}`) +
          undoText,
      );
    } catch (e) {
      if (!record) throw e;
      // The helper did the turn-offs in the same step; they stand even when the turn-ons did not stick.
      if (plan && undoRan) this.finishUndo(plan, undoNote);
      else if (plan && !(e instanceof NotApplied)) this.markUndoUnsure(plan);
      // The administrator step never ran (declined, not approved in time, or another prompt was open): nothing was written, so
      // restoring would only open a second prompt for a change that never happened.
      if (e instanceof NotApplied)
        return this.repo.finish(
          record.id,
          "cancelled",
          `Not applied — ${e.reason}. Nothing was changed.`,
          false,
        );
      try {
        await this.platform.restore(preview.snapshot, false);
        return this.repo.finish(
          record.id,
          this.controller.signal.aborted ? "cancelled" : "failed",
          notKept
            ? "Windows reverted or did not keep the change when it was read back, so nothing was reported as applied. The captured Windows state was restored."
            : `The operation did not complete${detail(e)}. The captured Windows state was restored.`,
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
    return (await this.rollbackBatch([{ id, ids: row.activity.ids }]))[0]!;
  }
  /**
   * Read-only, never opens an administrator prompt: whether Windows currently has each available optimization's target values.
   * Boot-store items need administrator rights to read, so they stay "unknown".
   */
  async status(): Promise<
    { id: OperationId; state: "on" | "off" | "unknown" }[]
  > {
    const ids = this.platform.capabilities;
    const state = new Map<OperationId, "on" | "off" | "unknown">(
      ids.map((id) => [id, "unknown"]),
    );
    const read = async (list: OperationId[]): Promise<void> => {
      if (!list.length) return;
      try {
        const snapshot = await this.platform.capture(list);
        for (const id of list) {
          const values = snapshot.values.filter((v) => v.operation === id);
          if (values.length)
            state.set(id, values.every(sameAsTarget) ? "on" : "off");
        }
      } catch {
        // One unreadable item (e.g. a service that is not installed) must not blank the others.
        if (list.length > 1) for (const id of list) await read([id]);
      }
    };
    await read(
      ids.filter((id) => id !== "power-plan" && !bootStoreIds.includes(id)),
    );
    if (ids.includes("power-plan"))
      try {
        state.set(
          "power-plan",
          alreadyOnTarget(await this.platform.capture(["power-plan"]))
            ? "on"
            : "off",
        );
      } catch {
        // Stays unknown.
      }
    return ids.map((id) => ({ id, state: state.get(id)! }));
  }
  /**
   * Validates turn-offs before anything is written: each item must belong to its still-restorable journal row. One merged
   * snapshot of just those items' values is what gets restored, so the rest of a batch or preset stays as it is.
   */
  private planUndo(items: UndoItem[]): UndoPlan {
    if (!items.length || new Set(items.map((i) => i.id)).size !== items.length)
      throw new Error("No restorable snapshot for this operation.");
    const parts = items.map(({ id, ids }): UndoPart => {
      const row = this.repo.operation(id);
      if (!row || !row.activity.rollback)
        throw new Error("No restorable snapshot for this operation.");
      if (
        !ids.length ||
        new Set(ids).size !== ids.length ||
        ids.some((i) => !row.activity.ids.includes(i))
      )
        throw new Error("Those items are not part of this change.");
      const snapshot = SnapshotSchema.parse(row.snapshot);
      const whole = row.activity.ids.every((i) => ids.includes(i));
      const slice = whole ? snapshot : sliceOf(snapshot, ids);
      if (!slice.values.length && !slice.scheme)
        throw new Error("Nothing was saved to restore for these items.");
      return {
        activity: row.activity,
        ids,
        slice,
        rest: whole ? null : restOf(snapshot, ids),
        left: row.activity.ids.filter((i) => !ids.includes(i)),
      };
    });
    const all = parts.flatMap((p) => p.ids);
    if (all.includes("capture-off")) this.noBoost(["capture-off"]);
    this.noBoost(all.filter((id) => serviceOpIds.includes(id)));
    // The probe hides power-plan when High performance is missing, but going back to the prior plan needs only the helper.
    if (
      all.some(
        (id) =>
          !this.platform.capabilities.includes(id) &&
          !(id === "power-plan" && this.platform.probe),
      )
    )
      throw new Error("This operation is unavailable on this installation.");
    // Two rows that touch the same item would fight over one value; they must be undone one at a time.
    if (
      new Set(all).size !== all.length ||
      parts.filter((p) => p.slice.scheme).length > 1
    )
      throw new Error(
        "Some of these changes overlap. Undo them one at a time from Activity.",
      );
    return {
      parts,
      merged: {
        ...(parts.find((p) => p.slice.scheme)?.slice ?? {}),
        values: parts.flatMap((p) => p.slice.values),
      },
    };
  }
  /** Journal after a verified restore: a fully undone row is closed; a partly undone row keeps the items still on. */
  private finishUndo(plan: UndoPlan, note: string | void): Activity[] {
    return plan.parts.map((p) =>
      p.rest
        ? this.repo.shrink(
            p.activity.id,
            p.left,
            p.rest,
            `${p.activity.message} Turned off since: ${p.ids.map((id) => itemOf(id).name).join(", ")}.`,
          )
        : this.repo.finish(
            p.activity.id,
            "rolled-back",
            `The captured Windows state was restored and verified.${note ? ` ${note}` : ""}`,
            false,
          ),
    );
  }
  private markUndoUnsure(plan: UndoPlan) {
    for (const p of plan.parts)
      this.repo.finish(
        p.activity.id,
        "recovery-needed",
        "Rollback could not finish. Settings may have been changed externally; review the Windows preferences before retrying.",
      );
  }
  private async runUndo(plan: UndoPlan): Promise<Activity[]> {
    try {
      const note = await this.platform.restore(plan.merged, false);
      return this.finishUndo(plan, note);
    } catch (e) {
      // Declined, not approved or blocked by another prompt: nothing was restored and nothing is in doubt. The rows stay restorable.
      if (e instanceof NotApplied) {
        const text = `Rollback not done — ${e.reason}. The settings are unchanged; retry when you can answer the prompt.`;
        this.repo.log("Rollback not done", text, "failed");
        throw Object.assign(new Error(text), { logged: true });
      }
      this.markUndoUnsure(plan);
      return plan.parts.map(
        (p) => this.repo.operation(p.activity.id)!.activity,
      );
    }
  }
  /** Turns off items (each from its own journal row) through ONE platform restore, so a machine-wide batch asks once. */
  async rollbackBatch(items: UndoItem[]): Promise<Activity[]> {
    if (this.busy) throw new Error("Another operation is running.");
    const plan = this.planUndo(items);
    this.busy = true;
    try {
      return await this.runUndo(plan);
    } finally {
      this.busy = false;
    }
  }
}
