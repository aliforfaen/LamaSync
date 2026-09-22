// LAMA-346 — Folders page seed presentation helpers. Pure; no DOM.

import { describe, expect, test } from "bun:test";
import type { FolderHealthFacts, FolderHealthRecord } from "@lamasync/core/folder-health";
import type { SeedJob, SeedPlan } from "@lamasync/core/folder-seed";
import {
  SEED_GLOSSARY,
  seedArchiveSentence,
  seedJobTone,
  seedPhaseLabel,
  seedProgressPercent,
  seedProgressSentence,
  seedRecommendationSentence,
  seedRecommended,
  seedRunnableVerdict,
  seedSpaceSentence,
  seedSpaceTone,
  seedUnavailableHelp,
  shouldOfferSeed,
} from "./folder-seed.ts";

function facts(overrides: Partial<FolderHealthFacts> = {}): FolderHealthFacts {
  return {
    folderType: "sync",
    effectiveType: "sync",
    enabled: true,
    paused: false,
    runInProgress: false,
    rcloneAvailable: true,
    localDir: "ok",
    freeSpaceBytes: 10_000_000_000,
    freeSpaceThresholdBytes: 1_000_000_000,
    watcher: null,
    filter: { fingerprint: null, source: "none", changedSinceBaseline: false },
    baseline: {
      present: false,
      ready: false,
      error: false,
      path1Count: null,
      path2Count: null,
      updatedAt: null,
      fingerprint: "none",
    },
    activePhase: null,
    pendingConflicts: 0,
    lastRun: null,
    measurement: null,
    ...overrides,
  };
}

function record(overrides: Partial<FolderHealthRecord> = {}): FolderHealthRecord {
  return {
    assignmentId: "a2",
    folderId: "f1",
    hostId: "dev-vm",
    state: "new_host",
    reasons: [],
    facts: facts(),
    reportedAt: Date.now(),
    stale: false,
    stalenessMs: 0,
    measurementAgeMs: null,
    active: false,
    ...overrides,
  };
}

function plan(overrides: Partial<SeedPlan> = {}): SeedPlan {
  return {
    id: "p1",
    hostId: "dev-vm",
    folderId: "f1",
    assignmentId: "a2",
    recommendation: { recommended: true, thresholdFiles: 3000, reason: "recommended" },
    source: { fileCount: 91_660, totalBytes: 14_864_173_809, measuredAt: 1, measuredOnHostId: "master", manifestFingerprint: null },
    target: { freeBytes: 200_000_000_000, freeBytesMeasuredAt: 1, measuredOnHostId: "dev-vm", stagingRoot: "/home/b", stagingSameFilesystem: null },
    space: {
      sourceBytes: 14_864_173_809,
      sourceFiles: 91_660,
      archiveBytesEstimate: 14_864_173_809,
      extractedBytes: 14_864_173_809,
      peakBytes: 29_728_347_618,
      requiredFreeBytes: 37_224_483_590,
      targetFreeBytes: 200_000_000_000,
      shortfallBytes: 0,
      ok: true,
      message: "Target needs 34.67 GiB free; it has 186.26 GiB.",
    },
    archive: {
      format: "tar.zstd",
      tooling: { tar: true, zstd: true, gzip: true },
      toolingReady: true,
      estimateBytes: 14_864_173_809,
      choiceReason: "zstd is installed",
      fallback: false,
    },
    stagingPolicy: {
      adjacentToTarget: true,
      insideTarget: false,
      sameFilesystem: null,
      message: "The device derives the staging directory as a sibling of its local path.",
    },
    configRevision: 4,
    filterFingerprint: "fp",
    baselineFingerprint: "base",
    createdAt: 1,
    expiresAt: 2,
    execution: { available: false, reason: "Seed archive transport is not implemented yet." },
    ...overrides,
  };
}

describe("offering and recommending", () => {
  test("only offers for a sync assignment with a measurement", () => {
    expect(shouldOfferSeed(record())).toBe(false);
    expect(
      shouldOfferSeed(record({ facts: facts({ measurement: { pathCount: 10, totalBytes: 10, measuredAt: 1 } }) })),
    ).toBe(true);
    expect(
      shouldOfferSeed(
        record({
          facts: facts({ effectiveType: "backup", measurement: { pathCount: 10, totalBytes: 10, measuredAt: 1 } }),
        }),
      ),
    ).toBe(false);
  });

  test("says what to do when the device has not measured yet", () => {
    const sentence = seedRecommendationSentence(record());
    expect(sentence).toContain("has not measured the folder yet");
    expect(sentence).toContain("3,000");
    expect(sentence).toContain("Check this device now");
  });

  test("recommends above the threshold using the real numbers", () => {
    const recommended = record({
      facts: facts({ measurement: { pathCount: 91_660, totalBytes: 14_864_173_809, measuredAt: 1 } }),
    });
    expect(seedRecommended(recommended)).toBe(true);
    const sentence = seedRecommendationSentence(recommended);
    expect(sentence).toContain("91,660");
    expect(sentence).toContain("Nothing happens until you review and approve a plan");
  });

  test("does not recommend a small folder", () => {
    const small = record({
      facts: facts({ measurement: { pathCount: 850, totalBytes: 17_715_220, measuredAt: 1 } }),
    });
    expect(seedRecommended(small)).toBe(false);
    expect(seedRecommendationSentence(small)).toContain("below the");
  });
});

