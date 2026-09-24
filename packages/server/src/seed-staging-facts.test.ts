// LAMA-346 correction — the target device's staging proof is normalized
// FAIL-CLOSED.
//
// A seed plan is only runnable when the target device has PROVEN that the
// staging sibling and the target share a parent directory (and therefore a
// filesystem, so publishing is one atomic rename). The server cannot stat the
// target's filesystem, so it must read the device's report exactly: anything
// missing, malformed, or merely truthy-but-not-`true` becomes `null`
// ("unproven"), never `true`.

import { describe, expect, test } from "bun:test";
import { normalizeFolderHealthFacts } from "./folder-health.ts";

/** The minimum blob the normalizer accepts, plus whatever is under test. */
function factsBlob(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    folderType: "sync",
    effectiveType: "sync",
    enabled: true,
    paused: false,
    runInProgress: false,
    rcloneAvailable: true,
    localDir: "ok",
    freeSpaceBytes: 1,
    freeSpaceThresholdBytes: 1,
    filter: { fingerprint: "fp", source: "lamasyncignore", changedSinceBaseline: false },
    baseline: { present: false, ready: false, error: false },
    pendingConflicts: 0,
    ...extra,
  };
}

describe("seedStaging normalization", () => {
  test("a device-reported true proof survives", () => {
    const facts = normalizeFolderHealthFacts(
      factsBlob({
        seedStaging: {
          targetPath: "/home/b/Projects",
          targetParent: "/home/b",
          stagingParent: "/home/b",
          sameFilesystem: true,
          device: 42,
          checkedAt: 1_700_000_000_000,
        },
      }),
    );
    expect(facts).not.toBeNull();
    expect(facts!.seedStaging).toEqual({
      targetPath: "/home/b/Projects",
      targetParent: "/home/b",
      stagingParent: "/home/b",
      sameFilesystem: true,
      device: 42,
      checkedAt: 1_700_000_000_000,
    });
  });

  test("an absent or malformed block is null or all-unproven, never a claimed proof", () => {
    expect(normalizeFolderHealthFacts(factsBlob())!.seedStaging).toBeNull();
    expect(normalizeFolderHealthFacts(factsBlob({ seedStaging: "yes" }))!.seedStaging).toBeNull();
    // An array is not a facts block: it normalizes to an all-unproven shape,
    // which is equally fail-closed.
    const fromArray = normalizeFolderHealthFacts(factsBlob({ seedStaging: [] }))!.seedStaging;
    expect(fromArray?.sameFilesystem).toBeNull();
    expect(fromArray?.targetParent).toBeNull();
    expect(fromArray?.stagingParent).toBeNull();
  });

  test("a truthy-but-not-true verdict is UNPROVEN, not proven", () => {
    for (const value of ["true", 1, {}, [], null, undefined]) {
      const facts = normalizeFolderHealthFacts(
        factsBlob({ seedStaging: { sameFilesystem: value, targetParent: "/home/b" } }),
      );
      expect(facts!.seedStaging!.sameFilesystem).toBeNull();
    }
    // An explicit false is preserved as false so the plan can say why.
    const denied = normalizeFolderHealthFacts(
      factsBlob({ seedStaging: { sameFilesystem: false, targetParent: "/home/b" } }),
    );
    expect(denied!.seedStaging!.sameFilesystem).toBeNull();
  });

  test("an unparsable device number is dropped rather than guessed", () => {
    const facts = normalizeFolderHealthFacts(
      factsBlob({ seedStaging: { sameFilesystem: true, device: "42", checkedAt: "now" } }),
    );
    expect(facts!.seedStaging!.device).toBeNull();
    expect(facts!.seedStaging!.checkedAt).toBe(0);
  });
});
