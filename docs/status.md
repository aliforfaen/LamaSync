# Status & work queue — LamaSync

Updated 2026-09-08. This is the current state, not an append-only changelog.
Older release notes and completed work are in
[`archive/status-2026-08-through-2026-09-03.md`](archive/status-2026-08-through-2026-09-03.md).

## Current release

v0.3.7 is deployed; the source tree is at v0.3.9 pending release. The server,
daemon, CLI, web UI, agent skill, and deploy agent build from the same Bun
workspace. CI runs type-check, web build, tests, strict skill drift, and
distributable binary build.

## Recently shipped

- **LAMA-324 — app backup storage destinations (server-relay).** Each
  application protection can select an s3/local/nfs backend destination
  (restic rejected); the server stages every daemon tarball outside browse
  roots, verifies size + SHA-256, revalidates protection + destination
  immediately before publication, and relays under the fixed key
  `lamasync/apps/<protectionId>/<snapshotId>.tar.gz` (or atomically renames
  into the server archive as before). Every snapshot persists its immutable
  physical location (`backend_id`/`object_key`/`s3_bucket` frozen at capture
  time); download/delete dispatch from those stored values with no silent
  fallback, and a failed archive delete keeps the row (502) for retry.
  Backend deletion is blocked while protections reference it or snapshots
  remain stored there. The storage adapter
  (`packages/server/src/app-storage.ts`) exposes the reusable delete
  primitive LAMA-325 retention builds on.
- **LAMA-325 — smart retention + basic strategies (v1).** A pure
  deterministic retention evaluator (`packages/core/src/retention.ts`):
  UTC calendar buckets with newest-successful-per-bucket, keepLast /
  keepAge / daily / weekly / monthly / yearly rules, always-keep-at-least-
  one-successful, pins/holds + unfinished rollback artifacts overriding
  every rule, future/bad timestamps kept for safety, unknown sizes surfaced
  as unavailable accounting. Smart retention is a preset that expands into
  visible normalized rules. Policies attach to the protected resource
  (app protection / restic-backed folder) and are disabled/null by default
  (conservative — existing data is retained). REST surface:
  GET/PUT policy, read-only preview, and confirmed execution
  (`confirm: true`) that re-evaluates fresh state, records per-item
  outcomes in Activity, and never reports a failed deletion as pruned.
  App-archive deletes reuse the LAMA-324 adapter (exact stored location);
  restic folders run `restic forget` + `prune` per repository. Folders
  without snapshot identity (ordinary backup/sync/mount trees) are refused.
  No automatic destructive scheduling — preview/manual execution only.


- **LAMA-323 — TUI removed, CLI extracted to `packages/cli`.** The
  interactive OpenTUI shell is gone (`@opentui/core` dependency dropped);
  `packages/tui` became `packages/cli` building the non-interactive
  `lamasync` binary (bare invocation prints help, exit 0). The legacy
  `lamasync-tui` name ships for one transition release as a copy of
  `lamasync` with a stderr-only deprecation notice; the installer gains
  `--with-cli` (with `--with-tui` as a deprecated alias) and update.sh
  refreshes a pre-existing `lamasync-tui` in place. First-run setup is
  handled by `lamasync register` + the install script; fleet management is
  web UI + REST API (agent skill). Follow-up: LAMA-326 trims the CLI to its
  local-daemon surface.

- **LAMA-296 (stage 2) — automatic camera protection.** On top of the
  stage-1 baseline, the Android companion now discovers camera photos/videos
  (and optional screenshots) through real MediaStore queries, keeps a
  durable device-local registry (stable `collection:<id>@<volume>` identity,
  per-collection/volume discovery cursors, settings, per-collection
  permission authority), and automatically protects them into the
  server-approved **Camera** inbox via the stage-1 resumable engine — no
  server or wire changes. New-only boundaries are race-safe; existing-history
  import completes into a retained high-water boundary with incremental-new
  passes afterwards; edits (size or date-modified delta) are re-protected;
  every completed discovery page is committed atomically so process death
  never skips a file; LOCALLY_DELETED is only claimed for revisions already
  verified PROTECTED (a source lost before protection is UNREADABLE, and a
  staged row finishes its upload from the private copy); queue completions
  reconcile the registry so coverage and "last successful protection"
  advance from real uploads. Permission authority is per collection (a
  denied collection is never scanned, deleted or counted covered);
  automatic transfer conditions are separate from manual upload policy
  (dedicated drainer, manual semantics unchanged); transfers promote to a
  dataSync foreground-service worker regardless of the notification grant
  (graceful degradation only when the OS refuses). A review correction
  round fixed these semantics with focused regressions — see
  [`report-296-stage-2-auto-protection.md`](report-296-stage-2-auto-protection.md)
  (correction round) and
  [`spec-296-stage-2-auto-protection.md`](spec-296-stage-2-auto-protection.md).
