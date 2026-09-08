# LAMA-296 — review of R1/R2 touch-ups

Reviewed 2026-09-07 at `25404e0`, focusing on implementation commit
`5b67ccc` against `review-296-phase-1-corrections.md`, the implementation
report, and LAMA-296. The implementation was already committed locally and
the worktree was clean when this review started.

**Verdict: accepted after the follow-up below.** R1 and R2 are corrected,
including the stale-cleanup interaction found during this review.

## P2 — stale cleanup retry could erase a subsequent pending enrollment (fixed)

Sources: `android/app/src/main/java/app/lamasync/companion/ui/SessionViewModel.kt:208`
and `:528`; `android/app/src/main/java/app/lamasync/companion/data/CompanionRepository.kt:468`.

Reproduction through the real ViewModel on the API 35 emulator, with injected
transport, store, vault, and cookie adapters:

1. Disconnect from server A while its cookie adapter returns false. The
   welcome screen retains A's cleanup origin and offers **Retry cleanup**.
2. Let cookie removal recover. Choose **Scan enrollment QR code** and enroll
   with B. The repository successfully cleans A and clears its persisted
   cleanup marker before exchanging B's QR.
3. B's exchange succeeds and stores its credentials and EXCHANGED binding,
   but its identity request returns 503.
4. Choose **Change server**, then **Back** to return to welcome.
   `onScannerBack()` derives B's pending enrollment, but retains the stale
   `cleanupUnconfirmed` and `cleanupOrigins` from A. Both recovery actions
   are now visible.
5. Tap **Retry cleanup**. `retryCleanup()` trusts the stale UI state and
   `retryLocalCleanup(A)` unconditionally clears the current vault and
   registration store. B's new credentials and binding disappear, while
   the UI still offers B's **Resume enrollment** action.

This would destroy recoverable enrollment state after the one-time QR had
already been consumed. The user would need another QR and B's issued
registration could be left orphaned on the server.

Fixed in the working tree. Returning from B's failed enrollment now reloads
the persisted cleanup marker, so A's obsolete retry action disappears. The
repository also checks whether a confirmed old-cookie retry is now superseded
by a registration or binding at another origin; it clears only the old marker
and preserves B's vault and enrollment records. This makes the invariant hold
even if a stale UI action reaches the repository.

Regression coverage includes the full real-ViewModel sequence above on-device,
and a repository test that invokes the stale A cleanup retry directly after B
reaches `EXCHANGED`.

The initial temporary probe failed exactly at:
`old cleanup must preserve the new enrollment expected:<TOKEN_B> but was:<null>`.
Probe copy: `/tmp/lama296-review-test-with-probe.kt`; execution log:
`/tmp/lama296-final-review-instrumented.log`. The temporary source modification
was removed after the probe; no implementation or existing test edits remain.

## Verification

- `assembleDebug` and `lintDebug`: passed using JDK 17 (Gradle reused existing
  task outputs). Android Studio's bundled JDK 25 was incompatible with this
  build; using the documented JDK 17 resolved the invocation failure.
- `testDebugUnitTest --rerun-tasks`: 62 passed, no failures or skips.
- `connectedDebugAndroidTest`: 25 tests total, 21 passed and four HTTPS
  vertical tests skipped cleanly; zero failures.
- No live HTTPS harness, camera scanning, or desktop UI interaction was
  exercised in this review. No TypeScript/server changes were part of the
  R1/R2 implementation commit, so their prior review gates were not repeated.

No commit, push, production action, or Multica write was performed.
