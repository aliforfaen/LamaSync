// LAMA-346 — the seed panel's rendered surface.
//
// Repo convention: no jsdom. `react-dom/server` static markup pins the copy
// and the disabled state an operator actually sees. Effects do not run, so a
// plan is rendered through the exported `SeedPlanSummary`/`SeedJobProgress`
// presentational components; the panel's own gating lives in
// ../folder-seed.test.ts.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FolderHealthFacts, FolderHealthRecord } from "@lamasync/core/folder-health";
import { emptySeedJobArchiveFacts } from "@lamasync/core/folder-seed";
import type { SeedJob, SeedPlan, SeedPlanValidity } from "@lamasync/core/folder-seed";
import {
  FolderSeedPlanCard,
  SeedJobProgress,
  SeedPlanSummary,
} from "./FolderSeedPlanCard.tsx";

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
    filter: { fingerprint: null, source: "none", changedSinceBaseline: false, patternCount: 0 },
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
      message: "Source authority: master — measured 91,660 entries 1 minutes ago.",
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
      message: "Target needs 34.67 GiB free (archive + extracted tree + safety margin); it has 186.26 GiB.",
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
      message:
        "A seed archive must be built from exactly the effective filter universe the following sync baseline uses.",
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

function renderPanel(r: FolderHealthRecord, siblings?: FolderHealthRecord[]): string {
  return renderToStaticMarkup(
    <FolderSeedPlanCard folderId="f1" hostId="dev-vm" record={r} siblingRecords={siblings} now={1_700_000_000_000} />,
  );
}

/** A measured source device, as the panel needs for an explicit choice. */
function masterRecord(): FolderHealthRecord {
  return record({
    hostId: "master",
    assignmentId: "a1",
    facts: facts({ measurement: { pathCount: 91_660, totalBytes: 14_864_173_809, measuredAt: 1_700_000_000_000 - 60_000 } }),
  });
}

describe("FolderSeedPlanCard", () => {
  test("renders nothing for a non-sync assignment", () => {
    const html = renderPanel(record({ facts: facts({ effectiveType: "backup" }) }));
    expect(html).toBe("");
  });

  test("shows the recommendation and the explicit no-automatic promise", () => {
    const html = renderPanel(
      record({ facts: facts({ measurement: { pathCount: 91_660, totalBytes: 14_864_173_809, measuredAt: 1 } }) }),
    );
    expect(html).toContain("Large initial transfer (seed)");
    expect(html).toContain("recommended");
    expect(html).toContain("91,660");
    expect(html).toContain("Nothing happens until you review and approve a plan");
  });

  test("requires the operator to name the source device explicitly", () => {
    const measured = record({
      facts: facts({ measurement: { pathCount: 91_660, totalBytes: 14_864_173_809, measuredAt: 1 } }),
    });
    const html = renderPanel(measured, [measured, masterRecord()]);
    expect(html).toContain("Source device (the device that already holds the data)");
    expect(html).toContain("Choose a device…");
    expect(html).toContain("master — 91,660 entries");
    expect(html).toContain("never picks the source for you");
    expect(html).toContain("Prepare a seed plan (read-only)");
    // The target is never offered as its own source.
    expect(html).not.toContain("dev-vm — 91,660 entries");
  });

  test("refuses to offer a plan when no other device is assigned", () => {
    const measured = record({
      facts: facts({ measurement: { pathCount: 91_660, totalBytes: 14_864_173_809, measuredAt: 1 } }),
    });
    const html = renderPanel(measured, [measured]);
    expect(html).toContain("No other device is assigned to this folder");
    expect(html).not.toContain("Prepare a seed plan (read-only)");
  });

  test("asks the operator to measure first when there is no measurement", () => {
    const html = renderPanel(record());
    expect(html).toContain("has not measured the folder yet");
    expect(html).toContain("Check this device now");
    expect(html).not.toContain("Prepare a seed plan");
  });

  test("explains the terms and the progress-aware timeout", () => {
    const html = renderPanel(
      record({ facts: facts({ measurement: { pathCount: 100, totalBytes: 1_000, measuredAt: 1 } }) }),
    );
    expect(html).toContain("Seed transfer");
    expect(html).toContain("Staging directory");
    expect(html).toContain("Progress-aware timeout");
  });
});

