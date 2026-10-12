export const migrations = [
  `
CREATE TABLE configuration (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
CREATE TABLE backups (id TEXT PRIMARY KEY, name TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE operations (id TEXT PRIMARY KEY, label TEXT NOT NULL, at TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, ids TEXT NOT NULL, snapshot TEXT, backup_id TEXT, rollback INTEGER NOT NULL DEFAULT 0);
CREATE INDEX operations_at ON operations(at DESC);
`,
];
