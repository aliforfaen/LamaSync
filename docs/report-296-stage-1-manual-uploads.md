# LAMA-296 — stage 1: usable manual uploads — implementation report

Status: review package for the planning agent. Date 2026-09-07. Branch
`aliforfaen/android-client`. Implements only
[`spec-296-stage-1-manual-uploads.md`](spec-296-stage-1-manual-uploads.md)
(stage 1 of [`handoff-296-android.md`](handoff-296-android.md)) on top of the
accepted phase-1 baseline, including the accepted uncommitted cleanup fix
(which is preserved in the working tree). No deployment, publish/tag,
production credential rotation, or full-issue completion was performed.
Automatic camera discovery (stage 2) is the next assignment.

## What shipped

### Server (core + server)

- **Scoped destinations** (`mobile_upload_destinations`, schema + migration):
  one authorized landing path per registration, server-computed as
  `Mobile/<hostId>/<slug>`. Registrations default to **no upload access**
  until an administrator assigns an inbox from the desktop web UI; request
  bodies carry only destination ids + validated file names — never roots,
  backend credentials, or another host's inbox.
- **Resumable uploads** (`mobile_uploads`, schema + migration): host-bound
  persistent upload ids + client idempotency keys (unique per registration),
  durable queryable offsets, negotiated chunk size (default 4 MiB) and
  per-upload cap (default 2 GiB), SHA-256 verification, explicit state
  transitions (`created → uploading → ready → verifying → publishing →
  finalized`, plus `failed`/`cancelled`), serialized per-upload writes,
  atomic publication, persisted completion receipts, and retry-safe
  finalization across the crash between filesystem rename and DB completion.
- **Protocol routes** (native bearer; boundary-confined in `auth.ts`):
  `GET /mobile/destinations`, `POST /mobile/uploads` (+`Idempotency-Key`),
  `PUT /mobile/uploads/:id/chunks` (`X-Upload-Offset`, raw binary,
  bounded — reads the request stream chunkwise, never the whole body),
  `GET /mobile/uploads[:/:id]`, `POST /mobile/uploads/:id/finalize`,
  `POST /mobile/uploads/:id/cancel`. Admin routes:
  `GET|POST /mobile/registrations/:hostId/destinations`,
  `POST …/destinations/:id/revoke`. All with Swagger detail.
- **Security contract**: authorization re-checked on every request
  (principal → live registration → ownership), and re-checked *again* at
  publication; central revocation marks in-flight uploads failed + revokes
  destinations so a transfer can never publish after authority is lost;
  staging lives outside the browse tree keyed by server-issued ids;
  containment (realpath) enforced at the write boundary (symlink escapes
  refused); filename collisions are explicit, never silent overwrites;
  identical filenames are not treated as duplicate proof.
- **Bounds**: chunk cap, per-upload cap, staging-quota accounting,
  abandoned-upload reconcile (boot + daily sweep, unordered) removing
  staging after an inactivity TTL; cancellation never touches a published
  final file.
- **History**: completed/failed uploads append exactly one `operation_log`
  row per intent with the **actual mobile registration host id** and
  `operation = 'mobile_upload'`, `trigger = 'manual'`; retries never append
  a second row. Published files appear in the existing local Data Browser
  under `Mobile/<hostId>/<slug>/` with zero changes to the browse engine.

### Web UI

- Admin **Android devices** panel now manages per-device inboxes: list
  (active + revoked), assign a labeled inbox, revoke a destination — the
  authenticated desktop setup surface for existing paired devices.
- **Data Browser deep links**: `#/data?kind=local&path=…` opens the local
  tab at a folder. This also repairs a pre-existing navigation regression
  (the local tab was controlled by a constant `localBrowseRef`, so
  breadcrumbs/entry clicks never changed the listing — restored with a
  stateful `localPath`).
- New flow helpers + tests; operation-sentence mapping for `mobile_upload`.

### Android

- **Intake**: `ACTION_SEND` / `ACTION_SEND_MULTIPLE` manifest filters
  (singleTop) + `ACTION_OPEN_DOCUMENT` multi-select; content URIs only,
  never filesystem paths; persistable grants retained where available;
  transient share content staged into bounded private storage immediately
  with explicit failures (unreadable / over-cap / no-space); intake while
  unpaired is an explicit error.
- **Durable queue** (`UploadQueueStore`, SharedPreferences +
  kotlinx.serialization): items bind to the enrollment identity (origin +
  hostId) at intake; a disconnect or re-pair — even to the same origin with
  a new hostId — **blocks** old items instead of resubmitting them under a
  new identity.
