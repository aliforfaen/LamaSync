# LAMA-296 — stage 1: usable manual uploads

Prepared 2026-09-07 for the next coding agent. Implement this milestone in
`/home/messhias/orca/workspaces/lamasync/android-client`, then return for
review. This is the manual-ingestion stage of `handoff-296-android.md`;
automatic camera discovery remains the next milestone.

## Starting state

- Branch: `aliforfaen/android-client`; HEAD at preparation: `25404e0`.
- Phase 1 means handoff **stage 0**, the Kotlin QR/authentication foundation.
  It exists and has been reviewed. Do not scaffold a replacement app.
- The accepted final cleanup fix is still uncommitted in four Android source/
  test files, alongside `review-296-phase-1-touch-ups.md`. Preserve these
  changes as the starting baseline. A clean checkout of HEAD omits that fix.
- Last executed Android tests: 62 unit tests passed; 21 instrumented tests
  passed and four live-HTTPS cases skipped. The subsequent independent
  review reported no actionable regressions. These are historical results,
  not validation of your forthcoming implementation.
- LAMA-296 is still backlog/low in Multica. Its current issue description
  contains the broader stage 0–2 plan; this assignment delivers stage 1 only.

Read `AGENTS.md`, `docs/agent-start.md`, `docs/status.md`, LAMA-296 and its
comments, `docs/handoff-296-android.md`, the phase-1 spec/report and latest
touch-up review, then the relevant architecture/development contracts.
The phase-1 spec's prohibition on speculative upload work applied to that
completed milestone; actual manual uploads are now the assigned work.

## Required outcome

A paired phone can select documents or receive one/multiple Android shares,
choose an authorized inbox, persist the upload work, recover after interruption,
and deliver exactly one verified final file per upload intent. Users can see
progress and actionable waiting/failure states, retry or cancel, and browse,
download, and open/share completed files.

Use the existing native credential for narrowly authorized upload operations.
Keep the separate full-administration web grant/session and origin binding
intact. No API-key entry or second web login. Native code must not use the
administrative web grant to bypass missing upload permissions.

## Implement in this order

### 1. Scoped destinations and transfer contract

Write the selected protocol and state transitions in a short stage-1 spec
before wiring clients. Continue implementation after documenting it; ordinary
implementation decisions do not require another planning approval.

Start with one server-local landing root, configured by the administrator.
Resolve it through the existing destination/backend contracts where practical.
The final, verified file in that root is this milestone's durability point;
do not claim off-host backup or implement onward cloud replication here.

Provide an authenticated desktop setup surface for the permitted mobile inbox
and allow it to be configured for existing paired devices. Existing registrations
default to no upload access until explicitly assigned. Server-issued destination
IDs select permitted paths such as `Mobile/<host-id>/Inbox`; request bodies
must never select arbitrary roots, backend credentials, or another host's inbox.
Configuration must survive server restart. Keep mobile source identity separate
from daemon local-path/cron assumptions.

The resumable transfer contract must include:

- Host-bound persistent upload IDs and a client-generated idempotency key.
  Retrying creation after a lost response returns the same authorized upload.
- Bounded binary streaming/chunks, durable queryable offsets, total-size limits,
  SHA-256 verification, and explicit state transitions. Never buffer a whole
  video or reuse the base64 `/browse/upload` endpoint.
- Serialized writes/finalization per upload; wrong offsets and incompatible
  retries fail explicitly. A lost chunk response can recover by querying state.
- Atomic publication after checksum verification, a persisted completion
  receipt, and retry-safe finalization across process death/server restart.
  Cover the crash between filesystem publication and DB completion recording.
- No silent overwrite on filename collision. Reserve a stable final name per
  upload intent and reuse it on retries; identical filenames alone are not
  proof of duplicate content.
- Bounds on staging space, active transfers and request size, disk-full errors,
  abandoned staging cleanup, and cancellation that cannot delete a completed
  final file. Validate traversal and symlink escapes at the write boundary.
- Authorization by current native principal, registration, destination grant,
  and upload ownership on every request and again before publication. Revocation
  must prevent an in-flight transfer from publishing after authorization is lost.

Record completed/failed operations using the actual originating Android host
and source. Keep retries from creating duplicate completion history. Reuse
the existing operation schema and browse surface wherever their contracts fit.

