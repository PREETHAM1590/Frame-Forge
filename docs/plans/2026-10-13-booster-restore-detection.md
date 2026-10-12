# Plan: Frameforge build repair, restore points, game detection, booster

Date: 2026-10-13. Branch: `feature/booster-restore-detection` (base: the `main` baseline commit).
Repo: `D:\Hone` (app name "Frameforge"). Stack: Electron 41 (ESM main, preload bundled to cjs), React 19 + Vite 7, zod 4 contracts in `shared/contracts.ts`, `node:sqlite`, .NET 8 helper `windows/Frameforge.Windows` (one JSON line on stdin, one on stdout).

Each task stands alone. Read **Global Constraints** first, then only your task. Every task lists the constraints it depends on.

---

## Research notes (game-mode mechanisms, own summary)

Source: hone.gg research article on game mode. These notes are paraphrased; nothing is copied.

- Uses selectable profiles: a mild one, an aggressive one, and a custom one where each action is chosen separately.
- Raises the game's CPU priority and lowers the priority of background apps. This only helps when there is CPU contention.
- Suspends chosen background processes during play and resumes them afterwards. Closing processes is used only in the aggressive profile.
- Stops chosen services temporarily and restores their prior running state. Startup type is never changed.
- Confines background apps to some cores (E-cores on hybrid CPUs) through CPU sets/affinity. Optional per-game core limits (skip core 0, second CCD, SMT) can hurt some games.
- Lowers the GPU scheduling priority of background apps.
- Switches to a performance power plan for the session and restores the previous plan afterwards. Can also unpark all cores.
- Requests a finer system timer while a game runs. The effect depends on the game, and it costs power.
- Explicitly asks Windows for a high-performance QoS level for the game.
- Optionally reduces desktop visual effects.
- Keeps a protected exclusion list (anti-cheat, security, audio, capture software) and rescans every few seconds to apply rules to newly started processes.
- Its published gains come from the vendor's own combined tests, so no single mechanism's contribution is isolated. Windows Game Mode itself and memory/standby trimming are not described.
- **Takeaways for us:** every mechanism needs a captured prior state and an automatic revert. Keep a hard exclusion list. Make no gain claims without our own measurement.

---

## Global Constraints

Tasks reference these as **GC-n**.

- **GC-1 Toolchain.** `dotnet` is not on PATH. In Git Bash use `export PATH="/d/Hone/.tools/dotnet:$PATH"` before any `npm run windows:*`. In PowerShell use `$env:PATH = "D:\Hone\.tools\dotnet;$env:PATH"`. Node 26 is installed and `node:sqlite` is used.
- **GC-2 Helper rebuild.** After **every** C# change, run `npm run windows:publish`. `windows/publish/` is gitignored, and a stale exe answers "Unsupported helper request". Electron dev loads `windows/publish/Frameforge.Windows.exe`.
- **GC-3 Dual schema.** Every new helper request field must be added to the C# `Request` record in `Program.cs`, which uses `UnmappedMemberHandling.Disallow`. Every new response field must be added to the strict zod `HelperResult` in `shared/contracts.ts`. Every new IPC method needs:
  - a `requests` entry and a `responses` entry (zod, `.strict()`) in `shared/contracts.ts`;
  - a handler in `electron/service.ts` (the `Handlers` mapped type forces one per method);
  - a case in the browser demo `src/api.ts`. The demo either returns an honest "desktop only" result or throws a clear error. It never fakes success.
- **GC-4 Persisted data compatibility.** `StateSchema` is `.strict()` and is embedded in `BackupSchema`. Existing rows in `configuration` and `backups` must keep parsing.
  - Adding enum values is safe.
  - Adding fields is safe only with `.default(...)`.
  - Renaming or removing enum values or fields requires a migration in `electron/migrations.ts` that rewrites the JSON in **both** tables.
  - Add a test that loads a v1 payload: `{version:1, settings, games:[{...profile:"gaming"}], presets:[], gameMode:{gameId:null,active:false}}`.
- **GC-5 No shell, no string commands.** Helpers and tools are spawned with `shell:false` and argument arrays only.
  - Renderer text never becomes a command, a registry path or a GUID. It may only select from server-side allowlists.
  - Elevation only through GC-7.
  - `electron-builder` keeps the default `asInvoker`. Never add `requestedExecutionLevel: requireAdministrator`.
- **GC-6 No fake success.** A result reports success only after the helper re-reads the changed state and confirms it.
  - Unsupported or unverifiable mechanisms are labelled `unsupported` with a reason, in the UI and in `docs/FEATURE_STATUS.md`.
  - Buttons for unavailable actions are disabled and show the reason. A clickable no-op is not acceptable.
  - Never claim FPS or latency gains.
- **GC-7 Elevation protocol.** Admin is needed for restore points and System Protection.
  - The Node side calls the normal (unelevated) helper with `{command:"elevated", action, ...args}`.
  - If the helper is already elevated (`WindowsPrincipal.IsInRole(Administrator)`), it runs the action inline.
  - Otherwise it pre-creates an empty result file `%TEMP%\frameforge-<32 hex>.json`. It then starts **itself** with `ProcessStartInfo { UseShellExecute = true, Verb = "runas", FileName = Environment.ProcessPath }` and `ArgumentList = ["--elevated", action, resultPath, ...validated args]`. There is no `Arguments` string concatenation.
  - The elevated instance does the following:
    1. Accepts only allowlisted actions.
    2. Validates every argument with a strict regex. Restore-point descriptions must match `^[\p{L}\p{N} ._()\-]{1,64}$`. Numbers are parsed with `int.TryParse`.
    3. Requires the result path to be absolute, local, named exactly `frameforge-[0-9a-f]{32}.json`, existing, empty, and not a reparse point.
    4. Writes one JSON object to that file and exits.
  - The unelevated helper waits with a timeout, then reads, validates and deletes the file.
  - A declined UAC prompt raises `Win32Exception` with `NativeErrorCode == 1223`. Map it to `code:"elevation-cancelled"`. This is a normal outcome, not a crash.
