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
required — stage 2 reuses the stage-1 upload protocol unchanged (the Android
transfer worker/engine gained stage-2 behavior on top of it, see queue
integration). This is deliberate: the server contract
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
  - `unmeteredOnly`, `chargingOnly` — AUTOMATIC-only transfer policy. The
    Auto Protect screen writes these into `AutoProtectSettings` and never
    touches the stage-1 manual `UploadPolicyStore`, so automatic conditions
    cannot delay explicit user shares (separate drainers, see scheduling).
  - resolved Camera destination: `cameraDestinationId`,
    `cameraDestinationLabel`, `cameraDestinationRelPath` — cleared whenever a
    fresh authoritative list has no Camera inbox or upload authority was
    revoked; retained ONLY as a network-outage fallback
  - honesty summaries: `lastSuccessfulProtectionEpochMillis`,
    `lastWaitingReason` (+ `waitingReasonUpdatedAt`), `lastScanAt`,
    `lastScanStatus` (`OK` | `PARTIAL` | `INTERRUPTED` | `NOT_GRANTED`),
    `lastScanScope` (observed permission scope at scan time)
- `MediaCursorState` — discovery cursor, keyed `(collection, volume)`:
  - `scopeMode`, `watermarkDateAdded`/`watermarkId` (new-only boundary and
    retained existing-history high-water), `fullScanCompleted`
    (backfill-completed → later scans do an incremental-new pass). There is
    NO generation field: MediaStore's GENERATION column is not public before
    API 36, so the `(date_added, _id)` keyset is the boundary.
- `MediaRecord` registry — durable per-item state, keyed by stable identity
  `collection:<mediaId>@<volume>` (never a path):
  - `uri`, `displayName`, `sizeBytes`, `mimeType`, `relativePath`,
    `dateAddedSeconds`, `dateModifiedSeconds`, `dateTakenMillis`, `sha256`
  - `status`: `DISCOVERED` → `STAGED` → `PROTECTED`; plus `LOCALLY_DELETED`,
    `UNREADABLE`, `FAILED`
  - `queueItemId`, `previousProtectedPaths` (bounded provenance of earlier
    protected revisions), `protectedAt`, `receiptPath`, `error`
- Coverage (`MediaCoverage.protectedThrough`) is *derived*, never stored:
  order records by `(dateTakenMillis ?: dateAdded*1000, mediaId)`; a record is
  satisfied iff `PROTECTED` or `LOCALLY_DELETED` — and `LOCALLY_DELETED` is
  only ever produced for a revision already verified `PROTECTED` (see
  discovery rules), so a satisfied claim is always backed by a verified
  receipt or a verified-protected past; the boundary is the newest
  item whose every predecessor is satisfied. Pending = unsatisfied
  non-deleted records (`DISCOVERED`/`STAGED`/`FAILED`/`UNREADABLE`).

## Permission model

- Manifest: `READ_EXTERNAL_STORAGE` (maxSdk 32), `READ_MEDIA_IMAGES`,
  `READ_MEDIA_VIDEO`, `READ_MEDIA_VISUAL_USER_SELECTED` (API 34+),
  `POST_NOTIFICATIONS` (API 33+), `RECEIVE_BOOT_COMPLETED`,
  `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC`.
- Permission authority is PER COLLECTION (`MediaPermissions
  .scopeForCollection`, checked live per scan/resume, never stored as
  authority):
  - `FULL` for IMAGES — `READ_MEDIA_IMAGES` granted (API ≤32:
    `READ_EXTERNAL_STORAGE` grants both collections)
  - `FULL` for VIDEOS — `READ_MEDIA_VIDEO` granted
  - `PARTIAL` — only `READ_MEDIA_VISUAL_USER_SELECTED` granted (API 34+);
    both collections see the selected subset
  - `NOT_GRANTED` — the collection's own permission is denied. A denied
    collection is NEVER scanned, NEVER declared deleted, and NEVER counted
    as covered (a hidden row proves nothing about its server state).
