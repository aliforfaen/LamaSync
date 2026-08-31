import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "backup-legacy-test-key";

const { getAuthPlugin } = await import("../auth.ts");
const { __setDb, backupLegacyRoutes } =
  (await import("./backup-legacy.ts")) as typeof import("./backup-legacy.ts");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const m of MIGRATIONS) {
    try {
      db.exec(m);
    } catch {
      // idempotent
    }
  }
  // No backup folders by default so the report/prune paths return [] without
  // spawning rclone (AGENTS: `bun test` must work without external deps).
  __setDb(db);
  app = new Elysia().use(getAuthPlugin()).use(backupLegacyRoutes);
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

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(request(path, { method: "POST", body: JSON.stringify(body) }));
}

describe("backups legacy-root (LAMA-294)", () => {
  test("report is a safe dry-run returning [] with no backup folders", async () => {
    const res = await get("/api/v1/backups/legacy-root");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("report accepts the opt-in sizes query param (fast path is the default)", async () => {
    for (const path of [
      "/api/v1/backups/legacy-root",
      "/api/v1/backups/legacy-root?sizes=true",
      "/api/v1/backups/legacy-root?sizes=false",
    ]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    }
  });

  test("prune requires explicit confirm", async () => {
    const res = await post("/api/v1/backups/legacy-root/prune", { confirm: false });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "confirm_required" });
  });

  test("prune with confirm and no backup folders returns []", async () => {
    const res = await post("/api/v1/backups/legacy-root/prune", { confirm: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("an unauthenticated request is rejected (401)", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/backups/legacy-root"),
    );
    expect(res.status).toBe(401);
  });
});
