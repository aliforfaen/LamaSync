// LAMA-345 stage 2/3 — plan parsing, summary wording, plan staleness and the
// allowlisted run control.

import { describe, expect, test } from "bun:test";
import {
  PLAN_CHANGE_CAP,
  buildPlanSummary,
  parseDryRunChanges,
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
