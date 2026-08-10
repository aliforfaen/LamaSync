# Dogfood handoff — UX program (WS1–5), web UI + CLI

**Date:** 2026-08-10
**Audience:** an image-capable testing agent with browser automation. You can
take screenshots — **take them and look at them**; half of what you're testing
is visual (WS5 ops-console redesign). No prior context required.
**Mission:** Exploratory + scripted testing of everything that shipped in the
August UX improvement program (workstreams 1–5), on a locally seeded dev
server. Find bugs, UX papercuts, and visual regressions. **Do not modify
code** — produce a report.

---

## What shipped (scope under test)

| WS | Theme | Highlights to exercise |
|----|-------|------------------------|
| 1 | Hidden API power | Per-folder Sync now + dry-run, inline assignment editor + pause/resume, host delete, dotfile versions (download/delete), backend kinds local/nfs/restic + test-connection, Conflicts history tabs, Operations active-locks + host filter |
| 2 | Onboarding | Concept glossary/hints, GettingStarted checklist on Dashboard, login hint, empty-state coaching, Swagger link |
| 3 | TUI foundations | First-run setup, `?` help, friendly errors — **CLI fallback only for you; interactive TUI is a manual checklist at the end** |
| 4 | Remaining features | Operations folder filter + History deep links, restic restore UI, DataBrowser delete/download (job-based), shared Modal/ConfirmDialog/PromptDialog (no window.prompt/confirm anywhere), Admin Server block, cron + backend validation, Login remember-me, sync-note name resolution |
| 5 | Visual redesign | Ops-console look: dark-first tokens, mono for machine data, skeleton loading, badge system, nav wordmark, WS status pill, light-theme parity |

Commits: `5094bbb` (WS1+2), `fe65bc8` (WS3), `1f07496` (WS4), `165fc77` (WS5).

---

## Setup

```bash
# 1. Build the web UI (the server embeds packages/web-ui/dist)
bun install && bun run build:web-ui

# 2. Fresh server in terminal 1 (serves UI + API at :8080)
rm -rf /tmp/lamasync-dogfood /tmp/lamasync-dogfood-backups
mkdir -p /tmp/lamasync-dogfood-backups/docs
echo "hello dogfood" > /tmp/lamasync-dogfood-backups/docs/notes.txt
LAMASYNC_API_KEY=dev-key \
LAMASYNC_DATA_DIR=/tmp/lamasync-dogfood \
LAMASYNC_BACKUP_DIR=/tmp/lamasync-dogfood-backups \
  bun run dev:server

# 3. Browser: http://localhost:8080/ — log in with: dev-key
#    Swagger (no auth): http://localhost:8080/swagger
```

**The web UI is a HashRouter SPA (`#/...` routes).** Navigation must stay
client-side; any link that triggers a full page load (and possibly a 404) is
a bug. Report every instance.

## Seed script (run in terminal 2, AFTER the empty-state section below)

