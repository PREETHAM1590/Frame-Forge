# Frameforge

An original, local Windows gaming configuration application built with React, TypeScript, Vite, Tailwind, Radix, Electron and a C#/.NET Windows helper. Core desktop features work offline. Frameforge makes no FPS or latency claims.

## Setup

Use Windows x64, Node.js 22.13 or later, npm and the .NET 8 SDK. Node's built-in `node:sqlite` is required for repository tests. The packaged helper is self-contained; an installed app does not require a separate .NET runtime.

```powershell
npm ci
npm run windows:publish
npm run build
npm start
```

For development, `npm run dev:desktop` opens Electron against Vite on `http://127.0.0.1:5173`. It expects that port to be available. `npm run dev` opens the browser demo only: hardware is labeled demo, configuration is stored in browser local storage, Windows changes are unavailable and there is no native executable picker. Use the desktop app for real discovery and durable SQLite storage.

If using the optional local SDK in this workspace rather than an SDK on PATH:

```powershell
.\.tools\dotnet\dotnet.exe publish windows/Frameforge.Windows/Frameforge.Windows.csproj -c Release -r win-x64 --self-contained true -o windows/publish
.\.tools\dotnet\dotnet.exe test windows/Frameforge.Windows.Tests/Frameforge.Windows.Tests.csproj
```

## Commands

| Command                   | Purpose                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run build`           | Type-check and build renderer, main process and preload                                             |
| `npm run typecheck`       | Check renderer and Electron TypeScript                                                              |
| `npm run lint`            | ESLint                                                                                              |
| `npm run format:check`    | Check formatting                                                                                    |
| `npm test`                | Vitest UI, contract, service, persistence and operation tests                                       |
| `npm run test:e2e`        | Playwright browser workflows; requires Chromium installed through `npx playwright install chromium` |
| `npm run test:desktop`    | Electron smoke test                                                                                 |
| `npm run windows:build`   | Build the .NET helper                                                                               |
| `npm run windows:test`    | Run xUnit tests                                                                                     |
| `npm run windows:publish` | Publish the self-contained Windows x64 helper                                                       |
| `npm run package:win`     | Publish helper, build application, create NSIS installer in `release/`                              |

Installer configuration is included. Consult [Phase Report](docs/PHASE_REPORT.md) for what has actually been built and tested; installer configuration alone does not establish installation verification. Development requires dependency downloads; core installed features do not.

For browser tests, keep a Vite server running first. The default test URL is port 5173; use `PLAYWRIGHT_BASE_URL` to override it. This workspace's preview is running on port 5174. To smoke-test a packaged executable, set `FRAMEFORGE_EXECUTABLE` to its absolute path before `npm run test:desktop`. The unsigned Windows x64 development installer is `release/Frameforge Setup 0.1.0.exe`; install/uninstall and live registry mutations have not been tested on this PC.

## Windows Preferences

Only two system changes are supported when the Windows helper is available:

| Preference                      | Affected current-user settings                                                                     | Caveat                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Consistent pointer movement     | `HKCU\Control Panel\Mouse`: `MouseSpeed`, `MouseThreshold1`, `MouseThreshold2`, strings set to `0` | Sign out and back in for Windows to reload; raw-input games may ignore it     |
| Disable background game capture | `HKCU\Software\Microsoft\Windows\CurrentVersion\GameDVR`: `AppCaptureEnabled`, DWORD set to `0`    | Capture applications may need reopening; third-party recorders are unaffected |

These do not require administrator elevation. Preview captures exact previous values, including absent values. Confirmation uses a single-use token valid for five minutes, rejects settings changed since preview, creates an app configuration backup, saves a durable Windows snapshot, writes only allowlisted values and verifies the result. Presets use the same confirmation process. No automatic reboot or sign-out occurs. These registry preferences have not been applied to the development user's machine during verification.

Power policy, GPU scheduling, DNS, drivers, third-party startup entries and Windows services are visibly unsupported. The app does not change Defender, firewall, Windows Update, BIOS or boot configuration.

## Data and Recovery

Desktop state is stored in `frameforge.db` under Electron's per-user `userData` directory, ordinarily `%APPDATA%\frameforge` in development. SQLite migrations use `PRAGMA user_version`, WAL, parameterized statements and transactions. Newer database versions are refused without deleting existing data. Keep the database private: game paths and configuration can identify local files.

Named backups capture app settings, games and custom preset configuration. They are not Windows System Restore points or full machine backups. Restoring one first creates a pre-restore app backup. Restoring app configuration does not restore Windows registry preferences; use the operation's rollback action for those.

Rollback restores the captured registry values and verifies them. It refuses to overwrite an unexpected external value. Failure or cancellation attempts recovery after the helper exits. Incomplete recovery remains `recovery-needed`; interrupted operations are marked for recovery on the next startup. Inspect the activity entry and retry rollback after reviewing conflicting settings. Clearing activity preserves records needed for rollback or recovery. Do not delete the database while a change needs recovery.

Game Mode stores the selected game's profile and active state in app configuration. It does not launch games, measure FPS, change process priorities or automatically apply Windows tweaks. Game discovery reads launcher metadata (Steam, Epic Games, GOG, Xbox app, Microsoft Store, EA app, Ubisoft Connect, Battle.net, Riot, Rockstar, itch) and Windows uninstall entries, and can scan a folder you choose; custom executables are selected through a native `.exe` picker. Microsoft Store and Game Pass titles are detected when their package ships a `MicrosoftGame.config`; other Store apps cannot be detected and may require adding games manually. Startup at sign-in is available only in the packaged app.

See [Feature Status](docs/FEATURE_STATUS.md), [Security](docs/SECURITY.md) and [Implementation Plan](docs/IMPLEMENTATION.md) for scope and boundaries.
