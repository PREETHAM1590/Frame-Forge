import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  ActivitySchema,
  BackupSchema,
  BoostSessionSchema,
  CapturedSchema,
  StateSchema,
  defaultState,
  legacyMechanismIds,
  type Activity,
  type AppState,
  type Backup,
  type BoostSession,
  type Captured,
  type OperationId,
} from "../shared/contracts.js";
import { migrations } from "./migrations.js";
type Row = Record<string, unknown>;
export const restoreLabels = {
  override: "Restore point throttle override",
  pending: "Restore point pending verification",
} as const;
const restoreRecovery: Record<string, string> = {
  [restoreLabels.override]:
    "The app stopped while the Windows restore point limit was lifted. Open Restore & backups and choose Restore the original limit.",
  [restoreLabels.pending]:
    "The app stopped while Windows was creating a restore point. Open Restore & backups to check it.",
};
// Unfinished sessions from before GPU preference and fullscreen optimizations became launch settings may carry those ids.
function stripLegacyIds(payload: Record<string, unknown>): {
  payload: Record<string, unknown>;
  dropped: number;
} {
  const keep = (id: unknown) => !legacyMechanismIds.includes(String(id));
  const captured = Array.isArray(payload.captured)
    ? payload.captured.filter((c) =>
        keep((c as { mechanism?: unknown })?.mechanism),
      )
    : payload.captured;
  const mechanisms = Array.isArray(payload.mechanisms)
    ? payload.mechanisms.filter((m) => keep((m as { id?: unknown })?.id))
    : payload.mechanisms;
  const dropped =
    (Array.isArray(payload.captured) && Array.isArray(captured)
      ? payload.captured.length - captured.length
      : 0) +
    (Array.isArray(payload.mechanisms) && Array.isArray(mechanisms)
      ? payload.mechanisms.length - mechanisms.length
      : 0);
  return dropped
    ? { payload: { ...payload, captured, mechanisms }, dropped }
    : { payload, dropped: 0 };
}
export class Repository {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const version = Number(
      (this.db.prepare("PRAGMA user_version").get() as Row).user_version,
    );
    if (version > migrations.length)
      throw new Error(
        "Database was created by a newer app. Configuration is preserved.",
      );
    for (let i = version; i < migrations.length; i++)
      this.transaction(() => {
        const migration = migrations[i]!;
        if (typeof migration === "string") this.db.exec(migration);
        else migration(this.db);
        this.db.exec(`PRAGMA user_version=${i + 1}`);
      });
    this.db
      .prepare("INSERT OR IGNORE INTO configuration(id,payload) VALUES(1,?)")
      .run(JSON.stringify(defaultState));
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  state(): AppState {
    return StateSchema.parse(
      JSON.parse(
        String(
          (
            this.db
              .prepare("SELECT payload FROM configuration WHERE id=1")
              .get() as Row
          ).payload,
        ),
      ),
    );
  }
  updateState(state: AppState): AppState {
    const parsed = StateSchema.parse(state);
    this.db
      .prepare("UPDATE configuration SET payload=? WHERE id=1")
      .run(JSON.stringify(parsed));
    return parsed;
  }
  backup(name: string): Backup {
    const backup = BackupSchema.parse({
      id: randomUUID(),
      name,
      at: new Date().toISOString(),
      state: this.state(),
    });
    this.db
      .prepare("INSERT INTO backups(id,name,at,payload) VALUES(?,?,?,?)")
      .run(backup.id, backup.name, backup.at, JSON.stringify(backup.state));
    return backup;
  }
  backups(): Backup[] {
    return this.db
      .prepare("SELECT * FROM backups ORDER BY at DESC LIMIT 500")
      .all()
      .map((row) =>
        BackupSchema.parse({
          id: row.id,
          name: row.name,
          at: row.at,
          state: JSON.parse(String(row.payload)),
        }),
      );
  }
  restore(id: string): AppState {
    const row = this.db
      .prepare("SELECT payload FROM backups WHERE id=?")
      .get(id);
    if (!row) throw new Error("Backup not found");
    const state = StateSchema.parse(JSON.parse(String(row.payload)));
    return this.transaction(() => {
      this.backup("Before configuration restore");
      return this.updateState(state);
    });
  }
  beginOperation(
    ids: OperationId[],
    snapshot: unknown,
    backupId: string,
  ): Activity {
    const activity: Activity = {
      id: randomUUID(),
      label: ids.length === 1 ? "Apply preference" : "Apply preset",
      at: new Date().toISOString(),
      status: "running",
      message: "Snapshot saved; operation in progress.",
      ids,
      rollback: true,
    };
    this.db
      .prepare(
        "INSERT INTO operations(id,label,at,status,message,ids,snapshot,backup_id,rollback) VALUES(?,?,?,?,?,?,?,?,1)",
      )
      .run(
        activity.id,
        activity.label,
        activity.at,
        activity.status,
        activity.message,
        JSON.stringify(ids),
        JSON.stringify(snapshot),
        backupId,
      );
    return activity;
  }
  finish(
    id: string,
    status: Activity["status"],
    message: string,
    rollback = true,
  ): Activity {
    this.db
      .prepare("UPDATE operations SET status=?,message=?,rollback=? WHERE id=?")
      .run(status, message.slice(0, 1000), Number(rollback), id);
    const row = this.operation(id);
    if (!row) throw new Error("Operation not found");
    return row.activity;
  }
  log(
    label: string,
    message: string,
    status: Activity["status"] = "success",
  ): void {
    this.db
      .prepare(
        "INSERT INTO operations(id,label,at,status,message,ids,rollback) VALUES(?,?,?,?,?,?,0)",
      )
      .run(
        randomUUID(),
        label,
        new Date().toISOString(),
        status,
        message,
        JSON.stringify([]),
      );
  }
  /** Journal row for a non-registry Windows change; never offered as a registry rollback. */
  journal(label: string, snapshot: unknown, message: string): string {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO operations(id,label,at,status,message,ids,snapshot,rollback) VALUES(?,?,?,'running',?,'[]',?,0)",
      )
      .run(
        id,
        label,
        new Date().toISOString(),
        message,
        JSON.stringify(snapshot),
      );
    return id;
  }
  pendingJournal(label: string): { id: string; snapshot: unknown } | null {
    const row = this.db
      .prepare(
        "SELECT id, snapshot FROM operations WHERE label=? AND status IN ('running','recovery-needed') ORDER BY at DESC, rowid DESC LIMIT 1",
      )
      .get(label);
    return row
      ? { id: String(row.id), snapshot: JSON.parse(String(row.snapshot)) }
      : null;
  }
  /** True while a successful, not rolled back optimization contains this id. */
  optimizationApplied(id: OperationId): boolean {
    return this.db
      .prepare(
        "SELECT ids FROM operations WHERE rollback=1 AND status='success'",
      )
      .all()
      .some((row) => (JSON.parse(String(row.ids)) as string[]).includes(id));
  }
  meta(key: string): unknown {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    return row ? JSON.parse(String(row.value)) : null;
  }
  /** Values are JSON; null removes the key. */
  setMeta(key: string, value: unknown): void {
    if (value === null)
      this.db.prepare("DELETE FROM meta WHERE key=?").run(key);
    else
      this.db
        .prepare(
          "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, JSON.stringify(value));
  }
  activity(): Activity[] {
    return this.db
      .prepare(
        "SELECT * FROM operations WHERE rollback=1 OR status IN ('running','recovery-needed') OR id IN (SELECT id FROM operations WHERE rollback=0 AND status NOT IN ('running','recovery-needed') ORDER BY at DESC, rowid DESC LIMIT 500) ORDER BY at DESC, rowid DESC",
      )
      .all()
      .map((row) => this.toActivity(row));
  }
  private toActivity(row: Row): Activity {
    return ActivitySchema.parse({
      id: row.id,
      label: row.label,
      at: row.at,
      status: row.status,
      message: row.message,
      ids: JSON.parse(String(row.ids)),
      rollback: !!row.rollback,
    });
  }
  operation(id: string): { activity: Activity; snapshot: unknown } | null {
    const row = this.db.prepare("SELECT * FROM operations WHERE id=?").get(id);
    return row
      ? {
          activity: this.toActivity(row),
          snapshot: row.snapshot ? JSON.parse(String(row.snapshot)) : null,
        }
      : null;
  }
  recoverInterrupted(): void {
    this.dropRetiredCaptures();
    // Restore point rows are resolved on Restore & backups, not by a registry snapshot.
    for (const [label, message] of Object.entries(restoreRecovery))
      this.db
        .prepare(
          "UPDATE operations SET status='recovery-needed',message=? WHERE status='running' AND label=?",
        )
        .run(message, label);
    this.db
      .prepare(
        "UPDATE operations SET status='recovery-needed',message='The app stopped during this operation. Inspect and restore the saved Windows snapshot.' WHERE status='running'",
      )
      .run();
    this.db
      .prepare(
        "UPDATE boost_sessions SET status='recovery-needed',message='The app stopped during a game boost. Frameforge restores the saved state on start; retry if needed.' WHERE status IN ('preparing','active','restoring')",
      )
      .run();
  }
  // Startup: an unfinished session from an older build may hold retired ids. Drop them (they can no longer be reverted by
  // a session) and say so once, since the Windows value they changed is not tracked any more.
  dropRetiredCaptures(): void {
    for (const row of this.db
      .prepare("SELECT id, payload FROM boost_sessions WHERE status!='ended'")
      .all()) {
      const { payload, dropped } = stripLegacyIds(
        JSON.parse(String(row.payload)) as Record<string, unknown>,
      );
      if (!dropped) continue;
      this.db
        .prepare("UPDATE boost_sessions SET payload=? WHERE id=?")
        .run(JSON.stringify(payload), String(row.id));
      this.log(
        "Game booster",
        "An unfinished session from an older build had changed a GPU preference or fullscreen optimization value. Frameforge no longer tracks those; check Windows Graphics settings or the game's compatibility settings if the game behaves differently.",
        "failed",
      );
    }
  }
  boostSession(): BoostSession | null {
    return this.boostRecord()?.session ?? null;
  }
  // The latest unfinished session plus the prior states captured before each change.
  boostRecord(): { session: BoostSession; captured: Captured[] } | null {
    const row = this.db
      .prepare(
        "SELECT * FROM boost_sessions WHERE status!='ended' ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get();
    if (!row) return null;
    const payload = stripLegacyIds(
      JSON.parse(String(row.payload)) as Record<string, unknown>,
    ).payload;
    // Task 1 rows stored only the target, whose priority was raised to Above normal.
    const legacy = "pid" in payload;
    const { captured = [], ...rest } = legacy ? { target: payload } : payload;
    const session = BoostSessionSchema.parse({
      ...rest,
      id: row.id,
      gameId: row.game_id,
      startedAt: row.started_at,
      status: row.status,
      message: row.message,
    });
    return {
      session,
      captured: legacy
        ? [
            {
              mechanism: "priority",
              process: session.target,
              prior: session.target.priority,
              applied: "AboveNormal",
            },
          ]
        : CapturedSchema.array().parse(captured),
    };
  }
  /** Ended sessions (newest first), for "This session changed" history. Rows that no longer parse are skipped. */
  endedBoostSessions(gameId?: string, limit = 20): BoostSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM boost_sessions WHERE status='ended'${gameId ? " AND game_id=?" : ""} ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...(gameId ? [gameId, limit] : [limit]));
    const out: BoostSession[] = [];
    for (const row of rows) {
      try {
        const payload = stripLegacyIds(
          JSON.parse(String(row.payload)) as Record<string, unknown>,
        ).payload;
        if ("pid" in payload) continue;
        const { captured: _captured, ...rest } = payload;
        void _captured;
        out.push(
          BoostSessionSchema.parse({
            ...rest,
            id: row.id,
            gameId: row.game_id,
            startedAt: row.started_at,
            status: row.status,
            message: row.message,
          }),
        );
      } catch {
        /* an old or damaged row is not history */
      }
    }
    return out;
  }
  /** The newest boost sessions for diagnostics: outcomes only, never the captured prior values. */
  boostSessions(limit: number): BoostSession[] {
    return this.db
      .prepare(
        "SELECT * FROM boost_sessions ORDER BY started_at DESC, rowid DESC LIMIT ?",
      )
      .all(limit)
      .flatMap((row) => {
        const { payload } = stripLegacyIds(
          JSON.parse(String(row.payload)) as Record<string, unknown>,
        );
        if ("pid" in payload) return [];
        const parsed = BoostSessionSchema.safeParse({
          ...payload,
          id: row.id,
          gameId: row.game_id,
          startedAt: row.started_at,
          status: row.status,
          message: row.message,
        });
        return parsed.success ? [parsed.data] : [];
      });
  }
  saveBoostSession(session: BoostSession, captured: Captured[]): void {
    const s = BoostSessionSchema.parse(session);
    const { id, gameId, startedAt, status, message, ...rest } = s;
    this.db
      .prepare(
        "INSERT INTO boost_sessions(id,game_id,status,started_at,message,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,message=excluded.message,payload=excluded.payload",
      )
      .run(
        id,
        gameId,
        status,
        startedAt,
        message,
        JSON.stringify({
          ...rest,
          captured: CapturedSchema.array().parse(captured),
        }),
      );
  }
  clearActivity(): void {
    this.db
      .prepare(
        "DELETE FROM operations WHERE rollback=0 AND status!='recovery-needed' AND status!='running'",
      )
      .run();
  }
  close(): void {
    this.db.close();
  }
}