- **GC-8 Per-command timeouts.** `WindowsPlatform.call(request, signal?, timeoutMs = 20000)` takes a timeout parameter. Elevated calls use 180000 ms, because UAC plus restore-point creation can take minutes. Process scans use 10000 ms.
- **GC-9 Structured errors.** Helper failures return `{ok:false, code, message}` with a stable `code` (kebab-case). Expected outcomes (throttled, cancelled, protection-disabled, unsupported) are returned as **data** in the response so the UI can branch. Only unexpected failures throw. Every user-visible Windows change writes an activity entry through `repo.log(...)` or the operations journal.
- **GC-10 Recovery.** Before any persistent Windows change, persist the prior state in SQLite. Persistent changes include the power plan, HKCU/HKLM values, process priority, affinity and suspension.
  - On startup, extend `Repository.recoverInterrupted()` and call the engine-level `recover()`. It reverts state that is still applied, after a pid + start-time + current-value check, and marks failures `recovery-needed` with a visible retry.
  - External changes made since then are preserved, never overwritten. Follow the conflict pattern in `RegistryOperations.Restore` and `GameProcesses.Stop`.
- **GC-11 Process safety.** Background-process actions never touch any of these:
  - processes in session 0 or owned by another user;
  - critical processes (`IsProcessCritical`);
  - a hard denylist (case-insensitive image names): `system, registry, smss, csrss, wininit, winlogon, services, lsass, lsaiso, svchost, fontdrvhost, dwm, explorer, sihost, ctfmon, audiodg, spoolsv, searchhost, startmenuexperiencehost, shellexperiencehost, textinputhost, runtimebroker, msmpeng, nissrv, securityhealthservice, securityhealthsystray, smartscreen, easyanticheat, easyanticheat_eos, beservice, vgc, vgtray, faceit, faceitclient, esportal, gameguard, xigncode, nvcontainer, nvdisplay.container, amdrsserv, atiesrxx, atieclxx`;
  - the game itself, Frameforge, and the helper.

  The denylist lives in C#, which is the enforcement point, and is mirrored in a zod refine for UX. Process identity is always pid + start time (UTC "O") + resolved image path.
- **GC-12 Acceptance gate for every task.** All of these must pass:

  ```bash
  cd /d/Hone && export PATH="/d/Hone/.tools/dotnet:$PATH"
  npm run typecheck && npm run lint && npm test && npm run build
  npm run windows:build && npm run windows:test && npm run windows:publish
  npm run format:check
  ```

  Then commit with a conventional message whose last lines are a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Tasks that touch real Windows state also list a manual check in `npm run dev:desktop`.
- **GC-13 Style.** Follow the existing patterns: zod-validated boundaries, `repo.transaction`, `Platform` interface plus `MockPlatform` for tests, and C# interfaces (`IRegistryStore`, `IProcessStore`) with in-memory fakes in xUnit. Use no new npm or NuGet dependencies, except a Windows TFM bump if strictly needed (it should not be). Keep the file count low.

---

## Task 1: Repair the build (finish the half-done refactor)

**Depends on:** GC-1, GC-2, GC-3, GC-12, GC-13.

**Current failures** (as of 2026-10-13):
- `npm run typecheck` fails, so `npm run build` fails.
- `npm test` fails in 3 files.
- `lint` and both dotnet commands pass.

### 1a. Steam detection (`electron/games.ts`, `tests/games.test.ts`)

There are two root causes, and the second one affects real users.

1. `@node-steam/vdf` throws `Open parentheses somewhere` on **single-line** VDF, which is what the test fixtures write.
2. The library converts numeric-looking strings to numbers. Parsing a real manifest yields `{"appid":100,...,"StateFlags":4}`. The zod field `StateFlags: z.string().regex(...)` then rejects it, and the error is silently counted in `skippedSteam`. **The real in-app Steam scan therefore finds 0 games today.** Numeric game names and install directories (for example `"1943"`) also fail.

Fix:
- In the Steam zod shapes, use `const vdfString = z.union([z.string(), z.number()]).transform(String)` for `name`, `installdir`, `StateFlags` and library `path`. Re-apply the existing `gameName` and installdir validators after the transform.
- Rewrite the fixtures in `tests/games.test.ts` as real multi-line VDF (tabs and newlines, with `appid` and `StateFlags` lines like real files).
- Add a test with a numeric `name` (`"1943"`).
- Add a test asserting that a malformed manifest increments the skipped warning.

Manual check: this PC has `C:\Program Files (x86)\Steam\steamapps\appmanifest_1304930.acf`. Run `node -e` against `detectInstalledGames()` (via `npx tsx` or the built `dist-electron`) and confirm the game is returned.

### 1b. Detection wiring

- `electron/service.ts`: change `DesktopServices.detectGames` to `() => Promise<DetectionResult>` (import the type from `./games.js`). The `detectGames` handler does the following:
  1. merges `result.games` into state, deduped by lower-cased `path` (unchanged logic);
  2. returns `{games: result.games, warnings: result.warnings, launchers: result.launchers}`;
  3. logs `"Installed game scan completed"` with the message `"<added> new of <found> found. Scanned: <launchers>."`.

  Remove the hard-coded "Steam" wording.
- `electron/main.ts`: pass `detectGames: () => detectInstalledGames()` and delete the `detectSteamGames` import. Delete `detectSteamGames` from `games.ts`, since nothing else uses it.
- `main.ts pickGame`: set `executablePath: selected` (the picked exe) and `path: path.dirname(selected)`. The library dedupe and the booster match on the install folder, and today `path` is the exe.
- `tests/service.test.ts`: change the mocks to `detectGames: async () => ({games:[],warnings:[],launchers:[]})`.

### 1c. Booster backend, minimal (exactly the API that `tests/booster.test.ts` already fixes)

- `electron/migrations.ts`: append migration #2:

  ```sql
  CREATE TABLE boost_sessions (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, message TEXT NOT NULL, payload TEXT NOT NULL);
  ```

  `payload` holds the JSON of the session target (Task 4 extends it to a full snapshot).
- `electron/repository.ts`:
  - `boostSession(): BoostSession | null` returns the latest row whose status is not `ended`, parsed with `BoostSessionSchema`.
  - `saveBoostSession(s: BoostSession)` upserts.
  - `recoverInterrupted()` also marks `preparing`, `active` and `restoring` sessions as `recovery-needed`.
- `electron/platform.ts`, `Platform` interface:
  - `boostAvailable: boolean`
  - `gameProcesses(game: Game): Promise<ProcessTarget[]>`
  - `boostStart(expected: ProcessTarget): Promise<ProcessTarget>`
  - `boostStop(snapshot: ProcessTarget): Promise<string>`

  `WindowsPlatform` implements these with helper commands `processes {gamePath, executablePath}`, `boost-start {target}` and `boost-stop {target}`, and sets `boostAvailable = true`. `MockPlatform` has `boostAvailable = false`, returns `[]` from `gameProcesses`, and throws "unavailable" from start and stop. The test subclasses override them.
