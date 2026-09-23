// LAMA-346 Stage 2d — source-host authorization and per-role seed-job authority.
//
// Stage 2c's gap, asserted rather than described: the source device must be able
// to do its half of a seed with its OWN device key, the target must not be able
// to touch the source's half (or vice versa), a stranger must be refused, and the
// archive facts must be written exactly once and never rewritten.
//
// The archive route is the doubly-gated test-only surface (`LAMASYNC_SEED_E2E=1`
// AND `LAMASYNC_TEST=1`), so this suite toggles the seam per test and proves the
// 503 default is intact — the role rules must hold on BOTH sides of the gate.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import {
  MIGRATIONS,
  SERVER_SCHEMA,
  emptySeedJobArchiveFacts,
  type SeedJob,
  type SeedJobArchiveFacts,
} from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "seed-role-master-key-123";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "seed-role-secret-key-123";
delete process.env.LAMASYNC_SEED_E2E;
delete process.env.LAMASYNC_TEST;

const { getAuthPlugin } = await import("./auth.ts");
const { insertManagedApiKey, __setApiKeysDb, __resetApiKeysDb } = await import("./api-keys.ts");
const { folderSeedRoutes, __setDb: __setSeedDb } = await import("./routes/folder-seed.ts");
const { createSeedJob, getSeedJob } = await import("./seed-jobs.ts");

const SOURCE = "seed-source";
const TARGET = "seed-target";
const STRANGER = "seed-stranger";

let db: Database;
let app: { handle(request: Request): Promise<Response> };
let adminToken: string;
let sourceToken: string;
let targetToken: string;
let strangerToken: string;

function facts(overrides: Partial<SeedJobArchiveFacts> = {}): SeedJobArchiveFacts {
  return {
    ...emptySeedJobArchiveFacts("tar.gz"),
    bytes: 4096,
    sha256: "a".repeat(64),
    objectKey: "lamasync/seed/job-1/archive.tar.gz",
    memberCount: 7,
    manifestFingerprint: "b".repeat(64),
    manifestObjectKey: "lamasync/seed/job-1/manifest.json",
    manifestBytes: 512,
    manifestSha256: "c".repeat(64),
    uploadedAt: Date.now(),
    ...overrides,
  };
}

function jobInPhase(phase: string, lease: { owner: string; expiresAt: number } | null): SeedJob {
  const now = Date.now();
  return {
    id: "job-1",
    planId: "plan-1",
    folderId: "f1",
    hostId: TARGET,
    sourceHostId: SOURCE,
    assignmentId: "a2",
    status: lease === null ? "planned" : "running",
    phase: phase as SeedJob["phase"],
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
    source: {
      fileCount: 0,
      totalBytes: 0,
      measuredAt: now,
      measuredOnHostId: SOURCE,
      manifestFingerprint: null,
    },
    archive: emptySeedJobArchiveFacts("tar.gz"),
    staging: { path: "", targetPath: "/t/Projects", requiredFreeBytes: 0, freeBytesAtPlan: null },
    leaseOwner: lease?.owner ?? null,
    leaseExpiresAt: lease?.expiresAt ?? null,
    error: null,
    summary: null,
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    finishedAt: null,
  };
}

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
  db.exec(`
    INSERT INTO hosts (id, hostname, config_revision) VALUES ('${SOURCE}', 'source', 1);
    INSERT INTO hosts (id, hostname, config_revision) VALUES ('${TARGET}', 'target', 1);
    INSERT INTO hosts (id, hostname, config_revision) VALUES ('${STRANGER}', 'stranger', 1);
    INSERT INTO folders (id, name, type) VALUES ('f1', 'Projects', 'sync');
  `);
  __setApiKeysDb(db);
  adminToken = insertManagedApiKey({ name: "admin", kind: "admin", hostId: null }).token;
  sourceToken = insertManagedApiKey({ name: "source", kind: "device", hostId: SOURCE }).token;
  targetToken = insertManagedApiKey({ name: "target", kind: "device", hostId: TARGET }).token;
  strangerToken = insertManagedApiKey({ name: "stranger", kind: "device", hostId: STRANGER }).token;
  __setSeedDb(db);
  app = new Elysia().use(getAuthPlugin()).use(folderSeedRoutes);
});

afterEach(() => {
  __resetApiKeysDb();
  delete process.env.LAMASYNC_SEED_E2E;
  delete process.env.LAMASYNC_TEST;
  db.close();
});

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, { ...init, headers: new Headers(init.headers) });
}

