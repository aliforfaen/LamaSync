// LAMA-345 stage 2/3 — plan parsing, summary wording, plan staleness and the
// allowlisted run control.

import { describe, expect, test } from "bun:test";
import {
  PLAN_CHANGE_CAP,
  buildPlanSummary,
  parseDryRunChanges,
  runControlFor,
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
    expect(summary).toContain("remote is authoritative");
    expect(summary).toContain("no file changes detected");
  });

  test("seeding the remote says this host wins", () => {
    const summary = buildPlanSummary("seed", "local", empty, false);
    expect(summary).toContain("Seed the remote from this host");
    expect(summary).toContain("this host is authoritative");
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
  };
  const live = {
    assignmentId: "a1",
    hostId: "dev-vm",
    folderId: "f1",
    configRevision: 9,
    filterFingerprint: "fp",
    baselineFingerprint: "base",
    now: 1_000,
  };

  test("a current plan for the right assignment passes", () => {
    expect(verifyPlanAgainstLive(plan, live).ok).toBe(true);
  });

  test("an expired plan is refused with the operator-facing reason", () => {
    const verdict = verifyPlanAgainstLive(plan, { ...live, now: 2_000 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("expired");
  });

  test("a plan for another assignment is refused outright", () => {
    const verdict = verifyPlanAgainstLive(plan, { ...live, assignmentId: "a2" });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("missing");
  });

  test("a changed filter universe invalidates the plan", () => {
    const verdict = verifyPlanAgainstLive(plan, { ...live, filterFingerprint: "different" });
    expect(verdict.reason).toBe("filter_changed");
  });

  test("a rewritten baseline invalidates the plan", () => {
    const verdict = verifyPlanAgainstLive(plan, { ...live, baselineFingerprint: "different" });
    expect(verdict.reason).toBe("baseline_changed");
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

  test("a deletion cap travels with the run when supplied", () => {
    expect(runControlFor("seed", { maxDelete: 25 })).toEqual({
      mode: "seed",
      authority: "local",
      maxDelete: 25,
    });
  });
});