- New file `electron/booster.ts`: `export class BoostEngine { constructor(repo, platform) }`.
  - `start(gameId, target)`:
    1. Fails if the game is not in state.
    2. Requires `target` to deep-equal one of `await platform.gameProcesses(game)`; otherwise it throws `/running|target/i`.
    3. Throws a message containing `Normal` if `target.priority !== "Normal"`.
    4. Persists the session with status `preparing` **before** calling `platform.boostStart`.
    5. On success, sets the status to `active`.
    6. On a thrown error, tries `platform.boostStop(target)`. If that succeeds the status becomes `ended`; if it fails the status becomes `recovery-needed`, and the session is returned rather than thrown. (The test expects `recovery-needed` together with a failing stop.)
  - `stop()`: does nothing if there is no session. Otherwise it sets status `restoring`, calls `boostStop`, and ends with `ended` (returned), or `recovery-needed` on error.
  - `isBusy` getter.
- `windows/Frameforge.Windows/Program.cs`: add `GamePath`, `ExecutablePath` and `Target` (`ProcessTarget?`) to `Request`, and dispatch:
  - `processes` → `WindowsProcessStore.Find(...)`;
  - `boost-start` and `boost-stop` → `new GameProcessOperations(new WindowsProcessStore()).Start/Stop`.

  Map `ProcessResult` to `{ok, message, code, boostSnapshot}`. `GameProcesses.cs` already exists and has no callers.
- Add xUnit tests `windows/Frameforge.Windows.Tests/GameProcessesTests.cs` with an in-memory `IProcessStore` fake:
  - start → verify → stop;
  - process exited;
  - priority conflict;
  - identity mismatch.
- `electron/service.ts`: construct `BoostEngine` and add handlers for `boostTargets`, `boostStart` and `boostStop`. `bootstrap()` adds `boost: {session: repo.boostSession(), available: platform.boostAvailable}`. `isBusy` also includes `booster.isBusy`.

### 1d. Restore-point methods (honest placeholders until Task 2)

The `restorePoints` and `createRestorePoint` handlers return `{points:[], available:false, createdSequence:null, message:"Windows restore points are not available in this build yet."}`. No UI button is added in Task 1. `src/api.ts` adds the same for `createRestorePoint`.

### 1e. Renderer

- `src/views/Games.tsx`: delete the local `GameMode` function (old lines 190–279). Keep `export { GameMode } from "./GameBooster";`.
- New file `src/views/GameBooster.tsx`: `export function GameMode(props: ViewProps)`, a minimal real UI on the existing contract:
  - choose a library game;
  - "Find running process" calls `boostTargets` and lists the targets;
  - "Raise priority" calls `boostStart {gameId, target, confirmed:true}`;
  - an active session card has a "Restore priority" button that calls `boostStop`;
  - shows `data.boost.session` status and message;
  - is disabled with a reason when `!data.boost.available` (demo, or helper missing).

  Import `Play`, `Square` and the other icons from `lucide-react`. Task 4 rewrites this page.
- `src/api.ts` demo: `boostTargets`, `boostStart` and `boostStop` throw "Game booster requires the desktop app."

### 1f. Formatting

Run `npm run format` once, as a separate commit `style: apply prettier`, so that `format:check` is part of the gate from now on.

**Tests:** fix the existing `booster.test.ts` (it must pass unchanged, except for import extensions if lint requires them), `games.test.ts` and `service.test.ts`. Add the GC-4 v1-payload test to `tests/repository.test.ts`.

**Acceptance:** GC-12. In addition:
- in `npm run dev:desktop`, Scan finds the Steam game above;
- the Game Mode page opens without errors;
- with a running game, the priority is visible in Task Manager as Above normal and returns to Normal after Stop.

---

## Task 2: Real Windows System Restore points

**Depends on:** GC-1, GC-2, GC-3, GC-5, GC-6, GC-7, GC-8, GC-9, GC-10, GC-12.

### Helper (new file `windows/Frameforge.Windows/RestorePoints.cs`, dispatched from `Program.cs`)

Put the logic behind `IRestoreStore` (WMI and registry access) so xUnit can fake it.

**Unelevated command `restore-status`** (read-only, HKLM read is allowed for standard users):
- `policyDisabled`: `HKLM\SOFTWARE\Policies\Microsoft\Windows NT\SystemRestore` values `DisableSR == 1` or `DisableConfig == 1`.
- `protection`: `"enabled" | "disabled" | "unknown"`, from `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore\RPSessionInterval` (1 means enabled on at least one drive; 0 means disabled; missing means unknown). This is a hint only, and the UI says "per-drive state is confirmed when creating".
- `frequency`: `{existed: bool, minutes: int|null}` from the same key, value `SystemRestorePointCreationFrequency` (DWORD minutes; absent means the Windows default of 1440).
- `elevated`: whether the current process is admin.
- `systemDrive`: `Environment.GetEnvironmentVariable("SystemDrive")`, validated with `^[A-Z]:$`.

**Elevated actions** (via GC-7):
- `restore-list`: WMI `root\default`, `SELECT SequenceNumber, Description, CreationTime, RestorePointType FROM SystemRestore`. Convert `CreationTime` (CIM datetime) with `ManagementDateTimeConverter.ToDateTime(...).ToUniversalTime().ToString("O")`. Return points sorted by sequence, newest first.
- `restore-create <description> <bypass:0|1> <origExisted:0|1> <origMinutes:int|-1>`:
  1. If the policy disables System Restore, return `outcome:"policy-disabled"`.
  2. `before = max(SequenceNumber)` (0 if none).
  3. If `bypass == 1`: write `SystemRestorePointCreationFrequency = 0` (DWORD) under HKLM, then do steps 4–5 in `try`. In `finally`, restore the original value: delete it if `origExisted == 0`, otherwise write `origMinutes`. Re-read it and set `frequencyRestored: bool`.
  4. `ManagementClass("\\\\.\\root\\default:SystemRestore").InvokeMethod("CreateRestorePoint", [description, 12 /*MODIFY_SETTINGS*/, 100 /*BEGIN_SYSTEM_CHANGE*/])`. Run it on a Task and wait up to 150 s; on timeout return `code:"restore-timeout"`.
  5. Map the return value:
     - `0` → continue to step 6;
     - `1058` (`ERROR_SERVICE_DISABLED`) or `0x80070422` → `outcome:"protection-disabled"`;
     - anything else → `code:"restore-failed"` with the number in the message.
  6. `after = max(SequenceNumber)`.
     - If `after > before`, return `outcome:"created"`, `createdSequence: after` and the new point.
     - Otherwise return `outcome:"throttled"` and `lastPoint` (the newest point). Windows silently skips creation when a point exists within the frequency window, so a WMI return of 0 is **not** success.