function post(path: string, token: string, body?: unknown): Promise<Response> {
  return app.handle(
    request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function get(path: string, token: string): Promise<Response> {
  return app.handle(request(path, { headers: { Authorization: `Bearer ${token}` } }));
}

describe("the archive route stays test-gated", () => {
  test("without the seam it answers 503, and one variable alone is not the seam", async () => {
    let response = await post("/api/v1/seed-jobs/job-1/archive", sourceToken, facts());
    expect(response.status).toBe(503);

    process.env.LAMASYNC_SEED_E2E = "1";
    response = await post("/api/v1/seed-jobs/job-1/archive", sourceToken, facts());
    expect(response.status).toBe(503);

    delete process.env.LAMASYNC_SEED_E2E;
    process.env.LAMASYNC_TEST = "1";
    response = await post("/api/v1/seed-jobs/job-1/archive", sourceToken, facts());
    expect(response.status).toBe(503);
  });
});

describe("the source records its own facts, once", () => {
  beforeEach(() => {
    process.env.LAMASYNC_SEED_E2E = "1";
    process.env.LAMASYNC_TEST = "1";
    createSeedJob(db, jobInPhase("uploading_archive", { owner: SOURCE, expiresAt: Date.now() + 600_000 }));
  });

  test("the source device records the facts and hands the lease over", async () => {
    const response = await post("/api/v1/seed-jobs/job-1/archive", sourceToken, facts());
    expect(response.status).toBe(200);
    const job = (await response.json()) as SeedJob;
    expect(job.archive.sha256).toBe("a".repeat(64));
    expect(job.archive.manifestFingerprint).toBe("b".repeat(64));
    // The handover: the same statement recorded the facts and freed the lease,
    // so the target can claim without waiting for a 10-minute expiry.
    expect(job.leaseOwner).toBeNull();
    expect(job.leaseExpiresAt).toBeNull();
  });

  test("after the handover the source is finished, and the target may claim", async () => {
    await post("/api/v1/seed-jobs/job-1/archive", sourceToken, facts());
    // A late source progress line must NOT be able to re-claim the lease it just
    // handed over — that would strand the target behind a live holder.
    const lateSource = await post("/api/v1/seed-jobs/job-1/progress", sourceToken, {
      phase: "uploading_archive",
    });
    expect(lateSource.status).toBe(409);
    expect(((await lateSource.json()) as { error: string }).error).toContain("already recorded");
    expect(getSeedJob(db, "job-1")!.leaseOwner).toBeNull();

    // ...and the TARGET, which was authorized all along, now claims its half.
    const targetStart = await post("/api/v1/seed-jobs/job-1/progress", targetToken, {
      phase: "downloading_archive",
    });
    expect(targetStart.status).toBe(200);
    const started = (await targetStart.json()) as SeedJob;
    expect(started.phase).toBe("downloading_archive");
    expect(started.leaseOwner).toBe(TARGET);
    // ...and the source cannot take it back afterwards.
    const sourceTakeback = await post("/api/v1/seed-jobs/job-1/lease", sourceToken, {});
    expect(sourceTakeback.status).toBe(409);
    expect(getSeedJob(db, "job-1")!.leaseOwner).toBe(TARGET);
  });

  test("a byte-identical retry is idempotent", async () => {
    await post("/api/v1/seed-jobs/job-1/archive", sourceToken, facts());
    const retry = await post("/api/v1/seed-jobs/job-1/archive", sourceToken, facts({ uploadedAt: Date.now() + 5 }));
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as SeedJob).archive.sha256).toBe("a".repeat(64));
  });

  test("a differing digest is refused and the stored facts are untouched", async () => {
    await post("/api/v1/seed-jobs/job-1/archive", sourceToken, facts());
    const rewrite = await post(
      "/api/v1/seed-jobs/job-1/archive",
      sourceToken,
      facts({ sha256: "d".repeat(64) }),
    );
    expect(rewrite.status).toBe(409);
    expect(((await rewrite.json()) as { error: string }).error).toContain("immutable");
    const stored = getSeedJob(db, "job-1")!;
    expect(stored.archive.sha256).toBe("a".repeat(64));
  });

  test("a manifest-identity rewrite is refused too", async () => {
    await post("/api/v1/seed-jobs/job-1/archive", sourceToken, facts());
    for (const patch of [
      { manifestFingerprint: "d".repeat(64) },
      { manifestObjectKey: "lamasync/seed/job-1/evil.json" },
      { manifestSha256: "d".repeat(64) },
      { manifestBytes: 1 },
      { bytes: 1 },
      { memberCount: 1 },
      { objectKey: "lamasync/seed/job-1/evil.tar.gz" },
    ]) {
      const response = await post("/api/v1/seed-jobs/job-1/archive", sourceToken, facts(patch));
      expect(response.status).toBe(409);
    }
    const stored = getSeedJob(db, "job-1")!;
    expect(stored.archive.manifestObjectKey).toBe("lamasync/seed/job-1/manifest.json");
    expect(stored.archive.manifestFingerprint).toBe("b".repeat(64));
  });

  test("a lapsed source lease may not stamp facts over the new owner", async () => {
    db.run(
      "UPDATE folder_seed_jobs SET lease_owner = 'seed-source', lease_expires_at = ? WHERE id = 'job-1'",
      [Date.now() - 1_000],
    );
    const response = await post("/api/v1/seed-jobs/job-1/archive", sourceToken, facts());
    expect(response.status).toBe(409);
    expect(getSeedJob(db, "job-1")!.archive.sha256).toBeNull();
  });

  test("facts are refused from any phase but uploading_archive", async () => {
    db.run("UPDATE folder_seed_jobs SET phase = 'measuring_source' WHERE id = 'job-1'");
    const response = await post("/api/v1/seed-jobs/job-1/archive", sourceToken, facts());
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("uploading_archive");
  });

  test("the target may not author the source's facts", async () => {
    const response = await post("/api/v1/seed-jobs/job-1/archive", targetToken, facts());
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toContain("Only the source device");
    expect(getSeedJob(db, "job-1")!.archive.sha256).toBeNull();
  });

  test("a stranger may not author the facts", async () => {
    const response = await post("/api/v1/seed-jobs/job-1/archive", strangerToken, facts());
    expect(response.status).toBe(403);
  });

  test("the operator is not a producer and may not author the facts", async () => {
    const response = await post("/api/v1/seed-jobs/job-1/archive", adminToken, facts());
    expect(response.status).toBe(403);
  });

  test("a late report after cancellation is refused", async () => {
    await post("/api/v1/seed-jobs/job-1/cancel", adminToken);
    const response = await post("/api/v1/seed-jobs/job-1/archive", sourceToken, facts());
    expect(response.status).toBe(409);
    expect(getSeedJob(db, "job-1")!.archive.sha256).toBeNull();
  });
});

