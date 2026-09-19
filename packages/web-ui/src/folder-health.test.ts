// LAMA-345 — the Folders page health presentation rules.
//
// Pure: which actions are offered (the intervention gates), how staleness is
// worded, and how the baseline/filter/watcher facts are stated.

import { describe, expect, test } from "bun:test";
import type { FolderHealthFacts, FolderHealthRecord } from "@lamasync/core/folder-health";
import type { FolderSyncPlan } from "@lamasync/core/folder-health";
import {
  availableHealthActions,
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
    filter: { fingerprint: "fp", source: "lamasyncignore", changedSinceBaseline: false },
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
  test("a healthy paired baseline offers Sync now and Reseed", () => {
    const actions = availableHealthActions(record());
    expect(actions).toEqual(["diagnose", "plan", "sync", "resync"]);
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
          filter: { fingerprint: "fp", source: "combined", changedSinceBaseline: true },
        }),
      }),
    );
    expect(actions).toContain("resync");
  });

  test("an interrupted run offers Resume", () => {
    expect(availableHealthActions(record({ state: "recoverable" }))).toContain("resume");
  });

  test("a running assignment offers only Cancel on top of the read-only actions", () => {
    const actions = availableHealthActions(record({ state: "busy", active: true }));
    expect(actions).toEqual(["diagnose", "plan", "cancel"]);
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

  test("the wording says which side loses files", () => {
    expect(authorityWording("remote").short).toBe("Remote wins");
    expect(authorityWording("local").short).toBe("This device wins");
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

  test("a paired baseline shows both counts when measured", () => {
    expect(baselineSentence(record())).toBe("Baseline paired (remote 10 · local 10)");
  });

  test("a changed filter universe is stated without jargon", () => {
    expect(
      filterSentence(
        record({ facts: facts({ filter: { fingerprint: "f", source: "combined", changedSinceBaseline: true } }) }),
      ),
    ).toContain("changed since the last baseline");
  });

  test("a requested-but-dead watcher is never reported as running", () => {
    expect(
      watcherSentence(record({ facts: facts({ watcher: { enabled: true, running: false, quietSec: 60 } }) })),
    ).toBe("Watcher requested but not running");
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
    ).toBe("This plan is current.");
  });
});
