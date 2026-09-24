// LAMA-345 — the Folders page health presentation rules.
//
// Pure: which actions are offered (the intervention gates), how staleness is
// worded, and how the baseline/filter/watcher facts are stated.

import { describe, expect, test } from "bun:test";
import type { FolderHealthFacts, FolderHealthRecord } from "@lamasync/core/folder-health";
import type { FolderSyncPlan } from "@lamasync/core/folder-health";
import { FOLDER_PLAN_CHANGE_CAP } from "@lamasync/core/folder-health";
import {
  HEALTH_GLOSSARY,
  actionChoosesAuthority,
  actionLabel,
  actionTone,
  availableHealthActions,
  planIsFromThisRequest,
  planMatchesSelection,
  planTotals,
  previewFailureNextStep,
  technicalDetails,
  wizardStep,
  wizardStepLabel,
  wizardVisibleSteps,
  authorityForAction,
  authorityWording,
  baselineSentence,
  filterSentence,
  freshnessSentence,
  healthLabel,
  healthTone,
  isGuardedAction,
  measurementSentence,
  planValiditySentence,
  relativeMinutes,
  watcherSentence,
} from "./folder-health.ts";

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
    watcher: { enabled: false, running: false, quietSec: 30 },
    filter: { fingerprint: "fp", source: "lamasyncignore", changedSinceBaseline: false, patternCount: 0 },
    baseline: {
      present: true,
      ready: true,
      error: false,
      path1Count: 10,
      path2Count: 10,
      updatedAt: 1,
      fingerprint: "base",
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
    assignmentId: "a1",
    folderId: "f1",
    hostId: "dev-vm",
    state: "healthy",
    reasons: [],
    facts: facts(),
    reportedAt: Date.now(),
    stale: false,
    stalenessMs: 1_000,
    measurementAgeMs: null,
    active: false,
    ...overrides,
  };
}

describe("healthTone / healthLabel", () => {
  test("maps each state to a tone and a word", () => {
    expect(healthTone("healthy")).toBe("ok");
    expect(healthTone("busy")).toBe("info");
    expect(healthTone("recoverable")).toBe("warn");
    expect(healthTone("new_host")).toBe("warn");
    expect(healthTone("unsafe")).toBe("bad");
    expect(healthTone("resync_required")).toBe("bad");
    expect(healthTone("blocked")).toBe("bad");
    expect(healthTone("unknown")).toBe("info");
    expect(healthLabel("new_host")).toBe("Not initialised");
  });
});

describe("availableHealthActions — the intervention gates", () => {
  test("a healthy paired baseline offers Sync now and Rebuild, never a context-free plan", () => {
    const actions = availableHealthActions(record());
    expect(actions).toEqual(["diagnose", "sync", "resync"]);
    // Planning is attached to the reseeding actions, not offered on its own.
    expect(actions).not.toContain("plan");
  });

  test("without a usable baseline Sync now is withheld in favour of initialize/seed", () => {
    const actions = availableHealthActions(
      record({
        state: "new_host",
        facts: facts({
          baseline: {
            present: false,
            ready: false,
            error: false,
            path1Count: null,
            path2Count: null,
            updatedAt: null,
            fingerprint: "none",
          },
        }),
      }),
    );
    expect(actions).toContain("initialize");
    expect(actions).toContain("seed");
    expect(actions).not.toContain("sync");
  });

  test("a safe resync is the offered path when the universe changed", () => {
    const actions = availableHealthActions(
      record({
        state: "resync_required",
        facts: facts({
          filter: { fingerprint: "fp", source: "combined", changedSinceBaseline: true, patternCount: 0 },
        }),
      }),
    );
    expect(actions).toContain("resync");
  });

  test("an interrupted run offers Resume", () => {
    expect(availableHealthActions(record({ state: "recoverable" }))).toContain("resume");
  });

  test("a running assignment offers only Diagnose and Stop", () => {
    const actions = availableHealthActions(record({ state: "busy", active: true }));
    expect(actions).toEqual(["diagnose", "cancel"]);
  });

  test("a blocked assignment offers diagnosis only — nothing can run", () => {
    const actions = availableHealthActions(record({ state: "blocked" }));
    expect(actions).toEqual(["diagnose"]);
  });

  test("a non-bisync assignment offers diagnosis only — no reseeding", () => {
    const actions = availableHealthActions(
      record({ facts: facts({ effectiveType: "backup", folderType: "backup" }) }),
    );
    expect(actions).toEqual(["diagnose"]);
  });
});

