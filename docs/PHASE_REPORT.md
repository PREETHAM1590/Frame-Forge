# Phase Report

## Phase 1: Architecture and Scaffold

Created `package.json`, TypeScript/Vite/Tailwind configuration, `shared/contracts.ts`, `src/App.tsx`, shared UI and theme. Original Frameforge branding and local assets avoid dependencies on third-party application source or services. Ownership and intended phases are in `IMPLEMENTATION.md`.

## Phase 2: Read-Only Discovery

Added `windows/Frameforge.Windows/HardwareDiscovery.cs`, helper JSON contract and `electron/platform.ts`. The real helper has returned hardware information successfully. Individual WMI/driver fields may be unavailable; fallback values carry source/warnings. No synthetic telemetry is presented as real.

## Phase 3: Catalogue and Preview

Added `shared/catalogue.ts`, optimization views and `electron/operations.ts`. Preview snapshots values; confirmation expires after five minutes, is single-use and checks for external changes. Unsupported operations do not receive apply capabilities.

## Phase 4: Persistence and Recovery

Added `electron/migrations.ts`, `electron/repository.ts`, service, settings, activity and recovery views. SQLite persists configuration, backups and operation journals; restore creates a prior-state backup. Interrupted operations remain recoverable. Configuration backups are explicitly separate from Windows snapshots.

## Phase 5: Games and Profiles

Added `electron/games.ts` and game views. Steam metadata discovery, validated custom executable selection, game removal and saved profiles are implemented. Game Mode is app configuration only; it does not launch games or apply process/system changes.

## Phase 6: Windows Preferences

Added `RegistryOperations.cs`, orchestration, cancellation, verification and conflict-aware rollback for pointer acceleration and Game DVR capture preferences. Current-user registry values need no elevation. Writes have not been run against the development user's machine. Live mutation and interruption recovery should be evaluated on disposable Windows machines before distribution.

## Phase 7: Verification and Distribution

Added Vitest, React Testing Library, xUnit, browser workflow and desktop smoke tests, NSIS configuration and documentation. Final checks on October 12, 2026:

- `npm test`: 23 tests passed across five suites, including UI, IPC, persistence, backup/restore, cancellation, rollback, logging failures and recovery-record retention.
- Local SDK `dotnet test`: six xUnit tests passed against an in-memory registry; no live Windows preference writes.
- `npm run test:e2e` with `PLAYWRIGHT_BASE_URL=http://127.0.0.1:5174`: two browser workflows passed. Desktop and mobile screenshots inspected; navigation across all pages has no horizontal overflow.
- `npm run test:desktop`: passed against both development Electron and the packaged executable. Real Windows discovery, context isolation, sandbox, renderer Node denial and malformed request rejection verified.
- Type checking, ESLint, Prettier check, renderer build, preload/main build and self-contained .NET publish passed.
- `npm audit`: zero reported vulnerabilities. The packaging downloader uses a patched dependency override.
- `npx electron-builder --win nsis`: completed and produced `release/Frameforge Setup 0.1.0.exe` plus a block map. Packaging reuses the installed Electron distribution to avoid a Windows staging rename failure.

Available commands include `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run windows:test`, `npm run build`, `npm run test:e2e`, `npm run test:desktop`, `npm run windows:publish` and `npm run package:win`. Screenshots are in `artifacts/`. Browser preview remains on port 5174.

Remaining distribution validation: exercise installer install/uninstall and live registry apply/interruption/recovery on a disposable Windows machine. No installation, system-preference mutation, FPS or latency measurement was performed on this user's PC. Authenticode reports `NotSigned` for the installer; signing and update delivery remain outside this development build.

## Phase 8: Booster, restore points and game detection (2026-10)

Branch `feature/booster-restore-detection`, head 404714f. This phase merged four task branches: Windows restore points (Task 2), full game detection (Task 3), the real Game Booster (Task 4) and the missing-features sweep (Task 5), with the power-plan handling consolidated at the Task 4 merge. Per-task reports are in `.superpowers/sdd/2026-10-13-booster-restore-detection/`.

### Gate results (this session, on 404714f plus the documentation edits)

