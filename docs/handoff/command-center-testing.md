# LamaSync Command Center v1 — Full-Epic Dogfood Handoff (LAMA-183, batches 1–4)

**Audience:** a future agentic testing session (dogfood-style, browser-driven).
**Scope under test:** the entire Command Center v1 epic — LAMA-199 (version &
update visibility), LAMA-201 (theme & design tokens), LAMA-197 (Command Center
dashboard), LAMA-198 (host pages + queued-action model), LAMA-200
(notifications: ntfy + LamaDB webhook), LAMA-202 (read-only Data Browser),
LAMA-203 (since-last-visit highlighting).

Everything shipped on `master` 2026-08-01:

| Issue | Commit | What landed |
|---|---|---|
| LAMA-199 | `825196c` | daemon version in heartbeat; server-side `updateAvailable` vs cached GitHub release; Version column + update pill |
| LAMA-201 | `8470eb8` | theme tokens (dark/light/system), Nav toggle, inline SVG icons |
| LAMA-197 | `60651d8` | Command Center landing page (needs-attention, fleet cards, live feed, quick actions) |
| LAMA-198 | `3f4594d` | host list + detail pages; queued actions (trigger_sync/backup, check_update, refresh_config); config-revision auto-refresh |
| LAMA-200 | `bfa1a07` | notification router: severity map, cooldowns/escalation, host-staleness sweep, ntfy + webhook delivery, Admin test button |
| LAMA-202 | `a449160` | read-only Data Browser: local dir, SigV4 S3 listing, restic metadata |
| LAMA-203 | `954ecec` | "since last visit" NEW chips + header count |

Per-batch implementation specs (ephemeral, untracked): `docs/handoff/command-center-batch1..6.md`.

## How to run the stack under test

```bash
# Terminal 1 — server (web UI embedded; serves at :8080)
LAMASYNC_API_KEY=dev-key \
LAMASYNC_DATA_DIR=/tmp/lamasync-test \
LAMASYNC_BACKUP_DIR=/tmp/lamasync-test-backups \
LAMASYNC_NTFY_URL=https://ntfy.sh/<your-test-topic> \   # optional; test delivery
  bun run dev:server

# Terminal 2 — fabricate a fleet (no real daemon needed for most tests):
curl -X POST http://localhost:8080/api/v1/register \
  -H "Authorization: Bearer dev-key" -H "Content-Type: application/json" \
  -d '{"id":"host-a","hostname":"host-a"}'
curl -X POST http://localhost:8080/api/v1/report/health \
  -H "Authorization: Bearer dev-key" -H "Content-Type: application/json" \
  -d '{"hostId":"host-a","timestamp":'"$(date +%s000)"',"status":"online","version":"0.2.3"}'

# A real daemon works too: needs ~/.config/lamasync/client.toml pointing at
# the server (serverUrl, apiKey, hostname).

# Browser: http://localhost:8080/ (login with dev-key). Swagger (no auth):
# http://localhost:8080/swagger
```

**The web UI is a HashRouter SPA (`#/` routes).** Any in-app link that is not a
`react-router` Link/NavLink is a bug (plain `<a href>` would hit the server and
404). This exact bug was caught in review for LAMA-197 and LAMA-202 — check
every navigation path, especially "View all →" links, fleet-card → host detail,
and Data Browser breadcrumbs.

## Test matrix

### A. LAMA-199 — version & update visibility

| # | Check | Expected |
|---|-------|----------|
| A1 | Heartbeat stores version | `hosts.version` populated; visible via `GET /api/v1/health` and after each heartbeat the WS pushes `{kind:"host"}` |
| A2 | Version column | Shows `v0.2.3`; `—` for hosts that never reported |
| A3 | Update-available derivation | With `version=0.2.3` and GitHub latest > 0.2.3 → `updateAvailable: true` + pill on fleet card + "Updates available" attention item. Server-side only |
| A4 | Blank heartbeat preserves version | Heartbeat WITHOUT `version` must NOT wipe the stored value |
| A5 | Release cache | `/api/v1/release/latest` works; no per-request GitHub fan-out (1h TTL, stale-or-null on failure) |
| A6 | First-load parity | Fresh server: `/api/v1/health` already includes `version`/`updateAvailable` |

### B. LAMA-201 — themes

| # | Check | Expected |
|---|-------|----------|
| B1 | Nav toggle cycles dark → light → system | Applies without reload |
| B2 | Persistence | Reload keeps choice (localStorage `lamasync-theme`) |
| B3 | System default | `"system"` follows OS `prefers-color-scheme` live; default is `system` |
| B4 | Both themes, ALL pages | Dashboard, Folders, Dotfiles, Conflicts, Admin, **Hosts, Host detail, Data Browser, Login** render legibly in dark AND light; dark = pre-LAMA-201 look (regression baseline) |
| B5 | Tokens only | `grep -c "#[0-9a-f]\{6\}" packages/web-ui/src/index.css` → 0 (only var() + rgba() via tokens). **Errata (2026-08-01 dogfood):** unsatisfiable as written — raw hex is required inside the `:root` token definition blocks themselves. Check consumer CSS only: hex hits outside `:root` blocks should be 0. |

