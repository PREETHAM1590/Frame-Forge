import { randomUUID } from "node:crypto";
import { catalogue } from "../shared/catalogue.js";
import {
  SnapshotSchema,
  type Activity,
  type OperationId,
  type Preview,
  type Snapshot,
} from "../shared/contracts.js";
import type { Platform } from "./platform.js";
import { Repository } from "./repository.js";
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
  async preview(ids: OperationId[]): Promise<Preview> {
    this.supported(ids);
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
      changes: snapshot.values.map((value) => ({
        id: value.operation,
        setting: `${value.path} / ${value.name}`,
        before: value.existed ? String(value.value) : "Not set",
        after: value.kind === "String" ? "0" : "0 (DWORD)",
      })),
      warnings: ids.map((id) => catalogue.find((o) => o.id === id)!.rollback),
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
        "Windows registry preferences verified. See the operation details for when Windows reloads them.",
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
    this.supported(row.activity.ids);
    this.busy = true;
    try {
      await this.platform.restore(SnapshotSchema.parse(row.snapshot), false);
      return this.repo.finish(
        id,
        "rolled-back",
        "The captured Windows registry state was restored and verified.",
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
