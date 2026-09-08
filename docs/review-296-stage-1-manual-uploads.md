# LAMA-296 stage 1 — manual uploads review

Reviewed 2026-09-07 against the uncommitted stage-1 working tree at
`25404e0`. Scope: `docs/handoff-296-stage-1-manual-uploads.md`, LAMA-296,
the implementation spec/report, server/core/web changes, and the Android
intake/queue/worker implementation.

**Verdict: changes requested.** The protocol and authorization foundation are
substantial, but the following lifecycle issues prevent stage-1 acceptance.

## R1 — P1: queue mutations are neither process-wide atomic nor observable

Sources: `android/.../data/UploadQueueStore.kt:15-97`,
`ui/UploadsViewModel.kt:75-82`, `work/UploadWorker.kt:39-153`.

`UploadQueueStore` synchronizes only one store instance, while the ViewModel
and WorkManager worker construct separate instances and both perform
read-modify-write replacement of the entire JSON snapshot. A worker progress
write can race a UI add/cancel/remove write and silently restore an older
snapshot, losing an item or a user action. `SharedPreferences.apply()` also
does not provide the claimed durable-before-scheduling boundary.

The ViewModel reads the queue only during initialization and its own actions.
It does not observe SharedPreferences or WorkManager progress, so worker
progress, failure, and completion remain invisible on an already-open Uploads
screen until some unrelated UI action or activity recreation reloads state.

Use one process-wide serialized transactional store (or a small Room table)
with atomic per-item updates and synchronous durability where work is handed
to WorkManager. Expose it as a Flow observed by the UI. Add concurrency tests
for worker progress versus add/cancel and an on-device test showing progress
and completion appear without recreating the Activity.

## R2 — P1: Cancel can be overwritten and the upload can still finalize

Sources: `android/.../ui/UploadsViewModel.kt:257-277`,
`work/UploadWorker.kt:94-147`.

Cancel starts the server request in an unjoined ViewModel coroutine, marks the
local snapshot cancelled, and immediately deletes the staged file. It neither
cancels/cooperatively stops the running unique work nor coordinates with the
worker. The worker retains the pre-cancel item and later writes `UPLOADING`,
`FAILED`, or `DONE` from that stale object. Depending on request ordering,
finalization can win after the UI already reported cancellation; deletion can
also turn the worker into a missing-source failure which overwrites CANCELLED.

Make cancellation a durable requested state consumed by the worker, serialize
it with progress updates, cancel remotely before deleting staging, and then
persist the authoritative server result. Cover cancellation during a chunk,
during finalize, offline cancellation, and activity/process restart.

## R3 — P1: staging quota double-counts the current upload

Source: `packages/server/src/mobile-uploads.ts:687-695`.

`currentStagedUsage()` already contains this upload's earlier chunks, but the
guard adds the upload's cumulative `next` offset again. With a 3-chunk quota,
the first two chunks fit and the third is rejected because the expression
counts the first two chunks twice. The existing quota test uses a one-chunk
quota and therefore does not distinguish correct accounting from this bug.

Compare the incoming chunk length against remaining global quota (or subtract
the current upload's accounted bytes), and add a boundary regression where an
upload exactly fills a multi-chunk quota.

## R4 — P1: successful publication can permanently miss operation history

Sources: `packages/server/src/mobile-uploads.ts:793-812` and `:971-987`.

Completion updates the upload to `finalized` first, then appends history in a
separate statement. The history helper catches and discards every DB failure.
A crash or insertion error after the finalized update returns or later retries
the successful receipt while the required operation row is absent forever;
the finalized fast path never repairs it. This contradicts the report's
exactly-one history and crash-recovery claims.

Persist finalization and an idempotently keyed history/outbox record in one DB
transaction after publication, and reconcile it on retry/startup. Add injected
failure/crash tests on both sides of the DB completion boundary.

## R5 — P2: sharing while unpaired opens an empty screen

Sources: `android/.../ui/MainActivity.kt:182-193` and `:143-157`.

The intake ViewModel correctly records “Pair this device…” when no registration
exists, but `handleShareIntent()` unconditionally changes the main state to
UPLOADS. The renderer only mounts `UploadsScreen` when `registration != null`,
so the promised explicit failure is not rendered; the user sees an empty app
surface. With registration metadata but missing key material, intake also
reaches `vault.nativeToken()!!` in `UploadsViewModel.kt:130`.

Keep unpaired/credential-lost intake on a renderable onboarding/error surface,
remove the forced unwrap, and add cold/warm share-intent regressions for both
states.

## R6 — P2: changing the network policy keeps the old WorkManager constraint

Source: `android/.../work/UploadWorkScheduler.kt:27-59`.

`rescheduleWithPolicy()` delegates to unique work with `ExistingWorkPolicy.KEEP`.
When work already exists, WorkManager keeps its original request and constraint;
switching the toggle therefore does not rebuild anything. Transfers may remain
stuck on an obsolete unmetered requirement or continue under the old connected
policy after the user asks for unmetered only.

Use an update/replace strategy appropriate to the installed WorkManager version
and verify both policy transitions with queued work.

## R7 — P2: local no-space failure leaves an untracked partial staging file

Source: `android/.../data/ContentStager.kt:50-77`.

The TOO_LARGE and exception paths delete `target`; the NO_SPACE early return
does not. A partially copied private file is left without a queue item and
repeated attempts can consume the remaining storage. Delete it before every
post-creation failure return and add the missing no-space cleanup regression.

## R8 — P2: destination revoke ignores the registration in its URL

Source: `packages/server/src/routes/mobile-uploads.ts:261-275`.

`POST /mobile/registrations/:hostId/destinations/:id/revoke` revokes solely by
destination id and never verifies that the destination belongs to `hostId`.
An administrator acting on a stale/mismatched row can revoke device B through
device A's nested resource URL. Validate the parent-child relationship and add
a mismatched-host route test.

## Validation in this review

- `bun x tsc --noEmit`: passed.
- Focused server/web tests: 61 passed, 0 failed.
- `bun run scripts/check-skill-drift.ts --strict`: passed (148 API rows,
  149 server routes, 70 CLI commands).
- Full `bun test`: 1,574 passed, 9 skipped, 0 failed (1,583 total). The
  implementation report currently misstates the total as 1,583 passed plus
  9 skipped and should be corrected.
- `testDebugUnitTest --rerun-tasks`: passed from freshly executed tasks
  (77 tests, verified from the generated JUnit results).
- Instrumented/live HTTPS tests were assessed from the implementation report,
  not independently rerun during this review.

No implementation files were changed by this review.