- Honesty rules:
  - Per-collection FULL is required for genuine "protect the whole camera
    roll" claims. `PARTIAL` still protects whatever the query returns, but
    the UI shows per-collection access and the waiting reason asks for full
    access; coverage claims are scoped to what was actually queried.
  - `NOT_GRANTED` on every ENABLED collection pauses discovery (cursor
    kept) with an actionable reason.
  - Runtime permissions are requested only for the ENABLED sources
    (`requestList(sdk, photosEnabled, videosEnabled)`).
  - A media URI that becomes unreadable (revoked/partial expiry/moved) is
    recorded per the reconciliation rules below — never silently skipped and
    never treated as protected.

## Discovery and reconciliation

- Sources of rows: `MediaStore.Images` + `MediaStore.Video` collections,
  per-volume on API 29+ (`getExternalVolumeNames`), `EXTERNAL_CONTENT_URI`
  on API 26–28 (documented: primary volume only).
- Selection: bounded projection; keyset pagination on
  `(date_added, _id) DESC` for both modes. New-only boundaries are the
  NEWEST row's `(date_added, _id)` captured BEFORE the first import query
  (race-safe: rows present at capture have keys ≤ the boundary; rows
  inserted afterwards are strictly newer) with per-volume cursors.
  EXISTING_HISTORY: a deterministic newest-first backfill walk; when the walk
  completes, the cursor RETAINS a high-water boundary and later scans run an
  incremental-new pass over strictly newer rows (while the known-rows
  reconciliation still handles edits/deletions) — new media captured after
  the history import is never missed.
- Page durability: every COMPLETED page is committed atomically (page
  records + cursor) via a page-commit callback, so a process death after a
  completed page resumes without skipping files; a failed page commits
  nothing and reports an interrupted scan.
- Query execution: `LIMIT` and the WHERE keyset pass through the
  query-args bundle (`QUERY_ARG_SQL_SORT_ORDER`/`QUERY_ARG_SQL_LIMIT`/
  `QUERY_ARG_SQL_SELECTION`); API 35 rejects `LIMIT` embedded in the
  sortOrder string.
- Classification (pure): camera = relative path `DCIM/Camera` (DATA fallback
  on ≤28); screenshots = relative path containing `Screenshots` (covers
  `Pictures/Screenshots` and OEM variants).
- Reconciliation of KNOWN identities (direct `_ID` lookups):
  - row present with a size OR date-modified delta → a NEW revision
    (`DISCOVERED`, prior receipt kept in `previousProtectedPaths`);
  - row absent under a FULL completed walk of an accessible collection:
    - `PROTECTED` → `LOCALLY_DELETED` (the ONLY deletion claim; the server
      copy is never touched);
    - `STAGED` → kept as-is: the private staged copy is the durable source
      and the upload finishes from it;
    - `DISCOVERED`/`FAILED`/`UNREADABLE` → `UNREADABLE` (the media
      disappeared BEFORE protection — reported as lost/action-required,
      never as satisfied coverage);
  - row absent under PARTIAL access: verified/staged revisions keep their
    status; not-yet-protected rows are honestly marked `UNREADABLE`;
  - row absent while the collection's permission is NOT_GRANTED: no
    conclusion is drawn at all (nothing scanned, deleted or claimed).
- Changed media: the discovery revision signal is size OR date-modified
  (practical provider metadata), and the staging step adds a content
  SHA-256 per revision — so an edited file with an identical byte length is
  caught when date-modified advanced, and content identity is still exact at
  staging time. Perfect mutation detection beyond observable provider
  metadata is NOT claimed: a same-size, same-date-modified, different-bytes
  edit is re-protected only if the content hash at staging differs from the
  previously recorded one (the queue id carries the sha, so a differing
  revision gets its own item).

## Queue integration