describe("authority helpers", () => {
  test("initialize pins remote, seed pins local, resync follows the operator", () => {
    expect(authorityForAction("initialize", "local")).toBe("remote");
    expect(authorityForAction("seed", "remote")).toBe("local");
    expect(authorityForAction("resync", "local")).toBe("local");
    expect(authorityForAction("sync", "local")).toBeNull();
  });

  test("only the reseeding actions are guarded", () => {
    expect(isGuardedAction("initialize")).toBe(true);
    expect(isGuardedAction("seed")).toBe(true);
    expect(isGuardedAction("resync")).toBe(true);
    expect(isGuardedAction("sync")).toBe(false);
    expect(isGuardedAction("cancel")).toBe(false);
  });

  test("the wording is about conflicting files, not deleting unique ones", () => {
    expect(authorityWording("remote").short).toBe("The remote wins conflicting files");
    expect(authorityWording("local").short).toBe("This device wins conflicting files");
    expect(authorityWording("remote").long).toContain("copied to the other side");
    expect(authorityWording("remote").long).not.toContain("removed");
    expect(authorityWording("local").long).not.toContain("removed");
  });

  test("only Rebuild lets the operator choose the winning side", () => {
    expect(actionChoosesAuthority("resync")).toBe(true);
    expect(actionChoosesAuthority("initialize")).toBe(false);
    expect(actionChoosesAuthority("seed")).toBe(false);
  });

  test("plain-language labels keep rclone vocabulary out of the button", () => {
    for (const action of ["diagnose", "sync", "initialize", "seed", "resync", "resume", "cancel"] as const) {
      const label = actionLabel(action);
      expect(label).not.toContain("Path 1");
      expect(label).not.toContain("Path 2");
      expect(label).not.toContain("resync-mode");
      expect(label).not.toContain("baseline re");
    }
    expect(actionLabel("cancel")).toBe("Stop current run");
    expect(actionLabel("resync")).toBe("Rebuild the sync baseline");
  });

  test("tone keeps checks and normal syncs distinct from rebaseline/stop", () => {
    expect(actionTone("diagnose")).toBe("neutral");
    expect(actionTone("sync")).toBe("primary");
    expect(actionTone("resync")).toBe("danger");
    expect(actionTone("cancel")).toBe("danger");
    expect(actionTone("initialize")).toBe("neutral");
    expect(actionTone("seed")).toBe("neutral");
  });

  test("technical details carry the rclone vocabulary for those who want it", () => {
    const lines = technicalDetails("seed", "local", 25);
    expect(lines.join(" ")).toContain("Path 1");
    expect(lines.join(" ")).toContain("--resync-mode path2");
    expect(lines.join(" ")).toContain("--max-delete 25");
    expect(lines.join(" ")).toContain("archived");
    // A blank threshold is described as rclone's default, never as no limit.
    const blank = technicalDetails("seed", "local", null).join(" ");
    expect(blank).toContain("rclone's default");
    expect(blank).toContain("50%");
    expect(blank).not.toContain("no cap");
  });
});

describe("freshness wording", () => {
  test("an old report is explicitly called stale", () => {
    expect(freshnessSentence(record({ stale: true, stalenessMs: 40 * 60_000 }))).toContain("stale");
    expect(freshnessSentence(record({ stale: false, stalenessMs: 30_000 }))).not.toContain("stale");
  });

  test("a measurement is stated separately and never as the report's age", () => {
    const withMeasurement = record({
      facts: facts({
        measurement: { pathCount: 5, totalBytes: 100, measuredAt: 1 },
      }),
      measurementAgeMs: 3 * 60 * 60_000,
    });
    expect(measurementSentence(withMeasurement)).toBe("Measured 3 h ago");
    expect(measurementSentence(record())).toBeNull();
  });

  test("relativeMinutes degrades sensibly", () => {
    expect(relativeMinutes(10_000)).toBe("just now");
    expect(relativeMinutes(5 * 60_000)).toBe("5 min");
    expect(relativeMinutes(3 * 60 * 60_000)).toBe("3 h");
    expect(relativeMinutes(3 * 24 * 60 * 60_000)).toBe("3 d");
  });
});

