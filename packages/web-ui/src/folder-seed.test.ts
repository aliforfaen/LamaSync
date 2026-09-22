// LAMA-346 — Folders page seed presentation helpers. Pure; no DOM.

import { describe, expect, test } from "bun:test";
import type { FolderHealthFacts, FolderHealthRecord } from "@lamasync/core/folder-health";
import type { SeedJob, SeedPlan } from "@lamasync/core/folder-seed";
import {
  SEED_GLOSSARY,
  seedArchiveSentence,
  seedFilterUniverseSentence,
  seedJobTone,
  seedPhaseLabel,
  seedProgressPercent,
  seedProgressSentence,
  seedRecommendationSentence,
  seedRecommended,
  seedRunnableVerdict,
  seedSourceAuthoritySentence,
  seedSourceCandidates,
  seedSourceSelectionError,
  seedSpaceSentence,
  seedSpaceTone,
  seedUnavailableHelp,
  seedUnmetPrerequisites,
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
    sourceHostId: "master",
    sourceAuthority: {
      hostId: "master",
      assignmentId: "a1",
      selectedBy: "operator",
      assigned: true,
      isTarget: false,
      measurementUsable: true,
      measurementAgeMs: 60_000,
      fileCount: 91_660,
      totalBytes: 14_864_173_809,
      measuredAt: 1,
      message: "Source authority: master — measured 91,660 entries (14864173809 bytes) 1 minutes ago.",
    },
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
    filterUniverse: {
      fingerprint: "universe",
      targetFingerprint: null,
      match: true,
      patternCount: 0,
      archiveImplemented: false,
      message: "Filter-aware archive construction is a Stage 1 prerequisite.",
    },
    stagingPolicy: {
      adjacentToTarget: true,
      derivedSibling: true,
      insideTarget: false,
      sameFilesystem: true,
      message: "Staging is a sibling of the target on the same filesystem.",
    },
    configRevision: 4,
    filterFingerprint: "fp",
    baselineFingerprint: "base",
    createdAt: 1,
    expiresAt: 2,
    execution: { available: false, reason: "Seed execution is not available yet." },
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
    expect(verdict.message).toContain("not available yet");

    const ready = plan({ execution: { available: true, reason: "available" } });
    expect(seedRunnableVerdict(ready, { valid: true, message: "current" }).runnable).toBe(true);
    expect(seedRunnableVerdict(ready, { valid: false, message: "expired" }).message).toBe("expired");
  });

  test("the help text is explicit that nothing is enabled yet, and states the timeout change precisely", () => {
    const help = seedUnavailableHelp();
    expect(help).toContain("not switched on yet");
    // The correction: a first sync with no baseline IS supervised differently.
    expect(help).toContain("existing baseline is untouched and keeps its fixed timeout");
    expect(help).toContain("FIRST sync with no baseline");
    expect(help).not.toContain("Ordinary sync is unaffected");
  });

  test("the source authority sentence is the plan's own, never a substitute device", () => {
    expect(seedSourceAuthoritySentence(plan())).toContain("Source authority: master");
    const unusable = plan({
      sourceAuthority: {
        ...plan().sourceAuthority,
        measurementUsable: false,
        message: "master is assigned to this folder but has not measured it yet.",
      },
    });
    expect(seedSourceAuthoritySentence(unusable)).toContain("has not measured it yet");
  });

  test("the filter-universe sentence is surfaced verbatim", () => {
    expect(seedFilterUniverseSentence(plan())).toContain("Stage 1 prerequisite");
  });

  test("unmet prerequisites are listed, and the open Stage 1 ones are visible", () => {
    const unmet = seedUnmetPrerequisites(plan());
    const ids = unmet.map((item) => item.id);
    expect(ids).toContain("filter_universe");
    expect(ids).toContain("transport");
    // The staging proof is satisfied in this fixture.
    expect(ids).not.toContain("staging_same_filesystem");
  });

  test("an unproven same-filesystem verdict is an unmet prerequisite", () => {
    const unproven = plan({
      stagingPolicy: {
        adjacentToTarget: true,
        derivedSibling: true,
        insideTarget: false,
        sameFilesystem: null,
        message: "The target device has not confirmed that the staging directory and the target share a filesystem.",
      },
    });
    expect(seedUnmetPrerequisites(unproven).map((item) => item.id)).toContain("staging_same_filesystem");
  });
});

