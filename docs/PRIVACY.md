# Frameforge privacy policy

Last updated: 2026-10-15

Frameforge runs locally on Windows. Core desktop features work offline. This page explains the two optional network features, what they send, and how to turn them off.

## What stays on your PC

- Your game library, detected game paths, configuration, Game Mode sessions and app backups are stored in `frameforge.db` under your per-user app data folder (ordinarily `%APPDATA%\frameforge`). That database is not uploaded.
- Short text logs (`main.log`, `helper.log`) are kept in `%APPDATA%\Frameforge\logs`, capped at 2 MB per file with 3 rotations. Your user name, profile path, PC name, game folders, emails, IP and MAC addresses and serial numbers are replaced as lines are written. Logs stay on this PC. Settings > Diagnostics can open the folder or export a redacted .zip that you preview and save yourself; Frameforge never uploads it, and only you decide whether to attach it to a GitHub issue.
- Monitor's system counters and FPS capture summaries are shown locally.

## The two optional network uses

Frameforge contacts the network in exactly two optional ways. Both are chosen on first run (one dialog: statistics default to off, and updates are a plain Yes/No) and can be changed at any time in **Settings > Privacy and updates**.

### 1. Update checks (your choice: on or off)

- When enabled, Frameforge checks at start-up and every 6 hours, or when you press **Check for updates**.
- The app asks `github.com` (and `objects.githubusercontent.com`, where GitHub serves release files) for the latest release.
- Nothing is downloaded until you press **Download**, and nothing is installed until you press **Restart to update** or quit the app.
- No update is installed while a Game Mode session is running.
- GitHub sees the usual request metadata, such as your IP address and the app's user agent. Frameforge does not add anything else.

### 2. Anonymous usage statistics (off unless you turn it on)

- Statistics are sent through [Aptabase](https://aptabase.com), using its EU region. Aptabase is open source and uses no cookies and no persistent device ID.
- Only these events are ever sent, and only after you opt in:

| Event                  | What it contains                                                  |
| ---------------------- | ----------------------------------------------------------------- |
| `app_started`          | Frameforge version and Windows build number                       |
| `mode_started`         | The Game Mode mode (balanced, performance, competitive, custom)   |
| `optimization_applied` | The id of a built-in optimization (for example `mouse-precision`) |
| `preset_applied`       | The name of a built-in preset                                     |
| `update_installed`     | The new Frameforge version                                        |
| `feature_opened`       | Which Frameforge page you opened (for example Settings)           |

- The Aptabase SDK adds the operating system name and version, the system locale, the Electron/Chromium version, and a random session id that rotates after an hour of inactivity.
- Aptabase does not store IP addresses.
- Frameforge never sends game names, file paths, user names, PC names, hardware serial numbers, or any free text.
- Builds made without an Aptabase key (for example local builds) cannot send statistics at all. The setting then reads "Not available in this build".

## Turning it off

- **Statistics:** untick the box in Settings > Privacy and updates. Sending stops immediately.
- **Update checks:** choose No in Settings > Privacy and updates, or turn the setting off there at any time. Frameforge then makes no update request.
- With both off, Frameforge makes no network requests for these purposes. Core desktop features work offline.

## Retention

Statistics that reach Aptabase are retained under Aptabase's own data retention policy. See [aptabase.com](https://aptabase.com) for its current terms.

## Contact

Questions or concerns: open a GitHub issue at <https://github.com/PREETHAM1590/Frame-Forge/issues>.

This policy describes the app as released. The statement of what the program does with network access is also in the [code signing policy](CODE_SIGNING_POLICY.md#privacy).
