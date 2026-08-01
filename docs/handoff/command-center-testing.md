# Command Center v1 — Agentic dogfood / testing brief (LAMA-183, batches 1–2)

**Audience:** a future agentic testing session (dogfood-style, browser-driven).
**Scope under test:** LAMA-199 (version & update visibility), LAMA-201 (theme
& design tokens), LAMA-197 (Command Center dashboard v1). Batch 1 + 2 of the
LAMA-183 epic. Everything here shipped on `master` 2026-08-01:

- `825196c` feat(server,daemon,core): version & update visibility (LAMA-199)
- `8470eb8` feat(web-ui): theme & design-token pass dark/light (LAMA-201)
- `60651d8` feat(web-ui): Command Center dashboard v1 (LAMA-197)

Implementation handoffs (ephemeral, not committed): `docs/handoff/command-center-batch1.md`,
`docs/handoff/command-center-batch2.md`.

## How to run the stack under test

```bash
# Terminal 1 — server (web UI embedded; serves at :8080)
LAMASYNC_API_KEY=dev-key \
LAMASYNC_DATA_DIR=/tmp/lamasync-test \
LAMASYNC_BACKUP_DIR=/tmp/lamasync-test-backups \
  bun run dev:server

# Terminal 2 — a daemon (needs ~/.config/lamasync/client.toml pointing at the
# server; or register a fake host via curl):
curl -X POST http://localhost:8080/api/v1/register \
  -H "Authorization: Bearer dev-key" -H "Content-Type: application/json" \
  -d '{"id":"test-host","hostname":"test-host"}'
curl -X POST http://localhost:8080/api/v1/report/health \
  -H "Authorization: Bearer dev-key" -H "Content-Type: application/json" \
  -d '{"hostId":"test-host","timestamp":'"$(date +%s000)"',"status":"online","version":"0.2.3"}'

# Browser: http://localhost:8080/  (login with dev-key)
# Swagger (no auth): http://localhost:8080/swagger
```

The web UI is a **HashRouter** SPA (`#/` routes). Any in-app link that is NOT a
`react-router` `Link`/`NavLink` is a bug (plain `<a href>` would hit the server
and 404). This exact bug was caught in review once already.

## Test matrix

### A. LAMA-199 — Version & update visibility

| # | Check | Expected |
|---|-------|----------|
| A1 | Daemon heartbeat stores version | `hosts.version` populated; visible via `GET /api/v1/health` (hosts[].version) and after each heartbeat the WS pushes `{kind:"host"}` |
| A2 | Version column on Command Center | Shows `v0.2.3` (or reported version); `—` for hosts that never reported |
| A3 | Update-available derivation | With `version=0.2.3` and the latest GitHub release > 0.2.3 → `updateAvailable: true` + "update" pill on the fleet card and in "Needs attention → Updates available". Derivation is server-side only (client does no comparison) |
| A4 | Blank heartbeat preserves version | Heartbeat WITHOUT `version` (older daemon) must NOT wipe the stored value (lanIp-style pattern) |
| A5 | Release cache | `/api/v1/release/latest` works; repeated calls don't fan out to GitHub (1h TTL; in-memory; stale-or-null on failure — stop the server's network and confirm it returns cached/null, never 502-spams) |
| A6 | First-load parity | Right after server start, `/api/v1/health` already includes `version`/`updateAvailable` (the health.ts integrator fix) |

### B. LAMA-201 — Theme & design tokens

| # | Check | Expected |
|---|-------|----------|
| B1 | Nav toggle cycles dark → light → system | Applies **without page reload** |
| B2 | Persistence | Reload keeps the choice (localStorage `lamasync-theme`) |
| B3 | System default | On `"system"`, follows OS `prefers-color-scheme`; switching OS theme live-updates the page; default is `system` when nothing stored |
| B4 | Both themes, all pages | Dashboard (Command Center), Folders, Dotfiles, Conflicts, Admin, **and the login page** render legibly in dark AND light. Dark must look identical to pre-LAMA-201 (regression baseline) |
| B5 | Tokens only | No hard-coded hex colors anywhere in `index.css` (grep `#[0-9a-f]{6}`) |
| B6 | Icons | Nav links show the inline SVG icons (host/folder/dotfile/conflict/notification); `currentColor` so they follow text color in both themes |

