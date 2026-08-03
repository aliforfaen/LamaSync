# Status & work queue — LamaSync

Rolling status log. Updated at the end of working sessions; `AGENTS.md` only
carries a one-line pointer here.

## Current status (as of 2026-08-03)

- Project version: **0.2.3**
- Tests: **425 passing** across 45 files, 1 skip, 0 failures. With rclone off PATH: 417 pass, 9 skip (LAMA-226 P0-2 — e2e browse-ops tests gated on `Bun.which("rclone")`).
- **LAMA-221..226 shipped** (batch: notification channels UI, reusable S3 backends with encrypted secrets, tailnet IP surfacing, storage stats, host rename, Data Browser write ops) — see `docs/features.md`. No push yet; changes are local commits awaiting operator go.
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
- **Release**: v0.2.3 tag pushed; GitHub Actions will publish the matching release assets (`lamasyncd`, `lamasync-tui`, `lamasync-server`) and the GHCR Docker image.
- **LAMA-173 done**: TUI unified into a tabbed shell with 6 persistent views and 2 guided wizards; LAMA-167 Enter-crash invariants preserved.
- **LAMA-183 complete (2026-08-01)**: all seven epic issues done — LAMA-199/201 (batch 1), LAMA-197 (batch 2, 60651d8), LAMA-198 (batch 3, 3f4594d), LAMA-200 (bfa1a07), LAMA-202 (a449160), LAMA-203 (954ecec). Full dogfood/testing handoff: `docs/handoff/command-center-testing.md`.
- **LAMA-183 dogfooded (2026-08-01)**: full-epic session against a local dev server (`docs/handoff/dogfood-2026-08-01/report.md`) — zero critical; 2 high + 3 medium + 1 low filed as LAMA-205..210. **Dogfood fixes landed (2026-08-02, commit 41c7cad)**: LAMA-205/206/208/209/210 fixed and verified live; LAMA-207 closed as not-an-app-bug (agent-browser below-fold click artifact). Daemon-dependent checks (D4/D5) and live S3/ntfy delivery still untested.
- **LamaDB integration (LAMA-204, LamaDB project)**: receiving endpoint for the LAMA-200 webhook (`POST /api/lamasync/webhook`) — LamaSync side is live and env-gated via `LAMASYNC_LAMADB_WEBHOOK_URL`.
- Open Multica issues: LAMA-105 (Exoscale S3), LAMA-110 (OMP inspiration), LAMA-104 (error handling backlog), LAMA-157 (installation documentation), LAMA-165 (CI/CD binary release), LAMA-171 (`@reboot` / `@login` dotfile schedule triggers), LAMA-182 (TUI process lingers after quit).
- **Production server**: running on LXC container `lamasync` at `100.113.52.108` via Docker image `ghcr.io/aliforfaen/lamasync-server:latest`, with daily cron auto-update at 04:00.
- **Web UI final pass (2026-08-02)**: audit + fixes — Add-host onboarding guide (copy-pasteable install commands, `web-ui/src/components/AddHostGuide.tsx`), folder assign/unassign UI on the Folders page. Testing guide: `docs/handoff/web-ui-final-pass-2026-08-02.md`. Findings filed as LAMA-211..217 (dotfiles edit-form clobber, dead hotkey hints, conflict-resolve confirm, operations page, assign hostId validation, unwired TUI backup wizard, web-ui polish).

## Next session options

Ready-to-pick work, ordered by likely value/urgency:

1. **LAMA-105 — Backend storage: Exoscale S3 backend + basic tests** (in_progress, urgent)
   - Wire up the Exoscale S3-compatible backend as a folder target.
   - Add validation for `s3Endpoint`, `s3Bucket`, `s3AccessKeyId`, `s3SecretAccessKey`.
   - Run basic end-to-end tests: create folder, assign, daemon sync, verify object listing in bucket.
   - Revisit rclone config generation for S3 in `server/src/routes/config.ts` and folder validation in `server/src/routes/folders.ts`.

2. **LAMA-171 — `@reboot`/`@login` dotfile schedule triggers** (in_progress, urgent)
   - Scheduler special-token support + tests done; LAMA-168 (host selector, excludes, cron presets, deployment tracking) is done.

3. **LAMA-104 — Error handling** (backlog, high)
   - Harden error propagation, structured error responses, and retry/circuit-breaker behavior across the daemon and server.

4. **LAMA-110 — Oh-My-Pi inspiration** (todo, urgent)
   - Pull OMP-specific features/conventions into a lighter Pi runtime. Likely overlaps with management UI and runtime simplification.

5. **Polish / tech debt**
   - Dotfile diff preview against current disk files before extraction.
   - `nts` / tabbed-cycle keyboard interactions in OpenTUI native mode.
   - Multi-user auth scoping, operation-log archival.
   - Renderer smoke tests behind `LAMASYNC_TUI_TEST_VIEWS` (foundation already wired the gating).
