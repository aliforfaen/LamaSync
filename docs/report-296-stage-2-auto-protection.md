# LAMA-296 stage 2 — automatic camera protection (implementation report)

Status: implemented and verified on the API-35 emulator (disposable HTTPS
vertical + shell-prepared permission negatives). Real-phone validation is
NOT claimed (exact unverified scenarios listed at the end). No server, wire,
CLI, or operator-contract change was required or made — stage 2 is
Android-local on the stage-1 baseline.

## Scope delivered

Automatic, one-way protection of locally accessible media:

| Source | Where | Default |
| --- | --- | --- |
| Camera photos | `DCIM/Camera` (images) | off until enabled |
| Camera videos | `DCIM/Camera` (videos, incl. >64 MiB recordings) | off until enabled |
| Screenshots (optional) | any `…/Screenshots/…` path | off until enabled |

Initial scope: **new media only** (race-safe boundary) or **existing
history** (deterministic, resumable import of everything). Destination: the
server-approved **Camera** inbox (the operator assigns it from Admin →
Android devices; the app never invents destinations and never touches a
root/backend/other-host path).

Explicitly NOT built (deferred, per the issue): selected-folder capture,
offline favourites, downstream processing, two-way sync, auto-delete,
native gallery, arbitrary private app-data backup, and the seven optional
conveniences — their extension points are preserved (stable source
selectors + destination ids + the scheduler command surface), no
placeholder UI shipped.

## Changed files

Android main source (`android/app/src/main/java/app/lamasync/companion/`):
- `media/MediaProtectionModels.kt` — durable models (settings, cursors,
  record registry, scope enums), all kotlinx-serialized
- `media/MediaProtectionStore.kt` — device-local durable store (sync
  commits, process-wide lock, live snapshot flow; same pattern as the
  stage-1 queue store; `android:allowBackup=false` already excludes it)
- `media/MediaPermissions.kt` — live FULL/PARTIAL/NOT_GRANTED scope
  derivation (official Android 14+ selected-photos model), one-dialog
  request lists per API tier
- `media/MediaClassifier.kt` — DCIM/Camera + Screenshots path
  classification (RELATIVE_PATH, DATA fallback ≤28), pure
- `media/MediaCoverage.kt` — contiguous completion-chain derivation of
  “protected through”, pending count/bytes, unreadable count
- `media/MediaStoreCursorLibrary.kt` — per-volume MediaStore queries with
  keyset pagination via the query-args bundle (API 35 rejects `LIMIT` in
  the sortOrder string — found by the on-device suite)
- `media/MediaDiscoveryEngine.kt` — race-safe new-only boundaries,
  deterministic existing-history walk, edit re-protection, deletion =
  LOCAL-ONLY (and never claimed under partial access); crash-safe page
  cursors
- `media/MediaProtectionEngine.kt` — discover → durable commit → bounded
  staging → idempotent enqueue; destination resolution (fresh + cached
  fallback); waiting-reason derivation; deterministic `autoq-…`/`autop-…`
  keys matching the server create contract (`^[A-Za-z0-9._-]+$`, ≤128)
- `work/AutoProtectWorker.kt` — honest gating (unpaired/credential-lost/
  permission), discovery, destination resolution, staging, waiting reasons,
  constrained drainer scheduling
- `work/AutoProtectWorkScheduler.kt` — unique prompt discovery (local-only
  constraints) + ~6 h unique periodic reconciliation + BOOT_COMPLETED
  recovery
- `work/TransferForeground.kt` — dataSync foreground promotion with
  graceful degradation (notification permission is NOT a precondition:
  a denied `POST_NOTIFICATIONS` still runs the FGS and surfaces it in the
  Task Manager — see the correction round)
