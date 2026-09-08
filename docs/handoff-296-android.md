# LAMA-296 — Android companion implementation handoff

Prepared 2026-09-06. Implement against the current LAMA-296 description and owner replies. This is an implementation assignment, not permission to deploy production or publish a release. Preserve unrelated changes. Read AGENTS.md, docs/agent-start.md, docs/status.md, and the issue before starting.

## Outcome and scope

Deliver an installable Android companion that pairs by QR once, opens an authenticated embedded LamaSync web UI, accepts Android shares/manual selections, and reliably uploads camera photos/videos to device-scoped destinations. Native Kotlin handles pairing, credentials, content access, persistence, and background transfers; reuse the React UI for management/browsing.

Complete stages 0–2 below. Stage 3 ideas in the issue (selected-folder automation, offline favourites, downstream processing) are future scope. Do not stop at a wrapper or mocked upload demo. Report unavailable real-device validation honestly rather than calling it complete.

The owner explicitly requires auth early: no API-key copying and no second web-view login. One enrollment serves both web and native surfaces; permissions remain separate internally. Owner-confirmed decisions: a sideloaded APK for the personal fleet; the paired embedded web UI has full fleet administration, while the native uploader remains destination-scoped. The trusted desktop enrollment explicitly grants the web administration authority; the phone cannot elevate its own device credential. No second login is required.

## Existing implementation to inspect

- packages/core/src/types.ts: Host, hostClass, pairing types, auth principals, assignments, operation reports. hostClass already distinguishes phone-like hardware; add client implementation/capabilities separately.
- packages/core/src/db/schema.ts: SERVER_SCHEMA and MIGRATIONS must both change for persisted contracts.
- packages/server/src/routes/pairing.ts and pairing.test.ts: existing admin-created, expiring, single-use enrollment; atomic claim then managed host-bound device credential issuance. Inspect failure/retry behavior carefully.
- packages/web-ui/src/pairing.ts and pairing.test.ts: QR generation already exists, but encodes only an uppercase pairing code, not a server address or versioned Android payload. Preserve the current CLI flow; add an explicit Android payload variant without uppercasing URLs/secrets.
- packages/server/src/auth.ts and ws.ts: device route allowlist and admin-only fleet WebSocket. UI hiding alone is not authorization.
- packages/web-ui/src/api.ts: bearer auth/storage plus download and multipart call sites. Audit every request path and WebSocket when adding session auth; a login screen bypass is insufficient.
- packages/server/src/routes/config.ts: desktop config includes backend/rclone data. Mobile config must not accidentally distribute those secrets.
- packages/server/src/routes/browse.ts and browse-jobs.ts: current upload is base64, capped at 64 MiB decoded. Build a dedicated streaming/resumable mobile contract; do not extend base64 into a video transport.
- packages/core/src/destination.ts and existing operation reporting: reuse canonical destination rules and managed execution where relevant.

No Android source was found in the initial repository inspection. Re-check HEAD and issue comments before scaffolding. Root package.json, not dated prose, is the version source of truth.

## Stage 0 — QR authentication and device contract

Implement and verify this before expanding upload features.

1. Desktop authenticated UI offers Add Android device, device label, allowed upload destinations, and the approved web access level.
2. QR contains a versioned enrollment payload with the server origin and a short-lived, single-use enrollment secret. No permanent bearer/admin key in QR, URLs, logs, screenshots of diagnostics, or navigation history. Reuse existing pairing lifecycle where compatible, with adequate entropy and exchange abuse protection.
3. Native app scans, displays the intended server/device, exchanges enrollment, and stores credentials securely using Android platform facilities. Do not trust caller-supplied existing host IDs as authority to take over another device. Bind grants to the enrollment server-side.
4. Establish an origin-bound web session without exposing native long-lived credentials to JavaScript. Document the chosen bootstrap/session/renewal contract, including separate server-issued authority for administration if approved. A plain device key must never mint an admin session.
5. Resolve transport early. Existing examples use tailnet HTTP; cookies marked Secure require HTTPS. Choose and document a working secure-origin deployment path and development setup. Do not disable certificate validation or add unrestricted cleartext access to make the demo pass. Tailnet reachability remains required; no public relay or embedded VPN is in scope.
6. If cookie auth is used, implement appropriate CSRF and origin protections for mutations, narrow cookie scope, session expiry, and WebSocket origin/auth checks. Prevent cross-origin WebView navigation from gaining authenticated native access; external links open without app credentials. Keep any native bridge minimal and origin restricted.
7. Central revocation invalidates the device's native credential and associated web/renewal sessions. Define local logout versus disconnect/revoke clearly; preserve pending work safely and explain re-pairing requirements.
8. Add client implementation/capabilities and mobile-aware presence. Enforce supported actions server-side. Sleeping/offline mobile devices show last check-in and last successful backup, without daemon-failure semantics.