### 2. Native manual upload flow

Implement document selection and `ACTION_SEND`/`ACTION_SEND_MULTIPLE` intake,
an authorized destination picker, and a durable queue. Accept content URIs
through Android APIs; do not treat them as filesystem paths.

Persist document grants when available. Copy transient shared content into
bounded private staging while access is valid; show an explicit failure if it
cannot be retained. Handle unknown sizes, missing/changed sources, insufficient
local space, and intake while unpaired. External intents cannot choose server
origins or override destination grants. Queue items must bind to the enrollment
identity and origin so disconnect/re-pair never redirects old uploads to a new
device/server, including re-pairing at the same origin.

Use persistent scheduling appropriate to user-initiated/deferred Android work;
verify the current official Android guidance for the project's SDK before
choosing APIs. Persist queue state across process death/reboot; do not rely on
a ViewModel coroutine as the durable transfer executor. Display uploading,
waiting for network/tailnet, waiting for policy, failed, cancelled and verified
completion accurately. Keep local staging until a durable completion/cancellation
decision permits cleanup. Source deletion must never delete uploaded copies.

Provide basic progress, retry/cancel and relevant network/charging preferences,
plus a completion receipt with destination/size/time and a working browse/open
path. Keep the web UI for management. Do not add camera/media auto-discovery,
Quick Settings tiles, OCR, or other optional conveniences during this milestone.

### 3. Verify the complete flow and return for review

Acceptance: existing QR enrollment → configure/select authorized inbox →
share/select → interrupt upload → app/server restart → resume → one
checksum-verified final file → Android-host operation history → browse/open.
Include a file larger than 64 MiB and prove memory stays bounded by chunks.

Negative coverage must include another device's upload/destination, grant
removal, native admin denial, traversal/symlink escape, collisions, lost create/
chunk/finalize responses, simultaneous requests, checksum mismatch, wrong
offset, disk full, source permission loss, cancellation, and central revocation.
Exercise disconnect/re-pair with queued work without resubmitting it under the
new identity. Preserve all phase-1 origin, CSRF, logout and cleanup regressions.

Use disposable server storage and HTTPS fixtures, never production. Run the
repository gates from `AGENTS.md`, plus packaging build for the deliverable:

```bash
bun install
bun x tsc --noEmit
bun run build:web-ui
bun test
bun run scripts/check-skill-drift.ts --strict
bun run build
JAVA_HOME=/usr/lib/jvm/java-17-openjdk ANDROID_HOME=/opt/android-sdk ./android/gradlew -p android assembleDebug lintDebug testDebugUnitTest
JAVA_HOME=/usr/lib/jvm/java-17-openjdk ANDROID_HOME=/opt/android-sdk ./android/gradlew -p android connectedDebugAndroidTest
```

Local tooling: `/opt/android-sdk`, JDK 17, API 35 `lamadb-test` AVD. Android
Studio's bundled JDK 25 was incompatible with this project's Gradle version.
Do not count skipped HTTPS tests as passed; run the disposable HTTPS vertical
where available and record exact unverified real-phone steps otherwise.

## Likely code touchpoints

- `packages/core/src/types.ts`, DB schema/migrations, public barrel.
- `packages/server/src/auth.ts`, `mobile-store.ts`, `routes/mobile.ts`,
  `routes/browse.ts`, browse jobs and operation history code.
- `packages/web-ui/src/` Android enrollment/registration administration and
  destination configuration; `packages/agent-skill/reference/` for new routes.
- `android/app/src/main/java/app/lamasync/companion/` data/network/UI,
  Android manifest and Gradle dependencies; unit and instrumented suites.

Follow existing `.ts` imports, core wire types, schema+migrations, Elysia
plugins/Swagger and strict skill drift. Update architecture/development/status
and produce `docs/report-296-stage-1-manual-uploads.md` with protocol decisions,
test evidence, APK path/hash, compatibility notes and honest limitations.

Return a reviewable diff. Preserve the accepted starting changes, keep one
writer in this checkout, and do not deploy, publish/tag, rotate production
credentials or mark the entire Android issue complete. Stage 2 automatic camera
protection is the next assignment after stage-1 review.
