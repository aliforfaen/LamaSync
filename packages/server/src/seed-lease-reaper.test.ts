// LAMA-346 Stage 2e — the seed job LEASE, against the real database.
//
// The daemon-side supervisor is tested where it lives. This file tests the
// SERVER half of the same contract, on the real schema and the real guarded
// writers, because the two have to agree about one number: how long a working
// side may go between renewals before the server is entitled to call it dead.
//
// Four things are pinned here:
//
//   1. an owner that renews inside the lease is NEVER reaped, and its phase
//      reports and handover write keep succeeding — including across a simulated
//      run far longer than the lease (the incident's shape);
//   2. an owner that stops renewing IS reaped, and every write afterwards is
//      refused rather than written;
//   3. a renewal after the lease has lapsed is REFUSED ("lapsed counts as lost,
//      so the reaper decides that job"), which is exactly why the supervisor's
//      grace window is bounded strictly inside the lease;
//   4. the handover window (facts recorded, lease cleared, still `running`) is
//      not reaped on sight, because that window is a healthy handover in flight.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MIGRATIONS,
  SERVER_SCHEMA,
  SEED_JOB_HANDOVER_GRACE_MS,
  SEED_JOB_LEASE_MS,
  SEED_JOB_LEASE_RENEW_INTERVAL_MS,
  emptySeedJobArchiveFacts,
  type SeedJob,
  type SeedJobArchiveFacts,
  type SeedJobPhase,
  type SeedJobPhaseOrTerminal,
} from "@lamasync/core";
import {
  createSeedJob,
  getSeedJob,
  reapStaleSeedJobs,
  renewSeedJobLeaseGuarded,
  reportSeedJobArchiveOnce,
  reportSeedJobProgressGuarded,
} from "./seed-jobs.ts";

let db: Database;

const JOB_ID = "stage2e-lease-job";
const SOURCE = "lease-source";
const TARGET = "lease-target";
const START = 1_700_000_000_000;

/**
 * A fixture whose mtime-bearing fields all come from a caller-supplied clock, so
 * a "long run" is simulated by moving that clock rather than by waiting.
 */
function jobFixture(now: number, overrides: Partial<SeedJob> = {}): SeedJob {
  return {
    id: JOB_ID,
    planId: "plan-1",
    folderId: "f1",
    hostId: TARGET,
    sourceHostId: SOURCE,
    assignmentId: "a-target",
    status: "running",
    phase: "preflight",
    progress: {
      phase: "preflight",
      phaseIndex: 0,
      phaseCount: 10,
      message: "",
      bytesDone: 0,
      bytesTotal: null,
      entriesDone: 0,
      entriesTotal: null,
      updatedAt: now,
    },
    source: { fileCount: 10, totalBytes: 1_000, measuredAt: now, measuredOnHostId: SOURCE, manifestFingerprint: null },
    archive: emptySeedJobArchiveFacts("tar.zstd"),
    staging: { path: "", targetPath: "/data/t", requiredFreeBytes: 1, freeBytesAtPlan: 10 },
    leaseOwner: null,
    leaseExpiresAt: null,
    error: null,
    summary: null,
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    finishedAt: null,
    ...overrides,
  };
}

function progress(phase: SeedJobPhase, now: number) {
  return {
    phase,
    phaseIndex: 0,
    phaseCount: 10,
    message: "",
    bytesDone: 0,
    bytesTotal: null,
    entriesDone: 0,
    entriesTotal: null,
    updatedAt: now,
  };
}

/** Report a phase as the SOURCE, exactly as the route does. */
function report(phase: SeedJobPhaseOrTerminal, now: number, owner = SOURCE, leaseMs = SEED_JOB_LEASE_MS) {
  return reportSeedJobProgressGuarded(db, JOB_ID, progress(phase as SeedJobPhase, now), {
    owner,
    expiresAt: now + leaseMs,
    now,
    fromPhase: (getSeedJob(db, JOB_ID)?.phase ?? "preflight") as SeedJobPhaseOrTerminal,
  });
}

/** Advance the source's half of the machine to `uploading_archive`. */
function reachUploadingArchive(now: number): void {
  for (const phase of ["measuring_source", "archiving_source", "uploading_archive"] as const) {
    now += 1_000;
    expect(report(phase, now)).not.toBeNull();
  }
}

/** A fresh job sitting in `uploading_archive`, holding a live lease. */
function freshUploadingArchive(): number {
  db.exec("DELETE FROM folder_seed_jobs");
  createSeedJob(db, jobFixture(START));
  reachUploadingArchive(START);
  return getSeedJob(db, JOB_ID)?.leaseExpiresAt ?? 0;
}

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // `CREATE INDEX IF NOT EXISTS` and friends are idempotent; the schema above
      // already created what some migrations add.
    }
  }
});