- **LAMA-296 (stage 1) — usable manual uploads.** On top of the accepted
  phase-1 baseline: Android share/document intake (`ACTION_SEND`/`_MULTIPLE`
  + `ACTION_OPEN_DOCUMENT`), a durable queue bound to the enrollment identity,
  a WorkManager transfer worker (survives process death/reboot; resumable via
  durable server offsets), an honest status screen (queued/uploading/
  needs-attention/failed/cancelled/verified + progress + retry/cancel +
  receipt with an **Open in web UI** deep link), and a per-device inbox
  management surface in the Admin **Android devices** panel (registrations
  default to **no upload access**; inboxes are server-computed
  `Mobile/<hostId>/<slug>`). Server: scoped `mobile_upload_destinations` +
  resumable `mobile_uploads` (idempotency keys, bounded chunks, SHA-256
  verification, atomic publication, retry-safe finalized-recovery across the
  publish/DB crash window, per-request + pre-publication authorization,
  staging outside the browse tree with quota/TTL reconcile, cancellation that
  never deletes a published file, one `operation_log` row per intent with the
  real mobile host id). Verified over the disposable HTTPS vertical:
  a 65 MiB+ file transferred chunk-by-chunk (≤ 1 MiB payloads) through the
  real stack, checksum-matched and visible in the Data Browser, plus a
  checksum-mismatch negative. See
  [`report-296-stage-1-manual-uploads.md`](report-296-stage-1-manual-uploads.md).
- **LAMA-296 (phase 1) — Android companion foundation.** Stage 0 of the
  Android handoff: a sideloadable Kotlin app (`android/`, app id
  `app.lamasync.companion`, minSdk 26 / compileSdk 35) that scans a
  desktop-generated QR, exchanges a ten-minute one-time enrollment for a
  server-created host identity plus **two separate credentials** — a native
  bearer confined to `/api/v1/mobile/me` + check-in and a web grant that
  bootstraps a 12-hour cookie session carrying full fleet administration —
  and opens the existing web UI in a hardened WebView with no second login.
  Secrets are hashed server-side (no plaintext replay), stored on-device
  under Android-Keystore-backed AES-GCM, and excluded from backup. Desktop
  gains an Add-Android-device modal (case-preserving versioned JSON QR,
  expiry countdown, terminal-state polling, regenerate, revoke) plus a
  persistent Android-devices panel on Admin (`GET /api/v1/mobile/
  registrations`, revoke by hostId after reload); the SPA gains a dual
  bearer/session auth mode with CSRF + exact-Origin enforced on cookie
  mutations; revocation atomically kills native token, web grant, all
  sessions, and live WebSockets. Android-native uploads, background work,
  and camera/media features remain deferred (handoff stage 1+). A review
  round (findings 1–7) shipped origin-bound enrollment resumption,
  same-bootstrap cookie+CSRF disconnect, `__Host-`-correct cookie expiry
  with honest local cleanup, fail-closed non-admin sessions, stage-aware
  bootstrap retry, the persistent revoke panel, and
  authorization-header-first auth. The full HTTPS vertical (enrollment →
  authenticated SPA → restart → logout/reconnect → native disconnect with a
  cookie → desktop revoke after reload → offline cleanup) is verified on the
  API 35 emulator against a disposable local HTTPS server; boot/install/
  launch plus 16 instrumented tests are green (see
  `docs/report-296-phase-1-android-foundation.md`).
- **LAMA-316 — application templates, protections, and snapshots.** The
  legacy profile/manifest/version model is replaced by an explicit
  `ApplicationTemplate → ApplicationProtection → ApplicationSnapshot` contract.
  Protections are host-bound, schedule directly in the daemon, and retain an
  immutable snapshot history. Legacy tables remain read-only for migration
  safety; `_global` inheritance and the `lamasync dotfiles` CLI namespace are
  gone.
