// LAMA-345 — shared folder-health contract: state derivation, staleness,
// plan validity and the allowlisted intervention grammar.

import { describe, expect, test } from "bun:test";
import {
  FOLDER_HEALTH_STALE_MS,
  checkFolderPlanValidity,
  deriveFolderHealth,
  describeBootstrapAuthority,
  folderHealthStaleness,
  parseFolderDiagnosePayload,
  parseFolderInterventionPayload,
  parseFolderPlanRequestPayload,
  validateBisyncMaxDelete,
  validateMountCacheMode,
  type FolderHealthFacts,
} from "./folder-health.ts";

function facts(overrides: Partial<FolderHealthFacts> = {}): FolderHealthFacts {
  const base: FolderHealthFacts = {
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
    filter: { fingerprint: "abc", source: "lamasyncignore", changedSinceBaseline: false },
    baseline: {
      present: true,
      ready: true,
      error: false,
      path1Count: 100,
      path2Count: 100,
      updatedAt: 1_700_000_000_000,
      fingerprint: "pair",
    },
    activePhase: null,
    pendingConflicts: 0,
    lastRun: { status: "success", summary: "sync ok", at: 1_700_000_000_000 },
    measurement: null,
  };
  return { ...base, ...overrides };
}

describe("deriveFolderHealth", () => {
  test("a ready paired baseline with a clean last run is healthy", () => {
    const { state, reasons } = deriveFolderHealth(facts());
    expect(state).toBe("healthy");
    expect(reasons.map((r) => r.code)).toEqual(["ok"]);
  });

  test("no pair at all is new_host with an initialize remediation", () => {
    const { state, reasons } = deriveFolderHealth(
      facts({
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
    );
    expect(state).toBe("new_host");
    expect(reasons[0]?.code).toBe("baseline_missing");
    expect(reasons[0]?.action).toBe("initialize");
  });

  test("a half-written listing pair requires a resync, not a resync on the next run", () => {
    const { state, reasons } = deriveFolderHealth(
      facts({
        baseline: {
          present: true,
          ready: false,
          error: false,
          path1Count: null,
          path2Count: null,
          updatedAt: 1,
          fingerprint: "pair",
        },
      }),
    );
    expect(state).toBe("resync_required");
    expect(reasons[0]?.code).toBe("baseline_incomplete");
  });

  test("an rclone critical error is unsafe and outranks resync_required", () => {
    const { state, reasons } = deriveFolderHealth(
      facts({
        filter: { fingerprint: "abc", source: "none", changedSinceBaseline: true },
        baseline: {
          present: true,
          ready: false,
          error: true,
          path1Count: null,
          path2Count: null,
          updatedAt: 1,
          fingerprint: "pair",
        },
      }),
    );
    expect(state).toBe("unsafe");
    expect(reasons[0]?.code).toBe("baseline_error");
  });

  test("the dev-vm shape — an empty remote listing beside local content — is not healthy", () => {
    const { state, reasons } = deriveFolderHealth(
      facts({
        baseline: {
          present: true,
          ready: true,
          error: false,
          path1Count: 0,
          path2Count: 850,
          updatedAt: 1,
          fingerprint: "pair",
        },
      }),
    );
    expect(state).toBe("resync_required");
    expect(reasons.map((r) => r.code)).toContain("baseline_not_established");
  });

  test("a changed filter universe requires a resync", () => {
    const { state, reasons } = deriveFolderHealth(
      facts({ filter: { fingerprint: "abc", source: "combined", changedSinceBaseline: true } }),
    );
    expect(state).toBe("resync_required");
    expect(reasons.map((r) => r.code)).toContain("filter_changed");
  });

  test("a missing local directory blocks any run", () => {
    const { state, reasons } = deriveFolderHealth(facts({ localDir: "missing" }));
    expect(state).toBe("blocked");
    expect(reasons.map((r) => r.code)).toContain("local_path_missing");
  });

  test("a free-space reading below the assignment floor blocks the run", () => {
    const { state } = deriveFolderHealth(
      facts({ freeSpaceBytes: 1, freeSpaceThresholdBytes: 1_000_000_000 }),
    );
    expect(state).toBe("blocked");
  });

  test("an in-flight run wins over every other condition", () => {
    const { state, reasons } = deriveFolderHealth(
      facts({ runInProgress: true, localDir: "missing" }),
    );
    expect(state).toBe("busy");
    expect(reasons[0]?.code).toBe("run_in_progress");
  });

  test("an interrupted run with an intact baseline is recoverable", () => {
    const { state } = deriveFolderHealth(
      facts({ lastRun: { status: "retry", summary: "transient", at: 1 } }),
    );
    expect(state).toBe("recoverable");
  });

  test("a disabled assignment is blocked without sounding like a fault", () => {
    const { state, reasons } = deriveFolderHealth(facts({ enabled: false }));
    expect(state).toBe("blocked");
    expect(reasons.map((r) => r.code)).toContain("assignment_disabled");
  });

  test("non-sync folders never report a missing bisync baseline", () => {
    const { state } = deriveFolderHealth(
      facts({
        effectiveType: "backup",
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
    );
    expect(state).toBe("healthy");
  });
});

describe("folderHealthStaleness", () => {
  test("marks a report older than the budget stale", () => {
    const now = 1_000_000_000;
    expect(folderHealthStaleness(now - 1_000, now).stale).toBe(false);
    expect(folderHealthStaleness(now - FOLDER_HEALTH_STALE_MS - 1, now).stale).toBe(true);
  });

  test("a clock that went backwards is not reported as stale", () => {
    expect(folderHealthStaleness(2_000, 1_000)).toEqual({ stale: false, stalenessMs: null });
  });
});

describe("describeBootstrapAuthority", () => {
  test("spells out which side loses files", () => {
    expect(describeBootstrapAuthority("remote").long).toContain("removed locally");
    expect(describeBootstrapAuthority("local").long).toContain("removed there");
  });
});

describe("parseFolderInterventionPayload", () => {
  const planId = "11111111-1111-1111-1111-111111111111";

  test("initialize must name remote authority, a plan and an explicit confirm", () => {
    expect(parseFolderInterventionPayload({ folderId: "f1", intervention: "initialize" })).toEqual({
      ok: false,
      error: "authority must be explicitly 'remote' or 'local'",
    });
    expect(
      parseFolderInterventionPayload({ folderId: "f1", intervention: "initialize", authority: "local" }),
    ).toEqual({
      ok: false,
      error: "initialize requires remote authority (remote is authoritative)",
    });
    expect(
      parseFolderInterventionPayload({ folderId: "f1", intervention: "initialize", authority: "remote" }),
    ).toEqual({ ok: false, error: "initialize requires a reviewed planId" });
    expect(
      parseFolderInterventionPayload({
        folderId: "f1",
        intervention: "initialize",
        authority: "remote",
        planId,
      }),
    ).toEqual({ ok: false, error: "initialize requires confirm: true" });
    const ok = parseFolderInterventionPayload({
      folderId: "f1",
      intervention: "initialize",
      authority: "remote",
      planId,
      confirm: true,
    });
    expect(ok.ok).toBe(true);
  });

  test("seed requires local authority", () => {
    expect(
      parseFolderInterventionPayload({ folderId: "f1", intervention: "seed", authority: "remote" }),
    ).toEqual({
      ok: false,
      error: "seed requires local authority (this host is authoritative)",
    });
  });

  test("resync accepts either explicit side but still needs a plan", () => {
    const missingPlan = parseFolderInterventionPayload({
      folderId: "f1",
      intervention: "resync",
      authority: "local",
      confirm: true,
    });
    expect(missingPlan).toEqual({ ok: false, error: "resync requires a reviewed planId" });
    const ok = parseFolderInterventionPayload({
      folderId: "f1",
      intervention: "resync",
      authority: "local",
      planId,
      confirm: true,
    });
    expect(ok.ok).toBe(true);
  });

  test("cancel needs no authority or plan", () => {
    const parsed = parseFolderInterventionPayload({ folderId: "f1", intervention: "cancel" });
    expect(parsed.ok).toBe(true);
  });

  test("arbitrary argv-shaped fields are rejected outright", () => {
    const parsed = parseFolderInterventionPayload({
      folderId: "f1",
      intervention: "cancel",
      rcloneArgs: ["--transfers", "32"],
    });
    expect(parsed).toEqual({ ok: false, error: "unsupported field: rcloneArgs" });
  });

  test("a maxDelete cap is bounded", () => {
    expect(
      parseFolderInterventionPayload({
        folderId: "f1",
        intervention: "cancel",
        maxDelete: 1_000_001,
      }),
    ).toEqual({ ok: false, error: "maxDelete must be an integer between 0 and 1000000" });
  });
});

describe("parseFolderPlanRequestPayload", () => {
  test("planning only accepts the three reseeding interventions", () => {
    expect(
      parseFolderPlanRequestPayload({ folderId: "f1", intervention: "cancel" }),
    ).toEqual({ ok: false, error: "only initialize, seed or resync can be planned" });
  });

  test("planning does not require confirm but does require the right authority", () => {
    const parsed = parseFolderPlanRequestPayload({
      folderId: "f1",
      intervention: "seed",
      authority: "local",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.payload.authority).toBe("local");
  });
});

describe("parseFolderDiagnosePayload", () => {
  test("accepts only a folderId", () => {
    expect(parseFolderDiagnosePayload({ folderId: "f1" })).toEqual({ ok: true, folderId: "f1" });
    expect(parseFolderDiagnosePayload({ folderId: "f1", deep: true })).toEqual({
      ok: false,
      error: "unsupported field: deep",
    });
    expect(parseFolderDiagnosePayload({})).toEqual({ ok: false, error: "folderId is required" });
  });
});

describe("checkFolderPlanValidity", () => {
  const plan = {
    expiresAt: 2_000,
    configRevision: 7,
    filterFingerprint: "fp",
    baselineFingerprint: "base",
  };
  const live = { now: 1_000, configRevision: 7, filterFingerprint: "fp", baselineFingerprint: "base" };

  test("a current plan is valid", () => {
    expect(checkFolderPlanValidity(plan, live).valid).toBe(true);
  });

  test("expiry, config, filter and baseline each invalidate it", () => {
    expect(checkFolderPlanValidity(plan, { ...live, now: 2_000 }).reason).toBe("expired");
    expect(checkFolderPlanValidity(plan, { ...live, configRevision: 8 }).reason).toBe("config_changed");
    expect(checkFolderPlanValidity(plan, { ...live, filterFingerprint: "other" }).reason).toBe(
      "filter_changed",
    );
    expect(checkFolderPlanValidity(plan, { ...live, baselineFingerprint: "other" }).reason).toBe(
      "baseline_changed",
    );
  });
});

describe("allowlisted tuning validators", () => {
  test("bisyncMaxDelete is null or a bounded integer", () => {
    expect(validateBisyncMaxDelete(null)).toBeNull();
    expect(validateBisyncMaxDelete(0)).toBeNull();
    expect(validateBisyncMaxDelete(1_000_000)).toBeNull();
    expect(validateBisyncMaxDelete(-1)).toContain("bisyncMaxDelete must be");
    expect(validateBisyncMaxDelete(1_000_001)).toContain("bisyncMaxDelete must be");
    expect(validateBisyncMaxDelete(1.5)).toContain("bisyncMaxDelete must be");
  });

  test("mountCacheMode is one of the four rclone modes", () => {
    expect(validateMountCacheMode(null)).toBe(true);
    expect(validateMountCacheMode("writes")).toBe(true);
    expect(validateMountCacheMode("turbo")).toBe(false);
  });
});
