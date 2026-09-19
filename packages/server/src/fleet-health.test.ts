// LAMA-345 follow-up — the server-side centralization.
//
// The point of this file: `updateAvailable`, `updateStatus`, the `/health`
// fleet summary and the offline/update notification sweep must all agree, and
// an "update available" claim must be backed by evidence (the device checked
// in at or after the release was published).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA, deriveUpdateStatus } from "@lamasync/core";
import {
  hostFromRow,
  readFleetHealth,
  releaseFactsFrom,
  updateStatusForRow,
  type HostRowLike,
} from "./fleet-health.ts";
import { listFolderHealth } from "./folder-health.ts";

let db: Database;

const PUBLISHED_AT = Date.parse("2026-09-10T12:00:00Z");
const RELEASE = { version: "0.3.11", publishedAt: new Date(PUBLISHED_AT).toISOString() };

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // idempotent
    }
  }
});

afterEach(() => {
  db.close();
});

function hostRow(over: Partial<HostRowLike> = {}): HostRowLike {
  return {
    id: "dev-vm",
    hostname: "dev-vm",
    tailnet_ip: null,
    last_seen: PUBLISHED_AT + 60_000,
    status: "online",
    lan_ip: null,
    version: "0.3.7",
    config_revision: 3,
    os: "Linux",
    storage_used_bytes: 100,
    host_class: "server",
    ...over,
  };
}

describe("hostFromRow — the one host serialization", () => {
  test("an online device on an older version has an actionable update", () => {
    const host = hostFromRow(hostRow(), RELEASE, PUBLISHED_AT + 120_000);
    expect(host.updateAvailable).toBe(true);
    expect(host.updateStatus?.kind).toBe("available");
    expect(host.updateStatus?.actionable).toBe(true);
  });

  test("a device offline since before the release is not called outdated", () => {
    const host = hostFromRow(
      hostRow({ last_seen: PUBLISHED_AT - 86_400_000, status: "offline" }),
      RELEASE,
      PUBLISHED_AT + 120_000,
    );
    // The wire-compat boolean must not claim an update it cannot prove.
    expect(host.updateAvailable).toBe(false);
    expect(host.updateStatus?.kind).toBe("not_evaluated");
    expect(host.updateStatus?.reason).toBe("checked_before_release");
    expect(host.updateStatus?.label).toContain("not been heard from since before");
  });

  test("the boundary is inclusive: lastSeen == publishedAt is eligible", () => {
    const host = hostFromRow(hostRow({ last_seen: PUBLISHED_AT }), RELEASE, PUBLISHED_AT + 1);
    expect(host.updateAvailable).toBe(true);
  });

  test("a never-seen host is unknown, never 'update available'", () => {
    const host = hostFromRow(
      hostRow({ last_seen: null, status: "unknown" }),
      RELEASE,
      PUBLISHED_AT + 1,
    );
    expect(host.updateAvailable).toBe(false);
    expect(host.updateStatus?.kind).toBe("not_evaluated");
    expect(host.updateStatus?.reason).toBe("never_seen");
  });

  test("no release information means nothing is claimed in either direction", () => {
    const host = hostFromRow(hostRow(), null, PUBLISHED_AT + 1);
    expect(host.updateAvailable).toBe(false);
    expect(host.updateStatus?.reason).toBe("no_release_info");
  });

  test("updateAvailable is exactly updateStatus.actionable for every shape", () => {
    const cases: Array<[HostRowLike, typeof RELEASE | null]> = [
      [hostRow(), RELEASE],
      [hostRow({ version: RELEASE.version }), RELEASE],
      [hostRow({ version: "9.9.9" }), RELEASE],
      [hostRow({ last_seen: null }), RELEASE],
      [hostRow({ version: null }), RELEASE],
      [hostRow({ last_seen: PUBLISHED_AT - 1 }), RELEASE],
      [hostRow(), null],
    ];
    for (const [row, release] of cases) {
      const host = hostFromRow(row, release, PUBLISHED_AT + 60_000);
      expect(host.updateAvailable).toBe(host.updateStatus?.actionable === true);
    }
  });

  test("releaseFactsFrom drops an unusable release instead of half-using it", () => {
    expect(releaseFactsFrom(null)).toBeNull();
    expect(releaseFactsFrom({ version: "", publishedAt: null })).toBeNull();
    expect(releaseFactsFrom({ version: RELEASE.version, publishedAt: RELEASE.publishedAt })).toEqual({
      version: RELEASE.version,
      publishedAt: RELEASE.publishedAt,
    });
  });

  test("class and status coercion is defensive", () => {
    const host = hostFromRow(hostRow({ host_class: "toaster", status: "melting" }), null);
    expect(host.hostClass).toBe("unknown");
    expect(host.status).toBe("unknown");
  });

  test("updateStatusForRow agrees with the full serialization", () => {
    const row = hostRow({ last_seen: PUBLISHED_AT - 10 });
    expect(updateStatusForRow(row, RELEASE)).toEqual(
      hostFromRow(row, RELEASE, PUBLISHED_AT).updateStatus!,
    );
  });
});