```bash
#!/usr/bin/env bash
set -e
API=http://localhost:8080/api/v1
H='Authorization: Bearer dev-key'
J='Content-Type: application/json'

# Two hosts: one online, one that will go stale (host-staleness sweep)
curl -sf -X POST $API/register -H "$H" -H "$J" -d '{"id":"host-a","hostname":"host-a"}' >/dev/null
curl -sf -X POST $API/register -H "$H" -H "$J" -d '{"id":"host-b","hostname":"host-b"}' >/dev/null
curl -sf -X POST $API/report/health -H "$H" -H "$J" \
  -d '{"hostId":"host-a","timestamp":'"$(date +%s000)"',"status":"online","version":"0.2.3"}' >/dev/null
# host-b intentionally gets NO heartbeat. Newly registered hosts show
# "online" at first; the staleness sweep flips host-b to offline after its
# interval (a few minutes) — check it LAST, not immediately.

# Local backend + backup folder + assignment with a real cron schedule
BACKEND_ID=$(curl -sf -X POST $API/backends -H "$H" -H "$J" \
  -d '{"name":"local-store","kind":"local","localPath":"/tmp/lamasync-dogfood-backups"}' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
FOLDER_ID=$(curl -sf -X POST $API/folders -H "$H" -H "$J" \
  -d "{\"name\":\"documents\",\"type\":\"backup\",\"backend\":\"local\",\"backendId\":\"$BACKEND_ID\"}" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
curl -sf -X POST $API/folders/$FOLDER_ID/assign -H "$H" -H "$J" \
  -d '{"hostId":"host-a","role":"source","localPath":"/tmp/docs","syncExpr":"*/15 * * * *"}' >/dev/null

# Operations history (mixed statuses, one recent failure)
for OP in '"operation":"sync","status":"success","summary":"synced 12 files"' \
          '"operation":"sync","status":"failed","summary":"rclone: connection refused"' \
          '"operation":"backup","status":"started","summary":"backup running"'; do
  curl -sf -X POST $API/report -H "$H" -H "$J" \
    -d "{\"hostId\":\"host-a\",\"folderId\":\"$FOLDER_ID\",\"timestamp\":$(date +%s000),$OP}"
done

# Conflicts: two pending (resolve one via UI later)
curl -sf -X POST $API/conflicts -H "$H" -H "$J" \
  -d "{\"conflicts\":[{\"hostId\":\"host-a\",\"folderId\":\"$FOLDER_ID\",\"path\":\"docs/report.md\"},{\"hostId\":\"host-a\",\"folderId\":\"$FOLDER_ID\",\"path\":\"docs/budget.xlsx\"}]}" >/dev/null

# Dotfile manifest
curl -sf -X POST $API/dotfiles/manifests -H "$H" -H "$J" \
  -d '{"appName":"nvim","paths":["~/.config/nvim"],"schedule":"0 3 * * *","excludes":["*.log"]}' >/dev/null

echo "Seeded: backend=$BACKEND_ID folder=$FOLDER_ID"
```

---

## Test matrix

Work top to bottom. Screenshot every page you visit
(`screenshots/NN-page-name-{dark,light}.png`) and attach paths in the report.

### A. First-run & onboarding (EMPTY database — do this BEFORE seeding)

| # | Check | Expected |
|---|-------|----------|
| A1 | Open the UI fresh | Login page: key field, remember-me checkbox, onboarding hint pointing at docs/Swagger; ops-console look already evident |
| A2 | Log in with a WRONG key, then the right one | Wrong: readable error, not a raw blob. Right: lands on Dashboard |
| A3 | Dashboard with zero data | GettingStarted checklist visible with sensible steps; hints/glossary near jargon; empty states coach the user; no crash, no blank page |
| A4 | Swagger link | Opens `/swagger` and loads the API docs |
| A5 | Toggle light/dark (nav) on the empty Dashboard | Both themes coherent; nothing unreadable |

### B. Seeded Dashboard (run the seed script first)

| # | Check | Expected |
|---|-------|----------|
| B1 | Reload Dashboard | GettingStarted step 4 ("assign a folder") now done; needs-attention shows the failed op + NEW chips since last visit (host-b needs a few minutes to go stale — if it still reads online here, re-check at the end of the session) |
| B2 | Skeleton loading | Hard-reload (Ctrl+Shift+R): skeleton rows/pulse, not bare "Loading…" text |
| B3 | Storage card | Shows the local backend; Refresh button works; busy state looks intentional |
| B4 | WS status | A status pill/dot (connected) — NOT raw text like `WS: connected` |
| B5 | Mono typography | IDs, IPs, timestamps, byte counts in monospace; prose stays sans |
| B6 | Click through: fleet card → host, "View all" links | HashRouter navigation, no full reloads |

### C. Hosts & HostDetail

