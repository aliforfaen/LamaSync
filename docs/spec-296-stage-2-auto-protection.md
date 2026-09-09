# LAMA-296 stage 2 — automatic camera protection (design decision record)

Status: implemented. Companion to `handoff-296-android.md` stage 2 and
`report-296-stage-2-auto-protection.md`. This file records the data model,
permission model, discovery/reconciliation semantics, policy, and the exact
honesty rules so a reviewer can check them against the issue acceptance
criteria without re-deriving them.

## Scope

Automatic, one-way protection of locally accessible media (camera photos,
camera videos, optional screenshots) into the server-approved **Camera**
destination. Everything is Android-local: no new wire or server contract is
required — stage 1 already ships the destination-scoped resumable upload
protocol; stage 2 reuses it unchanged. This is deliberate: the server contract
is stable, and all new durable state lives on the device.

Explicitly out of scope (issue): selected-folder capture, offline favourites,
downstream processing, two-way sync, auto-delete, native gallery, arbitrary
private app-data backup, and the seven optional conveniences (deferred).

## Data model (device-local, `MediaProtectionStore`)

Persisted via SharedPreferences (sync `commit()`, excluded from backup) with a
process-wide mutation lock, mirroring the stage-1 `UploadQueueStore` pattern.

- `AutoProtectSettings` — durable configuration:
  - `cameraPhotosEnabled`, `cameraVideosEnabled`, `screenshotsEnabled`
  - `scopeMode`: `EXISTING_HISTORY` | `NEW_ONLY` (default NEW_ONLY)
  - `unmeteredOnly`, `chargingOnly` (transfer policy; shared with manual)
  - per-source resolved destination: `destinationId`, `destinationRelPath`
  - honesty summaries: `lastSuccessfulProtectionEpochMillis`,
    `lastWaitingReason` (+ `waitingReasonUpdatedAt`), `lastScanAt`,
    `lastScanStatus` (`OK` | `PARTIAL` | `INTERRUPTED` | `NOT_GRANTED`),
    `lastScanScope` (observed permission scope at scan time)
- `MediaCursorState` — discovery cursor, keyed `(collection, volume)`:
  - `scopeMode`, `watermarkGeneration` (API 30+ new-only),
    `watermarkDateAdded`/`watermarkId` (fallback + existing-history keyset),
    `fullScanCompleted` (existing-history determinism)
- `MediaRecord` registry — durable per-item state, keyed by stable identity
  `collection:<mediaId>@<volume>` (never a path):
  - `uri`, `displayName`, `sizeBytes`, `mimeType`, `relativePath`,
    `dateAddedSeconds`, `dateTakenMillis`, `sha256`
  - `status`: `DISCOVERED` → `STAGED` → `PROTECTED`; plus `LOCALLY_DELETED`,
    `UNREADABLE`, `FAILED`
  - `queueItemId`, `revisionSha256` (content version), `protectedAt`,
    `receiptPath`, `error`
- Coverage (`MediaCoverage.protectedThrough`) is *derived*, never stored:
  order records by `(dateTakenMillis ?: dateAdded*1000, mediaId)`; a record is
  satisfied iff `PROTECTED` or `LOCALLY_DELETED`; the boundary is the newest
  item whose every predecessor is satisfied. Pending = unsatisfied
  non-deleted records (`DISCOVERED`/`STAGED`/`FAILED`/`UNREADABLE`).

## Permission model

- Manifest: `READ_EXTERNAL_STORAGE` (maxSdk 32), `READ_MEDIA_IMAGES`,
  `READ_MEDIA_VIDEO`, `READ_MEDIA_VISUAL_USER_SELECTED` (API 34+),
  `POST_NOTIFICATIONS` (API 33+), `RECEIVE_BOOT_COMPLETED`,
  `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC`.
- `MediaPermission.scopeOf()` (checked live per scan/resume, never stored as
  authority):
  - `FULL` — images or videos granted (API ≤32: `READ_EXTERNAL_STORAGE`)
  - `PARTIAL` — only `READ_MEDIA_VISUAL_USER_SELECTED` granted (API 34+)
  - `NOT_GRANTED`
- Honesty rules:
  - Full scope is required for genuine "protect the whole camera roll"
    claims. `PARTIAL` still protects whatever the query returns, but the UI
    shows "only selected media are being protected" and the waiting reason
    asks for full access; coverage claims are scoped to what was actually
    queried.
  - `NOT_GRANTED` pauses discovery (cursor kept) with an actionable reason.
  - A media URI that becomes unreadable (revoked/partial expiry/moved) is
    recorded `UNREADABLE`/locally-deleted per the reconciliation rules, never
    silently skipped and never treated as protected.

## Discovery and reconciliation

- Sources of rows: `MediaStore.Images` + `MediaStore.Video` collections,
  per-volume on API 29+ (`getExternalVolumeNames`), `EXTERNAL_CONTENT_URI`
  on API 26–28 (documented: primary volume only).
