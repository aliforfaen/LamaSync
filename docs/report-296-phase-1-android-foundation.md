# LAMA-296 phase 1 — Android foundation implementation report

Status: review package for the planning agent — initial implementation plus
the review correction round (findings 1–7) are complete. Dates: 2026-09-06
(initial), 2026-09-06/07 (correction round). Branch:
`aliforfaen/android-client`. Implements only
[`spec-296-phase-1-android-foundation.md`](spec-296-phase-1-android-foundation.md)
(stage 0 of [`handoff-296-android.md`](handoff-296-android.md)) plus Android
scaffolding. No uploads, background transfer, media features, deployment,
tagging, signing secrets, or "LAMA-296 done" marking — those remain deferred.

## What shipped (waves 1–2 + this integration pass)

- **packages/core** — mobile DTOs (`MobileEnrollment*`, `MobileWebSession*`,
  `MobileMe*`, `MobileCheckIn*`, `MobileRegistrationRevoke*`, `AuthMeResponse`
  dual-mode union) and `mobile_enrollments` / `mobile_registrations` /
  `web_grants` / `web_sessions` in both `SERVER_SCHEMA` and `MIGRATIONS`.
- **packages/server** — request-local principals (`WeakMap<Request,
  AuthPrincipal>`; Elysia shared-store bug fixed), a `mobile` principal
  confined to `/api/v1/mobile/me` + check-in, `web-session` cookie principal,
  mobile variant fail-closed; `mobile-store.ts` (hashed secrets, transactional
  single-use exchange, 10/min address + 5/min enrollment rate limits,
  10-minute enrollment TTL, 12-hour session TTL, CSRF derivation); the eight
  pinned routes in `routes/mobile.ts` with Swagger; cookie-session WS upgrades
  and live disconnect on revocation/expiry in `ws.ts`; dual-mode `/auth/me`.
- **Desktop (TUI + web UI)** — access-keys type union for the new principal;
  "Add Android device" enrollment modal (case-preserving versioned JSON QR,
  countdown, terminal-state polling, regenerate, revoke), SPA bearer/session
  dual-mode auth with CSRF on cookie mutations and no dummy key in
  sessionStorage; `agent-skill/reference/api.md` updated (strict drift check
  passes).