- `ui/AutoProtectScreen.kt` + `ui/AutoProtectViewModel.kt` — setup/status
- Modified: `data/UploadModels.kt` (queue item: `mediaIdentity`,
  `sourceLabel`, `autoNameAttempt`; policy: `chargingOnly`; `UploadNaming`),
  `data/UploadQueueStore.kt` (`NamedQueueStorage`), `data/UploadPolicyStore.kt`,
  `data/UploadTransferEngine.kt` (distinct `Collision` outcome for
  automatic versioned-name retries), `work/UploadWorker.kt` (collision
  retries + foreground), `work/UploadWorkScheduler.kt` (charging
  constraint), `ui/{MainActivity,SessionViewModel,ManagementScreens}.kt`
  (AUTO_PROTECT navigation), `AndroidManifest.xml` (media permissions,
  receiver, SystemForegroundService dataSync)

Tests:
- JVM (`app/src/test/.../media/`): classifier (5), coverage (9),
  permissions (6), discovery engine over a fake library (12: boundaries,
  determinism, resume, revisions, deletions, partial honesty), protection
  engine (13: idempotence, receipt linkage, staging failures, destination
  states, waiting reasons, key determinism), store (7 incl. backward
  compat), plus `UploadNamingTest` (3) and updated `UploadTransferEngineTest`
  (Collision outcome): 148/148 total.
- Android (`app/src/androidTest/...`): `MediaStoreDiscoveryInstrumentedTest`
  (real MediaStore: photo, screenshot, >64 MiB video; idempotent scans;
  local deletion; live scope) incl. the two shell-prepared negative tests;
  `AutoProtectWorkSchedulerTest` (unique prompt + periodic, REPLACE/cancel);
  extended `UploadWorkSchedulerPolicyTest` (charging REPLACE);
  `VerticalAutoProtectTest` (full HTTPS vertical); `AutoProtectScreenshotCaptureTest`
  (report evidence capture).

Docs: `docs/spec-296-stage-2-auto-protection.md` (design decision record),
`docs/report-296-stage-2-auto-protection.md` (this file), updates to
`ARCHITECTURE.md`, `docs/development.md`, `docs/features.md`, `docs/status.md`,
and `docs/296-stage-2-artifacts/`.

## Data and permission design (summary)

- Identity = `collection:<mediaId>@<volume>` — stable across reboot,
  storage-path changes and process death; never a path.
- Cursors per (collection, volume); new-only boundary = the newest
  `(date_added, _id)` captured BEFORE the first import query (rows present
  at capture are excluded; rows inserted later are strictly newer and
  imported) — race-safe without relying on the pre-API-36 hidden GENERATION
  column. MediaStore's GENERATION column is not a public constant before
  API 36, so edits of known rows are caught by the per-scan known-ids
  reconciliation (size/date_modified) instead. EXISTING_HISTORY backfill
  completes into a retained high-water boundary; later scans do an
  incremental-new pass, so media captured after the import is discovered.
- Every COMPLETED discovery page is committed atomically (records + cursor),
  so process death after a completed page resumes without skipping files.
- Permission authority is PER COLLECTION and CHECKED LIVE (per scan, per
  resume) — never stored. `READ_MEDIA_IMAGES` grants FULL over IMAGES only,
  `READ_MEDIA_VIDEO` over VIDEOS only; a denied collection is never scanned,
  never declared deleted and never counted covered. PARTIAL (selected
  photos) protects only the accessible subset, shows an honest per-
  collection banner + "grant full access" action, and never claims
  deletions for rows outside the selection (not-yet-protected rows become
  UNREADABLE); NOT_GRANTED on every enabled collection pauses discovery
  with an actionable waiting reason. Runtime permission requests are
  limited to the enabled sources.
- "Protected through" is derived from the contiguous completion chain
  (PROTECTED or LOCALLY_DELETED advance it; DISCOVERED/STAGED/FAILED/
  UNREADABLE stop it) — never the latest upload timestamp.
