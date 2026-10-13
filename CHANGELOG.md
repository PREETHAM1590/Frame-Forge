# Changelog

## 1.0.1

### Features that used to say "unavailable" can now be turned on

- **High performance power plan.** On PCs that only have Balanced and OEM plans, the Optimizations page, the Presets page and the preset preview now offer **Create High performance plan…** right where the plan is reported missing. After you confirm, the plan is created and the optimization works immediately, with no restart. If Windows refuses (some laptops do), it says so and nothing is created.
- **High timer resolution on Windows 11.** Game Mode offers **Allow games to keep high timer resolution**. It turns on Windows' `GlobalTimerResolutionRequests` setting after one administrator approval, saves the old value, asks you to restart Windows, and can be turned back off. Until you restart, the step stays unavailable. On Windows 10 it stays unsupported, with the reason shown, because Windows 10 never lets one program's timer request reach another.
- **Clear the standby memory list.** A new opt-in step under Custom clears Windows' cached memory once when a boost starts. It is off by default, asks for administrator approval together with the services step, cannot be undone and is harmless.
- **Game Bar capture blocked by policy** now reads "already off by policy" instead of looking like a missing feature.
- **Launch at sign-in** says "Available in the installed app" in development builds; it stays on in the installed app.
- Readings Frameforge cannot take (temperatures, FPS) now say why and what to use instead.
- **Launch settings for games found by a scan without a known .exe** (Steam, Riot and similar) are no longer a dead end: Game Mode shows **Choose the game's .exe…**, which opens a file dialog in the game's folder and saves the choice.

### Fixes

- **A service that started and then stopped again** (for example SysMain) was reported as restored. Frameforge now watches it for 5 seconds, retries once, and if it still stops reports it as failed with Windows' error number and keeps Retry recovery available.
- **An unanswered administrator prompt no longer stalls a boost.** The boost goes active straight away and shows "waiting for admin approval". Stop is available and withdraws the request. After 2 minutes the step is skipped. A prompt that is still on screen afterwards, or one you approve late, changes nothing. The same protection covers restore-point requests.
- **Two administrator prompts can no longer open at once.** Restore points, recovery, the timer setting and the services step take turns, and Game Mode, power plan and restore requests no longer start while another one is running.
- **Disable background game capture** and the Game Bar step of a boost no longer undo each other. While a boost session exists, the optimization cannot be applied or rolled back, and a boost leaves capture alone when the optimization is applied.
- **Launch settings stuck in "recovery needed"** now have a **Forget saved value** button (with a confirmation).
- **Restoring an older app backup** is refused, with a clear message, while a game that is missing from the backup still has a saved launch-setting value.
- **Game Mode on first launch** now selects a game as soon as the first scan has found one.
- **Network check** on a local or unroutable address is recorded in Activity as "not run" with the reason, not as "Request failed".
- Test suite: a flaky UI test was made reliable, and `npm run test:e2e` now starts the dev server itself.

## 1.0.0

First public release.

- Game library with detection for Steam, Epic, GOG, Xbox app, Microsoft Store, EA app, Ubisoft Connect, Battle.net, Riot Games, Rockstar Games, itch.io and Windows Uninstall entries, a startup scan, icons and a "removed games" list.
- Game Mode with Off, Balanced, Performance, Competitive and Custom modes: game priority and CPU affinity, Windows Game Mode, a performance power plan, timer resolution, lowering, suspending or closing background apps, Game Bar capture off, power-throttling opt-out, smart core targeting, core parking and pausing a safe list of services. Every change is saved first, verified, and reverted when the game exits, on Stop, on quit or after a crash.
- Per-game launch settings (high-performance GPU preference, fullscreen optimizations) with preview and Revert.
- Reversible Windows preferences (pointer acceleration, background game capture, performance power plan) with preview, verification and rollback.
- Windows restore points through a UAC-elevated helper, app configuration backups, activity journal and recovery after interrupted changes.
- Network check (ping, jitter, loss) to any host.
- Unsigned Windows x64 installer. No telemetry.
