# Status & work queue — LamaSync

Updated 2026-09-07. This is the current state, not an append-only changelog.
Older release notes and completed work are in
[`archive/status-2026-08-through-2026-09-03.md`](archive/status-2026-08-through-2026-09-03.md).

## Current release

v0.3.7 is deployed. The server, daemon, TUI/CLI, web UI, agent skill, and
deploy agent build from the same Bun workspace. CI runs type-check, web build,
tests, strict skill drift, and distributable binary build.

## Recently shipped

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
- **LAMA-307–311 — device setup and release hardening.** New sync targets are
  created safely where appropriate, duplicate runs are serialized, home paths
  expand correctly, initial read-only mount setup is available, and sandbox
  release discovery is documented.
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

1. **LAMA-315 — path classification and recommendation UX.** The design
   handoff is written: [`handoff-315-path-classification.md`](
   handoff-315-path-classification.md) audits the current capture-spec model
   and proposes taxonomy, data model, and staged delivery. Next step is
   implementing stage 1 of that proposal.
2. **LAMA-313 — retention policy.** Define and implement practical snapshot
   retention/pruning before histories grow unchecked.
3. **Application setup/restore executor.** Build the target-side wizard:
   preflight, dry-run/change plan, populated-target decisions, revalidation
   before writes, rollback artifact, and execution journal. Direct app restore
   remains intentionally unavailable until this exists.
4. **LAMA-302 — event-triggered sync.** Implementation is complete; the
   remaining work is a live soak on a busy Git worktree. See
   [`handoff-302-event-triggered-sync.md`](handoff-302-event-triggered-sync.md).
5. **LAMA-321 follow-up — trash retention.** Optional per-folder
   `trashRetentionDays` with `.trashinfo` DeletionDate-based cleanup; deferred
   from the first pass to keep deletion risk narrow. See the LAMA-321 issue
   handoff for the retention correctness rules.

## Known limitations

- The Android (LAMA-296 phase 1) flow requires an HTTPS front door and
  `LAMASYNC_ORIGIN` set to that canonical `https://` origin — enrollment
  exchange and web-session bootstrap 503 without it. Existing HTTP tailnet
  installations remain served by existing clients but cannot enroll an
  Android device until an HTTPS front door exists.
- LAMA-296 phase 1 ships the native shell and QR/session foundation only:
  Android-native uploads, background transfer, and media/camera features are
  deferred to handoff stage 1+. The HTTPS vertical (scan-seam enrollment →
  authenticated fleet page → reconnect → disconnect → desktop revoke) was
  verified on the API 35 emulator against a disposable local HTTPS server in
  the review correction round; camera/desktop pointer automation and SPA
  live-event-row DOM rendering remain unverified (blockers recorded in the
  report). Boot/install/launch plus 16 instrumented tests are green on the
  emulator.
- App-capture archive rewriting currently relies on GNU tar's `--transform`
  behavior and is verified on Linux. There are no macOS or Windows clients in
  the fleet today; qualify their archive tooling before onboarding either
  platform for application capture.
- Application restore is inspect/download-only until the setup executor lands.
- The web UI emits a production bundle warning at roughly 727 kB minified.
  Code splitting is maintenance work, not a release blocker.

## Recent verification baseline

After the LAMA-319/321 pass: `bun x tsc --noEmit`, `bun run build:web-ui`,
`bun test` (1410 pass, 9 renderer-dependent skips), and strict skill drift all
passed. The LAMA-321 trash/size round trip is covered by hermetic route tests;
a live S3 empty-trash smoke on a real bucket is still outstanding.

LAMA-296 phase 1 baseline (this worktree): all six repo gates green
(`bun install`, `bun x tsc --noEmit`, `bun run build:web-ui`, `bun test` —
1523 pass / 9 skip, `bun run scripts/check-skill-drift.ts --strict`, `bun run
build`), plus the Android trio (`assembleDebug`, `lintDebug` 0 errors,
`testDebugUnitTest` 57/57) and the instrumented suite
(`connectedDebugAndroidTest` 16/16 on the API 35 `lamadb-test` AVD when run
with the disposable HTTPS harness; the four HTTPS-vertical tests skip cleanly
when no live server is configured).