- **Durable executor**: a single unique WorkManager worker
  (`UploadWorker`) drains the queue with `NetworkType.CONNECTED` (or
  `UNMETERED` from the policy toggle), exponential backoff, and
  process-death/reboot persistence. The ViewModel only observes + enqueues.
  The transfer engine (`UploadTransferEngine`) streams chunk-by-chunk
  (≤ 1 MiB per request, whatever the file size), recovers lost create/chunk/
  finalize responses by re-querying server state, and persists progress
  after every accepted chunk.
- **UI**: Uploads screen (queue states — queued/uploading/needs-attention/
  failed/cancelled/verified — progress bars, retry/cancel/remove, receipt
  with **Open in web UI** deep link into the embedded Data Browser, unmetered
  preference, destination picker for multi-inbox devices, document picker),
  reachable from the management header via an "Uploads" button.
- WorkManager 2.10.0 added to the version catalog (compileSdk-35-compatible
  stable per the official data-transfer guidance).

## Protocol and state machine decisions

See `docs/spec-296-stage-1-manual-uploads.md` for the full contract. Summary:

- **Durability point**: the checksum-verified file published under the
  server-local landing root (`<LAMASYNC_BACKUP_DIR>/Mobile` by default,
  `LAMASYNC_MOBILE_LANDING_DIR` override). No off-host backup or onward
  replication in this milestone.
- **Resume**: offset = `bytes_received`; a stale client fails explicitly
  (409) and recovers by `GET`ing state.
- **Idempotency**: `(registration, idempotency_key)` unique; a retried
  create returns the same upload; the reserved final name is reused, so one
  intent yields one final file even across lost responses and restarts.
- **Publication crash window**: `sha256` + `final_rel_path` are recorded
  *before* the rename; a `publishing` row whose final file matches the
  recorded digest completes in place; a mismatching occupant is an explicit
  collision and is never overwritten.

## Test evidence

### Repository gates (all green)

| Gate | Result |
|------|--------|
| `bun install` | 198 installs, no changes |
| `bun x tsc --noEmit` | pass |
| `bun run build:web-ui` | pass |
| `bun test` | **1580 pass, 9 skip, 0 fail** (1589 total; 130 files, 6149 expects). Corrected: the first edition misstated the pre-correction total as 1,583 passed + 9 skipped — the actual review baseline was 1,574 passed + 9 skipped = 1,583 total. |
| `bun run scripts/check-skill-drift.ts --strict` | OK (148 API rows, 149 server routes, 70 CLI commands) |
| `bun run build` | all binaries compiled, exit 0 |

New hermetic server suite `packages/server/src/routes/mobile-uploads.test.ts`
(42 tests): destinations default/no-access/admin validation (traversal, dots,
slugs, duplicates, cross-host denial, revoke idempotence), create
idempotency + collisions + caps + unsafe names, chunk offsets (wrong offset,
oversized, declared-size, concurrent writes serialized, disk-full
simulation, staging quota), finalize (verify+publish+receipt, retried
finalize once, checksum mismatch, crash-window completion in place +
different-content collision, symlink-parent escape refused, destination/
registration revoked mid-transfer, unknown/foreign uploads 404/403), cancel
(in-flight + finalized no-op + foreign), a **65 MiB+ file uploaded
chunk-by-chunk** with spot-checked content, abandoned reconcile + orphan
sweep, and operation-history provenance (real mobile host id, exactly one
row, failure rows too).

### Android gates

| Gate | Result |
|------|--------|
| `assembleDebug` | BUILD SUCCESSFUL |
| `lintDebug` | 0 errors (49 version-available warnings — baseline) |
| `testDebugUnitTest` | **86 tests, 0 failures** (77 prior + 9 new: R1 concurrent-across-instance mutations + snapshot-flow observation and durable-write failure propagation; R2 terminal-state CAS — cancel immunity, restart persistence, authoritative CANCELLED→DONE reconciliation, stale-DONE immunity, cooperative-cancel propagation, finalize-conflict-after-cancel) |
| `connectedDebugAndroidTest` (no harness) | **42 tests pass, 6 vertical tests skip cleanly, 0 failures** |
| `connectedDebugAndroidTest` + live HTTPS vertical | **42 tests pass, 0 failures** (rebuild of the disposable harness, one clean run) |

New instrumented coverage: `UploadIntakeInstrumentedTest` grew to 7 — real
FileProvider content URI staged with exact bytes + sha256, over-cap rejects
with no partial files, **NO_SPACE rejects with no partial files (R7)**, and
**an unreadable source leaves no placeholder (R7)**, real-SharedPreferences
queue survival, staged file as durable source. New suites:
`UploadQueueObservationInstrumentedTest` (2 — **live worker progress/
completion without Activity recreation (R1)**; **concurrent UI+worker
writers never lose a snapshot (R1)**), `UploadIntakePairingStateInstrumentedTest`
(4 — **cold unpaired share block, warm repeat-share stability,
credential-lost block without a null assertion, block clearing on success
(R5)**), `UploadCancellationInstrumentedTest` (2 — **cancel survives restart
and immunizes against stale worker writes; offline cancel reconciled to the
authoritative server result on the next worker pass (R2)**),
`UploadWorkSchedulerPolicyTest` (1 — **both policy transitions actually
replace WorkManager constraints (R6)**), and `VerticalUploadFlowTest` (2 —
the disposable-HTTPS vertical; see below).

