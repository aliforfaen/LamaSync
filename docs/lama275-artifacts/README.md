# LAMA-275 before/after artifacts

Before captures: 2026-08-22, base + terminology doc (pre-design work).
After captures: 2026-08-23, at TUI pass 1 (tokens + web shell + page sweep +
TUI tab titles/selection). Local dev server, empty fleet, dev-key.

## Naming
- `web-login-1440.png`, `web-<page>-1440-dark.png` — 1440×900 dark
- `web-dashboard-1440-light.png` — light theme
- `web-{dashboard,folders}-{768,360}-light.png` — responsive checks; the 360
  folder shots show the closed state, use agent-browser to see the drawer
- `tui/*-120x36.txt`, `tui/this-device-80x24.txt` — tmux capture-pane text;
  both 80×24 captures show the pre-existing tab-bar truncation (`›`) that
  motivates the LAMA-276 chrome-reduction pass

## Key before→after deltas visible in artifacts
- Web nav: flat 10-item wrapping top bar → grouped left rail
  (Overview / Sync / Apps / Storage & tools / System) with drawer <900px
- Page titles: "Command Center"/"Hosts"/"Backends"/"Dotfiles"/"Operations" →
  Dashboard/Devices/Storage/App settings/Activity, each with a one-sentence purpose
- Folders table: Backend/Assignments columns → Storage/Set up on
- TUI tabs: Local/Fleet/Dotfiles/Logs → This device/All devices/App settings/
  Activity; consistent selection colors from app/palette.ts

## LAMA-276 pass-2 deltas (2026-08-23, re-captured)
- Third tab is now **Backups & apps**: fleet-wide backup-folders block
  (`this-device-80x24.txt` shows the new 80-col footer + this-device view;
  `more-80x24.txt` is the new More tab). GitHub is a drill-in under More
  (tab bar still selects More while the GitHub list is open; Esc returns).
- Chrome: per-view borders gone (content starts right under the tab bar's
  underline), the separate hint line is merged into the single status/hint
  bar (“[ok] Loaded 3 folder(s).” replaces the “[?] help ...” row).
- Tab-bar overflow at 80 cols persists for six task-oriented tabs (›);
  tracked in the dogfood findings log — abbreviations accepted.
