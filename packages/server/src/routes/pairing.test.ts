// LAMA-262: pairing-session lifecycle tests.
//
// Coverage:
//   - helpers: alphabet excludes ambiguous chars (0/O/1/I/L),
//     generatePairingCode shape, effectiveStatus projection,
//     pruneExpiredPending idempotence, sweepExpiredPairingSessions
//   - routes: create (admin auth required), lookup (admin), exchange
//     (single-use, 409 on second; 410 on expired; 404 on missing; 400
//     on missing host identity; 503 when a device key cannot be issued
//     because the secret key is unavailable), case-insensitive lookup
//   - LAMA-234: the exchange mints a host-bound DEVICE key — never the
//     master key — and the code stays single-use even on issuance
//     failure
//   - schema: pairing_sessions table + index exist on a fresh DB

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

const ORIGINAL_API_KEY = process.env.LAMASYNC_API_KEY;
const ORIGINAL_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY;
const ORIGINAL_DATA_DIR = process.env.LAMASYNC_DATA_DIR;
process.env.LAMASYNC_API_KEY =
  process.env.LAMASYNC_API_KEY ?? "pairing-test-key-1234567890";
// Device-key issuance needs a working AES-GCM key; without it the
// exchange fails closed with 503.
process.env.LAMASYNC_SECRET_KEY =
  process.env.LAMASYNC_SECRET_KEY ?? "pairing-test-secret-1234567890";
process.env.LAMASYNC_DATA_DIR =
  process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-pairing-test";

const { getAuthPlugin } = await import("../auth.ts");
const {
  pairingRoutes,
  __pairingHelpersForTests,
  __setDb,
} = await import("./pairing.ts");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (!isRecord(parsed)) throw new Error("expected an object response");
  return parsed;
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${process.env.LAMASYNC_API_KEY}`);
  }
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`http://localhost${path}`, { ...init, headers });
}

function requestNoAuth(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`http://localhost${path}`, { ...init, headers });
}

beforeEach(() => {
  // Re-set the crypto env every test: afterEach restores the outer env
  // (possibly deleting the values above), so later crypto-using tests
  // must re-pin them.
  process.env.LAMASYNC_SECRET_KEY =
    process.env.LAMASYNC_SECRET_KEY ?? "pairing-test-secret-1234567890";
  process.env.LAMASYNC_DATA_DIR =
    process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-pairing-test";
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // ignore
    }
  }
  __setDb(db);
  app = new Elysia().use(getAuthPlugin()).use(pairingRoutes);
});

afterEach(() => {
  db.close();
  if (ORIGINAL_API_KEY === undefined) delete process.env.LAMASYNC_API_KEY;
  else process.env.LAMASYNC_API_KEY = ORIGINAL_API_KEY;
  if (ORIGINAL_SECRET_KEY === undefined) delete process.env.LAMASYNC_SECRET_KEY;
  else process.env.LAMASYNC_SECRET_KEY = ORIGINAL_SECRET_KEY;
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.LAMASYNC_DATA_DIR;
  else process.env.LAMASYNC_DATA_DIR = ORIGINAL_DATA_DIR;
});

