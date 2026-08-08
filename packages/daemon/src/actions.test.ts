// Pure-part tests for the action dispatcher (LAMA-198). The network and
// server-side paths live in `index.ts` and are covered by server-side
// route tests; these tests pin the payload-parsing + completion-building
// rules without mocking anything.

import { describe, expect, test } from "bun:test";
import type { FolderAssignment, QueuedAction } from "@lamasync/core";
import {
  isDryRunRequested,
  selectAssignmentsForSyncAction,
  summarizeConfigRefresh,
  summarizeReportForAction,
  summarizeUpdateCheck,
  validateActionShape,
} from "./actions.ts";

function assignment(overrides: Partial<FolderAssignment>): FolderAssignment {
  return {
    id: "a1",
    folderId: "f1",
    hostId: "host-a",
    role: "both",
    localPath: "/tmp/a",
    enabled: true,
    ...overrides,
  };
}

const A = assignment({ id: "a1", folderId: "f1" });
const B = assignment({ id: "a2", folderId: "f2" });
const C = assignment({ id: "a3", folderId: "f3" });
const ALL = [A, B, C];

describe("selectAssignmentsForSyncAction", () => {
  test("no folderId in payload returns every assignment", () => {
    expect(selectAssignmentsForSyncAction(ALL, null, { backupOnly: false })).toEqual([
      A,
      B,
      C,
    ]);
    expect(selectAssignmentsForSyncAction(ALL, {}, { backupOnly: false })).toEqual([
      A,
      B,
      C,
    ]);
  });

  test("matching folderId filters to that single assignment", () => {
    expect(
      selectAssignmentsForSyncAction(ALL, { folderId: "f2" }, { backupOnly: false }),
    ).toEqual([B]);
  });

  test("unknown folderId returns an empty list", () => {
    expect(
      selectAssignmentsForSyncAction(ALL, { folderId: "ghost" }, { backupOnly: false }),
    ).toEqual([]);
  });

  test("non-string folderId values are ignored (treated as 'all')", () => {
    expect(
      selectAssignmentsForSyncAction(ALL, { folderId: 42 }, { backupOnly: false }),
    ).toEqual([A, B, C]);
  });

  test("backupOnly with no folder-type lookup returns nothing (safety)", () => {
    // Without a folder-type lookup we can't tell which assignments are
    // backup folders, so we drop everything rather than risk running the
    // wrong type of sync. The daemon always supplies the lookup at runtime.
    expect(
      selectAssignmentsForSyncAction(ALL, null, { backupOnly: true }),
    ).toEqual([]);
  });

  test("backupOnly with folder-types filters to backup + dotfile assignments (LAMA-219)", () => {
    const folderTypes = new Map<string, "sync" | "backup" | "mount" | "dotfile" | "git">([
      ["f1", "backup"],
      ["f2", "sync"],
      ["f3", "dotfile"],
    ]);
    expect(
      selectAssignmentsForSyncAction(ALL, null, { backupOnly: true, folderTypes }),
    ).toEqual([A, C]);
  });

  test("backupOnly with a folderId still keeps the explicit match (LAMA-219: dotfile match)", () => {
    const folderTypes = new Map<string, "sync" | "backup" | "mount" | "dotfile" | "git">([
      ["f1", "sync"],
      ["f2", "dotfile"],
    ]);
    expect(
      selectAssignmentsForSyncAction(
        ALL,
        { folderId: "f2" },
        { backupOnly: true, folderTypes },
      ),
    ).toEqual([B]);
  });

  test("backupOnly with a folderId keeps a sync match when lookup is missing (LAMA-219)", () => {
    // Without a folder-type lookup we still keep the explicit match —
    // refusing a user-requested folder because we don't know its type
    // would be worse UX than firing it.
    expect(
      selectAssignmentsForSyncAction(
        ALL,
        { folderId: "f2" },
        { backupOnly: true },
      ),
    ).toEqual([B]);
  });

  test("dryRun in the payload does not change selection (flag is execution-only)", () => {
    // The dry-run flag is read by the dispatcher and forwarded into
    // `runOnce(assignment, { dryRun })` → `executeAssignment`; it must not
    // filter which assignments run.
    expect(
      selectAssignmentsForSyncAction(
        ALL,
        { folderId: "f2", dryRun: true },
        { backupOnly: false },
      ),
    ).toEqual([B]);
    expect(
      selectAssignmentsForSyncAction(
        ALL,
        { dryRun: true },
        { backupOnly: false },
      ),
    ).toEqual([A, B, C]);
  });
});

