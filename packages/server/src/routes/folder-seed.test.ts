// LAMA-346 — seed plan + job routes.
//
// Covers: admin-only plan creation, the operator-approval requirement, the
// preflight built from reported facts (recommendation, space, tooling,
// staging policy), the explicit "execution not available" refusal (never a
// fake button), the phase state machine, the renewable lease, idempotent
// completion and admin-only cancellation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import {
  MIGRATIONS,
  SERVER_SCHEMA,
  SEED_ARCHIVE_TRANSPORT_IMPLEMENTED,
  SEED_RECOMMENDATION_FILE_THRESHOLD,
  type FolderHealthFacts,
  type SeedJob,
} from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "folder-seed-master-key-123";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "folder-seed-secret-key-123";

const { getAuthPlugin } = await import("../auth.ts");
const { insertManagedApiKey, __setApiKeysDb, __resetApiKeysDb } = await import("../api-keys.ts");
const { folderSeedRoutes, __setDb: __setSeedDb } = await import("./folder-seed.ts");
const { createSeedJob, getSeedJob, reapStaleSeedJobs } = await import("../seed-jobs.ts");

let db: Database;
let app: { handle(request: Request): Promise<Response> };
let adminToken: string;
let deviceBToken: string;

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
    INSERT INTO hosts (id, hostname, config_revision) VALUES ('host-a', 'master', 4);
    INSERT INTO hosts (id, hostname, config_revision) VALUES ('host-b', 'dev-vm', 4);
    INSERT INTO folders (id, name, type) VALUES ('f1', 'Projects', 'sync');
    INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path, destination, enabled)
      VALUES ('a1', 'f1', 'host-a', 'both', '/home/a/Projects', 'Projects', 1);
    INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path, destination, enabled)
      VALUES ('a2', 'f1', 'host-b', 'both', '/home/b/Projects', 'Projects', 1);
  `);
  __setApiKeysDb(db);
  adminToken = insertManagedApiKey({ name: "admin", kind: "admin", hostId: null }).token;
  deviceBToken = insertManagedApiKey({ name: "dev-b", kind: "device", hostId: "host-b" }).token;
  __setSeedDb(db);
  app = new Elysia().use(getAuthPlugin()).use(folderSeedRoutes);
});

afterEach(() => {
  __resetApiKeysDb();
  db.close();
});

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, { ...init, headers: new Headers(init.headers) });
}

function facts(overrides: Partial<FolderHealthFacts> = {}): FolderHealthFacts {
  return {
    folderType: "sync",
    effectiveType: "sync",
    enabled: true,
    paused: false,
    runInProgress: false,
    rcloneAvailable: true,
    archive: { tar: true, zstd: true, gzip: true },
    localDir: "ok",
    freeSpaceBytes: 100_000_000_000,
    freeSpaceThresholdBytes: 1_000_000_000,
    watcher: { enabled: false, running: false, quietSec: 30 },
    filter: { fingerprint: "fp-1", source: "lamasyncignore", changedSinceBaseline: false },
    baseline: {
      present: false,
      ready: false,
      error: false,
      path1Count: null,
      path2Count: null,
      updatedAt: null,
      fingerprint: "none",
    },
    activePhase: null,
    pendingConflicts: 0,
    lastRun: null,
    measurement: null,
    ...overrides,
  };
}

/** Seed a health row directly so the plan builder has reported facts. */
function insertHealth(
  assignmentId: string,
  folderId: string,
  hostId: string,
  overrides: Partial<FolderHealthFacts>,
): void {
  db.run(
    `INSERT INTO folder_health (assignment_id, folder_id, host_id, state, reasons, facts, reported_at)
     VALUES (?, ?, ?, 'new_host', '[]', ?, ?)
     ON CONFLICT(assignment_id) DO UPDATE SET facts = excluded.facts, reported_at = excluded.reported_at`,
    [assignmentId, folderId, hostId, JSON.stringify(facts(overrides)), Date.now()],
  );
}

function createPlan(token: string, hostId: string, confirm = true): Promise<Response> {
  return app.handle(
    request("/api/v1/folders/f1/seed-plans", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ hostId, confirm }),
    }),
  );
}

function seedJobFixture(overrides: Partial<SeedJob> = {}): SeedJob {
  const now = Date.now();
  return {
    id: "job-1",
    planId: "plan-1",
    folderId: "f1",
    hostId: "host-b",
    assignmentId: "a2",
    status: "planned",
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
    source: { fileCount: 91_660, totalBytes: 14_864_173_809, measuredAt: now, measuredOnHostId: "host-a", manifestFingerprint: null },
    archive: { format: "tar.zstd", bytes: null, sha256: null, objectKey: null, memberCount: null },
    staging: { path: "/home/b/.lamasync-seed-staging-Projects-job-1", targetPath: "/home/b/Projects", requiredFreeBytes: 1, freeBytesAtPlan: 100_000_000_000 },
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

describe("seed plan creation", () => {
  test("is admin-only and requires explicit operator approval", async () => {
    insertHealth("a2", "f1", "host-b", {});
    const asDevice = await createPlan(deviceBToken, "host-b");
    expect(asDevice.status).toBe(403);

    const noConfirm = await createPlan(adminToken, "host-b", false);
    // Elysia's schema rejects a missing/invalid `confirm` at the boundary (422);
    // the handler's own parse is the second line of defence.
    expect(noConfirm.status).toBe(422);
  });

  test("404s for a device that is not assigned to the folder", async () => {
    const response = await createPlan(adminToken, "host-zzz");
    expect(response.status).toBe(404);
  });

  test("builds a recommendation and space reservation from reported facts", async () => {
    // Source (host-a) has the real 91,660-entry measurement; target (host-b)
    // is a fresh device with plenty of free space and zstd installed.
    insertHealth("a1", "f1", "host-a", {
      measurement: { pathCount: 91_660, totalBytes: 14_864_173_809, measuredAt: Date.now() },
    });
    insertHealth("a2", "f1", "host-b", { freeSpaceBytes: 200_000_000_000 });

    const response = await createPlan(adminToken, "host-b");
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      plan: {
        hostId: string;
        recommendation: { recommended: boolean; thresholdFiles: number };
        source: { fileCount: number; totalBytes: number; measuredOnHostId: string | null };
        space: { ok: boolean; requiredFreeBytes: number; targetFreeBytes: number | null };
        archive: { format: string; toolingReady: boolean; fallback: boolean };
        stagingPolicy: { adjacentToTarget: boolean; insideTarget: boolean };
        execution: { available: boolean; reason: string };
      };
      validity: { valid: boolean };
    };
    expect(body.plan.hostId).toBe("host-b");
    expect(body.plan.recommendation.recommended).toBe(true);
    expect(body.plan.recommendation.thresholdFiles).toBe(SEED_RECOMMENDATION_FILE_THRESHOLD);
    expect(body.plan.source.fileCount).toBe(91_660);
    expect(body.plan.source.measuredOnHostId).toBe("host-a");
    expect(body.plan.space.ok).toBe(true);
    expect(body.plan.space.requiredFreeBytes).toBeGreaterThan(2 * 14_864_173_809);
    expect(body.plan.archive.format).toBe("tar.zstd");
    expect(body.plan.archive.toolingReady).toBe(true);
    expect(body.plan.archive.fallback).toBe(false);
    // Staging is a sibling by construction — never inside the target.
    expect(body.plan.stagingPolicy.adjacentToTarget).toBe(true);
    expect(body.plan.stagingPolicy.insideTarget).toBe(false);
    // Execution is explicitly unavailable.
    expect(body.plan.execution.available).toBe(SEED_ARCHIVE_TRANSPORT_IMPLEMENTED);
    expect(body.plan.execution.available).toBe(false);
    expect(body.plan.execution.reason).toContain("not implemented yet");
    // The plan is valid as a plan even though it cannot be executed.
    expect(body.validity.valid).toBe(true);
  });

  test("a plan is created but NOT runnable when the source was never measured", async () => {
    insertHealth("a2", "f1", "host-b", { freeSpaceBytes: 200_000_000_000 });
    const response = await createPlan(adminToken, "host-b");
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      plan: { space: { ok: boolean; message: string }; recommendation: { recommended: boolean } };
      validity: { valid: boolean; reason: string | null; message: string };
    };
    expect(body.plan.space.ok).toBe(false);
    expect(body.plan.space.message).toContain("source device has not been measured");
    expect(body.plan.recommendation.recommended).toBe(false);
    expect(body.validity.valid).toBe(false);
    expect(body.validity.reason).toBe("not_runnable");
  });

  test("falls back to tar.gz when the target has not reported archive tooling", async () => {
    insertHealth("a1", "f1", "host-a", {
      measurement: { pathCount: 91_660, totalBytes: 14_864_173_809, measuredAt: Date.now() },
    });
    insertHealth("a2", "f1", "host-b", { archive: null });
    const response = await createPlan(adminToken, "host-b");
    const body = (await response.json()) as {
      plan: { archive: { format: string; toolingReady: boolean; fallback: boolean; choiceReason: string } };
      validity: { valid: boolean };
    };
    expect(body.plan.archive.format).toBe("tar.gz");
    expect(body.plan.archive.toolingReady).toBe(false);
    expect(body.plan.archive.fallback).toBe(true);
    expect(body.plan.archive.choiceReason).toContain("has not reported its archive tooling");
    expect(body.validity.valid).toBe(false);
  });

  test("lists and reads plans with a validity verdict", async () => {
    insertHealth("a1", "f1", "host-a", {
      measurement: { pathCount: 91_660, totalBytes: 14_864_173_809, measuredAt: Date.now() },
    });
    insertHealth("a2", "f1", "host-b", {});
    const created = (await (await createPlan(adminToken, "host-b")).json()) as { plan: { id: string } };

    const list = await app.handle(
      request("/api/v1/folders/f1/seed-plans", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(list.status).toBe(200);
    const plans = (await list.json()) as Array<{ plan: { id: string }; validity: { valid: boolean } }>;
    expect(plans.length).toBe(1);
    expect(plans[0]!.plan.id).toBe(created.plan.id);

    const one = await app.handle(
      request(`/api/v1/seed-plans/${created.plan.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(one.status).toBe(200);

    const deviceRead = await app.handle(
      request(`/api/v1/seed-plans/${created.plan.id}`, {
        headers: { Authorization: `Bearer ${deviceBToken}` },
      }),
    );
    expect(deviceRead.status).toBe(200);
  });
});

