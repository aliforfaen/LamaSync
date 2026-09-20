// LAMA-345 stage 2/3 — plan parsing, summary wording, plan staleness and the
// allowlisted run control.

import { describe, expect, test } from "bun:test";
import type { Folder, FolderAssignment, HostConfig, OperationReport } from "@lamasync/core";
import { accumulateRcloneJsonLog } from "./executor.ts";
import {
  PLAN_CHANGE_CAP,
  buildPlanSummary,
  buildSyncPlan,
  parseDryRunChanges,
  recheckZeroContentExecution,
  runControlFor,
  runControlFromExecution,
  verifyPlanAgainstLive,
} from "./intervention.ts";

describe("parseDryRunChanges", () => {
  test("narrows the executor's dry-run details into a bounded change list", () => {
    const details = JSON.stringify({
      wouldCopy: ["/a", "/b", "/c"],
      wouldDelete: ["/d"],
      wouldMkdir: ["/e"],
      rclone: { bytes: 4096, transfers: 3 },
    });
    const changes = parseDryRunChanges(details);
    expect(changes.wouldCopy).toEqual(["/a", "/b", "/c"]);
    expect(changes.wouldDelete).toEqual(["/d"]);
    expect(changes.wouldMkdir).toEqual(["/e"]);
    expect(changes.files).toBe(3);
    expect(changes.bytes).toBe(4096);
  });

  test("malformed or absent details yield an empty, safe list", () => {
    expect(parseDryRunChanges(null)).toEqual({
      wouldCopy: [],
      wouldDelete: [],
      wouldMkdir: [],
      files: 0,
      bytes: 0,
    });
    expect(parseDryRunChanges("{not json")).toEqual({
      wouldCopy: [],
      wouldDelete: [],
      wouldMkdir: [],
      files: 0,
      bytes: 0,
    });
  });

  test("the change list is capped before it reaches the wire", () => {
    const many = Array.from({ length: 100 }, (_, i) => `/f${i}`);
    const changes = parseDryRunChanges(JSON.stringify({ wouldCopy: many }));
    expect(changes.wouldCopy.length).toBe(PLAN_CHANGE_CAP);
  });
});

describe("buildPlanSummary", () => {
  const empty = { wouldCopy: [], wouldDelete: [], wouldMkdir: [], files: 0, bytes: 0 };

  test("names the operation and the authoritative side, in plain language", () => {
    const summary = buildPlanSummary("initialize", "remote", empty, false);
    expect(summary).toContain("Initialize this host from remote");
    expect(summary).toContain("the remote wins conflicting files");
    expect(summary).toContain("no file changes detected");
    // Deleting files is never implied by the authority — only the dry run says.
    expect(summary).not.toContain("removed");
  });

  test("seeding the remote says this host wins conflicting files", () => {
    const summary = buildPlanSummary("seed", "local", empty, false);
    expect(summary).toContain("Seed the remote from this host");
    expect(summary).toContain("this device wins conflicting files");
  });

  test("counts the planned work and flags a filter change", () => {
    const summary = buildPlanSummary(
      "resync",
      "local",
      { wouldCopy: ["a", "b"], wouldDelete: ["c"], wouldMkdir: [], files: 2, bytes: 0 },
      true,
    );
    expect(summary).toContain("2 to copy");
    expect(summary).toContain("1 to delete");
    expect(summary).toContain("ignore/filter set changed");
  });

  test("a zero-change plan is labelled as a baseline rebuild, not a content run", () => {
    const summary = buildPlanSummary("resync", "local", empty, false);
    expect(summary).toContain("no file changes detected (baseline rebuild only)");
  });
});