| # | Check | Expected |
|---|-------|----------|
| C1 | Hosts list | host-a online / host-b offline badges; version shown mono |
| C2 | Rename host-a inline | EditableHostname works, persists after reload |
| C3 | HostDetail for host-a | Assignment listed; pause/resume toggle works; inline AssignmentEditor edits schedule — try INVALID cron (`banana`) → inline validation error, no save |
| C4 | Sync now + dry-run buttons | Both enqueue; feedback visible (ack/toast/status), dry-run distinguishable |
| C5 | History button | Lands on Operations pre-filtered to host-a (URL `#/operations?hostId=host-a`) |
| C6 | Delete host-b | ConfirmDialog (app modal, NOT a browser-native confirm), cascade warning copy; succeeds; navigates back |

### D. Folders

| # | Check | Expected |
|---|-------|----------|
| D1 | Folder detail / row for "documents" | Assignment to host-a visible; sync note shows names not raw IDs |
| D2 | Edit assignment schedule to `*/15 * * * *` then `61 * * * *` | Valid saves; invalid rejected with inline error naming the problem |
| D3 | History link | Operations page pre-filtered to this folder |
| D4 | Create a new folder, pick backend kind | Backend picker offers local/nfs/s3/restic backends; validation stops incomplete submissions with readable messages |

### E. Backends

| # | Check | Expected |
|---|-------|----------|
| E1 | Create s3 backend with bad endpoint (`not-a-url`) + missing bucket | Inline validation errors, no raw server blob |
| E2 | Create an s3 backend with plausible-but-fake values, hit Test | Fails (no real S3) — error must be a readable message via the error envelope |
| E3 | Create nfs + restic backends | Validation per kind (path required etc.); restic asks for repo/password or shows centralized defaults |
| E4 | Delete the fake s3 backend | ConfirmDialog; success |
| E5 | Copy hint about local/nfs paths | Copy states (somewhere sensible) that paths are server-side and must exist at the same mountpoint on every assigned host — if it doesn't, note as copy gap |

### F. Data Browser

| # | Check | Expected |
|---|-------|----------|
| F1 | Local tab | Lists `docs/` under the backup root; ownership labels; skeleton while loading |
| F2 | Download `docs/notes.txt` | File downloads with correct content |
| F3 | Upload a small local file into `docs/` | Appears in listing after job completes; JobsPanel shows progress with formatted bytes (e.g. `1.2 KiB`, not raw numbers) |
| F4 | Upload the SAME file again | Overwrite ConfirmDialog, not silent |
| F5 | Rename `notes.txt` → `notes.md`, then rename again WITHOUT changing the name | First works; second just closes the dialog (no error, no hang) |
| F6 | Delete a file | ConfirmDialog → job in JobsPanel → entry gone |
| F7 | mkdir + copy/move a file into the new dir | Works; jobs tracked; busy guard blocks a second simultaneous op on the same target with a clear message |
| F8 | Restic tab | If no restic data: clean empty state + restore UI affordances explained. If reachable: restore modal validates input (whole-snapshot restore) |
| F9 | Breadcrumbs + tab navigation | HashRouter-safe, no full reloads |

### G. Operations & Conflicts pages

| # | Check | Expected |
|---|-------|----------|
| G1 | Operations list | Seeded ops visible; folder dropdown filter + host filter work; badges colored per status |
| G2 | Active-locks panel | Renders (likely empty) with a sensible empty state |
| G3 | Conflicts: Pending tab | Two seeded conflicts with resolved NAMES (folder/host), not raw IDs |
| G4 | Resolve one conflict with a strategy | Moves to Resolved; Resolved and All tabs show it with resolution record |
| G5 | Timestamps, paths | Mono where machine-shaped |

### H. Dotfiles

| # | Check | Expected |
|---|-------|----------|
| H1 | Manifest list | Seeded nvim manifest with schedule/excludes visible |
| H2 | Create a manifest via UI | Form coaching/hints; validation on paths and schedule |
| H3 | Versions section | Expand an app; if empty, sensible empty state. (Upload requires a real daemon — note as untested if absent) |

### I. Admin

