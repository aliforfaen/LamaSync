# LAMA-296 phase 1 — correction review

Reviewed 2026-09-07 against `e3845c3` on `aliforfaen/android-client`, in `/home/messhias/orca/workspaces/lamasync/android-client`.

**Verdict: substantial corrections accepted; two remaining P2 lifecycle issues before final phase-1 acceptance.** Keep the implementation and finish the narrow cases below. No uploads or other scope expansion is needed.

## Accepted corrections

- Origin/enrollment binding prevents the previously identified different-QR credential disclosure. Both the ViewModel and repository use the binding for normal retry.
- Disconnect now sends the fresh bootstrap's own cookie and CSRF token together.
- Cookie deletion includes Secure and the required host-only attributes; installation/removal await callback and verify the resulting cookie state.
- Non-admin grants cannot issue web sessions; existing non-admin sessions are denied fleet routes centrally.
- Bootstrap interruption within the running ViewModel resumes using stored credentials without exchanging the consumed QR again.
- The persistent Android-devices panel and admin-only registration projection support later revocation without the original modal or QR.
- Explicit Authorization headers are parsed before considering cookies, and malformed credentials fail closed.
- Rate-limit storage now has expiry sweeps and a cardinality cap.

The added tests and reported disposable HTTPS integration run materially improve confidence. The report correctly distinguishes endpoint/scanner-seam testing from actual camera capture and desktop pointer interaction.

## R1 — P2: Offer persisted enrollment recovery after restarting before identity completes

Source: `android/app/src/main/java/app/lamasync/companion/ui/SessionViewModel.kt:94–114`.

Reproduction from the current state machine:

1. Exchange succeeds and saves credentials plus an `EXCHANGED` binding.
2. `/mobile/me` fails or the app is terminated before registration is saved.
3. Construct a fresh ViewModel and call `initialize()` over those persisted stores.
4. Initialization examines only `snapshot.registration`, ignores `snapshot.pendingBinding`, and selects WELCOME. There is no candidate and no resume action. The welcome action leads to scanning another QR.

The repository can recover this state, but the app never exposes that path after restart. The original enrollment is already consumed; the desktop no longer needs to retain its QR. Requiring the same QR to be scanned again defeats persisted recovery.

Fix: initialize a visible pending-enrollment recovery state from the stored binding when its credentials are usable. Let the user explicitly resume at that bound origin without a QR secret or a new exchange. Preserve the bound display name. Keep web logout behavior intact: do not automatically re-bootstrap a completed enrollment merely because its cookie is absent. Introduce an explicit completed state or equivalent distinction if needed.

Regression: seed EXCHANGED binding and usable credentials with no registration, create a fresh real ViewModel, initialize, trigger its visible resume action, and reach MANAGE. Assert no scanner input, zero new exchange requests, and credentials sent only to the stored origin. Also test missing credentials and completed enrollment after explicit web logout.

Evidence: direct inspection of startup and retry paths. Current instrumented ViewModel tests cover retry in the existing ViewModel and scanning a different origin; they do not exercise this pending-state startup path. A restart of an already completed registration does not cover it either.

## R2 — P2: Propagate cleanup failure through disconnect and re-pairing

Sources: `android/app/src/main/java/app/lamasync/companion/ui/SessionViewModel.kt` (`disconnect`, around line 340); `data/CompanionRepository.kt:391–406` (`clearLocalAuth`).

The repository now reports `DisconnectResult.localCleared = false` when cookie removal or another cleanup step fails. However, the ViewModel never reads that field. With remote failure it still displays “Local data cleared”; it also drops the connection identity and transitions to WELCOME in every case. The lower-level honesty correction therefore does not reach the user.

The re-pair path has the related gap: `clearLocalAuth()` discards the Boolean returned by `clearSessionCookie`, catches exceptions, and proceeds with the new exchange. Its comment assumes the new cookie replaces the old one, which is false when switching to a different origin. A failed deletion can leave the prior origin's cookie behind while its cleanup metadata is discarded.

Fix: render local and remote outcomes independently. Retain sufficient non-secret state to retry unconfirmed cleanup, and do not claim successful local disconnection when it is unknown. Make re-pair cleanup return an outcome and prevent silently activating the new pairing while old local auth remains unconfirmed. The UI should explain the failure and offer a concrete retry/recovery action.

Regression: force the cookie adapter to return false and separately throw; verify real ViewModel messaging and recovery for remote success/failure. For re-pair A → B, failed cleanup must not silently proceed to B and lose A's cleanup state. Verify the successful path still works. The existing repository test asserting `localCleared == false` is useful but does not test its consumer.

Evidence: direct inspection of both consumers of the new cookie-cleanup result. No emulator failure injection was run during this review.

## Verification in this review

- `bun x tsc --noEmit`: passed.
- Server auth/mobile/WS plus complete web-ui tests: **291 pass, 0 fail**, across 26 files.
- Strict skill drift: passed (138 API rows, 139 server routes, 70 CLI commands).
- Repeated hermetic probes: non-admin bootstrap rejected; manually seeded non-admin sessions receive 403 on `/hosts` and `/folders`; Basic/bare-Bearer/lowercase invalid Bearer headers receive 401 even with a valid cookie; matching fresh cookie/CSRF revokes successfully.
- Test log: `/tmp/lama296-correction-tests.log`; probe script: `/tmp/lama296-correction-probes.ts`. Isolated SQLite fixtures only; no production access.
- Android build, unit/instrumented suites, and HTTPS integration results were assessed from code and the author's report, not independently rerun here. Camera scanning, actual desktop clicks, and SPA event-row rendering remain outside the reported vertical test.

Implementation checkout remained unchanged. This review is saved in the original planning checkout.

Suggested correction prompt: “Address R1 and R2 in docs/review-296-phase-1-corrections.md. Add real ViewModel regression coverage for pending-enrollment startup and cleanup-failure UI/re-pair handling. Preserve phase-1 scope and explicit web-logout behavior, update the report, and return for final review.”
