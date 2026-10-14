# UI Phase A report

Screenshots (Electron, FRAMEFORGE_TEST_MODE=1, temp profile): C:/Users/badbo/AppData/Local/Temp/claude/D--Hone/67cc4c79-baba-4fa4-913c-a4afbd0e083f/scratchpad/ui-a
dashboard-1280.png, dashboard-1600.png, gamemode-1280.png, gamemode-1600.png

## Created
Tokens: src/styles/tokens.css (light theme variant included), base.css, ui.css, dashboard.css, gamemode.css, legacy.css (older views, retokened, 0 radius).
Fonts bundled via @fontsource (Space Grotesk, JetBrains Mono); CSP unchanged.
Primitives (src/components/ui/): Panel, CellGrid, StatCell, Meter, SectionHeader, Button, Badge/StatusTag, LinkButton, Toggle, Slider, SegmentedControl, Modal (Radix dialog, focus trap/restore), Toast, Skeleton, Empty/EmptyState, ErrorState, Busy, Disclosure, NavRail, TopBar, PageTransition, PageTitle, CountUp.
Dashboard parts (src/views/dashboard/): Hero, Alerts, BoostPanel, Matrix, QuickActions, RecentActivity.
Game Mode parts (src/views/gamemode/): model, ModeSelector, ModeCards, SessionPanel (RecoveryNotice, SessionLog), StartBoost, Enhancers, CustomMechanisms, BackgroundApps, LaunchSettings, NetworkCheck, HowItWorks.
Rail: Dashboard, Game Mode, Game library, Optimizations (child Presets), Restore & backups (child Activity), System, Settings.
Tool: tools/ui-shots.mjs.

## Gates
typecheck, lint, format:check, npm test (303), build, test:e2e (2), test:desktop all pass.
Test edits: boosterMechanismsUi opens collapsed details; gameIcons selector .gm-launch-row.

## Not done / notes
Other views (Games, Optimize, Restore, System, Settings) only retokened (Phase B). Dashboard shows no invented sensors (no DPC/thermal data exists).
