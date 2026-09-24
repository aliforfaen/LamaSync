// LAMA-346 Stage 1b — the transport's state lives on the JOB, not in a parallel
// table.
//
// The archive/transport facts are a field of the existing `folder_seed_jobs`
// row (`archive` JSON), so the transport adds no schema, no second source of
// truth and no second lifecycle. These tests pin that: the facts round-trip
// through the row, a malformed row normalizes fail-closed (the transport then
// refuses to download rather than trusting a shape it cannot verify against),
// and the cleanup state is recordable after the job has already ended — which
// is exactly when its objects become deletable.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MIGRATIONS,
  SERVER_SCHEMA,
  emptySeedJobArchiveFacts,
  initialSeedRelayCleanup,
  seedRelayArchiveKey,
  type SeedJob,
} from "@lamasync/core";
import {
  createSeedJob,
  finishSeedJob,
  getSeedJob,
  updateSeedJobArchive,
} from "./seed-jobs.ts";

const JOB_ID = "job-1";
const DIGEST = "a".repeat(64);
const MANIFEST = "b".repeat(64);

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // migrations are idempotent
    }
  }
  createSeedJob(db, plannedJob());
});

afterEach(() => {
  db.close();
});

function plannedJob(): SeedJob {
  return {
    id: JOB_ID,
    planId: "plan-1",
    folderId: "f1",
    hostId: "host-b",
    sourceHostId: "host-a",
    assignmentId: "a2",
    status: "planned",
    phase: "preflight",
    progress: {
      phase: "preflight",
      phaseIndex: 0,
      phaseCount: 10,
      message: "planned",
      bytesDone: 0,
      bytesTotal: null,
      entriesDone: 0,
      entriesTotal: null,
      updatedAt: 1,
    },
    source: { fileCount: 3, totalBytes: 30, measuredAt: 1, measuredOnHostId: "host-a", manifestFingerprint: null },
    archive: emptySeedJobArchiveFacts("tar.gz"),
    staging: { path: "/home/b/.lamasync-seed-staging-x", targetPath: "/home/b/Projects", requiredFreeBytes: 1, freeBytesAtPlan: 2 },
    leaseOwner: null,
    leaseExpiresAt: null,
    error: null,
    summary: null,
    createdAt: 1,
    startedAt: null,
    updatedAt: 1,
    finishedAt: null,
  };
}

describe("archive facts persist on the existing job row", () => {
  test("a planned job starts with explicitly empty transport facts", () => {
    const job = getSeedJob(db, JOB_ID)!;
    expect(job.archive).toEqual(emptySeedJobArchiveFacts("tar.gz"));
    expect(job.archive.objectKey).toBeNull();
    expect(job.archive.cleanup.state).toBe("not_started");
  });

  test("the uploaded metadata round-trips unchanged", () => {
    const uploaded = {
      ...emptySeedJobArchiveFacts("tar.zstd"),
      bytes: 4096,
      sha256: DIGEST,
      objectKey: seedRelayArchiveKey(JOB_ID, "tar.zstd"),
      memberCount: 7,
      manifestFingerprint: MANIFEST,
      uploadedAt: 1_000,
      verifiedAt: null,
      cleanup: initialSeedRelayCleanup(),
    };
    updateSeedJobArchive(db, JOB_ID, uploaded, 1_000);
    expect(getSeedJob(db, JOB_ID)!.archive).toEqual(uploaded);
  });

  test("the cleanup state is recordable after the job has ENDED", () => {
    // The objects become deletable exactly when the job ends, so the cleanup
    // write must not be blocked by a terminal status guard.
    finishSeedJob(db, JOB_ID, {
      status: "completed",
      phase: "completed",
      summary: "done",
      error: null,
      now: 2_000,
    });
    const cleaned = {
      ...emptySeedJobArchiveFacts("tar.gz"),
      bytes: 10,
      sha256: DIGEST,
      objectKey: seedRelayArchiveKey(JOB_ID, "tar.gz"),
      memberCount: 1,
      manifestFingerprint: MANIFEST,
      uploadedAt: 1_000,
      verifiedAt: 1_500,
      cleanup: {
        state: "cleaned" as const,
        attempts: 2,
        lastAttemptAt: 3_000,
        deletedKeys: [seedRelayArchiveKey(JOB_ID, "tar.gz")],
        message: null,
      },
    };
    updateSeedJobArchive(db, JOB_ID, cleaned, 3_000);
    const job = getSeedJob(db, JOB_ID)!;
    expect(job.status).toBe("completed");
    expect(job.archive.cleanup.state).toBe("cleaned");
    expect(job.archive.cleanup.deletedKeys).toEqual([seedRelayArchiveKey(JOB_ID, "tar.gz")]);
    // Recording transport facts never rewrites the job's OUTCOME.
    expect(job.summary).toBe("done");
    expect(job.finishedAt).toBe(2_000);
  });

  test("a malformed or partial row normalizes fail-closed on read", () => {
    db.run(`UPDATE folder_seed_jobs SET archive = ? WHERE id = ?`, [
      JSON.stringify({ format: "tar.zstd", bytes: -1, sha256: "nope", cleanup: { state: "???" } }),
      JOB_ID,
    ]);
    const archive = getSeedJob(db, JOB_ID)!.archive;
    expect(archive.format).toBe("tar.zstd");
    expect(archive.bytes).toBeNull();
    expect(archive.sha256).toBeNull();
    expect(archive.objectKey).toBeNull();
    expect(archive.cleanup.state).toBe("not_started");
    // Nothing to verify against means the transport refuses to download, which
    // is the point of normalizing instead of casting.
    expect(archive.sha256).toBeNull();

    db.run(`UPDATE folder_seed_jobs SET archive = ? WHERE id = ?`, ["not json at all", JOB_ID]);
    expect(getSeedJob(db, JOB_ID)!.archive).toEqual(emptySeedJobArchiveFacts("tar.gz"));
  });

  test("the transport adds NO column: the only extra one is Stage 2d's source authority", () => {
    const columns = db
      .query<{ name: string }, []>(`PRAGMA table_info(folder_seed_jobs)`)
      .all()
      .map((row) => row.name);
    expect(columns.sort()).toEqual([
      "archive",
      "assignment_id",
      "created_at",
      "error",
      "finished_at",
      "folder_id",
      "host_id",
      "id",
      "lease_expires_at",
      "lease_owner",
      "phase",
      "plan_id",
      "progress",
      "source",
      "source_host_id",
      "staging",
      "started_at",
      "status",
      "summary",
      "updated_at",
    ]);
  });
});
