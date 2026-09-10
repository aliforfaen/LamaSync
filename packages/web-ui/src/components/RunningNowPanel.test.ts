// LAMA-327 — RunningNowPanel pure reducer tests (repo convention: bun:test,
// no jsdom — the panel's state transitions are pure functions).

import { describe, expect, test } from "bun:test";
import type { LiveSyncProgress, WSEvent } from "@lamasync/core";
import {
  applySyncProgressEvent,
  mergeHydration,
  showEnumerationHint,
  sortRunsNewestFirst,
} from "./RunningNowPanel.tsx";

function run(overrides: Partial<LiveSyncProgress> = {}): LiveSyncProgress {
  return {
    runId: "run-1",
    hostId: "host-a",
    hostname: "cachy",
    folderId: "f1",
    folderName: "Projects",
    operation: "sync",
    phase: "enumerating",
    startedAt: 1_000,
    phaseStartedAt: 1_000,
    updatedAt: 1_000,
    elapsedMs: 0,
    transfers: null,
    bytes: null,
    checks: null,
    errors: null,
    files: null,
    detail: "building listings for both paths",
    ...overrides,
  };
}

function event(progress: LiveSyncProgress): WSEvent {
  return { kind: "sync_progress", progress };
}

describe("applySyncProgressEvent (LAMA-327)", () => {
  test("upserts a brand-new run", () => {
    const next = applySyncProgressEvent([], event(run()));
    expect(next).toHaveLength(1);
    expect(next[0]?.runId).toBe("run-1");
  });

  test("updates an existing run in place (same runId)", () => {
    const existing = [run()];
    const next = applySyncProgressEvent(
      existing,
      event(run({ phase: "transferring", transfers: 7, bytes: 4096 })),
    );
    expect(next).toHaveLength(1);
    expect(next[0]?.phase).toBe("transferring");
    expect(next[0]?.transfers).toBe(7);
  });

  test("removes the run on the terminal success phase", () => {
    const next = applySyncProgressEvent([run(), run({ runId: "run-2", startedAt: 2_000 })], event(run({ phase: "success" })));
    expect(next.map((r) => r.runId)).toEqual(["run-2"]);
  });

  test("removes the run on the terminal failed phase", () => {
    const next = applySyncProgressEvent([run()], event(run({ phase: "failed" })));
    expect(next).toHaveLength(0);
  });

  test("ignores non-sync_progress events", () => {
    const existing = [run()];
    const next = applySyncProgressEvent(existing, { kind: "operation", entry: {} as never });
    expect(next).toBe(existing);
  });
});

describe("mergeHydration (reconnect refresh)", () => {
  test("uses the authoritative snapshot and keeps terminal entries out", () => {
    const current = [
      run(),
      run({ runId: "run-2", phase: "transferring", startedAt: 2_000 }),
      run({ runId: "run-3", phase: "success" }), // should never be here, but...
    ];
    const fresh = [
      run({ runId: "run-2", phase: "finalizing", startedAt: 2_500 }),
      run({ runId: "run-4", startedAt: 3_000 }),
    ];
    const merged = mergeHydration(current, fresh);
    expect(merged.map((r) => r.runId).sort()).toEqual(["run-2", "run-4"]);
    expect(merged.find((r) => r.runId === "run-2")?.phase).toBe("finalizing");
  });

  test("sorts newest-started first", () => {
    const sorted = sortRunsNewestFirst([run({ startedAt: 100 }), run({ runId: "new", startedAt: 400 })]);
    expect(sorted.map((r) => r.runId)).toEqual(["new", "run-1"]);
  });
});

describe("showEnumerationHint (LAMA-327)", () => {
  test("true for pre-transfer phases with zero counters", () => {
    expect(showEnumerationHint(run({ phase: "enumerating" }))).toBe(true);
    expect(showEnumerationHint(run({ phase: "queued" }))).toBe(true);
    expect(showEnumerationHint(run({ phase: "working" }))).toBe(true);
    expect(showEnumerationHint(run({ phase: "lock", transfers: 0, bytes: 0 }))).toBe(true);
  });

  test("false once counters appear", () => {
    expect(showEnumerationHint(run({ phase: "enumerating", transfers: 1, bytes: 0 }))).toBe(false);
    expect(showEnumerationHint(run({ phase: "enumerating", bytes: 512 }))).toBe(false);
  });

  test("false for phases where transfers are already expected", () => {
    expect(showEnumerationHint(run({ phase: "transferring", transfers: 0, bytes: 0 }))).toBe(false);
    expect(showEnumerationHint(run({ phase: "finalizing", transfers: 0, bytes: 0 }))).toBe(false);
    expect(showEnumerationHint(run({ phase: "checking", transfers: 0, bytes: 0 }))).toBe(false);
  });
});
