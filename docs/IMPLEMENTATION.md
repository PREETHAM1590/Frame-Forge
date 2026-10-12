# Frameforge implementation plan

Original local Windows gaming utility. Core features work offline. System changes require a validated preview and explicit in-app confirmation. No performance claims or remote telemetry.

## Ownership and invariants

- `shared/`: Zod request/response contracts, domain models, operation catalogue.
- `src/`: React views, Radix accessible controls, Tailwind theme, browser development adapter explicitly labeled demo.
- `electron/`: trusted sender validation, bounded IPC, SQLite typed repository/migrations, durable operation journal, fixed helper invocation, backup/restore.
- `windows/`: .NET JSON-line helper, read-only discovery and allowlisted current-user registry changes. No renderer-supplied commands.
- `tests/`: boundary validation, repository transactions, backups, preview expiry, cancellation, snapshot/rollback and UI workflows.

## Phases

1. Scaffold strict TypeScript, build/lint/test tools and original navigation/theme.
2. Read Windows hardware through a fixed helper; unavailable values stay unavailable.
3. Catalogue/details/search/risk and server-owned previews.
4. Persist settings, games, presets, backups and operation history transactionally in SQLite.
5. Game detection, custom executable picker and app-only per-game profiles; Game Mode does not launch or alter games.
6. Two current-user operations: pointer acceleration and Game DVR capture preference. Snapshot all registry values including absent values, journal before writes, verify and support conflict-aware rollback. Recovery remains visible after interruption.
7. Run frontend/IPC/persistence/.NET tests, security checks, browser/Electron smoke tests, packaging and documentation.

## Design

Charcoal workspace, lime active actions, cyan hardware data, amber warnings. Compact navigation and full-width working surfaces. Space Grotesk locally bundled; no remote assets required. Radix dialogs and switches, Lucide icons, reduced motion, responsive layout.

## Tooling found

Repository empty; Node 26.3.0 and npm installed. .NET SDK absent from PATH at inspection; obtain an official local SDK if possible. SQLite uses the native `node:sqlite` API supported by Node 22.13+ and Electron 41's Node runtime, avoiding a native-addon ABI dependency.
