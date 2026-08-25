# Handoff — UX flourish batch (LAMA-266/267/270/271/272/273)

Work-order handoff for a **long session** on the LAMA-249 "flourish" backlog.
All six issues are wired to the now-shipped design foundation (tokens, web
shell, TUI shell, glossary) — each flourish implements ON TOP of what
landed in `feature/product-finish` (PR #1), never re-doing it.

State: branch `feature/product-finish` (24+ commits ahead of master, PR #1
open, 616 tests green). Parent program LAMA-249 is `in_review` on Multica;
these children stay `backlog` until picked up.

## Session contract (every session touching this batch)

1. One issue per commit/PR; run gates after each:
   `bun x tsc --noEmit` → `bun run build:web-ui` → `bun test` → (help/API
   changes) `bun scripts/check-skill-drift.ts`.
2. **No API route / DB column / config key / CLI command / wire-type
   renames.** Additive endpoints OK when an issue needs one (e.g. pause mode,
   restore-test). Glossary per `docs/terminology.md` (devices, storage
   destinations, app settings backups). Copy changes stay user-facing only.
3. Use the shipped design assets: web CSS tokens (4-tier surfaces,
   `--content-max`, `--nav-rail-width`), TUI palette (`app/palette.ts`),
   `PageHeader`, shared Modal/ConfirmDialog, `docs/lama275-artifacts/` for
   before/after captures.
4. After each feature: append to `docs/whats-new-for-owner.md`,
   tick `docs/dogfood-2026-08-23.md`, flip the Multica issue to done with a
   comment. Keep the memsearch progress note updated.
5. Merge flow: these are separate features → separate PRs off
   `feature/product-finish`, or the owner may batch-review via the existing
   PR. Ask if unsure.

## Suggested order (quick win → flagship)

1. **LAMA-267 — Schedules as human sentences** (medium, ~half day)
2. **LAMA-271 — Empty states that teach** (medium, ~half day)
3. **LAMA-272 — Device cards, not host table** (medium, ~half day)
4. **LAMA-270 — Command palette (cmd+k)** (low, ~half day)
5. **LAMA-273 — Pause / Slow mode toggle** (low prio, FEATURE: daemon+web)
6. **LAMA-266 — Backup health: 'Prove it' + fire drills** (high, multi-part)

Alternates if time (or next batch): LAMA-268 (smart conflict cards),
LAMA-269 (storage donut + sparkline), LAMA-261 (file biography), LAMA-274
(personality system — needs owner taste check first).

---

## 1. LAMA-267 — Schedules as human sentences (hide cron)

**Goal:** replace the raw cron box with friendly presets + a "next run"
sentence, keeping cron underneath.

**Already in place:** web `AssignmentEditor` + Folders page have
`SCHEDULE_PRESETS` (Custom / Every hour / Every 6h / Daily / Weekly /
Monthly / On boot / On login) and the TUI has
`packages/tui/src/app/schedule-presets.ts`. Daemon `Scheduler.nextRunFor()`
computes the next cron fire. Validators reject @midnight/@noon (LAMA-247).

**Scope:**
- Fold the preset select into the folder create/edit + app settings
  manifest forms; "Advanced: custom cron" collapsed.
- Add **next-run sentence** to the assignment editor and the Folders row
  ("Next: tonight at 02:00"). Web needs a small helper calling a next-run
  computation (mirror the daemon's cron-parser or surface `nextRunFor` via
  the existing config/assignment payload — no new endpoint needed).
- Keep `cron-parser` on the daemon; no daemon behavior changes unless the
  "When on WiFi" preset is included — treat that as out of scope (no
  wifi-trigger backend exists; note it in the issue).

**Acceptance:** editor shows presets + collapsed custom cron; a "Next: …"
sentence appears where cron is set; TUI wizard matches (it already has
presets — has only the label wording). Captures at 360px (form) + 80×24.

## 2. LAMA-271 — Empty states that teach (with illustration + CTA)

**Goal:** every empty view becomes a mini-wizard: message + one CTA + a
small 3-step hint ("takes 30s"). Cover: Folders (no folders yet), Devices,
Storage destinations, Operations/Activity, Data browser.

**Already in place:** web has `GettingStarted` + `AddHostGuide` scaffolding;
TUI has per-view empty text ("(no folders configured)"). Glossary + tokens.

**Scope (web first):** a shared `EmptyState` component (icon/emoji-free,
CSS-drawn illustration or simple glyph, title, one-sentence how, primary
CTA button). Wire into the five pages; CTAs open existing flows (Add
device guide, new folder form, new storage destination). TUI passes second:
match the empty states in This device / Backups & apps / Activity.

**Acceptance:** each empty page shows a clear next action; dashboard empty
fleet shows "Pair your first device" not a bare table. Screenshots at 1440
dark + 360.

## 3. LAMA-272 — Device cards, not host table

**Goal:** Devices page becomes a card grid (OS icon, pulsing online dot,
"last backup 2h ago", storage used, click into the device's folders/activity).

**Already in place:** `GET /api/v1/health` gives hosts+status; per-host
details via `/hosts/:id` (+ HostDetail page), operations filtered by host.
Glossary uses devices. Tailscale-like glance.

**Scope (web):** Hosts.tsx → responsive card grid using existing health
data; derive "last backup" from the operations feed (or `/hosts/:id`
operations); storage used from existing size/health fields if available —
do NOT add a new stats endpoint unless the issue explicitly asks (note it
instead). Keep the HostDetail page reachable from a card. TUI "All devices"
row list can stay (cards are a web flourish) — but the naming/hostname
columns must stay device-first.

**Acceptance:** cards at 1440 + stacked at 360; online/offline visually
obvious (dot + text, never color alone); clicking opens the device.

## 4. LAMA-270 — Command palette (cmd+k)

**Goal:** web cmd+k fuzzy palette over actions + navigation ("Add synced
folder", "Go to Storage", "Resolve conflicts", "Pair device").

**Already in place:** web shell + PageHeader; route-preserving SPA. No
heavy deps policy (implement fuzzy match in ~30 lines; no romp/omg).

**Scope:** a `CommandPalette` overlay (reuse the shared modal patterns),
keyboard-driven (cmd+k toggle, arrows, enter, esc), commands registry:
navigation (rail groups + pages), page CTAs (new folder, new storage
destination, resolve conflicts), + "Go to …" for all rail items. Preserve
deep links — activating navigation uses router push, not window.location.

**Acceptance:** palette opens/close cleanly, fuzzy matches typo'd input,
Enter navigates and closes; reduced-motion safe; no layout shift at 360px.

## 5. LAMA-273 — Pause / Slow mode toggle

**Goal:** friendly "⏸ Pause all syncs for 1h / 4h / Until resume" + slow
(bandwidth-limited) mode for tethering; per-device and global; countdown
banner while paused.

**Already in place:** daemon busy-guard per folder, `scheduler` with
`enabled` flag on assignments, `--bwlimit` support in the executor
(`bandwidthSchedule` on assignments). No global pause exists.

**Scope — this is a real feature (additive):**
- New additive API: `POST /api/v1/hosts/:id/pause {until}` + global
  `POST /api/v1/pause {until}` (or one endpoints pair) storing a pause row;
  config-ready daemon reads it (extend `/config/:hostId` payload
  additively; bump `config_revision` on set/clear).
- Daemon: scheduler + executor skips scheduled runs while `until > now`;
  a `--bwlimit` override applied when slow-mode active (reuse the existing
  bandwidthSchedule plumbing, don't invent a new rclone path).
- Web + TUI: a pause control (web header area + TUI status bar action);
  banner shows the countdown while paused.
- No config-key renames; new keys/endpoints are additive and documented.

**Acceptance (needs a live daemon):** pausing stops scheduled runs (log
line + status), countdown banner accurate, resume works, slow mode applies
`--bwlimit`. Findings filed if the daemon socket/TUI path needs new verbs.

## 6. LAMA-266 — Backup health: 'Prove it' + scheduled fire drills

**Goal (multi-part, sub-issues LAMA-255 + LAMA-256):** users can prove a
backup works and get scheduled restore tests with report cards.

**Part A — 'Prove it' (LAMA-255):** server endpoint that restores ONE
random text file from a backup to a temp dir, diffs it, returns
"restore successful, your backups are working" (or the diff). Web button
per storage destination + badge "✓ Verified 2h ago" on the Dashboard.

**Part B — fire drills (LAMA-256):** monthly scheduled drill (restic check
+ test-restore of one random file → report card; notification via the
existing ntfy/webhook channels). Daemon-side or server-cron — prefer a
server-side schedule (no new daemon watchdog) if the drill can run
server-side; else reuse the LAMA-266 parent guidance.

**Already in place:** restic restore path (`restore` CLI, restic backend
config), notification engine (LAMA-200), operation-log + stats caching,
`GET /folders/:id/size` pattern for per-folder size.

**Scope guardrails:** restore tests must be non-destructive (temp dir,
never overwrite real paths — mirror `resolveBrowsePath` containment);
scrub rclone/restic stderr from API responses (LAMA-226 rule); calendar
scheduling = a small `setInterval` on the server (no new scheduler).

**Acceptance:** 'Prove it' returns a real diff/ok on an s3/restic backup;
the Dashboard badge updates after a success; a drill writes a report card
to operations + fires a notification; no API-key/secret leakage.

---

## After the batch

- Update Multica: each done + comment; LAMA-249 can then be moved to done
  once PR #1 merges.
- Refresh `docs/whats-new-for-owner.md` + `docs/dogfood-2026-08-23.md` with
  this batch; capture before/after per feature into
  `docs/lama275-artifacts/` with README delta lines.
- Unpicked flourishes (LAMA-268/269/261/274…) remain on the board for a
  later session.