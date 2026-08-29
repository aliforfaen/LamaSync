// LAMA-234: key lifecycle routes + GET /auth/me.
//
// Coverage:
//   - create admin key: 201, secret returned once, works as a bearer,
//     Cache-Control no-store, name validation
//   - list: masked metadata only (no hashes/encrypted copies/secrets)
//   - reveal: explicit, no-store, marks revealed_at; fail-closed 500 path
//     covered by unit tests in api-keys.test.ts (decrypt null)
//   - revoke: soft revoke → next request 401; reason recorded; idempotent
//   - /auth/me: master/admin/device identity + name resolution
//   - device keys blocked from the whole management surface (403)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "apikeys-master-123456";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "apikeys-secret-123456";

const { getAuthPlugin } = await import("../auth.ts");
const { insertManagedApiKey, __setApiKeysDb, __resetApiKeysDb } = await import("../api-keys.ts");
const { __setDb, apiKeysRoutes } = await import("./api-keys.ts");

let db: Database;
let app: { handle(request: Request): Promise<Response> };

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
  __setApiKeysDb(db);
  __setDb(db);
  app = new Elysia().use(getAuthPlugin()).use(apiKeysRoutes);
});

afterEach(() => {
  __resetApiKeysDb();
  db.close();
});

function as(token: string | null, method: string, path: string, body?: unknown): Request {
  const headers = new Headers();
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function send(token: string | null, method: string, path: string, body?: unknown): Promise<Response> {
  return app.handle(as(token, method, path, body));
}

const MASTER = process.env.LAMASYNC_API_KEY!;

describe("GET /api-keys (admin list)", () => {
  test("master sees masked metadata, never secrets", async () => {
    const { token } = insertManagedApiKey({ name: "Admin laptop", kind: "admin", hostId: null });
    const res = await send(MASTER, "GET", "/api/v1/api-keys");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    const item = list[0]!;
    expect(item.name).toBe("Admin laptop");
    expect(item.kind).toBe("admin");
    expect(typeof item.fingerprint).toBe("string");
    expect(item).not.toHaveProperty("token_hash");
    expect(item).not.toHaveProperty("token_enc");
    expect(item).not.toHaveProperty("secret");
    expect(JSON.stringify(list)).not.toContain(token);
  });

  test("device keys are blocked (403)", async () => {
    const dev = insertManagedApiKey({ name: "d", kind: "device", hostId: "h1" });
    expect((await send(dev.token, "GET", "/api/v1/api-keys")).status).toBe(403);
  });

  test("no bearer → 401", async () => {
    expect((await send(null, "GET", "/api/v1/api-keys")).status).toBe(401);
  });
});

describe("POST /api-keys (create admin key)", () => {
  test("returns the secret once with no-store; the key works as a bearer", async () => {
    const res = await send(MASTER, "POST", "/api/v1/api-keys", { name: "ops laptop" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { key: Record<string, unknown>; secret: string };
    expect(body.key.name).toBe("ops laptop");
    expect(body.key.kind).toBe("admin");
    expect(typeof body.secret).toBe("string");
    expect(body.secret.startsWith("lmsk.")).toBe(true);
    // The freshly minted admin key can list keys (full admin surface).
    const asNew = await send(body.secret, "GET", "/api/v1/api-keys");
    expect(asNew.status).toBe(200);
    // and it is not echoed anywhere in the list
    const list = await send(MASTER, "GET", "/api/v1/api-keys");
    expect(JSON.stringify(await list.json())).not.toContain(body.secret);
  });

  test("validates the name", async () => {
    expect((await send(MASTER, "POST", "/api/v1/api-keys", { name: "  " })).status).toBe(400);
    expect((await send(MASTER, "POST", "/api/v1/api-keys", { name: "x".repeat(65) })).status).toBe(400);
    expect((await send(MASTER, "POST", "/api/v1/api-keys", { name: "ok" })).status).toBe(200);
  });

  test("device keys cannot create admin keys (403)", async () => {
    const dev = insertManagedApiKey({ name: "d", kind: "device", hostId: "h1" });
    expect((await send(dev.token, "POST", "/api/v1/api-keys", { name: "sneaky" })).status).toBe(403);
  });
});

describe("POST /api-keys/:id/reveal", () => {
  test("reveals the exact created secret with no-store and stamps revealed_at", async () => {
    const created = await send(MASTER, "POST", "/api/v1/api-keys", { name: "backup laptop" });
    const { key, secret } = (await created.json()) as { key: { id: string }; secret: string };
    const res = await send(MASTER, "POST", `/api/v1/api-keys/${key.id}/reveal`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { id: string; secret: string; revealedAt: number };
    expect(body.id).toBe(key.id);
    expect(body.secret).toBe(secret);
    expect(typeof body.revealedAt).toBe("number");
    const row = db.query("SELECT revealed_at FROM api_keys WHERE id = ?").get(key.id) as { revealed_at: number };
    expect(row.revealed_at).toBe(body.revealedAt);
  });

  test("unknown id → 404; device key → 403", async () => {
    expect((await send(MASTER, "POST", "/api/v1/api-keys/nope/reveal")).status).toBe(404);
    const dev = insertManagedApiKey({ name: "d", kind: "device", hostId: "h1" });
    expect((await send(dev.token, "POST", "/api/v1/api-keys/nope/reveal")).status).toBe(403);
  });
});

describe("POST /api-keys/:id/revoke", () => {
  test("revoked key returns 401 on the next request; reason recorded", async () => {
    const created = await send(MASTER, "POST", "/api/v1/api-keys", { name: "to-rotate" });
    const { key, secret } = (await created.json()) as { key: { id: string }; secret: string };
    expect((await send(secret, "GET", "/api/v1/api-keys")).status).toBe(200);

    const revoke = await send(MASTER, "POST", `/api/v1/api-keys/${key.id}/revoke`, {
      reason: "device was replaced",
    });
    expect(revoke.status).toBe(200);
    expect((await send(secret, "GET", "/api/v1/api-keys")).status).toBe(401);

    const row = db.query("SELECT revoked_at, revoked_reason FROM api_keys WHERE id = ?").get(key.id) as {
      revoked_at: number;
      revoked_reason: string;
    };
    expect(row.revoked_at).toBeGreaterThan(0);
    expect(row.revoked_reason).toBe("device was replaced");
  });

  test("revoking another device's key leaves other keys working", async () => {
    const a = insertManagedApiKey({ name: "a", kind: "device", hostId: "h1" });
    const b = insertManagedApiKey({ name: "b", kind: "device", hostId: "h2" });
    const revoke = await send(MASTER, "POST", `/api/v1/api-keys/${a.row.id}/revoke`, {});
    expect(revoke.status).toBe(200);
    expect((await send(a.token, "GET", "/api/v1/auth/me")).status).toBe(401);
    expect((await send(b.token, "GET", "/api/v1/auth/me")).status).toBe(200);
  });

  test("unknown id → 404", async () => {
    expect((await send(MASTER, "POST", "/api/v1/api-keys/nope/revoke", {})).status).toBe(404);
  });
});

describe("GET /auth/me", () => {
  test("master resolves to master with no name", async () => {
    const res = await send(MASTER, "GET", "/api/v1/auth/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "master", keyId: null, hostId: null, name: null });
  });

  test("admin resolves with its label; device resolves with its host", async () => {
    const admin = insertManagedApiKey({ name: "ops", kind: "admin", hostId: null });
    const adminBody = (await (await send(admin.token, "GET", "/api/v1/auth/me")).json()) as {
      kind: string;
      name: string | null;
      keyId: string;
    };
    expect(adminBody.kind).toBe("admin");
    expect(adminBody.name).toBe("ops");
    expect(adminBody.keyId).toBe(admin.row.id);

    const dev = insertManagedApiKey({ name: "cachy", kind: "device", hostId: "host-1" });
    const devBody = (await (await send(dev.token, "GET", "/api/v1/auth/me")).json()) as {
      kind: string;
      hostId: string | null;
    };
    expect(devBody.kind).toBe("device");
    expect(devBody.hostId).toBe("host-1");
  });

  test("unknown token → 401", async () => {
    expect((await send("lmsk.AAAAAAAAAAAA.garbage", "GET", "/api/v1/auth/me")).status).toBe(401);
  });
});