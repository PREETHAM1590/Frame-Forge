# Feature Status

Status describes behavior, not performance benefit. Real Windows changes require the desktop helper; browser development never advertises mutation capabilities.

| Capability                                                                            | Status                     | Scope or limitation                                                                                      |
| ------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| Navigation, responsive dark workspace, dialogs, loading/error/empty states            | Implemented                | React, Radix controls and local font; final UI verification tracked separately                           |
| Dashboard and hardware information                                                    | Implemented                | Read-only .NET Windows discovery; unavailable fields have warnings; runtime fallback when helper missing |
| Browser hardware and configuration                                                    | Mocked                     | Labeled demo data and browser local storage, separate from desktop SQLite                                |
| Catalogue, search, filters, risk and prerequisites, details                           | Implemented                | Unsupported items remain visibly unavailable                                                             |
| Optimization preview and explicit confirmation                                        | Implemented                | Actual captured Windows values, expiring single-use token, conflict check                                |
| Recommended, Beginner, Balanced, Gaming and custom presets                            | Implemented                | Select from supported preferences; preview and confirm before applying                                   |
| Settings, activity, named backups and configuration restore                           | Implemented                | Desktop SQLite migrations; pre-restore configuration backup                                              |
| Steam game discovery and custom executable picker                                     | Implemented                | Standard Steam roots and metadata; native desktop picker; no game execution                              |
| Per-game profiles and Game Mode                                                       | Implemented, app-only      | Saved configuration and selected-game status; no automatic process/system changes                        |
| Launch at sign-in                                                                     | Implemented, packaged only | Own application startup setting; unavailable in development/browser                                      |
| Theme, notification and diagnostics preferences                                       | Implemented                | Local preferences; no network telemetry or uploads                                                       |
| Pointer acceleration preference                                                       | Implemented                | Current-user strings, snapshot, verify and rollback; requires Windows reload                             |
| Game DVR capture preference                                                           | Implemented                | Current-user DWORD, snapshot, verify and rollback; does not manage third-party capture                   |
| Windows mutation test adapter                                                         | Mocked                     | Explicit test-only capabilities for deterministic tests                                                  |
| Interrupted operation recovery and conservative rollback                              | Implemented                | Durable journal; external conflicts remain visible rather than overwritten                               |
| Power plans, GPU scheduling, DNS, drivers, services, third-party startup modification | Unsupported                | Catalogue explains limitation; no successful-operation simulation                                        |
| Windows System Restore points, process priority tuning, automatic game optimization   | Unsupported                | App configuration backups and profiles do not imply these functions                                      |
| FPS, latency, temperatures and live GPU utilization measurements                      | Unsupported                | No inferred readings or claimed improvements                                                             |
| Signed distribution and update delivery                                               | Planned                    | Not configured or verified                                                                               |
| Broader Steam paths and other launcher discovery                                      | Planned                    | Manual executable selection is available now                                                             |
| Installer                                                                             | Built                      | NSIS Windows x64 installer produced; packaged executable smoke passed; install/uninstall untested        |

Real hardware discovery has been exercised. Live registry mutation on the user's PC has not been exercised; fake-registry and orchestration tests provide bounded evidence, not an end-to-end machine rollback guarantee. See [Phase Report](PHASE_REPORT.md) for current verification.
