# LAMA-296 phase 1 — Android foundation implementation report

Status: review package for the planning agent. Date: 2026-09-06. Branch:
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
| Tests | `bun test` | **1496 pass, 9 skip, 0 fail** (1505 tests / 126 files, 4360 expects) |
| Skill drift | `bun run scripts/check-skill-drift.ts --strict` | OK (137 API rows, 138 server routes, 70 CLI commands) |
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
| Unit | `… testDebugUnitTest` | **49 tests, 0 failures** |
| Instrumented | `… connectedDebugAndroidTest` (API 35 `lamadb-test` AVD, headless) | **7 tests, 0 failures** |

APK: `android/app/build/outputs/apk/debug/app-debug.apk`
sha256 `5be9a44ea72777534ebaca4a5c9bd90f2f0b05c4af55b7c0514d576ce2400a2a`
(34 MB debug APK, versionName 0.1.0 / versionCode 1, `app.lamasync.companion`).

Instrumented coverage (real device behavior, not parser mirrors):
`KeystoreCredentialVaultInstrumentedTest` ×4 (Keystore round-trip across a
store reload, both secrets persisted encrypted, clear destroys secrets + key
material, corrupted ciphertext fails closed), `AppLaunchSmokeTest` ×1 (real
activity + ViewModel + repository on clean state → onboarding surface),
`WebViewNavigationInstrumentedTest` ×2 (hardened WebView settings on a real
WebView; a same-origin document redirecting cross-origin is consumed by the
policy and handed to the external opener before any network traffic).

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
need a real HTTPS server + desktop session are **unverified** — no server was
stood up and no emulator-driven HTTPS enrollment was performed in this
assignment (owner's emulator setup is separate; scope says report honestly).

| # | Step | Expected | Status |
|---|------|----------|--------|
| 1 | Install `app-debug.apk` on a clean emulator and launch | App boots to the LamaSync Companion onboarding screen ("Scan enrollment QR code") with no crash; screenshot captured | **passed** (install Success; launch OK; screenshot verified) |
| 2 | `connectedDebugAndroidTest` on the AVD | 7/7 instrumented tests pass: Keystore vault round-trip/clear/fail-closed, real-activity launch smoke, WebView hardening + cross-origin consumption | **passed** |
| 3 | Point the app at a desktop-generated QR from an authenticated web session (`LAMASYNC_ORIGIN=https://…`) | Scan → confirm screen shows server/display name → exchange → "paired" → management WebView loads the fleet page authenticated, no second login; live WS events flow | **unverified** (needs real HTTPS server + desktop QR) |
| 4 | Native check-in on launch/resume | Connection panel shows device id/name/version and a successful check-in; `last_seen` advances server-side | **unverified** (server round-trip not exercised) |
| 5 | Kill and relaunch the app | Stored credentials decrypt from Keystore; app skips onboarding straight to the management WebView (no re-scan) | **unverified** end-to-end; stored-state recovery covered by unit tests (`CompanionRepositoryFlowTest`) and Keystore instrumented round-trip (passed) |
| 6 | Let the 12 h web session expire (or revoke server-side), then use "Reconnect web session" | Reconnect re-bootstraps from the stored web grant without a QR or key prompt | **unverified** (needs live server); reconnect path covered by unit tests (passed) |
| 7 | Tap an external HTTPS link inside the WebView | Link opens in the system browser (no app credentials); the WebView never navigates away from the enrolled origin | **passed at the policy/wiring level on-device** (instrumented cross-origin test); full external-browser handoff on a real page unverified |
| 8 | Present a bad certificate | WebView cancels the load (SSL error never proceeded past) | **unverified** (no TLS fixture server) |
| 9 | Revoke the device from the desktop while the WebView is open | Registration/native/grant/sessions all die; the open WebView disconnects (live WS close) and its next request fails closed | **unverified** (needs live server + desktop) |
| 10 | Re-pair after revoke/disconnect | Explicit re-pair clears previous local auth + cookie before activating the new server; one enrollment, no second key/login prompt | **unverified** end-to-end; re-pair clearing covered by unit tests (passed) |

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

## Known deviations / notes for review

- The report's verified scope is narrower than the spec's full checklist:
  end-to-end enrollment against a live HTTPS server was not run in this
  assignment. Every server-side behavior IS covered by hermetic route tests
  (`mobile.test.ts`, `mobile-ws.test.ts`, `auth.test.ts` etc.), and every
  native behavior short of a real server round-trip is covered by unit +
  instrumented tests — but the two halves meet only in code review until the
  manual run happens.
- `probeSession` treats any `/auth/me` response that is not a live
  `mobile-session` payload as "no session" (bearer flow handles its own key);
  an admin bearer key stored in the browser wins over a stale cookie by
  design (server enforces the same precedence).