- **LAMA-307–310 — device setup and release hardening.** New sync targets are
  created safely where appropriate, duplicate runs are serialized, home paths
  expand correctly, initial read-only mount setup is available, and sandbox
  release discovery is documented.
- **LAMA-302 — event-triggered local sync.** Opt-in Linux inotify watching,
  debounce/single-flight execution, Git-aware filtering, operation trigger
  origins, and the web/API contract are complete; a real daemon soak against
  a busy Git worktree confirmed one bounded watch-triggered bisync run.
- **LAMA-320 — mount lifecycle hardening.** `--allow-other` is passed to
  rclone only when `/etc/fuse.conf` enables `user_allow_other` (otherwise
  mounts start single-user with a daemon warning); mount readiness is real
  FUSE detection via mountinfo, so a plain directory is never reported
  mounted; failed rclone startups log the exit code plus a bounded (~8 KiB)
  stderr tail; per-mount systemd units now live in the ephemeral
  `$XDG_RUNTIME_DIR/systemd/user/` runtime dir and are re-created at daemon
  boot and config refresh — nothing persists, and the daemon service unit
  stays in `~/.config/systemd/user`.
- **LAMA-319 — self-update EXDEV fix.** `lamasyncd --update` stages the
  download inside the binary's own directory instead of `os.tmpdir()`, renames
  atomically without ever unlinking the installed binary first, and cleans up
  only its staged file. Updating no longer fails (or can strand the binary)
  on hosts where `/tmp` and `~/.local/bin` are different filesystems, as
  observed on `norheim`.
- **LAMA-321 (first pass) — trash management in the Data Browser.** Freedesktop
  trash layouts (`.Trash-<uid>`, `.Trash/<uid>`) are detected only at a browse
  root or configured folder destination on Local and S3 listings; each trash
  card supports on-demand recursive size via the
  new `POST/GET /browse/size` job (paginated S3 aggregation, cached results —
  also fixes measured prefixes showing 0 B) and an explicit Empty-trash action
  reusing the audited browse-delete job with an irreversible confirmation.
  Automatic retention scheduling is intentionally deferred to a follow-up.
- **LAMA-299/301 — remote daemon update and controlled server deploy.** The
  server has no Docker socket or arbitrary shell endpoint; a narrowly scoped
  LXC deploy agent runs the fixed deployment script.

## Active follow-ups

0. **LAMA-296 stage 2 — real-device soak.** Automatic camera protection is
   emulator-verified (see
   [`report-296-stage-2-auto-protection.md`](report-296-stage-2-auto-protection.md));
   the remaining evidence is a one-day real-phone run (Doze/battery,
   overnight scheduling, existing-history import at scale, OEM camera
   paths, a real partial-access selection, and a server restart mid-
   transfer).

1. **LAMA-315 — path classification and recommendation UX.** The design
   handoff is written: [`handoff-315-path-classification.md`](
   handoff-315-path-classification.md) audits the current capture-spec model
   and proposes taxonomy, data model, and staged delivery. Next step is
   implementing stage 1 of that proposal.
2. **Application setup/restore executor.** Build the target-side wizard:
   preflight, dry-run/change plan, populated-target decisions, revalidation
   before writes, rollback artifact, and execution journal. Direct app restore
   remains intentionally unavailable until this exists.
3. **LAMA-311 — daemon home-path sandbox.** The unit contract and local/Docker
  validation are complete; production-client rollout/acceptance on `cachy`
  remains pending because it requires an explicit restart/update authority.
4. **LAMA-321 follow-up — trash retention.** Optional per-folder
   `trashRetentionDays` with `.trashinfo` DeletionDate-based cleanup; deferred
   from the first pass to keep deletion risk narrow. See the LAMA-321 issue
   handoff for the retention correctness rules.

## Known limitations

- The Android (LAMA-296 phase 1) flow requires an HTTPS front door and
  `LAMASYNC_ORIGIN` set to that canonical `https://` origin — enrollment
  exchange and web-session bootstrap 503 without it. Existing HTTP tailnet
  installations remain served by existing clients but cannot enroll an
  Android device until an HTTPS front door exists.
