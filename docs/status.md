# Status & work queue — LamaSync

Rolling status log. Updated at the end of working sessions; `AGENTS.md` only
carries a one-line pointer here.

## Live-LXC session — LAMA-263/264 verified, LAMA-273/266 shipped (2026-08-25)

Orchestrator ran with prod SSH authority (`docs/prod-deploy.md`; branch
source shipped to the LXC via `git archive | tar` + `docker compose build`,
superseded by GHCR pulls after merge). All gates green at end of session:
`tsc --noEmit`, drift `--strict` (95 routes), **832 pass / 1 skip / 0 fail**.

- **LAMA-263/264 live verification PASSED**: demo seed/delete round-trip on
  prod (real fleet untouched, idempotent, non-demo rows survive); preset →
  manifest flow exercised. One defect found & fixed: presets device counts
  were always empty because unfiltered `/dotfiles/manifests` returns only
  `_global` rows — Presets now folds in per-host manifests (`78b5b86`).
- **LAMA-273 pause/slow mode SHIPPED + LIVE-VERIFIED**: 3 commits
  (`c6f4c10` server/core/daemon, `db7ad86` web, `82363af` TUI Ctrl+P).
  Prod checks: effective pause on `/config/:hostId`, host-over-global
  override, bwlimit validation, DELETE resume, `config_revision` bump
  observed (36→37→38).
- **LAMA-266 backup health SHIPPED + LIVE-VERIFIED against a real restic
  repo**: prove-it restored a real file byte-exact; fire drill passed
  (liveness + restore + operation_log audit row); failures scrubbed.
  Fixes found by live testing: ls parsing switched to `restic ls --json`
  (`0f8021b`), documented 409 for non-restic backends enforced (`4c4201b`),
  restic added to the server runtime image (`17009bc`). Web:
  `36c4748`.
- Batch-2 handoff (`docs/handoff-agent-batch2-2026-08-25.md`) items
  LAMA-259/265 and polish run 2 are still open for coding agents.

## Coding-agent batch — LAMA-283/258/269/282/257/268/153 (2026-08-24)

Full seven-issue batch from `docs/handoff-agent-batch-2026-08-24.md` shipped
on `feature/product-finish` (one commit each + 2 doc commits), all pushed to
PR #1; CI green (check + build). Gates after every commit: `tsc --noEmit`,
`build:web-ui`, `bun test` 679 pass / 1 skip / 0 fail, skill-drift `--strict`
OK (87 routes). All issues flipped to done on Multica with ship comments.

- **LAMA-283** (`a560238`): skill-drift check is now `--strict` in CI +
  AGENTS.md policy line (any undocumented route/command fails the build).
- **LAMA-258** (`77dc7a5`): human-sentence activity feed — Operations +
  Dashboard render glossary sentences (verb + folder + from device + to
  destination · 2h ago · status word); raw summary on hover tooltip; shared
  `relative-time.ts` + `format-bytes.ts` extracted (killed 2×/5× dup).
- **LAMA-269** (`89011e3`): storage donut + growth sparkline per destination
  (Backends Storage column + Dashboard fleet donut); additive `size_history`
  store + `GET /folders/sizes` + `GET /stats/storage/history` (both
  documented); 'Not measured yet' state for non-S3.
- **LAMA-282** (`938e43e`): device OS + storage-used on the wire — daemon
  reports `os` + `storageUsedBytes` per heartbeat (SCHEMA + MIGRATIONS),
  device cards show them.
- **LAMA-257** (`3e4f528`): 'Preview next run' drawer on device detail —
  dry-run via existing daemon `--dry-run` path, polls the action, reads the
  tagged `dry-run:` op row, shows would-copy/delete/mkdir counts + capped
  file list. No new endpoints.
- **LAMA-268** (`d7dc477`): Conflicts page → side-by-side cards (this device
  vs destination: size + mtime), Keep local/remote/both via the existing
  resolve verb; additive `localSizeBytes`/`remoteSizeBytes` (daemon stats
  local, remote stays null); demo seeds 2 conflicts (+ `demo` flag on
  conflicts so demo-delete cleans them).
- **LAMA-153** (`fe4ce8c`): TUI markdown helpers (`packages/tui/src/markdown.ts`,
  golden-tested) — aligned fixed-width tables + `<details>` folds as [+] / [-]
  rows; wired into the adaptive help overlay + app-settings instructions.
- Docs: `whats-new-for-owner.md` (2 sections), `dogfood-2026-08-23.md` ticks,
  this status log, `features.md` rows.

Relook candidates (recorded in whats-new): 269 donut slices equal when
folders share an S3 bucket (center uses the storage-report total) and the
sparkline only accumulates as measurements happen; 268 remote conflict sizes
render "—" until a per-conflict remote stat is added.

## Wrap-up audit — 2026-08-24

Post-session audit of the 8 unpushed commits (flourish batch + LAMA-263/264):
all gates green on re-run (`tsc`, `build:web-ui`, `bun test` 630/1/0, skill
drift OK), PR #1 CI green. Fixed: LAMA-263/264 flipped to done on Multica
(were left backlog) + comments; LAMA-263/264 rows added to `docs/features.md`.
Open items and the next-session plan live in
`docs/handoff-wrapup-2026-08-24.md` (headline: live-LXC verification of
263/264 still pending; push pending owner go-ahead).

