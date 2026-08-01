// Unit tests for the queued-actions routes (LAMA-198). Follows the
// `__setDb` test-seam pattern used by hosts/operations/folders tests.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "actions-test-key";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-actions-test-data";

const { getAuthPlugin } = await import("../auth.ts");
const { __setDb, actionsRoutes } = (await import("./actions.ts")) as typeof import("./actions.ts");

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
  db.run(
    `INSERT INTO hosts (id, hostname) VALUES ('host-a', 'host-a'), ('host-b', 'host-b')`,
  );
  __setDb(db);
  app = new Elysia().use(getAuthPlugin()).use(actionsRoutes);
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

async function get(path: string): Promise<Response> {
  return app.handle(request(path));
}

async function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(request(path, { method: "POST", body: JSON.stringify(body) }));
}

describe("POST /api/v1/hosts/:hostId/actions — enqueue", () => {
  test("enqueues a valid trigger_sync action and returns 201", async () => {
    const res = await postJson("/api/v1/hosts/host-a/actions", {
      type: "trigger_sync",
      payload: { folderId: "folder-x" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe("trigger_sync");
    expect(body.status).toBe("pending");
    expect(body.hostId).toBe("host-a");
    expect(body.payload).toEqual({ folderId: "folder-x" });
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("number");
  });

  test("enqueues an action with no payload", async () => {
    const res = await postJson("/api/v1/hosts/host-a/actions", {
      type: "check_update",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.payload).toBeNull();
  });

  test("rejects an unknown action type", async () => {
    const res = await postJson("/api/v1/hosts/host-a/actions", {
      type: "wipe_disk",
    });
    // Elysia's literal validator rejects unknown values with 422; the
    // in-handler 400 branch is a defensive fallback for callers that
    // bypass the schema.
    expect(res.status).toBe(422);
    // The body shape from Elysia's validator is `{ errors, summary, type }`,
    // not our `{ error }` envelope — just confirm a non-empty JSON body
    // was returned.
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("wipe_disk");
  });

  test("returns 404 for an unknown host", async () => {
    const res = await postJson("/api/v1/hosts/ghost/actions", {
      type: "trigger_sync",
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/actions/pending — daemon take", () => {
  test("claims pending actions for the host and marks them taken", async () => {
    await postJson("/api/v1/hosts/host-a/actions", { type: "trigger_sync" });
    await postJson("/api/v1/hosts/host-a/actions", { type: "check_update" });
    await postJson("/api/v1/hosts/host-b/actions", { type: "refresh_config" });

    const res = await get("/api/v1/actions/pending?hostId=host-a&limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    const types = body.map((a) => a.type).sort();
    expect(types).toEqual(["check_update", "trigger_sync"]);
    for (const a of body) {
      expect(a.status).toBe("taken");
      expect(typeof a.takenAt).toBe("number");
    }

    // host-b was untouched.
    const other = await get("/api/v1/actions/pending?hostId=host-b&limit=10");
    const otherBody = (await other.json()) as Array<Record<string, unknown>>;
    expect(otherBody).toHaveLength(1);
    expect(otherBody[0]?.type).toBe("refresh_config");
  });

  test("a second poll returns nothing (taken actions aren't returned twice)", async () => {
    await postJson("/api/v1/hosts/host-a/actions", { type: "trigger_sync" });
    const first = await get("/api/v1/actions/pending?hostId=host-a");
    expect((await first.json()) as unknown[]).toHaveLength(1);
    const second = await get("/api/v1/actions/pending?hostId=host-a");
    expect((await second.json()) as unknown[]).toHaveLength(0);
  });

  test("returns a 4xx when hostId is missing", async () => {
    const res = await get("/api/v1/actions/pending");
    // Elysia returns 422 for query-validator failures; the in-handler 400
    // branch is a defensive fallback that fires only if the validator
    // accepts a missing-but-undefined value, which it currently does not.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("POST /api/v1/actions/:id/complete — daemon ack", () => {
  test("marks the action done and writes an operation_log row", async () => {
    const enqueue = await postJson("/api/v1/hosts/host-a/actions", {
      type: "trigger_sync",
    });
    const actionId = ((await enqueue.json()) as { id: string }).id;

    const res = await postJson(`/api/v1/actions/${actionId}/complete`, {
      status: "done",
      result: "sync completed in 12s",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("done");
    expect(body.result).toBe("sync completed in 12s");
    expect(typeof body.completedAt).toBe("number");

    // Audit row in operation_log
    const ops = db
      .query<
        { operation: string; status: string; host_id: string; summary: string | null },
        []
      >("SELECT operation, status, host_id, summary FROM operation_log")
      .all();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      operation: "trigger_sync",
      status: "done",
      host_id: "host-a",
      summary: "sync completed in 12s",
    });
  });

  test("marks the action failed on daemon error", async () => {
    const enqueue = await postJson("/api/v1/hosts/host-a/actions", {
      type: "check_update",
    });
    const actionId = ((await enqueue.json()) as { id: string }).id;

    const res = await postJson(`/api/v1/actions/${actionId}/complete`, {
      status: "failed",
      result: "GitHub 503",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("failed");
    expect(body.result).toBe("GitHub 503");

    const ops = db
      .query<{ status: string }, []>(
        "SELECT status FROM operation_log WHERE host_id = 'host-a'",
      )
      .all();
    expect(ops[0]?.status).toBe("failed");
  });

  test("returns 404 for an unknown action id", async () => {
    const res = await postJson("/api/v1/actions/does-not-exist/complete", {
      status: "done",
    });
    expect(res.status).toBe(404);
  });

  test("rejects invalid completion status", async () => {
    const enqueue = await postJson("/api/v1/hosts/host-a/actions", {
      type: "refresh_config",
    });
    const actionId = ((await enqueue.json()) as { id: string }).id;
    const res = await postJson(`/api/v1/actions/${actionId}/complete`, {
      status: "started",
    });
    // Elysia's body validator rejects the literal with 422; the in-handler
    // 400 branch is a defensive fallback for un-validated callers.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("GET /api/v1/hosts/:hostId/actions — history", () => {
  test("returns newest first, scoped to the host", async () => {
    await postJson("/api/v1/hosts/host-a/actions", { type: "trigger_sync" });
    // Force a separate millisecond so the ORDER BY created_at DESC is
    // deterministic (Date.now() can repeat within a busy event loop).
    await new Promise((resolve) => setTimeout(resolve, 5));
    await postJson("/api/v1/hosts/host-a/actions", { type: "check_update" });
    await postJson("/api/v1/hosts/host-b/actions", { type: "refresh_config" });

    const res = await get("/api/v1/hosts/host-a/actions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(body.every((a) => a.hostId === "host-a")).toBe(true);
    expect(body[0]?.type).toBe("check_update");
    expect(body[1]?.type).toBe("trigger_sync");
  });

  test("filters by status", async () => {
    const enqueue = await postJson("/api/v1/hosts/host-a/actions", {
      type: "trigger_sync",
    });
    const actionId = ((await enqueue.json()) as { id: string }).id;
    await postJson("/api/v1/hosts/host-a/actions", { type: "check_update" });
    await postJson(`/api/v1/actions/${actionId}/complete`, { status: "done" });

    const pending = await get("/api/v1/hosts/host-a/actions?status=pending");
    const done = await get("/api/v1/hosts/host-a/actions?status=done");
    expect((await pending.json()) as Array<unknown>).toHaveLength(1);
    expect((await done.json()) as Array<unknown>).toHaveLength(1);
  });
});