describe("seed job creation is explicitly unavailable", () => {
  test("refuses with the exact reason instead of pretending", async () => {
    insertHealth("a1", "f1", "host-a", {
      measurement: { pathCount: 91_660, totalBytes: 14_864_173_809, measuredAt: Date.now() },
    });
    insertHealth("a2", "f1", "host-b", {});
    const created = (await (await createPlan(adminToken, "host-b")).json()) as { plan: { id: string } };
    const response = await app.handle(
      request("/api/v1/seed-jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ planId: created.plan.id, confirm: true }),
      }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: string;
      executionAvailable: boolean;
      planId: string;
    };
    expect(body.executionAvailable).toBe(false);
    expect(body.error).toContain("not implemented yet");
    expect(body.planId).toBe(created.plan.id);
    // No job row was created.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM folder_seed_jobs").get()?.n).toBe(0);
  });
});

describe("seed job progress, lease and terminal states", () => {
  beforeEach(() => {
    createSeedJob(db, seedJobFixture());
  });

  test("a device reports a legal phase transition and renews its lease", async () => {
    const response = await app.handle(
      request("/api/v1/seed-jobs/job-1/progress", {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceBToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          phase: "measuring_source",
          message: "measuring the source tree",
          bytesDone: 10,
          bytesTotal: 100,
          entriesDone: 1,
          entriesTotal: 5,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const job = (await response.json()) as SeedJob;
    expect(job.status).toBe("running");
    expect(job.phase).toBe("measuring_source");
    expect(job.progress.bytesDone).toBe(10);
    expect(job.leaseOwner).toBe("host-b");
    expect(job.leaseExpiresAt).toBeGreaterThan(Date.now());
  });

  test("an illegal phase transition is refused", async () => {
    const response = await app.handle(
      request("/api/v1/seed-jobs/job-1/progress", {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceBToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "publishing" }),
      }),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("illegal phase transition");
  });

  test("a different device cannot report progress for this job", async () => {
    const otherToken = insertManagedApiKey({ name: "dev-a", kind: "device", hostId: "host-a" }).token;
    const response = await app.handle(
      request("/api/v1/seed-jobs/job-1/progress", {
        method: "POST",
        headers: { Authorization: `Bearer ${otherToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "measuring_source" }),
      }),
    );
    expect(response.status).toBe(403);
  });

  test("completion is idempotent and freezes the outcome", async () => {
    const first = await app.handle(
      request("/api/v1/seed-jobs/job-1/complete", {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceBToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed", summary: "seeded 91,660 entries" }),
      }),
    );
    expect(first.status).toBe(200);
    const completed = (await first.json()) as SeedJob;
    expect(completed.status).toBe("completed");
    expect(completed.finishedAt).not.toBeNull();

    const second = await app.handle(
      request("/api/v1/seed-jobs/job-1/complete", {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceBToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "failed", error: "rewrite attempt" }),
      }),
    );
    const after = (await second.json()) as SeedJob;
    expect(after.status).toBe("completed");
    expect(after.error).toBeNull();

    // A late progress report cannot reopen a finished job.
    const late = await app.handle(
      request("/api/v1/seed-jobs/job-1/progress", {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceBToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "extracting_target" }),
      }),
    );
    expect(late.status).toBe(409);
  });

  test("cancel is admin-only and terminal", async () => {
    const asDevice = await app.handle(
      request("/api/v1/seed-jobs/job-1/cancel", {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceBToken}` },
      }),
    );
    expect(asDevice.status).toBe(403);

    const asAdmin = await app.handle(
      request("/api/v1/seed-jobs/job-1/cancel", {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(asAdmin.status).toBe(200);
    const cancelled = (await asAdmin.json()) as SeedJob;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.phase).toBe("cancelled");
  });

  test("a running job whose lease expires is reaped, never silently kept", () => {
    db.run(
      "UPDATE folder_seed_jobs SET status = 'running', phase = 'archiving_source', lease_expires_at = ? WHERE id = 'job-1'",
      [Date.now() - 1_000],
    );
    expect(reapStaleSeedJobs(db)).toBe(1);
    const reaped = getSeedJob(db, "job-1")!;
    expect(reaped.status).toBe("failed");
    expect(reaped.error).toContain("lease expired");
  });
});
