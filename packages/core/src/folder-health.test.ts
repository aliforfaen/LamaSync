// LAMA-345 — shared folder-health contract: state derivation, staleness,
// plan validity and the allowlisted intervention grammar.

import { describe, expect, test } from "bun:test";
import {
  BISYNC_MAX_DELETE_PERCENT_DEFAULT,
  FOLDER_HEALTH_STALE_MS,
  checkFolderPlanValidity,
  checkPlanSemantics,
  deriveFolderHealth,
  describeBootstrapAuthority,
  folderHealthStaleness,
  formatDeletePercent,
  parseFolderDiagnosePayload,
  parseFolderInterventionPayload,
  parseFolderPlanRequestPayload,
  planHasContentChanges,
  validateBisyncMaxDeletePercent,
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

describe("reason remediation copy", () => {
  // The card shows reasons[0].remediation verbatim, so it is primary copy —
  // it must read as an action an operator can find on the card, not as rclone
  // vocabulary.
  const cases: Array<[Parameters<typeof deriveFolderHealth>[0], string]> = [
    [
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
      "Set up this device from the remote, or fill the remote from this device.",
    ],
    [
      facts({ filter: { fingerprint: "f", source: "combined", changedSinceBaseline: true } }),
      "Changing the ignore set moved the file universe; preview a rebuild and approve it.",
    ],
    [
      facts({ lastRun: { status: "retry", summary: "x", at: 1 } }),
      "Continue the interrupted sync.",
    ],
    [facts({ runInProgress: true }), "Wait for it to finish, or stop it deliberately."],
  ];

  test("each remediation names an action the operator can actually take", () => {
    for (const [input, expected] of cases) {
      const { reasons } = deriveFolderHealth(input);
      expect(reasons[0]?.remediation).toBe(expected);
    }
  });

  test("no remediation leaks rclone flags or Path 1/Path 2 vocabulary", () => {
    const inputs: Array<Parameters<typeof deriveFolderHealth>[0]> = [
      facts(),
      facts({ localDir: "missing" }),
      facts({ localDir: "unwritable" }),
      facts({ enabled: false }),
      facts({ paused: true }),
      facts({
        baseline: { present: true, ready: false, error: true, path1Count: null, path2Count: null, updatedAt: 1, fingerprint: "p" },
      }),
      facts({
        baseline: { present: true, ready: true, error: false, path1Count: 0, path2Count: 5, updatedAt: 1, fingerprint: "p" },
      }),
      facts({ pendingConflicts: 2 }),
      facts({ freeSpaceBytes: 1, freeSpaceThresholdBytes: 1_000 }),
      facts({ lastRun: { status: "failed", summary: "x", at: 1 } }),
      ...cases.map(([input]) => input),
    ];
    for (const input of inputs) {
      for (const reason of deriveFolderHealth(input).reasons) {
        expect(reason.remediation).not.toContain("Path 1");
        expect(reason.remediation).not.toContain("Path 2");
        expect(reason.remediation).not.toContain("--");
        expect(reason.remediation).not.toContain("--resync");
        if (reason.code !== "rclone_missing") {
          expect(reason.remediation).not.toContain("rclone");
        }
      }
    }
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
  test("describes the conflicting-file winner, not a deletion of unique files", () => {
    const remote = describeBootstrapAuthority("remote");
    expect(remote.short).toBe("Remote wins conflicts");
    expect(remote.long).toContain("copied to the other side");
    expect(remote.long).toContain("the remote's version is kept");
    // The old wording wrongly claimed unique files get removed. Bisync copies
    // every file that exists on only one side.
    expect(remote.long).not.toContain("removed locally");
    expect(describeBootstrapAuthority("local").long).not.toContain("removed there");
    expect(describeBootstrapAuthority("local").long).toContain("this device's version is kept");
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

  test("resume requires an explicit confirmation like every other mutation", () => {
    expect(
      parseFolderInterventionPayload({ folderId: "f1", intervention: "resume" }),
    ).toEqual({ ok: false, error: "resume requires confirm: true" });
    expect(
      parseFolderInterventionPayload({ folderId: "f1", intervention: "resume", confirm: true }).ok,
    ).toBe(true);
  });

  test("a planId is only accepted for the operations that need one", () => {
    expect(
      parseFolderInterventionPayload({
        folderId: "f1",
        intervention: "resume",
        confirm: true,
        planId,
      }),
    ).toEqual({ ok: false, error: "resume does not take a planId" });
  });

  test("the deletion threshold is a percentage, not a file count", () => {
    expect(
      parseFolderInterventionPayload({
        folderId: "f1",
        intervention: "cancel",
        maxDeletePercent: 101,
      }),
    ).toEqual({ ok: false, error: "maxDeletePercent must be an integer between 0 and 100" });
    expect(
      parseFolderInterventionPayload({
        folderId: "f1",
        intervention: "cancel",
        maxDeletePercent: 25,
      }).ok,
    ).toBe(true);
  });

  test("the legacy file-count field name is rejected outright", () => {
    expect(
      parseFolderInterventionPayload({
        folderId: "f1",
        intervention: "cancel",
        maxDelete: 5,
      }),
    ).toEqual({ ok: false, error: "unsupported field: maxDelete" });
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

  test("a plan request carries the reviewed deletion percentage and bounds it", () => {
    const parsed = parseFolderPlanRequestPayload({
      folderId: "f1",
      intervention: "seed",
      authority: "local",
      maxDeletePercent: 10,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.payload.maxDeletePercent).toBe(10);
    expect(
      parseFolderPlanRequestPayload({
        folderId: "f1",
        intervention: "seed",
        authority: "local",
        maxDeletePercent: 500,
      }),
    ).toEqual({
      ok: false,
      error: "bisyncMaxDeletePercent must be null or an integer between 0 and 100",
    });
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

describe("checkPlanSemantics", () => {
  const plan = {
    intervention: "seed" as const,
    authority: "local" as const,
    maxDeletePercent: 10 as number | null,
  };

  test("the exact reviewed operation is authorized, and returns the plan's values", () => {
    const verdict = checkPlanSemantics(plan, { intervention: "seed", authority: "local" });
    expect(verdict.ok).toBe(true);
    expect(verdict.execution).toEqual({
      intervention: "seed",
      authority: "local",
      maxDeletePercent: 10,
    });
  });

  test("a remote request can never ride a local plan", () => {
    const verdict = checkPlanSemantics(plan, { intervention: "seed", authority: "remote" });
    expect(verdict.ok).toBe(false);
    expect(verdict.execution).toBeNull();
    expect(verdict.message).toContain("reviewed with this device authoritative");
  });

  test("a different intervention is refused", () => {
    const verdict = checkPlanSemantics(plan, { intervention: "resync", authority: "local" });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('reviewed as "seed"');
  });

  test("a different deletion threshold is refused", () => {
    const verdict = checkPlanSemantics(plan, {
      intervention: "seed",
      authority: "local",
      maxDeletePercent: 90,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("10%");
    expect(verdict.message).toContain("90%");
  });

  test("omitting the threshold means 'use the plan', not 'widen it'", () => {
    const verdict = checkPlanSemantics(plan, { intervention: "seed", authority: "local" });
    expect(verdict.execution?.maxDeletePercent).toBe(10);
  });

  test("initialize is bound to remote even when the request omits the side", () => {
    const initialize = { intervention: "initialize" as const, authority: "remote" as const, maxDeletePercent: null };
    expect(checkPlanSemantics(initialize, { intervention: "initialize" }).ok).toBe(true);
    expect(
      checkPlanSemantics(initialize, { intervention: "initialize", authority: "local" }).ok,
    ).toBe(false);
  });
});

describe("formatDeletePercent", () => {
  test("null names rclone's default rather than implying no cap", () => {
    expect(formatDeletePercent(null)).toBe("rclone's default (50%)");
    expect(formatDeletePercent(0)).toBe("0%");
    expect(formatDeletePercent(75)).toBe("75%");
    expect(BISYNC_MAX_DELETE_PERCENT_DEFAULT).toBe(50);
  });
});

describe("allowlisted tuning validators", () => {
  test("bisyncMaxDeletePercent is null or an integer percentage 0-100", () => {
    expect(validateBisyncMaxDeletePercent(null)).toBeNull();
    expect(validateBisyncMaxDeletePercent(0)).toBeNull();
    expect(validateBisyncMaxDeletePercent(100)).toBeNull();
    expect(validateBisyncMaxDeletePercent(-1)).toContain("bisyncMaxDeletePercent must be");
    expect(validateBisyncMaxDeletePercent(101)).toContain("bisyncMaxDeletePercent must be");
    // A file count is not a percentage: 1000000 is out of range.
    expect(validateBisyncMaxDeletePercent(1_000_000)).toContain("bisyncMaxDeletePercent must be");
    expect(validateBisyncMaxDeletePercent(1.5)).toContain("bisyncMaxDeletePercent must be");
  });

  test("mountCacheMode is one of the four rclone modes", () => {
    expect(validateMountCacheMode(null)).toBe(true);
    expect(validateMountCacheMode("writes")).toBe(true);
    expect(validateMountCacheMode("turbo")).toBe(false);
  });
});

// LAMA-345 follow-up (release-blocking): the reviewed plan is the execution
// contract, so "did the dry run report any content change?" is a first-class
// shared predicate — the server refuses an approval at the boundary and the
// daemon re-checks at dispatch with the SAME function.
describe("planHasContentChanges", () => {
  const empty = { wouldCopy: [], wouldDelete: [], wouldMkdir: [], files: 0, bytes: 0 };

  test("false only when every signal is empty", () => {
    expect(planHasContentChanges({ changes: empty })).toBe(false);
  });

  test("a single copy, delete or mkdir is a change", () => {
    expect(planHasContentChanges({ changes: { ...empty, wouldCopy: ["a"] } })).toBe(true);
    expect(planHasContentChanges({ changes: { ...empty, wouldDelete: ["a"] } })).toBe(true);
    expect(planHasContentChanges({ changes: { ...empty, wouldMkdir: ["d"] } })).toBe(true);
  });

  test("a reported total or byte count alone is still a change", () => {
    // rclone's stats can report work the bounded sample list did not carry.
    expect(planHasContentChanges({ changes: { ...empty, files: 349 } })).toBe(true);
    expect(planHasContentChanges({ changes: { ...empty, bytes: 803_465_460 } })).toBe(true);
  });
});