describe("isDryRunRequested", () => {
  test("true only when the payload carries dryRun exactly true", () => {
    expect(isDryRunRequested({ dryRun: true })).toBe(true);
    expect(isDryRunRequested({ folderId: "f1", dryRun: true })).toBe(true);
  });

  test("false for absent, falsy, or non-boolean values", () => {
    expect(isDryRunRequested(null)).toBe(false);
    expect(isDryRunRequested({})).toBe(false);
    expect(isDryRunRequested({ dryRun: false })).toBe(false);
    expect(isDryRunRequested({ dryRun: "yes" })).toBe(false);
    expect(isDryRunRequested({ dryRun: 1 })).toBe(false);
  });
});

describe("summarizeReportForAction", () => {
  test("success maps to done with the report summary", () => {
    expect(
      summarizeReportForAction("success", "ok", "fallback"),
    ).toEqual({ status: "done", result: "ok" });
  });

  test("'skipped: …' failures map to done (lock contention is not an error)", () => {
    expect(
      summarizeReportForAction(
        "failed",
        "skipped: folder locked by host-b (60s remaining)",
        "synced folder=f1",
      ),
    ).toEqual({
      status: "done",
      result: "skipped: folder locked by host-b (60s remaining)",
    });
  });

  test("real failures (no 'skipped:' prefix) map to failed", () => {
    expect(
      summarizeReportForAction("failed", "disk full", "fallback"),
    ).toEqual({ status: "failed", result: "disk full" });
  });

  test("conflict status maps to failed", () => {
    expect(
      summarizeReportForAction("conflict", "two-sided change", "fallback"),
    ).toEqual({ status: "failed", result: "two-sided change" });
  });

  test("null summary falls back to the provided default", () => {
    expect(
      summarizeReportForAction("success", null, "default"),
    ).toEqual({ status: "done", result: "default" });
  });
});

describe("summarizeUpdateCheck", () => {
  test("equal versions produce an 'up to date' message", () => {
    expect(summarizeUpdateCheck("0.2.3", "0.2.3")).toEqual({
      status: "done",
      result: "up to date (v0.2.3)",
    });
  });

  test("newer latest produces an 'update available' message", () => {
    expect(summarizeUpdateCheck("0.2.3", "0.3.0")).toEqual({
      status: "done",
      result: "update available: v0.3.0 (current v0.2.3)",
    });
  });
});

describe("summarizeConfigRefresh", () => {
  test("singular for one assignment, plural otherwise", () => {
    expect(summarizeConfigRefresh(0)).toEqual({
      status: "done",
      result: "refreshed config (0 assignments)",
    });
    expect(summarizeConfigRefresh(1)).toEqual({
      status: "done",
      result: "refreshed config (1 assignment)",
    });
    expect(summarizeConfigRefresh(7)).toEqual({
      status: "done",
      result: "refreshed config (7 assignments)",
    });
  });
});

describe("validateActionShape", () => {
  function baseAction(): QueuedAction {
    return {
      id: "abc",
      hostId: "host-a",
      type: "trigger_sync",
      payload: null,
      status: "pending",
      createdAt: 1,
    };
  }

  test("returns the action when all required fields are present", () => {
    expect(validateActionShape(baseAction())).toEqual(baseAction());
  });

  test("rejects non-objects", () => {
    expect(validateActionShape(null)).toBeNull();
    expect(validateActionShape("hi")).toBeNull();
    expect(validateActionShape(42)).toBeNull();
  });

  test("rejects unknown action types", () => {
    const bad: unknown = { ...baseAction(), type: "wipe_disk" };
    expect(validateActionShape(bad)).toBeNull();
  });

  test("rejects unknown status values", () => {
    const bad: unknown = { ...baseAction(), status: "lost" };
    expect(validateActionShape(bad)).toBeNull();
  });

  test("rejects non-string id/hostId and non-number createdAt", () => {
    expect(validateActionShape({ ...baseAction(), id: 5 })).toBeNull();
    expect(validateActionShape({ ...baseAction(), hostId: 5 })).toBeNull();
    expect(validateActionShape({ ...baseAction(), createdAt: "1" })).toBeNull();
  });
});