| # | Check | Expected |
|---|-------|----------|
| I1 | Server block | Server version, DB size, latest-release check. The dev box may lack GitHub access — must degrade gracefully (placeholder/error note), never crash |
| I2 | Notification channels | Page renders; test button on an unconfigured channel → readable error |
| I3 | Prune operations | ConfirmDialog before pruning; result reported |

### J. Visual sweep (WS5 — the point of the screenshots)

Do this last, page by page, in BOTH themes (toggle in nav):

- All 10 pages + Login + one ConfirmDialog and one PromptDialog open.
- Dark theme: near-black cool surfaces, terminal-green/teal OK accents, amber
  warn, red critical; badges look like a deliberate status system (consistent
  shape across pages).
- Mono font ONLY on machine data (paths/IPs/IDs/timestamps/bytes/cron), never
  on prose or buttons.
- Focus rings: Tab through a form — visible focus indicator on every control.
- Light theme: same design language, not an afterthought; muted text still
  readable; badge text readable on its tint.
- Wordmark in the nav; scrollbars styled; modals have elevation + dim
  backdrop; nothing overflows at 1280px width.
- Flag anything that looks generic, misaligned, or off-palette.

### K. CLI fallback (LAMASYNC_NO_TUI=1)

The interactive TUI needs a real terminal (see section L). The CLI fallback
you CAN test:

```bash
# 1. With a valid client config (~/.config/lamasync/client.toml):
#    serverUrl = "http://localhost:8080" / apiKey = "dev-key"
LAMASYNC_NO_TUI=1 bun run packages/tui/src/index.ts
#    Expected: fleet summary lines (hosts + statuses), clean exit.

# 2. Point serverUrl at a dead port and rerun.
#    Expected: a FRIENDLY error (WS3 friendlyError) — e.g. "server not
#    reachable"-style, not a raw stack/fetch blob.

# 3. Move client.toml away entirely and rerun.
#    Known behavior (verify, then JUDGE it): buildClient falls back to
#    http://localhost:8080 + dev-key (api.ts DEFAULT_URL/DEFAULT_KEY) and
#    runCliFallback ignores the needsSetup flag — so against this dev
#    server it will silently WORK with default credentials. The WS3
#    first-run flow only gates the interactive boot path. Report whether
#    you consider this acceptable for a headless fallback or a bug —
#    with reasoning.
```

### L. Interactive TUI — MANUAL checklist for the maintainer (not the tester)

An agent cannot dogfood the OpenTUI renderer headlessly (native terminal,
keyboard-driven). Maintainer: 10 minutes in a real terminal —
`bun run dev:tui`. First-run wizard (move client.toml away), tab through all
6 views, `?` help overlay opens/closes and doesn't leak keys, footer hotkey
hints match what keys actually do, fleet view shows live status, and with the
server stopped every view degrades to a friendly error. This was all
regression-tested in WS3 (`packages/tui/src/flows/setup.test.ts`) — you're
looking for feel, not function.

---

## Rules

- **No code changes.** You are a tester. If you find a bug, document it
  precisely: page/route, steps, expected vs actual, screenshot, severity
  (blocker / should-fix / nit).
- Prefer real interaction over reading source; use source only to confirm
  what an endpoint should return.
- If the server crashes or a page whitescreens, capture the browser console
  output — that's usually the report's most valuable artifact.
- Known gaps, do NOT report: S3/restic paths needing real infra (fake-backend
  failure is expected — you're grading the error presentation); dotfile
  upload (needs a daemon); daemon self-update (deferred feature).

## Report format

Save as `docs/handoff/dogfood-2026-08-10/report.md`:

```
# Dogfood report — UX program WS1–5 (2026-08-10)
Environment: local dev server, seeded per handoff. Browser: <tool used>.

## Summary
<N lines: overall state, blocker count, general impression of the WS5 design>

## Findings
| # | Section | Severity | Page/route | Description | Screenshot |
|---|---------|----------|-----------|-------------|------------|

## Per-section results
A–K: PASS / FAIL / PARTIAL + one line each (L: maintainer, skip)

## Untested / out of scope
<what couldn't be exercised and why>
```