### C. LAMA-197 — Command Center

| # | Check | Expected |
|---|-------|----------|
| C1 | Landing page | `/` is "Command Center"; needs-attention FIRST, above the fold |
| C2 | Triage | 4 items: pending conflicts, failed ops (24h), offline/degraded hosts, updates available — counts + first details + working "View all →" (conflicts) |
| C3 | All-quiet | Healthy fleet → single green "✓ All quiet" line (no flash while loading) |
| C4 | Fleet cards | hostname, status badge, last seen, version + update pill; **clickable → `/hosts/:id`** |
| C5 | Live WS | Register/kill host or post an operation → updates without reload (≤30s) |
| C6 | Activity feed | Last ~20 ops; empty state; status badges incl. recovery/retry/conflict |
| C7 | Quick actions | "Manage folders →" / "Resolve conflicts →" navigate **without full reload** |
| C8 | No-scroll triage | ≤10 hosts: critical state visible without scrolling |

### D. LAMA-198 — host pages + queued actions

| # | Check | Expected |
|---|-------|----------|
| D1 | Host list | `/hosts` (nav "Hosts") shows fleet inventory; rows link to detail |
| D2 | Host detail | `/hosts/:id`: identity (status, tailnet/LAN IP, last seen), daemon version + update pill, **config revision + cached revision**, assigned folders (type/path/schedule/role/enabled), dotfile manifests, last operations, collapsible `rclone.conf` (**must match what the daemon receives via `GET /config/:hostId`**) |
| D3 | Action buttons | Trigger sync / Trigger backup / Check update / Refresh config enqueue + appear in action history (pending → taken → done/failed with result) |
| D4 | Trigger sync end-to-end | With a real daemon + a folder assignment: click "Trigger sync" → daemon runs a sync within ≤30s → operation_log row + action history shows `done` with summary |
| D5 | Config-revision auto-refresh | Edit a folder/assignment in the UI → host's config revision bumps → daemon re-pulls config within ≤30s (its log shows `[config] revision drift … refreshing`) without waiting for the 5-min timer |
| D6 | check_update result | Action history shows "up to date (vX)" or "update available: vY" |
| D7 | Audit trail | Every action completion writes an `operation_log` row (operation = action type) — visible on Dashboard feed + `/operations?hostId=` |

### E. LAMA-200 — notifications

| # | Check | Expected |
|---|-------|----------|
| E1 | Admin test button | Admin → "Send test notification" → `test` event recorded (list updates) + ntfy push to the configured topic (severity `warning`) |
| E2 | Event log | `GET /api/v1/notifications` lists events newest-first (type/severity/message/delivery flags) |
| E3 | Operation failed → ntfy | Post `{status:"failed"}` via `/api/v1/report` → ntfy push (default severity) + event row |
| E4 | Cooldown | Repeated failures for the same folder within 15 min → suppressed (no new rows); 2nd **backup** failure escalates to `critical` (rotating_light tag) |
| E5 | Success digest | Successful operations → at most one info event per host per 30 min |
| E6 | Host offline sweep | Stop heartbeating a host (or set its `last_seen` old) → within ~60-90s the sweep flips it to `offline` (Command Center offline item appears!) + one critical `host_offline` event — **and NOT again on subsequent sweeps** |
| E7 | Host recovery | Host heartbeats again (or re-registers) → one `host_online` info event (LamaDB-only severity) |
| E8 | Conflict pending | Create a conflict → one `conflict_pending` event (15 min cooldown per folder) |
| E9 | Restore events | Restore job done/failed → info / critical event |
| E10 | LamaDB webhook | With `LAMASYNC_LAMADB_WEBHOOK_URL` set (e.g. a local `nc -l` receiver): all events POSTed as JSON; `webhook_delivered=1` |
| E11 | No spam | Leave the server running idle with a dead host → host_offline fires exactly once, never per-poll (the Uptime-Kuma lesson) |

### F. LAMA-202 — Data Browser

| # | Check | Expected |
|---|-------|----------|
| F1 | Local tab | `/data` → Local: shows `LAMASYNC_BACKUP_DIR` tree; drill into dirs (breadcrumbs + `../ parent`); sizes + mtimes; top-level dirs matching folder names show owner |
| F2 | Path safety | `GET /api/v1/browse/local?path=../../etc` (and `a/../../`, absolute) → 400; symlink escapes blocked |
| F3 | S3 tab | Pick an S3 folder → lists bucket root; navigate prefixes; **100% read-only** (no action buttons anywhere) |
| F4 | S3 errors | Unknown folder → 404; non-S3 folder → 400; unreachable endpoint → 502 generic (no leaked error body) |
| F5 | Restic tab | Snapshots table (folder/host/time/paths/size) from the existing snapshots API |
| F6 | Folder switch | Switching S3 folders resets the prefix + clears stale entries (no ghost listing) |

