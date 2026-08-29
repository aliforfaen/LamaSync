// LAMA-234: auth principal resolution + route-level credential gating.
//
// Coverage:
//   - resolvePrincipal: master env key, managed admin/device keys, revoked
//     keys collapse to null, garbage/empty/null rejected
//   - route middleware: no/wrong bearer → 401, each credential type
//     attaches the correct principal to the request store, pairing exchange
//     stays auth-exempt
//   - helpers: requireAdmin (master/admin only), deviceMayAccessHost
//     (device bound to one host; master/admin any host)
//   - ws gate: master/admin subscribe, device keys rejected

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

const ORIGINAL_API_KEY = process.env.LAMASYNC_API_KEY;
const ORIGINAL_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY;
const TEST_API_KEY = "auth-test-master-key-1234567890";
const TEST_SECRET_KEY = "auth-test-secret-key-1234567890";

const {
  getAuthPlugin,
  resolvePrincipal,
  requireAdmin,
  deviceMayAccessHost,
} = await import("./auth.ts");
const { insertManagedApiKey, __setApiKeysDb, __resetApiKeysDb } = await import(
  "./api-keys.ts"
);
const { isWsSubscriptionAllowed } = await import("./ws.ts");

let db: Database;
let app: { handle(request: Request): Promise<Response> };

beforeEach(() => {
  process.env.LAMASYNC_API_KEY = TEST_API_KEY;
  process.env.LAMASYNC_SECRET_KEY = TEST_SECRET_KEY;
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // idempotent safety-net migrations
    }
  }
  __setApiKeysDb(db);
  app = new Elysia()
    .use(getAuthPlugin())
    .get("/api/v1/probe", ({ store }) => ({
      kind: store.principal?.kind ?? null,
      keyId: store.principal?.keyId ?? null,
      hostId: store.principal?.hostId ?? null,
    }))
    .get("/api/v1/pairing/exempt/exchange", () => ({ ok: true }));
});

afterEach(() => {
  __resetApiKeysDb();
  db.close();
  if (ORIGINAL_API_KEY === undefined) delete process.env.LAMASYNC_API_KEY;
  else process.env.LAMASYNC_API_KEY = ORIGINAL_API_KEY;
  if (ORIGINAL_SECRET_KEY === undefined) delete process.env.LAMASYNC_SECRET_KEY;
  else process.env.LAMASYNC_SECRET_KEY = ORIGINAL_SECRET_KEY;
});

