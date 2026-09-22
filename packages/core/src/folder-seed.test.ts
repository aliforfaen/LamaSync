// LAMA-346: seed-contract tests. Pure — no filesystem, no timers, no rclone.
//
// The behaviours pinned here are the ones the issue calls out explicitly:
// the recommendation is never automatic, the space calculation fails closed
// when the target free space is unknown, staging is refused inside the final
// target or on a different filesystem, archive members are validated
// fail-closed, the phase machine only moves forward, and the seed deadline
// continues past the old wall-clock timeout while progress keeps coming but
// fails on a stall.

import { describe, expect, test } from "bun:test";
import {
  SEED_ARCHIVE_RATIO_DEFAULT,
  SEED_ARCHIVE_TRANSPORT_IMPLEMENTED,
  SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED,
  SEED_JOB_PHASE_COUNT,
  SEED_JOB_PHASES,
  SEED_RECOMMENDATION_FILE_THRESHOLD,
  SEED_SOURCE_MEASUREMENT_MAX_AGE_MS,
  SEED_SPACE_FIXED_OVERHEAD_BYTES,
  SEED_SPACE_SAFETY_FACTOR,
  SEED_STALL_TIMEOUT_FALLBACK_SEC,
  SEED_STAGE_HARD_CAP_MS,
  canTransitionSeedPhase,
  checkSeedPlanValidity,
  computeSeedSpacePlan,
  formatSeedBytes,
  isSafeArchiveMember,
  isSeedLeaseExpired,
  isTerminalSeedPhase,
  parentPathOf,
  parseSeedJobCreatePayload,
  parseSeedPlanRequestPayload,
  parseSeedProgressPayload,
  recommendSeed,
  seedArchiveExtension,
  seedArchiveObjectKey,
  seedArchiveToolingReady,
  seedPhaseIndex,
  seedPlanExecution,
  seedPlanPrerequisites,
  seedProgressFraction,
  seedStagingPath,
  selectSeedArchiveFormat,
  shouldExtendSeedDeadline,
  startSeedProgress,
  validateArchiveMembers,
  validateStagingLocation,
  type SeedPlan,
} from "./folder-seed.ts";

describe("recommendSeed — recommended, never automatic", () => {
  test("recommends above the file threshold and names the numbers", () => {
    const verdict = recommendSeed({ fileCount: 91_660, totalBytes: 14_864_173_809 });
    expect(verdict.recommended).toBe(true);
    expect(verdict.thresholdFiles).toBe(SEED_RECOMMENDATION_FILE_THRESHOLD);
    expect(verdict.reason).toContain("91,660");
    expect(verdict.reason).toContain("13.84 GiB");
    expect(verdict.reason).toContain("Nothing happens until you review and approve a plan");
  });

  test("does not recommend at or below the threshold", () => {
    expect(recommendSeed({ fileCount: 850, totalBytes: 17_715_220 }).recommended).toBe(false);
    expect(
      recommendSeed({ fileCount: SEED_RECOMMENDATION_FILE_THRESHOLD - 1, totalBytes: 1 }).recommended,
    ).toBe(false);
    expect(
      recommendSeed({ fileCount: SEED_RECOMMENDATION_FILE_THRESHOLD, totalBytes: 1 }).recommended,
    ).toBe(true);
  });

  test("a plan request always requires explicit confirmation and a named source", () => {
    expect(parseSeedPlanRequestPayload({ folderId: "f", hostId: "h" }).ok).toBe(false);
    expect(parseSeedPlanRequestPayload({ folderId: "f", hostId: "h", confirm: false }).ok).toBe(false);
    expect(
      parseSeedPlanRequestPayload({ folderId: "f", hostId: "h", sourceHostId: "s", confirm: true }).ok,
    ).toBe(true);
    // No free-form field can ride along.
    expect(
      parseSeedPlanRequestPayload({
        folderId: "f",
        hostId: "h",
        sourceHostId: "s",
        confirm: true,
        rcloneArgs: ["--x"],
      }).ok,
    ).toBe(false);
  });
});