- Deletion semantics are honest, not broad: LOCALLY_DELETED is produced
  ONLY for a revision already verified PROTECTED (coverage preserved, the
  server copy is never touched — verified in the vertical). A source that
  disappears BEFORE protection is a loss: DISCOVERED/FAILED rows become
  UNREADABLE (action required), and a STAGED row keeps its private staged
  copy and finishes the upload from there — never marked satisfied.
- Pending is a non-double-counting union of the media records (records can
  wait on a destination/space/readability problem without ever entering the
  queue) and the queue's live progress, deduplicated by media identity;
  unreadable media are reported separately as "needs attention".
- Repeated names (camera counter resets, edited files) are re-protected
  under versioned names `name (n).ext` with derived idempotency keys after
  a server 409; the series derives from the item's immutable base name/key
  plus the persisted `autoNameAttempt`, so each attempt converges on one
  upload row across restarts (never nested `name (2) (2).jpg` /
  `base.v1.v1`), and the 20-attempt bound is global per item.
- Once an auto item is durably DONE, the worker reconciles the registry
  (`MediaProtectionEngine.reconcileCompleted`): the record becomes
  PROTECTED with receiptPath/protectedAt — coverage and "last successful
  protection" advance from real upload completions.

## Validation evidence

Repo gates (all green):
- `bun install` — no changes (250 packages).
- `bun x tsc --noEmit` — clean.
- `bun run build:web-ui` — built, inlined.
- `bun test` — **1580 pass / 9 skip / 0 fail** (1589 tests across 130 files).
- `bun run scripts/check-skill-drift.ts --strict` — OK (148 API rows, 149
  server routes, 70 CLI commands).
- `bun run build` — daemon/server/tui dist binaries built.

Android gates (green):
- `assembleDebug` — APK `android/app/build/outputs/apk/debug/app-debug.apk`,
  sha256 `f40ce8f4f177a7d0f9aa14ed53d2513780e2efc61699d5a685b8f0666610af5d`.
- `lintDebug` — 0 errors.
- `testDebugUnitTest` — **148/148**.
- `connectedDebugAndroidTest` on the API-35 `lamadb-test` AVD **with** the
  disposable HTTPS vertical — **53/53 pass** (includes the evidence-capture
  test; the two permission negatives are in-class skips without their arg
  and were additionally run in the shell-prepared pass → +2 passing there).
  One intermittent phase-1 flake was observed once (`deviceD_offlineDisconnect`
  raced an online check-in write against the offline disconnect's store
  clear — phase-1 code untouched by stage 2) and passed on the definitive
  clean re-run.

Vertical evidence (`VerticalAutoProtectTest`, real stack): a real MediaStore
camera photo (480 KB) and a real >64 MiB video (65 MiB + 333 B with
≤1 MiB chunk payloads) were discovered through real MediaStore queries,
staged with bounded SHA-256 hashing, enqueued idempotently, transferred via
the real resumable engine through the real HTTPS server; both arrived
checksum-verified in the Data Browser under `Mobile/<hostId>/Camera`, two
`operation_log` rows (`operation=mobile_upload`, `status=success`, real
hostId) were recorded; a duplicate scan produced no new items; deleting the
local photo recorded LOCALLY_DELETED and the server copy remained listed.
The stage-1 vertical (enrollment A–D, >64 MiB manual upload +
checksum-mismatch negative) and all other instrumented suites also pass.

Permission negatives (shell-prepared, since in-process revocation
force-stops the app — honest limitation):
- all media permissions revoked → NOT_GRANTED detected; discovery claims
  nothing;
- only `READ_MEDIA_VISUAL_USER_SELECTED` granted → PARTIAL detected.

Screenshot (no secrets, default first-run surface; see
`docs/296-stage-2-artifacts/screenshot-auto-protect.png`): the automatic
protection setup/status screen (source toggles, initial scope, transfer
conditions, destination readiness, status card). The paired/existing-data
states are covered by the instrumented suite but not photographed (they
require a live enrollment on a seeded device).

