# Frameforge

An original, local Windows gaming configuration application built with React, TypeScript, Vite, Tailwind, Radix, Electron and a C#/.NET Windows helper. Core desktop features work offline. Frameforge makes no FPS, latency or performance-gain claims.

## Setup

Requirements: Windows x64, Node.js 22.13 or later, npm, and a .NET 8 SDK. Node's built-in `node:sqlite` is required for repository tests. The published helper is self-contained, so an installed app does not need a separate .NET runtime.

```powershell
npm ci
npm run windows:publish
npm run build
npm start
```

For development, `npm run dev:desktop` opens Electron against Vite on `http://127.0.0.1:5173`, which must be free. `npm run dev` opens the browser demo only: hardware is labelled as demo data, configuration is kept in browser local storage, every Windows change is unavailable and there is no native executable picker. Use the desktop app for real discovery and durable SQLite storage.

### .NET SDK in this workspace

The npm scripts call `dotnet` from PATH. In this workspace the SDK is in `.tools\dotnet` (SDK 8.0.425). Either put it on PATH for the session, or call it directly:

```powershell
$env:PATH = "D:\Hone\.tools\dotnet;$env:PATH"
$env:DOTNET_ROOT = "D:\Hone\.tools\dotnet"
npm run windows:test

.\.tools\dotnet\dotnet.exe publish windows/Frameforge.Windows/Frameforge.Windows.csproj -c Release -r win-x64 --self-contained true -o windows/publish
.\.tools\dotnet\dotnet.exe test windows/Frameforge.Windows.Tests/Frameforge.Windows.Tests.csproj
```

### Test data and profile override

Tests and the desktop smoke test must not touch a real profile. `FRAMEFORGE_USER_DATA` sets the app's `userData` directory. It must be a local absolute path (no relative, UNC or device paths); an invalid value makes the app exit with code 1. The override is ignored in packaged builds unless `FRAMEFORGE_TEST_MODE=1` is also set. `npm run test:desktop` creates its own temporary profile and sets both variables.

## Commands

