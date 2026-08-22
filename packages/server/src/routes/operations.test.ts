import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "operations-test-key";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-operations-test-data";

const { getAuthPlugin } = await import("../auth.ts");
const { subscribe } = (await import("../ws.ts")) as typeof import("../ws.ts");
const { __setDb, operationsRoutes, reapExpiredFolderLocks } =
  (await import("./operations.ts")) as typeof import("./operations.ts");

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

describe("operations GET /operations", () => {
  const seedOperationRows = (): void => {
    const now = Date.now();
    db.exec(`DELETE FROM operation_log;`);
    const insert = db.prepare(
      `INSERT INTO operation_log (timestamp, host_id, folder_id, operation, status, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // 5 entries: newest first is host-a/success at now+4, oldest is host-b/failed at now.
    for (let i = 0; i < 5; i++) {
      insert.run(
        now + i,
        i % 2 === 0 ? "host-a" : "host-b",
        "f1",
        "sync",
        i % 2 === 0 ? "success" : "failed",
        `entry-${i}`,
      );
    }
  };

  test("defaults to newest-first ordering with default limit", async () => {
    seedOperationRows();
    const res = await app.handle(request("/api/v1/operations"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ summary: string; timestamp: number }>;
    expect(body).toHaveLength(5);
    // Newest first.
    expect(body[0]?.summary).toBe("entry-4");
    expect(body.at(-1)?.summary).toBe("entry-0");
  });

  test("honors ?limit=N", async () => {
    seedOperationRows();
    const res = await app.handle(request("/api/v1/operations?limit=2"));
    const body = (await res.json()) as Array<{ summary: string }>;
    expect(body).toHaveLength(2);
    expect(body[0]?.summary).toBe("entry-4");
    expect(body[1]?.summary).toBe("entry-3");
  });

  test("honors ?offset=N for pagination", async () => {
    seedOperationRows();
    const res = await app.handle(request("/api/v1/operations?limit=2&offset=2"));
    const body = (await res.json()) as Array<{ summary: string }>;
    expect(body).toHaveLength(2);
    expect(body[0]?.summary).toBe("entry-2");
    expect(body[1]?.summary).toBe("entry-1");
  });

  test("filters by hostId and status", async () => {
    seedOperationRows();
    const res = await app.handle(
      request("/api/v1/operations?hostId=host-a&status=success"),
    );
    const body = (await res.json()) as Array<{ hostId: string; status: string }>;
    expect(body.length).toBeGreaterThan(0);
    for (const row of body) {
      expect(row.hostId).toBe("host-a");
      expect(row.status).toBe("success");
    }
  });
});

describe("reapExpiredFolderLocks (LAMA-244)", () => {
  const seedLockRow = (
    folderId: string,
    lockedBy: string | null,
    lockedAt: number | null,
    lockTtl: number | null,
    lockId: string | null,
  ): void => {
    db.run(
      `INSERT OR REPLACE INTO folder_locks (folder_id, locked_by, locked_at, lock_ttl, lock_id)
       VALUES (?, ?, ?, ?, ?)`,
      [folderId, lockedBy, lockedAt, lockTtl, lockId],
    );
  };

  const countLocks = (folderId: string): number => {
    const row = db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM folder_locks WHERE folder_id = ?",
      )
      .get(folderId);
    return row?.c ?? 0;
  };

  test("deletes rows whose locked_at + lock_ttl*1000 <= now", () => {
    const now = 1_700_000_000_000;
    // Acquired 1500s ago with a 1200s TTL → 300s past expiry.
    seedLockRow("f1", "host-a", now - 1500_000, 1200, "old-lock");
    // Acquired 1199s ago with a 1200s TTL → 1s before expiry.
    seedLockRow("f2", "host-b", now - 1199_000, 1200, "fresh-lock");

    const out = reapExpiredFolderLocks(now);
    expect(out.deleted).toBe(1);
    expect(countLocks("f1")).toBe(0);
    expect(countLocks("f2")).toBe(1);
  });

  test("keeps rows still within TTL", () => {
    const now = 1_700_000_000_000;
    seedLockRow("f1", "host-a", now, 1200, "active-lock");

    const out = reapExpiredFolderLocks(now);
    expect(out.deleted).toBe(0);
    expect(countLocks("f1")).toBe(1);
  });

  test("keeps rows with NULL locked_at or NULL lock_ttl", () => {
    const now = 1_700_000_000_000;
    seedLockRow("f1", "host-a", null, 1200, "no-at");
    seedLockRow("f2", "host-a", now - 9_999_000, null, "no-ttl");
    seedLockRow("f3", "host-a", null, null, "no-both");

    const out = reapExpiredFolderLocks(now);
    expect(out.deleted).toBe(0);
    expect(countLocks("f1")).toBe(1);
    expect(countLocks("f2")).toBe(1);
    expect(countLocks("f3")).toBe(1);
  });

  test("idempotent under repeated runs", () => {
    const now = 1_700_000_000_000;
    seedLockRow("f1", "host-a", now - 1500_000, 1200, "stale");
    seedLockRow("f2", "host-b", now - 1500_000, 1200, "stale-2");

    const first = reapExpiredFolderLocks(now);
    expect(first.deleted).toBe(2);

    const second = reapExpiredFolderLocks(now);
    expect(second.deleted).toBe(0);
  });

  test("broadcasts a 'reaped' lock event per deleted row", () => {
    const now = 1_700_000_000_000;
    seedLockRow("f1", "host-a", now - 1500_000, 1200, "stale");
    seedLockRow("f2", "host-b", now - 100_000, 1200, "fresh");

    const events: unknown[] = [];
    const unsubscribe = subscribe((event) => events.push(event));
    try {
      const out = reapExpiredFolderLocks(now);
      expect(out.deleted).toBe(1);
      expect(out.folderIds).toEqual(["f1"]);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: "lock",
        folderId: "f1",
        hostId: "host-a",
        action: "reaped",
      });
    } finally {
      unsubscribe();
    }
  });

  test("acquire succeeds on a previously-reaped folder without waiting for overwrite", async () => {
    // Daemon on host-a "crashed" 25 minutes ago: lock is well past TTL
    // (default 1200s). Without the reaper, host-b's acquire below would
    // get 409 folder_locked until either (a) the reaper runs or (b) a
    // third host eventually acquires. With the reaper, host-b's acquire
    // succeeds on the first attempt.
    const now = Date.now();
    db.run(
      `INSERT OR REPLACE INTO folder_locks (folder_id, locked_by, locked_at, lock_ttl, lock_id)
       VALUES ('f1', 'host-a', ?, 1200, 'orphaned')`,
      [now - 25 * 60 * 1000],
    );

    const out = reapExpiredFolderLocks(now);
    expect(out.deleted).toBe(1);

    const acquire = await post("/api/v1/operations/acquire", {
      folderId: "f1",
      hostId: "host-b",
    });
    expect(acquire.status).toBe(200);
    const body = (await acquire.json()) as { lockId: string; ttl: number; acquired: boolean };
    expect(body.acquired).toBe(true);
    expect(body.lockId).toEqual(expect.any(String));
  });
});
