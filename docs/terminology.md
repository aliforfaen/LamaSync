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
| Nav labels | Dashboard · **Hosts** · Folders · **Backends** · **Dotfiles** · Conflicts · Operations · Data · Admin | Hosts→Devices, Backends→Storage, Dotfiles→App settings; nav regrouping itself is LAMA-275 scope | ☐ |
| Hosts / HostDetail | "host", hostname fields | Device everywhere; keep actual hostname values as data | ☐ |
| Folders list + editor | type chips sync/mount/backup/dotfile; "backend" select; assignment wording; cron presets exist | Type chips → glossary names; mount shown as sub-label; "Storage destination"; "Set up on …" | ☐ |
| AssignmentEditor | "assign", mode Inherit/Sync/Mount, custom cron field | Per-device setup phrasing; mode → "read-only on this device"; hide raw cron behind Custom | ☐ |
| Backends page | "Backend(s)", kind names s3/local/nfs/restic | Storage destination; kind names may stay as technical tags | ☐ |
| Dotfiles page | "Dotfiles", manifest wording | App settings backup; drop "manifest" from labels | ☐ |
| Conflicts page | strategy names newer_wins/source_wins/… | Plain-language dropdown ("When both sides changed") | ☐ |
| Operations page | "operation" | Activity framing in prose; title optional rename | ☐ |
| GettingStarted / empty states | mixed | Apply glossary while rewriting | ☐ |
| Admin | server jargon | Mostly technical page; audit lightly | ☐ |

### TUI (`packages/tui/src/views/`, `flows/`)

| Surface | Current terms found | Change needed | Status |
|---|---|---|---|
| View titles | Local · Fleet · Dotfiles · Logs · Conflicts · GitHub | Fleet→Devices (or All devices); Dotfiles→App settings; IA restructure itself is LAMA-275 | ☐ |
| Backup setup wizard | "Cron expression" step, raw cron entry | Schedule presets first, Custom reveals cron | ☐ |
| Setup wizard (flows/setup.ts) | host/backend/assignment wording | Device / storage destination | ☐ |
| Dotfile manifest wizard | "Host", "manifest" | Device; drop manifest-speak | ☐ |
| Local/Fleet view rows & hints | host naming, hotkey hints | Device naming; hint rewording pairs with LAMA-275 contextual actions | ☐ |

### CLI (`packages/tui/src/cli/`) — LAMA-253

| Surface | Current terms found | Change needed | Status |
|---|---|---|---|
| Command tree | `hosts`, `backends`, `folders assignments` subcommands | **Command names stay identical** (drift check); only descriptions/synopsis prose change | ☐ |
| Help descriptions | host/backend/assignment jargon | Glossary wording in usage text | ☐ |
| friendly-error messages | mixed | Device/storage wording; exact API error text untouched | ☐ |
| daemon/server `usage.ts` blocks | host/daemon terms | Same rule: prose only | ☐ |

### Repo presence — LAMA-252 / LAMA-254

| Surface | Current terms found | Change needed | Status |
|---|---|---|---|
| README headline + body | "folder assignments", "dotfile manifests", "machines" | Sync-first headline; devices/app settings backups; public-safe split to prod-deploy.md | ☐ |
| Screenshots/GIFs | n/a yet | Capture AFTER copy passes land | ☐ |
| CONTRIBUTING.md / templates | don't exist yet | New files; dev-facing so technical terms OK there | ☐ |

### Deliberately out of scope for renaming

Swagger schema/docs, `packages/agent-skill/reference/*.md`, JSON keys,
log lines, DB/config identifiers — agents and scripts depend on them verbatim.