describe("pairing code alphabet", () => {
  test("excludes 0, O, 1, I, L", () => {
    const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    expect("01OIL".split("").every((ch) => !alphabet.includes(ch))).toBe(true);
    expect(alphabet.length).toBe(31);
  });

  test("generated code matches LAMA-XXXX-XXXX shape with uppercase body", () => {
    for (let i = 0; i < 20; i++) {
      const code = __pairingHelpersForTests.generatePairingCode();
      // Generator emits lowercase `lama-` prefix + uppercase body. The
      // route normalizes to UPPER on insert so the wire shape is
      // canonical; both cases are accepted by isValidCodeShape.
      expect(code).toMatch(/^lama-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      const body = code.slice(5).replace("-", "");
      expect(body.length).toBe(8);
      for (const ch of body) {
        expect("01OIL".includes(ch)).toBe(false);
      }
    }
  });

  test("isValidCodeShape normalizes case and rejects malformed input", () => {
    // Codes use the unambiguous alphabet — no 0/O/1/I/L anywhere.
    expect(__pairingHelpersForTests.isValidCodeShape("LAMA-72B4-9PQ2")).toBe(true);
    expect(__pairingHelpersForTests.isValidCodeShape("lama-72B4-9PQ2")).toBe(true);
    expect(__pairingHelpersForTests.isValidCodeShape("lama-72b4-9pq2")).toBe(true);
    expect(__pairingHelpersForTests.isValidCodeShape("lama-7OIO-9LIL")).toBe(false);
    // 1 is excluded too (a 1 next to an I is impossible to tell apart
    // in many monospace fonts).
    expect(__pairingHelpersForTests.isValidCodeShape("lama-72B4-9PQ1")).toBe(false);
    expect(__pairingHelpersForTests.isValidCodeShape("nope")).toBe(false);
    expect(__pairingHelpersForTests.isValidCodeShape(null)).toBe(false);
    expect(__pairingHelpersForTests.isValidCodeShape(undefined)).toBe(false);
    expect(__pairingHelpersForTests.isValidCodeShape(123)).toBe(false);
  });
});

describe("create + lookup + exchange (LAMA-262)", () => {
  test("create returns a LAMA-XXXX-XXXX code + TTL", async () => {
    const res = await app.handle(
      request("/api/v1/pairing", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(201);
    const body = await responseObject(res);
    const code = String(body["code"]);
    // Stored + wire shape: uppercase LAMA-XXXX-XXXX. Operator-facing
    // docs call it lowercase `lama-72B4-9PQ1`; both are accepted on
    // input via normalizeCode().
    expect(code).toMatch(/^LAMA-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(typeof body["expiresInSeconds"]).toBe("number");
    expect(Number(body["expiresInSeconds"])).toBe(600);
  });

  test("create respects ttlSeconds within bounds; clamps out-of-range", async () => {
    const ok = await app.handle(
      request("/api/v1/pairing", {
        method: "POST",
        body: JSON.stringify({ ttlSeconds: 120 }),
      }),
    );
    const okBody = await responseObject(ok);
    expect(Number(okBody["expiresInSeconds"])).toBe(120);

    const tooLow = await app.handle(
      request("/api/v1/pairing", {
        method: "POST",
        body: JSON.stringify({ ttlSeconds: 5 }),
      }),
    );
    const tooLowBody = await responseObject(tooLow);
    expect(Number(tooLowBody["expiresInSeconds"])).toBe(30);

    const tooHigh = await app.handle(
      request("/api/v1/pairing", {
        method: "POST",
        body: JSON.stringify({ ttlSeconds: 24 * 3600 }),
      }),
    );
    const tooHighBody = await responseObject(tooHigh);
    expect(Number(tooHighBody["expiresInSeconds"])).toBe(3600);
  });

  test("create requires admin auth (401 without bearer)", async () => {
    const res = await app.handle(
      requestNoAuth("/api/v1/pairing", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
  });

  test("lookup reports pending + expiry, never the key", async () => {
    const created = await responseObject(
      await app.handle(request("/api/v1/pairing", { method: "POST", body: "{}" })),
    );
    const code = String(created["code"]);
    const lookup = await app.handle(request(`/api/v1/pairing/${code}`));
    expect(lookup.status).toBe(200);
    const body = await responseObject(lookup);
    expect(body["status"]).toBe("pending");
    expect(typeof body["expiresAt"]).toBe("string");
    // Never reveal the key on a status read.
    expect(body).not.toHaveProperty("apiKey");
  });

  test("lookup is case-insensitive and rejects malformed codes", async () => {
    const created = await responseObject(
      await app.handle(request("/api/v1/pairing", { method: "POST", body: "{}" })),
    );
    const code = String(created["code"]);
    const upper = await app.handle(request(`/api/v1/pairing/${code.toUpperCase()}`));
    expect(upper.status).toBe(200);

    const lower = await app.handle(request(`/api/v1/pairing/${code.toLowerCase()}`));
    expect(lower.status).toBe(200);

    const malformed = await app.handle(request("/api/v1/pairing/not-a-code"));
    expect(malformed.status).toBe(400);

    const missing = await app.handle(request("/api/v1/pairing/lama-AAAA-BBBB"));
    expect(missing.status).toBe(404);
  });

  test("exchange mints a host-bound device key (never the master), single-use", async () => {
    const created = await responseObject(
      await app.handle(request("/api/v1/pairing", { method: "POST", body: "{}" })),
    );
    const code = String(created["code"]);
    // The exchange endpoint does NOT require the bearer header.
    const exchange = await app.handle(
      requestNoAuth(`/api/v1/pairing/${code}/exchange`, {
        method: "POST",
        body: JSON.stringify({ hostId: "pair-host", hostname: "pair-host" }),
      }),
    );
    expect(exchange.status).toBe(200);
    const body = await responseObject(exchange);
    // LAMA-234: a managed device key, never the shared master key.
    const apiKey = String(body["apiKey"]);
    expect(apiKey.startsWith("lmsk.")).toBe(true);
    expect(apiKey).not.toBe(process.env.LAMASYNC_API_KEY);
    // The minted key is bound to the submitted host in api_keys.
    const found = db
      .query<{ kind: string; host_id: string | null; name: string }, [string]>(
        "SELECT kind, host_id, name FROM api_keys WHERE id = ?",
      )
      .get(body["apiKey"]!.toString().split(".")[1]);
    expect(found).not.toBeNull();
    expect(found!.kind).toBe("device");
    expect(found!.host_id).toBe("pair-host");
    expect(found!.name).toBe("pair-host");

    // Second exchange → 409 (already used), even with a different host.
    const second = await app.handle(
      requestNoAuth(`/api/v1/pairing/${code}/exchange`, {
        method: "POST",
        body: JSON.stringify({ hostId: "other-host", hostname: "other" }),
      }),
    );
    expect(second.status).toBe(409);
    const secondBody = await responseObject(second);
    expect(String(secondBody["error"])).toMatch(/already used/);

    // Lookup reflects the new state.
    const status = await responseObject(await app.handle(request(`/api/v1/pairing/${code}`)));
    expect(status["status"]).toBe("used");
  });

  test("exchange requires the device host identity in the body", async () => {
    const created = await responseObject(
      await app.handle(request("/api/v1/pairing", { method: "POST", body: "{}" })),
    );
    const code = String(created["code"]);
    const noBody = await app.handle(
      requestNoAuth(`/api/v1/pairing/${code}/exchange`, { method: "POST" }),
    );
    expect(noBody.status).toBe(422); // Elysia body validation failure
    const emptyHost = await app.handle(
      requestNoAuth(`/api/v1/pairing/${code}/exchange`, {
        method: "POST",
        body: JSON.stringify({ hostId: "", hostname: "x" }),
      }),
    );
    expect(emptyHost.status).toBe(400);
  });

  test("exchange rejects expired sessions with 410 and flips them on read", async () => {
    const created = await responseObject(
      await app.handle(request("/api/v1/pairing", { method: "POST", body: "{}" })),
    );
    const code = String(created["code"]);
    // Backdate the row.
    db.run(
      "UPDATE pairing_sessions SET expires_at = ? WHERE code = ?",
      [Date.now() - 1000, code],
    );

    const exchange = await app.handle(
      requestNoAuth(`/api/v1/pairing/${code}/exchange`, {
        method: "POST",
        body: JSON.stringify({ hostId: "pair-host", hostname: "pair-host" }),
      }),
    );
    expect(exchange.status).toBe(410);

    // After a read, the periodic read-prune flips pending → expired.
    const status = await responseObject(await app.handle(request(`/api/v1/pairing/${code}`)));
    expect(status["status"]).toBe("expired");

    // Expired rows are NOT claimable even by a fresh exchange.
    const exchange2 = await app.handle(
      requestNoAuth(`/api/v1/pairing/${code}/exchange`, {
        method: "POST",
        body: JSON.stringify({ hostId: "pair-host", hostname: "pair-host" }),
      }),
    );
    expect(exchange2.status).toBe(410);
  });

  test("exchange returns 404 for unknown codes", async () => {
    const exchange = await app.handle(
      requestNoAuth("/api/v1/pairing/lama-ZZZZ-ZZZZ/exchange", {
        method: "POST",
        body: JSON.stringify({ hostId: "x", hostname: "x" }),
      }),
    );
    expect(exchange.status).toBe(404);
  });

  test("exchange rejects malformed codes with 400", async () => {
    const exchange = await app.handle(
      requestNoAuth("/api/v1/pairing/not-a-code/exchange", {
        method: "POST",
        body: JSON.stringify({ hostId: "x", hostname: "x" }),
      }),
    );
    expect(exchange.status).toBe(400);
  });

  test("exchange returns 503 when a device key cannot be issued (secret key unavailable), and the code stays single-use", async () => {
    const created = await responseObject(
      await app.handle(request("/api/v1/pairing", { method: "POST", body: "{}" })),
    );
    const code = String(created["code"]);
    const savedKey = process.env.LAMASYNC_SECRET_KEY;
    const savedDir = process.env.LAMASYNC_DATA_DIR;
    try {
      // Force insertManagedApiKeyInto's fail-closed path: no env secret
      // key and a data dir that cannot be created.
      delete process.env.LAMASYNC_SECRET_KEY;
      process.env.LAMASYNC_DATA_DIR = "/dev/null/lamasync/none";
      const exchange = await app.handle(
        requestNoAuth(`/api/v1/pairing/${code}/exchange`, {
          method: "POST",
          body: JSON.stringify({ hostId: "x", hostname: "x" }),
        }),
      );
      expect(exchange.status).toBe(503);
    } finally {
      if (savedKey === undefined) delete process.env.LAMASYNC_SECRET_KEY;
      else process.env.LAMASYNC_SECRET_KEY = savedKey;
      if (savedDir === undefined) delete process.env.LAMASYNC_DATA_DIR;
      else process.env.LAMASYNC_DATA_DIR = savedDir;
    }
    // The single-use contract holds even on a failed issuance: a retry
    // with a working secret key still gets 409, not a second mint.
    const retry = await app.handle(
      requestNoAuth(`/api/v1/pairing/${code}/exchange`, {
        method: "POST",
        body: JSON.stringify({ hostId: "x", hostname: "x" }),
      }),
    );
    expect(retry.status).toBe(409);
  });
});

describe("pairing helpers", () => {
  test("effectiveStatus projects pending+expired onto `expired`", () => {
    const now = Date.now();
    const rowPending = {
      id: "x",
      code: "lama-AAAA-BBBB",
      status: "pending",
      expires_at: now + 1000,
      created_at: now,
    };
    const rowExpiredPending = {
      ...rowPending,
      expires_at: now - 1,
    };
    const rowUsed = { ...rowPending, status: "used" };
    expect(__pairingHelpersForTests.effectiveStatus(rowPending, now)).toBe("pending");
    expect(__pairingHelpersForTests.effectiveStatus(rowExpiredPending, now)).toBe("expired");
    expect(__pairingHelpersForTests.effectiveStatus(rowUsed, now)).toBe("used");
  });

  test("pruneExpiredPending flips pending rows whose expiry has elapsed", () => {
    const now = Date.now();
    db.run(
      `INSERT INTO pairing_sessions (id, code, status, expires_at, created_at)
       VALUES (?, 'lama-AAAA-AAAA', 'pending', ?, ?)`,
      [now - 10, now - 10, now - 1000],
    );
    db.run(
      `INSERT INTO pairing_sessions (id, code, status, expires_at, created_at)
       VALUES (?, 'lama-BBBB-BBBB', 'pending', ?, ?)`,
      [now - 20, now + 10000, now],
    );
    const flipped = __pairingHelpersForTests.pruneExpiredPending();
    expect(flipped).toBe(1);
    // Idempotent — second call flips zero.
    expect(__pairingHelpersForTests.pruneExpiredPending()).toBe(0);
    const statuses = db
      .query<{ code: string; status: string }, []>(
        "SELECT code, status FROM pairing_sessions ORDER BY code ASC",
      )
      .all();
    expect(statuses).toEqual([
      { code: "lama-AAAA-AAAA", status: "expired" },
      { code: "lama-BBBB-BBBB", status: "pending" },
    ]);
  });

  test("sweepExpiredPairingSessions deletes only expired rows past the audit window", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // Two expired rows: one old (delete), one fresh (keep).
    db.run(
      `INSERT INTO pairing_sessions (id, code, status, expires_at, created_at)
       VALUES ('old', 'lama-AAAA-AAAA', 'expired', ?, ?)`,
      [now - 10 * day, now - 10 * day],
    );
    db.run(
      `INSERT INTO pairing_sessions (id, code, status, expires_at, created_at)
       VALUES ('fresh', 'lama-BBBB-BBBB', 'expired', ?, ?)`,
      [now - 1000, now - 2000],
    );
    // Pending row, even past expiry, is left alone (the sweep only
    // touches already-expired rows).
    db.run(
      `INSERT INTO pairing_sessions (id, code, status, expires_at, created_at)
       VALUES ('pending', 'lama-CCCC-CCCC', 'pending', ?, ?)`,
      [now - 5 * day, now - 5 * day],
    );
    const deleted = __pairingHelpersForTests.sweepExpiredPairingSessions(24 * 60 * 60 * 1000);
    expect(deleted).toBe(1);
    const remaining = db
      .query<{ id: string }, []>("SELECT id FROM pairing_sessions ORDER BY id ASC")
      .all();
    expect(remaining.map((r) => r.id).sort()).toEqual(["fresh", "pending"]);
  });
});

describe("pairing schema migrations", () => {
  test("table + index exist on a fresh DB", () => {
    const fresh = new Database(":memory:");
    try {
      fresh.exec(SERVER_SCHEMA);
      for (const migration of MIGRATIONS) {
        try { fresh.exec(migration); } catch { /* ignore */ }
      }
      const table = fresh
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='pairing_sessions'",
        )
        .get();
      expect(table?.name).toBe("pairing_sessions");
      const idx = fresh
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pairing_sessions_expires_at'",
        )
        .get();
      expect(idx?.name).toBe("idx_pairing_sessions_expires_at");
    } finally {
      fresh.close();
    }
  });
});