describe("archive format selection and tooling", () => {
  test("prefers tar.zstd and falls back to tar.gz with a reason", () => {
    const preferred = selectSeedArchiveFormat({ tar: true, zstd: true, gzip: true });
    expect(preferred.format).toBe("tar.zstd");
    expect(preferred.fallback).toBe(false);

    const fallback = selectSeedArchiveFormat({ tar: true, zstd: false, gzip: true });
    expect(fallback.format).toBe("tar.gz");
    expect(fallback.fallback).toBe(true);
    expect(fallback.reason).toContain("zstd is not installed");
  });

  test("tooling readiness is the gate, not the format choice", () => {
    expect(seedArchiveToolingReady("tar.zstd", { tar: true, zstd: true, gzip: false })).toBe(true);
    expect(seedArchiveToolingReady("tar.zstd", { tar: true, zstd: false, gzip: true })).toBe(false);
    expect(seedArchiveToolingReady("tar.gz", { tar: true, zstd: false, gzip: true })).toBe(true);
    expect(seedArchiveToolingReady("tar.gz", { tar: true, zstd: true, gzip: false })).toBe(false);
    expect(seedArchiveToolingReady("tar.gz", { tar: false, zstd: true, gzip: true })).toBe(false);
  });

  test("extensions and the dedicated seed object namespace", () => {
    expect(seedArchiveExtension("tar.zstd")).toBe(".tar.zst");
    expect(seedArchiveExtension("tar.gz")).toBe(".tar.gz");
    const key = seedArchiveObjectKey("job-1", "tar.zstd");
    expect(key).toBe("lamasync/seed/job-1/payload.tar.zst");
    // Never the managed-folder namespace.
    expect(key.startsWith("lamasync/seed/")).toBe(true);
  });
});

describe("archive member safety — fail closed", () => {
  test("accepts ordinary relative paths", () => {
    for (const member of ["a.txt", "dir/", "dir/a.txt", "./a.txt", "a/b/c/d.bin", "weird name.txt"]) {
      expect(isSafeArchiveMember(member)).toBe(true);
    }
  });

  test("rejects absolute, traversal, drive, backslash, NUL and control members", () => {
    for (const member of [
      "/etc/passwd",
      "\\windows\\system32",
      "../escape.txt",
      "dir/../../escape.txt",
      "C:/windows",
      "c:\\windows",
      "a\u0000b",
      "line\nbreak",
      "tab\tname",
      "",
    ]) {
      expect(isSafeArchiveMember(member)).toBe(false);
    }
  });

  test("one unsafe member rejects the whole archive and is reported", () => {
    const verdict = validateArchiveMembers(["ok/a.txt", "../escape", "ok/b.txt"]);
    expect(verdict.ok).toBe(false);
    expect(verdict.count).toBe(3);
    expect(verdict.offenders).toEqual(["../escape"]);
    expect(verdict.message).toContain("refusing to extract");
  });

  test("an all-safe list passes", () => {
    const verdict = validateArchiveMembers(["a", "b/c", "d/"]);
    expect(verdict.ok).toBe(true);
    expect(verdict.offenders).toEqual([]);
  });
});

describe("space calculation", () => {
  test("reserves archive + extracted tree with safety factor and overhead", () => {
    const plan = computeSeedSpacePlan({
      sourceBytes: 14_864_173_809,
      sourceFiles: 91_660,
      targetFreeBytes: 100_000_000_000,
    });
    expect(plan.archiveBytesEstimate).toBe(14_864_173_809);
    expect(plan.extractedBytes).toBe(14_864_173_809);
    expect(plan.peakBytes).toBe(2 * 14_864_173_809);
    expect(plan.requiredFreeBytes).toBe(
      Math.ceil(2 * 14_864_173_809 * SEED_SPACE_SAFETY_FACTOR) + SEED_SPACE_FIXED_OVERHEAD_BYTES,
    );
    expect(plan.ok).toBe(true);
    expect(plan.shortfallBytes).toBe(0);
  });

  test("fails closed when the target free space is unknown", () => {
    const plan = computeSeedSpacePlan({ sourceBytes: 1_000, sourceFiles: 2, targetFreeBytes: null });
    expect(plan.ok).toBe(false);
    expect(plan.targetFreeBytes).toBeNull();
    expect(plan.message).toContain("not known yet");
  });

  test("reports the exact shortfall when the target cannot hold the seed", () => {
    const plan = computeSeedSpacePlan({ sourceBytes: 1_000_000, sourceFiles: 10, targetFreeBytes: 1 });
    expect(plan.ok).toBe(false);
    expect(plan.shortfallBytes).toBe(plan.requiredFreeBytes - 1);
    expect(plan.message).toContain("short");
  });

  test("a measured archive ratio replaces the conservative default", () => {
    const conservative = computeSeedSpacePlan({ sourceBytes: 1_000_000, sourceFiles: 1, targetFreeBytes: 0 });
    const measured = computeSeedSpacePlan({
      sourceBytes: 1_000_000,
      sourceFiles: 1,
      targetFreeBytes: 0,
      archiveRatio: 0.4,
    });
    expect(conservative.archiveBytesEstimate).toBe(1_000_000);
    expect(measured.archiveBytesEstimate).toBe(400_000);
    expect(measured.requiredFreeBytes).toBeLessThan(conservative.requiredFreeBytes);
    expect(SEED_ARCHIVE_RATIO_DEFAULT).toBe(1);
  });
});

