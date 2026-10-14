# Frameforge

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![CI](https://github.com/PREETHAM1590/Frame-Forge/actions/workflows/ci.yml/badge.svg)](https://github.com/PREETHAM1590/Frame-Forge/actions/workflows/ci.yml)

An original, local Windows gaming configuration application built with React, TypeScript, Vite, Tailwind, Radix, Electron and a C#/.NET Windows helper. Core desktop features work offline. Frameforge makes no FPS, latency or performance-gain claims.

## Download

Get `Frameforge-Setup-<version>.exe` and `SHA256SUMS.txt` from the [Releases page](https://github.com/PREETHAM1590/Frame-Forge/releases). Requires Windows 10 or 11, x64. Releases are built by GitHub Actions from the tagged source.

Code signing: Frameforge uses free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org) (application in progress; releases up to v1.3.0 are unsigned).

Privacy policy: [docs/PRIVACY.md](docs/PRIVACY.md)

- **Per-user install, no administrator needed.** The installer puts Frameforge in `%LOCALAPPDATA%\Programs\Frameforge`, adds Start menu and desktop shortcuts, and registers an uninstaller under Settings, Apps.
- **SmartScreen.** Until the installer is code-signed, Windows SmartScreen may warn on first run. Choose "More info", then "Run anyway".
- **Verify the download** (compare with the line in `SHA256SUMS.txt`):

  ```powershell
  Get-FileHash .\Frameforge-Setup-1.3.0.exe -Algorithm SHA256
  ```

- Pausing background services during a boost, and creating or listing Windows restore points, need administrator approval. Windows shows a UAC prompt for each of those actions. Declining the prompt changes nothing.

Code signing policy: [docs/CODE_SIGNING_POLICY.md](docs/CODE_SIGNING_POLICY.md). License: [MIT](LICENSE). Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Known limitations

- **Unsigned.** The installer and `Frameforge.Windows.exe` are not code-signed, so SmartScreen may warn on first run (see above).
- **Administrator prompts.** Windows asks for approval for each of these, and declining changes nothing: creating or listing restore points, turning on System Protection, pausing services or clearing the standby memory list during a boost, and turning on the Windows 11 timer setting. Only one prompt is open at a time. If you leave a prompt unanswered it times out and nothing is changed; a prompt that is still open after that does nothing.
- **Security trade-offs lower your PC's security.** They are opt-in, one at a time, and each can be rolled back. A rollback that needs administrator approval waits for you; declining leaves the item restorable. If Game Mode ends by itself (the game exits) while services were paused, the end-of-session restart prompt is not covered by the shared gate.
- **Restore point prompts time out.** An unanswered prompt ends after 2 minutes as "Not approved - cancelled" (Cancel request withdraws it sooner).
- **Local monitoring.** Monitor shows live system counters and optional DirectX FPS capture with local summaries. FPS capture needs administrator approval; Vulkan, OpenGL and some anti-cheat games are not measured. Results describe this PC and scene, with no performance improvement promised.
- **Not verified by a person on a second PC.** See [Feature Status](docs/FEATURE_STATUS.md) for what was run on real hardware and what only ran against fakes.

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

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
$env:PATH = "<repo>\.tools\dotnet;$env:PATH"
$env:DOTNET_ROOT = "<repo>\.tools\dotnet"
npm run windows:test

.\.tools\dotnet\dotnet.exe publish windows/Frameforge.Windows/Frameforge.Windows.csproj -c Release -r win-x64 --self-contained true -o windows/publish
.\.tools\dotnet\dotnet.exe test windows/Frameforge.Windows.Tests/Frameforge.Windows.Tests.csproj
```

### Test data and profile override

Tests and the desktop smoke test must not touch a real profile. `FRAMEFORGE_USER_DATA` sets the app's `userData` directory. It must be a local absolute path (no relative, UNC or device paths); an invalid value makes the app exit with code 1. The override is ignored in packaged builds unless `FRAMEFORGE_TEST_MODE=1` is also set. `npm run test:desktop` creates its own temporary profile and sets both variables.

## Commands

| Command                   | Purpose                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`           | Type-check, then build renderer, Electron main process and preload                                                        |
| `npm run typecheck`       | Check renderer and Electron TypeScript                                                                                    |
| `npm run lint`            | ESLint                                                                                                                    |
| `npm run format:check`    | Prettier check (`npm run format` rewrites)                                                                                |
| `npm test`                | Vitest: UI, IPC contract, service, persistence, booster, restore, launcher parsing                                        |
| `npm run test:e2e`        | Playwright browser workflows; starts the Vite dev server itself and needs Chromium from `npx playwright install chromium` |
| `npm run test:desktop`    | Electron smoke test with an isolated temporary profile                                                                    |
| `npm run windows:build`   | Build the .NET helper                                                                                                     |
| `npm run windows:test`    | Run the xUnit helper tests                                                                                                |
| `npm run windows:publish` | Publish the self-contained Windows x64 helper to `windows/publish`                                                        |
| `npm run package:win`     | Publish helper, build the app, create the NSIS installer in `release/`                                                    |

`npm run test:e2e` starts `npm run dev` itself (or reuses a server that is already running on port 5173); set `PLAYWRIGHT_BASE_URL` to test another server. To smoke-test a packaged executable, set `FRAMEFORGE_EXECUTABLE` to its absolute path before `npm run test:desktop`.

Installer configuration is included, but the installer and packaged smoke test predate the booster, restore-point and detection work described below. See [Phase Report](docs/PHASE_REPORT.md) for what has been built and tested; installer configuration alone does not establish installation verification.

## Features and Scope

Every status below is defined in [Feature Status](docs/FEATURE_STATUS.md). The short version:

- **Windows System Restore points** are created through the Windows `SystemRestore` WMI class. Creation runs in a helper that Windows elevates per operation with a UAC prompt. Declining the prompt changes nothing. The new point is confirmed by its sequence number. The app also checks System Protection for C: and handles the 24-hour creation limit with consent. This elevated path has **not yet been verified on real hardware by a person**.
- **Game detection** reads 12 sources: Steam, Epic Games, GOG, Xbox app (`.GamingRoot`), Microsoft Store packages that ship `MicrosoftGame.config`, EA app, Ubisoft Connect, Battle.net, Riot Games, Rockstar Games, itch.io, and Windows Uninstall registry entries. A folder you choose can also be scanned. Launcher parsers are read-only. Which sources were checked on the development PC and which only with fixtures is listed in the Feature Status table.
- **Game Booster** applies reversible changes to a running library game in one of five modes. Changes are captured before they are made, verified after, and reverted when the game exits, when you press Stop, when the app quits, or after a crash. Details are in the table below.
- **Windows preferences** (current-user only, no elevation): consistent pointer movement and background game capture (Game DVR). Preview, confirmation, verification and rollback are included.
- **Optimizations** (v1.1.0: 43 more than 1.0) that are previewed before any change: current-user preferences, machine settings that need one administrator approval, boot-store items, a persistent High performance power plan, and a few **security trade-offs** (never in presets, one at a time, restore point offered, acknowledgement and typed name required, listed on the Dashboard until rolled back). Applying a value Windows already has reports "Already set - no change". Every item in the catalogue can be applied and rolled back: nothing is listed only to inform (the reasons for what was left out are in `docs/research/catalog-mapping.md`). Services (SysMain, Print Spooler and eight more from a never-core allowlist), Large Send Offload per physical adapter, the NVIDIA global driver profile and Windows Photo Viewer registration were added after 1.2.0.

### Game Booster

Modes and what each one applies. Each mechanism is also shown on the Game Mode page with whether it applies on this PC.

| Mechanism                                           | Off | Balanced    | Performance | Competitive | Custom                      |
| --------------------------------------------------- | --- | ----------- | ----------- | ----------- | --------------------------- |
| Windows Game Mode (per-user GameBar)                | No  | Yes         | Yes         | Yes         | Toggle                      |
| Game priority                                       | No  | AboveNormal | High        | High        | Toggle: AboveNormal or High |
| Game CPU affinity (per CPU)                         | No  | No          | No          | No          | Toggle                      |
| High performance power plan (switch)                | No  | No          | Yes         | Yes         | Toggle                      |
| Timer resolution (0.5 ms request)                   | No  | No          | No          | Yes         | Toggle                      |
| Lower selected background apps                      | No  | No          | Yes         | Yes         | Toggle                      |
| Suspend selected background apps                    | No  | No          | No          | Yes         | Toggle                      |
| Close selected background apps                      | No  | No          | No          | No          | Toggle                      |
| Game Bar capture off (session)                      | No  | Yes         | Yes         | Yes         | Toggle                      |
| Power throttling opt-out (game)                     | No  | Yes         | Yes         | Yes         | Toggle                      |
| Smart core targeting (hybrid CPUs)                  | No  | No          | Windows 10  | Windows 10  | Toggle                      |
| Disable core parking (plugged in)                   | No  | No          | No          | Yes         | Toggle                      |
| Pause Windows services (asks for admin)             | No  | No          | No          | Yes         | Toggle                      |
| Clear the standby memory list once (asks for admin) | No  | No          | No          | No          | Toggle (off by default)     |

Notes on each mechanism:

- **Game Mode** sets `AutoGameModeEnabled` and `AllowAutoGameMode` (`HKCU\Software\Microsoft\GameBar`) to 1. If a value is absent, Frameforge treats it as the Windows default (on) and does not write it. Only an explicit 0 is changed.
- **Priority** is set on the game process only. Real-time priority is never used.
- **Affinity** is a single 64-bit mask on the game. It only covers processor group 0.
- **Power plan** switches to High performance, or Ultimate if present, for the session, then returns to the exact prior plan. If neither exists, the option is unavailable until you consent to creating a copy named "Frameforge High performance" from a built-in template. That copy does not become active when created, is recorded in the app database, can be removed from the app, and user-created plans are never modified. Removal refuses any plan that was not created by Frameforge.
- **Timer resolution** requests 0.5 ms through `NtSetTimerResolution` and releases it at revert or game exit. It is unsupported on Windows 10 2004 and later builds below 22000 (builds 19041 to 21999), because there a timer request only affects the requesting program; nothing can change that. On Windows 11 (22000 and later) it works only when `GlobalTimerResolutionRequests` is 1. If it is off, Game Mode offers **Allow games to keep high timer resolution**: after you confirm and approve one Windows administrator prompt, Frameforge saves the current value of `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\kernel` > `GlobalTimerResolutionRequests`, sets it to 1 and tells you to restart Windows (choose Restart, not Shut down: Windows reads it at start-up and Fast Startup keeps the old session). Until you restart, the mechanism stays unavailable. **Turn back off** restores exactly the saved value. Frameforge never changes it otherwise.
- **Background apps** are limited to processes in the game's session and owned by the same user. Critical, system, security, anti-cheat and denylisted processes, the helper and Frameforge itself are never touched. You choose which apps are affected, up to 50. Suspend resumes each process exactly once. Close sends a window-close request and then terminates after 5 seconds; closed apps are not reopened, and that action cannot be reverted.
- **Clear the standby memory list once** (Custom only, off by default) calls `NtSetSystemInformation` with `SystemMemoryListInformation` and `MemoryPurgeStandbyList` once when the boost starts, after enabling `SeProfileSingleProcessPrivilege`. It runs inside the same administrator step as pausing services (one prompt for both), never during auto-boost, and is not reversible. It is harmless: Windows refills its cache as programs need memory.
- **Waiting for administrator approval.** The boost starts right away and works without the services or standby step. While Windows waits for you, Game Mode shows the step as "waiting for admin approval" and Stop is available; Stop (or ignoring the prompt for 2 minutes) withdraws the request, and a late approval changes nothing.

Session behaviour: the helper runs detached and reports every prior value before it changes it. On revert, a value is restored only if Frameforge's value is still in place. An external change is kept and shown as a conflict. A failed revert leaves a recovery banner with Retry and Dismiss. Auto-start, when enabled, watches library games in the background and starts one session per game process. CPU and RAM figures are system readings, not FPS.

## Data and Recovery

Desktop state is stored in `frameforge.db` under Electron's per-user `userData` directory, ordinarily `%APPDATA%\frameforge`. SQLite migrations use `PRAGMA user_version`, WAL, parameterised statements and transactions. Newer database versions are refused without deleting existing data. The database holds game paths and configuration that can identify local files, so keep it private.

Named app backups capture app settings, games and custom preset configuration. They are not Windows System Restore points and not full machine backups. Restoring one first creates a pre-restore app backup. Restoring app configuration does not undo Windows registry preferences; use the operation's rollback for those.

Interrupted registry operations and booster sessions are recorded in a durable journal and marked for recovery on the next startup. Recovery never overwrites an unexpected external value. Do not delete the database while a change needs recovery.

## Security

Frameforge runs as the current user (`asInvoker`). Only these actions ask for elevation, one UAC prompt per action, through the same helper: restore-point actions, pausing services and clearing the standby list during a boost, the Windows 11 timer setting, machine catalogue changes (including services, Large Send Offload and supported HAGS), and optional FPS capture. An elevated request only works while a short-lived request file next to its result file still exists, so a prompt answered after the app stopped waiting changes nothing. See [Security](docs/SECURITY.md) for the boundaries and the parts of the elevation and booster design that document does not yet cover.

## Privacy

Frameforge contacts the network in exactly two optional ways. Both are chosen on first run (one dialog, both default to off for statistics and a plain Yes/No for updates) and can be changed any time in Settings > Privacy and updates.

1. **Update checks** (if you allow them: at start and every 6 hours, or when you press Check for updates). The app asks `github.com` (and `objects.githubusercontent.com`, where GitHub serves release files) for the latest release. Nothing is downloaded until you press Download, and nothing is installed until you press Restart to update or quit the app. GitHub sees the usual request metadata (your IP address, the app's user agent); Frameforge does not add anything else. No update is installed while a Game Mode session is running.
2. **Anonymous usage statistics** (off unless you tick the box). Sent through [Aptabase](https://aptabase.com) (EU region, open source, no cookies, no persistent device ID). Only these events are ever sent, and only after you opted in:
   - `app_started`: Frameforge version and Windows build number
   - `mode_started`: the Game Mode mode (balanced, performance, competitive, custom)
   - `optimization_applied`: the id of a built-in optimization (for example `mouse-precision`)
   - `preset_applied`: the name of a built-in preset
   - `update_installed`: the new Frameforge version
   - `feature_opened`: which Frameforge page you opened (for example Settings)

   The Aptabase SDK adds the operating system name and version, the system locale, the Electron/Chromium version and a random session id that rotates after an hour of inactivity. Frameforge never sends game names, file paths, user names, PC names, hardware serial numbers or any free text. Aptabase does not store IP addresses. Turning the setting off stops sending immediately. Builds made without an Aptabase key (for example local builds) cannot send statistics at all; the setting then reads "Not available in this build".

### Logs and diagnostics (local only)

Frameforge writes short rotating text logs to `%APPDATA%\Frameforge\logs` (`main.log` for the app, `helper.log` for the Windows helper; each file is capped at 2 MB with 3 rotations). Your user name, profile path, PC name, game folders, emails, IP and MAC addresses and serial numbers are replaced as each line is written, and the logs never contain the statistics key or session ids. They are never uploaded. **Settings > Diagnostics** can open the folder, and **Export diagnostics...** shows you exactly what will go into a redacted .zip, which you save yourself and may attach to a [GitHub issue](https://github.com/PREETHAM1590/Frame-Forge/issues/new) (the **Report a problem** button opens that page with only the version and Windows build filled in).

Plain-language privacy policy: [docs/PRIVACY.md](docs/PRIVACY.md). See also the [privacy statement](docs/CODE_SIGNING_POLICY.md#privacy) and [Security](docs/SECURITY.md).

## Verification and Limitations

- [Phase Report](docs/PHASE_REPORT.md) lists the gate results, the manual checks that were performed, the checks that are still required, and the known limitations.
- [Feature Status](docs/FEATURE_STATUS.md) states, for each capability, whether it was verified on the development PC or only tested with fixtures or fakes.
- [Implementation Plan](docs/IMPLEMENTATION.md) records scope and ownership.
