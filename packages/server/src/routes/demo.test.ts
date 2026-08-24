// Unit tests for LAMA-264 demo-mode routes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "demo-test-key";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-demo-test-data";
process.env.LAMASYNC_BACKUP_DIR = process.env.LAMASYNC_BACKUP_DIR ?? "/tmp/lamasync-demo-test-backup";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "demo-test-secret-key-0123456789abcdef";

const { getAuthPlugin } = await import("../auth.ts");
const { __setDb, demoRoutes } = (await import("./demo.ts")) as unknown as {
  __setDb: (db: Database) => void;
  demoRoutes: Elysia;
};

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
  __setDb(db);
  app = new Elysia().use(getAuthPlugin()).use(demoRoutes);
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

function countWhere(table: string): number {
  return (
    (db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${table} WHERE demo = 1`).get()?.c) ??
    0
  );
}

describe("LAMA-264 demo mode", () => {
  test("GET /demo reports no demo data initially", async () => {
    const res = await app.handle(request("/api/v1/demo"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasDemo: boolean; counts: Record<string, number> };
    expect(body.hasDemo).toBe(false);
    expect(Object.values(body.counts).every((n) => n === 0)).toBe(true);
  });

  test("requires auth", async () => {
    const res = await app.handle(new Request("http://localhost/api/v1/demo"));
    expect(res.status).toBe(401);
  });

  test("POST /demo/seed creates flagged demo rows", async () => {
    const res = await app.handle(request("/api/v1/demo/seed", { method: "POST" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      hosts: number;
      folders: number;
      assignments: number;
      backends: number;
      operations: number;
      snapshots: number;
      manifests: number;
    };
    expect(body.hosts).toBe(3);
    expect(body.folders).toBe(3);
    expect(body.assignments).toBe(6);
    expect(body.backends).toBe(1);
    expect(body.operations).toBe(13);
    expect(body.snapshots).toBe(1);
    expect(body.manifests).toBe(1);

    // Every seeded row is flagged demo = 1.
    expect(countWhere("hosts")).toBe(3);
    expect(countWhere("operation_log")).toBe(13);
    expect(countWhere("restic_snapshots")).toBe(1);

    // GET now reports hasDemo.
    const get = await app.handle(request("/api/v1/demo"));
    const state = (await get.json()) as { hasDemo: boolean };
    expect(state.hasDemo).toBe(true);
  });

  test("DELETE /demo removes only demo rows and is idempotent", async () => {
    await app.handle(request("/api/v1/demo/seed", { method: "POST" }));
    // Plant a REAL (non-demo) host that must survive the delete.
    db.run(
      "INSERT INTO hosts (id, hostname, status, demo) VALUES (?, 'real-laptop', 'online', 0)",
      [`real-${crypto.randomUUID()}`],
    );
    const realBefore = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM hosts WHERE demo = 0")
      .get()?.c;

    const del = await app.handle(request("/api/v1/demo", { method: "DELETE" }));
    expect(del.status).toBe(200);

    expect(countWhere("hosts")).toBe(0);
    expect(countWhere("folders")).toBe(0);
    expect(countWhere("operation_log")).toBe(0);
    expect(countWhere("restic_snapshots")).toBe(0);

    const realAfter = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM hosts WHERE demo = 0")
      .get()?.c;
    expect(realAfter).toBe(realBefore);

    // Idempotent: deleting again is a safe no-op.
    const del2 = await app.handle(request("/api/v1/demo", { method: "DELETE" }));
    expect(del2.status).toBe(200);
    expect(countWhere("hosts")).toBe(0);
  });
});