- LAMA-296 stage 2 ships automatic camera/media discovery and protection
  (camera photos/videos + optional screenshots) with durable device-local
  state; REAL-PHONE background-transfer behavior (Doze, battery, work
  constraints, overnight user flows) is still unverified — the API-35
  emulator vertical proves the protocol, scheduling machinery and
  MediaStore discovery; the stage-1 vertical (this worktree) is emulator
  verified. Uploads promote to a dataSync foreground-service worker on
  every supported API level (notification permission is not required — the
  FGS notification surfaces in the Task Manager even when the drawer
  notification is denied); the pass degrades to a plain constrained worker
  only when the OS refuses the background FGS start. Automatic transfer
  conditions (unmetered/charging) apply to automatic protection only;
  manual uploads keep their own stage-1 policy.
- App-capture archive rewriting currently relies on GNU tar's `--transform`
  behavior and is verified on Linux. There are no macOS or Windows clients in
  the fleet today; qualify their archive tooling before onboarding either
  platform for application capture.
- Application restore is inspect/download-only until the setup executor lands.
- The web UI emits a production bundle warning at roughly 727 kB minified.
  Code splitting is maintenance work, not a release blocker.

## Recent verification baseline

After the LAMA-324/325 review pass: `bun x tsc --noEmit`,
`bun run build:web-ui`, `bun test` (1447 pass), strict skill drift, and the
full distributable build passed. App archive relay/retention is covered by
hermetic route and adapter tests; no production deployment was performed.

LAMA-296 phase 1 baseline (this worktree): all six repo gates green
(`bun install`, `bun x tsc --noEmit`, `bun run build:web-ui`, `bun test` —
1523 pass / 9 skip, `bun run scripts/check-skill-drift.ts --strict`, `bun run
build`), plus the Android trio (`assembleDebug`, `lintDebug` 0 errors,
`testDebugUnitTest` 57/57) and the instrumented suite
(`connectedDebugAndroidTest` 16/16 on the API 35 `lamadb-test` AVD when run
with the disposable HTTPS harness; the four HTTPS-vertical tests skip cleanly
when no live server is configured).

LAMA-296 stage 1 baseline (this worktree): repo gates green (`bun x tsc
--noEmit`, `bun run build:web-ui`, `bun test` **1583 pass / 9 skip / 0 fail**,
strict skill drift OK, `bun run build`), Android `assembleDebug` + `lintDebug`
0 errors, `testDebugUnitTest` **77/77**, and the instrumented suite — 25 pass
with 6 vertical tests skipping cleanly without a live server, and **31/31
with the disposable HTTPS vertical** (three consecutive clean runs: phase-1
enrollment chain A–D + large 65 MiB+ chunked upload + checksum-mismatch
negative). APK sha256
`0686027dd6a9b369aaad42434c8fbe06ecedd1bea44f132897ce1f39ceaf1391`.

LAMA-296 stage-1 correction baseline (this worktree, review R1–R8): repo
gates green (`bun x tsc --noEmit`, `bun run build:web-ui`, `bun test`
**1580 pass / 9 skip / 0 fail** — the earlier 1,583-pass claim was corrected;
strict skill drift OK, `bun run build`), Android `assembleDebug` + `lintDebug`
0 errors (50 version-available warnings), `testDebugUnitTest` **86/86**, and
the instrumented suite — **42 pass / 6 vertical skip / 0 fail** without a live
server, **42/42 with the rebuilt disposable HTTPS vertical** (phase-1
enrollment A–D + 65 MiB+ chunked upload with server-side verification +
checksum-mismatch negative). APK sha256
`0891fe3302f749b7401660b592e4646be614ebf1c548f21724c346497f9d264a`.

LAMA-296 stage-2 correction baseline (this worktree, review round):
repo gates green (`bun x tsc --noEmit`, `bun run build:web-ui`, `bun test`
**1580 pass / 9 skip / 0 fail**, strict skill drift OK, `bun run build`),
Android `assembleDebug` OK + `lintDebug` **0 errors (55 warnings)**,
`testDebugUnitTest` **188/188**, and the instrumented suite — **55 tests /
0 failures / 2 in-class skips** on the API-35 `lamadb-test` AVD **with the
disposable HTTPS vertical** (phase-1 enrollment A–D, stage-1 manual verticals,
stage-2 auto-protect vertical incl. the real completion-reconcile path); the
two permission negatives validated per shell-prepared state (all revoked →
NOT_GRANTED; selected-only → PARTIAL). Real-phone soak remains the open
evidence gap.