describe("recheckZeroContentExecution (LAMA-345 baseline-only recovery)", () => {
  const empty = JSON.stringify({ wouldCopy: [], wouldDelete: [], wouldMkdir: [], rclone: { transfers: 0, deletes: 0, bytes: 0 } });
  const report = (over: Partial<OperationReport>): OperationReport => ({
    hostId: "dev-vm",
    operation: "sync",
    status: "success",
    summary: "dry run",
    details: empty,
    ...over,
  });

  test("a fresh dry run that still proves zero mutations approves the baseline rebuild", () => {
    const verdict = recheckZeroContentExecution(report({}));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.changes.files).toBe(0);
  });

  test("a fresh dry run that reveals transfers refuses the run as changed", () => {
    const changed = JSON.stringify({
      wouldCopy: ["/a", "/b"],
      wouldDelete: [],
      wouldMkdir: [],
      rclone: { transfers: 2, deletes: 0, bytes: 44 },
    });
    const verdict = recheckZeroContentExecution(report({ details: changed }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("changed");
      expect(verdict.message).toContain("2 file(s)");
    }
  });

  test("a revealed delete or mkdir also refuses the run", () => {
    const del = JSON.stringify({ wouldCopy: [], wouldDelete: ["/gone"], wouldMkdir: [], rclone: { transfers: 0, deletes: 1, bytes: 0 } });
    const mkdir = JSON.stringify({ wouldCopy: [], wouldDelete: [], wouldMkdir: ["/new"], rclone: { transfers: 0, deletes: 0, bytes: 0 } });
    expect(recheckZeroContentExecution(report({ details: del })).ok).toBe(false);
    expect(recheckZeroContentExecution(report({ details: mkdir })).ok).toBe(false);
  });

  test("a missing, failed or unreadable fresh dry run refuses — never assumed clean", () => {
    expect(recheckZeroContentExecution(null).ok).toBe(false);
    expect(recheckZeroContentExecution(report({ status: "failed" })).ok).toBe(false);
    expect(recheckZeroContentExecution(report({ details: null })).ok).toBe(false);
    expect(recheckZeroContentExecution(report({ details: "{not json" })).ok).toBe(false);
    const failed = recheckZeroContentExecution(report({ status: "failed" }));
    if (!failed.ok) expect(failed.reason).toBe("failed");
    const unreadable = recheckZeroContentExecution(report({ details: null }));
    if (!unreadable.ok) expect(unreadable.reason).toBe("unreadable");
  });
});