describe("baseline / filter / watcher wording", () => {
  test("a critical error is named as such", () => {
    expect(
      baselineSentence(
        record({
          facts: facts({
            baseline: {
              present: true,
              ready: false,
              error: true,
              path1Count: null,
              path2Count: null,
              updatedAt: 1,
              fingerprint: "p",
            },
          }),
        }),
      ),
    ).toContain("critical error");
  });

  test("a paired sync record shows both counts when measured", () => {
    expect(baselineSentence(record())).toBe("Sync record paired (remote 10 · this device 10)");
  });

  test("a changed ignore set is stated without jargon", () => {
    expect(
      filterSentence(
        record({ facts: facts({ filter: { fingerprint: "f", source: "combined", changedSinceBaseline: true, patternCount: 0 } }) }),
      ),
    ).toContain("changed since the last sync");
  });

  test("a requested-but-dead watcher is never reported as running", () => {
    expect(
      watcherSentence(record({ facts: facts({ watcher: { enabled: true, running: false, quietSec: 60 } }) })),
    ).toBe("Watching was requested but is not running");
    expect(
      watcherSentence(record({ facts: facts({ watcher: { enabled: true, running: true, quietSec: 30 } }) })),
    ).toBe("Watching for changes (settles after 30s of quiet)");
    expect(
      watcherSentence(record({ facts: facts({ watcher: { enabled: false, running: false, quietSec: 30 } }) })),
    ).toBeNull();
  });
});

describe("planValiditySentence", () => {
  test("passes through the server's verdict", () => {
    const plan = { id: "p1" } as unknown as FolderSyncPlan;
    expect(
      planValiditySentence({ plan, validity: { valid: false, reason: "expired", message: "This plan has expired — plan again." } }),
    ).toBe("This plan has expired — plan again.");
    expect(
      planValiditySentence({ plan, validity: { valid: true, reason: null, message: "Plan is current." } }),
    ).toBe("This preview is still current.");
  });
});