describe("plan wording", () => {
  test("space tone and sentence come from the plan itself", () => {
    expect(seedSpaceTone(plan())).toBe("ok");
    expect(seedSpaceSentence(plan())).toBe("Target needs 34.67 GiB free; it has 186.26 GiB.");
    const short = plan({ space: { ...plan().space, ok: false, shortfallBytes: 1_000_000, message: "Target is short 1.0 MiB" } });
    expect(seedSpaceTone(short)).toBe("bad");
  });

  test("archive wording never claims unverified tooling", () => {
    expect(seedArchiveSentence(plan())).toContain("tar + zstd");
    const unverified = plan({ archive: { ...plan().archive, toolingReady: false } });
    expect(seedArchiveSentence(unverified)).toContain("has not reported that it has the tools");
    const fallback = plan({
      archive: { ...plan().archive, format: "tar.gz", fallback: true, choiceReason: "zstd is not installed on this device" },
    });
    expect(seedArchiveSentence(fallback)).toContain("tar + gzip");
    expect(seedArchiveSentence(fallback)).toContain("zstd is not installed");
  });

  test("the execution verdict is the server's own reason, never invented", () => {
    const verdict = seedRunnableVerdict(plan(), { valid: true, message: "current" });
    expect(verdict.runnable).toBe(false);
    expect(verdict.message).toContain("not implemented yet");

    const ready = plan({ execution: { available: true, reason: "available" } });
    expect(seedRunnableVerdict(ready, { valid: true, message: "current" }).runnable).toBe(true);
    expect(seedRunnableVerdict(ready, { valid: false, message: "expired" }).message).toBe("expired");
  });

  test("the help text is explicit that nothing is enabled yet", () => {
    expect(seedUnavailableHelp()).toContain("not switched on yet");
    expect(seedUnavailableHelp()).toContain("Ordinary sync is unaffected");
  });
});

describe("phase and progress wording", () => {
  test("every phase has plain language, never rclone vocabulary", () => {
    expect(seedPhaseLabel("archiving_source")).toBe("Building the archive");
    expect(seedPhaseLabel("baseline_validation")).toBe("Validating the sync baseline");
    expect(seedPhaseLabel("completed")).toBe("Finished");
    for (const label of [
      seedPhaseLabel("preflight"),
      seedPhaseLabel("extracting_target"),
      seedPhaseLabel("publishing"),
      seedPhaseLabel("failed"),
    ]) {
      expect(label).not.toContain("bisync");
      expect(label).not.toContain("rclone");
    }
  });

  test("progress sentence reports only known totals", () => {
    const job = {
      phase: "extracting_target" as const,
      status: "running" as const,
      progress: {
        phase: "extracting_target" as const,
        phaseIndex: 6,
        phaseCount: 10,
        message: "",
        bytesDone: 0,
        bytesTotal: null,
        entriesDone: 100,
        entriesTotal: null,
        updatedAt: 1,
      },
    };
    const sentence = seedProgressSentence(job);
    expect(sentence).toContain("Unpacking beside the target");
    expect(sentence).toContain("100 entries so far");
    expect(sentence).not.toContain("%");
    expect(seedProgressPercent(job)).toBeNull();

    const withTotals = {
      ...job,
      progress: { ...job.progress, entriesTotal: 400 },
    };
    expect(seedProgressPercent(withTotals)).toBe(25);
    expect(seedProgressSentence(withTotals)).toContain("25%");
  });

  test("job tone maps the state machine", () => {
    expect(seedJobTone("completed")).toBe("ok");
    expect(seedJobTone("failed")).toBe("bad");
    expect(seedJobTone("cancelled")).toBe("warn");
    expect(seedJobTone("running")).toBe("info");
  });

  test("the glossary explains the new terms without jargon", () => {
    const terms = SEED_GLOSSARY.map((entry) => entry.term);
    expect(terms).toContain("Seed transfer");
    expect(terms).toContain("Staging directory");
    expect(terms).toContain("Progress-aware timeout");
    const timeout = SEED_GLOSSARY.find((entry) => entry.term === "Progress-aware timeout")!;
    expect(timeout.plain).toContain("stalls");
  });
});

describe("SeedJob typing stays honest", () => {
  test("a planned job has no lease and no archive bytes", () => {
    const job: Pick<SeedJob, "status" | "leaseOwner" | "archive"> = {
      status: "planned",
      leaseOwner: null,
      archive: { format: "tar.gz", bytes: null, sha256: null, objectKey: null, memberCount: null },
    };
    expect(job.leaseOwner).toBeNull();
    expect(job.archive.bytes).toBeNull();
  });
});
