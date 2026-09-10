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

- **LAMA-329 (phases 5–7 of 8) — browser settings, installable web app, brand
  icon exports.** A browser `#/settings` route owns what only the browser can
  change (theme, install, connection) and renders the preference-ownership
  table — the documented answer to "which store owns every preference", held
  to invariants by a test. The web app is now installable: a manifest, an icon
  set and an asset-only service worker are served from the origin root by
  `webUiRoutes` (a service worker's scope and a manifest's `scope` both have to
  sit where the SPA does, so they cannot live under `/api/v1`), with the icon
  bytes embedded through a generated module because the SPA is inlined into one
  document and there is no asset directory at runtime. The worker caches the
  app shell ONLY — never `/api/` — and registration is skipped inside the
  Android companion, where a cached shell could outlive a server update with no
  way to clear it. Connectivity is now stated honestly: device-offline,
  server-unreachable and live-updates-paused are three different messages, and
  data is only flagged as possibly stale when a request actually failed. A
  review pass closed three gaps: `#/settings` now carries the whole browser-only
  preference set the plan named — density, the reduced-motion override (default
  system, mirrored onto `<html data-motion>` and honoured by both the CSS gates
  and `prefersReducedMotion()`), command-palette help, and session sign-out
  through a shared `sign-out.ts`; every raw request path (`apiBlob`, both
  multipart uploads, the boot probe) now publishes the same transport outcome as
  `apiFetch`, so a failed upload can no longer leave the banner saying only
  "Live updates paused"; and service-worker activation prunes only
  `lamasync-shell-*` caches instead of every cache on the origin. On the native
  side the adaptive icon gained its `<monochrome>` themed layer and the
  notification icon became the courier mark at 24dp, with the enrollment
  surface checked at font scale 2.0. See `docs/android-mobile-ux-plan.md` for
  decisions 10–16 and phase 8 for the verification that still needs a human.
- **LAMA-329 (phases 3–4 of 8) — mobile web navigation and the responsive page
  pass.** Below 900px the off-canvas drawer is replaced by two permanent
  surfaces: a compact rail from 640px up and a bottom tab bar with a More sheet
  below it. Four destinations stay in the bar (Dashboard, Devices, Managed
  folders, Backups) and the rest are one tap further in, with both sets derived
  from `GROUPS` so the phone and the rail cannot drift; the sheet also carries
  the shell actions (API docs, theme, sign out) the hidden rail footer held.
  Tab taps deliberately keep pushing history, so browser back and Android back
  behave exactly as they did with the drawer. The page pass fixed the three
  routes that scrolled sideways at 360px (`/apps/backups` 670px, `/operations`
  577px, `/admin` 632px of content in a 360px viewport) by collapsing
  multi-column tables to list rows, and a sub-900px table safety net keeps any
  other table from pushing the page out. Safe-area insets are wired for the
  bottom bar (`viewport-fit=cover` + `--safe-*`). See
  `docs/android-mobile-ux-plan.md` for the measured before/after numbers and for
  decisions 5–9, which record where this departs from the written plan.
