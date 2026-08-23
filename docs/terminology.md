# Terminology — user-facing language guide (LAMA-250)

Single source of truth for human-facing wording across every LamaSync surface:
web-ui, TUI, CLI help, README, and docs. Established by LAMA-249 decision #3
(2026-08-22 brainstorm). Every copy pass (LAMA-251, LAMA-253, LAMA-252) audits
against this file; new UI work should use these terms from the start.

**Positioning reminder:** LamaSync is a *sync-fleet controller*. Backups are a
top capability, not the brand.

## The one rule

Rename **words, never identifiers.** API routes, config keys, DB columns, wire
types, CLI command names, flags, exit codes, and JSON keys stay byte-identical
(`scripts/check-skill-drift.ts` enforces the CLI/API surface). Only
human-readable strings — labels, headings, help text, wizard steps, error
messages, docs prose — follow this guide.

## Glossary

| Internal today | User-facing | Notes |
|---|---|---|
| folder type `sync` | Synced folder | bidirectional |
| folder type `mount` | Synced folder *(read-only on this device)* | collapse sync/mount into ONE concept; mount is a sub-label, not a separate type in user words |
| folder type `backup` | Backup | unchanged |
| folder type `dotfile` | App settings backup | "application backups" wording allowed; never "dotfile" toward users |
| assignment | (disappears from UI) → "Set up on: cachy ✓, norheim ✗" | pure plumbing; show per-device setup state instead of the word |
| backend | Storage destination | dev-speak; "destination" is fine on second use |
| host | Device | warm, consumer-grade; `hostname` may stay when showing the actual machine name value |
| cron schedule | Schedule (+ friendly presets: Every hour, Nightly…) | raw cron hidden behind "Custom"; presets already exist in web Folders (`SCHEDULE_PRESETS`) and TUI backup wizard — keep and extend |
| conflict strategy | "When both sides changed" | plain-language dropdown below |
| conflict strategy `newer_wins` | Keep newest | default suggestion |
| conflict strategy `source_wins` | Prefer this device | "source" = the device you're setting up on |
| conflict strategy `keep_both` | Keep both | |
| conflict strategy `manual` | Ask me | pauses for resolution |
| operation / action log | Activity | "Operations" acceptable as page title; prefer "activity" in sentences |

## Words to avoid in user-facing copy

`host`, `backend`, `assignment`, `daemon` (say *the LamaSync service* if the
concept is unavoidable), `bisync`, `manifest`, `cron`, `wire`, `schema`,
`revision`. Technical terms remain correct in: Swagger, agent-skill reference
docs, log output, and code comments — agents need exact terms.

## Audit checklist

Tick items as later passes fix them. Statuses: ☐ todo · ◐ partial · ☑ done.

### Web UI (`packages/web-ui/src/pages/`, `components/Nav.tsx`)

| Surface | Current terms found | Change needed | Status |
|---|---|---|---|
| Nav labels | Dashboard · **Hosts** · Folders · **Backends** · **Dotfiles** · Conflicts · Operations · Data · Admin | Regroup into rail per approved LAMA-275 proposal: Overview / Sync / **Apps** / Storage & tools / System; Hosts→Devices, Backends→Storage, Dotfiles under Apps | ☐ |
| Hosts / HostDetail | was: host everywhere | Swept list page (Add device, remove-device dialogs); HostDetail detail pass still open | ◐ |
| Folders list + editor | was: type chips, backend select, Assign wording | Swept: Set up on device…, Storage/Set up on columns, device empty states, schedule presets (cron behind Custom) | ☑ |
| AssignmentEditor | was: assign/Inherit/Sync/Mount/cron | Swept: When both sides changed, Use folder default/Sync/Read-only mount, Custom schedule label | ☑ |
| Backends page | was: Backend(s) everywhere | Swept: storage destinations in headings/notices/dialogs; kind names remain as technical tags | ☑ |
| Dotfiles page | was: Dotfiles/manifest wording | Swept: app backups wording (New app backup, All devices); deep manifest-speak in TUI wizard still pending | ◐ |
| Conflicts page | strategy names were raw values | Swept via concepts.ts: Keep newest / Prefer this device / Keep both / Ask me; Device column | ☑ |
| Operations page | was: operation/host | Swept: Activity header + purpose, Device column/filter | ☑ |
| GettingStarted / empty states | mixed | Apply glossary while rewriting | ☐ |
| Admin | server jargon | Mostly technical page; audit lightly | ☐ |

### TUI (`packages/tui/src/views/`, `flows/`)

| Surface | Current terms found | Change needed | Status |
|---|---|---|---|
| View titles | Local · Fleet · Dotfiles · Logs · Conflicts · GitHub | LAMA-276 done: This device · All devices · Backups & apps (backup folders + app settings) · Conflicts · Activity · More; GitHub is a drill-in under More | ☑ 2026-08-23 |
| Backup setup wizard | "Cron expression" step, raw cron entry | Schedule presets first, Custom reveals cron | ☐ |
| Setup wizard (flows/setup.ts) | host/backend/assignment wording | Device / storage destination | ☐ |
| Dotfile manifest wizard | "Host", "manifest" | Device; drop manifest-speak | ☐ |
| Local/Fleet view rows & hints | host naming, hotkey hints | Headings device-first; contextual footer per selected folder (LAMA-276) | ☑ 2026-08-23 |

### CLI (`packages/tui/src/cli/`) — LAMA-253 ✅ shipped 2026-08-23

| Surface | Current terms found | Change needed | Status |
|---|---|---|---|
| Command tree | `hosts`, `backends`, `folders assignments` subcommands | **Command names stay identical** (drift check); only descriptions/synopsis prose change | ☑ (names untouched) |
| Help descriptions | host/backend/assignment jargon | Glossary wording in usage text (device, storage destination, activity, app settings backups) | ☑ |
| friendly-error messages | mixed | Device/storage wording; exact API error text untouched | ☑ |
| daemon/server `usage.ts` blocks | host/daemon terms | Prose only: this device, per-device configuration | ☑ |

### Repo presence — LAMA-252 / LAMA-254

| Surface | Current terms found | Change needed | Status |
|---|---|---|---|
| README headline + body | "folder assignments", "dotfile manifests", "machines" | Sync-first headline; devices/app settings backups; public-safe split to prod-deploy.md | ☐ |
| Screenshots/GIFs | n/a yet | Capture AFTER copy passes land | ☐ |
| CONTRIBUTING.md / templates | don't exist yet | New files; dev-facing so technical terms OK there | ☐ |

### Deliberately out of scope for renaming

Swagger schema/docs, `packages/agent-skill/reference/*.md`, JSON keys,
log lines, DB/config identifiers — agents and scripts depend on them verbatim.
