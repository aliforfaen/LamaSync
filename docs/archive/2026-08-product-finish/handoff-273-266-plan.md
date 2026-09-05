# Handoff — LAMA-273 + LAMA-266 live-feature plan

Target audience: the main orchestrator agent (has SSH + live-app access on the
LXC). These two flourishes are **real features**, not copy/layout flourishes —
they need a live daemon and real backends to prove out, which is why they were
split out of the web-first batch (LAMA-267/271/272/270). This file is the
execution plan; the issue scopes still live in `docs/handoff-flourishes.md`
sections 5 and 6.

State when written: branch `feature/product-finish`, PR #1 open, ~616 tests
green. Do these on the branch (or their own PRs) *after* the web-first batch
lands, so the two features stack on the shipped web shell/tokens.

## Shared guardrails (both features)

- **Additive only** — no renames of API routes, DB columns, config keys, CLI
  commands, or wire types. New endpoints/columns/keys are fine and must be
  documented (SKILL drift check: `bun scripts/check-skill-drift.ts`).
- **Non-destructive restores** — never write into a real folder; use a temp
  dir, mirroring the `resolveBrowsePath` realpath containment.
- **Scrub rclone/restic stderr** from API responses (LAMA-226 rule); log full
  stderr server-side only.
- **No secret leakage** — never echo API keys / S3 secrets / restic passwords
  in responses, logs, or report cards.
- **`config_revision` bump** on any state change the daemon must observe
  (pause set/clear, etc.) so daemons re-pull via the existing heartbeat path.
- **One commit/PR per issue**, gates after each: `bun x tsc --noEmit` →
  `bun run build:web-ui` → `bun test` → `bun scripts/check-skill-drift.ts`.
- Tick `docs/whats-new-for-owner.md` + `docs/dogfood-2026-08-23.md`, flip the
  Multica issue to done with a comment.

---

## LAMA-273 — Pause / Slow mode toggle

Goal: friendly "⏸ Pause all syncs for 1h / 4h / Until resume" + slow
(bandwidth-limited) mode for tethering; per-device and global; countdown
banner while paused.

### 1. Server — additive pause model

- New table (in **both** `SERVER_SCHEMA` and the `MIGRATIONS` array — see
  `packages/core/src/` schema + `packages/server/src/` migrations): e.g.
  `host_pause` / `global_pause` rows storing `until` (ISO timestamp) and
  `mode` (`pause` | `slow`). Slow mode carries an optional `bwlimit` string.
- Additive endpoints (flat route files in `packages/server/src/routes/`,
  each its own `prefix: "/api/v1"` + Swagger `detail`):
  - `POST /api/v1/pause` `{ until, mode, bwlimit? }` — global.
  - `POST /api/v1/hosts/:id/pause` `{ until, mode, bwlimit? }` — per-device.
  - `DELETE` (or `POST .../resume`) to clear. Pick one pair and document it.
  - `GET` surface so web/TUI can read the current pause state + countdown.
- Bump `config_revision` on set/clear so daemons re-pull.

### 2. Daemon — honor the pause

- Extend the `/config/:hostId` payload **additively** (`packages/server/src/routes/config.ts`
  → `packages/daemon/src/config.ts` + `config-cache.ts`) so a daemon sees its
  effective pause state (global OR its own host row, whichever is "later").
- In `packages/daemon/src/scheduler.ts`: skip scheduled runs while
  `until > now`. The executor (`executor.ts`) should also refuse a fresh run
  while paused (belt-and-braces for the manual/CLI sync path).
- Slow mode: apply a `--bwlimit` override when active — **reuse the existing
  `bandwidthSchedule` plumbing** (rclone argv builder in `rclone.ts`), do NOT
  invent a new rclone path. `bandwidthSchedule` already lives on
  `FolderAssignment` in `packages/core/src/types.ts` (line ~238).

### 3. Web + TUI

- Web: pause control in the shell header area (or Dashboard) + a countdown
  banner while paused. Reuse `PageHeader` / shared Modal for the picker.
- TUI: status-bar action (the one status/hint bar) + countdown text.
- Glossary-consistent wording ("devices", "pause", "slow mode").

### 4. Live verification (the reason this is handed off)

Against the LXC live app + a real client daemon:
- Set a 5-min pause on one host → watch the daemon log: scheduled runs skip
  with a clear log line, no rclone spawn.
- Confirm the countdown banner is accurate (server clock vs browser clock).
- Resume → next scheduled run fires normally.
- Toggle slow mode → confirm the next sync's rclone argv carries `--bwlimit`
  (daemon log line).
- File findings if the daemon socket/TUI path needs new verbs (per the
  handoff acceptance). Prod ops: `docs/prod-deploy.md`.

---

## LAMA-266 — Backup health: "Prove it" + scheduled fire drills

Goal (multi-part; sub-issues LAMA-255 + LAMA-256): users can prove a backup
works and get scheduled restore tests with report cards.

### Part A — "Prove it" (LAMA-255)

- Server endpoint: restore ONE random text file from a backup to a temp dir,
  diff it, return `{ ok, diff? , file }` → "restore successful, your backups
  are working" (or the diff). Non-destructive temp dir only.
- Build on the existing restic path: `packages/server/src/routes/restic.ts`
  (`restore` CLI) + `backends.ts` restic config. Mirror `resolveBrowsePath`
  containment for the temp target.
- Web: a "Prove it" button per storage destination (Backends page) + a
  "✓ Verified 2h ago" badge on the Dashboard, updated after a success.
- Scrub stderr (LAMA-226); never leak secrets.

### Part B — fire drills (LAMA-256)

- Monthly scheduled drill: restic `check` + test-restore of one random file →
  report card written to the operations log + a notification via the existing
  notification engine (`packages/server/src/notifications.ts`, LAMA-200
  ntfy/webhook channels).
- **Server-side schedule** — a small `setInterval` (calendar) in the server,
  no new daemon watchdog, no new scheduler. Store "last drill" state so a
  restart doesn't immediately re-fire.
- Report card: timestamp, destination, check result, restored file + diff
  status, duration.

### 3. Live verification

Against the LXC live app with a real restic/S3 backend configured:
- "Prove it" returns a real `ok`/diff on a restic backup.
- Dashboard badge updates after the success.
- A manually-triggered drill writes a report card to operations + fires a
  notification (ntfy/webhook).
- Confirm no API-key/secret leakage in any response or report card.

---

## After both land

- Update Multica (comment + status flip per issue), refresh
  `docs/whats-new-for-owner.md` + `docs/dogfood-2026-08-23.md`, capture
  before/after into `docs/lama275-artifacts/` with README delta lines.
- LAMA-249 (parent) can move to done once PR #1 merges.
