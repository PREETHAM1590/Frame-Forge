# Changelog

## 1.4.0

- **PC Health Check.** A read-only page, with a Dashboard card showing the score and the top three issues. It checks power source and Battery Saver, the Windows power mode and plan, the laptop maker's performance mode, which GPU runs your games, graphics driver age, refresh rate, memory channels and speed, GPU heat and power limits, disk space and type, memory use, background CPU, Game Mode, hardware-accelerated GPU scheduling, Memory Integrity, a pending restart, startup apps, overlays and whether a before and after FPS measurement exists. Each check says what it means and the expected effect, and offers a reversible fix through the existing paths or exact steps.
- **Smart mode.** The new default for new installs, for any game. It watches the first minute (CPU, per-core load, GPU load and clocks, memory), works out what limits the game (CPU, GPU, memory, heat or power, or a frame cap), applies only what helps that case, and saves a profile that is reused next launch and re-checked when the hardware or graphics driver changes. It never changes Windows Game Mode, never claims an FPS gain, and only clears the standby list when memory is tight and the game keeps growing. A fullscreen program that is not in the library is offered as "Add to library?"; nothing is added or boosted until you say yes.
- **This session changed.** One panel, live and in history, lists what every step of a boost really did (applied, already set, skipped, unavailable or failed, with the old and new value where Windows has one) and what was restored at the end. Smart mode shows its reasoning above it. The tray notification at the end of a session uses the same summary.
- **Close or pause apps while gaming.** Running apps grouped by program with icon, memory and CPU, with heavy non-essential ones suggested and pre-ticked. Voice chat, audio, input, overlay, security, anti-cheat and the game's own launcher are never suggested. The choice is saved for all games or one game. More Windows services can be paused for a session (Windows Update, Update Orchestrator, Delivery Optimization, Office Click-to-Run, Inventory, Data Usage, Imaging) and are started again afterwards. USB selective suspend is switched off on the Frameforge power plan during a session and put back afterwards.
- **Boost-start clean-up.** When a boost starts, Frameforge closes (politely, or ends) or pauses the apps you picked, trims the memory big background programs hold, and clears the standby list only when memory was tight. The result shows how much RAM was freed. Paused apps are resumed when the boost ends; closed apps can optionally be reopened (off by default, windows and tabs are not restored). It is switched on or off in Game Mode > Close or pause apps and in Settings.
- **A/B benchmark.** Timed FPS runs with Game Mode on and off, a comparison of average, 1% low and frame times, saved reports, and export to Markdown or CSV.
- **Cleanup and driver check.** System > Cleanup previews, then deletes only old temporary files and shader caches you tick (files in use are skipped). The driver check reads your graphics driver and links to the vendor's official download page; it never downloads or installs anything.
- **Startup apps.** A new page lists programs that start with Windows and switches them on or off the way Task Manager does, so both agree. Nothing is deleted, every change can be put back exactly, and security software, Windows components and driver helpers ask for an extra confirmation. Machine-wide items need one administrator approval.
- **Global hotkeys.** Start or stop a boost for the game you are in, cycle the boost mode and toggle the overlay from anywhere, including while Frameforge sits in the tray. Keys are configurable in Settings, a key another app already owns is reported as a conflict, and the whole feature can be turned off.
- **Closing the window.** The first time you close Frameforge it asks whether to minimize to the tray or quit, and remembers the answer (changeable in Settings).
- **In-game FPS overlay.** An optional transparent, click-through overlay with FPS, 1% low, a frame-time graph and CPU, GPU and memory readings. It shows during a boost or on demand, never takes focus, and is set up in Settings > Overlay. The tray and the hotkey toggle it.
- **Approve admin once.** Settings > Administrator access can install an optional Windows service, FrameforgeBroker, after one Windows approval. While it is running, restore points, System Protection, service pausing, standby-list clearing, the timer setting, machine-wide optimizations (except the security-lowering ones, which always ask Windows), machine-wide startup app switches and FPS capture no longer ask Windows each time, and auto-boost does its administrator steps silently. It is off by default, does only those allowlisted steps for the one Windows account that approved it, and is removed from the same page (one approval) or by uninstalling Frameforge. If it is not running, every step asks Windows as before, and background work skips the step instead of prompting. Security fixes in this release: items that lower Windows security never use the service. See the trade-offs in `docs/SECURITY.md`.
- **Per-game settings guide.** In a game's drawer, "Recommended settings" gives guidance for your PC (CPU, GPU, video memory, laptop), a frame-cap and Reflex recommendation, and uses Smart mode's finding for that game when there is one. It is guidance only; Frameforge never edits a game's files.
- **Diagnostics and logs.** Settings > Diagnostics previews and saves a redacted diagnostics .zip (versions, hardware summary, booster configuration, recent sessions, optimization history, activity, FPS summaries, capabilities, errors and logs), opens the logs folder, and opens a GitHub issue with only the version and Windows build filled in. Nothing is uploaded. Local rotating logs in `%APPDATA%\Frameforge\logs` (`main.log`, `helper.log`; 2 MB each, 3 rotations) are redacted as they are written.
- **Settings.** Sections for Overlay, Hotkeys, Administrator access, Diagnostics and the close action sit alongside the existing Preferences, Booster, Privacy and updates, and Data management.
- Helper additions: `health` (read-only PC facts), `foreground` (the foreground fullscreen program), working set, CPU and path in the process list, and the CPU clock percentage in the monitor sample.