describe("staging policy", () => {
  test("refuses staging inside the final target", () => {
    const verdict = validateStagingLocation({
      stagingPath: "/data/projects/.lamasync-seed-staging-x",
      targetPath: "/data/projects",
      sameFilesystemProven: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.insideTarget).toBe(true);
    expect(verdict.message).toContain("inside the final target");
  });

  test("refuses /data/elsewhere for a /data/projects target", () => {
    // Same device, outside the target, and even in the same parent — but it is
    // not a directory this feature created, and publishing renames the staging
    // directory OVER the target.
    const verdict = validateStagingLocation({
      stagingPath: "/data/elsewhere",
      targetPath: "/data/projects",
      sameFilesystemProven: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.insideTarget).toBe(false);
    expect(verdict.derivedSibling).toBe(false);
    expect(verdict.message).toContain("not a seed staging directory");
  });

  test("refuses staging whose direct parent is not the target's parent", () => {
    const verdict = validateStagingLocation({
      stagingPath: "/data/elsewhere/.lamasync-seed-staging-projects-job1",
      targetPath: "/data/projects",
      sameFilesystemProven: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.adjacentToTarget).toBe(false);
    expect(verdict.derivedSibling).toBe(true);
    expect(verdict.message).toContain("not a sibling of the target");
    expect(verdict.message).toContain("/data");
  });

  test("refuses staging on a different filesystem", () => {
    const verdict = validateStagingLocation({
      stagingPath: "/tmp/.lamasync-seed-staging-x",
      targetPath: "/data/projects",
      sameFilesystemProven: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.insideTarget).toBe(false);
    expect(verdict.sameFilesystem).toBe(false);
  });

  test("FAILS CLOSED when the same-filesystem fact is unknown", () => {
    const verdict = validateStagingLocation({
      stagingPath: "/data/.lamasync-seed-staging-projects-job1",
      targetPath: "/data/projects",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.adjacentToTarget).toBe(true);
    expect(verdict.derivedSibling).toBe(true);
    expect(verdict.sameFilesystem).toBeNull();
    expect(verdict.message).toContain("has not confirmed");
  });

  test("accepts a derived sibling with a proven same filesystem", () => {
    const verdict = validateStagingLocation({
      stagingPath: "/data/.lamasync-seed-staging-projects-job1",
      targetPath: "/data/projects",
      sameFilesystemProven: true,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.adjacentToTarget).toBe(true);
    expect(verdict.derivedSibling).toBe(true);
    expect(verdict.sameFilesystem).toBe(true);
  });

  test("derives a sibling staging path from the target, never a child", () => {
    const staging = seedStagingPath("/data/projects", "job-1");
    expect(staging).toBe("/data/.lamasync-seed-staging-projects-job-1");
    expect(parentPathOf(staging!)).toBe(parentPathOf("/data/projects"));
    expect(staging!.startsWith("/data/projects/")).toBe(false);
    expect(seedStagingPath("relative/path", "j")).toBeNull();
  });
});

describe("phase state machine", () => {
  test("only moves forward by one, or to a terminal phase", () => {
    expect(canTransitionSeedPhase("preflight", "measuring_source")).toBe(true);
    expect(canTransitionSeedPhase("preflight", "archiving_source")).toBe(false);
    expect(canTransitionSeedPhase("archiving_source", "uploading_archive")).toBe(true);
    expect(canTransitionSeedPhase("uploading_archive", "archiving_source")).toBe(false);
    expect(canTransitionSeedPhase("publishing", "baseline_validation")).toBe(true);
    expect(canTransitionSeedPhase("baseline_validation", "completed")).toBe(true);
    // A resumable retry of the same phase is allowed.
    expect(canTransitionSeedPhase("extracting_target", "extracting_target")).toBe(true);
    // Terminal phases never transition.
    expect(canTransitionSeedPhase("completed", "failed")).toBe(false);
    expect(canTransitionSeedPhase("failed", "preflight")).toBe(false);
  });

  test("phase indices and terminal detection", () => {
    expect(SEED_JOB_PHASE_COUNT).toBe(SEED_JOB_PHASES.length);
    expect(seedPhaseIndex("preflight")).toBe(0);
    expect(seedPhaseIndex("baseline_validation")).toBe(SEED_JOB_PHASE_COUNT - 1);
    expect(isTerminalSeedPhase("completed")).toBe(true);
    expect(isTerminalSeedPhase("failed")).toBe(true);
    expect(isTerminalSeedPhase("cancelled")).toBe(true);
    expect(isTerminalSeedPhase("publishing")).toBe(false);
  });
});

describe("progress", () => {
  test("fraction is honest: a number only when a total is known", () => {
    const noTotal = startSeedProgress("archiving_source", 0, "archiving");
    expect(seedProgressFraction(noTotal)).toBeNull();
    const withBytes = { ...noTotal, bytesDone: 25, bytesTotal: 100 };
    expect(seedProgressFraction(withBytes)).toBe(0.25);
    const withEntries = { ...noTotal, entriesDone: 1, entriesTotal: 4 };
    expect(seedProgressFraction(withEntries)).toBe(0.25);
    // Bytes take precedence and are clamped.
    const clamped = { ...noTotal, bytesDone: 200, bytesTotal: 100, entriesDone: 1, entriesTotal: 4 };
    expect(seedProgressFraction(clamped)).toBe(1);
  });

  test("a fresh progress record carries the phase index and count", () => {
    const progress = startSeedProgress("uploading_archive", 1234, "uploading", {
      bytesTotal: 500,
      entriesTotal: 10,
    });
    expect(progress.phaseIndex).toBe(seedPhaseIndex("uploading_archive"));
    expect(progress.phaseCount).toBe(SEED_JOB_PHASE_COUNT);
    expect(progress.updatedAt).toBe(1234);
    expect(progress.bytesTotal).toBe(500);
  });
});

describe("progress-aware deadline — the timeout fix", () => {
  const start = 1_000_000;

  test("continues past the old 600 s wall-clock timeout while progress keeps coming", () => {
    // 40 minutes elapsed, but progress 5 s ago: the old fixed timeout would
    // have killed this at 10 minutes. This is exactly the dev-vm case.
    const verdict = shouldExtendSeedDeadline({
      startedAt: start,
      lastProgressAt: start + 40 * 60_000 - 5_000,
      now: start + 40 * 60_000,
    });
    expect(verdict.action).toBe("continue");
    expect(verdict.reason).toBe("progressing");
    expect(verdict.elapsedMs).toBe(40 * 60_000);
    expect(verdict.stallMs).toBe(SEED_STALL_TIMEOUT_FALLBACK_SEC * 1000);
  });

  test("fails when no measurable progress arrives within the stall budget", () => {
    const verdict = shouldExtendSeedDeadline({
      startedAt: start,
      lastProgressAt: start,
      now: start + SEED_STALL_TIMEOUT_FALLBACK_SEC * 1000,
    });
    expect(verdict.action).toBe("fail");
    expect(verdict.reason).toBe("stalled");
    expect(verdict.sinceProgressMs).toBe(SEED_STALL_TIMEOUT_FALLBACK_SEC * 1000);
  });

  test("fails at the absolute hard cap even while progress continues", () => {
    const verdict = shouldExtendSeedDeadline({
      startedAt: start,
      lastProgressAt: start + SEED_STAGE_HARD_CAP_MS,
      now: start + SEED_STAGE_HARD_CAP_MS,
    });
    expect(verdict.action).toBe("fail");
    expect(verdict.reason).toBe("hard_cap");
  });

  test("the stall budget is the assignment timeout, not a new limit", () => {
    const verdict = shouldExtendSeedDeadline({
      startedAt: start,
      lastProgressAt: start,
      now: start + 900_000,
      stallMs: 1_800_000,
    });
    expect(verdict.action).toBe("continue");
    expect(verdict.stallMs).toBe(1_800_000);
  });
});

describe("job/plan wire grammar", () => {
  test("a seed-plan request names the source authority explicitly", () => {
    const ok = parseSeedPlanRequestPayload({
      folderId: "f",
      hostId: "dev-vm",
      sourceHostId: "master",
      confirm: true,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.payload.sourceHostId).toBe("master");
    // Required, never inferred.
    expect(parseSeedPlanRequestPayload({ folderId: "f", hostId: "dev-vm", confirm: true }).ok).toBe(false);
    expect(
      parseSeedPlanRequestPayload({ folderId: "f", hostId: "dev-vm", sourceHostId: "", confirm: true }).ok,
    ).toBe(false);
    // A device cannot seed itself.
    expect(
      parseSeedPlanRequestPayload({ folderId: "f", hostId: "h", sourceHostId: "h", confirm: true }).ok,
    ).toBe(false);
    // Still operator-approved.
    expect(
      parseSeedPlanRequestPayload({ folderId: "f", hostId: "h", sourceHostId: "s" }).ok,
    ).toBe(false);
  });

  test("the source measurement freshness budget is one deep-measurement cadence plus slack", () => {
    expect(SEED_SOURCE_MEASUREMENT_MAX_AGE_MS).toBeGreaterThan(24 * 60 * 60_000);
    expect(SEED_SOURCE_MEASUREMENT_MAX_AGE_MS).toBeLessThan(48 * 60 * 60_000);
  });

  test("job creation requires a plan and an explicit confirmation", () => {
    expect(parseSeedJobCreatePayload({ planId: "p" }).ok).toBe(false);
    expect(parseSeedJobCreatePayload({ planId: "p", confirm: true }).ok).toBe(true);
    expect(parseSeedJobCreatePayload({ confirm: true }).ok).toBe(false);
    expect(parseSeedJobCreatePayload({ planId: "p", confirm: true, extra: 1 }).ok).toBe(false);
  });

  test("progress reports are bounded and reject unknown fields", () => {
    const ok = parseSeedProgressPayload({
      phase: "extracting_target",
      message: "extracting",
      bytesDone: 10,
      bytesTotal: 100,
      entriesDone: 1,
      entriesTotal: 5,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.payload.phase).toBe("extracting_target");
      expect(ok.payload.bytesDone).toBe(10);
    }
    expect(parseSeedProgressPayload({ phase: "completed" }).ok).toBe(false);
    expect(parseSeedProgressPayload({ phase: "preflight", rclone: "--x" }).ok).toBe(false);
    expect(parseSeedProgressPayload({ phase: "preflight", bytesDone: -1 }).ok).toBe(true);
  });

  test("lease expiry is explicit", () => {
    expect(isSeedLeaseExpired({ leaseExpiresAt: null }, 1_000)).toBe(true);
    expect(isSeedLeaseExpired({ leaseExpiresAt: 1_001 }, 1_000)).toBe(false);
    expect(isSeedLeaseExpired({ leaseExpiresAt: 1_000 }, 1_000)).toBe(true);
  });
});

describe("plan validity", () => {
  function basePlan(): Pick<
    SeedPlan,
    | "expiresAt"
    | "configRevision"
    | "filterFingerprint"
    | "baselineFingerprint"
    | "space"
    | "archive"
    | "stagingPolicy"
    | "sourceAuthority"
    | "filterUniverse"
  > {
    return {
      expiresAt: 2_000,
      configRevision: 3,
      filterFingerprint: "abc",
      baselineFingerprint: "base",
      space: computeSeedSpacePlan({ sourceBytes: 1_000, sourceFiles: 5, targetFreeBytes: 100_000_000_000 }),
      archive: {
        format: "tar.zstd",
        tooling: { tar: true, zstd: true, gzip: true },
        toolingReady: true,
        estimateBytes: 1_000,
        choiceReason: "zstd",
        fallback: false,
      },
      stagingPolicy: {
        adjacentToTarget: true,
        derivedSibling: true,
        insideTarget: false,
        sameFilesystem: true,
        message: "sibling",
      },
      sourceAuthority: {
        hostId: "master",
        assignmentId: "a-source",
        selectedBy: "operator",
        assigned: true,
        isTarget: false,
        measurementUsable: true,
        measurementAgeMs: 60_000,
        fileCount: 91_660,
        totalBytes: 14_864_173_809,
        measuredAt: 1_000,
        message: "Source authority: master.",
      },
      filterUniverse: {
        fingerprint: "universe",
        targetFingerprint: null,
        match: true,
        patternCount: 2,
        // Stage 1 has not wired filter-aware archiving yet, so a REAL plan is
        // not runnable. This fixture sets it true so the OTHER checks can be
        // exercised independently.
        archiveImplemented: true,
        message: "universe",
      },
    };
  }
  const live = { now: 1_000, configRevision: 3, filterFingerprint: "abc", baselineFingerprint: "base" };

  test("a fully-consistent plan is still not runnable while execution is unavailable", () => {
    // Stage 1a is implemented, so every FACT on this plan is fine...
    expect(SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED).toBe(true);
    const validity = checkSeedPlanValidity(basePlan(), live);
    // ...but the transport is not, and a plan that cannot run is never
    // reported as runnable.
    expect(validity.valid).toBe(false);
    expect(validity.reason).toBe("not_runnable");
    expect(validity.message).toContain("temporary seed space");
    expect(validity.message).not.toBe("Seed plan is current and runnable.");
  });

  test("dies on expiry, config, filter and baseline changes", () => {
    expect(checkSeedPlanValidity(basePlan(), { ...live, now: 2_000 }).reason).toBe("expired");
    expect(checkSeedPlanValidity(basePlan(), { ...live, configRevision: 4 }).reason).toBe("config_changed");
    expect(checkSeedPlanValidity(basePlan(), { ...live, filterFingerprint: "zzz" }).reason).toBe("filter_changed");
    expect(checkSeedPlanValidity(basePlan(), { ...live, baselineFingerprint: "zzz" }).reason).toBe("baseline_changed");
  });

  test("dies when the source authority is not usable", () => {
    const plan = basePlan();
    plan.sourceAuthority = {
      ...plan.sourceAuthority,
      measurementUsable: false,
      message: "The measurement from master is 40 hours old.",
    };
    const validity = checkSeedPlanValidity(plan, live);
    expect(validity.valid).toBe(false);
    expect(validity.reason).toBe("not_runnable");
    expect(validity.message).toContain("40 hours old");
  });

  test("dies when a plan still reports unwired filter-aware archiving, and on a filter mismatch", () => {
    // A plan built while Stage 1a was unwired keeps failing closed.
    const unwired = basePlan();
    unwired.filterUniverse = { ...unwired.filterUniverse, archiveImplemented: false, message: "Stage 1." };
    expect(checkSeedPlanValidity(unwired, live).reason).toBe("not_runnable");
    expect(checkSeedPlanValidity(unwired, live).message).toBe("Stage 1.");

    const mismatched = basePlan();
    mismatched.filterUniverse = {
      ...mismatched.filterUniverse,
      match: false,
      targetFingerprint: "different",
      message: "The target device's baseline used a different filter set.",
    };
    expect(checkSeedPlanValidity(mismatched, live).reason).toBe("not_runnable");
  });

  test("dies when the plan is not runnable", () => {
    const noTooling = basePlan();
    noTooling.archive = { ...noTooling.archive, toolingReady: false };
    expect(checkSeedPlanValidity(noTooling, live).reason).toBe("not_runnable");

    const noSpace = basePlan();
    noSpace.space = computeSeedSpacePlan({ sourceBytes: 1_000_000, sourceFiles: 5, targetFreeBytes: 1 });
    expect(checkSeedPlanValidity(noSpace, live).reason).toBe("not_runnable");

    const insideTarget = basePlan();
    insideTarget.stagingPolicy = {
      adjacentToTarget: true,
      derivedSibling: true,
      insideTarget: true,
      sameFilesystem: true,
      message: "inside",
    };
    expect(checkSeedPlanValidity(insideTarget, live).reason).toBe("not_runnable");

    const notSibling = basePlan();
    notSibling.stagingPolicy = {
      adjacentToTarget: false,
      derivedSibling: true,
      insideTarget: false,
      sameFilesystem: true,
      message: "not a sibling",
    };
    expect(checkSeedPlanValidity(notSibling, live).reason).toBe("not_runnable");

    // The correction: an UNKNOWN same-filesystem verdict is refused.
    const unknownFilesystem = basePlan();
    unknownFilesystem.stagingPolicy = {
      adjacentToTarget: true,
      derivedSibling: true,
      insideTarget: false,
      sameFilesystem: null,
      message: "has not confirmed",
    };
    const validity = checkSeedPlanValidity(unknownFilesystem, live);
    expect(validity.valid).toBe(false);
    expect(validity.reason).toBe("not_runnable");
    expect(validity.message).toBe("has not confirmed");
  });
});

describe("seed prerequisites are listed, not collapsed into a boolean", () => {
  test("names every prerequisite, including the one open Stage 1 gate", () => {
    const execution = seedPlanExecution();
    const prerequisites = seedPlanPrerequisites({
      sourceAuthority: {
        hostId: "master",
        assignmentId: "a",
        selectedBy: "operator",
        assigned: true,
        isTarget: false,
        measurementUsable: true,
        measurementAgeMs: 1_000,
        fileCount: 10,
        totalBytes: 100,
        measuredAt: 0,
        message: "ok",
      },
      filterUniverse: {
        fingerprint: null,
        targetFingerprint: null,
        match: true,
        patternCount: 0,
        archiveImplemented: SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED,
        message: "the archive is built from the source device's effective filter universe",
      },
      stagingPolicy: {
        adjacentToTarget: true,
        derivedSibling: true,
        insideTarget: false,
        sameFilesystem: true,
        message: "sibling",
      },
      archive: {
        format: "tar.zstd",
        tooling: { tar: true, zstd: true, gzip: true },
        toolingReady: true,
        estimateBytes: 1,
        choiceReason: "zstd",
        fallback: false,
      },
      space: computeSeedSpacePlan({ sourceBytes: 100, sourceFiles: 1, targetFreeBytes: 1_000_000_000 }),
    });
    expect(prerequisites.map((p) => p.id)).toEqual([
      "source_authority",
      "filter_universe",
      "staging_same_filesystem",
      "target_tooling",
      "target_space",
      "transport",
    ]);
    // Filter-aware archiving is implemented (Stage 1a), so the only open gate
    // on this fully-specified plan is the transport.
    expect(prerequisites.find((p) => p.id === "filter_universe")!.ok).toBe(true);
    expect(prerequisites.find((p) => p.id === "transport")!.ok).toBe(false);
    expect(prerequisites.find((p) => p.id === "staging_same_filesystem")!.ok).toBe(true);
    expect(execution.available).toBe(false);
  });
});

describe("execution capability is explicit, not a fake button", () => {
  test("execution stays unavailable while the transport is unimplemented", () => {
    const execution = seedPlanExecution();
    expect(SEED_ARCHIVE_TRANSPORT_IMPLEMENTED).toBe(false);
    // Stage 1a is done, and doing it must NOT have enabled execution.
    expect(SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED).toBe(true);
    expect(execution.available).toBe(false);
    expect(execution.reason).toContain("not available yet");
    expect(execution.reason).toContain("one Stage 1 prerequisite is still open");
    expect(execution.reason).toContain("temporary seed space");
    expect(execution.reason).toContain("no live archive transfer is claimed");
    // The timeout change is stated precisely: an existing baseline is NOT
    // silently re-scoped.
    expect(execution.reason).toContain("existing baseline keeps its exact fixed timeout");
    expect(execution.reason).toContain("first run with no usable baseline");
  });
});

describe("formatSeedBytes", () => {
  test("uses binary units and never invents precision", () => {
    expect(formatSeedBytes(0)).toBe("0 B");
    expect(formatSeedBytes(1024)).toBe("1.0 KiB");
    expect(formatSeedBytes(17_715_220)).toBe("16.9 MiB");
    expect(formatSeedBytes(14_864_173_809)).toBe("13.84 GiB");
    expect(formatSeedBytes(Number.NaN)).toBe("unknown");
  });
});