Acceptance: one scan signs in both surfaces; restart recovers authorized access; no second login; expired, replayed, malformed and concurrent QR exchanges are handled safely; cross-device takeover and unauthorized elevation fail; revoked credentials/sessions stop working; unrelated navigation cannot receive secrets; legacy CLI pairing and browser bearer login still work. Test REST, download, upload, and WebSocket access, not just initial HTML.

## Stage 1 — Usable manual ingestion

Provide a Mobile uploads setup preset with stable per-device destinations such as Mobile/<device-id>/Inbox and Camera. Store source identity separately from desktop localPath/cron assumptions. Server chooses/validates actual destination paths from approved assignments; client input cannot select arbitrary backend paths. Defaults are one-way copy, no remote deletion when a local file disappears, and no silent overwrite on filename collision.

Deliver native share-target support for one/multiple files, system file/media selection, a persisted transfer queue, clear progress/waiting/failure states, cancel/retry controls, and uploaded-file browsing/download/open/share through authorized web/native surfaces.

Implement a bounded streaming protocol with persisted upload IDs, queryable progress, resumable offsets/chunks, checksums, retry-safe finalization, atomic publication, name/path validation, quota/space checks, and abandoned-staging cleanup. Specify collision and deduplication rules: filename alone is not file identity. Avoid buffering whole videos. Handle lost success responses and retries without duplicate final files.

Begin with one supported server landing destination. Integrate with managed transfers for onward storage only if needed. Report received/staged separately from protected at the promised final durability point. Tie operation history to the actual mobile device and source; do not reuse a synthetic browser actor as provenance.

Persist content grants where supported; for transient share URIs, securely stage readable bytes while the grant is valid, with bounded space and explicit failure handling. Define what happens if a queued source disappears or changes, and when local staging can be cleaned up.

Acceptance: pair → choose inbox → share/select → interrupt/restart → resume → one checksum-verified file at destination → visible operation history → browse/open/share. Unauthorized destination access, traversal, oversized payloads, wrong offsets, corrupt chunks, full disk, cancellation, and server restart must leave no falsely successful or partially published file.

## Stage 2 — Automatic camera protection

Add camera photos/videos, optional screenshots, selection of existing history versus new media only, and reliable incremental discovery with reconciliation. Persist discovery state and queue items so process death does not skip files. Handle partial/revoked media access honestly; do not claim coverage outside the granted collection.

Use current Android-supported background APIs appropriate to automatic work versus user-started long transfers. Verify official documentation against the chosen SDK; do not hardcode an assumption that WorkManager implies unrestricted execution. Provide unmetered-network/charging policies and eventual-progress semantics, not exact cron promises. Tailnet outage is a recoverable waiting condition.

Status must show last successful protection, pending count/bytes, and actionable waiting reasons. Derive any “protected through” statement from actual discovery/completion coverage, not simply the most recent upload timestamp. Repeated names, changed files, permission changes, and retries must not silently lose data. Source deletion never removes the server copy.

Acceptance on an emulator and, where available, a real phone: photos plus a video larger than the old 64 MiB limit; process death; app restart; reboot; network loss and recovery; tailnet unavailable; charging/network constraints; restricted/revoked permissions; duplicate retries; server restart during transfer; central device revocation. Demonstrate eventual verified arrival when constraints permit and no false protection claims.