describe("plan review", () => {
  const changes = {
    wouldCopy: ["a", "b"],
    wouldDelete: ["c"],
    wouldMkdir: [],
    files: 2,
    bytes: 4096,
  };

  test("totals are counted separately from the bounded samples", () => {
    const totals = planTotals({ changes });
    expect(totals).toMatchObject({ copies: 2, deletes: 1, mkdirs: 0, bytes: 4096 });
    expect(totals.sampled).toBe(false);
    expect(totals.sampleCap).toBe(FOLDER_PLAN_CHANGE_CAP);
  });

  test("a full sample list is flagged so the UI can say only the first N are shown", () => {
    const full = Array.from({ length: FOLDER_PLAN_CHANGE_CAP }, (_, i) => `f${i}`);
    expect(planTotals({ changes: { ...changes, wouldCopy: full } }).sampled).toBe(true);
  });

  test("a plan is only approved against the side and threshold it was built for", () => {
    // Rebuild is the operation where the operator picks the side, so it is the
    // one that can be switched under a plan.
    const plan = { intervention: "resync" as const, authority: "local" as const, maxDeletePercent: 10 };
    expect(
      planMatchesSelection(plan, {
        intervention: "resync",
        authority: "local",
        maxDeletePercent: 10,
      }).ok,
    ).toBe(true);
    const wrongSide = planMatchesSelection(plan, {
      intervention: "resync",
      authority: "remote",
      maxDeletePercent: 10,
    });
    expect(wrongSide.ok).toBe(false);
    expect(wrongSide.message).toContain("Plan again with the side you want");
    expect(
      planMatchesSelection(plan, {
        intervention: "resync",
        authority: "local",
        maxDeletePercent: 90,
      }).ok,
    ).toBe(false);
    // A different operation entirely is never authorized by this plan.
    expect(
      planMatchesSelection(plan, { intervention: "seed", authority: "local", maxDeletePercent: 10 })
        .ok,
    ).toBe(false);
  });

  test("an operation with a fixed side binds that side regardless of the selection", () => {
    const seedPlan = { intervention: "seed" as const, authority: "local" as const, maxDeletePercent: null };
    // The seed action pins local authority in core, so this is the same review.
    expect(
      planMatchesSelection(seedPlan, {
        intervention: "seed",
        authority: "remote",
        maxDeletePercent: null,
      }).ok,
    ).toBe(true);
    const initializePlan = {
      intervention: "initialize" as const,
      authority: "remote" as const,
      maxDeletePercent: null,
    };
    expect(
      planMatchesSelection(initializePlan, {
        intervention: "initialize",
        authority: "local",
        maxDeletePercent: null,
      }).ok,
    ).toBe(true);
    // But a seed plan can never be an initialize plan.
    expect(
      planMatchesSelection(seedPlan, {
        intervention: "initialize",
        authority: "remote",
        maxDeletePercent: null,
      }).ok,
    ).toBe(false);
  });

  test("a plan is never approved for an action that does not take one", () => {
    const plan = { intervention: "seed" as const, authority: "local" as const, maxDeletePercent: null };
    expect(
      planMatchesSelection(plan, { intervention: "sync", authority: "local", maxDeletePercent: null })
        .ok,
    ).toBe(false);
  });

  test("only a plan produced by THIS preview is accepted", () => {
    const requestedAt = 1_000_000;
    expect(planIsFromThisRequest({ createdAt: requestedAt + 10 }, requestedAt)).toBe(true);
    // A plan that predates the request must never be shown as its result —
    // that is how a stale plan for the same side could be approved.
    expect(planIsFromThisRequest({ createdAt: requestedAt - 60_000 }, requestedAt)).toBe(false);
  });

  test("a failure always ends with a concrete next step", () => {
    expect(previewFailureNextStep("preview timed out after 60s")).toContain("timeout");
    expect(previewFailureNextStep("planning failed: rclone binary not found")).toContain("rclone");
    expect(previewFailureNextStep("something odd")).toContain("Nothing has been changed");
    for (const reason of ["timed out", "rclone", "unknown"]) {
      expect(previewFailureNextStep(reason).length).toBeGreaterThan(20);
    }
  });
});

describe("wizard steps", () => {
  test("the four stages map to four labelled steps", () => {
    expect(wizardStep("choose")).toBe(1);
    expect(wizardStep("previewing")).toBe(2);
    expect(wizardStep("review")).toBe(3);
    expect(wizardStep("executing")).toBe(4);
    for (const step of [1, 2, 3, 4] as const) {
      expect(wizardStepLabel(step).length).toBeGreaterThan(0);
    }
  });

  test("a failure returns to the review step so the operator can retry", () => {
    expect(wizardStep("failed")).toBe(3);
  });

  test("the side-choice step is skipped when the operation fixes the side", () => {
    expect(wizardVisibleSteps("resync")).toEqual([1, 2, 3, 4]);
    expect(wizardVisibleSteps("initialize")).toEqual([2, 3, 4]);
    expect(wizardVisibleSteps("seed")).toEqual([2, 3, 4]);
  });
});

describe("glossary", () => {
  test("covers every term the card shows and explains consequences plainly", () => {
    const terms = HEALTH_GLOSSARY.map((e) => e.term).join(" | ");
    for (const wanted of ["Sync record", "Ignore set", "Watching", "Dry run", "Winning side", "Deletion threshold"]) {
      expect(terms).toContain(wanted);
    }
    const threshold = HEALTH_GLOSSARY.find((e) => e.term === "Deletion threshold")!;
    expect(threshold.plain).toContain("50%");
    expect(threshold.plain).toContain("never means 'no limit'");
    for (const entry of HEALTH_GLOSSARY) {
      expect(entry.plain).not.toContain("--");
      expect(entry.plain).not.toContain("Path 1");
    }
  });
});
