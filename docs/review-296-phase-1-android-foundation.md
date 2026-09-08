# LAMA-296 phase 1 — orchestrator review

Reviewed 2026-09-06. **Changes requested before accepting phase 1.**

Implementation: `/home/messhias/orca/workspaces/lamasync/android-client`, branch `aliforfaen/android-client`, commit `ed7ab738015396f89f791cb486c057351e593c19`. Reviewed against `docs/spec-296-phase-1-android-foundation.md` and the implementation report. Source paths and line numbers below refer to that implementation checkout. This review is saved in the original planning checkout; implementation files were not changed.

The architecture is worth keeping: distinct native and web authority, hashed server secrets, transactional enrollment, request-local principals, a separate native broker, and a small Android shell. The problems are in permission enforcement and lifecycle transitions. Fix these before adding uploads.

## 1. P1 — Bind interrupted enrollment credentials to their original origin

`android/app/src/main/java/app/lamasync/companion/ui/SessionViewModel.kt:132–150`; `data/CompanionRepository.kt:94–142`.

Exchange persists the two secrets before the identity probe, but the origin/registration is saved only after that probe succeeds. If identity fails, the vault contains credentials and registration remains absent. Confirming any subsequently scanned QR takes the `alreadyExchanged` branch and sends those existing credentials to the **new QR's origin**. The retry path has the same problem. If the new server answers `/mobile/me`, the app then sends it the old web grant too. HTTPS validation cannot prevent disclosure to a different valid HTTPS server.

Persist an enrollment state that binds credentials to canonical origin, enrollment ID, issued host ID, and completed stage. Resume only that enrollment at that origin. A different QR must explicitly replace/clear pending state and perform its own exchange. Repository methods should enforce this invariant, independent of ViewModel checks.

Regression: exchange on origin A succeeds; identity request fails; restart/back out and scan origin B. Assert that neither A's native token nor A's web grant appears in any request to B. Also prove same-enrollment recovery after process death.

Evidence: traced actual ViewModel/repository paths; no device exploit was run.

## 2. P1 — Use the same session for disconnect's cookie and CSRF token

`android/app/src/main/java/app/lamasync/companion/data/CompanionRepository.kt:232–235`.

Disconnect bootstraps session B, then prefers the existing WebView cookie for session A while using B's CSRF token. Normally paired devices have that old cookie, so the revoke endpoint rejects with 403; an expired old cookie instead yields 401. Local credentials are subsequently discarded while server authority remains live.

Use the cookie pair and CSRF token from the same fresh bootstrap response. There is no need to consult CookieManager for this native revoke request.

Confirmed against the real Elysia routes with isolated SQLite fixtures: old cookie + fresh CSRF → **403**, native credential remains valid; fresh cookie + matching CSRF → **200**. The Android fake currently returns 200 regardless of cookie/token correspondence, so it misses this defect.

Regression: seed cookie A, bootstrap distinct cookie B and CSRF B, and require revoke to send B/B. Cover stale A and no A too.

## 3. P1 — Correct and verify local session-cookie deletion

`android/app/src/main/java/app/lamasync/companion/web/SessionCookieJar.kt:40–46`.

The expiry cookie omits `Secure`, although its name starts with `__Host-`. Prefix validation rejects such a cookie; setting an expiry does not exempt it from the prefix requirements. This leaves the old admin cookie behind during offline disconnect or re-pairing. The repository also swallows cleanup failures and reports `localCleared = true` unconditionally.

Expire the cookie with its valid secure host-only attributes, await completion, and verify removal. Handle cleanup failure honestly. Use the completion callback for installation as well, so enrollment success means the cookie was accepted before the WebView opens.

Regression: real CookieManager instrumented test installs the production-form Secure/HttpOnly/Strict cookie, clears it, verifies absence immediately and after reload, and covers offline disconnect. Existing instrumented tests cover the vault and WebView navigation, not this adapter.