- `restore-enable <drive>`: validate `drive == systemDrive`, run `SystemRestore.Enable(drive + "\\")` in WMI, check the return value is 0, then re-run status. Return the new status.
- `restore-frequency-set <existed:0|1> <minutes>`: recovery-only action that writes or deletes the value and re-reads it. Used when a bypass was interrupted.

### Contracts (`shared/contracts.ts`)

`RestoreDescription = z.string().trim().regex(/^[\p{L}\p{N} ._()\-]{1,64}$/u)`

| Method | Request | Response |
|---|---|---|
| `restoreStatus` (new) | `Empty` | `RestoreStatusSchema {protection, policyDisabled, frequency:{existed, minutes}, elevated, systemDrive, lastAppCreatedAt: string\|null, pendingFrequencyRecovery: boolean, message}` |
| `restorePoints` | `Empty` | existing `RestorePointsSchema` (elevated list; `available:false` plus a message on cancel or policy) |
| `createRestorePoint` | `{name: RestoreDescription, confirmed: true, bypassThrottle: z.boolean().default(false)}` | `CreateRestorePointResultSchema {outcome: enum["created","throttled","protection-disabled","policy-disabled","elevation-cancelled","failed"], point: RestorePointSchema.nullable(), lastPoint: RestorePointSchema.nullable(), message}` |
| `enableSystemProtection` (new) | `{confirmed: true}` | `RestoreStatusSchema` |
| `recoverRestoreFrequency` (new) | `{confirmed: true}` | `RestoreStatusSchema` |
| `openSystemRestore` (new) | `Empty` | `z.boolean()` |

Notes on the table:
- `pendingFrequencyRecovery` is true when a bypass journal row is still `running` (see Electron below).
- `openSystemRestore` lets users actually restore. Main calls `shell.openPath(path.join(SystemRoot, "System32", "rstrui.exe"))`. ShellExecute handles its auto-elevation, and there is no renderer input.

`HelperResult` gains optional fields: `restoreStatus`, `outcome`, `point`, `lastPoint`, `frequencyRestored`.

### Electron

