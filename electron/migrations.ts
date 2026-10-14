import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
type Json = Record<string, unknown>;
// v1 stored custom games with `path` set to the executable. Library dedupe and the
// booster match on the install folder, so move the exe to `executablePath`.
function moveExecutablePaths(payload: string): string {
  const state = JSON.parse(payload) as Json;
  if (!Array.isArray(state.games)) return payload;
  state.games = state.games.map((game: Json) =>
    typeof game.path === "string" && /\.exe$/i.test(game.path)
      ? {
          ...game,
          executablePath: game.path,
          path: path.win32.dirname(game.path),
        }
      : game,
  );
  return JSON.stringify(state);
}
// GPU preference and fullscreen optimizations moved from session mechanisms to per-game launch settings.
function dropLegacyMechanisms(payload: string): string {
  const state = JSON.parse(payload) as Json;
  const custom = (state.booster as Json | undefined)?.custom as
    Json | undefined;
  if (!custom) return payload;
  delete custom.gpuPreference;
  delete custom.fullscreenOptimizations;
  return JSON.stringify(state);
}
export const migrations: Array<string | ((db: DatabaseSync) => void)> = [
  `
CREATE TABLE configuration (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
CREATE TABLE backups (id TEXT PRIMARY KEY, name TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE operations (id TEXT PRIMARY KEY, label TEXT NOT NULL, at TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, ids TEXT NOT NULL, snapshot TEXT, backup_id TEXT, rollback INTEGER NOT NULL DEFAULT 0);
CREATE INDEX operations_at ON operations(at DESC);
`,
  (db) => {
    db.exec(
      "CREATE TABLE boost_sessions (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, message TEXT NOT NULL, payload TEXT NOT NULL);",
    );
    for (const table of ["configuration", "backups"])
      for (const row of db
        .prepare(`SELECT rowid AS rid, payload FROM ${table}`)
        .all())
        db.prepare(`UPDATE ${table} SET payload=? WHERE rowid=?`).run(
          moveExecutablePaths(String(row.payload)),
          row.rid as number,
        );
  },
  "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  (db) => {
    for (const table of ["configuration", "backups"])
      for (const row of db
        .prepare(`SELECT rowid AS rid, payload FROM ${table}`)
        .all())
        db.prepare(`UPDATE ${table} SET payload=? WHERE rowid=?`).run(
          dropLegacyMechanisms(String(row.payload)),
          row.rid as number,
        );
  },
  // v1.3 removes three non-applicable review ids. Keep every real setting in configuration and backups.
  (db) => {
    const removed = new Set(["startup-review", "driver-review", "dns-tuning"]);
    for (const table of ["configuration", "backups"])
      for (const row of db
        .prepare(`SELECT rowid AS rid, payload FROM ${table}`)
        .all()) {
        const state = JSON.parse(String(row.payload)) as Json;
        if (!Array.isArray(state.presets)) continue;
        state.presets = state.presets
          .map((preset: Json) => ({
            ...preset,
            ids: Array.isArray(preset.ids)
              ? preset.ids.filter((id) => !removed.has(String(id)))
              : preset.ids,
          }))
          .filter(
            (preset: Json) =>
              !Array.isArray(preset.ids) || preset.ids.length > 0,
          );
        db.prepare(`UPDATE ${table} SET payload=? WHERE rowid=?`).run(
          JSON.stringify(state),
          row.rid as number,
        );
      }
  },
];