## Feature batch — LAMA-263 + LAMA-264 (2026-08-23)

Shipped on `feature/product-finish` (two commits; gates green: `tsc --noEmit`,
`build:web-ui`, `bun test` 630 pass / 1 skip). Both are LAMA-249 flourishes
that were out of scope for the LAMA-275 design issue.

- **LAMA-263 — App presets gallery (curated)**: new `/presets` page under the
  Apps nav group listing 6 hand-picked apps (VS Code, Neovim, Zsh, Firefox,
  Git config, tmux). "Backup" creates an app-settings backup (dotfile
  manifest) for the app's per-OS paths on a chosen device — reuses the
  existing manifest verb, **no new server endpoints**. Pure web feature.
- **LAMA-264 — Demo mode**: additive `demo` flag on 8 tables (schema +
  migrations) + new `demo.ts` route (`GET /api/v1/demo`, `POST /api/v1/demo/seed`,
  `DELETE /api/v1/demo`). "Explore a demo fleet" seeds 3 fake devices, a
  timeline, and a browsable snapshot; "Delete demo data" (confirmed) wipes all
  flagged rows without touching real data. Dashboard banner + empty-fleet CTA.
- Handoff plan: `docs/handoff-263-264-plan.md`. LAMA-262 (pairing) and
  LAMA-266 (backup health) remain open; 266 has its own live-feature plan.

## UX flourish batch — web-first shipped (2026-08-23)

The four web-first flourishes from `docs/handoff-flourishes.md` landed on
`feature/product-finish`, one commit each, gates green after each:

- **LAMA-267 — schedules as human sentences** (`eca5c2f`): raw cron
  collapsed behind "Advanced: custom cron"; "Next: …" sentence computed
  client-side with the daemon's own `cron-parser`; web presets consolidated.
- **LAMA-271 — empty states that teach** (`ef0e1f8`): shared `EmptyState`
  (CSS glyph + CTA) across web pages + Dashboard empty-fleet; TUI empty text
  reworded to the glossary.
- **LAMA-272 — device cards** (`797a3e9`): Devices page card grid (status dot
  + text never color-alone, last-backup from the operations feed);
  device-first copy sweep. OS icon + storage-used noted as wire gaps.
- **LAMA-270 — command palette** (`7ea88ec`): cmd+k fuzzy palette,
  dependency-free; 7 new tests (now **622 pass / 1 skip / 0 fail**).

All four flipped to done on Multica with comments. `tsc --noEmit` +
`build:web-ui` green. Docs updated: `whats-new-for-owner.md`,
`dogfood-2026-08-23.md`, `features.md`.

**LAMA-273 (pause/slow mode) + LAMA-266 (backup health) handed off** — real
features needing a live daemon/backends on the LXC. Execution plan is
`docs/handoff-273-266-plan.md`; the main orchestrator runs them against the
live app. Both remain `backlog` on Multica.

## Current status (as of 2026-08-23, earlier — phases 5/6)