### Disposable HTTPS vertical (correction pass: rebuilt, one clean run)

Harness: disposable server from source (fresh data dir per run) +
`LAMASYNC_ORIGIN=https://10.0.2.2:8444` + socat TLS terminator (self-signed
cert, SAN `IP:10.0.2.2`, CA installed into the AVD user store; debug builds
trust user CAs; release trusts only the platform) + API-35 `lamadb-test`
AVD. The host-local harness script was absent at correction time (by design:
`/tmp/lamasync-vertical/run-vertical.sh` is disposable) and was REBUILT —
full reproduction recipe in `docs/development.md`. Vertical run covers the
phase-1 enrollment suite (A–D) **and**:

- **Large verified upload with bounded memory**: a real 65 MiB + 4 KiB file
  transferred by the real Android stack (real HTTPS transport, real
  MobileUploadApi + engine) through the real server — every chunk payload
  ≤ 1 MiB (recording transport asserts it), ≥ 65 chunks, receipt size and
  sha256 equal the source, the final file visible in the Data Browser
  listing at `Mobile/<hostId>/Inbox/vertical-big.mp4` with the server-side
  size matching, and exactly one `mobile_upload` success row in operation
  history carrying the real mobile host id.
- **Checksum mismatch negative**: a deliberately wrong declared sha256 → the
  engine reports blocked, the server row lands in `failed` with no receipt,
  and no success history references the file.

## Stage-1 corrections (review R1–R8)

All eight review items are addressed in this pass; regression evidence is
listed in the gates above (hermetic server suite 48/48 incl. five new
tests; Android unit 86/86 incl. nine new; instrumented 42/42 with the
vertical). Full item-by-item fixes:

1. **R1 — process-wide queue safety + live observation.** `UploadQueueStore`
   now serializes every mutation on ONE process-wide lock and re-reads the
   persisted snapshot inside it, so the ViewModel and the worker (both use
   the canonical `UploadQueueStore.getInstance(context)` instance) can never
   race a whole-snapshot update; `PrefsQueueStorage` writes are synchronous
   (`commit()`, never `apply()`) so an intake/cancel is durable BEFORE
   WorkManager scheduling; the store exposes a `snapshots` `StateFlow` that
   the ViewModel collects, so worker progress/failure/completion render live
   on an already-open Uploads screen with no Activity recreation. New tests:
   store concurrent-across-instance mutations, flow emission, on-device
   live-observation + concurrent UI/worker writers.
2. **R2 — cancellation races eliminated.** Cancel is now a DURABLE requested
   state persisted first; the worker checks the current store state before
   every write and stops cooperatively (`CancellationException` from its
   progress callback), and the store refuses stale writes over a durably
   CANCELLED item (the single sanctioned escape is the server-authoritative
   CANCELLED → DONE reconciliation with a receipt). Remote cancel happens
   BEFORE local staging deletion; offline cancellations stay CANCELLED and
   are re-synced on the next worker pass (`syncServerCancellations`), which
   also applies the authoritative server result when the cancel lost the
   race to finalize. New tests: store cancel-immunity/restart/authoritative-
   reconciliation, engine cooperative-cancel + finalize-conflict-after-
   cancel, on-device restart + offline-reconcile cancellation, and a
   hermetic server test that a racing finalize after cancel is 409 and never
   publishes.
