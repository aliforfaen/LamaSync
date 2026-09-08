# LAMA-296 stage 1 — usable manual uploads (protocol and state transitions)

Status: implementation specification, 2026-09-07. Implements stage 1 of
[`handoff-296-android.md`](handoff-296-android.md) per
[`handoff-296-stage-1-manual-uploads.md`](handoff-296-stage-1-manual-uploads.md).
Stage 0 (QR authentication foundation, `spec-296-phase-1-android-foundation.md`)
is the accepted baseline; this document adds the scoped-destination model and
the resumable transfer contract on top of it. Automatic camera discovery is a
later milestone and is not designed here.

## Scope and durability point

- One server-local landing root, configured by the administrator. Completed,
  checksum-verified uploads land under that root and are immediately visible
  in the existing local Data Browser surface. **"Received, verified, and
  published under the landing root" is this milestone's durability point.**
  No off-host backup or onward cloud replication is implemented here.
- A **mobile upload destination** is the grant a phone needs to send files:
  a server-issued destination id tied to exactly one mobile registration,
  with a server-computed relative path `Mobile/<hostId>/<slug>`. Existing
  registrations have **no upload access** until an administrator assigns a
  destination through the authenticated desktop web UI. Request bodies carry
  only destination ids and file names — never arbitrary paths, backend
  credentials, or another host's inbox.

### Wiring to existing machinery

- The landing root defaults to `<LAMASYNC_BACKUP_DIR>/Mobile` (env
  `LAMASYNC_MOBILE_LANDING_DIR` overrides), so the local Data Browser
  (`/browse/local`, the browse-jobs filesystem surface) lists, downloads and
  manages the published files with zero changes to the browse engine.
- Completed/failed uploads are appended to the existing `operation_log` with
  the **actual mobile registration host id** and the source file name
  (`operation = 'mobile_upload'`, `trigger = 'manual'`, `host_id` = the
  mobile registration). Retries never append a second row.
- Upload transfers use a dedicated resumable protocol — never the base64
  `/browse/upload` endpoint and never whole-file buffering.

## New persisted records (SERVER_SCHEMA + MIGRATIONS)

```sql
-- One authorized landing path per mobile registration. No row => no upload
-- access, even for a live registration. Path is server-computed and
-- validated at write time; the client can never select it.
CREATE TABLE IF NOT EXISTS mobile_upload_destinations (
    id              TEXT PRIMARY KEY,          -- server-issued destination id
    registration_id TEXT NOT NULL REFERENCES mobile_registrations(host_id),
    label           TEXT NOT NULL,             -- admin-chosen label, e.g. "Inbox"
    rel_path        TEXT NOT NULL,             -- validated: Mobile/<hostId>/<slug>
    created_at      INTEGER NOT NULL,
    revoked_at      INTEGER,                   -- non-null => uploads fail at finalize
    UNIQUE(registration_id, rel_path)
);

-- One upload intent, host-bound and idempotency-keyed. The final file name
-- is RESERVED at creation so retries of the same intent reuse it and a lost
-- create response can never mint a second upload.
CREATE TABLE IF NOT EXISTS mobile_uploads (
    id               TEXT PRIMARY KEY,         -- server-issued upload id
    registration_id  TEXT NOT NULL REFERENCES mobile_registrations(host_id),
    destination_id   TEXT NOT NULL REFERENCES mobile_upload_destinations(id),
    idempotency_key  TEXT NOT NULL,            -- client-generated, unique per registration
    file_name        TEXT NOT NULL,            -- validated single segment, safe charset
    final_rel_path   TEXT NOT NULL,            -- destination rel_path + file_name (reserved)
    size_bytes       INTEGER,                  -- client-declared expected size (nullable)
    bytes_received   INTEGER NOT NULL DEFAULT 0, -- durable queryable offset
    sha256           TEXT,                     -- verified digest (set before publication)
    status           TEXT NOT NULL DEFAULT 'created', -- see state machine
    error            TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    finalized_at     INTEGER,
    UNIQUE(registration_id, idempotency_key)
);
```