- **LAMA-275/LAMA-251/LAMA-276 implementation shipped on
  `feature/product-finish` (PR #1 open, CI green, 614 tests)**: design tokens,
  web shell (grouped rail + drawer <900px, page-context headers, max-width),
  page sweep with the LAMA-250 glossary (LAMA-251 folded in), TUI pass 2
  (task-oriented tabs, **Backups & apps** with fleet backup folders, **GitHub
  under More** drill-in, chrome reduction to one status/hint bar, adaptive
  help, per-selection contextual footer). Owner D1–D5 approved 2026-08-22.
- **LAMA-247 no-issue batch landed on the branch**: S3 download streaming
  cap + 404 shape, stale `tailnet_ip` clear after a 5-min grace (`""`
  sentinel + `config_revision` bump), rename-no-op 400, web/TUI cron
  allowlist (@midnight/@noon rejected), Admin health caption, **backup
  summaries now count real transfers** (rclone ≥1.63 logs JSON to stderr —
  both streams parsed), `lamasync --json` exit-3 `{reason:"auth-failure"}`
  envelope, `clean:pi` script, clock-drift test, ARCHITECTURE refresh.
  Remaining items (op-log archival, ntfyUrl cleanup, CLI-fallback decision,
  dotfile diff preview, renderer smoke tests, `LAMASYNC_SOCKET_PATH` env table)
  still open in `docs/cleanup-2026-08-18.md`.
- **Dogfood guide live**: `docs/dogfood-2026-08-23.md` is the single place
  capturing what LAMA-250+ built and how to verify it (web/TUI/CLI/server
  checklists, stranger-flow baseline for Phase 6, findings log, artifacts
  convention). Future sessions update it instead of recreating it; it is also
  tracked in the memsearch progress note.
- Remaining branch phases: **LAMA-253 CLI/TUI help copy (Phase 4) shipped
  2026-08-23** (glossary prose, drift check green), **LAMA-252 README rewrite
  (Phase 5)**, **LAMA-254 repo polish + onboarding audit (Phase 6)**. Owner
  relooks applied same day: six tabs fit 80 cols (tabWidth 13, Backups tab
  label), bordered pages restored, loud fake-key warning; LAMA-228 clean-exit
  pty-verified (q + Ctrl+C, dead + live). See `docs/product-finish-plan.md`
  and `docs/whats-new-for-owner.md`.

## Status (as of 2026-08-22)

- **LAMA-249 user-facing polish planning**: the parent now has a terminology
  foundation (LAMA-250), web copy pass (LAMA-251), README/repo polish work
  (LAMA-252–254), and the new **LAMA-275 design system + web/TUI shell
  overhaul** work order. The concise agent entry point is
  `docs/agent-start.md`; use it when creating a fresh worktree so historical
  plans do not compete with the current sequence.
- **LAMA-275 owner decisions are still open**: visual direction, web navigation
  shape, task-oriented TUI tabs, top-level GitHub integration, and minimum
  browser/terminal sizes. Agents must propose rather than silently decide.
- **LAMA-244/LAMA-245 landed on master**: the folder-lock reaper (server,
  WS `reaped` events, opt-out via `LAMASYNC_LOCK_REAPER_MS=0`) and the batched
  sync/backup ack aggregator are committed and pushed. The design worktree
  `feature/product-finish` is rebased on this master; do not restart this work
  in a fresh worktree.

## Recent status (as of 2026-08-18)

- **Docs cleanup pass** (commit `7720c43`): archived 26 former handoff files plus 30 dogfood PNGs and 2 former planning files, and the two LAMA-218/220 post-mortems — work is long done; `docs/features.md` is the canonical LAMA-XXX summary. Fixed stale `packages/agent-skill/lamasync-server.md` references across `README.md`, `AGENTS.md`, `ARCHITECTURE.md`, `docs/development.md`, `docs/features.md`, `packages/agent-skill/{README.md,lamasync-client.md}`. Rewrote `docs/repository-layout.md` to reflect the LAMA-227/230/239/242/243 additions. Net: 74 files / 6140 lines / ~2 MB archived. `bun x tsc --noEmit` was clean at that checkpoint; the current checkout now contains separate uncommitted LAMA-244/LAMA-245 review work.
- **Open Multica issues refreshed (2026-08-22)**: LAMA-249 is the user-facing polish parent; LAMA-250–275 are its terminology, UI, repo-polish, feature-inspiration, and design-shell children. LAMA-243/244/245 are in review; LAMA-228, LAMA-204, LAMA-110 are todo; LAMA-236/237 are backlog. LAMA-105, LAMA-104, and LAMA-171 are done.
- **LAMA-227 update**: `lamasync <command>` exit-3 mapping from the LAMA-245 work verifies the `--json` envelope preserves HTTP status.

## Historical status (as of 2026-08-14)

- **LAMA-239 — per-host mount/sync override (implemented + pushed)**: a folder can now be synced on most hosts but only mounted on resource-constrained ones. New `folder_assignments.mode` column (`inherit|sync|mount`, default `inherit`, in both `SERVER_SCHEMA` + `MIGRATIONS`); `effectiveFolderType()` in core resolves `inherit` → folder type and is honored only for `sync`/`mount` folders (backup/dotfile/git ignore it). The daemon now reconciles on refresh + boot (`reconcileMountsOnRefresh`): starts the mount unit for effective-`mount` hosts, stops stale mounts and resumes cron for effective-`sync` hosts; the scheduler skips effective-mount assignments. `switchToMount`/`switchToSync` are now **per-host mode setters** (PATCH `assign/:hostId {mode}`) instead of flipping `folder.type` globally. Web UI: Mode dropdown (Inherit/Sync/Mount) in AssignmentEditor for sync/mount folders + effective-mode badge in Folders and HostDetail. Tests: `tsc --noEmit` clean; **582 pass / 1 skip / 0 fail** (20 new tests).
- **LAMA-242 — `--help`/`-h` + unknown-flag guard for `lamasyncd` + `lamasync-server` (implemented + pushed)**: the two binaries now print a usage block (new `usage.ts` — `daemonUsage()` / `serverUsage()`, plus `DAEMON_KNOWN_FLAGS` / `SERVER_KNOWN_FLAGS` as the single source of truth for the unknown-flag guard) on `--help`/`-h` (stdout, exit 0) and reject unknown flags with usage on stderr + exit 2 instead of silently booting a long-running process. `lamasync`/`lamasync-tui` already had help (LAMA-229) and was left untouched. The former help-flags handoff was archived; implementation is documented in
`docs/features.md`. Tests: `tsc --noEmit` clean; **562 pass / 1 skip / 0 fail** (13 new usage tests).
- **LAMA-243 — GitHub update-check throttle + server proxy (implemented + pushed)**: root cause of the 2026-08-13 `cachy` incident — a corrupt `client.toml` crash-looped the daemon, and the per-start `--check-update` hit `api.github.com` directly ~600× in ~1h45m, exhausting the 60 req/hr unauthenticated limit (403). Fixes, all landed:
  - **Server proxy routing**: the daemon no longer talks to api.github.com for release metadata — added `LamaSyncApiClient.getLatestRelease()` (GET `/api/v1/release/latest`, the already ~1h-cached server endpoint) and switched every `fetchLatestRelease()` call site (`check_update` action, startup one-shot, `--check-update`, `--update`) to it.
  - **Persisted cooldown**: new `daemon/src/update-check.ts` — `~/.config/lamasync/update-state.json` with a 15-min `lastCheckAt`, written *before* the network call so a crash mid-check still leaves the cooldown in place. A 10s crash loop now fires ≤ ~4 checks/hour.
  - **systemd start-limit**: the generated daemon unit sets `StartLimitIntervalSec=300` + `StartLimitBurst=8` so a hard crash loop stops after 8 failures/5 min.
  - **Optional GitHub token**: `release-cache.ts` sends `Authorization: Bearer $LAMASYNC_GITHUB_TOKEN` when set (5000 req/hr), server-side only. Web UI admin field deliberately deferred — env var is enough; the app shouldn't need a token at all.
  - Tests: `tsc --noEmit` clean; **549 pass / 1 skip / 0 fail** (added `update-check.test.ts` + StartLimit assertion).
- **Backlog housekeeping (this session)**: the 2026-08-11 UI-touch batch (`0a6fd43`, LAMA-238/235/241/232) was shipped in code + docs but never pushed to `origin/master` and never reflected in Multica. Pushed now; flipped LAMA-238 / LAMA-235 / LAMA-232 / LAMA-241 to **done**. LAMA-239 (mount-vs-sync override) remains `backlog` (a real feature, not a touch).
- Daemon-side fixes (0a6fd43 batch + LAMA-243) reach the fleet on the next release tag; the prod server picks up the server-side changes on the nightly master pull.

## Historical status (as of 2026-08-11)

- **UI touch + bug-fix batch (LAMA-238 / LAMA-235 / LAMA-241 / LAMA-232)** — all four shipped in one pass; **LAMA-239 (per-host mount-vs-sync override) deliberately deferred** to its own session (it's a real feature — DB migration + daemon mount lifecycle + UI — not a small touch). Details:
  - **LAMA-238 — backend health-check in the create/edit form**: new `POST /api/v1/backends/test` validates an *unsaved* backend config (S3 → `rclone lsd` on a temp 0600 config, local/nfs → stat+readdir, restic → `restic snapshots`); write-only fields (s3 secret, restic password) fall back to the stored ciphertext when `backendId` references an existing backend, so edits with unchanged secrets still test the real config. Shared helpers extracted to `server/src/backend-test.ts` and reused by the existing `/backends/:id/test`. UI: "Test connection" button + inline ✓/✗ result in the form.
  - **LAMA-235 — host filter in the Folders view**: Dotfiles-style "Host" scope selector in the toolbar (All hosts + each host); rows filter to folders with an assignment on the selected host; expanded-row state collapses if the filter hides it; empty state names the host.
  - **LAMA-241 — onboarding rough edges (all four findings)**: (1) socket `sync` accepts the `folder` alias for `folderId`, requires an identifier, and returns `{"ok":false,"error":"folder not found: X"}` instead of silently succeeding — the `onSyncRequest` contract now returns `boolean`; (2) `POST /folders` with no `backend` defaults to the **first existing backend** (400 "no backends configured" only when none exist), and the web UI preselects the first backend in the create form; explicit `sftp` is still honored for legacy folders; (3) daemon warns per assignment on config load — `local path missing, waiting for first use: <path>` (warn-once while missing, re-warn if it disappears again after appearing; `~` expanded) — via new `missingAssignmentPaths`/`expandHomePath` helpers in `daemon/src/config.ts`; (4) `PUT/PATCH/DELETE /api/v1/assignments/:id` now return **405** pointing at `/api/v1/folders/:folderId/assign/:hostId` instead of a bare `not_found`.
  - **LAMA-232 — orphaned action reclaim**: actions claimed (`taken`) by a daemon that died before acking were stuck forever. Now: (a) `GET /actions/pending` reaps `taken` rows older than 10 min back to `pending` before claiming (`reapStaleTakenActions`), (b) new `GET /actions/taken?hostId=` returns a host's taken actions, which the daemon re-executes at boot (fresh process ⇒ no in-flight work ⇒ safe), (c) the daemon polls immediately at boot instead of waiting for the first 30 s tick. Note: the LAMA-232 report cited lamasyncd 0.2.3, which had **no action polling at all** (it landed after v0.2.3 in LAMA-198); the current-code gap was the orphaned-taken + 30 s first-poll delay, which this fixes.
  - Tests: `tsc --noEmit` clean, web-ui dist rebuilt, **545 passing (0 fail, 1 pre-existing skip)** — was 516 before the batch. Daemon-side fixes reach the fleet on the next release tag (prod server picks up on the nightly master pull; the daemons need a v0.3.2-style tag).

## Earlier on 2026-08-11

- **Production server manually updated after the drift-fix push**: triggered `update.sh` on the LXC (commit `cfa3463`'s GHCR image). End-to-end: 7s — new layers `e0f42ba25292` / `56191f4c264f` pulled (vs prior `c0cfbb583ea8` / `51a5aa6bdfb3`), container recreated at 18:23:42Z, started 18:23:43Z, `GET /api/v1/health` clean (4 hosts, same fleet shape as pre-update — `cachy` / `dev-vm` / `norheim` online, `CachyTop` offline), boot log `LamaSync server v0.3.1 listening on http://0.0.0.0:8080` + `[retention] no operation_log entries older than 90 day(s)`. Server version string unchanged because no `package.json` bump — this was a docs/CI fix, no release. Full ops procedure codified in `docs/prod-deploy.md`.
- **LAMA-240 (folders view cleanup) — CI drift-check fix landed**: the LAMA-227 push to master (`34b7da5`) failed CI for the first time the `Drift-check the agent skill (LAMA-230)` step actually ran — the `lamasync dotfiles manifests` Usage block in `reference/cli.md` packed three subcommands (`list|create|delete`) into one stanza, and the script's invocation set only saw the parent (`dotfiles manifests`) because the top-level `Commands:` section never enumerates nested-group leaves. Eight documented flags resolved to nothing. Fix: (1) split the block into three leaf blocks matching the existing convention (`folders assignments <folderId> [--json]` is the template), (2) export `listInvocations()` from `packages/tui/src/cli/dispatch.ts` and seed `dumpCliHelp()` from the dispatch walker — now covers every depth-3 path and stays correct as the tree grows without further script changes, (3) keep the existing `--help` probe for the per-invocation flag-match regex. Drift check now scans 57 CLI commands (was 53 — the four missing were `dotfiles manifests list|create|delete` plus the group head itself when queried directly). `tsc --noEmit` clean, 516 tests pass (12 dispatch tests included). The CI step had been silently absent from every prior push to master because the workflow file changed in `e4b4425` but no run after that point hit the check job until LAMA-240.
- **LAMA-227/229/230/231 (agent surface) wired end-to-end** (working tree dirty per the handoff's "no git mutations" rule; awaiting maintainer review). Three phases landed in one pass:
  - **Phase A — LAMA-229 (HIGH, foundation)**: CLI v1 surface. New `packages/tui/src/cli/` (args, output, client, dispatch, status, folders, backends, sync, ops, doctor, local). Wired into `packages/tui/src/index.ts` BEFORE `bootShell()` — any positional subcommand → non-interactive dispatch; no positional + TTY → TUI; no positional + `LAMASYNC_NO_TUI=1` → existing CLI fallback. 31 unit tests for the new layer; `bun x tsc --noEmit` and `bun test` green; e2e smoke against a real server confirms `status`, `folders list|create|assign`, `backends list|create|test`, `sync`, `ops list`, `doctor`, and every `local …` variant. Conventions: `--json` everywhere; exit codes 0/1/2/3/4 (ok/runtime/usage/auth-fail/unreachable); auth discovery order `--server`/`--api-key` flags → `LAMASYNC_SERVER_URL`/`LAMASYNC_API_KEY` env → `~/.config/lamasync/client.toml`; API key masked as `lamasync_…xxxx` in every output path.
  - **Phase B — LAMA-230 (MEDIUM, agent skill)**: replaced `packages/agent-skill/lamasync-server.md` with the two-tier bundle (`SKILL.md` + `reference/{cli,api,recipes,troubleshooting,safety}.md`). Six safety rules verbatim in `reference/safety.md`, summarised in `SKILL.md`. Install pipeline: `packaging/install/install.sh` prompts once, persists `~/.lamasync/install-state.json` (auto-updates on `update.sh`, default-on with a `--no-skill` opt-out flag). `lamasyncd --update skill` resolves the bundle whose version matches the local binary via the tag release (no cross-version drift; `readInstalledSkillVersion` reads the bundle's VERSION file, also reported by `--check-update`). `packaging/build-skill-tarball.sh` is the bundler; release CI adds it as `lamasync-skill-<version>.tar.gz`. `scripts/check-skill-drift.ts` verifies every route in `reference/api.md` exists and every command/flag in `reference/cli.md` matches the binary's `--help` output — runs in the `check` job.
  - **Review pass (2026-08-11, two reviewers + fixes)**: found and fixed before commit — (1) exit code 3 was unreachable because command error-wrapping dropped the HTTP status (`wrapApiError` now preserves it; regression tests assert 401/403 → exit 3 through the real command path); (2) `dotfiles manifests create|delete` silently ran `list` (parseArgs capped the command path at depth 2; dispatch now walks the tree greedily and leaves trailing positionals in `rest`); (3) missing `notifications test` command added (+ `testNotification` api-client method); (4) CI release job downloaded a `lamasync-skill` artifact no step uploaded (upload step added); (5) the drift-checker's CLI flag verification parsed 0 flags and keyed help by the wrong token (fixed — now genuinely verifies 53 CLI commands); (6) `--update skill` queried `/releases/latest` instead of the tag matching the local binary; (7) safety.md rule wording aligned to the contract (first-8+last-4, `/api/v1/operations`); (8) test-install.sh / test-update.sh extended to assert the skill lands.
  - **Phase C — LAMA-231 (LOW, full CRUD)**: 10 new command groups (folders update/delete/unassign/assignments, dotfiles list/upload/download/manifests, conflicts list/resolve, snapshots list, restore, browse local/s3/restic/jobs, notifications list/channels, hosts list/rename, register, shares list, admin prune). Destructive commands (`folders delete`, `folders unassign`, `restore`, `hosts rename`, `admin prune`, `dotfiles manifests delete`) go through `confirmDestructive()`: TTY prompt for interactive contexts, hard requirement of `--yes`/`-y` non-interactively (safety rule 5). Route-coverage audit: every non-daemon route in `packages/server/src/routes/` has a CLI equivalent OR a documented reason it doesn't (WebSocket stream → API, daemon-only `report`/`config`/`release` endpoints → out of agent scope).
- **No git mutations** per the LAMA-227 handoff rule: the working tree is dirty for the maintainer's review. CI drift-check + `bun x tsc --noEmit` + `bun test` are all green locally before the hand-off.
- Production deployment topology, the v0.3.1 self-update fix, the dogfood session, and all earlier status entries (below) remain unchanged.

## Historical status (as of 2026-08-10)

- Project version: **0.3.1** (tagged 2026-08-10; ships LAMA-183 batches, LAMA-221..226, and UX program WS1–6 to daemon/TUI clients via GitHub Releases. v0.3.1 patches the self-update: compiled daemons could never `--update` — `argv[1]` is the bunfs virtual path, so the rename target didn't exist; fixed via `resolveSelfBinaryPath` in `self-update.ts`. **v0.2.3 and v0.3.0 daemons can only move forward via `packaging/install/update.sh`**, not in-binary `--update`.)
- **UX improvement program complete — workstreams 1–6 shipped (2026-08-10)**: WS1 hidden API power + WS2 onboarding/explanations (commit `5094bbb`), WS3 TUI foundations + wizard-flow fixes (`fe65bc8`), WS4 remaining features (per-folder sync history UI, restic restore UI, DataBrowser job-based delete + base64 download, shared Modal/ConfirmDialog/PromptDialog replacing all window.prompt/confirm, Admin Server block on extended `GET /health`, cron + backend validation sweep, Login remember-me, sync-note name resolution). WS4 review fixes: download local branch now uses `resolveBrowsePath` realpath containment (symlink escape → arbitrary file read, regression test in `browse.test.ts`); Dashboard storage-refresh error now visible once data has loaded. Remaining nits (non-blocking): S3 download buffers the object before the 64 MiB check; S3 missing-key returns 400 not the Swagger-advertised 404; Admin Server block swallows `/health` failure into "—" placeholders; web cron validator accepts `@noon` etc. that the daemon can't schedule; rename-with-unchanged-name silently no-ops. Details in `docs/features.md` and the historical memsearch note `2026-08-08-handoff-workstreams.md`.
- **Dogfood session done (2026-08-10)**: the report and screenshots were archived after the findings were resolved — 0 blockers, 4 should-fix, 3 nits. WS5 visual sweep passed in both themes. **WS6 fixes landed + reviewed (2026-08-10)**: DataBrowser stuck-skeleton fixed both sides (RefBrowser/S3Browser effects keyed on primitive ref fields + `useMemo`/`useCallback` at call sites); all 9 bare `confirm()` sites now use the shared ConfirmDialog; AssignmentEditor has live custom-cron validation reusing `web-ui/src/cron.ts` and shows folder/host names instead of UUIDs; Dashboard needs-attention resolves folder names; theme toggle announces current + next state. Gate green (tsc clean, 475 tests). Watch item: CLI fallback silently defaults to localhost/dev-key when no client.toml exists (parked for maintainer decision). Remaining manual item: interactive TUI checklist L in the dogfood doc.
- **Production deployment check (2026-08-10)**: verified via the API (no SSH from cachy — root key denied). Prod tracks **master**, not tags: CI publishes GHCR `:latest` on every master push and the LXC's 04:00 cron pulls it, so prod ran ~the 2026-08-06 master (has LAMA-199/221..226; WS1–6 arrive with the 2026-08-11 04:00 pull). Daemons track GitHub Releases instead — latest release is v0.2.3 (2026-07-22), ~60 commits behind the server; heartbeats still compatible. Offline hosts were NOT version mismatch: `cachy`'s user daemon had been SIGTERM'd at 17:21 (restarted, back online); `CachyTop` simply hasn't heartbeated since 2026-08-09 12:42 (machine likely off/asleep, daemon predates version reporting). Found + fixed a real bug: `GET /config/:hostId` never selected `config_revision`, so it always emitted 0 and every daemon re-pulled its full config every 30s heartbeat ("revision drift (cached=0 server=N)" log spam) — one-line SELECT fix + regression test (`config.test.ts`), in with the WS6 push.
- Tests: **476 passing** across 50 files, 1 skip (pre-existing), 0 failures.
- **Web UI Data page blank-screen fixed (2026-08-06, committed `ce1d644`)**: clicking "Data" blanked the whole app. Root cause: `RefBrowser` in `packages/web-ui/src/pages/DataBrowser.tsx` declared a prop literally named `ref`, which React 18 strips from function-component props, so it always arrived as `undefined` and the first render threw `Cannot read properties of undefined (reading 'path')`. Fix: prop renamed to `browseRef` (destructure-aliased) at the definition and three call sites. Verified live in the Orca browser against a local dev server — page renders, zero console errors.
- **Deployment topology note**: TrueNAS is not involved anywhere. The production server is the LXC container `lamasync` at `100.113.52.108` (GHCR image, 04:00 cron auto-update); all server-side data and the small local backups live in Docker volumes local to that LXC. Web-UI fixes reach prod by tagging a release (CI publishes the GHCR image, the LXC's cron pulls it overnight).
- **LAMA-221..226 shipped** (batch: notification channels UI, reusable S3 backends with encrypted secrets, tailnet IP surfacing, storage stats, host rename, Data Browser write ops) — see `docs/features.md`. Pushed to master 2026-08-03 (26 commits, `32e983f..fa3a12e`), CI green (check/build/docker), deployed to production the same day.
- **Pre-push review fixes landed (this pass)**:
  - **P0-1 (LAMA-226)**: S3 write ops thread the bucket through `rclone` argv (`src:bucket/prefix/key`) instead of treating the first path segment as a bucket name. The pure config/argv builders live in `browse-rclone.ts` and are unit-tested without rclone.
  - **P0-2 (LAMA-226)**: `browse-ops.test.ts` e2e tests now skip cleanly when rclone is absent; `bun test` is hermetic again.
  - **P0-4 (LAMA-218)**: shared `defaultSocketPath` helper in `@lamasync/core`. Daemon + TUI + systemd unit template + `install.sh` + `test-install.sh` + docs all agree. `%h` in systemd PATH works for `/root`. `socketPath` is now honored from `client.toml`. `~/.lamasync/lamasync.sock` fallback dir is created before bind.
  - **P0-3 (LAMA-222)**: legacy s3_* DROP COLUMNs moved out of the unconditional `MIGRATIONS` runner into `LEGACY_S3_DROP_MIGRATIONS`, applied only when `initDb` is called with `{ dropLegacyS3Columns: true }` — which the server does solely after the lift reports success. The lift itself is now a single transaction, reports `clean`/`lifted`/`failed`, and skips folders that already point at a backend (converges after pre-transactional partial lifts). On failure the columns are kept and the boot continues degraded with a loud log (deliberate deviation from the handoff's "abort startup": getDb's fallback would have opened an empty in-memory DB, and a boot refusal + systemd restart-loop bricks the server). Tests: forced-failure rollback + retry convergence (backends.test.ts), gated-drop invariant (core test.test.ts).
  - **P1-1 (LAMA-221)**: web UI `updateNotificationChannel` switched from `apiPut` → `apiPatch` to match the server route.
  - **P1-2 (LAMA-226)**: local self-move rejection (same-path + nested-under) and S3 same-folder prefix allowance for intra-bucket moves.
  - **P1-3 (LAMA-226)**: busy-guard now stores and probes the same canonical `destKey(ref)`. Stuck `running` jobs are reconciled at boot. Guard extended to rename/mkdir/upload and to source contention. `null as never` / `as BrowseJobOperation` casts removed.
  - **P1-4 (LAMA-223)**: `parseIpAddrOutput` narrowed to the CGNAT /10. `detectTailnetIp` checks `tailscale0` first, then `tailscale status --json`, then the default-route iface. `parseTailscaleStatusJson` prefers the IPv4 entry. Rclone config emits two peer sections (tailnet + `-lan` fallback) when both addresses are known. Heartbeat bumps `config_revision` on `tailnet_ip` change so daemons re-pull.
  - **P1-5 (LAMA-225)**: cascade now updates `dotfile_manifests.original_uploader_host_id`. `host_renamed` is broadcast at re-registration with real old/new ids (PATCH endpoint no longer emits the half-wired event). Cascade test seeds every host-keyed table.
  - **P1-6**: `withTempRcloneConfig` helper replaces three `/tmp/...conf` sites (`backends.test`, `stats.rcloneSize`, `browse-jobs`). Each call gets a private `mkdtemp` dir + 0600 file + `try/finally` cleanup.
  - **P1-7 (LAMA-224)**: `/folders/:id/size` returns `{bytes:null, error:"not measurable server-side"}` for non-S3 folders; Folders UI renders "n/a". Stats endpoint no longer fabricates an entry for bucketless backends. `stats.test.ts` `afterEach` removes the actual base dir (was leaking temp trees). Folders size requests now sequential (was N parallel rclone processes per page load).
  - **P1-8 (LAMA-225)**: Dotfiles `scopeKey()` aligned with `<select>` option values. Stale-response guard via request-counter token.
  - **P1-9 (LAMA-226)**: write-op `kind` schemas are `t.Union([t.Literal("local"), t.Literal("s3")])`. Rclone stderr is scrubbed from API responses AND async job errors (full stderr logged server-side via `rcloneFailure`; jobs carry a generic message). `body as {…}` casts replaced with Elysia-validated body types.
  - **Verification round (after the fix commits)**: a re-review of the fix range found four regressions introduced by the fixes themselves, all repaired: (1) Dotfiles stale-response guard compared against a render-time snapshot so the page never loaded; (2) S3 upload argv passed the temp file as `<tmp>:` (ENOENT) and referenced a `[dst]` remote the same-folder config doesn't emit — argv now uses the bare temp path and the correct remote name, and the same-folder branch emits a single `[src]` section; (3) `isSafeS3IntraFolderMove` degenerated at the bucket root and ignored `names` (moving root-level `dir` into prefix `dir` would delete data) — now mirrors the local containment check per entry; (4) `test-install.sh` grepped `/root/.lamasync` in `ReadWritePaths` where the unit writes `%h/.lamasync`. Plus: same-folder s3 copy/move argv referenced the nonexistent `dst` remote (would have failed at runtime — the exact intra-folder move P1-2 enabled), `FolderSize.bytes` is `number | null` with the bucket-level caveat documented, and the dead `?refresh=1` param removed from the web client.
- Install scripts and release workflow unchanged by this batch.
- **Install scripts**: `packaging/install/install.sh` and `packaging/install/update.sh` patched to be self-contained and aligned with the CI-published binary names (`lamasyncd`, `lamasync-tui`). Docker smoke tests (`scripts/test-install.sh`, `scripts/test-update.sh`) both pass.
- **LAMA-173 done**: TUI unified into a tabbed shell with 6 persistent views and 2 guided wizards; LAMA-167 Enter-crash invariants preserved.
- **LAMA-183 complete (2026-08-01)**: all seven epic issues done — LAMA-199/201 (batch 1), LAMA-197 (batch 2, 60651d8), LAMA-198 (batch 3, 3f4594d), LAMA-200 (bfa1a07), LAMA-202 (a449160), LAMA-203 (954ecec). Full dogfood/testing handoff was archived; the implementation summary is in `docs/features.md`.
- **LAMA-183 dogfooded (2026-08-01)**: full-epic session against a local dev server (report archived) — zero critical; 2 high + 3 medium + 1 low filed as LAMA-205..210. **Dogfood fixes landed (2026-08-02, commit 41c7cad)**: LAMA-205/206/208/209/210 fixed and verified live; LAMA-207 closed as not-an-app-bug (agent-browser below-fold click artifact). Daemon-dependent checks (D4/D5) and live S3/ntfy delivery still untested.
- **LamaDB integration (LAMA-204, LamaDB project)**: receiving endpoint for the LAMA-200 webhook (`POST /api/lamasync/webhook`) — LamaSync side is live and env-gated via `LAMASYNC_LAMADB_WEBHOOK_URL`.
- The current Multica board is authoritative for issue status. The previous 2026-08-18 snapshot is superseded by the 2026-08-22 summary near the top of this file.
- **Production server**: running on LXC container `lamasync` at `100.113.52.108` via Docker image `ghcr.io/aliforfaen/lamasync-server:latest`. Deploy lives under user `messhias`'s home on the LXC (`/home/messhias/lamasync/` — `docker-compose.yml`, `update.sh`, `.env`, `update.log`); SSH access from this host uses `ssh -i ~/.ssh/lamasync_key root@lamasync`. Daily 04:00 cron (messhias's user crontab, `0 4 * * * /home/messhias/lamasync/update.sh`) pulls the latest GHCR image and recreates the container; manual `ssh root@lamasync '/home/messhias/lamasync/update.sh'` does the same on demand.
- **Production deployment consolidated (2026-08-03)**: the 04:00 cron updater had been silently failing since 2026-08-02 — the live container belonged to compose project `docker` (from the `~/lamasync/src/docker/` checkout, with an override bind-mounting a stale `/tmp/lamasync-server` binary over the image's own), while `~/lamasync/update.sh` drove project `lamasync` and died on the container-name conflict. Fixed: `~/lamasync/docker-compose.yml` now references the live volumes `docker_lamasync-data` / `docker_lamasync-backups` as `external`, the two `.env` files' differing API keys were reconciled to the one live clients use, and `update.sh` was run by hand — new image pulled, container recreated under project `lamasync`, healthy in seconds. Boot log clean (no legacy S3 lift needed, gated DROP path never fired); host `cachy` heartbeating fine. Pre-swap backup of `/data`: `~/lamasync/pre-migration-backup-2026-08-03` on the LXC. Leftover cruft safe to delete on the LXC: `/tmp/lamasync-server` (95MB stale binary), orphaned `lamasync_lamasync-data` (holds a stale 2026-07-21 DB — look before deleting) and `lamasync_lamasync-backups` volumes, and the `~/lamasync/src` checkout if the local-build fallback is no longer wanted. (All `~/lamasync/...` paths above are relative to user `messhias`'s home, i.e. `/home/messhias/lamasync/...` on the LXC.)
- **Web UI final pass (2026-08-02)**: audit + fixes — Add-host onboarding guide (copy-pasteable install commands, `web-ui/src/components/AddHostGuide.tsx`), folder assign/unassign UI on the Folders page. Testing guide was archived. Findings filed as LAMA-211..217 (dotfiles edit-form clobber, dead hotkey hints, conflict-resolve confirm, operations page, assign hostId validation, unwired TUI backup wizard, web-ui polish).

## Next session options

Ready-to-pick work, ordered by likely value/urgency:

1. **Merge PR #1** (owner) — the full coding-agent batch + prior flourishes
   are pushed and CI-green; the what's-new doc has the review notes.

2. **Live-LXC items** — LAMA-273 (pause/slow mode), LAMA-266 (backup fire
   drills), LAMA-262 (pairing), plus live verification of LAMA-263/264 and
   the new 257/269/282 surfaces against a real daemon — with the main
   orchestrator (`docs/handoff-273-266-plan.md`).

3. **LAMA-249 Phase 7 leftovers** — fuller screenshot/GIF set + filing the
   audit findings (dogfood doc #1–#5), and the first `v*` release tag
   (removes the build-from-source install gap).

4. **LAMA-247 remainder** — op-log export, ntfyUrl dead code, dotfile diff
   preview, renderer smoke tests, env-table doc (see the LAMA-247 comment).

5. **LAMA-110 — Oh-My-Pi inspiration** (todo, urgent)
   - Pull OMP-specific features/conventions into a lighter Pi runtime. Likely overlaps with management UI and runtime simplification.

6. **LAMA-228 — TUI runtime-verify clean process exit** (todo, medium)
   - LAMA-182 fixed it statically (commit `cbb10a1`); nobody has watched the actual process exit yet. Run the pty harness against dead + live servers.

7. **LAMA-204 — LamaSync → LamaDB webhook receiver** (todo)
   - Cross-project: LamaSync side is live (env-gated), the LamaDB side doesn't exist yet. Builds the Life OS timeline.

8. **LAMA-237 / LAMA-236** (backlog, no priority)
   - Host Types (laptop vs server, etc.) and Fleet software management. Larger features; revisit when the above is quiet.
