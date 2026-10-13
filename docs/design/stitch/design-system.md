# Stitch project "PC Game Booster Optimizer" (12237907486972165874) - design system

Two design systems exist. The 18 screens use **Aura Monolith** (orange brutalist). The project-level theme is the older **Aura OS** (cyan, rounded) and is NOT used by the screens.

## A. Aura Monolith (used by all 18 screens; asset e2e0a0ca2b48457bb97ba7fc9fa66723)

- Fonts: Space Grotesk (display/body, 900-weight uppercase headings), JetBrains Mono (telemetry, labels, tags, tabular numerals). Material Symbols Outlined icons.
- Colors: canvas #0d0e11 / #121316; rails and header #090a0d, #050608; alt cell #12141a; container #181a22; hover/focus #20232d; wireframe border #262930 (1-2px); text #f5f5f7, muted #9ba0ad, dim #5e6370; primary #ff5500 (container #ff5708, tint #ffb59c); secondary #ff7700; tertiary/caution #ffaa00; error #ff3b30.
- Shape: 0px radius everywhere. No shadows; depth via 2px borders, top accent rule (border-t-2 border-primary), alternating #0d0e11/#12141a tiles. Header = #090a0d at 95% with a tiny backdrop blur.
- Spacing: gutter 0px (cells share borders), margin 2rem, scale 0.25/0.5/1/1.5/2rem; card padding p-6/p-8.
- Components: primary button solid #ff5500 with black uppercase text (hover to white/amber); secondary #12141a with 2px #262930 border and mono text; badges 9-11px mono uppercase with 1px border (nominal orange, caution amber, dormant grey); meters flat h-2/h-3, #181a22 track, orange fill, stepped ticks; square orange/black toggles; nav rows with border-b, active row solid #ff5500 with black bold text and mono index 01-06 on the right.
- Layout: fixed left sidebar (w-64/w-72: AURA logo + V2.4, six numbered items Home, Game Mode, Games Library, Optimize, Safety & Backups, System & Topology; Settings + chassis/target-node footer) and fixed top telemetry bar (status, core freq, temp, bus load, window buttons, avatar).

## B. Aura OS (project theme from get_project; not used by screens)

Dark matte/glass: background #101319, primary #38BDF8 cyan (on-primary #00354A), secondary #F59E0B amber, tertiary #10B981 sage, neutral #13161C with elevations #1A1E26 / #222732 / #2D3342, ghost borders rgba(255,255,255,.07-.12). Hanken Grotesk + JetBrains Mono, radius 8px (cards 16px, pills full), 12-col grid, margin 2.5rem, gutter 1.5rem, soft shadows and 16px blur on level-2 panels. Typography scale: headline-xl 40px/600 down to label-sm 10px mono. Full Material-3 token list (surface-container-_, on-_, *-fixed) is in the project's designTheme.designMd.