- Selection: bounded projection; keyset pagination on
  `(date_added, _id) DESC` for both modes (existing-history import is
  therefore fully deterministic and resumable). New-only boundaries are the
  NEWEST row's `(date_added, _id)` captured BEFORE the first import query
  (race-safe: rows present at capture have keys ≤ the boundary; rows
  inserted afterwards are strictly newer) with per-volume cursors.
  MediaStore's GENERATION column is not a public SDK constant before API 36
  (only `getGeneration()` is), so the keyset boundary is used instead and
  edits of already-known rows are caught by the known-ids reconciliation.
- Query execution: `LIMIT` and the WHERE keyset pass through the
  query-args bundle (`QUERY_ARG_SQL_SORT_ORDER`/`QUERY_ARG_SQL_LIMIT`/
  `QUERY_ARG_SQL_SELECTION`); API 35 rejects `LIMIT` embedded in the
  sortOrder string.
- Classification (pure): camera = relative path `DCIM/Camera` (DATA fallback
  on ≤28); screenshots = relative path containing `Screenshots` (covers
  `Pictures/Screenshots` and OEM variants).
- Reconciliation: every scan re-reads the collection from the cursor;
  previously seen identities that no longer appear in any page are recorded
  `LOCALLY_DELETED` (local disappearance only — the server copy is never
  touched). Missed observer events, edits, permission changes and process
  death cannot skip files because the watermark/registry is durable and the
  periodic worker re-scans.
- Changed media: size/`sha256` delta on the same identity re-stages the
  content and protects the revision under a deterministic versioned queue id
  (`auto-<identity>#<sha12>`); the original protected copy is never
  overwritten. Repeated display names are handled by the engine's collision
  retry (see queue integration).

## Queue integration

- One `UploadQueueItem` per discovered media row, produced by the stage-1
  stager (bounded bytes + SHA-256) and drained by the existing
  `UploadWorker`/`UploadTransferEngine` untouched.
- `UploadQueueItem` gains optional `mediaIdentity` and `sourceLabel` fields
  (serialization-defaulted, backward compatible) linking receipts back to the
  registry for provenance.
- Idempotency: queue item id and upload idempotency key are deterministic
  `autoq-<source>-<id>-<volhash>-<sha12>` (and `autop-…` for the server key)
  — repeated scans, restarts, retries and duplicate triggers converge on the
  same item instead of duplicating it. Keys comply with the server's create
  contract (`^[A-Za-z0-9._-]+$`, ≤ 128 chars). An item in a terminal state
  is never re-added; a re-protected revision gets a new hash suffix and
  therefore a distinct item. A user CANCELLED auto item stays cancelled
  until removed; removing it re-arms protection on the next scan.
- Collision handling (repeated names): if the server rejects `create` with a
  collision (409), the engine retries under `base (n).ext` names (bounded, 20
  attempts) so repeated names/edited files never silently fail; the server
  copy is never overwritten. Manual uploads keep stage-1 behavior (explicit
  blocked state with rename guidance).

## Scheduling and policy

- `AutoProtectWorkScheduler`:
  - prompt discovery: unique one-time work (`auto-protect-discovery`),
    unconstrained (discovery + local staging), enqueued on app start/resume,
    boot, policy change, and after transfers settle;
  - periodic reconciliation: unique `PeriodicWorkRequest`
    (`auto-protect-reconcile`, ~6 h, battery-not-low), unconstrained for
    discovery but the worker schedules the constrained drainer;
  - drain: existing `UPLOAD_QUEUE_WORK_NAME` one-time worker with policy
    constraints — `NetworkType.UNMETERED` when `unmeteredOnly`,
    `setRequiresCharging(chargingOnly)` — REPLACE semantics on policy change
    (stage-1 R6 pattern extended to charging);
  - boot recovery: `BOOT_COMPLETED` receiver re-enqueues both.
- Long transfers: `UploadWorker` promotes to a foreground service worker
  (`dataSync` type, notification channel) only when the platform allows —
  `POST_NOTIFICATIONS` granted on API 33+ — and degrades gracefully
  (`ForegroundServiceStartNotAllowedException` caught; durable offsets keep
  progress) when not; no claim of unrestricted background execution anywhere.
- Outage semantics: network/tailnet failure is a recoverable `WAITING`/
  transient failure with backoff; the periodic worker re-evaluates. The app
  never promises exact schedule times.

## Revocation/lifecycle

- Central device revocation → native 401 → upload items `BLOCKED` (stage-1
  binding check re-uses it) and the auto worker records `REVOKED` waiting
  reason; discovery stops (gated on registration + vault presence) but local
  queue/registry state is kept for the re-pair decision.
- App restart/reboot: all state durable; `BOOT_COMPLETED` + app-start
  scheduling + periodic work restore the pipeline. Process death mid-scan:
  cursor + registry persisted after each page; the next run resumes.

## Extension points preserved (not built)

Stable destination ids + destination picker (optional favourite pins, upload-
now override, receipts) already exist from stage 1; source selectors,
per-source exclusion, and a pause/resume command surface are modeled by
`AutoProtectSettings` source toggles + the scheduler, so the seven optional
conveniences (favourite destinations, upload-now override, richer receipts,
initial-backup estimate, quick-settings tile, per-source exclusions, timed
pause) can be added without redesign. No placeholder UI is shipped.