afterAll(() => {
  db.close();
});

describe("a healthy owner across a run longer than the lease", () => {
  test("renewing inside the lease is never reaped, and the handover still succeeds", () => {
    db.exec("DELETE FROM folder_seed_jobs");
    createSeedJob(db, jobFixture(START));
    reachUploadingArchive(START);

    const leaseGrantedAt = getSeedJob(db, JOB_ID)?.leaseExpiresAt ?? 0;
    expect(leaseGrantedAt).toBeGreaterThan(START);

    // Simulate a 60-minute stage in 1-minute steps: the timer fires every
    // `SEED_JOB_LEASE_RENEW_INTERVAL_MS`, and the reaper runs on every step.
    let now = START + 1_000;
    let reaped = 0;
    let renewals = 0;
    for (let minute = 0; minute < 60; minute += 1) {
      now += SEED_JOB_LEASE_RENEW_INTERVAL_MS;
      const renewed = renewSeedJobLeaseGuarded(
        db,
        JOB_ID,
        SOURCE,
        now + SEED_JOB_LEASE_MS,
        now,
        getSeedJob(db, JOB_ID)?.phase ?? "uploading_archive",
      );
      expect(renewed).not.toBeNull();
      renewals += 1;
      reaped += reapStaleSeedJobs(db, now);
    }
    expect(renewals).toBe(60);
    expect(reaped).toBe(0);

    const job = getSeedJob(db, JOB_ID);
    expect(job?.status).toBe("running");
    expect(job?.phase).toBe("uploading_archive");

    // And the handover write — the one that REQUIRES a live lease — works.
    const facts: SeedJobArchiveFacts = {
      ...emptySeedJobArchiveFacts("tar.zstd"),
      bytes: 4_096,
      sha256: "a".repeat(64),
      manifestFingerprint: "b".repeat(64),
      memberCount: 12,
      manifestObjectKey: "lamasync/seed/x/manifest.json",
      manifestBytes: 100,
      manifestSha256: "c".repeat(64),
      uploadedAt: now,
    };
    const handover = reportSeedJobArchiveOnce(db, JOB_ID, facts, {
      owner: SOURCE,
      now,
      fromPhase: "uploading_archive",
    });
    expect(handover).not.toBeNull();
    // The handover clears the lease: nothing is renewing and nobody holds it.
    expect(handover?.leaseOwner).toBeNull();
    expect(handover?.leaseExpiresAt).toBeNull();
    expect(reapStaleSeedJobs(db, now)).toBe(0);
  });

  test("the control case: the same run without renewals loses the job", () => {
    db.exec("DELETE FROM folder_seed_jobs");
    createSeedJob(db, jobFixture(START));
    reachUploadingArchive(START);

    const grantedUntil = getSeedJob(db, JOB_ID)?.leaseExpiresAt ?? 0;
    // The very same 60-minute stage, with no renewals.
    let now = grantedUntil;
    expect(reapStaleSeedJobs(db, now)).toBe(1);
    const job = getSeedJob(db, JOB_ID);
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("lease expired");

    // Every write after the reap is refused rather than written, which is the
    // behaviour a daemon that only renewed between stages would have met.
    const late = reportSeedJobProgressGuarded(
      db,
      JOB_ID,
      progress("uploading_archive", now),
      { owner: SOURCE, expiresAt: now + SEED_JOB_LEASE_MS, now, fromPhase: "failed" },
    );
    expect(late).toBeNull();
    const facts: SeedJobArchiveFacts = {
      ...emptySeedJobArchiveFacts("tar.zstd"),
      bytes: 1,
      sha256: "d".repeat(64),
      manifestFingerprint: "e".repeat(64),
      memberCount: 1,
    };
    expect(
      reportSeedJobArchiveOnce(db, JOB_ID, facts, { owner: SOURCE, now, fromPhase: "uploading_archive" }),
    ).toBeNull();
    expect(getSeedJob(db, JOB_ID)?.archive.sha256).toBeNull();
  });
});