### G. LAMA-203 — since last visit

| # | Check | Expected |
|---|-------|----------|
| G1 | First visit | Fresh browser: NO new markers on first load |
| G2 | NEW chips | Post ops/conflicts, reload → feed entries newer than the previous visit show `new` chips; header shows "· N new" |
| G3 | Markers clear | Reload again → the same entries no longer marked (fresh delta) |
| G4 | Live | WS-arriving ops during a visit are chipped too |

### H. Regression

| # | Check | Expected |
|---|-------|----------|
| H1 | Existing pages | Folders/Dotfiles/Conflicts/Admin CRUD intact |
| H2 | API shapes | `/health`, `/operations`, `/conflicts`, `/release/latest`, `/config/:hostId` response shapes unchanged by the epic (fields were only ADDED) |
| H3 | TUI untouched | `git log --oneline -8 -- packages/tui` shows nothing from these commits |
| H4 | Full suite | `bun x tsc --noEmit` + `bun run build:web-ui` + `bun test` → **300 pass / 1 skip / 0 fail** (35 files) |

## Known limitations / heads-ups (from the 2026-08-01 sessions)

1. **First-load version gap:** initial `/health` shows versions only after each
   host's next heartbeat (≤30s); WS host events fill the column/pills.
2. **24h failed-op window** counts within the fetched 100-op window
   (`listOperations(100)`); heavy fleets can undercount. The `Date.now()`
   cutoff is render-time (stale until the next WS event). Accepted.
3. **No browser-level tests exist** for the web UI — this dogfood session IS
   the UI verification.
4. **Update badge / NEW chip** are text+info-blue only.
5. **"Updates available" requires GitHub reachability** from the server
   (cached 1h); offline it silently shows nothing.
6. **Queued actions:** taken-but-died actions have NO reclaim/TTL (a daemon
   that dies mid-action leaves it `taken` forever — manual re-enqueue). Action
   completion writes one operation_log row per action (multi-folder syncs are
   aggregated into one result).
7. **Notification cooldowns are in-memory** (server restart resets them); no
   delivery retries/backoff; ntfy topic comes from the last path segment of
   `LAMASYNC_NTFY_URL`.
8. **S3 browsing is single-page** (max 1000 keys, `IsTruncated` ignored) —
   large buckets show partial listings. SigV4 is unit-verified against the
   official AWS test-suite vector but never exercised against a live
   S3/MinIO endpoint.
9. **Local browse root is `LAMASYNC_BACKUP_DIR` only** — other server-side
   storage (data dir) is not browsable.
10. **Since-last-visit is per-browser** (localStorage) — no multi-device sync;
    multiple simultaneous tabs bump each other's delta.
11. **`docker/.env` is the live compose env file**; `docker/.env.api-key` was
    an orphan and was removed (both names stay gitignored). `ntfyUrl` in the
    TOML parser is documented but the runtime reads `LAMASYNC_NTFY_URL`.
12. **Offline detection is new** (LAMA-200 sweep): hosts now flip to `offline`
    ~90s after their last heartbeat — the Command Center offline triage relies
    on it. Verify it doesn't false-positive on slow heartbeats during the
    session (threshold 90s vs 30s cadence is intentional).

## Tooling notes for the dogfood session

- Drive the browser with `agent-browser` (or computer-use for the desktop
  browser). Local SPA; auth = API-key login form (sessionStorage).
- Fake fleet fabrication: the curl register + heartbeat snippets above; vary
  `version` strings for A3; post a mix of successful/failed operations through
  `POST /api/v1/report` (`{"hostId","folderId","operation","status",
  "summary"}`) for E3/C5/G2.
- For D4/D5 you need a REAL daemon (rclone sync): install one on a test box
  pointing at the server, create a folder + assignment in the UI, then
  trigger sync from the host page.
- For E6/E7: register a host, let it go stale (don't heartbeat), watch the
  sweep; then heartbeat again.
- For E10: run `nc -l 8088` (or a tiny `bun -e` http server) and set
  `LAMASYNC_LAMADB_WEBHOOK_URL=http://localhost:8088/hook`.
- For F3: create an S3-backed folder with real creds (Exoscale/AWS) — no
  mutation happens, listing only.
- WebSocket live checks (C5, G4) — post operations while the page is open.
- Swagger at `/swagger` lists every endpoint for cross-checking shapes (H2).