| Command                   | Purpose                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run build`           | Type-check, then build renderer, Electron main process and preload                                                |
| `npm run typecheck`       | Check renderer and Electron TypeScript                                                                            |
| `npm run lint`            | ESLint                                                                                                            |
| `npm run format:check`    | Prettier check (`npm run format` rewrites)                                                                        |
| `npm test`                | Vitest: UI, IPC contract, service, persistence, booster, restore, launcher parsing                                |
| `npm run test:e2e`        | Playwright browser workflows; needs a Vite server (see below) and Chromium from `npx playwright install chromium` |
| `npm run test:desktop`    | Electron smoke test with an isolated temporary profile                                                            |
| `npm run windows:build`   | Build the .NET helper                                                                                             |
| `npm run windows:test`    | Run the xUnit helper tests                                                                                        |
| `npm run windows:publish` | Publish the self-contained Windows x64 helper to `windows/publish`                                                |
| `npm run package:win`     | Publish helper, build the app, create the NSIS installer in `release/`                                            |

For browser tests, keep a Vite server running first. The default test URL is port 5173; set `PLAYWRIGHT_BASE_URL` to override. To smoke-test a packaged executable, set `FRAMEFORGE_EXECUTABLE` to its absolute path before `npm run test:desktop`.

Installer configuration is included, but the installer and packaged smoke test predate the booster, restore-point and detection work described below. See [Phase Report](docs/PHASE_REPORT.md) for what has been built and tested; installer configuration alone does not establish installation verification.

## Features and Scope

Every status below is defined in [Feature Status](docs/FEATURE_STATUS.md). The short version:

- **Windows System Restore points** are created through the Windows `SystemRestore` WMI class. Creation runs in a helper that Windows elevates per operation with a UAC prompt. Declining the prompt changes nothing. The new point is confirmed by its sequence number. The app also checks System Protection for C: and handles the 24-hour creation limit with consent. This elevated path has **not yet been verified on real hardware by a person**.
- **Game detection** reads 12 sources: Steam, Epic Games, GOG, Xbox app (`.GamingRoot`), Microsoft Store packages that ship `MicrosoftGame.config`, EA app, Ubisoft Connect, Battle.net, Riot Games, Rockstar Games, itch.io, and Windows Uninstall registry entries. A folder you choose can also be scanned. Launcher parsers are read-only. Which sources were checked on the development PC and which only with fixtures is listed in the Feature Status table.
- **Game Booster** applies reversible changes to a running library game in one of five modes. Changes are captured before they are made, verified after, and reverted when the game exits, when you press Stop, when the app quits, or after a crash. Details are in the table below.
- **Windows preferences** (current-user only, no elevation): consistent pointer movement and background game capture (Game DVR). Preview, confirmation, verification and rollback are included.
- **Optimizations** that are previewed before any change: the consistent pointer and Game DVR preferences above, and a persistent switch to a High performance power plan when one exists. Other catalogue entries (GPU scheduling, DNS, drivers, services, third-party startup) are unsupported and link to the relevant Windows page where one exists.

### Game Booster

Modes and what each one applies. Each mechanism is also shown on the Game Mode page with whether it applies on this PC.

| Mechanism                            | Off                                                    | Balanced    | Performance | Competitive | Custom                      |
| ------------------------------------ | ------------------------------------------------------ | ----------- | ----------- | ----------- | --------------------------- |
| Windows Game Mode (per-user GameBar) | No                                                     | Yes         | Yes         | Yes         | Toggle                      |
| Game priority                        | No                                                     | AboveNormal | High        | High        | Toggle: AboveNormal or High |
| Game CPU affinity (per CPU)          | No                                                     | No          | No          | No          | Toggle                      |
| High performance power plan (switch) | No                                                     | No          | Yes         | Yes         | Toggle                      |
| Timer resolution (1 ms request)      | No                                                     | No          | No          | Yes         | Toggle                      |
| Lower selected background apps       | No                                                     | No          | Yes         | Yes         | Toggle                      |
| Suspend selected background apps     | No                                                     | No          | No          | Yes         | Toggle                      |
| Close selected background apps       | No                                                     | No          | No          | No          | Toggle                      |
| Standby list purge                   | Unsupported in every mode (needs administrator rights) |             |             |             |                             |

Notes on each mechanism:

- **Game Mode** sets `AutoGameModeEnabled` and `AllowAutoGameMode` (`HKCU\Software\Microsoft\GameBar`) to 1. If a value is absent, Frameforge treats it as the Windows default (on) and does not write it. Only an explicit 0 is changed.
- **Priority** is set on the game process only. Real-time priority is never used.
- **Affinity** is a single 64-bit mask on the game. It only covers processor group 0.
- **Power plan** switches to High performance, or Ultimate if present, for the session, then returns to the exact prior plan. If neither exists, the option is unavailable until you consent to creating a copy named "Frameforge High performance" from a built-in template. That copy does not become active when created, is recorded in the app database, can be removed from the app, and user-created plans are never modified. Removal refuses any plan that was not created by Frameforge.
- **Timer resolution** requests 1 ms through `NtSetTimerResolution` and releases it at revert or game exit. It is unsupported on Windows 10 2004 and later builds below 22000 (builds 19041 to 21999), even if the flag below is set. On Windows 11 (22000 and later) it is supported only when `GlobalTimerResolutionRequests` is 1. Frameforge never writes that value.
- **Background apps** are limited to processes in the game's session and owned by the same user. Critical, system, security, anti-cheat and denylisted processes, the helper and Frameforge itself are never touched. You choose which apps are affected, up to 50. Suspend resumes each process exactly once. Close sends a window-close request and then terminates after 5 seconds; closed apps are not reopened, and that action cannot be reverted.
- **Standby list purge** is always shown as unsupported.

Session behaviour: the helper runs detached and reports every prior value before it changes it. On revert, a value is restored only if Frameforge's value is still in place. An external change is kept and shown as a conflict. A failed revert leaves a recovery banner with Retry and Dismiss. Auto-start, when enabled, checks every 5 seconds for a running library game and starts one session per game process. CPU and RAM figures are system readings, not FPS.

## Data and Recovery

Desktop state is stored in `frameforge.db` under Electron's per-user `userData` directory, ordinarily `%APPDATA%\frameforge`. SQLite migrations use `PRAGMA user_version`, WAL, parameterised statements and transactions. Newer database versions are refused without deleting existing data. The database holds game paths and configuration that can identify local files, so keep it private.

Named app backups capture app settings, games and custom preset configuration. They are not Windows System Restore points and not full machine backups. Restoring one first creates a pre-restore app backup. Restoring app configuration does not undo Windows registry preferences; use the operation's rollback for those.

Interrupted registry operations and booster sessions are recorded in a durable journal and marked for recovery on the next startup. Recovery never overwrites an unexpected external value. Do not delete the database while a change needs recovery.

## Security

Frameforge runs as the current user (`asInvoker`). Only the Windows restore-point actions ask for elevation, one UAC prompt per action, through the same helper. See [Security](docs/SECURITY.md) for the boundaries and the parts of the elevation and booster design that document does not yet cover.

## Verification and Limitations

- [Phase Report](docs/PHASE_REPORT.md) lists the gate results, the manual checks that were performed, the checks that are still required, and the known limitations.
- [Feature Status](docs/FEATURE_STATUS.md) states, for each capability, whether it was verified on the development PC or only tested with fixtures or fakes.
- [Implementation Plan](docs/IMPLEMENTATION.md) records scope and ownership.
