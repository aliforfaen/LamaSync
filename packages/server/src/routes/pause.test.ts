// LAMA-273: pause/slow mode CRUD route tests. Exercises the global +
// per-host endpoints, expired-row pruning, and the config_revision bump
// that drives daemons to re-pull their effective pause.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "pause-test-key";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-pause-test-data";

const { getAuthPlugin } = await import("../auth.ts");
const {
  __setDb: __setPauseDb,
  pauseRoutes,
} = (await import("./pause.ts")) as unknown as {
  __setDb: (db: Database) => void;
  pauseRoutes: Elysia;
};
const {
  __setDb: __setConfigRevisionDb,
} = (await import("../config-revision.ts")) as unknown as {
  __setDb: (db: Database) => void;
};

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (!isRecord(parsed)) throw new Error("expected an object response");
  return parsed;
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${process.env.LAMASYNC_API_KEY}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(request(path, { method: "POST", body: JSON.stringify(body) }));
}

async function del(path: string): Promise<Response> {
  return app.handle(request(path, { method: "DELETE" }));
}

function insertHost(id: string): void {
  db.run(
    "INSERT INTO hosts (id, hostname, status, last_seen) VALUES (?, ?, 'online', ?)",
    [id, id, Date.now()],
  );
}

function readRevision(id: string): number {
  const row = db
    .query<{ config_revision: number | null }, [string]>(
      "SELECT config_revision FROM hosts WHERE id = ?",
    )
    .get(id);
  return row?.config_revision ?? 0;
}

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
  __setPauseDb(db);
  __setConfigRevisionDb(db);
  // Seed a few hosts so per-host tests have something to bump.
  insertHost("alpha");
  insertHost("beta");
  app = new Elysia().use(getAuthPlugin()).use(pauseRoutes);
});

afterEach(() => {
  db.close();
});

describe("pause routes — global CRUD", () => {
  test("GET /pause starts with global + hosts both null/empty", async () => {
    const res = await app.handle(request("/api/v1/pause"));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body["global"]).toBeNull();
    expect(body["hosts"]).toEqual([]);
  });

  test("POST /pause sets a global pause with ISO until + bumps every host revision", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const res = await postJson("/api/v1/pause", { until: future, mode: "pause" });
    expect(res.status).toBe(201);
    const created = await bodyOf(res);
    expect(created["scope"]).toBe("global");
    expect(created["mode"]).toBe("pause");
    expect(created["until"]).toBe(future);
    // Every host was bumped (pause affects the fleet). alpha + beta get +1.
    expect(readRevision("alpha")).toBe(1);
    expect(readRevision("beta")).toBe(1);

    const list = await app.handle(request("/api/v1/pause"));
    const listed = await bodyOf(list);
    expect(listed["global"]).not.toBeNull();
    expect((listed["global"] as { mode: string }).mode).toBe("pause");
  });

  test("POST /pause in slow mode accepts a single-segment bwlimit and trims it", async () => {
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    const res = await postJson("/api/v1/pause", {
      until: future,
      mode: "slow",
      bwlimit: "  10M  ",
    });
    expect(res.status).toBe(201);
    const created = await bodyOf(res);
    expect(created["mode"]).toBe("slow");
    expect(created["bwlimit"]).toBe("10M");
  });

  test("POST /pause rejects multi-segment / non-rclone bwlimit strings", async () => {
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    const res = await postJson("/api/v1/pause", {
      until: future,
      mode: "slow",
      bwlimit: "08:00,1M 12:00,10M",
    });
    expect(res.status).toBe(400);
    const err = await bodyOf(res);
    expect(String(err["error"])).toMatch(/bwlimit/);
  });

  test("POST /pause rejects past timestamps (resume is explicit DELETE)", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const res = await postJson("/api/v1/pause", { until: past, mode: "pause" });
    expect(res.status).toBe(400);
    const err = await bodyOf(res);
    expect(String(err["error"])).toMatch(/future/);
  });

  test("POST /pause rejects invalid mode + missing until", async () => {
    // Elysia's t.Literal body validator fails with 422 (HTTP standard
    // for body validation), while our own parsePauseBody returns 400 for
    // semantic errors. Both are accepted as "invalid input".
    const future = new Date(Date.now() + 60_000).toISOString();
    const badMode = await postJson("/api/v1/pause", { until: future, mode: "throttle" });
    expect([400, 422]).toContain(badMode.status);
    const badUntil = await postJson("/api/v1/pause", { until: "not-a-date", mode: "pause" });
    expect(badUntil.status).toBe(400);
    const noUntil = await postJson("/api/v1/pause", { mode: "pause" });
    expect([400, 422]).toContain(noUntil.status);
  });

  test("DELETE /pause clears the global row and bumps every host revision", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    await postJson("/api/v1/pause", { until: future, mode: "pause" });
    expect(readRevision("alpha")).toBe(1);

    const delRes = await del("/api/v1/pause");
    expect(delRes.status).toBe(204);
    expect(readRevision("alpha")).toBe(2);

    const list = await bodyOf(await app.handle(request("/api/v1/pause")));
    expect(list["global"]).toBeNull();
  });

  test("DELETE /pause is idempotent (no row still returns 204)", async () => {
    const res = await del("/api/v1/pause");
    expect(res.status).toBe(204);
  });

  test("GET /pause prunes expired rows on read", async () => {
    // Insert an expired row directly (bypassing the POST validation).
    db.run(
      `INSERT INTO pause_state (id, scope, host_id, until_ms, mode, bwlimit, created_at)
       VALUES ('global', 'global', NULL, ?, 'pause', NULL, ?)`,
      [Date.now() - 1, Date.now()],
    );
    const before = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pause_state").get();
    expect(before?.count).toBe(1);

    const res = await app.handle(request("/api/v1/pause"));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body["global"]).toBeNull();

    const after = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pause_state").get();
    expect(after?.count).toBe(0);
  });
});