3. **R3 — staging quota no longer double-counts.** The guard charges only
   the incoming chunk delta against global staged usage (the counter already
   includes this upload's earlier chunks), so an upload that exactly fills a
   multi-chunk quota succeeds; one byte past fails with 507. New hermetic
   boundary test.
4. **R4 — atomic, idempotent finalization + history.** Finalization and its
   `operation_log` row COMMIT IN ONE TRANSACTION; the row is idempotency-
   keyed by the new `operation_log.dedupe_key` column (partial unique
   index, SERVER_SCHEMA + MIGRATIONS). A history-insert failure rolls the
   whole transaction back (row stays `publishing`; a retry completes in
   place); the finalized fast path and the boot/sweep reconcile repair any
   missing history row exactly once. New hermetic failure-injection +
   reconcile tests (both sides of the DB completion boundary).
5. **R5 — unpaired / credential-lost share intents are renderable.** The
   Uploads screen mounts even without a registration and renders an
   onboarding/error surface (UNPAIRED / CREDENTIAL_LOST) with Pair + Back
   actions; the forced `vault.nativeToken()!!` unwrap is gone (the token is
   read once and null-checked before any network call). New on-device cold
   + warm unpaired, credential-lost, and block-clearing tests.
6. **R6 — policy transitions replace constraints.** `rescheduleWithPolicy`
   now enqueues with `ExistingWorkPolicy.REPLACE`, cancelling the stale
   request and applying the NEW network constraint in both directions
   (CONNECTED ↔ UNMETERED); ordinary enqueues keep KEEP. New on-device test
   verifies the real WorkManager request carries the new constraint.
7. **R7 — NO_SPACE staging cleanup.** `ContentStager` deletes the partial
   target before EVERY post-creation failure return (NO_SPACE, and the
   unreadable-source placeholder). New on-device no-partial-file tests for
   NO_SPACE and unreadable sources.
8. **R8 — destination revoke enforces its hostId parent.**
   `revokeMobileUploadDestination(registrationId, id)` verifies the
   destination belongs to the nested hostId; a mismatched parent is a 404
   and never revokes another device's inbox. New mismatched-host route
   test.

Server-file surface changes: `operation_log.dedupe_key` (core schema +
MIGRATIONS), `revokeMobileUploadDestination` signature, the quota guard and
finalize/fail/history functions in `mobile-uploads.ts`. No wire/route
contracts changed.

## APK

`android/app/build/outputs/apk/debug/app-debug.apk`
sha256 `0891fe3302f749b7401660b592e4646be614ebf1c548f21724c346497f9d264a`
(34 MB debug APK, versionName 0.1.0 / versionCode 1,
`app.lamasync.companion`). Rebuild with the commands in
`docs/development.md`.

## Compatibility notes

- The streaming/resumable upload surface is **additive**: `/browse/upload`
  (base64, ≤ 64 MiB) and all desktop/TUI contracts are untouched; daemon
  behavior unchanged (the type-check + full `bun test` prove no regressions,
  including the phase-1 origin/CSRF/logout/cleanup suites).
- Migration safety: both new tables are added via `SERVER_SCHEMA` +
  idempotent `MIGRATIONS` entries (fresh DBs and upgraded DBs both work);
  `initDb` swallows duplicate-column/table errors as before.
- The ingested files land under the browse root (`Mobile/…`) — existing Data
  Browser listing/download semantics apply unchanged (downloads ≤ 64 MiB via
  the base64 endpoint; larger downloads remain a stage-3+ nicety — the
  receipt's "Open in web UI" opens the folder in the embedded Data Browser).
- Env vars (documented in `docs/development.md`): `LAMASYNC_MOBILE_LANDING_DIR`,
  `LAMASYNC_MOBILE_STAGING_DIR`, `LAMASYNC_MOBILE_CHUNK_BYTES`,
  `LAMASYNC_MOBILE_MAX_UPLOAD_BYTES`, `LAMASYNC_MOBILE_STAGING_QUOTA_BYTES`,
  `LAMASYNC_MOBILE_ABANDON_TTL_MS`, `LAMASYNC_MOBILE_SWEEP_MS`.

## Honest limitations / unverified items

- **Real phone / real tailnet not exercised** (emulator-only). Exact steps:
  enroll a phone via an HTTPS front door, share a >64 MiB file, kill/relaunch
  mid-transfer, reboot, reconnect tailnet — the engine behaves identically
  to the vertical (offsets are durable server-side; the worker re-runs), but
  real-device scheduling (battery, Doze, work constraints) is unverified.
- WorkManager `setProgress` (not `setForeground`): transfers run in the
  worker process with the OS's normal work-management latency. A
  user-visible **foreground notification** during long uploads was
  deliberately not added in this milestone (needs a notification channel +
  POST_NOTIFICATIONS handling); accurate "uploading" state is shown in-app,
  and deferred background execution is documented behavior, not a promise.
- The camera pixel path, desktop pointer-click automation, and SPA live-row
  DOM rendering remain unverified (same blockers as phase 1; the exact
  wire calls are covered by web-ui/server tests).
- Attachment/file metadata beyond name/size/mime (e.g. tags, THUMBNAIL) is
  not captured.
- Cancellation is user-initiated per item; there is no bulk/global cancel
  control yet (optional follow-up).

## Deferred (stage 2+)

Automatic camera media discovery, initial-history selection, network/
charging policy beyond the unmetered toggle (charging constraint), real
foreground-service semantics, upload receipts in the desktop web UI's
operation list beyond the sentence mapping, and onward cloud replication
(moving files off the landing root). None are claimed.
