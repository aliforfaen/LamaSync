# Status & work queue — LamaSync

Updated 2026-09-19. This is the current state, not an append-only changelog.
Older release notes and completed work are in
[`archive/status-2026-08-through-2026-09-03.md`](archive/status-2026-08-through-2026-09-03.md).

## Current release

v0.3.7 is deployed; the source tree is at v0.3.11 pending release. The server,
daemon, CLI, web UI, agent skill, and deploy agent build from the same Bun
workspace. CI runs type-check, web build, tests, strict skill drift, and
distributable binary build.

## Recently shipped

- **LAMA-346 — initial large-folder seeding and progress-aware sync
  timeouts (first vertical slice).** A first full transfer is not a sync. On
  2026-09-17 `dev-vm`'s initial bisync against `master`'s 91,660-entry /
  14.86 GB Projects tree repeatedly hit the fixed 600-second wall-clock
  timeout with exit 143 *before any completed transfer or check*, in ~43.5
  minute retry cycles; the recovery that worked moved 850 items / 16.9 MiB and
  a later resync was zero-change.
  *Timeout fix:* `shouldExtendSeedDeadline` (shared, pure) replaces elapsed
  time with progress. A stage continues while measurable rclone phase/stats
  progress arrives, and fails on a stall (the old 600 s timeout, reinterpreted
  as a *stall* budget; an assignment's own `timeoutSec` replaces it) or at a
  6-hour absolute ceiling. The daemon applies it only to initial seed stages —
  a first run with **no usable baseline** (the dev-vm shape), an explicit
  `initialize`/`seed` intervention, or an explicit `seedStage` flag — so every
  ordinary run keeps its exact fixed timeout and no safety limit is weakened.
  *Seed path (opt-in, never automatic, source never inferred):* a measured
  folder at or above 3,000 entries gets a **recommendation**, never a trigger;
  a plan exists only after an admin
  `POST /folders/:id/seed-plans { hostId, sourceHostId, confirm: true }`, which
  is read-only. `sourceHostId` is mandatory and persisted: the device that
  holds the data must be assigned to the folder, must not be the target, and
  must hold a measurement fresher than 26 h — the planner never picks "the
  largest other assignment". The plan reserves `archive + extracted tree` ×
  1.25 + 64 MiB, requires staging to be a **true sibling** (the target's own
  parent directory, a `SEED_STAGING_DIR_PREFIX` name, outside the target, on a
  filesystem the target device itself proved — an unknown verdict fails
  closed), and prefers `tar + zstd` with a documented `tar + gzip` fallback.
  *Archive pipeline (implemented and fixture-tested end-to-end with the host's
  real GNU tar):* manifest with SHA-256 and a stats fingerprint → archive →
  member validation (safe relative path **and** regular file/directory, so
  traversal/symlink/device members abort) → extract into a sibling staging
  directory with no ownership/setuid restore → byte-for-byte verification →
  **one atomic rename** (a non-empty target is refused, never merged). mtimes
  survive, which is what makes the mandatory zero-content-change bisync
  baseline validation possible. The **manifest is the authority for what may
  be archived**: a member the folder's effective filter universe includes but
  a seed cannot represent (a symlink — the real Projects tree has 28, chiefly
  nested `node_modules`) blocks the run *before tar starts*, and the produced
  archive's member set must **equal** the manifest's or it is deleted and the
  run fails. The archive is built from the folder's **effective filter
  universe**, never the raw tree, and tar is given only the manifest's member
  paths — so excluded content cannot enter the archive at all.
  *Persistent job state machine:* ten ordered phases plus terminal states,
  stored in `folder_seed_jobs` with bounded progress, a renewable 10-minute
  lease (an expired lease means the owner is gone, never merely slow),
  idempotent completion, admin-only cancel, and `seed_job` WebSocket updates.
  *Filter-aware archive construction (Stage 1a, implemented):* the archive is
  built from the folder's **effective filter universe** — the exact
  `--filter-from` rule lines the executor writes (`lamasyncignore`,
  `ignoreGitMetadata`, and a Git-ignore snapshot when `respectGitignore` is
  on), compiled with rclone's own semantics and pinned by a cross-check test
  against the host's real rclone. `buildSeedSourceManifest(assignment, type)`
  is the single assignment → universe → manifest entry point, tar is given the
  manifest's member list (`--no-recursion --verbatim-files-from --null
  --files-from`, NUL-separated) so excluded content can never enter the archive
  **and a legal file name beginning with `-` is a name rather than a tar
  option** (measured: without the flags a file named `--directory=sub` changed
  tar's working directory), churn is measured inside the same universe, and a
  member the universe includes but a seed cannot represent — a symlink, a
  special file, or a name tar escapes in its listing (control character,
  backslash) — still fails closed before tar runs. Fixture-tested against the
  real Projects shape (nested `node_modules` symlinks + ignored content) and
  against hostile option-shaped file names with the host's real GNU tar.
  *Transport foundation (Stage 1b, contract only):* `@lamasync/core/seed-relay`
  defines the dedicated per-job namespace (`lamasync/seed/<jobId>/`), key
  validation with prefix containment — **lexical and actual**: every existing
  path component below the relay root is `lstat`-ed and must be a real
  directory, so a symlinked parent cannot redirect a read, write or delete
  outside (reproduced, then fixed and regression-tested against a real outside
  directory; race limits and the reason a full fix needs dirfd APIs are
  documented) — the immutable archive metadata (format,
  byte count, SHA-256, manifest fingerprint, member count) and the
  cleanup/retention state. `packages/daemon/src/seed-transport.ts` uploads with
  a digest computed locally, re-verifies the store's read-back, and **re-hashes
  the downloaded bytes on disk before anything may extract**; failures delete
  what they created. A local object store (`seed-relay-local.ts`) is both a
  legitimate store and the integration fixture. No configured S3, no rclone
  remote and no live host is touched: the store interface has no credential,
  endpoint or bucket parameter. Retention is decided — delete on the terminal
  phase, a 24 h window for abandoned objects, idempotent retries,
  namespace-confined sweeps, never delete on an unknown age.
  *Disposable two-host proof (Stage 2a):* `packages/daemon/src/seed-e2e.test.ts`
  drives the whole local chain inside one temp sandbox with two daemon-shaped
  identities — source effective filter universe → manifest → real GNU tar
  archive → local-object-store relay upload/download (re-hashed on disk) →
  sibling staging → extract → manifest verification → one atomic rename into an
  **empty** target — and then a **real `rclone bisync --resync` over the same
  filter rules that reports zero files changed**, followed by bidirectional
  edits, ignored-content checks, an anti-vacuity pair of roots and a modtime
  sensitivity test. Failure cases: insufficient target space (plan gate),
  unwritable archive destination, a tampered stored object, a store that lies
  about what it downloaded, a stalled stage, a non-empty target, and a
  filter-included symlink. rclone-gated with an explicit, named skip and a
  documented list of the host proofs still required (handoff §2.11).
  *Test-only job orchestration (Stage 2b):* `packages/server/src/seed-coordinator.ts`
  drives a seed job through the **existing** state machine — phases one at a
  time via `canTransitionSeedPhase`, lease renewal on every phase entry and
  progress report, archive facts persisted with `updateSeedJobArchive` before
  the target may run, terminal outcomes through the idempotent `finishSeedJob`,
  and idempotent cleanup recorded on the job. Injected source/target sides and an
  injected local object store keep it test-only: no configured backend,
  credential, rclone config or live host, no new table or column, and a
  bounded-foundation test reads the module graph to assert no production module
  imports it. The lifecycle proof covers completion, source and target failures,
  operator cancellation, a lost lease, cleanup idempotency, an illegal phase
  transition a side cannot ignore, and lease renewal. It also surfaced a real
  gap: **the source manifest does not travel to the target** — the target
  verifies the archive and the extracted tree against it, so making the manifest
  available to the target is still owed.
  *Ownership is atomic, not last-writer-wins.* The coordinator's claim, progress
  report and terminal write go through the ownership-conditional helpers
  (`claimSeedJobProgress` / `reportOwnedSeedJobProgress` / `finishOwnedSeedJob`),
  which decide inside the `WHERE` clause and return `null` on a zero-row write, so
  a refusal can never be mistaken for a success. A contender cannot claim a live
  owner's job, cannot write its outcome, and **cannot delete relay objects another
  owner may still be reading** (`seedCleanupAllowed` gates cleanup; a terminal job
  is nobody's, an in-flight one belongs to its live owner). An expired lease is
  claimable, a recorded owner with no expiry is not (fail closed, leave it to the
  reaper), and a run whose own lease lapsed reports `lease_lost` rather than an
  outcome it can no longer record. Completion additionally requires **every** seed
  phase to have been entered and archive facts to have been persisted, so a
  passing baseline cannot complete a job that never did the work. The device
  routes keep their own last-writer-wins contract: `seed-jobs.ts` is purely
  additive and `routes/folder-seed.ts` is untouched. **In-flight archive facts
  are conditional too** (`updateOwnedSeedJobArchive`): a run whose lease lapsed
  during a long source/target phase cannot overwrite the new owner's digest, so
  the target's verification authority cannot be corrupted from underneath it. The
  **cleanup** write stays deliberately unguarded (post-terminal by definition)
  and now only ever sets the `cleanup` field on a freshly read row, so a caller's
  stale in-memory facts can never be written back. And a **live lease is never
  claimable — not even by the same owner**: `owner` is a host id, not a run id, so
  allowing it let a second invocation on the same host claim a live job, rewind
  the phase to `preflight` and work concurrently; renewal goes through
  `reportOwnedSeedJobProgress`, which needs no claim. A same-host takeover after
  the lease has demonstrably lapsed still works (that is the recovery path).
  *Explicitly unavailable execution:* no real store is wired to a running job
  and remote orchestration is **not implemented**, so
  `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` is `false` (while
  `SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED` is now `true`),
  `POST /seed-jobs` returns `503 { executionAvailable: false, reason }`, and
  the Folders page renders a **disabled** control with that reason and a
  plain-language glossary — never a fake button. The timeout
  scope is stated precisely rather than as "ordinary sync is unaffected": a
  sync against an **existing, ready baseline keeps its exact fixed wall-clock
  timeout** (including a planned resync on that baseline), while a **first run
  with no usable baseline** — the dev-vm case — is supervised progress-aware.
  Design, space math, failure/recovery table, threat rules and the
  rollout plan are in
  [`handoff-346-initial-folder-seeding.md`](handoff-346-initial-folder-seeding.md).

- **LAMA-345 release-blocking plan/execution safety regression (live v0.3.12
  fleet validation).** Two defects, fixed at the layer that owned each.
  *Phantom "0 change" plans:* the executor's dry-run accumulator matched
  invented `"Would copy"` sentences that rclone never emits; modern rclone
  reports a suppressed operation through the machine-readable
  `"skipped": "copy|delete|make directory"` JSON field. Every planned dry run
  therefore reported 0 copies / 0 deletes / 0 bytes while the real resync
  copied the tree — cachy showed plan 0 then 349 transfers / 803,465,460 B.
  The accumulator now reads `skipped` (with the sentence as a legacy
  fallback), rclone's dry-run `transfers`/`deletes`/`bytes` give the true
  plan totals, and a dry run that does not complete fails planning instead of
  becoming a "0 change" plan. *Zero-content execution invariant:* the rule
  is **no unreviewed content mutation**, not "never rebuild a baseline". A
  reviewed plan whose dry run reported no copies, deletes or mkdirs is a
  legitimate **baseline-only recovery** (the listing pair is missing or unsafe
  but both sides already agree); it may run only after the daemon re-runs a
  fresh dry run with the plan's own reviewed control and that run still proves
  nothing would transfer. Any copy/delete/mkdir the fresh dry run reveals
  means the folder moved since the review, so the run is refused and the
  operator must plan a content run. Plan semantics, authority and the reviewed
  `--max-delete` percentage are untouched, and the plan summary now labels a
  zero-content review "baseline rebuild only". *Duplicate action lifecycle:* a
  claimed action now holds a **renewable 10-minute lease**
  (`POST /api/v1/actions/:id/lease`); the daemon renews every in-flight action
  every minute, so a Projects-scale plan/intervention can no longer outlive a
  fixed window, get flipped back to `pending` by the stale-taken sweep, and be
  re-claimed and re-executed concurrently. The daemon also refuses to run an
  action already in flight or already terminal, the action poller no longer
  re-enters itself, and `POST /actions/:id/complete` is idempotent (a
  duplicate ack cannot rewrite a terminal outcome or add a second
  `operation_log` row). See the LAMA-345 comments for the live evidence and
  the deployment gate.

- **LAMA-345 follow-up — fleet-health summary, evidence-based update verdict,
  and a scheduler defect found by integration.** Same branch, awaiting review.
  *Dashboard:* a server-derived **Fleet health** card buckets device and
  managed-folder state into "Needs attention now" (red — unsafe/resync-required/
  blocked folders, or a genuinely missing always-on server/NAS), "Check when
  next online" (yellow — work to finish, sleeping devices, updates ready to
  install), "Not heard from" (neutral — stale/never-reported, explicitly not
  "broken") and a one-line healthy count. A sleeping laptop/phone/tablet/
  desktop is never red on its own, a red or never-seen device speaks for its own
  folders (one root cause, one row), and the page shows a single urgency total
  (the hero and the card agree). The card links every item to its folder or
  device, keeps the class-policy reasoning behind a disclosure, and stacks to
  one column at 390px.
  *Update evidence:* `updateStatus` is now derived in one place
  (`@lamasync/core/fleet-health`, serialized centrally by the server and shared
  by `/health`, `/hosts`, `GET /hosts/:hostId`, the notification sweep and the
  UI). An "update available" claim now *requires evidence*: the device must have
  checked in at or after the release's `publishedAt` (inclusive boundary, from
  the cached release). A device offline since before the release reads "Update
  not checked — not evaluated since before X was released"; a device that has
  never reported in is "not checked" too; a device on a NEWER build is not
  nagged. `updateAvailable` is exactly `updateStatus.actionable`.
  *One read path:* `loadDerivedFolderHealth` is now the only managed-folder
  health read. The Dashboard summary previously read the daemon's stored
  `state` column while the folder card re-derived it, so the same folder could
  be urgent on the dashboard and healthy in its card (found in a browser pass
  and fixed, with a regression test).
  *Integration finding (fixed):* a schedule whose next fire is more than
  ~24.8 days away overflowed `setTimeout` (`TimeoutOverflowWarning … set to 1`)
  and fired in a tight loop — a yearly cron, `@yearly`, or a monthly cron just
  after it fires would have synced continuously. `planTimerDelay` now parks the
  timer and re-evaluates; both cron paths use it, with behavioural tests that
  fail against the pre-fix code.
  *Review corrections (browser-proven):* the Dashboard's urgent row is a real
  in-page **button** that scrolls and focuses the Fleet health section — as a
  Link to `/#fleet-health-heading` under HashRouter it became
  `/#/#fleet-health-heading`, changed the route and never scrolled. Scroll
  behaviour lives in `scroll-to-section.ts` and honours the existing
  reduced-motion gate. Folder links from the health card now actually do
  something: `folder-deep-link.ts` (pure, tested) opens the requested folder,
  marks the assignment and scrolls/focuses its health card, with fallbacks for a
  missing device (first assignment + explanation) and an unknown/removed folder
  (stale highlight cleared + explanation), without ever filtering the table. The
  apply guard is keyed on the navigation, so repeat clicks and back/forward
  work, and focus only ever lands on a connected node (a ref callback fires
  during the commit, so the effect can still hold the previous target).
  `hostClassFromRow`/`hostStatusFromRow` use explicit switches instead of inline
  casts.
  *Evidence:* `scripts/lama345-integration.ts` runs a fully isolated server
  (random port, mktemp data dir, generated key, `HOME` redirected) plus an
  isolated daemon and exercises heartbeat → folder-health report → `/health`
  summary → dry-run plan → reviewed-plan validation, plus the release-blocking
  follow-up (0-change refusal, renewable lease, idempotent ack): 59/59 checks,
  rclone never
  invoked (asserted from the daemon log). Browser pass at 1440px and 390px with
  no console or page errors.

- **LAMA-345 — managed-folder health diagnostics and guided bisync
  intervention.** Implemented in
  `feat-lama-345-folder-health-intervention`; awaits review and release. A clean
  rclone exit code is no longer treated as health.
  *Stage 1:* the shared `@lamasync/core/folder-health` contract
  (`healthy | new_host | resync_required | recoverable | unsafe | blocked |
  busy | unknown` plus bounded reason codes with exact remediation), a
  layered-cost daemon probe whose heartbeat path is stat/access + one statfs +
  a readdir of the bisync workdir (listing counts only after a run or on
  demand; a bounded deep measurement only after operations or an explicit
  diagnose), and server-side persistence of the latest report plus a bounded
  transition history. Reads re-derive the state with the pending conflict
  count, live-run activity, and a fleet cross-check of what each host sees on
  the same shared remote — which is what makes an incomplete shared baseline
  visible instead of `healthy`.
  *Stage 2:* `diagnose_folder` and `plan_folder` queued actions; a plan is an
  explicit dry run against the device's real workdir, stored server-side with
  a bounded change list, a 30-minute TTL and the config/filter/baseline
  identity it was built from.
  *Stage 3:* the concrete defect is fixed — the daemon decided "first run?" by
  looking for a `bisync.state` file rclone has never written, and rclone
  persists paired `*.path1.lst` + `*.path2.lst` listings. Baseline readiness
  is now a complete pair with no `.lst-err` and no in-flight `.lst-new`, so a
  completed normal bisync no longer receives `--resync` on its next run.
  `initialize` / `seed` / `resync` / `resume` / `cancel` interventions carry
  EXPLICIT human-readable authority (remote is Path 1, local is Path 2), are
  gated on a reviewed plan, archive prior state instead of deleting it, and
  verify that the intended baseline was established rather than trusting exit
  0. The effective filter fingerprint now covers BOTH the Git-ignore snapshot
  and `.lamasyncignore`, with a persisted pending marker so a failed resync
  never acknowledges a new fingerprint. `OperationStatus` gained `cancelled`.
  *Review corrections:* execution is now bound to the reviewed plan's
  semantics — intervention, authoritative side AND the reviewed `--max-delete`
  percentage must match, and the daemon executes the plan's own values, so a
  remote request can never ride a local plan. `rclone bisync --max-delete` is a
  PERCENTAGE, not a file count: the field is `bisyncMaxDeletePercent` /
  `maxDeletePercent`, validated 0-100, where blank means rclone's default
  (50%) and never "no cap". A planned dry run uses the assignment's own timeout
  instead of the 60-second ad-hoc preview budget, so a Projects-scale folder
  can be planned at all. `mountCacheMode` now actually reaches the mount:
  it is threaded through `startMount`/`buildRcloneArgs`, retained across
  restarts and re-applied by reconcile when it changes. `resume` requires the
  same explicit confirmation as every other mutation. The authority wording no
  longer claims unique files are deleted — it decides the winner only for a
  file modified on both sides, and deletions are read from the dry run alone.
  *Stage 4:* the Folders page gained a per-assignment Folder health card
  (state, freshness, stale measurement, sync-record readiness, ignore-set
  status, exact remediation), plain-language contextual actions (no
  context-free "plan" button — planning is attached to the operation it
  previews), a four-step guided wizard (choose the winning side → preview
  running → review totals plus a bounded sample → run it) that refuses a plan
  built for a different side or threshold, a "What do these terms mean?"
  glossary, and an Advanced section of typed allowlisted controls
  (`bisyncMaxDeletePercent` → `--max-delete`, `mountCacheMode` →
  `--vfs-cache-mode`).
  There is no free-form rclone arguments or configuration field anywhere.

- **LAMA-327/328 — live sync progress and fast persisted statistics.** Active
  rclone work now reports bounded, non-blocking phases and counters through an
  in-memory server registry, with WebSocket updates and reconnect hydration in
  Activity's responsive **Running now** panel. Folder and storage pages answer
  from persisted last-known sizes, expose stale/refreshing metadata, dedupe and
  bound background measurement work, embed secret-free folder assignments,
  and bound storage-history reads. Explicit single-folder refresh uses the same
  scheduler; mutation invalidations survive server restarts.

- **LAMA-337 — Reconnect with QR for an existing Android device.** A phone
  whose local credentials were lost (reset, reinstall, wiped vault) used to
  have exactly one way back in: pair again, which mints a **new** host id and
  quietly orphans everything bound to the old one — upload inboxes, upload
  history, device-scoped state. The enrollment secret is one-time and only its
  hash is stored, so the original QR can never be re-shown; the fix is a new
  one that names the device it belongs to.
  *Server:* `POST /api/v1/mobile/registrations/:hostId/reconnect-enrollment`
  (admin, `no-store`) creates a fresh 10-minute single-use enrollment for an
  existing **live** registration — 404 unknown, 409 revoked, and creating it
  changes nothing, so an abandoned or expired reconnect QR leaves the working
  device exactly as it was. The QR payload is the unchanged
  `lamasync.android.enroll` v1 shape; the exchange branches on the enrollment
  row: a pairing QR still creates a host, a reconnect QR claims the QR and, in
  one transaction, rotates `native_token_hash`, refreshes display name/app
  version/last-seen plus the host heartbeat, revokes the previous web grant and
  every web session, issues a fresh grant and returns the **same host id**.
  Live WebSockets of that registration are closed after commit — the sweep is
  keyed on the rotation itself, never on how many session rows the transaction
  happened to see, so a socket that outlived its session row (or a device that
  never bootstrapped one) cannot keep streaming under the replaced credential —
  and the old native bearer, old grant and every old cookie session are dead the
  moment the reconnect lands. The fresh grant restores the device's **current
  live** authority, resolved from the single live `web_grants` row: a
  registration whose authority cannot be resolved (no live grant, or more than
  one) is refused with a 500 rather than minted an admin grant, and
  `idx_web_grants_live_registration` now makes "exactly one live grant per
  registration" the database's invariant too. Credential history is now
  auditable: `mobile_enrollments`
  keeps one row per QR shown (`kind` = `new` | `reconnect`, no more
  `UNIQUE(host_id)`) and `web_grants` keeps the superseded grant with its
  revoke reason (no more `UNIQUE(registration_id)`); a guarded one-time rebuild
  in `initDb` migrates existing databases without dropping rows. Supersession
  is scoped rather than global: showing a new pairing QR voids the earlier
  pending pairing QR, and a reconnect QR voids only that same device's earlier
  pending reconnect QR.
  *Desktop:* active device rows in the Android-devices panel gain a
  "Reconnect QR" action (revoked rows do not), reusing the pairing modal — same
  QR rendering, countdown, polling and accessibility — with copy that says the
  device keeps its identity, that scanning rotates credentials and signs out
  the old session, and that closing the window or letting the QR expire changes
  nothing. The projection is refreshed as soon as the phone claims the QR. The
  card's terminal states separate the QR from the device: an expired or
  superseded QR now reads "this QR is no longer valid, the device is unchanged"
  in both flows (the pairing flow's expired case lost the wrong "Access
  revoked" label too), and only the registration's own revocation is reported
  as lost access.
  *Android:* the same v1 QR is parsed by the same parser, and the existing
  different-enrollment replacement path already handles a same-origin reconnect
  (it clears local auth, exchanges, and stores the host id the server returns —
  the same one); a unit test now pins that path.

- **LAMA-336 — live-tree app captures, destination updates and the audit
  batch around them.** A `dev-vm` Hermes protection was enabled, scheduled and
  pointed at the server archive, and had produced no snapshots: five scheduled
  attempts reached the daemon and died before upload because GNU tar exits 1
  on a live tree. The whole set of findings is now fixed, one commit each.
  *tar capture:* `~` and absolute exclude patterns are normalized into tar's
  `-C /` member namespace (so `~/.hermes/backups` can finally match
  `home/<user>/.hermes/backups`), `LC_ALL=C` keeps diagnostics stable, and
  exit 1 is recoverable only when every diagnostic is one of the recognized
  live-tree warnings — permission errors, unknown text, empty stderr and
  exit 2+ stay fatal. `runAppTarCapture` is the seam the regression tests
  drive real GNU tar through, including an actual Unix socket and a file
  appended to for the whole read.
  *Atomicity:* server-local EXDEV fallback and local/NFS publication copy to a
  sibling temp file, fsync and rename instead of writing the final object key
  in place; the daemon's config cache, update cooldown, gitignore filter hash
  and report queue share one `writeFileAtomic` with mode preservation.
  *Untrusted input:* the skill bundle lists and validates every archive member
  (relative, inside `lamasync-skill-<version>/`, plain file or directory)
  before `tar -xzf` runs.
  *Destinations and schedules:* `PUT /apps/protections/:id` treats an explicit
  `null` as a clear (so `backendId: null` also drops the bucket and switching
  s3 → local works), and one shared schedule grammar
  (`validateScheduleExpression`, backed by the daemon's own parser) rejects any
  expression the daemon could not arm — for protections and folder
  assignments alike. The enrollment form now opens on an explicit "Manual
  only" choice and the protection table says "Not scheduled" instead of an
  em-dash next to a green Enabled badge.
  *Conflicts:* manual keep-both resolution is a checked `renameSync` again (it
  used to ignore `mv`'s exit status and then overwrite the local copy anyway)
  and its `.conflict-YYYYMMDD` name no longer collides with an earlier copy
  from the same day.

- **LAMA-335 — the backup viewer became an in-app browser with previews.** The
  Data Browser already had authorized listing/navigation for local, S3 and
  restic refs (server-side path validation, its own SigV4 signer and a proxied
  64 MiB `POST /browse/download`), and image/text preview. What this pass added:
  audio and video preview through the browser's own renderers with a
  MIME-typed Blob (a typeless one is why `<audio>`/`<video>` refuse to play),
  one decision point (`previewPlanFor`) that returns a *reason* for every file
  with no viewer plus a Download action, a 48 MB preview cap across image,
  audio and video so a phone never decodes a 64 MiB payload for a renderer
  that cannot stream it, and a truthful floor at the transport's own 64 MiB
  (`downloadable: false` above it, stated in the row instead of a Download
  button that would 400), and stacked
  phone-width rows for the listing, the browse-jobs panel, the snapshot picker
  and the restore jobs. The trust boundary is now covered on both sides:
  `device-boundary.test.ts` proves a device credential gets 403 on every browse
  action, that the routes are 401 without one, and that an admin's S3 listing
  carries neither the destination's secret nor its access key nor a signed URL;
  `browse-trust-boundary.test.ts` fails if an S3 client, a signed-URL helper or
  a credential field is ever added to the SPA. The component decision —
  candidates, licences, weights, rejected alternatives — is recorded in
  [`browse-viewer-decisions.md`](browse-viewer-decisions.md).

- **LAMA-334 — the physical-phone feedback pass.** Seven defects reported from
  real use, fixed at the layer that owned each one:
  *Gallery folders:* the uploads screen can queue a whole gallery top-level
  folder (Camera roll, Downloads, Pictures, …) as a one-shot snapshot of the
  media the app is granted to read — permissions are the existing media
  grants (PARTIAL "selected photos" honoured and labelled), contents are
  MediaStore-derived rather than a filesystem walk, and staging keeps only
  three un-transferred files on disk at a time so a 3,000-photo roll does not
  need 12 GB free. *Pull-to-refresh:* the spinner was raised by
  `SwipeRefreshLayout` and never lowered — `ManageWebState` is now the single
  source of truth with four terminal paths (load finished, main-frame failure,
  a 20s watchdog, surface released); a `doUpdateVisitedHistory` back-stack
  callback is a separate signal and can no longer settle the spinner before
  `onPageFinished` (review finding 2); and the gesture is bounded to the top
  strip of the view so the phone's More sheet keeps its own scroll. *Queue
  rows:* the status badge is a horizontal badge and the filename is the
  element that truncates, so `Queued` can no longer wrap one character per
  line. *Dashboard:* the raw `OPEN` websocket pill is replaced by an icon plus
  the same state sentence the connectivity banner uses, and the pause control
  is icon-led and stateful (pause/resume, in-flight transition, unavailable
  reason) with changing an existing window as its own control. *Native header:*
  the app bar leads with the LamaSync mark and "LamaSync", and the server line
  is a host name rather than the raw origin — the full origin, device id and
  check-in state stay on the Connection screen. *Responsive tables:* the three
  device-page tables and the Admin access-key table now collapse with the
  `.data-list` skeleton and keep their column names via `data-label`, with a
  source-scanning test guarding every wide `table.data` in the app. See
  `docs/android-mobile-ux-plan.md` decisions 17–21.

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

1. **LAMA-346 — the transport, remote orchestration and live acceptance.**
   Stages 1a, 1b, 2a, 2b and 2c are implemented and locally validated;
   **Stages 2d, 2e and 2f are now implemented and passing on this host**. The job carries
   `sourceHostId`, so each side of a seed has its own IDENTITY: a device key is
   authorized for the source half or the target half (`seedJobRoleFor` +
   `seedJobPhaseRole`), the archive facts are written exactly once by the
   source in a compare-and-set that doubles as the single lease HANDOVER, and
   every device-facing write is role-scoped and compare-and-set (a stale
   writer or a lost race is a 409, never an overwrite). A device can no longer
   forge a lease owner, the target cannot author the facts it must verify, and
   only the target may report a seed completed. The shipped `lamasyncd` runs a
   `seed_job` queued action through `packages/daemon/src/seed-runner.ts`
   (dynamic-imported behind the doubly-gated seam) using the existing
   archive/transport/staging primitives and the real S3 store, and its
   `baseline_validation` phase runs a real `rclone bisync --resync` whose
   zero-change verdict is REQUIRED before `completed` (no peer ⇒ the phase
   fails, never a false pass). `scripts/lama346-seed-e2e.ts` starts TWO REAL
   daemon processes, each with a device key minted through the pairing
   exchange, and passes **80 checks / 0 fail / 3 GATED** — including four
   device-key denials (the target cannot rewrite the source's facts, a third
   device cannot read the job, a late report cannot reopen it, and the digest
   cannot be rewritten).
   **Stage 2e closed a review finding that would have reproduced the original
   incident:** the runner renewed the seed job lease only between stages, so a
   healthy transfer longer than the 10-minute lease lost the job and its
   handover write was refused. `packages/daemon/src/seed-lease-supervisor.ts`
   now renews from a TIMER that runs alongside every long stage (tar, upload,
   download, extraction, verification, `rclone`), with a grace window bounded
   strictly inside the lease, an `AbortSignal` threaded into every long
   operation, and an authority check immediately before publishing and before
   completing. A cancellation or a lost lease now stops the run mid-stage: it
   publishes nothing, leaves no staging sibling or work directory, and is
   reported as a STOP rather than as a job failure. The reaper no longer fails
   the handover window (a `running` job with no lease is given a grace), and
   the target no longer renews a lease it does not hold while it waits for the
   source. The E2E proves it against two real daemons with a 30 s lease: a 35 s
   source stage was LIVE at all 116 observations and RENEWED 12 times, and an
   operator cancellation inside the target's 10 s hold published nothing.
   **Stage 2f replaced the test seam with the operator's SEED PILOT and gave both
   external inputs a production resolution.** Execution is no longer opened by an
   environment variable: `packages/core/src/seed-pilot.ts` authorizes exactly ONE
   folder and ONE ORDERED source/target pair, and requires the temporary seed
   space — an EXISTING S3 backend row plus the operator's bucket (`lamasync-tmp`)
   — to have been PROBED first. A swapped pair authorizes nothing, an unprobed or
   failed space authorizes nothing, and the SERVER's doubly-gated seam is deleted
   (a test environment alone opens nothing). `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED`
   stays `false`: it now means "claimed as production-validated fleet-wide",
   which nothing here claims. The space is decrypted on the server only and
   delivered as `HostConfig.seedRelay` inside a party's OWN authenticated config,
   bound to the job id and side; an idle device, a stranger and any host after
   the job is terminal get nothing, and the runner refuses a space issued for
   another job. The probe is BUCKET-SCOPED on purpose — an existing key may be
   scoped to one bucket, and the generic backends test lists every bucket in the
   account, which such a key cannot do — it writes and deletes one object under
   the seed namespace, is retry-pinned and killed after 20 s, and its verdict is
   persisted (a reconfiguration resets it). The target's resync PEER now resolves
   from the assignment (`<remoteName>:<canonical destination>` plus the server's
   rclone config in a private temp file); the env override is seam-gated. A
   target that is not MEASURED as empty is refused at PLAN time as well as at
   publish, and a terminal job's relay objects are deleted promptly with the
   bucket's lifecycle as the independent backstop. The disposable E2E now creates
   a real backend row, configures and probes the pilot through the real admin
   routes, starts both daemons with NO relay environment at all, and asserts the
   503 cases, the non-empty-target preflight, the issued-space and resolved-peer
   evidence and prompt cleanup: **80 pass / 0 fail / 3 GATED**.
   Remaining work, in order:
   (a) the GATED host proofs — a real two-MACHINE hop with a network partition and
   one retry/resume, real ENOSPC on a bounded disposable volume, and the live
   dev-vm-shape run on a **copy** of a large tree (no timeout kill while
   progressing, one correct resume after a deliberate stall, a zero-change
   baseline afterwards). This is what the pilot exists for: ONE real pair, dev-vm
   as the target of `master`'s Projects, with `lamasync-tmp` as the seed space —
   and before that run the operator must decide where dev-vm's existing PARTIAL
   Projects content belongs and start from an EMPTY target directory (LamaSync
   never moves, merges or deletes it) and run "Check this device now" on dev-vm
   so the target-emptiness preflight has a measurement; (b) persist the cleanup
   block server-side for a daemon-run job (the objects ARE deleted, promptly now;
   the bookkeeping field stays `not_started`). The retention/cleanup policy is
   decided (delete on the terminal phase, 24 h for abandoned objects,
   idempotent, namespace-confined), and the bucket's own lifecycle is the
   independent backstop. Only after (a) and an independent review of the Stage
   2c-2f evidence may `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` flip — and a released
   build still keeps `POST /seed-jobs` at 503 for every folder the pilot does not
   authorize. See
   [`handoff-346-initial-folder-seeding.md`](handoff-346-initial-folder-seeding.md)
   §2.14, §2.15 and §2.16.

2. **LAMA-337 — release, and the one device-path question it leaves open.**
   The reconnect flow is merged with the
   repo gates green; the release and the production deploy are the operator's,
   not the worktree's. One deliberate non-change needs an owner call: the
   Android app has **no QR entry point while it is already paired** (the
   scanner is reachable from Welcome, i.e. a fresh install or after a local
   wipe), so a phone that still holds credentials reaches reconnect through its
   own stored grant. Adding a paired-state "Scan reconnect QR" entry is a
   Kotlin UI change, deliberately left out of this server/web pass — see
   *Known limitations*.

3. **LAMA-336 — release and live confirmation.** The code for every finding is
   merged; the release, the `dev-vm` update and the
   check that the next Hermes capture produces a verified snapshot in the
   server archive are the operator's, not the worktree's. Nothing in the
   change set is deployed yet, so the original five failing attempts are still
   the live behaviour until it ships.

4. **LAMA-296 stage 2 — real-device soak.** Automatic camera protection is
   emulator-verified (see
   [`report-296-stage-2-auto-protection.md`](report-296-stage-2-auto-protection.md));
   the remaining evidence is a one-day real-phone run (Doze/battery,
   overnight scheduling, existing-history import at scale, OEM camera
   paths, a real partial-access selection, and a server restart mid-
   transfer).

5. **LAMA-315 — path classification and recommendation UX.** The design
   handoff is [`handoff-315-path-classification.md`](
   handoff-315-path-classification.md) (taxonomy, data model, staged
   delivery). Stage 1 — annotation provenance, the deterministic classifier,
   the read-only classify route, and per-path editor suggestions — and stage
   2 — read-only review surfaces that group a snapshot's captured paths by the
   class its own frozen `capturedSpec` recorded, and show a protection's
   frozen enrollment spec separately from the editable template — are
   implemented. Stages 3–5 (suggestion-driven authoring, the restore/change
   plan, optional denormalization) remain. Known contract gap: `excludes` is a
   raw `string[]` with no class or rationale, so review surfaces list exclude
   patterns verbatim and associate no classification with them.
6. **Application setup/restore executor.** Build the target-side wizard:
   preflight, dry-run/change plan, populated-target decisions, revalidation
   before writes, rollback artifact, and execution journal. Direct app restore
   remains intentionally unavailable until this exists.
7. **LAMA-311 — daemon home-path sandbox.** The unit contract, the queued-action
  config refresh, and the unit reconciliation shipped; only production-client
  rollout remains. `lamasyncd --update` and the remote `update_daemon` action now
  migrate an already-installed unit (removing the obsolete
  `ProtectHome=`/`ReadWritePaths=` lines only) even when the binary is already
  current — which is how `dev-vm`, running a post-fix v0.3.11 binary under an
  Aug-6 unit, actually gets fixed. A daemon whose old unit sandbox is
  *effective* cannot rewrite its own unit, so the remote action reports that
  case as `failed` with the manual `lamasyncd --update` instruction; running it
  from a shell is the reliable remedy. Live acceptance (binary update was
  already rolled out on `dev-vm`, but the unit was not) still needs an explicit
  restart/update authority, because a unit migration requires
  `systemctl --user restart lamasyncd.service`. See `docs/agent-start.md` for the
  rollout command set.
8. **Dispatcher race (filed separately from LAMA-311).** The refresh-once fix
  covers "the named folder is missing from a cache that the server has already
  superseded". The broader race — a claimed action is executed against a config
  revision that changes mid-flight, a host-wide trigger resolves against an
  empty stale cache, and `STALE_TAKEN_MS` (10 min) can flip a long-running
trigger back to `pending` and re-claim it while it is still running — is its own
issue with its own fix (revision-pinned selection or a bounded re-check).
9. **LAMA-321 follow-up — trash retention.** Optional per-folder
   `trashRetentionDays` with `.trashinfo` DeletionDate-based cleanup; deferred
   from the first pass to keep deletion risk narrow. See the LAMA-321 issue
   handoff for the retention correctness rules.
10. **LAMA-329 phase 8 — the evidence sweep, and the items it exists to
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
11. **LAMA-332 — Android WebView fleet administration is forbidden after a
   fresh re-pair.** On the physical device, the embedded management UI returns
   `Forbidden` for fleet data while the native shell reports `Connected`. The
   operator signed out, removed the registration from LamaSync, and paired
   again with a fresh QR; the failure persists. Root cause found: the embedded
   SPA allowed an origin-scoped legacy bearer in WebView DOM storage to take
   precedence over the freshly bootstrapped cookie. The server correctly
   treats an explicit bearer as authoritative and rejects a device-scoped key
   from fleet routes with 403 rather than falling back to the cookie. The
   client fix removes only stored bearers when the companion opens its
   embedded document, then lets the existing cookie-only `/auth/me` probe
   establish session mode; it neither changes server precedence nor exposes a
   credential. A real-device inspection then found the remaining server-side
   defect: the valid admin cookie reaches `/auth/me` and `/hosts`, but the
   dashboard's unscoped `/conflicts` and `/restic/snapshots` list requests
   were incorrectly denied by `deviceMayAccessHost` because they omit
   `hostId`. Admin web sessions must have fleet-wide access just like admin
   bearers; the gate now allows them while keeping non-admin sessions and
   device/native credentials confined. Full tests, TypeScript, production web
   build, and strict drift pass. Deploy this server fix, then confirm the
   physical dashboard no longer reports Forbidden; separately improve the
   native cookie-presence indicator so it does not claim verified fleet
   authority.
12. **size_history retention.** LAMA-328 bounds and downsamples history reads,
    but successful measurements still append indefinitely. Add pruning to the
    existing daily maintenance pass once an operator-approved retention
    horizon is chosen.

## Known limitations

- **LAMA-337 reconnect is a desktop-initiated flow, and the phone cannot scan
  one while it is still paired.** The Android app reaches the scanner from
  Welcome — a fresh install, a cleared vault, or after its own local
  disconnect — which is exactly the case that needs a reconnect QR (the
  device that still holds credentials re-issues its web session from the
  stored grant instead). A paired phone therefore has no "scan a reconnect
  QR" entry, and adding one is a Kotlin UI change left to the Android pass.
  Two smaller edges follow from the same design: a reconnect QR lives 10
  minutes and is single-use (a consumed-but-unseen exchange — the response
  lost in flight — needs a newly generated QR, which is now cheap and
  non-destructive), and only one live web grant exists per registration
  (the previous one is revoked with the reason `credentials rotated by
  reconnect`, and every session built on it stops working immediately).
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

LAMA-335 backup viewer (this worktree): `bun x tsc --noEmit`, `bun run
build:web-ui` (still one self-contained `index.html`), `bun test` **1574 pass /
0 fail** (+17 over the LAMA-334 pass: the preview plan and MIME mapping, the
SPA trust-boundary scan, and the browse authorization / no-secret-leak route
tests). Strict skill drift OK — no route, command or flag changed, so the
agent-skill reference is untouched. Verified against the built bundle and a
seeded demo fleet with real media at 360x800: the listing renders as stacked
rows (`scrollWidth == clientWidth == 360`, no visible cell both narrower than
70px and more than three times its own width tall), the desktop table is
unchanged at 1280px, and all four renderers were exercised — text, image,
audio (the player reports the file's real 0:02 duration, which only happens
once the Blob is typed correctly) and video (a decoded frame with controls).
Screenshots in `docs/android-mobile-ux-artifacts/lama335-*.png`. **Not
exercised live:** the snapshot-picker and restore-job collapses, because the
demo fleet has no restore history — they are covered by the source-scanning
table guard and the same `.data-list` pattern as the verified tables.

LAMA-334 feedback pass (this worktree): `bun x tsc --noEmit`, `bun run
build:web-ui` (still one self-contained `index.html`), `bun test` **1557 pass /
0 fail** (+17), strict skill drift OK (160 API rows / 161 server routes / 11 CLI
commands — no route, command or flag changed). Android `assembleDebug` OK,
`lintDebug` **0 errors (62 warnings**, all pre-existing version-availability
noise) and `testDebugUnitTest` **242/242** (+12: the pull-gate arming rules at
nine view heights, the refresh terminal states, `serverIdentity`, and the
gallery folder semantics). Narrow-width evidence measured against the built
bundle and a seeded demo fleet at 360x800: all seven sampled routes report
`scrollWidth == clientWidth == 360`, the collapsed host-folder and access-key
tables render as stacked labelled rows (screenshots in
`docs/android-mobile-ux-artifacts/`), and no visible cell is both narrower than
70px and more than three times its own width tall. **Not run in this pass:** the
instrumented suite (the `lamadb-test` AVD's system image is not installed on
this host, and the only attached device is the operator's paired phone, which
the instrumented classes must not touch) and the physical-phone look at the new
native surfaces.

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

LAMA-337 baseline (this worktree): repo gates green — `bun x tsc --noEmit`,
`bun run build:web-ui` (still one self-contained `index.html`), `bun test`
**1749 pass / 0 fail** (the ~70 added for this change cover both the feature and
its review round), `bun run scripts/check-skill-drift.ts --strict` OK (162 API
rows / 163 server routes — the new reconnect route documented), and `bun run
build` (all five distributables). Android `assembleDebug` OK, `lintDebug`
**0 errors**, `testDebugUnitTest` **245/245** (one added: the same-origin
reconnect path in `CompanionRepositoryFlowTest`); no instrumented run was made
(no Kotlin main source changed, and the reconnect vertical needs a live HTTPS
server). New coverage: admin-only create with 404/409 for unknown/revoked
targets and 500 when the live web authority cannot be resolved (no live grant,
two live grants, revoked history alongside one live row); the guarded `initDb`
rebuild of legacy `mobile_enrollments` (UNIQUE(host_id)) and `web_grants`
(UNIQUE(registration_id)) preserving rows, plus the partial unique index that
now enforces one live grant per registration; abandoned + expired reconnect QRs
leaving the old bearer/grant/session valid; a successful exchange keeping the
host id while rotating both authorities, killing the old cookie session and
live WebSocket (real HTTP + WS harness), and refreshing device metadata without
touching destinations, uploads or `created_at`; the review's socket regression —
two shapes of "zero live sessions by the query but a socket the server accepts
as live" (the row deleted outright, and a row stamped revoked_at = 0) still
close the registration's open socket on a rotation (both verified to fail
against the previous session-count inference); replay
and concurrent exchanges yielding one winner; QR-supersession scoped to kind
and host; revoke killing a pending reconnect QR; and the UI action/modal copy,
including state-machine tests proving expired/superseded QRs read "device
unchanged" while only a revoked registration reads "access revoked" (both
modes).