## Upload state machine

```
created ──first chunk──▶ uploading ──all bytes──▶ ready
   │                        │   ▲                     │
   │                        │   │ (resume/append)     │ finalize
   ▼                        ▼   │                     ▼
 (failed | cancelled)   (failed | cancelled)       verifying
                                                        │ sha256 ok
                                                        ▼
                                                    publishing ──rename──▶ finalized
                                                        │
                                              (crash between rename and
                                               DB update is recovered by
                                               finalize retry; see below)
```

- `created`/`uploading` resume after a lost response or process death: the
  client `GET`s the upload and continues at `bytes_received` (the durable
  offset).
- `ready` ⇔ `bytes_received == size_bytes` (or the client declares finalize
  with no expected size).
- `verifying` computes SHA-256 over the staged bytes. A mismatch moves the
  upload to `failed` with a checksum-mismatch error and removes staging
  (bounded space); the client starts a fresh intent.
- `publishing` re-checks authorization (registration live, destination
  active, upload ownership) and re-checks the write boundary, then atomically
  renames staged → `final_rel_path`. `finalized_at` is stamped, the
  operation_log row is appended **once**, and the receipt is returned.
- Retry-safe finalization across the publication/completion crash window:
  the row carries `final_rel_path` and the verified `sha256` **before** the
  rename. A finalize call on a `finalized` row returns the stored receipt
  without appending history; a `publishing` row whose final file already
  exists and matches the recorded digest is completed in place; a final path
  that exists with **different** content fails with an explicit collision
  error — never a silent overwrite.

## Transfer contract

| Route (native bearer unless noted) | Behavior |
|---|---|
| `GET /api/v1/mobile/destinations` | Own **active** destinations (authorized inboxes) — the app's destination picker. Empty list = no upload access yet. |
| `POST /api/v1/mobile/uploads` | Body `{ destinationId, fileName, sizeBytes?, sha256? }` + `Idempotency-Key` header. Returns the upload (or the same upload on retry). Rejects: unknown/other-host destination (404/403), unsafe file name (400), final-name collision (409), size over cap (400/413), destination revoked (410). |
| `PUT /api/v1/mobile/uploads/:id/chunks` | Raw binary body, `X-Upload-Offset` header. Writes at exactly `bytes_received` (wrong offset → 409), bounded `chunkSizeBytes`, never exceeding `size_bytes`/`maxSizeBytes`, single-flight per upload. Returns the updated upload state. |
| `GET /api/v1/mobile/uploads/:id` | Full state: durable offset, sha256, status, error, receipt when finalized. Used for lost-response recovery. |
| `GET /api/v1/mobile/uploads` | Own upload history, newest first (status/progress/receipt). |
| `POST /api/v1/mobile/uploads/:id/finalize` | Verify size + digest, re-authorize, publish atomically, append operation_log once, return receipt `{ uploadId, fileName, finalRelPath, browseRef, sizeBytes, sha256, finalizedAt }`. Idempotent. |
| `POST /api/v1/mobile/uploads/:id/cancel` | Owner only, non-finalized only. Removes staging, marks `cancelled`. **Can never delete a published final file** (cancelling a `finalized` row is a no-op → 200 with the receipt). |

Admin (web session / admin bearer):

| Route | Behavior |
|---|---|
| `GET /api/v1/mobile/registrations/:hostId/destinations` | List a registration's destinations (active + revoked). |
| `POST /api/v1/mobile/registrations/:hostId/destinations` | Body `{ label, slug? }`. Computes + validates `Mobile/<hostId>/<slug>` (slug defaults to the label, sanitized; servers reject traversal/`.`, `/`, control chars, and any attempt to escape the landing root or name another host). |
| `POST /api/v1/mobile/registrations/:hostId/destinations/:id/revoke` | Idempotent; marks `revoked_at`. In-flight uploads fail at their next request/finalize. |