- **LAMA-329 (phases 1–2 of 8) — native shell foundations and information
  architecture.** The Compose shell is now edge-to-edge, themed from the web
  UI's own design tokens, and owns a real navigation back stack.
  *Foundations:* `enableEdgeToEdge()`, backgrounds painted behind the system
  bars with every target and row padded inside `WindowInsets.safeDrawing`
  (system bars + cutout + IME), a light/dark Material 3 scheme derived token
  for token from `packages/web-ui/src/index.css` (Material You colouring is an
  explicit opt-in, off by default so the shell and the embedded SPA cannot
  disagree about the brand), and a window background that follows the
  *resolved* theme rather than the system one. *Shell:* the text-button strip
  is replaced by a Material 3 top app bar carrying the host, a
  connection-state dot **with a label** (never colour-only), a reload action, a
  live reconnect action and an overflow menu (Uploads, Camera protection,
  Settings, Open in browser). *Navigation:* `androidx.navigation` owns the
  post-enrollment destinations (Manage, Uploads, Camera protection, Settings,
  Connection, About) with a real back stack and predictive back
  (`enableOnBackInvokedCallback`); the enrollment flow deliberately keeps its
  existing ViewModel state machine, whose resume-from-EXCHANGED and
  unconfirmed-cleanup invariants are unchanged. Android back walks WebView
  history first and only then unwinds the back stack. *Settings:* a native
  Settings screen (Appearance, Transfers, Camera protection, Notifications,
  Browser experience, Connection, About, disconnect) in which every switch
  writes through the store that already owned that fact — no second source of
  truth — plus a browser-only `Appearance`/`Browser experience`
  `ShellPreferencesStore`. Pull-to-refresh is implemented with
  `SwipeRefreshLayout.setOnChildScrollUpCallback`, which is the only way to
  honour "never fire while the page is scrolled away from top" around a
  WebView. The embedded SPA receives a non-secret display-mode signal
  (`?lamasyncShell=android`, consumed once into session state, presentation
  only, never an authorization input). *Not yet implemented (phases 3–8):* the
  mobile web navigation rewrite, the per-page responsive pass, the browser
  `/settings` route, the vector adaptive icon and PWA/manifest asset exports,
  the service worker, and the screenshot evidence set. PWA assets are agreed
  to arrive as new server asset routes, because the SPA is served as one
  inlined HTML string with no static-asset route today. See
  [`android-mobile-ux-plan.md`](android-mobile-ux-plan.md).

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
5. **LAMA-329 phase 8 — the evidence sweep, and the items it exists to
   close.** Phases 3–7 shipped; see **Recently shipped**. What remains is
   verification that needs a human or a device, not more code:
   - **TalkBack** over the shell and the mobile nav: focus order, the
     connection indicator's label (it is not colour-only, but that needs
     hearing), and the More sheet's dialog semantics.
   - **Gesture vs 3-button navigation** on a device. Under 3-button nav the
     system bar takes bottom space, which is exactly where the tab bar now
     lives; the `safeDrawing` insets should handle it, but that is an
     inference from the API, not an observation.
   - **Installed-PWA launch**: title, icon, theme colour, scope, and that the
     installed app starts offline and still refuses to show stale data. The
     install prompt itself is confirmed (Chrome offered it), launching is not.
   - **The embedded WebView after the phase-3 nav change.** Tab taps push
     history, so Android back now walks tabs instead of leaving the app. That
     is the intended contract and it matches the old drawer's behaviour, but
     it is reasoned about rather than observed — the vertical harness needs a
     live HTTPS server.
   - **Font scale on the paired managed shell.** 2.0 is verified on the
     enrollment screen; the top app bar, the Settings rows and the tab bar are
     not.
   - **The new browser preferences.** Density (comfortable/compact) and the
     reduced-motion override in both directions are unit-tested and the CSS is
     exercised through the build, but the *look* of compact density at 360 and
     412px and the override visibly stopping a running animation in a real
     browser belong to this sweep. The review's fixes are covered by tests: the
     raw-fetch transport signals, the shared sign-out ordering, and
     service-worker activation pruning only `lamasync-shell-*`.

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
- Navigating away from the Android companion's management surface (to Uploads,
  Camera protection, Settings or Connection) disposes the WebView, so returning
  to it reloads the page. This is the pre-existing behaviour — the WebView was
  always owned by a composable branch — and the 12-hour cookie session survives
  in the app-wide cookie jar, so there is no re-login; the visible cost is a
  load. Preserving the live page across native navigation needs the WebView to
  live outside the nav graph and is deferred with LAMA-329 phase 8.
- `/backends` needs ~980px of table width, so at a 900–1000px viewport (desktop
  rail, no sub-900px safety net) the Storage destinations page still scrolls
  sideways by up to 80px. This predates the LAMA-329 nav work — it measures the
  same with the new rail suppressed — and is outside the phone gate phases 3–4
  enforced. Fixing it means deciding which of the seven storage columns is
  expendable at that width, which is a desktop information-architecture call,
  not a phone one.
- The Android notification small icon is a 24dp raster, not a vector. Android's
  own guidance prefers a vector there; producing one faithfully needs the
  designer's source SVG, which is not in the repo. The raster is derived from
  the approved art at five densities and was checked at true 24px against both
  a dark and a light status bar.
- `App` in `packages/server/src/app.ts` is typed as `Elysia` rather than
  `ReturnType<typeof createServerApp>`. The composed type of the plugin chain
  is at TypeScript's instantiation-depth limit: it type-checked at 158 routes
  and threw `TS2589` at 161. Nothing consumes the deep type. Adding many more
  detailed routes may need the app split behind a narrower facade instead.