| Command                | Result                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`    | No errors (renderer and Electron configs)                                                                                                                                               |
| `npm run lint`         | No problems                                                                                                                                                                             |
| `npm run format:check` | All matched files use Prettier code style                                                                                                                                               |
| `npm test`             | Test Files 11 passed (11); Tests 119 passed (119)                                                                                                                                       |
| `npm run build`        | Build completed (`dist-electron\electron\preload.cjs` written)                                                                                                                          |
| `npm run windows:test` | Passed: 69 of 69 xUnit tests (the helper is built first)                                                                                                                                |
| `npm run test:desktop` | Electron smoke passed: real Windows discovery, sandboxed preload, no renderer Node, invalid request rejected. Run with the isolated temporary profile; the real profile was not opened. |

Not run in this phase: `npm run test:e2e` (not run since the merges), `npm run package:win` and `npm run windows:publish` (the helper was published during the task branches; the installer was not rebuilt, so the installer is the 2026-10-12 build). `npm run windows:publish` is needed before `npm run package:win` because the installer ships `windows/publish`.

### What was verified on this PC

- **Restore points, unelevated only:** `restore-status` returned System Protection enabled for C:, no policy block, frequency `{existed: true, minutes: 0}`, not elevated. The elevated child, run directly without UAC, returned its expected admin-required failure for the list action. Create, enable and override were never run for real. Frequency is 0 here, so the 24-hour throttle cannot be reproduced.
- **Game detection, real:** Steam (The Outlast Trials), Xbox app (Roblox), Riot (VALORANT), Microsoft Store (Roblox, de-duplicated against Xbox), Uninstall registry export (read only), and folder scans of `D:\Riot Games` and `D:\XboxGames`. Epic, GOG, EA, Ubisoft, Battle.net, Rockstar and itch.io were not installed here and were not checked against real installs.
- **Booster, real helper, test processes only** (`ffgame.exe` and `ffbg.exe` copies of `ping.exe`, named uniquely and killed afterwards): priority, affinity, timer request, suspend and resume, revert on Stop, revert on game exit, self-revert after a hard kill of the app (helper runs detached), `boost-recover`, and auto-start. Verified through the built app service and the real helper.
- **Frameforge High performance plan, real:** created, applied during a session, reverted to the prior plan, and deleted. The active plan was unchanged at the end. The GameBar values were already on and were not written.
- **Power plan switch to a built-in plan and the persistent power optimization:** this PC has no High performance or Ultimate plan, so these were verified with fakes only.

### Manual checks performed

- Restore points: the unelevated status read and the unelevated helper rejections (unknown action, invalid description) only.
- Booster: the helper and service checks listed above. No GUI session with a real game.
- Settings and optimization previews: the isolated Electron click-through of all nine pages from the Task 5 review, with no page errors.

### Manual verification still required

These have not been performed by a person on this PC. They are required before the features are described as verified:

1. Create a restore point through the UAC prompt (`Recovery` page, "Create restore point"), accept UAC, and confirm the point appears in `rstrui.exe`.
2. Enable System Protection for C: from the app, and confirm Windows reports it on in System Protection settings.
3. Use "Create anyway" after a throttled attempt and confirm the original frequency value is restored (`reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore" /v SystemRestorePointCreationFrequency`).
4. Decline the UAC prompt and confirm the app reports cancellation and that no restore point, protection change or frequency change occurred.
5. Boost a real game (not a test process) in Performance or Competitive, watch its priority in Task Manager, and confirm it is restored after exit or Stop.
6. Switch to the Frameforge High performance plan (or a built-in High performance plan) on a PC that has one, confirm the switch and the return to the prior plan.
7. Install and uninstall the packaged installer after rebuilding it from this branch.

### Known limitations

- The elevated restore-point path (create, enable, override, list) and `runas` have not been run on real hardware by a person. Its per-drive System Protection check depends on an admin-only record whose format is unverified; if it cannot be read, C: is reported as unconfirmed.
- The 24-hour throttle is not reproducible on the development PC (frequency is 0).
- Affinity is a single 64-bit mask and covers processor group 0 only.
- Captures are saved on arrival, not acknowledged by the helper first. If the app and helper both die in the window between the change and the save, that one change has no saved prior value.
- A session is capped at 200 captures; further matching background processes are skipped with a message.
- Closed apps are not reopened, and the close action cannot be reverted.
- Timer resolution is unsupported on Windows 10 builds 19041 to 21999 even if the flag is set, and on Windows 11 without `GlobalTimerResolutionRequests` = 1.
- Game removal is refused during an active session; the session is not stopped automatically.
- The library holds at most 500 games; each source is capped at 500 entries; drives C: to Z: are probed with a 1.5 s timeout each.
- Game paths that no longer exist are dropped during detection without a per-source warning.
- The Dashboard does not show the booster mode.
- The booster recovery banner can point to a row that has no button; "Restore & backups" has the working recovery action for restore-point rows.
- WMI error detail is not surfaced to the user; a fixed message is shown.
- The app's exit path for an invalid `FRAMEFORGE_USER_DATA` (exit code 1) was not run live. The validation is unit-tested.
- Epic, GOG, EA, Ubisoft, Battle.net, Rockstar and itch.io detection were checked with fixtures or synthetic data only.
- Physical-PC behaviour of Game Mode writes is untested: on this PC the values are already on.
- `docs/SECURITY.md` does not yet describe the booster's session helper lifetime and revert guarantees, or the process denylist. It does cover the asInvoker application, the per-action UAC restore-point elevation, and the registry export and PowerShell calls used for detection.
- `npm run test:e2e` has not been run since the merges.
- The installer has not been rebuilt for this branch, and install and uninstall are untested. It is unsigned.