## 1.3.1

- Smaller, faster download: the installer no longer carries unused UI libraries, extra Chromium languages, debug symbols or helper translations.
- Ignore the local .claude-flow tool folder in the repository.
- Added a privacy policy and a code signing notice on the download page.

## 1.3.0

- Optional update checks at startup, every six hours, or from Settings and the tray. Downloads happen when requested. Installation waits until a boost has ended and the app quits; closing to the tray keeps it running.
- Optional anonymous usage statistics, off by default. First run asks once; both privacy choices can be changed in Settings. Only the events and values listed in the README can be sent.
- Background mode with one tray menu for opening the window, auto-boost, mode and status, stopping a boost, updates and quitting. Closing destroys the window to free its memory. Launch at sign-in starts hidden, and a second launch opens the existing app.
- Auto-boost watches library games and restores their settings when they exit. Pages load when opened. Software rendering stays enabled to keep tray CPU use low.
- Monitor shows live CPU, GPU, memory, disk and network readings. Sampling stops when the window is hidden or destroyed. Optional FPS capture reads DirectX present events through an administrator helper and saves local session summaries.
- New reversible settings for ten Windows services, Large Send Offload on physical adapters, NVIDIA global power and pre-rendered frame settings, Windows Photo Viewer registration and Windows Mobility Center. Service settings preserve the exact start type and run state and are blocked during a boost.
- Hardware-accelerated GPU scheduling is available only when the GPU and driver report support. It needs administrator approval and a restart, and rollback restores the exact prior value, including an absent override.
- Removed information-only catalogue rows, including startup, driver and DNS reviews. Startup management and driver checks are planned for 1.4.0.
- Fixed publishing into an existing helper folder so newer dependencies replace older runtime DLLs. Monitor charts update with each sample without continuous animation, reducing software-rendering CPU use.

## 1.2.2

First public release built by GitHub Actions (1.2.1 was never published: its release build failed before shipping, so its changes ship here).

- **MIT license.** Frameforge is now open source under the MIT license, with `THIRD_PARTY_NOTICES.md` listing bundled components (including the OFL-licensed fonts).
- **Per-user installer, no administrator needed.** The installer installs to `%LOCALAPPDATA%\Programs\Frameforge` with Start menu and desktop shortcuts and a proper uninstaller, and never asks for elevation. Administrator prompts still appear only for the optional actions that need them.
- **Releases are built by GitHub Actions** with a published `SHA256SUMS.txt`, so every download can be verified.
- **Signing-ready.** The release workflow can sign the installer through SignPath Foundation once the project is approved; see `docs/CODE_SIGNING_POLICY.md`. Until then the installer is unsigned.
- **Removed the default menu bar** (File, Edit, View, Window) from the app window.
- **Docs.** Removed third-party reference material from the repository and reworded research notes neutrally.

## 1.2.0

- **Game Enhancers on Game Mode.** A toggle list of enhancers (Power Plan, CPU priority, CPU affinity / smart cores, GPU Priority, core parking, power throttling, Game Bar capture, timer resolution, background apps, pause services, standby purge) that works on every mode, with per-enhancer overrides and a reset to the mode's defaults.
- **New: GPU Priority.** Raises the game's GPU scheduling priority; on by default in Competitive mode.
- **Fixed a scan progress race** where progress events could be missed between the page rendering and subscribing.
- **Tooltips are keyboard-accessible** (focus shows them, Escape dismisses).