## Correction round (review fixes, this worktree)

A review round found release-blocking correctness defects. All are fixed
with focused regressions; docs above are corrected to match actual behavior.

- **P0 — STAGED never became PROTECTED.** Queue completion now reconciles
  the registry: `MediaProtectionEngine.reconcileCompleted` (called by the
  worker on durable completion, and by the cancel-loses-race path) marks the
  record PROTECTED with receiptPath/protectedAt via `mediaIdentity` + the
  final receipt (versioned collision names included via
  `receipt.finalRelPath`); `protectPending` additionally reconciles STAGED
  records whose queue item is already DONE and never re-stages a STAGED
  record (the private copy uploads regardless of source fate).
- **P0 — false LOCALLY_DELETED claims.** Only a verified-PROTECTED revision
  may become LOCALLY_DELETED. A source that disappears before protection is
  a loss: DISCOVERED/FAILED → UNREADABLE (action required); STAGED → kept
  (private copy uploads). Under PARTIAL access, verified/staged revisions
  keep their status. The instrumented deletion test now asserts the loss
  semantics for a never-protected row.
- **P0 — permission authority is per collection.** `scopeForCollection`
  grants FULL over IMAGES only via `READ_MEDIA_IMAGES` and over VIDEOS only
  via `READ_MEDIA_VIDEO`; the discovery walk skips a NOT_GRANTED collection
  entirely (never scans/deletes/claims it); runtime requests are limited to
  the enabled sources; the UI shows per-collection access.
- **P0 — EXISTING_HISTORY stopped discovering future media.** After the
  backfill completes, the cursor retains a high-water boundary and later
  scans run an incremental-new pass; reconciliation still handles known
  rows. A NEW_ONLY→EXISTING_HISTORY transition walks from the top (dedup
  makes it exactly-once), covering an insertion during the transition.
- **P0 — same-size edits were silently missed.** `MediaRecord` now persists
  `dateModifiedSeconds`; discovery re-protects on a size OR date-modified
  delta, and staging adds the content SHA. Perfect mutation detection
  beyond observable provider metadata is explicitly NOT claimed.
- **P1 — collision retry restart determinism.** The retry series derives
  from the item's immutable base name/key plus the persisted
  `autoNameAttempt`; the 20-attempt bound is global per item; the final
  outcome applies to the LATEST durable item (never the stale pre-retry
  snapshot).
- **P1 — foreground premise.** `POST_NOTIFICATIONS` denial no longer
  prevents the dataSync FGS (the system surfaces it in the Task Manager
  regardless); `foregroundAllowed(sdkInt)` is the pure, JVM-tested decision;
  the ForegroundInfo declares the dataSync service type; an OS refusal is
  reported via progress data instead of being swallowed.
- **P1 — pending undercount.** Pending is the non-double-counting union of
  media records and queue progress by media identity (records blocked by a
  missing destination/space/readability now show up); unreadable counts stay
  a separate "needs attention" figure.
- **P1 — cursor durability.** Every completed discovery page commits its
  records + cursor atomically; a failed page commits nothing. An
  interrupted-after-page regression proves resume without skipping files.
- **P1 — stale destination cache.** A fresh authoritative list without a
  Camera inbox, and revocation, clear the cached destination fields;
  only network unreachability retains the cached fallback.
- **P1/P2 — automatic vs manual transfer policy.** The Auto Protect screen
  no longer writes the global `UploadPolicyStore`: automatic conditions live
  in `AutoProtectSettings` and drain via the dedicated
  `lamasync:auto-upload-queue` work (worker filters by item kind), while
  manual uploads keep the stage-1 policy/work unchanged. The screen states
  this explicitly.
- **P2 — docs/comments.** Spec/report corrected (no `watermarkGeneration`, no
  battery-not-low claim, engine/worker marked as extended, deletion and
  permission semantics described accurately); the stray "Apply the final
  result" doc comment in `UploadWorker` was removed.

