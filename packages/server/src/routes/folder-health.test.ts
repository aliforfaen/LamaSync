// LAMA-345 — folder health + reviewed plan routes.
//
// Covers: device-key host scoping, admin-only reads, the server-derived
// freshness fields, the pending-conflict overlay, the fleet-level
// "incomplete shared remote" cross-check (the dev-vm shape), plan validity
// and the assignment-ownership rule on plan reporting.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
import type { FolderHealthFacts } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "folder-health-master-key-123";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "folder-health-secret-key-123";

const { getAuthPlugin } = await import("../auth.ts");
const { insertManagedApiKey, __setApiKeysDb, __resetApiKeysDb } = await import("../api-keys.ts");
const { folderHealthRoutes, __setDb: __setHealthDb } = await import("./folder-health.ts");
const { __resetLiveProgressForTests } = await import("../live-progress.ts");

let db: Database;
let app: { handle(request: Request): Promise<Response> };
let masterToken: string;
let adminToken: string;
let deviceAToken: string;
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
    INSERT INTO hosts (id, hostname, config_revision) VALUES ('host-a', 'host-a', 4);
    INSERT INTO hosts (id, hostname, config_revision) VALUES ('host-b', 'host-b', 4);
    INSERT INTO folders (id, name, type) VALUES ('f1', 'Projects', 'sync');
    INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path, destination, enabled)
      VALUES ('a1', 'f1', 'host-a', 'both', '/home/a/Projects', 'Projects', 1);
    INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path, destination, enabled)
      VALUES ('a2', 'f1', 'host-b', 'both', '/home/b/Projects', 'Projects', 1);
  `);
  masterToken = process.env.LAMASYNC_API_KEY!;
  __setApiKeysDb(db);
  adminToken = insertManagedApiKey({ name: "admin", kind: "admin", hostId: null }).token;
  deviceAToken = insertManagedApiKey({ name: "dev-a", kind: "device", hostId: "host-a" }).token;
  deviceBToken = insertManagedApiKey({ name: "dev-b", kind: "device", hostId: "host-b" }).token;
  __resetLiveProgressForTests();
  __setHealthDb(db);
  app = new Elysia().use(getAuthPlugin()).use(folderHealthRoutes);
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
    localDir: "ok",
    freeSpaceBytes: 50_000_000_000,
    freeSpaceThresholdBytes: 1_000_000_000,
    watcher: { enabled: false, running: false, quietSec: 30 },
    filter: { fingerprint: "fp-1", source: "lamasyncignore", changedSinceBaseline: false },
    baseline: {
      present: true,
      ready: true,
      error: false,
      path1Count: 850,
      path2Count: 850,
      updatedAt: Date.now() - 1_000,
      fingerprint: "base-1",
    },
    activePhase: null,
    pendingConflicts: 0,
    lastRun: { status: "success", summary: "sync ok", at: Date.now() - 1_000 },
    measurement: null,
    ...overrides,
  };
}

async function reportHealth(
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.handle(
    request("/api/v1/folder-health", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function reportPlan(token: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(
    request("/api/v1/folder-plans", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function planBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "plan-1",
    hostId: "host-a",
    folderId: "f1",
    assignmentId: "a1",
    intervention: "initialize",
    authority: "remote",
    summary: "Initialize this host from remote — remote is authoritative.",
    changes: { wouldCopy: ["/a"], wouldDelete: [], wouldMkdir: [], files: 1, bytes: 10 },
    configRevision: 4,
    filterFingerprint: "fp-1",
    baselineFingerprint: "base-1",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe("POST /api/v1/folder-health", () => {
  test("records a device report and re-derives the state server-side", async () => {
    const res = await reportHealth(deviceAToken, {
      hostId: "host-a",
      folderId: "f1",
      state: "healthy",
      reasons: [{ code: "ok", message: "fine", remediation: "none", action: null }],
      facts: facts(),
      reportedAt: Date.now(),
    });
    expect(res.status).toBe(204);
    const row = db
      .query<{ state: string; assignment_id: string }, []>("SELECT state, assignment_id FROM folder_health")
      .get();
    expect(row?.assignment_id).toBe("a1");
    expect(row?.state).toBe("healthy");
  });

  test("a device may not report for another host", async () => {
    const res = await reportHealth(deviceBToken, {
      hostId: "host-a",
      folderId: "f1",
      state: "healthy",
      reasons: [],
      facts: facts(),
      reportedAt: Date.now(),
    });
    expect(res.status).toBe(403);
  });

  test("an assignment that does not exist for the host is a 404", async () => {
    db.run("DELETE FROM folder_assignments WHERE id = 'a1'");
    const res = await reportHealth(deviceAToken, {
      hostId: "host-a",
      folderId: "f1",
      state: "healthy",
      reasons: [],
      facts: facts(),
      reportedAt: Date.now(),
    });
    expect(res.status).toBe(404);
  });

  test("a mismatched assignmentId is a 400", async () => {
    const res = await reportHealth(deviceAToken, {
      hostId: "host-a",
      folderId: "f1",
      assignmentId: "a2",
      state: "healthy",
      reasons: [],
      facts: facts(),
      reportedAt: Date.now(),
    });
    expect(res.status).toBe(400);
  });

  test("malformed facts are rejected with 422", async () => {
    const res = await reportHealth(deviceAToken, {
      hostId: "host-a",
      folderId: "f1",
      state: "healthy",
      reasons: [],
      facts: { effectiveType: "sync" },
      reportedAt: Date.now(),
    });
    expect(res.status).toBe(422);
  });

  test("an unknown health state is rejected at the schema boundary", async () => {
    const res = await reportHealth(deviceAToken, {
      hostId: "host-a",
      folderId: "f1",
      state: "excellent",
      reasons: [],
      facts: facts(),
      reportedAt: Date.now(),
    });
    // The body schema's state union rejects it before the handler runs.
    expect(res.status).toBe(422);
  });
});

describe("GET /api/v1/folders/:id/health", () => {
  async function seedBothHosts(): Promise<void> {
    await reportHealth(deviceAToken, {
      hostId: "host-a",
      folderId: "f1",
      state: "healthy",
      reasons: [],
      facts: facts(),
      reportedAt: Date.now(),
    });
  }

  test("requires admin — a device key is refused", async () => {
    const res = await app.handle(
      request("/api/v1/folders/f1/health", {
        headers: { Authorization: `Bearer ${deviceAToken}` },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("returns the record with freshness accounting", async () => {
    await seedBothHosts();
    const res = await app.handle(
      request("/api/v1/folders/f1/health", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: { assignmentId: string; state: string; stale: boolean; measurementAgeMs: number | null }[];
      history: unknown[];
    };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.state).toBe("healthy");
    expect(body.records[0]!.stale).toBe(false);
    expect(body.records[0]!.measurementAgeMs).toBeNull();
    expect(body.history.length).toBeGreaterThan(0);
  });

  test("an old report is flagged stale rather than presented as current", async () => {
    await reportHealth(deviceAToken, {
      hostId: "host-a",
      folderId: "f1",
      state: "healthy",
      reasons: [],
      facts: facts(),
      reportedAt: Date.now() - 60 * 60_000,
    });
    const res = await app.handle(
      request("/api/v1/folders/f1/health", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    const body = (await res.json()) as { records: { stale: boolean; stalenessMs: number }[] };
    expect(body.records[0]!.stale).toBe(true);
    expect(body.records[0]!.stalenessMs).toBeGreaterThan(0);
  });

  test("the dev-vm fixture: a host that pulled only part of the shared remote is resync_required", async () => {
    // host-a seeded 850 entries; host-b sees only 3 of them on the same remote.
    await reportHealth(deviceAToken, {
      hostId: "host-a",
      folderId: "f1",
      state: "healthy",
      reasons: [],
      facts: facts(),
      reportedAt: Date.now(),
    });
    await reportHealth(deviceBToken, {
      hostId: "host-b",
      folderId: "f1",
      state: "healthy",
      reasons: [],
      facts: facts({
        baseline: {
          present: true,
          ready: true,
          error: false,
          path1Count: 3,
          path2Count: 3,
          updatedAt: Date.now(),
          fingerprint: "base-b",
        },
      }),
      reportedAt: Date.now(),
    });
    const res = await app.handle(
      request("/api/v1/folders/f1/health", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    const body = (await res.json()) as {
      records: { hostId: string; state: string; reasons: { code: string }[] }[];
    };
    const byHost = new Map(body.records.map((r) => [r.hostId, r]));
    expect(byHost.get("host-b")!.state).toBe("resync_required");
    expect(byHost.get("host-b")!.reasons.map((r) => r.code)).toContain("baseline_not_established");
    expect(byHost.get("host-a")!.state).toBe("healthy");
  });

  test("pending conflicts are folded in from the server's own conflict queue", async () => {
    await seedBothHosts();
    db.run(
      `INSERT INTO conflicts (id, host_id, folder_id, path, local_mtime, remote_mtime, status, created_at)
       VALUES ('c1', 'host-a', 'f1', 'x.txt', 1, 2, 'pending', ?)`,
      [Date.now()],
    );
    const res = await app.handle(
      request("/api/v1/folders/f1/health", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    const body = (await res.json()) as {
      records: { state: string; reasons: { code: string }[]; facts: { pendingConflicts: number } }[];
    };
    expect(body.records[0]!.state).toBe("recoverable");
    expect(body.records[0]!.reasons.map((r) => r.code)).toContain("conflicts_pending");
    expect(body.records[0]!.facts.pendingConflicts).toBe(1);
  });

  test("an unknown folder is a 404", async () => {
    const res = await app.handle(
      request("/api/v1/folders/nope/health", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/folder-plans and reads", () => {
  test("stores a device plan and returns it with a validity verdict", async () => {
    const created = await reportPlan(deviceAToken, planBody());
    expect(created.status).toBe(201);

    const res = await app.handle(
      request("/api/v1/folders/f1/plans", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const list = (await res.json()) as {
      plan: { id: string; authority: string };
      validity: { valid: boolean; reason: string | null };
    }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.plan.id).toBe("plan-1");
    expect(list[0]!.plan.authority).toBe("remote");
    // No health report exists yet, so there is no live identity to compare
    // against: expiry and the config revision still apply, and the plan reads
    // as current rather than falsely stale.
    expect(list[0]!.validity.valid).toBe(true);
  });

  test("a plan is valid once the live health matches what it was built from", async () => {
    await reportPlan(deviceAToken, planBody());
    await reportHealth(deviceAToken, {
      hostId: "host-a",
      folderId: "f1",
      state: "healthy",
      reasons: [],
      facts: facts(),
      reportedAt: Date.now(),
    });
    const res = await app.handle(
      request("/api/v1/folders/f1/plans", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    const list = (await res.json()) as { validity: { valid: boolean } }[];
    expect(list[0]!.validity.valid).toBe(true);
  });

  test("the daemon may read its own plan (and no one else's)", async () => {
    await reportPlan(deviceAToken, planBody());
    const own = await app.handle(
      request("/api/v1/folder-plans/plan-1", {
        headers: { Authorization: `Bearer ${deviceAToken}` },
      }),
    );
    expect(own.status).toBe(200);
    const foreign = await app.handle(
      request("/api/v1/folder-plans/plan-1", {
        headers: { Authorization: `Bearer ${deviceBToken}` },
      }),
    );
    expect(foreign.status).toBe(403);
  });

  test("a plan for an assignment that does not belong to the folder is refused", async () => {
    const res = await reportPlan(deviceAToken, planBody({ assignmentId: "does-not-exist" }));
    expect(res.status).toBe(404);
  });

  test("an unknown plan id is a 404", async () => {
    const res = await app.handle(
      request("/api/v1/folder-plans/nope", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(404);
  });
});