- One `UploadQueueItem` per discovered media row, produced by the stage-1
  stager (bounded bytes + SHA-256) and drained by the stage-1 transfer
  machinery — extended (not untouched) for stage 2:
  - `UploadWorker` reconciles the automatic media registry on durable
    completion (`MediaProtectionEngine.reconcileCompleted`): the STAGED
    record becomes `PROTECTED` with the receipt path and protection time,
    keyed by `mediaIdentity`; versioned collision names are covered because
    the receipt's `finalRelPath` carries the published name;
  - `protectPending` additionally reconciles STAGED records whose queue item
    is already DONE (restart safety) and never re-stages a STAGED record;
  - `UploadTransferEngine` gained a distinct `Collision` outcome.
- `UploadQueueItem` gains optional `mediaIdentity`, `sourceLabel` and
  `autoNameAttempt` fields (serialization-defaulted, backward compatible)
  linking receipts back to the registry for provenance.
- Idempotency: queue item id and upload idempotency key are deterministic
  `autoq-<source>-<id>-<volhash>-<sha12>` (and `autop-…` for the server key)
  — repeated scans, restarts, retries and duplicate triggers converge on the
  same item instead of duplicating it. Keys comply with the server's create
  contract (`^[A-Za-z0-9._-]+$`, ≤ 128 chars). An item in a terminal state
  is never re-added; a re-protected revision gets a new hash suffix and
  therefore a distinct item. A user CANCELLED auto item stays cancelled
  until removed; removing it re-arms protection on the next scan.
- Collision handling (repeated names): if the server rejects `create` with a
  collision (409), the worker retries under `base (n).ext` names with derived
  `base.v(n)` keys — derived from the item's IMMUTABLE base name/key plus the
  PERSISTED `autoNameAttempt`, so a restart resumes the same series instead
  of nesting `name (2) (2).jpg` / `base.v1.v1`; the attempt bound (20) is
  global per item (persisted), not per worker run. The server copy is never
  overwritten. Manual uploads keep stage-1 behavior (explicit blocked state
  with rename guidance).

## Scheduling and policy

- `AutoProtectWorkScheduler`:
  - prompt discovery: unique one-time work (`auto-protect-discovery`),
    unconstrained (discovery + local staging), enqueued on app start/resume,
    boot, policy change, and after transfers settle;
  - periodic reconciliation: unique `PeriodicWorkRequest`
    (`auto-protect-reconcile`, ~6 h), unconstrained — discovery and local
    staging need no network constraint and the periodic pass is the safety
    net (there is deliberately NO battery-not-low constraint);
  - boot recovery: `BOOT_COMPLETED` receiver re-enqueues both.
- Drain lanes (automatic vs manual, P1 policy separation):
  - automatic items drain via the dedicated unique work
    `lamasync:auto-upload-queue` constrained by the AUTOMATIC policy in
    `AutoProtectSettings` (`NetworkType.UNMETERED` when `unmeteredOnly`,
    `setRequiresCharging(chargingOnly)`, REPLACE on change);
  - manual/user-initiated items keep the stage-1 unique work
    `lamasync:upload-queue` constrained by the stage-1 `UploadPolicyStore` —
    manual semantics are unchanged; the worker filters items by the drainer
    that launched it (`UploadWorker.KEY_KIND`), so neither policy can delay
    the other kind.
- Long transfers: `UploadWorker` promotes to a foreground service worker
  (`dataSync` type declared in the ForegroundInfo, notification channel) —
  notification permission is NOT a precondition: on API 26+ the FGS starts
  and the system keeps the process alive for the transfer; with
  `POST_NOTIFICATIONS` denied the notification simply stays out of the
  drawer while the service remains visible in the Task Manager. Only a
  genuine OS refusal (e.g. background FGS start restriction) degrades the
  pass to a plain constrained worker — reported via progress data, with
  durable per-chunk offsets keeping progress; the app never claims an
  unrestricted background guarantee it does not have.
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