Evidence: code plus documented cookie-prefix rules; not reproduced on an emulator in this review. See [Set-Cookie prefix requirements](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#cookie_prefixes) and [Android CookieManager callback contract](https://developer.android.com/reference/android/webkit/CookieManager#setCookie(java.lang.String,%20java.lang.String,%20android.webkit.ValueCallback%3Cjava.lang.Boolean%3E)).

## 4. P1 — Fail closed for sessions without the admin grant

`packages/server/src/auth.ts:403–430`; `packages/server/src/mobile-store.ts` (`bootstrapMobileWebSession`).

Enrollment accepts `webAdmin: false`; bootstrap creates an `admin: 0` session. The REST cookie boundary nevertheless admits it to all routes. Some handlers explicitly require admin, but others rely on the boundary, including fleet listing and folder operations. The WebSocket gate checks the admin flag; the REST boundary does not.

Confirmed using enrollment/exchange/bootstrap with `webAdmin: false`: **GET /hosts → 200; GET /folders → 200**. This contradicts the stored grant even though the current desktop UI requests full admin by default.

For this phase, reject non-admin web-session issuance or deny such sessions centrally except for explicitly permitted identity/logout behavior. Do not invent a partial-access product as part of the fix.

Regression: false-grant session cannot read fleet data or invoke folder mutations; full-admin session still works. Test actual routes that rely on boundary authorization, not only handlers already using `requireAdmin`.

## 5. P2 — Resume bootstrap failures without consuming the QR again

`android/app/src/main/java/app/lamasync/companion/ui/SessionViewModel.kt:157–165`, and `confirmEnrollment` at line 133.

After exchange and identity succeed, the repository saves registration before bootstrapping the cookie. If bootstrap fails, the UI returns to confirmation. Retry treats an existing registration as a reason not to resume, calls full enrollment, clears the saved credentials, and re-exchanges the already-consumed QR. The server correctly returns 409. A temporary network failure therefore loses recoverable onboarding.

Use the persisted stage from finding 1: retry bootstrap using the saved grant and origin, without clearing or re-exchanging. Preserve the user's selected display name.

Regression: exchange/identity succeed, bootstrap fails once, UI Retry succeeds. Assert exactly one exchange and unchanged native credential. Test the ViewModel/state transition; direct calls to repository recovery alone do not cover this bug.

## 6. P2 — Keep existing registrations revocable after closing enrollment

`packages/web-ui/src/components/AndroidEnrollmentModal.tsx:38–84`; `packages/web-ui/src/pages/Admin.tsx`.

The only desktop caller of `revokeMobileRegistration` is the enrollment modal, and it only knows the current QR's paired host. Closing/reloading discards that state; reopening creates a new QR. Existing mobile registrations are not included in the access-key list, and there is no persistent mobile-registration revoke surface. The offline-disconnect instruction to revoke from desktop is consequently unusable through the intended UI after the original modal closes.

Add a minimal persistent paired-device listing/detail with linked revoke, using an admin-only server projection. Alternatively expose registration identity and revoke on the existing host detail. Do not expose secret hashes or grants. Update the skill reference for any added route.

Regression: pair → close modal → reload desktop → locate the same phone → revoke → native/grant/session and live socket all fail. This must not require knowing the enrollment ID or manually calling the API.

Evidence: searched all UI callers and inspected enrollment state/API key listing; no browser walkthrough was run.

## 7. P2 — Reject malformed explicit Authorization before cookie fallback

`packages/server/src/auth.ts:373–403`.

The implementation branches on a successfully parsed case-sensitive `Bearer` expression, rather than on header presence. Consequently malformed/unsupported Authorization silently falls through to a valid cookie. This violates the spec's explicit-credential precedence and hides broken credential plumbing.

Confirmed with a live cookie: `Authorization: Basic garbage`, `Authorization: Bearer`, and `Authorization: bearer garbage` all returned **200** from `/hosts`; only `Bearer garbage` returned **401**.

Check `headers.has('authorization')` first. If present, parse the supported scheme correctly and reject invalid credentials; only an absent header permits cookie auth. Include empty, malformed, unsupported, invalid, and valid mixed-case scheme tests.

## Additional bounded maintenance

`packages/server/src/mobile-store.ts:137–160`: rate-limit maps never remove untouched expired keys. Replacing a bucket when the same key is reused does not prune arbitrary historical enrollment IDs. Add bounded expiry eviction and fake-clock/cardinality coverage to satisfy the spec's expiring-entry requirement. This is lower urgency than the authority and enrollment fixes above.

## Verification performed

- Type check produced no diagnostics.
- Targeted auth/mobile/WS/SPA suite: **79 pass, 0 fail**.
- Strict skill drift: **passed** (137 API rows, 138 server routes, 70 CLI commands).
- Full suite: **1487 pass, 9 skip, 9 fail**. All failures were environment constraints: eight daemon-update tests expect the implementation checkout's fixture file to be writable, and one mount test attempts cleanup under the read-only home cache. These are not evidence of Android regressions. The implementation report's 1496-pass result was not fully reproducible under this review sandbox.
- Additional hermetic Elysia probes confirmed findings 2, 4, and 7. Temporary script: `/tmp/lama296-review-probes.ts`; full test log: `/tmp/lama296-review-tests.log`. Fixture credentials are generated for isolated local databases; no fleet access was used.
- No APK rebuild, instrumented rerun, live HTTPS onboarding, or production change in this pass. The implementation report's Android results remain author-provided evidence.

## Correction assignment and acceptance

Implement findings 1–7, address the bounded limiter cleanup, and add the corresponding regression coverage. Preserve the current architecture and phase-1 scope. Do not start uploads or optional features. Update the implementation report with actual results.

Before acceptance, run a complete local HTTPS vertical test: real desktop QR → native exchange → installed cookie → authenticated SPA and live events → app restart → logout/explicit reconnect → native disconnect with an existing cookie → desktop revoke after reload. Include bootstrap interruption and offline local cleanup. Use a disposable test fleet; do not deploy production. Keep unresolved emulator/TLS checks explicitly unverified.

Suggested coding-agent prompt: “Address docs/review-296-phase-1-android-foundation.md against the android-client implementation. Fix the listed auth and lifecycle defects with regression tests, remain within phase 1, and update the report for orchestrator re-review.”