### C. LAMA-197 — Command Center dashboard

| # | Check | Expected |
|---|-------|----------|
| C1 | Landing page | `/` is the Command Center (title "Command Center"); "Needs attention" is the FIRST section, above the fold |
| C2 | Needs-attention triage | 4 items: pending conflicts, failed ops (last 24h), offline/degraded hosts, updates available — each with a count, details for the first few, and (conflicts) a working "View all →" link to `#/conflicts` |
| C3 | All-quiet state | With a healthy fleet: single green "✓ All quiet" line (no flash of it while data is still loading) |
| C4 | Fleet cards | Per-host: hostname, status badge, last seen, version + update pill; healthy hosts compact |
| C5 | Live WS updates | Register/kill a host or post an operation → sections update WITHOUT reload (≤30s heartbeat; op feed prepends) |
| C6 | Recent activity | Last ~20 ops with time/host/operation/status/summary; empty state present with no ops |
| C7 | Quick actions | "Manage folders →" and "Resolve conflicts →" navigate to `#/folders` / `#/conflicts` **without a full page reload** (HashRouter) |
| C8 | No-scroll triage | With ≤10 hosts, all critical state visible without scrolling (needs-attention first, compact cards) |
| C9 | Error state | Server unreachable → error banner shown, page doesn't crash |

### D. Regression

| # | Check | Expected |
|---|-------|----------|
| D1 | Existing pages | Folders/Dotfiles/Conflicts/Admin CRUD still work (the batch touched Dashboard + shared CSS only) |
| D2 | Server/API shapes | `/api/v1/health`, `/operations`, `/conflicts`, `/release/latest` response shapes unchanged (LAMA-199 only ADDED fields) |
| D3 | TUI untouched | `git log --oneline -5 -- packages/tui` shows nothing from these batches |
| D4 | Full suite | `bun x tsc --noEmit` + `bun run build:web-ui` + `bun test` (expect 212 pass / 1 skip / 0 fail) |

## Known limitations / heads-ups (from the 2026-08-01 session)

1. **First-load version gap:** on initial `/health`, versions appear only after
   each host's next heartbeat (≤30s) — WS host events fill the Version column
   and update pills. Not a bug; expected.
2. **24h failed-op window** counts only within the fetched 100-op window
   (`listOperations(100)`); a fleet with >100 ops in 24h could undercount.
3. **The 24h cutoff** (`Date.now()`) is computed on render — after ~1h of no WS
   events the count can go stale until the next event. Accepted for v1.
4. **No browser-level tests exist** for the web UI (no test infra in
   `packages/web-ui`); the batch was verified via tsc/build/unit tests +
   review only. This dogfood session is the real UI check.
5. **Update badge** is text/info-blue only; no severity colors.
6. **"Updates available" requires GitHub reachability** from the server
   (cached 1h). In offline environments it silently shows nothing.
7. **`docker/.env` vs the old `docker/.env.api-key`:** only `docker/.env` is
   read (by `docker-compose.yml`); `.env.api-key` was orphaned and removed
   2026-08-01. Both names remain gitignored.
8. **Deferred (LAMA-203):** "what changed since last visit" highlighting was
   deliberately NOT built into the Command Center.

## Tooling notes for the dogfood session

- Drive the browser with `agent-browser` (or computer-use for the desktop
  browser). The app is a local SPA — plain navigation + clicks, no auth
  beyond the API-key login form (sessionStorage).
- A fake fleet is easy to fabricate via the curl registration + heartbeat
  calls above (register several hosts, vary `version` strings, post a mix of
  successful/failed operations through `POST /api/v1/report`).
- WebSocket live behavior (C5) can be observed by posting operations while
  the page is open.
- Swagger at `/swagger` lists every endpoint for cross-checking response
  shapes (D2).