## Optional follow-ups — design for extension, no delivery priority

Owner approved all seven convenience ideas below for the plan. None is a blocker for stages 0–2 or requires priority. Implement only when inexpensive alongside core work; otherwise defer explicitly. Keep the queue, source configuration, destination selection, and transfer results reusable so these can be added without redesign. Do not build speculative frameworks, placeholder controls, or unused APIs solely for future features.

| Feature | Intended behavior | Foundation to preserve |
| --- | --- | --- |
| Favourite upload destinations | Pin approved destinations and remember the last choice in share/manual upload flows. | Stable destination IDs and a reusable destination picker; revalidate permissions when used and handle removed destinations. |
| Upload now override | Explicitly allow selected pending items to bypass charging/unmetered preferences for that request. | Separate per-transfer user overrides from persistent policy; never bypass authorization, connectivity, integrity checks, or Android execution limits. |
| Upload receipt | Show verified final destination, size, completion time, and Open folder. | Persist a canonical completion result linked to operation history; distinguish staging from final protection and enforce browse access. |
| Initial backup storage estimate | Show approximate eligible file count and bytes before importing existing media. | Reuse discovery and permission boundaries; mark estimates as approximate and avoid reading/uploading every byte just to calculate them. |
| Quick Settings tile | Offer a lightweight pause/resume action or open the queue. | A shared native queue/pause command surface independent of a screen or WebView; reflect actual state. Choose one clear tile behavior when implemented. |
| Per-source exclusions | Exclude selected media collections or screenshots from future automatic discovery. | Stable source selectors and filtering before enqueue; do not delete existing backups. Define treatment of already queued items explicitly. |
| Timed pause | Pause for a duration such as one hour, then resume automatically; allow persistent pause with a visible indication. | Persist pause state and optional expiry, re-evaluate on restart and work execution, and resume when Android permits. Define automatic versus manual-upload scope clearly. |

Keep basic queue controls and source correctness required by stages 1–2; the convenience extensions above are optional. Record which shipped and which remain deferred in the review handoff. OCR, document scanning, photo organisation, and automatic local space reclamation remain outside this scope; they were not part of the seven approved additions.

## Packaging and validation

Choose and document the Android minimum/target SDK and dependency versions using current official docs. Keep Android/Gradle tooling from breaking Bun workspace discovery. Add reproducible APK build, lint and unit-test commands, required SDK/JDK setup, and instrumented test instructions. Keep signing secrets out of the repository. A sideload build must have a documented installation/update path and persistent application identity; production signing/distribution is separate from a debug APK.

Required repository checks:

```bash
bun install
bun x tsc --noEmit
bun run build:web-ui
bun test
bun run scripts/check-skill-drift.ts --strict
bun run build
```

Also run the implemented Android build/lint/unit checks and available instrumented integration checks. Use isolated local test data; never hand-edit fleet state or install rclone into a worktree. Validate authorization negatively, not just the happy path. Include migration coverage and regressions for existing desktop clients. No any/inline casts; shared contracts in core with .ts imports and public barrels. New routes need /api/v1 plugins, Swagger details, composition, and agent-skill reference updates.

Update architecture, development/build instructions, features/status, and relevant operator/API guidance. Replace the stale mobile-out-of-scope statement when support exists. Record actual tested versions rather than copying old test counts.

## Review delivery

Deliver focused commits or a reviewable diff, APK location and build instructions, stage-by-stage acceptance evidence, test results, screenshots of QR onboarding and upload/status flows without secrets, chosen auth/session/transport design, migration/compatibility notes, and explicit remaining limitations. If real-device checks are unavailable, provide exact steps and mark them unverified. Do not mark the issue fully verified based only on mocks.

The owner intends to have Codex review the completed work. Do not deploy, tag/publish, or rotate production credentials as part of this assignment. Update LAMA-296 with implementation results and unresolved blockers when authorized by the assignment.

## Official Android references

- https://developer.android.com/develop/background-work/background-tasks/data-transfer-options
- https://developer.android.com/training/data-storage/shared/media
- https://developer.android.com/training/data-storage/shared/documents-files