function req(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function probeWith(token: string | null): Promise<Record<string, unknown>> {
  const headers = new Headers();
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  const res = await app.handle(req("/api/v1/probe", { headers }));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("resolvePrincipal", () => {
  test("master env key resolves to master", () => {
    expect(resolvePrincipal(TEST_API_KEY)).toEqual({
      kind: "master",
      keyId: null,
      hostId: null,
    });
  });

  test("managed admin key resolves to admin with keyId", () => {
    const { token } = insertManagedApiKey({ name: "ops laptop", kind: "admin", hostId: null });
    const p = resolvePrincipal(token);
    expect(p).not.toBeNull();
    if (p?.kind === "admin") {
      expect(p.keyId).toBeTypeOf("string");
      expect(p.hostId).toBeNull();
    } else {
      throw new Error("expected admin principal");
    }
  });

  test("managed device key resolves to device bound to its host", () => {
    const { token } = insertManagedApiKey({ name: "cachy", kind: "device", hostId: "host-1" });
    const p = resolvePrincipal(token);
    if (p?.kind === "device") {
      expect(p.hostId).toBe("host-1");
      expect(p.keyId).toBeTypeOf("string");
    } else {
      throw new Error("expected device principal");
    }
  });

  test("revoked managed key collapses to null (401)", () => {
    const { token, row } = insertManagedApiKey({ name: "rotated", kind: "admin", hostId: null });
    db.run("UPDATE api_keys SET revoked_at = ?, revoked_reason = ? WHERE id = ?", [
      Date.now(),
      "rotation",
      row.id,
    ]);
    expect(resolvePrincipal(token)).toBeNull();
  });

  test("garbage, empty, and missing tokens rejected", () => {
    expect(resolvePrincipal("garbage")).toBeNull();
    expect(resolvePrincipal("")).toBeNull();
    expect(resolvePrincipal(null)).toBeNull();
    expect(resolvePrincipal(undefined)).toBeNull();
  });
});

describe("route middleware", () => {
  test("no bearer → 401", async () => {
    const res = await app.handle(req("/api/v1/probe"));
    expect(res.status).toBe(401);
  });

  test("wrong bearer → 401", async () => {
    const res = await app.handle(req("/api/v1/probe", { headers: { Authorization: "Bearer nope" } }));
    expect(res.status).toBe(401);
  });

  test("revoked device key → 401 at the route boundary", async () => {
    const { token, row } = insertManagedApiKey({ name: "stolen", kind: "device", hostId: "host-1" });
    db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ?", [Date.now(), row.id]);
    const res = await app.handle(req("/api/v1/probe", { headers: { Authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(401);
  });

  test("each credential type attaches the right principal", async () => {
    expect(await probeWith(TEST_API_KEY)).toEqual({ kind: "master", keyId: null, hostId: null });

    const admin = insertManagedApiKey({ name: "ops", kind: "admin", hostId: null });
    const adminBody = await probeWith(admin.token);
    expect(adminBody.kind).toBe("admin");
    expect(adminBody.keyId).toBe(admin.row.id);

    const device = insertManagedApiKey({ name: "cachy", kind: "device", hostId: "host-7" });
    const deviceBody = await probeWith(device.token);
    expect(deviceBody.kind).toBe("device");
    expect(deviceBody.hostId).toBe("host-7");
    expect(deviceBody.keyId).toBe(device.row.id);
  });

  test("pairing exchange endpoint stays auth-exempt", async () => {
    const res = await app.handle(req("/api/v1/pairing/exempt/exchange"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("requireAdmin", () => {
  test("master and admin pass; device and null fail", () => {
    expect(requireAdmin({ principal: { kind: "master", keyId: null, hostId: null } })).not.toBeNull();
    expect(requireAdmin({ principal: { kind: "admin", keyId: "k", hostId: null } })).not.toBeNull();
    expect(requireAdmin({ principal: { kind: "device", keyId: "k", hostId: "h" } })).toBeNull();
    expect(requireAdmin({ principal: null })).toBeNull();
  });
});

describe("deviceMayAccessHost", () => {
  const master = { kind: "master", keyId: null, hostId: null } as const;
  const admin = { kind: "admin", keyId: "k", hostId: null } as const;
  const deviceA = { kind: "device", keyId: "k", hostId: "host-a" } as const;
  const deviceB = { kind: "device", keyId: "k", hostId: "host-b" } as const;

  test("master and admin may act on any host", () => {
    expect(deviceMayAccessHost(master, "whatever")).toBe(true);
    expect(deviceMayAccessHost(admin, "whatever")).toBe(true);
    expect(deviceMayAccessHost(master, null)).toBe(true);
  });

  test("device key only on its bound host", () => {
    expect(deviceMayAccessHost(deviceA, "host-a")).toBe(true);
    expect(deviceMayAccessHost(deviceA, "host-b")).toBe(false);
    expect(deviceMayAccessHost(deviceA, null)).toBe(false);
    expect(deviceMayAccessHost(deviceB, "host-a")).toBe(false);
  });

  test("null principal rejected", () => {
    expect(deviceMayAccessHost(null, "host-a")).toBe(false);
  });
});

describe("ws gate", () => {
  test("master and admin keys subscribe; device keys rejected", () => {
    const { token: adminToken } = insertManagedApiKey({ name: "ui", kind: "admin", hostId: null });
    const { token: deviceToken } = insertManagedApiKey({ name: "cachy", kind: "device", hostId: "h" });
    expect(isWsSubscriptionAllowed(TEST_API_KEY)).toBe(true);
    expect(isWsSubscriptionAllowed(adminToken)).toBe(true);
    expect(isWsSubscriptionAllowed(deviceToken)).toBe(false);
    expect(isWsSubscriptionAllowed("garbage")).toBe(false);
    expect(isWsSubscriptionAllowed(null)).toBe(false);
  });
});