Correction-round validation (actual results, this worktree):
- JVM `testDebugUnitTest` — **188/188** (was 148; +40 focused regressions:
  discovery/deletion/permission matrices, same-size edits, EXISTING_HISTORY
  incremental + transition insertion, per-page commit + interrupted resume,
  STAGED→PROTECTED + restart + coverage advancement, destination cache,
  collision restart determinism + terminal cap, foreground decision,
  pending derivation).
- `assembleDebug` — OK (APK rebuilt). `lintDebug` — **0 errors, 55
  warnings**.
- Instrumented suite on the API-35 `lamadb-test` AVD **with the disposable
  HTTPS vertical**: **55 tests, 0 failures, 2 in-class skips** (the two
  permission negatives, which require shell-prepared states) — including
  the phase-1 enrollment verticals A–D, the stage-1 manual verticals (65 MiB
  chunked upload + checksum-mismatch negative), and the stage-2 auto-protect
  vertical, which now drives the real completion reconcile path end-to-end.
- The two permission negatives were validated individually in their own
  shell-prepared states (`am instrument` per method, since a single grant
  state cannot satisfy both): all media revoked → `NOT_GRANTED` detected;
  only `READ_MEDIA_VISUAL_USER_SELECTED` granted → `PARTIAL` detected.
  (Note: the negatives share one `mediaScopeNegative` flag, so a single
  pass cannot satisfy both — they are validated per state.)
- Repo gates — `bun x tsc --noEmit` clean; `bun run build:web-ui` OK;
  `bun test` **1580 pass / 9 skip / 0 fail** (unchanged: Android-only
  changes); strict skill drift OK; `bun run build` OK.

## Unverified on real hardware (exact scenarios, NOT claimed)

1. Real-phone Doze/battery behavior and overnight background runs (WorkManager
   scheduling cadence, foreground-service promotion under real battery
   conditions, notification-channel presentation with a real user).
2. Real-phone camera app interleavings (photos taken DURING a scan; burst
   modes; multi-SD-volume phones with cross-volume `_id` ties).
3. Phone with an EXISTING large camera history imported in existing-history
   mode (scale: tens of thousands of items, staging space, time).
4. OEM camera libraries that write outside `DCIM/Camera` (e.g. some Chinese
   OEM paths) — classification is conservative and documented; such media
   are not claimed by any source (manual Uploads still covers them).
5. A real phone granting “Selected photos” partial access mid-session
   (Android 14+ flow; the revoke/partial states were shell-simulated on the
   emulator).
6. Server restart DURING an active auto transfer (stage-1 manual vertical +
   JVM tests cover the resume machinery with durable offsets; the auto
   vertical did not kill the server mid-transfer).
7. Tailnet-turnoff during long video transfer on a slow real link.
8. Widget/notification interaction when the app is force-stopped by the
   user (WorkManager drops periodic work when force-stopped; re-launch
   re-arms it — untested on-device).

Recommended follow-up: one-device soak (install the debug APK, enable
sources, photograph/record for a day, confirm “Protected through” and
pending counts on the status screen, kill the app, reboot once, verify
resumption). Steps: install `app-debug.apk`, enroll with a QR from the
desktop web UI (HTTPS origin), open Auto → enable Camera photos/videos,
choose “New media only”, set policy as desired, wait for the first scan,
verify the Camera inbox in the Data Browser.

## Operational / migration notes

- No server or desktop-UI changes; existing fleets and stage-1 installs are
  unaffected. The APK updates in place (same applicationId); the new fields
  default for old persisted snapshots (backward compatible, verified by a
  JVM test).
- The operator assigns a **Camera** destination per device (Admin → Android
  devices → Inboxes) for automatic protection to start; otherwise the app
  shows the actionable waiting reason.
- Background execution limits are OS-governed: automatic protection makes
  eventual progress when Android permits (constraints + periodic work), and
  the UI never claims otherwise.