## 1.1.2

- **Restore points: clearer when Windows skips creating one.** When Windows skips creating a point because a recent one exists, Frameforge now says so (with the existing point's description and time) instead of suggesting System Protection is off. "Create anyway" temporarily lifts the limit, verifies the new point and restores the setting; a fallback creation path is used if needed.

## 1.1.1

- **No shared administrator prompts when a game exits on its own.** The elevation gate is held until the paused services are restored, so a game that closes by itself no longer opens a second prompt over another action.
- **The Optimizations preview marks settings Windows already has**, and the header counts only the changes that will be made.
- **Fonts load without Content Security Policy errors.** Bundled fonts are emitted as files instead of inline data, so the console stays clean.
- **Boost without administrator approval.** Starting a boost offers "Skip steps that need administrator approval" for that start only (services and standby list are shown as skipped, the rest of the mode runs). The choice is never remembered.
- **No false failure when the game is not running.** Start boost now says to start the game first instead of logging a failed request.
- **A fresh session log for each Game Mode session**, instead of stacking under the previous one.
- **Game Mode keeps the game you selected** after a session ends and when you return to the page, unless that game was removed.

## 1.1.0

### 43 new optimizations

- **43 new Windows optimizations** in the Optimizations page, grouped as standard, advanced and security trade-offs. Standard items change current-user settings (shortcut naming, Sticky Keys shortcut, transparency, Explorer start folder and similar). Advanced items change machine settings (HKLM and boot-store values) through one administrator approval. Every item shows the exact setting, its before and after value, whether a restart is needed, and how it is rolled back.
- **Security trade-offs with guardrails.** A small set of items lowers Windows security (for example turning off UAC or Defender policy). They are never part of a preset, are applied one at a time, offer a restore point first, need an acknowledgement box and the item's name typed, and are listed on the Dashboard with **Restore all security settings** until they are rolled back.
- Items that Windows ignores, that only inform, or that this PC cannot do are listed under "Not offered or information only" with the reason, instead of looking like a missing feature.

### Fixes for "unavailable" features

- Game Mode and Optimizations say why a step is unavailable and, where possible, how to enable it: **Create High performance plan**, **Choose the game's .exe** for per-game launch settings (a scanned game whose program is unknown now reads "Choose the game's .exe to enable" instead of "Unsupported").
- Applying a setting that Windows already has says **Already set - no change**, writes nothing and leaves no rollback entry.

### Redesigned interface and apply flow

- New interface: dashboard with a security and drift banner, game library with real launcher icons, Game Mode, Presets, Restore & backups and Activity, light and dark themes, bundled fonts, reduced-motion support.
- A step-by-step **apply flow**: review, optional restore point, confirmation, progress and a clear result (applied, partially applied, already set, not applied, reverted by Windows, failed, recovery needed). If an attempt fails, your typed confirmation is kept and the next attempt re-checks Windows first.

### Elevation gate and freshness guards

- Every action that opens a Windows administrator prompt (restore points, optimizations, recovery, the timer setting, the services step) shares one gate, so two prompts never open together. All four elevated helper entry points (`--elevated`, `--elevated-services`, `--elevated-timer`, `--elevated-optimize`) act only on a fresh request: a prompt answered late, or after Cancel or Stop, changes nothing.
- The Game Mode session holds the gate only while a prompt is actually open (waiting for an answer, or while Stop restarts paused services), not for the whole session.
- A restore point whose prompt nobody answers ends after 2 minutes as **Not approved - cancelled**. A **Cancel request** button withdraws it earlier. While the prompt is unanswered the page says "Waiting for administrator approval", not "Windows may still be creating a restore point".

### Bug fixes

- Declining or missing the administrator prompt for an optimization no longer opens a second prompt to "restore" a change that never happened, and no longer produces a false "recovery needed" row. The result reads "Not applied - administrator approval declined".
- A rollback whose prompt is declined or blocked leaves the item restorable and says so, instead of turning into "recovery needed".
- The Dashboard security banner and **Restore all security settings** count security items that are applied or in recovery needed, and the restore loop stops at the first item that is not restored and names the ones still lowered.

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
