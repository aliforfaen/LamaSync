// Pure-part tests for the action dispatcher (LAMA-198). The network and
// server-side paths live in `index.ts` and are covered by server-side
// route tests; these tests pin the payload-parsing + completion-building
// rules without mocking anything.

import { describe, expect, test } from "bun:test";
import type { FolderAssignment, QueuedAction } from "@lamasync/core";
import {
  isDryRunRequested,
  selectActionTargets,
  selectAssignmentsForSyncAction,
  summarizeBatchSync,
  summarizeConfigRefresh,
  summarizeReportForAction,
  summarizeUpdateCheck,
  unassignedFolderCompletion,
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

describe("summarizeBatchSync (LAMA-245)", () => {
  test("all-done batch collapses to '<verb> N folder(s)'", () => {
    const out = summarizeBatchSync(
      [
        { status: "done", result: "backup ok: 3 transfers, 1 KiB in 1s" },
        { status: "done", result: "backup ok: 0 transfers, 0 B in 0s" },
        { status: "done", result: "backup ok: 0 transfers, 0 B in 1s" },
      ],
      { verb: "backed up" },
    );
    expect(out).toEqual({ status: "done", result: "backed up 3 folder(s)" });
  });

  test("any-failed batch returns X/Y counts and failed status", () => {
    const out = summarizeBatchSync(
      [
        { status: "done", result: "ok 1" },
        { status: "failed", result: "backup timed out after 1200s" },
        { status: "done", result: "ok 3" },
      ],
      { verb: "backed up" },
    );
    expect(out.status).toBe("failed");
    expect(out.result).toBe(
      "backed up 2/3 folder(s), 1 failed: backup timed out after 1200s",
    );
  });

  test("'skipped: …' completions (mapped to 'done' upstream) are not counted as failures", () => {
    // Upstream `summarizeReportForAction` upgrades `"skipped: …"` to
    // `done`, so a batch with one lock-contention skip should still
    // report "all-OK" rather than 6/7 + 1 failed.
    const out = summarizeBatchSync(
      [
        { status: "done", result: "backup ok: 0 transfers, 0 B in 0s" },
        {
          status: "done",
          result: "skipped: folder locked by norheim (300s remaining)",
        },
        { status: "done", result: "backup ok: 0 transfers, 0 B in 0s" },
      ],
      { verb: "backed up" },
    );
    expect(out).toEqual({ status: "done", result: "backed up 3 folder(s)" });
  });

  test("dry-run prefix is applied when dryRun is true", () => {
    const out = summarizeBatchSync(
      [{ status: "done", result: "would-copy 5" }],
      { verb: "synced", dryRun: true },
    );
    expect(out.result.startsWith("dry-run: ")).toBe(true);
    expect(out.result).toBe("dry-run: synced 1 folder(s)");
  });

  test("long first-failure strings are truncated with an ellipsis", () => {
    const longFailure = "x".repeat(500);
    const out = summarizeBatchSync(
      [
        { status: "done", result: "ok" },
        { status: "failed", result: longFailure },
      ],
      { verb: "synced" },
    );
    expect(out.status).toBe("failed");
    expect(out.result.length).toBeLessThan(120);
    expect(out.result.endsWith("…")).toBe(true);
  });

  test("empty batch uses empty override when provided", () => {
    const out = summarizeBatchSync([], {
      verb: "synced",
      empty: "no sync assignments configured",
    });
    expect(out).toEqual({
      status: "done",
      result: "no sync assignments configured",
    });
  });

  test("empty batch without override defaults to '<verb> 0 folder(s)'", () => {
    const out = summarizeBatchSync([], { verb: "backed up" });
    expect(out).toEqual({ status: "done", result: "backed up 0 folder(s)" });
  });

  test("stays well under 200 chars even for pathological 100-folder batches", () => {
    const outcomes = Array.from({ length: 100 }, () => ({
      status: "done" as const,
      result: "backup ok: 0 transfers, 0 B in 0s",
    }));
    const out = summarizeBatchSync(outcomes, { verb: "backed up" });
    expect(out.result.length).toBeLessThan(50);
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

// LAMA-311: the action poller shares its 30 s tick with the heartbeat's
// config-revision check, so a claimed action can be resolved against a cache
// the server has already superseded. `selectActionTargets` refreshes once and
// re-selects before the dispatcher may declare a named folder unassigned.
describe("selectActionTargets (LAMA-311)", () => {
  type FolderType = "sync" | "backup" | "mount" | "dotfile" | "git";

  function source(options: {
    initial: readonly FolderAssignment[];
    fresh?: readonly FolderAssignment[];
    types?: ReadonlyMap<string, FolderType>;
    freshTypes?: ReadonlyMap<string, FolderType>;
    refreshResult?: boolean;
    onRefresh?: () => void;
  }): {
    assignments: () => readonly FolderAssignment[];
    folderTypes: () => ReadonlyMap<string, FolderType>;
    refreshConfig: () => Promise<boolean>;
    refreshes: () => number;
  } {
    let current = options.initial;
    let currentTypes = options.types ?? new Map();
    let refreshes = 0;
    return {
      assignments: () => current,
      folderTypes: () => currentTypes,
      refreshConfig: async () => {
        refreshes += 1;
        options.onRefresh?.();
        const ok = options.refreshResult ?? true;
        if (ok) {
          current = options.fresh ?? options.initial;
          currentTypes = options.freshTypes ?? currentTypes;
        }
        return ok;
      },
      refreshes: () => refreshes,
    };
  }

  test("stale cache → refresh once → reselect finds the folder", async () => {
    const deps = source({ initial: [A], fresh: [A, B] });
    const outcome = await selectActionTargets(
      { folderId: "f2" },
      { backupOnly: false, ...deps },
    );
    expect(outcome).toEqual({ targets: [B], refreshed: true, refreshFailed: false });
    expect(deps.refreshes()).toBe(1);
  });

  test("still absent after a successful refresh → empty, caller fails", async () => {
    const deps = source({ initial: [A], fresh: [A] });
    const outcome = await selectActionTargets(
      { folderId: "ghost" },
      { backupOnly: false, ...deps },
    );
    expect(outcome).toEqual({ targets: [], refreshed: true, refreshFailed: false });
    expect(deps.refreshes()).toBe(1);
  });

  test("refresh failure → refreshFailed, no second attempt", async () => {
    const deps = source({ initial: [A], refreshResult: false });
    const outcome = await selectActionTargets(
      { folderId: "f2" },
      { backupOnly: false, ...deps },
    );
    expect(outcome).toEqual({ targets: [], refreshed: true, refreshFailed: true });
    expect(deps.refreshes()).toBe(1);
  });

  test("an already-matching folder does not refresh", async () => {
    const deps = source({ initial: ALL });
    const outcome = await selectActionTargets(
      { folderId: "f1" },
      { backupOnly: false, ...deps },
    );
    expect(outcome).toEqual({ targets: [A], refreshed: false, refreshFailed: false });
    expect(deps.refreshes()).toBe(0);
  });

  test("host-wide payload (no folderId) never refreshes", async () => {
    const deps = source({ initial: [A] });
    const outcome = await selectActionTargets(null, { backupOnly: false, ...deps });
    expect(outcome).toEqual({ targets: [A], refreshed: false, refreshFailed: false });
    expect(deps.refreshes()).toBe(0);
  });

  test("backup filter is applied against the FRESH folder types", async () => {
    // Initially f2 is a plain sync folder (no backup match), so the selection
    // is empty and triggers the refresh; the fresh config says backup.
    const deps = source({
      initial: [B],
      types: new Map([["f2", "sync"]]),
      fresh: [B],
      freshTypes: new Map([["f2", "backup"]]),
    });
    const outcome = await selectActionTargets(
      { folderId: "f2" },
      { backupOnly: true, ...deps },
    );
    expect(outcome.targets).toEqual([B]);
    expect(outcome.refreshed).toBe(true);
    expect(outcome.refreshFailed).toBe(false);
  });

  test("backup host-wide filter still excludes non-backup folders after a miss", async () => {
    const deps = source({
      initial: [A],
      fresh: [A, B],
      freshTypes: new Map([["f1", "backup"], ["f2", "sync"]]),
    });
    const outcome = await selectActionTargets(
      { folderId: "f2" },
      { backupOnly: true, ...deps },
    );
    // f2 exists but is a sync folder — the explicit-match rule keeps it only
    // when the type is unknown, so a known non-backup type is filtered out.
    expect(outcome.targets).toEqual([]);
  });

  test("refresh is attempted at most once even for a backup miss", async () => {
    const deps = source({ initial: [], refreshResult: true, fresh: [] });
    await selectActionTargets({ folderId: "f9" }, { backupOnly: true, ...deps });
    expect(deps.refreshes()).toBe(1);
  });

  test("unassignedFolderCompletion names a refresh failure distinctly", () => {
    const clean = unassignedFolderCompletion("f1", "host-a", { refreshFailed: false });
    expect(clean).toEqual({
      status: "failed",
      result: "folderId=f1 not assigned to host=host-a",
    });
    const stale = unassignedFolderCompletion("f1", "host-a", { refreshFailed: true });
    expect(stale.status).toBe("failed");
    expect(stale.result).toContain("not assigned to host=host-a");
    expect(stale.result).toContain("config refresh failed");
  });
});