describe("pause routes — per-host CRUD", () => {
  test("POST /hosts/:hostId/pause sets a host row + bumps only that host", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const res = await postJson("/api/v1/hosts/alpha/pause", {
      until: future,
      mode: "pause",
    });
    expect(res.status).toBe(201);
    const created = await bodyOf(res);
    expect(created["scope"]).toBe("host");
    expect(created["hostId"]).toBe("alpha");
    expect(readRevision("alpha")).toBe(1);
    expect(readRevision("beta")).toBe(0);

    const list = await bodyOf(await app.handle(request("/api/v1/pause")));
    const hosts = list["hosts"] as Array<Record<string, unknown>>;
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.["hostId"]).toBe("alpha");
  });

  test("POST /hosts/:hostId/pause 404s on unknown host", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const res = await postJson("/api/v1/hosts/ghost/pause", {
      until: future,
      mode: "pause",
    });
    expect(res.status).toBe(404);
  });

  test("DELETE /hosts/:hostId/pause clears the host row and bumps revision", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    await postJson("/api/v1/hosts/alpha/pause", { until: future, mode: "pause" });
    const delRes = await del("/api/v1/hosts/alpha/pause");
    expect(delRes.status).toBe(204);
    expect(readRevision("alpha")).toBe(2);

    const list = await bodyOf(await app.handle(request("/api/v1/pause")));
    expect(list["hosts"]).toEqual([]);
  });

  test("DELETE /hosts/:hostId/pause is idempotent (no row still returns 204)", async () => {
    const res = await del("/api/v1/hosts/alpha/pause");
    expect(res.status).toBe(204);
  });
});

describe("pause routes — auth", () => {
  test("requests without a bearer token are 401", async () => {
    const res = await app.handle(new Request("http://localhost/api/v1/pause"));
    expect(res.status).toBe(401);
  });
});