describe("SeedPlanSummary", () => {
  test("shows the source, the target space and the reservation", () => {
    const html = renderToStaticMarkup(
      <SeedPlanSummary plan={plan()} validity={{ valid: true, reason: null, message: "current" }} />,
    );
    expect(html).toContain("Source device");
    expect(html).toContain("master");
    expect(html).toContain("chosen by you");
    expect(html).toContain("Source size");
    expect(html).toContain("91,660");
    expect(html).toContain("measured on master");
    expect(html).toContain("Target free space");
    expect(html).toContain("Space to reserve");
    expect(html).toContain("This plan is still current.");
    expect(html).toContain("tar + zstd");
    expect(html).toContain("single atomic rename");
    expect(html).toContain("zero content changes");
  });

  test("lists the unmet prerequisites instead of a single opaque verdict", () => {
    const html = renderToStaticMarkup(
      <SeedPlanSummary plan={plan()} validity={{ valid: false, reason: "not_runnable", message: "not runnable" }} />,
    );
    expect(html).toContain("Before this seed can run:");
    expect(html).toContain("effective filter universe");
    expect(html).toContain("temporary seed space");
  });

  test("an unproven same-filesystem verdict is shown as a blocker", () => {
    const unproven = plan({
      stagingPolicy: {
        adjacentToTarget: true,
        derivedSibling: true,
        insideTarget: false,
        sameFilesystem: null,
        message: "The target device has not confirmed that the staging directory and the target share a filesystem.",
      },
    });
    const html = renderToStaticMarkup(
      <SeedPlanSummary plan={unproven} validity={{ valid: false, reason: "not_runnable", message: "not runnable" }} />,
    );
    expect(html).toContain("has not confirmed that the staging directory and the target share a filesystem");
  });

  test("states a shortfall instead of hiding it", () => {
    const short = plan({
      space: { ...plan().space, ok: false, shortfallBytes: 1_000_000, message: "Target is short 1.0 MiB." },
    });
    const html = renderToStaticMarkup(
      <SeedPlanSummary plan={short} validity={{ valid: false, reason: "not_runnable", message: "Target is short 1.0 MiB." }} />,
    );
    expect(html).toContain("short");
    expect(html).toContain("Target is short 1.0 MiB.");
  });
});

describe("SeedJobProgress", () => {
  test("renders the phase, counters and a percentage only when known", () => {
    const job: SeedJob = {
      id: "j1",
      planId: "p1",
      folderId: "f1",
      hostId: "dev-vm",
      assignmentId: "a2",
      status: "running",
      phase: "extracting_target",
      progress: {
        phase: "extracting_target",
        phaseIndex: 6,
        phaseCount: 10,
        message: "unpacking",
        bytesDone: 0,
        bytesTotal: null,
        entriesDone: 100,
        entriesTotal: 400,
        updatedAt: 1,
      },
      source: { fileCount: 91_660, totalBytes: 14_864_173_809, measuredAt: 1, measuredOnHostId: "master", manifestFingerprint: null },
      archive: {
        ...emptySeedJobArchiveFacts("tar.zstd"),
        bytes: 1,
        sha256: "a".repeat(64),
        objectKey: "lamasync/seed/j1/payload.tar.zst",
        memberCount: 91_660,
        manifestFingerprint: "mf",
      },
      staging: { path: "/home/b/.lamasync-seed-staging-Projects-j1", targetPath: "/home/b/Projects", requiredFreeBytes: 1, freeBytesAtPlan: 2 },
      leaseOwner: "dev-vm",
      leaseExpiresAt: 2,
      error: null,
      summary: null,
      createdAt: 1,
      startedAt: 1,
      updatedAt: 1,
      finishedAt: null,
    };
    const html = renderToStaticMarkup(<SeedJobProgress job={job} />);
    expect(html).toContain("Unpacking beside the target");
    expect(html).toContain("100 of 400 entries");
    expect(html).toContain("25%");
    expect(html).toContain("<progress");
  });

  test("renders a terminal failure with its bounded error", () => {
    const job: SeedJob = {
      id: "j2",
      planId: "p1",
      folderId: "f1",
      hostId: "dev-vm",
      assignmentId: "a2",
      status: "failed",
      phase: "failed",
      progress: {
        phase: "verifying_target",
        phaseIndex: 7,
        phaseCount: 10,
        message: "",
        bytesDone: 0,
        bytesTotal: null,
        entriesDone: 0,
        entriesTotal: null,
        updatedAt: 1,
      },
      source: { fileCount: 0, totalBytes: 0, measuredAt: 0, measuredOnHostId: null, manifestFingerprint: null },
      archive: emptySeedJobArchiveFacts("tar.gz"),
      staging: { path: "", targetPath: "", requiredFreeBytes: 0, freeBytesAtPlan: null },
      leaseOwner: null,
      leaseExpiresAt: null,
      error: "the source tree changed while it was being archived",
      summary: null,
      createdAt: 1,
      startedAt: 1,
      updatedAt: 1,
      finishedAt: 1,
    };
    const html = renderToStaticMarkup(<SeedJobProgress job={job} />);
    expect(html).toContain("Failed");
    expect(html).toContain("the source tree changed while it was being archived");
  });
});

describe("execution availability is never a fake button", () => {
  test("the plan's execution verdict and the server reason are both on the plan", () => {
    const validity: SeedPlanValidity = { valid: true, reason: null, message: "current" };
    const html = renderToStaticMarkup(<SeedPlanSummary plan={plan()} validity={validity} />);
    // The summary never renders a Run control; the panel gates it, and the
    // panel's own render is covered above.
    expect(html).not.toContain("Start the seed transfer");
  });
});