describe("the per-role permission matrix on one in-flight target job", () => {
  beforeEach(() => {
    process.env.LAMASYNC_SEED_E2E = "1";
    process.env.LAMASYNC_TEST = "1";
    // A job whose facts are recorded and whose lease has been handed over: the
    // TARGET is the party that should now own everything.
    const job = jobInPhase("downloading_archive", null);
    job.archive = facts();
    createSeedJob(db, job);
  });

  test("target may read, progress, lease and complete; it may not archive or cancel", async () => {
    expect((await get("/api/v1/seed-jobs/job-1", targetToken)).status).toBe(200);
    expect((await post("/api/v1/seed-jobs/job-1/archive", targetToken, facts())).status).toBe(403);
    expect(
      (await post("/api/v1/seed-jobs/job-1/progress", targetToken, { phase: "verifying_archive" })).status,
    ).toBe(200);
    expect((await post("/api/v1/seed-jobs/job-1/lease", targetToken, {})).status).toBe(200);
    expect((await post("/api/v1/seed-jobs/job-1/cancel", targetToken)).status).toBe(403);
  });

  test("source may read but may not touch the target's half", async () => {
    expect((await get("/api/v1/seed-jobs/job-1", sourceToken)).status).toBe(200);
    expect((await post("/api/v1/seed-jobs/job-1/progress", sourceToken, { phase: "verifying_archive" })).status).toBe(403);
    expect((await post("/api/v1/seed-jobs/job-1/lease", sourceToken, {})).status).toBe(409);
    expect((await post("/api/v1/seed-jobs/job-1/complete", sourceToken, { status: "completed" })).status).toBe(403);
  });

  test("a stranger may do none of it", async () => {
    expect((await get("/api/v1/seed-jobs/job-1", strangerToken)).status).toBe(403);
    expect((await post("/api/v1/seed-jobs/job-1/progress", strangerToken, { phase: "verifying_archive" })).status).toBe(403);
    expect((await post("/api/v1/seed-jobs/job-1/lease", strangerToken, {})).status).toBe(403);
    expect((await post("/api/v1/seed-jobs/job-1/complete", strangerToken, { status: "completed" })).status).toBe(403);
    expect((await post("/api/v1/seed-jobs/job-1/archive", strangerToken, facts())).status).toBe(403);
  });

  test("the operator may read and cancel, and may force a terminal outcome", async () => {
    expect((await get("/api/v1/seed-jobs/job-1", adminToken)).status).toBe(200);
    expect((await post("/api/v1/seed-jobs/job-1/cancel", adminToken)).status).toBe(200);
    expect(getSeedJob(db, "job-1")!.status).toBe("cancelled");
  });
});

describe("a device cannot forge a lease owner", () => {
  beforeEach(() => {
    createSeedJob(db, jobInPhase("preflight", null));
  });

  test("the progress route attributes the lease to the AUTHENTICATED device", async () => {
    const response = await post("/api/v1/seed-jobs/job-1/progress", sourceToken, {
      phase: "measuring_source",
      leaseOwner: TARGET,
    });
    expect(response.status).toBe(200);
    const job = (await response.json()) as SeedJob;
    expect(job.leaseOwner).toBe(SOURCE);
  });

  test("the lease route ignores a device-supplied owner", async () => {
    db.run(
      "UPDATE folder_seed_jobs SET status = 'running', phase = 'measuring_source', lease_owner = 'seed-source', lease_expires_at = ? WHERE id = 'job-1'",
      [Date.now() + 600_000],
    );
    const response = await post("/api/v1/seed-jobs/job-1/lease", sourceToken, { owner: TARGET });
    expect(response.status).toBe(200);
    expect(((await response.json()) as SeedJob).leaseOwner).toBe(SOURCE);
    expect(getSeedJob(db, "job-1")!.leaseOwner).toBe(SOURCE);
  });
});