### Bounds and guards

- Server-negotiated `chunkSizeBytes` (default 4 MiB, env
  `LAMASYNC_MOBILE_CHUNK_BYTES`), per-upload cap `maxSizeBytes` (default
  2 GiB, env `LAMASYNC_MOBILE_MAX_UPLOAD_BYTES`), and a staging-space guard.
- Staging lives outside the browse tree under
  `<tmp>/lamasync-mobile-staging` (env `LAMASYNC_MOBILE_STAGING_DIR`), keyed
  by upload id — the id is server-generated, so a client can never express a
  path. Publication re-validates containment (resolveBrowsePath-style realpath
  check against the landing root) at the write boundary.
- Serialized writes/finalization per upload: an in-memory per-upload lock
  plus a DB `status` guard; simultaneous chunk writes and finalize cannot
  interleave, and stale-offset writes fail explicitly.
- Abandoned uploads (`created`/`uploading` untouched past an inactivity TTL,
  default 7 days) are failed and their staging removed by a boot-time
  reconcile (mirrors `reconcileStuckBrowseJobs`), plus a daily sweep.
- Authorization is re-checked on **every** request: native principal →
  registration live (revocation collapses to 401) → upload ownership; the
  destination grant and revocation are re-checked again at finalize, so a
  central revoke or destination revoke **prevents an in-flight transfer from
  publishing**. `revokeMobileRegistration` also marks in-flight uploads
  failed and revokes their destinations.

## Android execution model

- Queue items are persisted (kotlinx-serialization in app-private
  SharedPreferences) and bind to the **enrollment identity and origin** at
  intake: `origin`, `hostId`, plus the source content URI / staged file. A
  disconnect or re-pair never redirects old items to a new device/server —
  the transfer engine refuses to run an item whose (origin, hostId) does not
  match the current registration, including re-pairing at the same origin.
- **WorkManager (CoroutineWorker) is the durable transfer executor** — one
  unique worker draining the queue, `NetworkType.CONNECTED` constraint,
  enqueued whenever the queue becomes non-empty. It survives process death
  and reboot; the ViewModel only observes the persisted store and enqueues
  work. No ViewModel coroutine is the durable executor. Deferred execution
  is accepted and documented (no promise of immediate background transfer);
  user-visible progress comes from the persisted store.
- Intake: `ACTION_SEND` / `ACTION_SEND_MULTIPLE` (manifest filters) and
  `ACTION_OPEN_DOCUMENT` selection. The app takes persistable URI grants
  where available and **stages byte streams into bounded private storage**
  (quota + free-space checks) immediately, so transient share grants remain
  usable even if access expires; failure to retain content is an explicit
  error. Content URIs are never treated as filesystem paths.
- Local staging is retained until a durable completion/cancellation decision
  permits cleanup; source deletion never deletes the uploaded copy.
- The app shows uploading, waiting (network/tailnet), failed, cancelled and
  verified-completed states, per-item progress, retry/cancel, and a
  completion receipt with a working browse/open path into the embedded web
  UI's Data Browser at `Mobile/<hostId>/<slug>/`.

## Web UI

The Admin **Android devices** panel grows per-registration destination
management (list active/revoked destinations, create a labeled inbox,
revoke a destination) using the new admin routes — an authenticated desktop
setup surface for existing paired devices. The management UI remains the web
UI; no camera/media discovery, OCR, tiles, or extra conveniences in this
milestone.

## Negative coverage (hermetic server tests + Android tests)

Another device's upload/destination, destination revoke mid-flight, native
admin denial, traversal/symlink escape, filename collision, lost create/
chunk/finalize responses, simultaneous requests, checksum mismatch, wrong
offset, disk full, source permission loss, cancellation, central revocation,
and disconnect/re-pair with queued work that must not resubmit under a new
identity — plus preservation of every phase-1 origin, CSRF, logout and
cleanup regression (full `bun test` + the Android suites).