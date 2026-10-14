import type {
  Activity,
  StartupItem,
  StartupStatus,
  StartupWriteResult,
} from "../shared/contracts.js";
import type { Platform } from "./platform.js";
import type { Repository } from "./repository.js";
// What Frameforge saved before it changed one item's StartupApproved value: the exact prior (null = no value) and what it wrote.
const changesKey = "startup.changes";
type Change = {
  name: string;
  prior: string | null;
  written: string | null;
  at: string;
};
type Log = (
  label: string,
  message: string,
  status?: Activity["status"],
) => void;
/** An expected refusal that has already been written to Activity in its own words. */
const refused = (message: string) =>
  Object.assign(new Error(message), { logged: true });
const machine = (id: string) => id.startsWith("hklm-");
export class StartupService {
  private busy = false;
  constructor(
    private repo: Repository,
    private platform: Platform,
    private log: Log,
  ) {}
  get isBusy() {
    return this.busy;
  }
  private changes(): Record<string, Change> {
    const value = this.repo.meta(changesKey);
    return value && typeof value === "object"
      ? (value as Record<string, Change>)
      : {};
  }
  private status(
    items: StartupItem[],
    warnings: string[],
    message = "",
  ): StartupStatus {
    const changes = this.changes();
    // An entry that is gone has nothing left to put back.
    const present = new Set(items.map((i) => i.id));
    const kept = Object.fromEntries(
      Object.entries(changes).filter(([id]) => present.has(id)),
    );
    if (Object.keys(kept).length !== Object.keys(changes).length)
      this.repo.setMeta(changesKey, Object.keys(kept).length ? kept : null);
    return {
      items,
      warnings,
      message,
      changes: Object.entries(kept).map(([id, c]) => ({
        id,
        name: c.name,
        at: c.at,
      })),
    };
  }
  async list(message = ""): Promise<StartupStatus> {
    const { items, warnings } = await this.platform.startupList();
    return this.status(items, warnings, message);
  }
  /** Runs one helper write; machine-wide items hold the shared administrator gate so no two prompts overlap. */
  private write(
    id: string,
    call: Parameters<Platform["startupSet"]>[0],
  ): Promise<StartupWriteResult> {
    return machine(id)
      ? this.platform.elevation.with("startup", () =>
          this.platform.startupSet(call),
        )
      : this.platform.startupSet(call);
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Wait for the startup change to finish.");
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }
  /** A write that did not happen: say so in Activity and stop. */
  private notDone(label: string, name: string, r: StartupWriteResult): never {
    this.log(
      label,
      `${name}: ${r.detail}`.slice(0, 1000),
      r.state === "failed" ? "failed" : "cancelled",
    );
    throw refused(r.detail);
  }
  set(id: string, enabled: boolean, acknowledged: boolean) {
    return this.exclusive(async () => {
      const label = enabled
        ? "Startup program enabled"
        : "Startup program disabled";
      const { items, warnings } = await this.platform.startupList();
      const item = items.find((i) => i.id === id);
      if (!item) throw new Error("That startup item is no longer listed.");
      if (!item.canToggle)
        throw new Error(
          "Windows has no startup switch for this item; Frameforge only lists it.",
        );
      if (!enabled && item.critical && !acknowledged)
        throw new Error(
          `${item.name} is protected: ${item.criticalReason ?? "turning it off can have side effects"} Confirm to continue.`,
        );
      if (item.enabled === enabled)
        return this.status(
          items,
          warnings,
          `${item.name} is already ${enabled ? "enabled" : "disabled"}.`,
        );
      const before = item.approved;
      const result = await this.write(id, {
        id,
        op: "set",
        enable: enabled,
        expect: before,
        machine: machine(id),
      });
      if (result.state === "already-set")
        return this.list(
          `${item.name} was already ${enabled ? "enabled" : "disabled"}.`,
        );
      if (result.state !== "applied") this.notDone(label, item.name, result);
      const changes = this.changes();
      // The first change keeps the true original; later ones only move what was written.
      changes[id] = {
        name: item.name,
        prior: changes[id] ? changes[id].prior : before,
        written: result.after,
        at: new Date().toISOString(),
      };
      this.repo.setMeta(changesKey, changes);
      this.log(
        label,
        `${item.name} (${item.source}): ${enabled ? "enabled" : "disabled"} the same way Task Manager does. Undo puts the previous Windows value back.`,
      );
      return this.list(`${item.name} ${enabled ? "enabled" : "disabled"}.`);
    });
  }
  undo(id: string) {
    return this.exclusive(async () => {
      const change = this.changes()[id];
      if (!change) throw new Error("Frameforge has no saved change to undo.");
      const result = await this.write(id, {
        id,
        op: "restore",
        expect: change.written,
        next: change.prior,
        machine: machine(id),
      });
      const label = "Startup change undone";
      if (result.state !== "applied" && result.state !== "already-set") {
        // Changed elsewhere since: that newer value is not Frameforge's to overwrite, so the saved change is dropped.
        if (result.state === "conflict") {
          const rest = this.changes();
          delete rest[id];
          this.repo.setMeta(changesKey, Object.keys(rest).length ? rest : null);
        }
        this.notDone(label, change.name, result);
      }
      const rest = this.changes();
      delete rest[id];
      this.repo.setMeta(changesKey, Object.keys(rest).length ? rest : null);
      this.log(
        label,
        `${change.name}: the previous Windows startup value was restored${change.prior === null ? " (it had none)" : ""} and verified.`,
      );
      return this.list(`${change.name} restored to how it was.`);
    });
  }
}