- The web UI emits a production bundle warning at roughly 727 kB minified.
  Code splitting is maintenance work, not a release blocker.

## Recent verification baseline

LAMA-329 phase 5–7 review pass (this worktree): `bun x tsc --noEmit`,
`bun run build:web-ui` (still one self-contained `index.html`), `bun test`
**1540 pass / 0 fail** (+31 over the phase-5–7 baseline), strict skill drift OK
(160 API rows / 161 server routes / 11 CLI commands; no route, command or flag
changed). The added coverage is the review itself: the full browser-only control
set (theme, density, the motion override across system/reduce/full, the
command-palette help and its open event, install, sign-out) with the two new
preference-ownership rows; the shared `sign-out.ts` ordering (server
invalidation before any local clear, and a server that will not confirm the
logout leaving the session usable); transport-outcome publication from
`apiBlob`, `uploadAppSnapshot` and `uploadFolderFile` (a transport rejection
fires `lamasync:request-failed`; a 4xx/5xx fires success, because the server
answered); and an executed service-worker activation that deletes
`lamasync-shell-v0` while leaving a foreign cache intact. No Kotlin changed, so
the Android baseline below still stands.

LAMA-329 phases 5–7 baseline (this worktree): `bun x tsc --noEmit`,
`bun run build:web-ui` (still one self-contained `index.html`), `bun test`
**1509 pass / 0 fail** (+34, covering the preference-ownership invariants, the
three connectivity states, the install gate, the service-worker gates, the boot
state's llama pose, and the manifest/icon/service-worker routes), strict skill
drift OK with the three new root routes documented in `reference/api.md`.
Measured in a real browser against the built bundle: all 12 routes (now
including `/settings`) report `scrollWidth == viewport` at 360, 412, 600, 768
and 1280px and in landscape at 800x360 and 915x412; the tab bar and the rail
stay mutually exclusive; no phone control is under 48px; Chrome fired
`beforeinstallprompt`, which is Chrome's own install criteria being satisfied;
and the shell cache contains only shell paths with no `/api/` entries. Stopping
the server confirmed the designed pairing: the cached shell boots, the banner
says changes will not be saved, and the Dashboard shows its empty state rather
than stale numbers. Android `assembleDebug`, `lintDebug` 0 errors, 215 unit
tests and **66/66 instrumented** — including the upload-cancellation test that
exercises the changed foreground-service notification — plus a font-scale 2.0
check on the emulator.

LAMA-329 phases 3–4 baseline (this worktree): `bun x tsc --noEmit`,
`bun run build:web-ui` (the inliner still produces a single self-contained
`index.html`), `bun test` **1475 pass / 0 fail** (18 added for the mobile nav,
including a partition test that proves every destination is reachable in one or
two actions and a route-coverage test that fails if a nav destination has no
`<Route>` — both verified by mutation), and strict skill drift OK (no route,
CLI command or flag changed, so the reference is untouched). The responsive
work was measured in the browser against the seeded demo fleet rather than
reviewed by eye: all 11 routes report `scrollWidth == viewport` at 360, 412,
600, 768 and 1280px, the tab bar and the rail are mutually exclusive at every
width, and no interactive control on a phone is under 48px. One pre-existing
failure remains outside that band and is listed under Known limitations.

LAMA-329 phases 1–2 baseline (this worktree): repo gates green
(`bun x tsc --noEmit`, `bun run build:web-ui`, `bun test` — **1457 pass / 0
fail**, strict skill drift OK), Android `assembleDebug` + `lintDebug` 0 errors
with no new warnings, `testDebugUnitTest` **208/208** (20 of them added for
this change, including a guard that fails if the Compose palette drifts from
the web design tokens), and the full instrumented suite — **66/66 on the API 35
`lamadb-test` AVD** (13 added here; the four HTTPS-vertical tests skip cleanly
without a live server). The added device coverage includes the paired shell
itself (seeded through the real vault and registration store, so the top app
bar, the nav graph, the WebView host and back navigation are all exercised) and
the pull-to-refresh gate against a real `SwipeRefreshLayout` and `WebView`. The
emulator run was driven with `adb -s`, never AGP device selection, because
several instrumented classes clear device credentials and must not run against
a paired phone. Phases 3–4 changed no Kotlin at all, so this Android baseline
still stands and was re-confirmed rather than re-derived.

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