- **android/** — standalone Gradle project (`app.lamasync.companion`, minSdk
  26, compileSdk/targetSdk 35, JDK 17, Gradle 8.11.1, AGP 8.9.3, Kotlin
  2.2.21, Compose BOM 2025.07.00, CameraX 1.4.2, ML Kit barcode 17.3.0).
  Scan → confirm → exchange → Android-Keystore storage → native identity
  probe → cookie bootstrap → hardened WebView, plus check-in, reconnect, and
  explicit disconnect.

## Authentication flow (prose diagram)

1. Admin (master/admin key or an admin web-session) opens **Add Android
   device** in the authenticated desktop web UI. `POST /api/v1/mobile/
   enrollments` (`webAdmin: true`) creates a 10-minute enrollment: the server
   stores only `sha256(secret)` of a 256-bit random QR secret, selects no host
   yet, and returns `{enrollmentId, secret, serverOrigin, expiresAt, …}`
   exactly once. The modal renders the versioned JSON payload
   `{"kind":"lamasync.android.enroll","version":1,"serverOrigin":"https://…",
   "enrollmentId":"…","secret":"…"}` **with case preserved** and polls
   `GET /mobile/enrollments/:id` on a 10 s interval until a terminal state.
2. The phone scans the QR, validates kind/version/bare-HTTPS origin, and
   confirms. `POST /mobile/enrollments/:id/exchange` (exact pre-auth
   exemption: enrollment id + one-time secret in the body; no bearer) is
   rate-limited, then transactionally marks the enrollment used and creates,
   in one DB transaction: a server-chosen host id, a mobile registration, a
   **native token**, a **web grant**, and the producing enrollment's consumed
   state. Only hashes are stored; each secret is returned once. Errors: 400
   shape/origin, 401 wrong secret, 404 unknown, 409 used/revoked, 410
   expired, 429 throttled, 503 when `LAMASYNC_ORIGIN` is unset.
3. The app stores the native token and web grant encrypted with
   Android-Keystore-backed AES-256-GCM (no plaintext fallback; app opts out of
   backup/device transfer). It then proves its **native** identity
   (`GET /mobile/me`, `Authorization: Bearer <native token>`) — this call can
   only ever return its own registration, never fleet/config data — and saves
   the registration.
4. The app's **web-session broker** (the only component that touches the web
   grant) POSTs `{"grant": …}` to `POST /mobile/web-session`. The server
   issues the host-only `__Host-lamasync-mobile` cookie (Secure, HttpOnly,
   SameSite=Strict, Path=/, 12-hour absolute lifetime) and returns
   `{hostId, displayName, expiresAt, csrfToken}`. The app installs that
   cookie for the exact enrolled origin only and loads the SPA.
5. The SPA boots with no stored key and probes `GET /auth/me` with the cookie.
   A live session answers `{authenticated:true, mode:"session",
   kind:"mobile-session", …, csrfToken}`; the SPA keeps the CSRF token **in
   memory only** and sends it (`X-CSRF-Token`) plus the exact trusted Origin
   on every cookie-authenticated mutation. The session maps to admin REST
   permissions. An invalid `Authorization` header never falls back to the
   cookie (server and client both enforce this).
6. Revocation (desktop revoke or app Disconnect, which bootstraps a fresh
   session when needed and then satisfies the CSRF rules) atomically revokes
   the native token, the web grant, and every web session, flips the
   enrollment to revoked, and disconnects that registration's live WebSockets
   in-process; expiry stops delivery too. Logout invalidates only the current
   web session and clears the cookie — the native registration stays valid.
   The app clears local key material and cookies even when offline.

## Actual commands and results

### Repo gates (run in order, all green)

| Gate | Command | Result |
|------|---------|--------|
| Install | `bun install` | 198 installs, no changes |
| Types | `bun x tsc --noEmit` | pass (exit 0) |
| Web UI | `bun run build:web-ui` | built 154 modules, exit 0 |
| Tests | `bun test` | **1523 pass, 9 skip, 0 fail** (1532 tests / 128 files, 5753 expects) |
| Skill drift | `bun run scripts/check-skill-drift.ts --strict` | OK (138 API rows, 139 server routes, 70 CLI commands) |
| Build | `bun run build` | all binaries compiled, exit 0 |

Fix landed during this gate pass: `packages/web-ui/src/api-auth.test.ts`
deleted `globalThis.fetch` in `afterEach` without restoring it, poisoning
every later test file that shares Bun's test process (13 cross-package
failures: TUI client/register/dispatch, server notifications). It now captures
the pristine `fetch` at module load and restores it.

### Android gates

| Gate | Command | Result |
|------|---------|--------|
| Build | `JAVA_HOME=… ANDROID_HOME=… ./android/gradlew -p android assembleDebug` | BUILD SUCCESSFUL |
| Lint | `… lintDebug` | 0 errors, 44 warnings (version-available notices only) |
| Unit | `… testDebugUnitTest` | **57 tests, 0 failures** |
| Instrumented | `… connectedDebugAndroidTest` (API 35 `lamadb-test` AVD, headless) | **16 tests, 0 failures** when run with the live-HTTPS instrumentation args (12 base + 4 `VerticalHttpsEnrollmentTest`); without the server the four vertical tests skip cleanly and the 12 base tests pass |

APK: `android/app/build/outputs/apk/debug/app-debug.apk`
sha256 `e48727888888c5f36c9c28cf74eceacc8e9b6a312256979ab6a176fa389ddbe7`
(34 MB debug APK, versionName 0.1.0 / versionCode 1, `app.lamasync.companion`).

Instrumented coverage (real device behavior, not parser mirrors):
`KeystoreCredentialVaultInstrumentedTest` ×4 (Keystore round-trip across a
store reload, both secrets persisted encrypted, clear destroys secrets + key
material, corrupted ciphertext fails closed), `AppLaunchSmokeTest` ×1 (real
activity + ViewModel + repository on clean state → onboarding surface),
`WebViewNavigationInstrumentedTest` ×2 (hardened WebView settings on a real
WebView; a same-origin document redirecting cross-origin is consumed by the
policy and handed to the external opener before any network traffic),
`SessionViewModelEnrollmentResumeInstrumentedTest` ×2 (findings 1/5 state
machine on device with fakes), `SessionCookieJarInstrumentedTest` ×3
(finding 3 — real CookieManager install/expiry/offline removal), and the
`VerticalHttpsEnrollmentTest` ×4 HTTPS vertical (below).

### Cross-slice wire fixes made during this integration pass

- **Android bootstrap was broken against the real server.** The broker sent
  `{"webGrant": …}`; the server schema pins `{"grant": …}` (probe on the live
  Elysia app: wrong key → 422). Fixed in `WebSessionBroker.kt` (field
  renamed; body parse now also returns the session CSRF token).
- **Android disconnect could never satisfy CSRF.** The server requires the
  session cookie + `X-CSRF-Token` + exact Origin on cookie mutations (the
  web-ui + server tests prove 403 on missing CSRF); the broker sent only the
  cookie + Origin. `revokeRegistration` now carries the CSRF token from the
  fresh bootstrap; the flow test asserts both headers on the revoke wire.
- **Android `/mobile/me` mirror used a field the server never sends**
  (`clientVersion` vs canonical `appVersion`, plus missing `pairedAt`/
  `serverOrigin`), and check-in sent an undeclared `clientType` body key.
  Mirrors now match the core DTOs exactly.
- **`SecureEnvelope.seal` supplied its own IV**, which Android Keystore2
  rejects when the key requires randomized encryption
  (`InvalidAlgorithmParameterException: Caller-provided IV not permitted`) —
  caught only by the instrumented suite. It now lets the provider generate
  the IV (format unchanged: `v1:base64url(iv‖ciphertext)`), keeping the
  secure key default.
- **WebView instrumented tests could not launch**: androidx.test requires a
  host activity declared in the app process — added
  `android/app/src/debug/AndroidManifest.xml` (framework `Activity` host,
  exported, debug-only, plus the previously orphaned debug network-security
  config is now wired: user CAs trusted in debug builds only, cleartext never).
- **`api-auth.test.ts` fetch poisoning** (see gate results above).
- All of the above are consumer-side fixes; the server/`core` pinned contracts
  were verified correct and left unchanged.

## Manual emulator checklist (from the spec)

Verified items ran on the API 35 `lamadb-test` AVD (headless,
`-no-window -gpu swiftshader_indirect`) with the debug APK above. Items that
need a real HTTPS server + desktop session were run in the **correction
round's HTTPS vertical** against a disposable local front door; the table
below records the final state (see the Correction round section for the
per-link evidence table).

| # | Step | Expected | Status |
|---|------|----------|--------|
| 1 | Install `app-debug.apk` on a clean emulator and launch | App boots to the LamaSync Companion onboarding screen ("Scan enrollment QR code") with no crash; screenshot captured | **passed** (install Success; launch OK; screenshot verified) |
| 2 | `connectedDebugAndroidTest` on the AVD | 16/16 instrumented tests pass in the correction round: Keystore vault ×4, real-activity launch smoke, ViewModel enrollment-resume ×2, real-CookieManager lifecycle ×3, WebView hardening ×2, HTTPS vertical ×4 | **passed** |
| 3 | Point the app at a desktop-generated QR from an authenticated web session (`LAMASYNC_ORIGIN=https://…`) | Scan → confirm screen shows server/display name → exchange → "paired" → management WebView loads the fleet page authenticated, no second login; live WS events flow | **passed** (vertical device A/B, payload injected via the scanner seam; see Correction round) |
| 4 | Native check-in on launch/resume | Connection panel shows device id/name/version and a successful check-in; `last_seen` advances server-side | **passed** (vertical: server `lastSeenAt` advances after check-in) |
| 5 | Kill and relaunch the app | Stored credentials decrypt from Keystore; app skips onboarding straight to the management WebView (no re-scan) | **passed** at the fresh-ViewModel relaunch level in the vertical + Keystore instrumented round-trip + `CompanionRepositoryFlowTest`; an OS process-death relaunch was not run in this assignment |
| 6 | Let the 12 h web session expire (or revoke server-side), then use "Reconnect web session" | Reconnect re-bootstraps from the stored web grant without a QR or key prompt | **passed** (vertical device A: SPA logout then explicit reconnect — no re-scan, no re-exchange) |
| 7 | Tap an external HTTPS link inside the WebView | Link opens in the system browser (no app credentials); the WebView never navigates away from the enrolled origin | **passed at the policy/wiring level on-device** (instrumented cross-origin test); full external-browser handoff on a real page unverified |
| 8 | Present a bad certificate | WebView cancels the load (SSL error never proceeded past) | **unverified** (no TLS fixture server; SslErrorHandler.cancel is exercised in HardenedWebView code, no on-device fixture) |
| 9 | Revoke the device from the desktop while the WebView is open | Registration/native/grant/sessions all die; the open WebView disconnects (live WS close) and its next request fails closed | **passed** (vertical device B: revoke by hostId from the fresh registrations projection → cookie 401, `/mobile/me` 401, live WebSocket closed by the server) |
| 10 | Re-pair after revoke/disconnect | Explicit re-pair clears previous local auth + cookie before activating the new server; one enrollment, no second key/login prompt | **passed** in the vertical (device B paired after device A's disconnect; single registration/hostId per device) |

## Compatibility limitations

- **`LAMASYNC_ORIGIN` is required** for the mobile flow. Enrollment
  create/exchange and web-session bootstrap return 503 until it is set to a
  canonical `https://` origin. The canonical origin is the trust anchor for
  QR payloads, CSRF Origin checks, and cookie scope; `Host`/forwarding
  headers are never trusted.
- **HTTPS-only Android flow.** The app rejects non-HTTPS origins, plaintext,
  and (outside debug builds) user CAs. Legacy HTTP tailnet installs remain
  served by existing clients unchanged, but an Android device cannot enroll
  against them until an HTTPS front door exists (documented local-TLS recipe
  in `docs/development.md`).
- **compileSdk 35 is pinned.** SDK 36 components need a provisioning step
  this project deliberately avoids; the whole dependency matrix (Compose BOM
  2025.07.00, CameraX 1.4.2, core-ktx 1.15.0, AGP 8.9.3) was chosen to
  compile against android-35. Lint's 44 warnings are version-available
  notices.
- **One enrolled server per app installation** in phase 1; re-pairing is
  explicit and wipes previous local auth.
- The web UI still emits the pre-existing production bundle-size warning
  (unrelated to this work).

## Deferred features (explicitly out of phase 1)

- Native uploads, upload endpoints, destination grants, folder creation.
- Background service / transfer scheduler / WorkManager policies.
- Camera/media discovery and storage permissions (camera is QR-only).
- Play Store distribution, release signing, APK publishing; manual
  install/update path is the debug APK.
- User accounts / multi-user; refresh-token rotation for web sessions.
- The full LAMA-296 roadmap beyond stage 0 (see
  [`handoff-296-android.md`](handoff-296-android.md)).

## Correction round — review findings 1–7 (2026-09-06/07)

Addresses [`review-296-phase-1-android-foundation.md`](review-296-phase-1-android-foundation.md).
The fix commits are the four commits on branch `aliforfaen/android-client`
after `7235c4e` (android fixes / server+core+agent-skill / web-ui panel /
docs); the review document itself is untouched.

### Finding-by-finding fix table

| # | Finding | Fix | Regression evidence |
|---|---------|-----|---------------------|
| 1 (P1) | Interrupted-enrollment credentials were not bound to their origin; a later different-QR confirm could send A's secrets to B | Persisted `EnrollmentBinding(origin, enrollmentId, hostId, displayName, stage)`; repository resumes only the exact (origin, enrollmentId) and `completeEnrollment` refuses any other origin; a different QR clears prior local auth before its own exchange | `EnrollmentInvariantRegressionTest` (JVM): origin-mismatch refusal, per-origin wire isolation, A credentials never reach B; `SessionViewModelEnrollmentResumeInstrumentedTest.scanningDifferentOriginAfterInterruptedEnrollmentRunsItsOwnExchange` (on-device state machine); vertical device-A restart + device-B re-pair |
| 2 (P1) | Disconnect used the stale CookieManager cookie with a fresh CSRF (403/401); native revocation could fail while the grant stayed live | `CompanionRepository.disconnect` bootstraps a fresh session and revokes with that bootstrap's own cookie + CSRF pair; CookieManager is never consulted for the revoke | `CompanionRepositoryFlowTest` (revoke wire asserts cookie/CSRF from the same bootstrap); vertical device-A "native disconnect with an existing cookie → 200, server authority dies" (server registration revokedAt set; `/mobile/me` 401) |
| 3 (P1) | Expiry cookie omitted `Secure`/host-only attrs, so `__Host-` validation rejected removal; cleanup was reported `localCleared=true` unconditionally | `SessionCookieJar` expires with full valid `__Host-` attribute set, awaits the platform completion callback, and confirms absence by read-back before reporting success; repository reports `localCleared` honestly | `SessionCookieJarInstrumentedTest` ×3 (real CookieManager install/clear/reload/offline removal); `CompanionRepositoryFlowTest` offline disconnect honesty; vertical device-D offline disconnect: real cookie absent from CookieManager after failure + honest UI message |
| 4 (P1) | `webAdmin:false` sessions passed the REST boundary and could read fleet data; `GET /hosts` → 200 | Bootstrap refuses non-admin grants (403) and the REST boundary denies non-admin cookie sessions centrally except `/auth/me` + logout (defense in depth) | `packages/server/src/routes/mobile.test.ts` (false-grant bootstrap 403; boundary deny for `/hosts`/`/folders`; full-admin still works) |
| 5 (P2) | A bootstrap failure lost onboarding: retry cleared credentials and re-exchanged the consumed QR (server 409) | Stage-aware resume: `EnrollmentStage.REGISTERED` retry re-bootstraps from the stored grant without clearing or re-exchanging; display name preserved | `SessionViewModelEnrollmentResumeInstrumentedTest.retryAfterBootstrapFailureResumesWithoutReExchange`; `EnrollmentInvariantRegressionTest`; vertical device-C: exchange exactly once on the real server, retry succeeds, hostId/native token unchanged |
| 6 (P2) | Existing mobile registrations were not revocable after the enrollment modal closed/reloaded | New admin projection `GET /api/v1/mobile/registrations` (bare `MobileRegistrationSummary[]`, newest first, revoked rows included, no secrets) + persistent `MobileDevicesPanel` on Admin with revoke-by-hostId; API + skill reference updated | `packages/web-ui/src/mobile-registrations.test.ts` + `MobileDevicesPanel.test.tsx` (224 web-ui tests pass); server `mobile.test.ts` projection rows; vertical device-B: pair → desktop "reload" (fresh GET of the projection) → revoke by hostId → cookie 401, `/mobile/me` 401, live WS closed |
| 7 (P2) | Malformed/unsupported explicit `Authorization` silently fell back to the cookie | Auth boundary checks header presence first: present-but-malformed → 401, never cookie fallback; scheme parsed case-insensitively; only an absent header may use the cookie | `packages/server/src/auth.test.ts` (empty/basic/bare-bearer/mixed-case/invalid rows) and route tests; web-ui `api-auth.test.ts` client parity |
| M | Rate-limit maps never pruned stale keys | Bounded eviction: prune sweep every 64 checks + 512-cardinality cap per map | `mobile.test.ts` rate-limit cardinality/expiry cases with fake clock |

### Vertical HTTPS test (review "Before acceptance" paragraph)

Run against a **disposable local HTTPS front door** (self-signed CA; debug NSC
trusts user CAs) + **disposable server data dir**, `LAMASYNC_ORIGIN` set to
the emulator-visible origin, and the built web UI served through it. The
"desktop" side is driven through the same admin endpoints the web UI calls
(enrollment create / registrations projection / revoke); the QR payload is
injected into `SessionViewModel` via `onQrScanned` (scanner seam — no camera).
Dedicated class: `android/app/src/androidTest/java/app/lamasync/companion/
vertical/VerticalHttpsEnrollmentTest.kt` (skipped when no `verticalOrigin`
instrumentation arg is present, so plain connected runs stay green).

Per-link results (all against the live HTTPS server on the API 35 AVD):

| Link | Evidence | Result |
|------|----------|--------|
| exchange → identity → cookie bootstrap | device-A real `SessionViewModel` reaches MANAGE; server registration row live, enrollment `used` once, `lastSeenAt` advanced by check-in | **passed** |
| Cookie authenticates (SPA boot probe) | `GET /api/v1/auth/me` with the platform-installed cookie → `authenticated, mode=session` | **passed** |
| Authenticated SPA load (WebView reaches fleet page) | App-hardened WebView at the origin renders the admin shell (DOM body contains nav "Activity", no "Sign in") | **passed** (page-state assertion; exact Compose-hosted pixel rendering not asserted) |
| Live WS events visible | Same-origin cookie-session WebSocket from the WebView reaches OPEN; server closes it on revoke | **passed** at the socket layer (DOM event-feed rendering not asserted — no SPA DOM fixture for live rows) |
| App restart recovery | Fresh `SessionViewModel` over the same persisted stores boots to MANAGE without re-scan; same hostId; cookie survives | **passed** (VM-level relaunch over real Keystore/SharedPreferences/CookieManager; OS process-death relaunch covered by Keystore instrumented round-trip + AppLaunchSmoke) |
| Logout → explicit reconnect (no re-scan, no re-exchange) | SPA logout (cookie+CSRF+Origin) kills only the session; reconnect restores it; exactly one registration/hostId and enrollment still `used` once | **passed** |
| Native disconnect WITH an existing cookie (finding 2 path) | Cookie present pre-disconnect; fresh bootstrap cookie+CSRF revoke → 200; server revokedAt set; local cookie/store cleared | **passed** |
| Desktop revoke AFTER desktop reload via GET `/mobile/registrations` (finding 6 path) | Fresh projection lists the paired device by hostId only; revoke by hostId → cookie session 401, `/mobile/me` 401, live WS closed | **passed** (endpoint path the panel drives; React clicks covered by web-ui tests) |
| Bootstrap-interruption retry (finding 5) | Exchange+identity hit the real server once; first `/web-session` POST dropped (transport seam); UI Retry resumes REGISTERED → success, no re-exchange, display name + native token unchanged | **passed** |
| Offline local cleanup honesty (finding 3) | Offline transport; disconnect reports local clear + remote failure; real CookieManager cookie gone; store/vault cleared; server registration untouched until cleanup revoke | **passed** |

Unverified / not automated (exact blockers):
- Camera pixel scan (payload injected via the scanner seam instead) and the
  desktop web UI's pointer-level click path (enrollment modal, panel button)
  are not driven in this vertical; the exact wire calls the UI makes are, and
  UI logic itself is covered by the 224 web-ui tests.
- Rendering of a specific live WS *event row* inside the SPA DOM was not
  asserted (no deterministic event-source fixture; socket open/close on the
  same cookie session is asserted, and server-side event fan-out is covered by
  `mobile-ws.test.ts`).

Server-side DB evidence after the run (disposable SQLite): 4 registrations
with distinct `mob-*` host ids — A revoked (native disconnect), B revoked
(desktop, reason `Revoked from the desktop web UI`), C live (bootstrap
retry), D revoked (vertical cleanup); 4 enrollments all `web_admin=1`, each
used exactly once; web grants + web sessions revoked exactly as the chain
demands (C's session still live at end). Front door: `socat` TLS terminator
with a cert SAN for `10.0.2.2`; CA installed into the AVD user store.

## Known deviations / notes for review

- The end-to-end HTTPS vertical (enrollment → authenticated SPA → reconnect →
  disconnect → desktop revoke) was run on the emulator against a disposable
  local HTTPS server in the correction round (above). What remains narrower
  than the spec's full checklist is camera/desktop-UI pointer automation and
  SPA DOM event-row rendering, with blockers recorded in that section; every
  server-side behavior is also covered hermetically by route/WS/auth tests,
  and native behavior by unit + instrumented tests.
- `probeSession` treats any `/auth/me` response that is not a live
  `mobile-session` payload as "no session" (bearer flow handles its own key);
  an admin bearer key stored in the browser wins over a stale cookie by
  design (server enforces the same precedence).
