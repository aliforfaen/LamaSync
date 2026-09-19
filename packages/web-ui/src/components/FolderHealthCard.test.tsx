// LAMA-345 — the Folder health card's rendered surface.
//
// Repo convention: no jsdom. `react-dom/server` static markup pins the copy
// and the offered actions an operator actually sees (effects do not run, so
// the guided modal is never opened here — its pure gating rules live in
// ../folder-health.test.ts).

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FolderHealthFacts, FolderHealthRecord } from "@lamasync/core/folder-health";
import { FolderHealthCard } from "./FolderHealthCard.tsx";

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
    watcher: { enabled: true, running: true, quietSec: 30 },
    filter: { fingerprint: "fp", source: "lamasyncignore", changedSinceBaseline: false },
    baseline: {
      present: true,
      ready: true,
      error: false,
      path1Count: 42,
      path2Count: 42,
      updatedAt: 1,
      fingerprint: "base",
    },
    activePhase: null,
    pendingConflicts: 0,
    lastRun: { status: "success", summary: "sync ok", at: 1 },
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
    reasons: [
      { code: "ok", message: "Baseline is paired and the last run agreed.", remediation: "Nothing to do.", action: null },
    ],
    facts: facts(),
    reportedAt: Date.now(),
    stale: false,
    stalenessMs: 30_000,
    measurementAgeMs: null,
    active: false,
    ...overrides,
  };
}

function render(props: Parameters<typeof FolderHealthCard>[0]): string {
  return renderToStaticMarkup(<FolderHealthCard {...props} />);
}

describe("FolderHealthCard", () => {
  test("shows the state word, the reason and the remediation", () => {
    const html = render({ folderId: "f1", hostId: "dev-vm", record: record() });
    expect(html).toContain("Healthy");
    expect(html).toContain("Baseline is paired and the last run agreed.");
    expect(html).toContain("Nothing to do.");
  });

  test("states the baseline, filter, watcher and last-run facts", () => {
    const html = render({ folderId: "f1", hostId: "dev-vm", record: record() });
    expect(html).toContain("Baseline paired (remote 42 · local 42)");
    expect(html).toContain(".lamasyncignore");
    expect(html).toContain("Watcher running (quiet 30s)");
    expect(html).toContain("sync ok");
  });

  test("never presents an unmeasured folder as measured", () => {
    const html = render({ folderId: "f1", hostId: "dev-vm", record: record() });
    expect(html).toContain("Not measured");
  });

  test("offers Sync now only with a ready baseline", () => {
    const ready = render({ folderId: "f1", hostId: "dev-vm", record: record() });
    expect(ready).toContain("Sync now");
    expect(ready).not.toContain("Initialize this host from remote");

    const unseeded = render({
      folderId: "f1",
      hostId: "dev-vm",
      record: record({
        state: "new_host",
        reasons: [
          {
            code: "baseline_missing",
            message: "No baseline yet.",
            remediation: "Initialize this host from remote.",
            action: "initialize",
          },
        ],
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
    });
    expect(unseeded).not.toContain("Sync now");
    expect(unseeded).toContain("Initialize this host from remote");
    expect(unseeded).toContain("Seed remote from this host");
  });

  test("a stale report is labelled stale", () => {
    const html = render({
      folderId: "f1",
      hostId: "dev-vm",
      record: record({ stale: true, stalenessMs: 3 * 60 * 60_000 }),
    });
    expect(html).toContain("stale");
  });

  test("a running assignment shows the running badge and a Cancel action", () => {
    const html = render({
      folderId: "f1",
      hostId: "dev-vm",
      record: record({ state: "busy", active: true }),
    });
    expect(html).toContain("running");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Sync now");
  });

  test("an unusable baseline is called out as a critical error", () => {
    const html = render({
      folderId: "f1",
      hostId: "dev-vm",
      record: record({
        state: "unsafe",
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
    });
    expect(html).toContain("critical error");
    expect(html).toContain("Reseed baseline");
  });
});