describe("readFleetHealth", () => {
  function seedHost(over: Partial<HostRowLike> = {}): void {
    const row = hostRow(over);
    db.run(
      `INSERT INTO hosts (id, hostname, last_seen, status, version, host_class)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.hostname, row.last_seen, row.status, row.version, row.host_class],
    );
  }

  /**
   * A facts blob that DERIVES the requested state. The summary now reads the
   * same derived records as the folder detail page, so a fixture whose stated
   * state contradicts its facts (the drift the browser pass found) would be
   * wrong by construction.
   */
  function factsJson(kind: "healthy" | "unsafe" | "resync_required" | "new_host" | "unknown"): string {
    const baseline =
      kind === "unsafe"
        ? { present: true, ready: false, error: true, path1Count: null, path2Count: null, updatedAt: 1, fingerprint: "p" }
        : kind === "resync_required"
          ? { present: true, ready: false, error: false, path1Count: null, path2Count: null, updatedAt: 1, fingerprint: "p" }
          : kind === "healthy"
            ? { present: true, ready: true, error: false, path1Count: 10, path2Count: 10, updatedAt: 1, fingerprint: "p" }
            : { present: false, ready: false, error: false, path1Count: null, path2Count: null, updatedAt: null, fingerprint: "none" };
    return JSON.stringify({
      folderType: "sync",
      effectiveType: "sync",
      enabled: true,
      paused: false,
      runInProgress: false,
      rcloneAvailable: true,
      localDir: "ok",
      freeSpaceBytes: 10_000_000_000,
      freeSpaceThresholdBytes: 1_000,
      watcher: { enabled: false, running: false, quietSec: 30 },
      filter: { fingerprint: "fp", source: "lamasyncignore", changedSinceBaseline: false },
      baseline,
      activePhase: null,
      pendingConflicts: 0,
      lastRun: kind === "healthy" ? { status: "success", summary: "ok", at: 1 } : null,
      measurement: null,
    });
  }

  function seedFolderHealth(
    over: {
      assignmentId?: string;
      folderId?: string;
      hostId?: string;
      kind?: "healthy" | "unsafe" | "resync_required" | "new_host" | "unknown";
      reasons?: string;
      reportedAt?: number;
    } = {},
  ): void {
    const kind = over.kind ?? "healthy";
    db.run(
      `INSERT INTO folder_health (assignment_id, folder_id, host_id, state, reasons, facts, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        over.assignmentId ?? "a1",
        over.folderId ?? "f1",
        over.hostId ?? "dev-vm",
        kind,
        over.reasons ?? "[]",
        factsJson(kind),
        over.reportedAt ?? Date.now(),
      ],
    );
  }

  const NOW = PUBLISHED_AT + 3 * 24 * 60 * 60_000;

  test("an empty fleet yields empty buckets, not a fake problem", () => {
    const summary = readFleetHealth(db, { release: RELEASE, now: NOW });
    expect(summary.buckets.needsIntervention.total).toBe(0);
    expect(summary.buckets.checkWhenOnline.total).toBe(0);
    expect(summary.buckets.unknownOrStale.total).toBe(0);
    expect(summary.healthy).toEqual({ folders: 0, hosts: 0 });
  });

  test("folder health rows are joined to their folder and host names", () => {
    seedHost();
    db.run(`INSERT INTO folders (id, name, type) VALUES ('f1', 'Projects', 'sync')`);
    seedFolderHealth({
      kind: "unsafe",
      reasons: JSON.stringify([
        { code: "baseline_error", message: "The saved sync record is unusable.", remediation: "Rebuild.", action: "resync" },
      ]),
    });
    const summary = readFleetHealth(db, { release: RELEASE, now: NOW });
    expect(summary.buckets.needsIntervention.total).toBe(1);
    const item = summary.buckets.needsIntervention.items[0]!;
    expect(item.title).toBe("Projects on dev-vm");
    // The detail is the SHARED derived reason, not the stored blob: one source
    // of copy means the dashboard cannot quote a stale message.
    expect(item.detail).toContain("saved sync record is unusable");
    expect(item.action).toBe("resync");
  });

  test("a report older than the shared budget is stale, not healthy", () => {
    seedHost();
    db.run(`INSERT INTO folders (id, name, type) VALUES ('f1', 'Projects', 'sync')`);
    seedFolderHealth({ kind: "healthy", reportedAt: NOW - 20 * 60_000 });
    const summary = readFleetHealth(db, { release: RELEASE, now: NOW });
    expect(summary.buckets.unknownOrStale.total).toBe(1);
    expect(summary.healthy.folders).toBe(0);
  });

  test("a fresh healthy report inside the budget counts as healthy", () => {
    seedHost();
    db.run(`INSERT INTO folders (id, name, type) VALUES ('f1', 'Projects', 'sync')`);
    seedFolderHealth({ kind: "healthy", reportedAt: NOW - 60_000 });
    expect(readFleetHealth(db, { release: RELEASE, now: NOW }).healthy.folders).toBe(1);
  });

  test("a missing always-on host is red and a sleeping laptop is not", () => {
    // Both on the current release so the update verdict does not add noise.
    seedHost({ id: "nas", hostname: "nas-1", host_class: "nas", status: "offline", last_seen: NOW - 3_600_000, version: RELEASE.version });
    seedHost({ id: "lap", hostname: "laptop", host_class: "laptop", status: "offline", last_seen: NOW - 7_200_000, version: RELEASE.version });
    const summary = readFleetHealth(db, { release: RELEASE, now: NOW });
    expect(summary.buckets.needsIntervention.total).toBe(1);
    expect(summary.buckets.needsIntervention.items[0]?.title).toBe("nas-1");
    expect(summary.buckets.checkWhenOnline.total).toBe(1);
    expect(summary.buckets.checkWhenOnline.items[0]?.tone).toBe("info");
  });

  test("an unevaluable update is counted separately and never listed as urgent", () => {
    seedHost({ last_seen: PUBLISHED_AT - 60_000, version: "0.3.7" });
    const summary = readFleetHealth(db, { release: RELEASE, now: NOW });
    expect(summary.updatesActionable).toBe(0);
    expect(summary.updatesNotEvaluated).toBe(1);
    expect(summary.buckets.needsIntervention.total).toBe(0);
    expect(summary.buckets.checkWhenOnline.total).toBe(0);
  });

  test("an actionable update is listed in the yellow bucket", () => {
    seedHost({ last_seen: NOW, version: "0.3.7" });
    const summary = readFleetHealth(db, { release: RELEASE, now: NOW });
    expect(summary.updatesActionable).toBe(1);
    expect(summary.buckets.checkWhenOnline.items.map((i) => i.kind)).toEqual(["update"]);
  });

  test("malformed stored reasons cannot break the read", () => {
    seedHost();
    db.run(`INSERT INTO folders (id, name, type) VALUES ('f1', 'Projects', 'sync')`);
    seedFolderHealth({ kind: "unsafe", reasons: "{not json" });
    const summary = readFleetHealth(db, { release: RELEASE, now: NOW });
    expect(summary.buckets.needsIntervention.total).toBe(1);
    // The reasons come from the shared derivation, not the stored blob, so the
    // item still carries an actionable suggestion.
    expect(summary.buckets.needsIntervention.items[0]?.action).toBe("resync");
  });

  test("the summary agrees with the folder detail read for the same folder", () => {
    // The regression this guards: the dashboard read the daemon's stored
    // `state` column while the folder card re-derived it, so a folder the
    // daemon called `unsafe` with healthy facts showed as urgent on the
    // dashboard and "Healthy" in its own card.
    seedHost();
    db.run(`INSERT INTO folders (id, name, type) VALUES ('f1', 'Projects', 'sync')`);
    seedFolderHealth({ kind: "healthy", reasons: JSON.stringify([{ code: "baseline_error", message: "stale claim", remediation: "x", action: "resync" }]) });

    const summary = readFleetHealth(db, { release: RELEASE, now: NOW });
    const detail = listFolderHealth(db, "f1", NOW);
    expect(detail.records).toHaveLength(1);
    // The stored `state` column says unsafe; both surfaces must report the
    // derived state instead.
    expect(detail.records[0]!.state).toBe("healthy");
    expect(summary.buckets.needsIntervention.total).toBe(0);
    expect(summary.healthy.folders).toBe(1);
  });

  test("a folder whose host row disappeared reports as not-heard-from, never as a data risk", () => {
    db.run(`INSERT INTO folders (id, name, type) VALUES ('f1', 'Projects', 'sync')`);
    seedFolderHealth({ kind: "unsafe", hostId: "gone" });
    const summary = readFleetHealth(db, { release: RELEASE, now: NOW });
    // No host evidence at all: the safe reading is "we do not know", which is
    // deliberately distinct from "broken" and never red.
    expect(summary.buckets.needsIntervention.total).toBe(0);
    expect(summary.buckets.unknownOrStale.total).toBe(1);
    expect(summary.buckets.unknownOrStale.items[0]?.title).toContain("Projects");
  });
});

describe("agreement with the core derivation", () => {
  test("the server read matches a direct core derivation over the same inputs", () => {
    const row = hostRow({ last_seen: PUBLISHED_AT - 5, status: "offline" });
    const direct = deriveUpdateStatus({
      currentVersion: row.version,
      lastSeen: row.last_seen,
      releaseVersion: RELEASE.version,
      releasePublishedAt: RELEASE.publishedAt,
    });
    expect(hostFromRow(row, RELEASE).updateStatus).toEqual(direct);
  });
});