describe("a lapsed lease is lost, not revivable", () => {
  test("renewal after expiry is refused, which bounds the supervisor's grace window", () => {
    // Each case starts from a fresh job: a successful renewal legitimately moves
    // the expiry, so sharing one row would test the previous assertion instead.
    const atExpiry = freshUploadingArchive();
    expect(renewSeedJobLeaseGuarded(db, JOB_ID, SOURCE, atExpiry + 1_000, atExpiry, "uploading_archive")).toBeNull();
    const afterExpiry = freshUploadingArchive();
    expect(
      renewSeedJobLeaseGuarded(db, JOB_ID, SOURCE, afterExpiry + 1_000, afterExpiry + 1_000, "uploading_archive"),
    ).toBeNull();
    const forAnother = freshUploadingArchive();
    expect(
      renewSeedJobLeaseGuarded(db, JOB_ID, TARGET, forAnother + 1_000, forAnother - 1, "uploading_archive"),
    ).toBeNull();
    const wrongPhase = freshUploadingArchive();
    expect(
      renewSeedJobLeaseGuarded(db, JOB_ID, SOURCE, wrongPhase + 1_000, wrongPhase - 1, "preflight"),
    ).toBeNull();
    // Inside the lease, for the owner, in its own phase: it works.
    const live = freshUploadingArchive();
    const renewed = renewSeedJobLeaseGuarded(db, JOB_ID, SOURCE, live + 1_000, live - 1, "uploading_archive");
    expect(renewed).not.toBeNull();
    expect(renewed?.leaseExpiresAt).toBe(live + 1_000);
    expect(renewed?.leaseOwner).toBe(SOURCE);
  });
});

describe("the handover window", () => {
  test("a running job with no lease is not reaped on sight, only after the grace", () => {
    db.exec("DELETE FROM folder_seed_jobs");
    createSeedJob(db, jobFixture(START));
    reachUploadingArchive(START);
    const expiry = getSeedJob(db, JOB_ID)?.leaseExpiresAt ?? 0;
    const facts: SeedJobArchiveFacts = {
      ...emptySeedJobArchiveFacts("tar.zstd"),
      bytes: 2_048,
      sha256: "f".repeat(64),
      manifestFingerprint: "0".repeat(64),
      memberCount: 3,
    };
    const handover = reportSeedJobArchiveOnce(db, JOB_ID, facts, {
      owner: SOURCE,
      now: expiry - 1,
      fromPhase: "uploading_archive",
    });
    expect(handover).not.toBeNull();
    expect(handover?.status).toBe("running");
    expect(handover?.leaseExpiresAt).toBeNull();

    const handedOverAt = handover?.updatedAt ?? 0;
    // The target normally claims immediately. A reaper running in that window
    // must NOT kill a healthy handover.
    expect(reapStaleSeedJobs(db, handedOverAt)).toBe(0);
    expect(reapStaleSeedJobs(db, handedOverAt + SEED_JOB_HANDOVER_GRACE_MS - 1)).toBe(0);
    expect(getSeedJob(db, JOB_ID)?.status).toBe("running");

    // Past the grace the target never showed up, so the job really is abandoned.
    expect(reapStaleSeedJobs(db, handedOverAt + SEED_JOB_HANDOVER_GRACE_MS)).toBe(1);
    expect(getSeedJob(db, JOB_ID)?.status).toBe("failed");
  });

  test("a handover in flight is claimable by the target, which then holds the lease", () => {
    db.exec("DELETE FROM folder_seed_jobs");
    createSeedJob(db, jobFixture(START));
    reachUploadingArchive(START);
    const expiry = getSeedJob(db, JOB_ID)?.leaseExpiresAt ?? 0;
    const facts: SeedJobArchiveFacts = {
      ...emptySeedJobArchiveFacts("tar.zstd"),
      bytes: 2_048,
      sha256: "1".repeat(64),
      manifestFingerprint: "2".repeat(64),
      memberCount: 3,
    };
    reportSeedJobArchiveOnce(db, JOB_ID, facts, { owner: SOURCE, now: expiry - 1, fromPhase: "uploading_archive" });
    const claimed = reportSeedJobProgressGuarded(db, JOB_ID, progress("downloading_archive", expiry), {
      owner: TARGET,
      expiresAt: expiry + SEED_JOB_LEASE_MS,
      now: expiry,
      fromPhase: "uploading_archive",
    });
    expect(claimed).not.toBeNull();
    expect(claimed?.leaseOwner).toBe(TARGET);
    expect(claimed?.phase).toBe("downloading_archive");
    // And the source cannot renew into the target's half.
    expect(
      renewSeedJobLeaseGuarded(db, JOB_ID, SOURCE, expiry + 10_000, expiry + 1, "downloading_archive"),
    ).toBeNull();
    expect(renewSeedJobLeaseGuarded(db, JOB_ID, TARGET, expiry + 10_000, expiry + 1, "downloading_archive")).not.toBeNull();
  });
});