describe("choosing the source device explicitly", () => {
  const now = 1_700_000_000_000;

  function sourceRecords(): FolderHealthRecord[] {
    return [
      record({
        hostId: "master",
        facts: facts({ measurement: { pathCount: 91_660, totalBytes: 14_864_173_809, measuredAt: now - 60_000 } }),
      }),
      record({
        hostId: "dev-vm",
        assignmentId: "a2",
        facts: facts({ measurement: { pathCount: 850, totalBytes: 17_715_220, measuredAt: now - 60_000 } }),
      }),
      record({
        hostId: "nas",
        assignmentId: "a3",
        facts: facts({ measurement: null }),
      }),
      record({
        hostId: "laptop",
        assignmentId: "a4",
        facts: facts({
          measurement: { pathCount: 5, totalBytes: 100, measuredAt: now - 40 * 60 * 60_000 },
        }),
      }),
    ];
  }

  test("the target is never offered as its own source", () => {
    const candidates = seedSourceCandidates(sourceRecords(), "dev-vm", now);
    expect(candidates.map((c) => c.hostId)).not.toContain("dev-vm");
    expect(candidates.map((c) => c.hostId)).toEqual(["master", "laptop", "nas"]);
  });

  test("candidates are labelled with their own numbers and freshness", () => {
    const candidates = seedSourceCandidates(sourceRecords(), "dev-vm", now);
    const master = candidates.find((c) => c.hostId === "master")!;
    expect(master.label).toContain("91,660");
    expect(master.label).toContain("13.84 GiB");
    expect(master.fresh).toBe(true);
    const laptop = candidates.find((c) => c.hostId === "laptop")!;
    expect(laptop.fresh).toBe(false);
    expect(laptop.label).toContain("stale");
    const nas = candidates.find((c) => c.hostId === "nas")!;
    expect(nas.measured).toBe(false);
    expect(nas.label).toContain("not measured yet");
  });

  test("no selection is an explicit refusal, not a silent default", () => {
    const candidates = seedSourceCandidates(sourceRecords(), "dev-vm", now);
    expect(seedSourceSelectionError(candidates, null)).toContain("never picks the source for you");
    expect(seedSourceSelectionError(candidates, "")).toContain("never picks the source for you");
  });

  test("an unassigned, unmeasured, stale or empty device is refused with a reason", () => {
    const candidates = seedSourceCandidates(sourceRecords(), "dev-vm", now);
    expect(seedSourceSelectionError(candidates, "elsewhere")).toContain("not assigned to this folder");
    expect(seedSourceSelectionError(candidates, "nas")).toContain("has not measured this folder yet");
    expect(seedSourceSelectionError(candidates, "laptop")).toContain("measurement is stale");
    const empty = seedSourceCandidates(
      [record({ hostId: "empty-host", facts: facts({ measurement: { pathCount: 0, totalBytes: 0, measuredAt: now } }) })],
      "dev-vm",
      now,
    );
    expect(seedSourceSelectionError(empty, "empty-host")).toContain("measures this folder as empty");
  });

  test("a usable, explicit choice passes", () => {
    const candidates = seedSourceCandidates(sourceRecords(), "dev-vm", now);
    expect(seedSourceSelectionError(candidates, "master")).toBeNull();
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
    expect(terms).toContain("Effective filter universe");
    expect(terms).toContain("Source device");
    const timeout = SEED_GLOSSARY.find((entry) => entry.term === "Progress-aware timeout")!;
    expect(timeout.plain).toContain("stalls");
    // Precise: an existing baseline is NOT re-scoped.
    expect(timeout.plain).toContain("saved baseline keeps its exact fixed timeout");
    expect(timeout.plain).toContain("FIRST transfer with no baseline");
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
