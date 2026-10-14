# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org). (This statement applies once the project is approved and releases are signed. Until then releases are unsigned.)

## What is signed

Only release artifacts built from this repository's source by the GitHub Actions workflow `.github/workflows/release.yml` are submitted for signing: the Frameforge installer (`Frameforge-Setup-<version>.exe`). Artifacts are never built or signed on a developer machine.

## Team roles

| Role      | Member                                          |
| --------- | ----------------------------------------------- |
| Author    | [PREETHAM1590](https://github.com/PREETHAM1590) |
| Committer | [PREETHAM1590](https://github.com/PREETHAM1590) |
| Reviewer  | [PREETHAM1590](https://github.com/PREETHAM1590) |
| Approver  | [PREETHAM1590](https://github.com/PREETHAM1590) |

Each signing request is approved manually by the approver after confirming it comes from a tagged release build.

## Privacy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. The only exceptions are the two opt-in features below, which the user turns on or off explicitly. A plain-language version of this statement is in the [Frameforge privacy policy](PRIVACY.md).

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

### Update signature verification

Releases are unsigned until SignPath approves this project. Once signed, set `build.win.publisherName` in `package.json` to the certificate subject (as printed by the signing certificate) so electron-updater refuses any update that is not signed by that publisher, and keep SignPath's output as the published installer (the release workflow already hashes whichever installer it publishes into `latest.yml`). Do not set `publisherName` before the first signed release: it would make updates from unsigned builds fail verification.

## Licensing

Frameforge is released under the [MIT license](../LICENSE). Bundled third-party components are listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