- `platform.ts`: add `restoreStatus()`, `restoreList()`, `restoreCreate(name, bypass, original)`, `restoreEnable(drive)` and `restoreFrequencySet(orig)`. Elevated calls use a 180000 ms timeout (GC-8). `MockPlatform` returns `protection:"unknown"` and `available:false` with an honest message.
- New file `electron/restore.ts`: `RestorePointService(repo, platform)`. In `create(name, bypass)`:
  1. Read `restoreStatus` first.
  2. If `bypass`, log a journal row in `operations`: label `"Restore point throttle override"`, status `running`, `snapshot = {frequency}` (the original value, read unelevated **before** the elevated call). Call `restoreCreate` with the original value.
  3. Afterwards, re-read the status. If the frequency equals the original, finish the row as `success`; otherwise mark it `recovery-needed`.
  4. Always `repo.log` the outcome:
     - `"Windows restore point created"` (success);
     - `"Restore point skipped: Windows 24-hour limit"` (`cancelled`);
     - `"System Protection is off"` (`failed`);
     - and so on.

  Store `lastAppCreatedAt` in a new key, `restore_meta` (migration #3: `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`). It is used to pre-warn about the 24 h limit before a UAC prompt.
- `service.ts`: add the handlers. `createRestorePoint` with `bypassThrottle:true` is only accepted when the request also comes after a `throttled` outcome in the same session. Keep `lastThrottledAt` in memory and reject with "Retry the normal creation first" otherwise. This keeps the bypass to explicit consent after an explanation.

### UI (`src/views/Recovery.tsx`, `Backups` page "Restore & backups")

Split the page into two clearly titled sections.

1. **"Windows System Restore (whole-PC recovery)"**
   - Status chip for protection and policy.
   - "Create restore point" opens a name dialog. The default name is `Frameforge <yyyy-mm-dd>`, and the dialog says a Windows admin prompt will appear.
   - Result handling:
     - `throttled`: show the explanation ("Windows allows one app-created restore point every 24 hours by default; the last one was at X"). Offer a secondary danger button, "Create anyway (temporarily lifts the limit, then restores it)", which sends `bypassThrottle:true`.
     - `protection-disabled`: show "System Protection is off for C:" and a button "Turn on System Protection for C:" with a confirm dialog that explains disk usage, followed by `enableSystemProtection`.
     - `elevation-cancelled`: show a neutral notice.
   - "Load restore points" is an explicit click because it needs admin. It shows a table of sequence, description and date.
   - "Open Windows System Restore" calls `openSystemRestore`.
   - `pendingFrequencyRecovery` shows a recovery banner with a button that calls `recoverRestoreFrequency`.
2. **"App configuration backups"**: the existing table. Keep the notice that these only cover Frameforge settings.

### Auto-offer before optimizations

`App.tsx`'s `openPreview(ids)` first calls `restoreStatus`. If protection is not `disabled` or policy-blocked, the preview modal shows a checked checkbox, "Create a Windows restore point first". When the box is checked, Confirm does the following:
1. calls `createRestorePoint`;
2. on `created` or `throttled` (where the last point is under 24 h old, which counts as covered), calls `preview` again to get a fresh token, because creation can outlast the 5-minute token;
3. calls `confirm` with the new token.

On `failed`, `elevation-cancelled` or `protection-disabled`, the flow stops and asks "Apply without a restore point?" with explicit buttons.

`src/api.ts` demo: `restoreStatus` returns `protection:"unknown"` with a message saying the desktop app is required. The other methods throw "desktop app required".

### Tests

- **xUnit** `RestorePointsTests.cs` with a fake `IRestoreStore`:
  - unchanged sequence gives `throttled`;
  - the bypass restores the original value (both existed and absent) even when create throws;
  - 1058 gives `protection-disabled`;
  - the description validator rejects `"; calc` and strings over 64 characters;
  - the result-path validator rejects a wrong name, a UNC path or a non-empty file.
- **vitest** `tests/restore.test.ts` with a `MockPlatform` subclass: the journal row lifecycle, `bypassThrottle` rejected without a prior throttle, activity entries written, and `pendingFrequencyRecovery` surfacing.
- **UI test**: the Restore page shows both section headings, and the demo create button is disabled with a reason.

**Acceptance:** GC-12. Manual checks on this PC:
1. Create a point. A UAC prompt appears and the point is listed in `rstrui`.
2. Create again immediately. The result is `throttled` with an explanation.
3. "Create anyway" creates the point, and `reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore" /v SystemRestorePointCreationFrequency` shows the original state afterwards.
4. Declining UAC shows "cancelled", and there is no error toast storm.

---

## Task 3: Full installed-game detection

**Depends on:** GC-3, GC-4, GC-5, GC-6, GC-12, GC-13.

### Files

- `electron/games.ts`: orchestration, path safety (`directory`, `within`, `installExecutable` and `safeExecutable` are already there), `add()`/dedupe, the result. Keep it as the only orchestrator.
- `electron/launchers.ts` (new): **pure** parsers that take file text or registry records and return `{name, installPath, executable?}[]`. They do no I/O, so fixture tests are trivial.
- `electron/registry.ts` (new): move the `reg.exe` reader out of `games.ts` and generalize it to `queryRegistry(key): Promise<{key, values: Record<string,string>}[]>`. It keeps the subkey path, reads `REG_SZ`, `REG_EXPAND_SZ` and `REG_DWORD` (hex to number string), uses fixed keys only, `shell:false`, and a 10 s timeout.
- `tests/fixtures/launchers/<launcher>/...` plus `tests/launchers.test.ts`.

### Contract

- `GameSchema.source` gains `"ea","ubisoft","battlenet","riot","rockstar","itch","registry","folder"`. Adding enum values is safe per GC-4.
- `DetectionSchema` gains `perLauncher: z.array(z.object({launcher, found: number, skipped: number, status: z.enum(["scanned","not-installed","error"])}))`.
- New method `scanFolder`: `{confirmed: true}` → `DetectionSchema`. Main opens the native folder dialog; the renderer passes no path.

### Sources

Each source is its own `try` block, adds to `perLauncher`, and is capped at 500 games.

| Source | Where | Parse |
|---|---|---|
| Steam | existing (Task 1 fixed) | libraryfolders.vdf + appmanifest; skip appid 228980 and other redistributables (`Steamworks Common Redistributables`, `Proton*`, `Steam Linux Runtime*`) |
| Epic | existing `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item` | keep; also skip `AppCategories` containing `"plugins"` or `"engines"` |
| GOG | existing registry `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games` (+ non-WOW) | keep (`gameName`, `path`, `exe`) |
| Xbox / MS Store | for each fixed drive, `X:\.GamingRoot` (binary: 4-byte `RGBX` magic, 4-byte count, then UTF-16LE NUL-terminated relative folder names, e.g. `XboxGames`); fall back to `X:\XboxGames` | each `<root>\<Game>\Content\MicrosoftGame.config` (XML). Name from `ShellVisuals DefaultDisplayName` (if it starts with `ms-resource:`, use the folder name); exe from the first `<Executable Name="...">` resolved under `Content`. Regex attribute extraction is fine; fixture-test it. UWP games under `WindowsApps` are not readable (ACL), so report "Microsoft Store titles outside XboxGames folders are not detectable without Store APIs" as an info warning only when no GamingRoot exists |
| EA app | registry `HKLM\SOFTWARE\WOW6432Node\Electronic Arts\*` and `...\EA Games\*`, value `Install Dir` | name = subkey leaf |
| Ubisoft Connect | `HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<id>` value `InstallDir` | name: Uninstall key `Uplay Install <id>` `DisplayName`, else the folder basename |
| Battle.net | Uninstall keys (below) with `Publisher` = `Blizzard Entertainment`, excluding the `Battle.net` app itself | `DisplayName`, `InstallLocation` |
| Riot | `%ProgramData%\Riot Games\Metadata\*\*.product_settings.yaml` (line `product_install_full_path: "..."`); exclude `riot_client` | name from the yaml folder (`valorant.live` → `VALORANT`, `league_of_legends.live` → `League of Legends`; small map with a title-case fallback) |
| Rockstar | `HKLM\SOFTWARE\WOW6432Node\Rockstar Games\*` value `InstallFolder` (+ Uninstall `Publisher` = `Rockstar Games`) | subkey leaf; exclude `Launcher`, `Social Club` |
| itch | `%APPDATA%\itch\apps\*\.itch\receipt.json.gz` (gunzip with `node:zlib`, ≤1 MB) | `game.title`; install = app folder |
| Uninstall heuristic | `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*`, the WOW6432Node equivalent, and HKCU | only when `InstallLocation` exists **and** (`Publisher` is in a small allowlist: Blizzard, Riot, Rockstar, Electronic Arts, Ubisoft, Bethesda, Activision, CD PROJEKT, Square Enix, Bandai Namco, SEGA, Capcom, Paradox **or** the key name matches `Steam App \d+`); source `registry` |
| Folder scan (user-chosen) | `scanFolder`: each immediate subfolder (≤200), searched to depth 3 | executable = the largest `.exe` excluding `/^(unins|setup|install|vc_?redist|dxsetup|crashreport|unitycrashhandler|crashpad|ue4prereq|dotnet|easyanticheat|be(service|_setup)|launcher_?helper)/i`; source `folder` |

**Dedupe** (in `add()`): key = `realpath(install).toLowerCase()`. Source priority on collision: launcher-specific sources beat `registry`, which beats `folder`.

**Executable resolution:** Epic, GOG, Xbox and folder sources set it when it is safely inside the install folder (`installExecutable`). Steam, EA, Ubisoft, Riot and Rockstar leave it `null`. The booster matches by install folder (Task 4), so this is acceptable, and the UI shows "matched by folder". Icons are skipped; YAGNI.

### Progress

Add a one-way event channel. `main.ts` sends `window.webContents.send("frameforge:event", event)`. `preload.ts` exposes `onEvent(cb) => unsubscribe` on `window.frameforge`, validated with a new `EventSchema = z.discriminatedUnion("type", [{type:"scan-progress", launcher, done, total, found}, ...])` in contracts (Task 4 adds booster events). `detectInstalledGames(options, onProgress?)` calls `onProgress` after each launcher.

### UI (`src/views/Games.tsx`)

- The "Scan installed games" button becomes "Rescan".
- While scanning: a progress line ("Scanning Riot… 6/12") from events.
- After the scan: a per-launcher summary table (found, skipped, status) and warnings.
- A "Scan a folder…" button calls `scanFolder`.
- The source badge uses friendly names.
- The empty-state text lists the supported launchers truthfully.

### Tests

`tests/launchers.test.ts` has one `describe` per parser, using fixture files under `tests/fixtures/launchers/`:
- `.GamingRoot` binary: create it in the test with a `Buffer`;
- `MicrosoftGame.config` (with and without `ms-resource`);
- Riot yaml;
- `RiotClientInstalls.json`, optional and ignored if unused;
- itch receipt (gzip in the test);
- registry text output from `reg query` for EA, Ubisoft, Rockstar and Uninstall;
- folder scan with a blacklisted exe.

Also cover: dedupe across sources by path, path escape rejected, oversized files rejected.

**Acceptance:** GC-12. Manual check on this PC: Rescan finds the Steam app 1304930, the Riot games under `C:\ProgramData\Riot Games\Metadata`, and the Xbox titles under the `.GamingRoot` roots on C: and D:. Record the per-launcher counts in the commit message.

---

## Task 4: Real Game Booster / Game Mode with selectable modes

**Depends on:** GC-2, GC-3, GC-4, GC-5, GC-6, GC-8, GC-9, GC-10, GC-11, GC-12, GC-13.

### Modes and mechanisms

| Mechanism | Off | Balanced | Performance | Competitive | Custom |
|---|---|---|---|---|---|
| Windows Game Mode on (HKCU `Software\Microsoft\GameBar` `AutoGameModeEnabled`=1, `AllowAutoGameMode`=1) | – | ✓ | ✓ | ✓ | toggle |
| Game process priority | – | AboveNormal | High | High | Normal/AboveNormal/High |
| Game affinity (custom logical CPU list) | – | – | – | – | toggle + CPU checkboxes |
| Power plan → High performance (`8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c`), or Ultimate (`e9a42b02-d5df-448d-aa00-03f14749eb61`) **only if already present** | – | – | ✓ | ✓ | toggle |
| Lower user-selected background processes to BelowNormal | – | – | ✓ | ✓ | toggle |
| Suspend user-selected background processes | – | – | – | ✓ | toggle |
| Close user-selected background processes (not reopened; stated in UI) | – | – | – | – | toggle, off by default |
| High timer resolution | – | – | – | if supported | toggle if supported |
| Standby-list purge | **unsupported**: needs admin + `SeProfileSingleProcessPrivilege`; listed as unsupported in UI and docs | | | | |

Rules:
- RealTime priority is never used.
- The power plan allowlist is High performance, Ultimate (if present), and the user's previous plan for restore only. Use `powrprof.dll` `PowerGetActiveScheme`, `PowerSetActiveScheme` and `PowerEnumerate`. These are the same APIs `powercfg /setactive` uses, need no admin and need no process spawn.
- If the target GUID is absent (common on Modern Standby machines with Balanced only), the mechanism reports `unavailable: "High performance plan not present"`. Never `duplicatescheme` without explicit consent; that is out of scope.
- **Timer resolution honesty.** Since Windows 10 2004, a timer request affects only the requesting process, unless Windows 11 has `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\kernel\GlobalTimerResolutionRequests` = 1.
  - The helper reads that value and the OS build.
  - If the build is ≥ 19041 and the value is not 1, the mechanism is `unsupported` with that reason. Frameforge does **not** set the HKLM value.
  - If it is supported, the session helper calls `NtSetTimerResolution(5000, TRUE, out cur)`, verifies it with `NtQueryTimerResolution`, and releases it on revert. Process exit also releases it.
- Windows Game Mode values reuse `RegistryOperations`:
  - generalize `Setting` with a per-setting target value (today it is hard-coded to `"0"`/`0`);
  - add a `game-mode` operation with the two GameBar DWORD settings, target 1;
  - lift the `ids.Length is < 1 or > 2` limit to the allowlist size;
  - Capture, Apply and Restore are reused unchanged.

### Persisted config (GC-4: additive with defaults; no breaking migration)

- `GameSchema.boostMode: z.enum(["global","off","balanced","performance","competitive","custom"]).default("global")`.
- The legacy `profile` stays, but it is hidden in the UI and documented as deprecated, so old backups still parse.
- `StateSchema.booster: z.object({ mode: z.enum(["off","balanced","performance","competitive","custom"]).default("off"), autoBoost: z.boolean().default(false), custom: CustomMechanismsSchema.default({...all off}), background: z.array(z.object({image: z.string().regex(/^[\w .()-]{1,64}\.exe$/i), action: z.enum(["lower","suspend","close"])})).max(50).default([]) }).strict().default({...})`.
  - Add a refine that rejects GC-11 denylist names.
  - `CustomMechanismsSchema = {gameMode: bool, priority: enum["Normal","AboveNormal","High"], affinity: z.array(z.number().int().min(0).max(255)).max(256).nullable(), powerPlan: bool, lowerBackground: bool, suspendBackground: bool, closeBackground: bool, timerResolution: bool}`.
- Legacy `state.gameMode`: keep the field for parse compatibility. Remove the `gameMode` IPC method, its handler, the demo case and the UI (it is the old cosmetic toggle).
- `BoostSessionSchema` is extended to `{id, gameId, mode, target: ProcessTargetSchema, startedAt, endedAt: string|null, status, message, mechanisms: z.array(MechanismResultSchema), samples: z.array(SampleSchema).max(200)}`, where:
  - `MechanismResultSchema = {id: enum[...], state: enum["applied","skipped","unsupported","unavailable","failed","reverted","conflict"], detail: string}`.
  - `SampleSchema = {at, systemCpuPercent, availableMemoryBytes, gameWorkingSetBytes}`.

  Old `boost_sessions` rows from Task 1 parse via defaults (`mode:"custom"`, `mechanisms:[]`, `samples:[]`, `endedAt:null`).

### Helper: long-lived session mode (new `windows/Frameforge.Windows/BoostSession.cs`)

The per-call helper exits after each reply. A boost needs a process that lives as long as the game and reverts things if Frameforge dies.

- Start: `Frameforge.Windows.exe --session` with stdio pipes, spawned by Node with `shell:false`. It reads JSON lines and writes JSON lines.
- Protocol:
  - **In:** `{"command":"start", gamePid, gameStartTime, gamePath, mechanisms:{...resolved for mode}, background:[{image, action}], parentPid}`.
  - **Out**, one line per step:
    - `{"event":"captured", mechanism, prior}` is emitted **before** each change (Node persists it to `boost_sessions.payload` immediately, per GC-10);
    - `{"event":"applied"|"skipped"|"unsupported"|"failed", mechanism, detail}`;
    - `{"event":"sample", ...}` every 30 s (system CPU via `GetSystemTimes` delta, `GlobalMemoryStatusEx`, game working set);
    - `{"event":"ended", reason:"game-exited"|"stop"|"parent-exited"|"stdin-closed", reverts:[...]}`.
  - **In:** `{"command":"stop"}` makes the helper revert everything and exit.
- The helper reverts in reverse order and exits when any of these happens: the game process exits (`WaitForExit` on the handle), `stop` arrives, stdin reaches EOF, or the `parentPid` process exits.
- Each revert is conflict-aware. It only restores when the current value equals the value the helper applied; otherwise it reports `conflict` and keeps the external change.
- Background actions:
  - enumerate processes with the same session id and owner SID as the game;
  - apply GC-11;
  - match `image` case-insensitively;
  - suspend via `NtSuspendProcess`/`NtResumeProcess` (ntdll) on a handle opened with `PROCESS_SUSPEND_RESUME`;
  - lower via `PriorityClass`;
  - close via `CloseMainWindow()`, then `Kill()` after 5 s, only for `action:"close"`, and log it as not reversible.

### Per-call helper commands for recovery and watching (`Program.cs`)

- `running-games {games:[{id, path, executablePath}]}` → the matched `ProcessTarget`s (reuse `WindowsProcessStore.Find`). Among several processes under the folder, prefer the one with a main window and the largest working set. Exclude GC-11 names and launcher helpers (`*crash*`, `*launcher*` unless it is the exe set).
- `boost-recover {captured:[...]}` reverts persisted priors with the same conflict rules. It resumes suspended pids only if pid + start time still match. It restores the power scheme if the current one equals the applied one. It restores GameBar values via `RegistryOperations.Restore`.
- `boost-capabilities` → per-mechanism availability: whether the power plans are present, whether the timer is supported (and why), and the logical CPU count.

### Electron (`electron/booster.ts`, evolving Task 1's `BoostEngine`)

- `start(gameId, target?, reason: "manual"|"auto")`:
  1. Resolve the mode (`game.boostMode`, else the global mode). If the result is `off`, do nothing.
  2. Persist the session as `preparing`.
  3. Spawn the session helper and stream its events into the DB and into `frameforge:event` `{type:"boost", session}`.
  4. Move to `active` once all mechanisms report.
- `stop()` sends `stop` and waits up to 15 s, after which the session helper is killed and `recover()` runs.
- Watcher: when `booster.autoBoost` is true, poll `running-games` every 5 s (10 s timeout), but only while no session is active. When a library game appears, `start(..., "auto")`. The session ends on its own when the game exits. Polling stops when `autoBoost` is false. Add a `ponytail:` comment noting that 5 s polling could be replaced by WMI process-start events if latency matters.
- Recovery: on `main.ts` startup, `booster.recover()` runs. For any non-`ended` session it calls `boost-recover` with the persisted captures and marks the result `ended` or `recovery-needed`.
- App quit: in `before-quit`, if a session is active, call `event.preventDefault()`, `await booster.stop()`, then `app.quit()`. The session helper also self-reverts on stdin EOF if Electron crashes.
- Activity log: session started (mode, game), each mechanism result, session ended (duration, revert summary, average CPU/RAM samples labelled "system snapshot, not FPS").

### IPC (replacing `boostTargets`, `boostStart`, `boostStop`, `gameMode`)

| Method | Request | Response |
|---|---|---|
| `boostStatus` | `Empty` | `{session: BoostSession\|null, capabilities: BoostCapabilitiesSchema, watching: boolean}` |
| `boostConfig` | `StateSchema.shape.booster` | `StateSchema` |
| `boostStart` | `{gameId, confirmed: true}` (the engine finds the running process; error "Start the game first" if none) | `BoostSessionSchema` |
| `boostStop` | `{confirmed: true}` | `BoostSessionSchema.nullable()` |
| `boostRecover` | `{confirmed: true}` | `BoostSessionSchema.nullable()` |
| `runningProcesses` | `Empty` | `z.array({image, pid, protected: boolean})`, for the background-list picker; denylisted entries are flagged and not selectable |
| `profile` | gains `boostMode` | |

`bootstrap.boost` becomes `{session, available, watching}`.

### UI (`src/views/GameBooster.tsx`, page "Game Mode")

- A mode selector (segmented: Off / Balanced / Performance / Competitive / Custom). Each mode shows the exact mechanisms it applies and their availability. Unsupported mechanisms are greyed with the reason.
- The Custom panel has a toggle per mechanism, a priority select, and affinity checkboxes (the CPU count comes from capabilities).
- Background processes: a list editor fed by `runningProcesses`, with an action select per entry.
- An "Auto-boost when a library game starts" switch.
- An active-session card showing the game, mode, uptime, per-mechanism state chips, and a Stop button.
- A live log of this session's events (via `onEvent`).
- A recovery banner and button when a session is `recovery-needed`.
- Game library details: replace the Profile select with a "Booster mode" select (Use global / Off / Balanced / Performance / Competitive / Custom).
- Copy: "Frameforge does not measure FPS. Session CPU/RAM snapshots are shown for reference."

### Tests

- **xUnit**, using fakes behind new `IPowerStore`, `IProcessControl` and `ITimerControl` interfaces:
  - the power plan is restored only if unchanged;
  - an absent target plan gives `unavailable`;
  - denylisted and other-session processes are never touched;
  - suspend/resume pairs are recorded and resumed on stop and on stdin EOF;
  - a priority conflict is kept;
  - the timer is `unsupported` on build ≥ 19041 without the global flag;
  - GameBar values are captured, applied and restored through `RegistryOperations`.
- **vitest** `tests/booster.test.ts`, rewritten for the new API with a fake session helper (an injectable `spawnSession` returning an EventEmitter-like stub):
  - captures are persisted before the `applied` event;
  - crash recovery on a new `BoostEngine` calls `boost-recover`;
  - the watcher starts once per game and does not start a second session;
  - an `off` mode is a no-op;
  - quitting with an active session awaits stop.
- **GC-4 test:** a v1 state plus a Task-1 `boost_sessions` row both parse.
- **UI test:** in demo mode, the mode selector renders and Start is disabled with a "desktop app required" reason.

**Acceptance:** GC-12. Manual checks with a real game (for example the Steam app 1304930) in `npm run dev:desktop`:
1. In Performance mode, Task Manager shows the game at High priority and `powercfg /getactivescheme` shows High performance (or the UI shows "unavailable" with a reason).
2. The selected background exe is at Below normal.
3. Closing the game restores everything, and the activity log shows the reverts.
4. In Competitive mode with a suspended app: kill Frameforge via Task Manager. The session helper resumes the app (stdin EOF). Also kill both processes, restart Frameforge, and confirm recovery resumes and reverts the power plan.

---

## Task 5: Missing-features sweep (no dead buttons, no fake success)

**Depends on:** GC-3, GC-6, GC-12, plus the GCs of any mechanism touched.

Audit each page against the original spec and these known findings, then fix them. Record each item as fixed, labelled or removed in `docs/FEATURE_STATUS.md` (Task 6).

1. **Dashboard** (`src/views/Dashboard.tsx`)
   - Quick actions must reflect real state: the game count, backups plus the restore-point status chip from `restoreStatus`, and the booster state and mode.
   - The "Consistent pointer movement" action is disabled in demo mode with its reason. Today it opens a preview whose confirm is disabled, which is acceptable but should be labelled.
2. **Optimization catalogue** (`shared/catalogue.ts`, `src/views/Optimizations.tsx`)
   - `power-plan`: its text claims "this app does not change power plans", which is now false. Make it **supported** as a persistent switch to High performance, reusing Task 4's `IPowerStore` via the `capture`/`apply`/`verify`/`restore` helper commands with a `{scheme}` snapshot entry. Add it to `WindowsPlatform.capabilities`. Extend `SnapshotSchema` additively.
   - The `hardware-scheduling`, `startup-review`, `driver-review`, `dns-tuning` and `service-tuning` entries stay unsupported. Each detail dialog gets a real "Open in Windows Settings" button: new IPC `openSettings {page: z.enum(["graphics","startup","network","services"])}` mapped server-side to `ms-settings:display-advancedgraphics`, `ms-settings:startupapps`, `ms-settings:network-status`, and `services.msc` (via `shell.openPath` of `System32\services.msc`). The renderer never sends URIs.
   - Unsupported "Review/apply" buttons stay disabled with the reason.
3. **Presets:** `Recommended` and `Beginner` are identical (`["mouse-precision"]`). Merge them, or make Beginner `capture-off`-free and Recommended include `power-plan` once supported. Every built-in preset may only reference supported ids. Add a test that every preset id is in `WindowsPlatform.capabilities`.
4. **Game library:** done by Tasks 3 and 4. Confirm that game removal during an active session stops the session first. "Game details" shows the path, exe (or "matched by folder") and source.
5. **Game Mode:** done by Task 4. Confirm the old `gameMode` method and its UI are gone, so there is no cosmetic toggle.
6. **Restore & backups:** done by Task 2.
7. **Hardware info** (`HardwareDiscovery.cs`, `System.tsx`)
   - `Win32_DesktopMonitor` gives "Generic PnP Monitor". Replace it with `root\wmi WmiMonitorID` (`UserFriendlyName` decoded from a ushort array, unelevated) plus resolution from `Win32_VideoController.CurrentHorizontalResolution`/`CurrentVerticalResolution`/`CurrentRefreshRate`.
   - Show a "Refresh" spinner state.
   - Leave temperatures, live GPU use and FPS listed as unsupported.
8. **Settings:**
   - Verify each toggle has a consumer. `notifications` gates toasts in `App.tsx`; `diagnostics` gates timing logs in `service.dispatch`; `startup` is packaged-only and disabled with a reason in dev.
   - Add a "Booster" subsection linking to the Game Mode page. No duplicate settings.
9. **Activity log:** booster and restore entries render with status chips. "Clear" keeps rollback, recovery and running rows (existing). Rows of the new journal types (`Restore point throttle override`) show their recovery action.
10. **Demo mode** (`src/api.ts`): every method handled. Mutating Windows methods throw "desktop app required". Sample data stays labelled "(sample)"/"Demo data". Add a test that iterates `Object.keys(requests)` and asserts that the demo either returns a schema-valid value or throws a message containing "desktop".
11. **IPC hygiene:** a test asserts that `Object.keys(requests)`, `Object.keys(responses)` and the `AppService` handler keys are identical sets.

**Acceptance:** GC-12. Manual check: a click-through of every page in `npm run dev:desktop` and `npm run dev` (demo). Every enabled button does something real or opens a dialog, and every disabled button shows a reason. Update the Playwright workflow `tests/browser/workflows.spec.ts` for changed labels, and run `npm run test:e2e` and `npm run test:desktop`.

---

## Task 6: Docs and packaging sanity

**Depends on:** GC-5, GC-6, GC-12.

- `README.md`:
  - real features with their exact scope (restore points via Windows System Restore with UAC per operation; the booster mechanisms table and the unsupported ones; launchers detected and their limits);
  - build steps including GC-1 (dotnet path) and GC-2 (publish);
  - no performance claims.
- `docs/FEATURE_STATUS.md`: rewrite the table from the actual state after Tasks 1–5. Each row has a status of Implemented, Implemented (needs admin), Unsupported (reason), or Mocked (demo). Include timer resolution (conditional), standby purge (unsupported), Ultimate plan (only if present), Microsoft Store titles outside XboxGames (not detected), and what was manually verified on this PC versus tested only with fakes.
- `docs/PHASE_REPORT.md`: append a "2026-10 booster / restore / detection" phase with the exact gate command output (test counts) and the manual checks performed, including which were **not** performed.
- `docs/SECURITY.md`: add the elevation model (GC-7), the session helper lifetime and revert guarantees, and the process denylist (GC-11).
- `package.json` `build`: confirm there is no `requestedExecutionLevel` (default `asInvoker`), `extraResources` still ships `windows/publish` (the helper exe is reused for `--elevated` and `--session`), and add no `nsis.perMachine` change. Do not add a manifest requiring admin to `Frameforge.Windows.csproj`.
- Run `npm run package:win` (with GC-1 PATH). The installer builds. Smoke the packaged exe with `FRAMEFORGE_EXECUTABLE=<release unpacked exe> npm run test:desktop`.

**Acceptance:** GC-12, the `package:win` success, and docs that contain no claim contradicted by `FEATURE_STATUS.md`.