describe("verifyPlanAgainstLive", () => {
  const plan = {
    assignmentId: "a1",
    hostId: "dev-vm",
    folderId: "f1",
    expiresAt: 2_000,
    configRevision: 9,
    filterFingerprint: "fp",
    baselineFingerprint: "base",
    intervention: "seed" as const,
    authority: "local" as const,
    maxDeletePercent: 10 as number | null,
  };
  const requested = { intervention: "seed" as const, authority: "local" as const };
  const live = {
    assignmentId: "a1",
    hostId: "dev-vm",
    folderId: "f1",
    configRevision: 9,
    filterFingerprint: "fp",
    baselineFingerprint: "base",
    now: 1_000,
  };

  test("a current plan for the right assignment passes and yields the plan's own values", () => {
    const verdict = verifyPlanAgainstLive(plan, live, requested);
    expect(verdict.ok).toBe(true);
    expect(verdict.execution).toEqual({
      intervention: "seed",
      authority: "local",
      maxDeletePercent: 10,
    });
  });

  test("an expired plan is refused with the operator-facing reason", () => {
    const verdict = verifyPlanAgainstLive(plan, { ...live, now: 2_000 }, requested);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("expired");
    expect(verdict.execution).toBeNull();
  });

  test("a plan for another assignment is refused outright", () => {
    const verdict = verifyPlanAgainstLive(plan, { ...live, assignmentId: "a2" }, requested);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("missing");
  });

  test("a changed filter universe invalidates the plan", () => {
    const verdict = verifyPlanAgainstLive(
      plan,
      { ...live, filterFingerprint: "different" },
      requested,
    );
    expect(verdict.reason).toBe("filter_changed");
  });

  test("a rewritten baseline invalidates the plan", () => {
    const verdict = verifyPlanAgainstLive(
      plan,
      { ...live, baselineFingerprint: "different" },
      requested,
    );
    expect(verdict.reason).toBe("baseline_changed");
  });

  // The release-blocking correction: freshness alone is not enough. A plan is
  // bound to WHAT was reviewed.
  test("a local plan can never authorize a remote-authority resync", () => {
    const verdict = verifyPlanAgainstLive(plan, live, {
      intervention: "resync",
      authority: "remote",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("semantics");
    expect(verdict.execution).toBeNull();
  });

  test("a seed plan can never authorize a different intervention", () => {
    const verdict = verifyPlanAgainstLive(plan, live, {
      intervention: "resync",
      authority: "local",
    });
    expect(verdict.reason).toBe("semantics");
  });

  test("a plan reviewed at 10% can never be executed at 90%", () => {
    const verdict = verifyPlanAgainstLive(plan, live, {
      intervention: "seed",
      authority: "local",
      maxDeletePercent: 90,
    });
    expect(verdict.reason).toBe("semantics");
    expect(verdict.execution).toBeNull();
  });

  test("semantics are checked before freshness, so a mismatch reads as a mismatch", () => {
    const verdict = verifyPlanAgainstLive(
      plan,
      { ...live, now: 5_000, filterFingerprint: "different" },
      { intervention: "seed", authority: "remote" },
    );
    expect(verdict.reason).toBe("semantics");
  });
});

describe("runControlFor", () => {
  test("initialize pins remote (Path 1) authority", () => {
    expect(runControlFor("initialize", {})).toEqual({ mode: "initialize", authority: "remote" });
  });

  test("seed pins local (Path 2) authority", () => {
    expect(runControlFor("seed", {})).toEqual({ mode: "seed", authority: "local" });
  });

  test("resync carries the reviewed authority through", () => {
    expect(runControlFor("resync", { authority: "local" })).toEqual({
      mode: "resync",
      authority: "local",
    });
  });

  test("resume keeps the automated run shape (no resync)", () => {
    expect(runControlFor("resume", {})).toEqual({ mode: "normal" });
  });

  test("cancel never becomes an rclone run control", () => {
    expect(runControlFor("cancel", {})).toEqual({ mode: "normal" });
  });

  test("a deletion threshold travels with the run as a percentage", () => {
    expect(runControlFor("seed", { maxDeletePercent: 25 })).toEqual({
      mode: "seed",
      authority: "local",
      maxDeletePercent: 25,
    });
  });

  test("null/omitted means 'rclone default', not 'no cap', so no flag is built", () => {
    expect(runControlFor("seed", { maxDeletePercent: null })).toEqual({
      mode: "seed",
      authority: "local",
    });
    expect(runControlFor("seed", {})).toEqual({ mode: "seed", authority: "local" });
  });

  test("resume carries the threshold but never a resync", () => {
    expect(runControlFor("resume", { maxDeletePercent: 5 })).toEqual({
      mode: "normal",
      maxDeletePercent: 5,
    });
  });
});

describe("runControlFromExecution", () => {
  test("execution follows the reviewed plan values verbatim", () => {
    expect(
      runControlFromExecution({
        intervention: "resync",
        authority: "local",
        maxDeletePercent: 10,
      }),
    ).toEqual({ mode: "resync", authority: "local", maxDeletePercent: 10 });
  });

  test("a null threshold becomes 'no flag' rather than an explicit value", () => {
    expect(
      runControlFromExecution({
        intervention: "initialize",
        authority: "remote",
        maxDeletePercent: null,
      }),
    ).toEqual({ mode: "initialize", authority: "remote" });
  });
});

// ---------------------------------------------------------------------------
// Release-blocking regression: a reviewed plan's change list must be truthful.
//
// Production cachy: a local-authority resync dry run reported 0 copies /
// 0 deletes / 0 bytes, the plan was approved, and the real resync then
// transferred 349 files / 803,465,460 B. Two defects combined: the executor
// never parsed modern rclone's `skipped` dry-run marker, and a plan whose dry
// run reported nothing was still executable.
// ---------------------------------------------------------------------------
describe("buildSyncPlan — dry-run fidelity (LAMA-345 release-blocking)", () => {
  const assignment: FolderAssignment = {
    id: "a1",
    folderId: "f1",
    hostId: "dev-vm",
    role: "source",
    localPath: "/tmp/lamasync-plan-fidelity",
    enabled: true,
  };
  const folder: Folder = { id: "f1", name: "Projects", type: "sync" };
  const hostConfig: HostConfig = {
    host: { id: "dev-vm", hostname: "dev-vm", status: "online" },
    assignments: [assignment],
    folders: [folder],
    apps: [],
    rcloneConfig: "",
    serverTailnetIp: null,
    peers: [],
    pause: null,
  };
  const base = {
    assignment,
    folder,
    effectiveType: "sync" as const,
    hostConfig,
    hostId: "dev-vm",
    intervention: "resync" as const,
    authority: "local" as const,
    maxDeletePercent: 10,
    now: 1_000,
  };

  /** Real v1.68.2 `--resync --dry-run` lines (see executor-log.test.ts). */
  const REAL_DRY_RUN = [
    '{"level":"warning","msg":"Skipped copy as --dry-run is set (size 17)","object":"projects/a.txt","skipped":"copy"}',
    '{"level":"warning","msg":"Skipped copy as --dry-run is set (size 17)","object":"projects/b.txt","skipped":"copy"}',
    '{"level":"warning","msg":"Skipped delete as --dry-run is set (size 2)","object":"projects/stale.txt","skipped":"delete"}',
    '{"level":"warning","msg":"Transferred: 34 B","stats":{"bytes":34,"checks":2,"deletes":1,"errors":0,"transfers":2}}',
  ].join("\n");

  test("a real dry run yields a non-empty change list (never a phantom 0)", async () => {
    const acc = accumulateRcloneJsonLog(REAL_DRY_RUN, {
      files: 0,
      bytes: 0,
      errors: 0,
      checks: 0,
      transfers: 0,
      wouldCopy: [],
      wouldDelete: [],
      wouldMkdir: [],
    });
    const { wouldCopy, wouldDelete, wouldMkdir, ...stats } = acc;
    const report: OperationReport = {
      hostId: "dev-vm",
      folderId: "f1",
      operation: "sync",
      status: "success",
      summary: "dry-run: 2 would-copy, 1 would-delete",
      details: JSON.stringify({ rclone: stats, wouldCopy, wouldDelete, wouldMkdir }),
    };
    const plan = await buildSyncPlan({ ...base, runDryRun: async () => report });
    expect(plan.changes.wouldCopy).toEqual(["projects/a.txt", "projects/b.txt"]);
    expect(plan.changes.wouldDelete).toEqual(["projects/stale.txt"]);
    expect(plan.changes.files).toBe(3);
    expect(plan.changes.bytes).toBe(34);
    // The reviewed semantics survive verbatim.
    expect(plan.intervention).toBe("resync");
    expect(plan.authority).toBe("local");
    expect(plan.maxDeletePercent).toBe(10);
  });

  test("a failed dry run fails planning instead of becoming a 0-change plan", async () => {
    const failed: OperationReport = {
      hostId: "dev-vm",
      folderId: "f1",
      operation: "sync",
      status: "failed",
      summary: "rclone exited 1: cannot find prior listing",
    };
    await expect(buildSyncPlan({ ...base, runDryRun: async () => failed })).rejects.toThrow(
      /did not complete \(failed\)/,
    );
  });

  test("a missing dry-run report fails planning", async () => {
    await expect(buildSyncPlan({ ...base, runDryRun: async () => null })).rejects.toThrow(
      /did not run/,
    );
  });

  test("a deferred dry run (lock unavailable) is not a plan", async () => {
    const deferred: OperationReport = {
      hostId: "dev-vm",
      folderId: "f1",
      operation: "sync",
      status: "deferred",
      summary: "skipped: another run is in flight",
    };
    await expect(buildSyncPlan({ ...base, runDryRun: async () => deferred })).rejects.toThrow(
      /did not complete \(deferred\)/,
    );
  });
});
