import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "operations-test-key";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-operations-test-data";

const { getAuthPlugin } = await import("../auth.ts");
const { __setDb, operationsRoutes } = (await import("./operations.ts")) as typeof import("./operations.ts");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // Migrations are intentionally idempotent for pre-existing schemas.
    }
  }
  db.exec(`
    INSERT INTO hosts (id, hostname) VALUES ('host-a', 'host-a'), ('host-b', 'host-b');
    INSERT INTO folders (id, name, type) VALUES ('f1', 'folder1', 'sync');
    INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path, enabled)
      VALUES ('a1', 'f1', 'host-a', 'both', '/tmp/f1', 1);
    INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path, enabled)
      VALUES ('a2', 'f1', 'host-b', 'both', '/tmp/f1-b', 1);
    INSERT INTO schedule_state (folder_assignment_id)
      VALUES ('a1'), ('a2');
  `);
  __setDb(db);
  app = new Elysia().use(getAuthPlugin()).use(operationsRoutes);
});

afterEach(() => {
  db.close();
});

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${process.env.LAMASYNC_API_KEY}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(
    request(path, { method: "POST", body: JSON.stringify(body) }),
  );
}

describe("operations lock routes", () => {
  test("acquires, renews, and releases a folder lock", async () => {
    const acquired = await post("/api/v1/operations/acquire", {
      folderId: "f1",
      hostId: "host-a",
    });
    expect(acquired.status).toBe(200);
    const acquiredBody = (await acquired.json()) as {
      lockId: string;
      ttl: number;
      acquired: boolean;
    };
    expect(acquiredBody.acquired).toBe(true);
    expect(acquiredBody.lockId).toEqual(expect.any(String));
    expect(acquiredBody.ttl).toBe(1200);

    const heartbeat = await post("/api/v1/operations/heartbeat", {
      folderId: "f1",
      hostId: "host-a",
      lockId: acquiredBody.lockId,
    });
    expect(heartbeat.status).toBe(200);
    const heartbeatBody = (await heartbeat.json()) as { ok: boolean; renewedAt: number };
    expect(heartbeatBody.ok).toBe(true);
    expect(heartbeatBody.renewedAt).toEqual(expect.any(Number));

    const release = await post("/api/v1/operations/release", {
      folderId: "f1",
      hostId: "host-a",
      status: "success",
      summary: "sync complete",
      lockId: acquiredBody.lockId,
    });
    expect(release.status).toBe(200);
    expect(await release.json()).toEqual({ ok: true });

    const locks = await app.handle(request("/api/v1/operations/locks"));
    expect(locks.status).toBe(200);
    expect(await locks.json()).toEqual([]);
  });

  test("rejects competing owners and mismatched lock IDs", async () => {
    const acquired = await post("/api/v1/operations/acquire", {
      folderId: "f1",
      hostId: "host-a",
    });
    const { lockId } = (await acquired.json()) as { lockId: string };

    const competingAcquire = await post("/api/v1/operations/acquire", {
      folderId: "f1",
      hostId: "host-b",
    });
    expect(competingAcquire.status).toBe(409);
    expect(await competingAcquire.json()).toMatchObject({
      error: "folder_locked",
      lockedBy: "host-a",
    });

    const competingHeartbeat = await post("/api/v1/operations/heartbeat", {
      folderId: "f1",
      hostId: "host-b",
      lockId,
    });
    expect(competingHeartbeat.status).toBe(409);
    expect(await competingHeartbeat.json()).toMatchObject({
      error: "lock_held_by_other",
      lockedBy: "host-a",
    });

    const wrongHeartbeat = await post("/api/v1/operations/heartbeat", {
      folderId: "f1",
      hostId: "host-a",
      lockId: "wrong-lock-id",
    });
    expect(wrongHeartbeat.status).toBe(409);
    expect(await wrongHeartbeat.json()).toEqual({ error: "lock_id_mismatch" });

    const competingRelease = await post("/api/v1/operations/release", {
      folderId: "f1",
      hostId: "host-b",
      status: "failed",
      lockId,
    });
    expect(competingRelease.status).toBe(409);
    expect(await competingRelease.json()).toMatchObject({
      error: "lock_held_by_other",
    });
  });
});
