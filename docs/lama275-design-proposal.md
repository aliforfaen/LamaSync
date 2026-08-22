# LAMA-275 design proposal — web UI + TUI shell overhaul

Companion to the LAMA-275 work order.

> **VERDICT (owner, via chat 2026-08-22): D1–D5 APPROVED as recommended,
> with one addition — an "Apps" destination in navigation (see D2/D3
> amendments below). Implementation may proceed.**

Before-screenshots at representative sizes are still pending (needs a dev
server + browser session); they will be captured before implementation starts
and attached to LAMA-275. The code-level inventory below was done against the
current tree so the recommendations are grounded regardless.

## Current-state inventory (code-level)

### Web UI (`packages/web-ui/src/`)
- Nav: flat peer list of 10 items in a horizontal bar (`components/Nav.tsx`):
  Dashboard · Hosts · Folders · Backends · Dotfiles · Conflicts · Operations ·
  Data · Admin (+ Swagger link, theme toggle). Implementation categories, not
  task groups; wraps rather than adapts on narrow screens.
- Pages mirror DB concepts one-to-one (Hosts = hosts table, Backends =
  backends, Operations = operation_log…). No page-context treatment (title +
  one-sentence purpose), no max-width strategy, dense 11–14px type dominates
  (`index.css`, ~30 small-font rules), single `--bg/--panel` surface model,
  primary vs destructive actions not visually ranked.
- Dark/light themes exist as paired CSS variable sets — good foundation.
- GettingStarted + AddHostGuide already exist as onboarding scaffolding.

### TUI (`packages/tui/src/views/`, `flows/`, `app/shell.ts`)
- Six top-level views named by implementation category: Local · Fleet ·
  Dotfiles · Logs · Conflicts · GitHub. No visible "which device am I" framing
  beyond hostname strings.
- Permanent chrome stacks: tab bar + key-hint line + bordered page shell +
  per-view hotkey footer + status line — several rows before content starts.
- Selection state and contextual actions vary per view; help is a fixed-size
  box; hotkeys assume memorization (`w`, `p`, `s`, `n`, digits, brackets).
- Wizards (setup, backup-setup, dotfile-manifest) use WizardRunner correctly;
  backup wizard exposes raw "Cron expression" as a step title.

## Recommendations on the five owner decisions

### D1 — Visual direction: **warm personal homelab utility, restrained technical**
Keep dark/light pairs and monospace for machine data, but shift the default
register: proportional type for labels/intent, comfortable sizes (14px base,
11px only for dense tables), softer surfaces, one accent color carrying the
brand. Rationale: this is a personal fleet tool used at home, not an NOC
console; the audit history (2026-08-08 UX review) repeatedly flags
"operations console" coldness. Terminal-flavored identity survives via the
TUI and monospace conventions, so we don't lose honesty.

### D2 — Web navigation: **grouped left rail on desktop, drawer below ~900px**
Five groups replacing the ten flat peers *(amended per owner: explicit Apps
group)*:
- **Overview**: Dashboard
- **Sync**: Devices (hosts), Synced folders, Conflicts
- **Apps**: App settings backups (dotfiles); future app-preset work lands here
- **Storage & tools**: Storage destinations (backends), Data browser
- **System**: Activity (operations), Admin
Swagger/theme/sign-out move to a subdued footer/user area of the rail.
Rationale: left rails scale (more pages are coming from other LAMA-249
children), give room for group labels that teach the vocabulary, and collapse
cleanly into a drawer. Top nav would wrap again at exactly the widths we need
to support. The Apps group gives application-level protection its own home
instead of burying it under storage.

### D3 — TUI information architecture: **task-oriented tabs**
`This device · All devices · Backups & apps · Conflicts · Activity · More`
- This device ← Local (answers "am I synced?" first)
- All devices ← Fleet
- Backups & apps ← backup folders + dotfile/app-settings views surfaced from
  folder types *(owner's Apps addition applied here; keeps the tab count at six)*
- Conflicts unchanged · Activity ← Logs + operation stream merged view
- More ← GitHub + settings/tools entry points
Rationale: matches the mental model of "my stuff, everywhere, protected";
implementation categories remain reachable inside the new views. Functionality
is moved, never removed.

### D4 — GitHub TUI view: **move under `More`**
It's an integrations concern, not a core destination. Keep all functionality
(release checks etc.) one level deeper; revisit removal later only if unused.

### D5 — Supported viewport floor (documented assumption, awaiting owner)
- Browser: **360px** wide usable (large phones) first-class; tables switch to
  stacked card layout below 700px.
- Terminal: **80×24** first-class; layouts must survive 60×20 degraded but
  readable; adaptive help collapses below 100×30.
If the owner's real floor differs (e.g. no phone use expected), say so in
LAMA-275 comments and D2/D5 responsive work simplifies.

## Cross-cutting contracts proposed

- Surface levels: canvas → panel → raised/modal → inset(technical). Four CSS
  variable tiers per theme; same semantics in TUI palette.
- Status semantics: success/warning/critical/muted defined once (web CSS vars
  + TUI ANSI mapping), always paired with text/icon cues.
- One primary action per page/view; destructive actions visually separated.
- Vocabulary per `docs/terminology.md` applied during recomposition (this
  absorbs the LAMA-251 copy pass).

## Implementation sketch after approval

1. Design tokens PR (CSS vars + TUI palette constants) — small, low-risk.
2. Web shell PR: rail/nav groups, page context header, max-width + responsive.
3. Page sweep PRs in Dashboard → Folders → Devices order, glossary applied.
4. TUI shell PR: tab restructure, chrome reduction, selection/contextual
   actions, adaptive help.
5. Before/after artifacts at 360/768/1440 browser and 80×24/120×40 terminal.

## Owner decision checklist

| Decision | Recommendation | Owner verdict |
|---|---|---|
| D1 visual direction | warm homelab utility | ☑ approved 2026-08-22 |
| D2 web nav | left rail + drawer, **+ Apps group** | ☑ approved with amendment |
| D3 TUI tabs | task-oriented six → "Backups & apps" | ☑ approved with amendment |
| D4 GitHub view | under More | ☑ approved |
| D5 viewport floor | 360px / 80×24 (assumed) | ☑ approved as assumed |
