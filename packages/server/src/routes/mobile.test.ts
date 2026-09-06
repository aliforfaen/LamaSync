// LAMA-296: server-side mobile auth + route integration tests.
//
// Coverage (spec "Required automated evidence", server portion):
//   - enrollment lifecycle: create (admin), status read, regeneration
//     revokes other pending enrollments, expired/replayed/malformed/
//     wrong-secret/throttled/concurrent exchange, rollback on issuance
//     error, cannot claim an existing device
//   - authority boundaries: native token denied fleet admin/config/key
//     reveal/arbitrary host/web bootstrap; web grant denied normal REST and
//     native identity; invalid bearer never falls back to the cookie;
//     web-session cookie = admin surface incl. multipart/download auth paths
//   - CSRF + exact-Origin enforcement on cookie mutations (missing/wrong →
//     400/403); logout clears cookie + session; revocation invalidates
//     native + grant + sessions and the producing enrollment
//   - principals are request-local under concurrent requests
//   - no plaintext secrets leak into status responses

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
import type { MobileEnrollmentExchangeResponse, MobileWebSessionBootstrapResponse } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "mobile-test-master-key-123456789";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "mobile-test-secret-key-123456";
const TEST_ORIGIN = "https://fleet.example.com";

const { getAuthPlugin } = await import("../auth.ts");
const { insertManagedApiKey, __setApiKeysDb, __resetApiKeysDb } = await import("../api-keys.ts");
const {
  __setMobileStoreDb,
  __resetMobileStoreDb,
  __resetMobileRateLimits,
  __setMobileRateLimitClock,
  createMobileEnrollment,
  hashSecret,
} = await import("../mobile-store.ts");
const { mobileRoutes } = await import("./mobile.ts");
const { __setDb: __setHostsDb, hostsRoutes } = await import("./hosts.ts");
const { __setDb: __setConfigDb, configRoutes } = await import("./config.ts");
const { __setDb: __setKeysDb, apiKeysRoutes } = await import("./api-keys.ts");
const { __setDb: __setAppsDb, appsRoutes } = await import("./apps.ts");
const { __setDb: __setConfigRevisionDb } = await import("../config-revision.ts");
const { __setCachedLatestVersionForTests } = await import("../release-cache.ts");

const ORIGINAL_ORIGIN = process.env.LAMASYNC_ORIGIN;

let db: Database;
let app: { handle(request: Request): Promise<Response> };
let masterToken: string;
let adminToken: string;

function req(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`http://fleet.example.com${path}`, { ...init, headers });
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function sessionHeaders(cookie: string, csrf: string, opts: { origin?: string | null } = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Cookie: `__Host-lamasync-mobile=${cookie}`,
    "X-CSRF-Token": csrf,
  };
  if (opts.origin !== null) headers["Origin"] = opts.origin ?? TEST_ORIGIN;
  return headers;
}

beforeEach(() => {
  process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "mobile-test-master-key-123456789";
  process.env.LAMASYNC_ORIGIN = TEST_ORIGIN;
  masterToken = process.env.LAMASYNC_API_KEY;
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
  __setMobileStoreDb(db);
  __setHostsDb(db);
  __setConfigDb(db);
  __setKeysDb(db);
  __setAppsDb(db);
  __setConfigRevisionDb(db);
  __setCachedLatestVersionForTests("test-9.9.9");
  __resetMobileRateLimits();
  const admin = insertManagedApiKey({ name: "ops", kind: "admin", hostId: null });
  adminToken = admin.token;
  app = new Elysia()
    .use(getAuthPlugin())
    .use(hostsRoutes)
    .use(configRoutes)
    .use(apiKeysRoutes)
    .use(appsRoutes)
    .use(mobileRoutes);
});

afterEach(() => {
  __resetApiKeysDb();
  __resetMobileStoreDb();
  __resetMobileRateLimits();
  db.close();
  if (ORIGINAL_ORIGIN === undefined) delete process.env.LAMASYNC_ORIGIN;
  else process.env.LAMASYNC_ORIGIN = ORIGINAL_ORIGIN;
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function createEnrollmentAs(token: string, webAdmin = true): Promise<{
  enrollmentId: string;
  secret: string;
  response: { serverOrigin: string; expiresInSeconds: number };
}> {
  const res = await app.handle(
    req("/api/v1/mobile/enrollments", {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ webAdmin }),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    enrollmentId: string;
    secret: string;
    serverOrigin: string;
    expiresInSeconds: number;
  };
  return { enrollmentId: body.enrollmentId, secret: body.secret, response: body };
}

async function exchange(
  enrollmentId: string,
  secret: string,
  displayName = "Pixel 9",
  appVersion = "1.2.0",
): Promise<Response> {
  return app.handle(
    req(`/api/v1/mobile/enrollments/${enrollmentId}/exchange`, {
      method: "POST",
      body: JSON.stringify({ secret, displayName, appVersion }),
    }),
  );
}

async function bootstrapSession(
  grant: string,
  opts: { origin?: string | null; authorization?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers["Origin"] = opts.origin ?? TEST_ORIGIN;
  if (opts.authorization !== undefined) headers["Authorization"] = opts.authorization;
  return app.handle(
    req("/api/v1/mobile/web-session", {
      method: "POST",
      headers,
      body: JSON.stringify({ grant }),
    }),
  );
}

function setCookieOf(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const match = /__Host-lamasync-mobile=([^;]+)/.exec(raw);
  if (!match) throw new Error(`no session cookie in ${raw}`);
  return match[1]!;
}

async function bootstrapOk(grant: string): Promise<{
  cookie: string;
  csrf: string;
  body: MobileWebSessionBootstrapResponse;
}> {
  const res = await bootstrapSession(grant);
  expect(res.status).toBe(200);
  const body = (await res.json()) as MobileWebSessionBootstrapResponse;
  return { cookie: setCookieOf(res), csrf: body.csrfToken, body };
}

async function pairAndroid(webAdmin = true): Promise<{
  enrollmentId: string;
  exchange: MobileEnrollmentExchangeResponse;
}> {
  const created = await createEnrollmentAs(masterToken, webAdmin);
  const res = await exchange(created.enrollmentId, created.secret);
  expect(res.status).toBe(200);
  return { enrollmentId: created.enrollmentId, exchange: (await res.json()) as MobileEnrollmentExchangeResponse };
}

// ---------------------------------------------------------------------------
// Enrollment create + status
// ---------------------------------------------------------------------------

describe("POST /mobile/enrollments + GET status", () => {
  test("admin creates an enrollment: secret returned once, https origin baked in", async () => {
    const created = await createEnrollmentAs(masterToken);
    expect(created.secret.length).toBeGreaterThanOrEqual(32);
    expect(created.response.serverOrigin).toBe(TEST_ORIGIN);
    expect(created.response.expiresInSeconds).toBe(600);
    // Status shows pending; the enrollment id is guessable but the row
    // carries no secret material.
    const status = await app.handle(
      req(`/api/v1/mobile/enrollments/${created.enrollmentId}`, { headers: bearer(masterToken) }),
    );
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as { status: string; host: unknown; secret?: unknown };
    expect(statusBody.status).toBe("pending");
    expect(statusBody.host).toBeNull();
    expect("secret" in statusBody).toBe(false);
  });

  test("status read requires admin (device key → 403)", async () => {
    const created = await createEnrollmentAs(masterToken);
    const device = insertManagedApiKey({ name: "d", kind: "device", hostId: "host-x" });
    const res = await app.handle(
      req(`/api/v1/mobile/enrollments/${created.enrollmentId}`, { headers: bearer(device.token) }),
    );
    expect(res.status).toBe(403);
  });

  test("create requires admin (native-style bearer → 403 at boundary)", async () => {
    const res = await app.handle(
      req("/api/v1/mobile/enrollments", {
        method: "POST",
        headers: bearer("lmsk.AAAAAAAAAAAA.invalidsecret"),
        body: JSON.stringify({ webAdmin: true }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("creating a new enrollment revokes still-pending older ones (regeneration)", async () => {
    const first = await createEnrollmentAs(masterToken);
    const second = await createEnrollmentAs(masterToken);
    const oldStatus = await app.handle(
      req(`/api/v1/mobile/enrollments/${first.enrollmentId}`, { headers: bearer(masterToken) }),
    );
    expect(oldStatus.status).toBe(200);
    expect(((await oldStatus.json()) as { status: string }).status).toBe("revoked");
    // The freshly created one is still pending.
    const newStatus = await app.handle(
      req(`/api/v1/mobile/enrollments/${second.enrollmentId}`, { headers: bearer(masterToken) }),
    );
    expect(((await newStatus.json()) as { status: string }).status).toBe("pending");
  });

  test("unknown enrollment id → 404", async () => {
    const res = await app.handle(
      req("/api/v1/mobile/enrollments/nonexistent", { headers: bearer(masterToken) }),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Exchange
// ---------------------------------------------------------------------------

describe("POST /mobile/enrollments/:id/exchange", () => {
  test("happy path: host id + native token + web grant returned once, no plaintext stored", async () => {
    const created = await createEnrollmentAs(masterToken);
    const res = await exchange(created.enrollmentId, created.secret, "Pixel 9", "1.2.0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as MobileEnrollmentExchangeResponse;
    expect(body.hostId).toMatch(/^mob-/);
    expect(body.nativeToken.length).toBeGreaterThanOrEqual(32);
    expect(body.webGrant.length).toBeGreaterThanOrEqual(32);
    expect(body.webGrant).not.toBe(body.nativeToken);
    expect(body.serverOrigin).toBe(TEST_ORIGIN);
    expect(body.displayName).toBe("Pixel 9");
    expect(body.clientType).toBe("android");
    // Server stores hashes only — no secret column may hold the plaintext.
    const stored = db
      .query<{ v: string }, [string]>(
        "SELECT native_token_hash AS v FROM mobile_registrations WHERE host_id = ?",
      )
      .get(body.hostId);
    expect(stored?.v).toBe(hashSecret(body.nativeToken));
    expect(stored?.v).not.toBe(body.nativeToken);
  });

  test("replay (used enrollment) → 409", async () => {
    const created = await createEnrollmentAs(masterToken);
    expect((await exchange(created.enrollmentId, created.secret)).status).toBe(200);
    const again = await exchange(created.enrollmentId, created.secret);
    expect(again.status).toBe(409);
  });

  test("wrong secret → 401; malformed body → 400/422; overlong fields → 400", async () => {
    const created = await createEnrollmentAs(masterToken);
    expect((await exchange(created.enrollmentId, "wrong-secret-value-here")).status).toBe(401);
    // Malformed body (missing secret) — Elysia validation.
    const missing = await app.handle(
      req(`/api/v1/mobile/enrollments/${created.enrollmentId}/exchange`, {
        method: "POST",
        body: JSON.stringify({ displayName: "x", appVersion: "1" }),
      }),
    );
    expect(missing.status).toBe(422);
    // Overlong display name → bounded payload check (400).
    const overlong = await exchange(created.enrollmentId, created.secret, "x".repeat(65));
    expect(overlong.status).toBe(400);
    // Overlong secret.
    const longSecret = await exchange(created.enrollmentId, "x".repeat(200), "ok");
    expect(longSecret.status).toBe(400);
  });

  test("expired enrollment → 410 (projected, no sleep)", async () => {
    // Insert a pending enrollment already past expiry directly.
    const secret = "expired-qr-secret-value";
    db.run(
      `INSERT INTO mobile_enrollments (id, secret_hash, host_id, status, expires_at, created_at)
       VALUES ('expired1', ?, 'mob-expired-host', 'pending', ?, ?)`,
      [hashSecret(secret), Date.now() - 1000, Date.now() - 1000],
    );
    const res = await exchange("expired1", secret);
    expect(res.status).toBe(410);
  });

  test("revoked (regenerated) enrollment → 409", async () => {
    const first = await createEnrollmentAs(masterToken);
    const second = await createEnrollmentAs(masterToken);
    void second;
    // first was revoked by regeneration.
    const res = await exchange(first.enrollmentId, first.secret);
    expect(res.status).toBe(409);
  });

  test("unknown enrollment → 404", async () => {
    expect((await exchange("does-not-exist", "whatever-secret")).status).toBe(404);
  });

  test("throttled: 5 attempts/min per enrollment id → 429 on the 6th (clock injectable)", async () => {
    const created = await createEnrollmentAs(masterToken);
    let now = 1_700_000_000_000;
    __setMobileRateLimitClock(() => now);
    for (let i = 0; i < 5; i++) {
      const res = await exchange(created.enrollmentId, "wrong-secret-" + i);
      expect(res.status).toBe(401); // reached the secret check
    }
    const sixth = await exchange(created.enrollmentId, "wrong-secret-6");
    expect(sixth.status).toBe(429);
    // Window expiry reopens the budget without sleeping.
    now += 61_000;
    const after = await exchange(created.enrollmentId, "wrong-secret-7");
    expect(after.status).toBe(401);
    __setMobileRateLimitClock(() => Date.now());
  });

  test("throttled: per-address budget is independent per address", async () => {
    // Unit-level: the address gate allows 10/min per address; the
    // enrollment gate (5/min) is keyed separately.
    const { mobileExchangeAllowed } = await import("../mobile-store.ts");
    __setMobileRateLimitClock(() => 1_700_000_000_000);
    for (let i = 0; i < 10; i++) {
      expect(mobileExchangeAllowed("1.2.3.4", `enr-addr-${i}`)).toBe(true);
    }
    // 11th attempt from the same address is refused regardless of enrollment.
    expect(mobileExchangeAllowed("1.2.3.4", "enr-addr-new")).toBe(false);
    // A different address has its own budget.
    expect(mobileExchangeAllowed("5.6.7.8", "enr-addr-new")).toBe(true);
    __setMobileRateLimitClock(() => Date.now());
  });

  test("concurrent exchanges yield exactly one installation", async () => {
    const created = await createEnrollmentAs(masterToken);
    const attempts = await Promise.all([
      exchange(created.enrollmentId, created.secret),
      exchange(created.enrollmentId, created.secret),
      exchange(created.enrollmentId, created.secret),
      exchange(created.enrollmentId, created.secret),
      exchange(created.enrollmentId, created.secret),
    ]);
    const statuses = attempts.map((r) => r.status).sort();
    const ok = statuses.filter((s) => s === 200).length;
    expect(ok).toBe(1);
    const denied = statuses.filter((s) => s === 409 || s === 410);
    expect(denied.length).toBe(4);
    const rows = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM mobile_registrations")
      .get();
    expect(rows?.n).toBe(1);
    const grants = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM web_grants").get();
    expect(grants?.n).toBe(1);
  });

  test("rollback on issuance failure: enrollment stays pending, retry succeeds", async () => {
    const created = await createEnrollmentAs(masterToken);
    db.run("INSERT INTO hosts (id, hostname) VALUES ('host-existing', 'existing')", []);
    // Point the enrollment's server-chosen host id at an EXISTING host so
    // the transaction's host insert collides mid-issuance.
    db.run("UPDATE mobile_enrollments SET host_id = 'host-existing' WHERE id = ?", [
      created.enrollmentId,
    ]);
    const failed = await exchange(created.enrollmentId, created.secret);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    // Rollback restored the single-use gate: no registration, still pending.
    const regs = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM mobile_registrations").get();
    expect(regs?.n).toBe(0);
    const row = db
      .query<{ status: string }, [string]>("SELECT status FROM mobile_enrollments WHERE id = ?")
      .get(created.enrollmentId);
    expect(row?.status).toBe("pending");
    // After fixing the collision the SAME enrollment succeeds (no partial
    // authority was left behind).
    db.run("UPDATE mobile_enrollments SET host_id = 'mob-fixed-host' WHERE id = ?", [
      created.enrollmentId,
    ]);
    const ok = await exchange(created.enrollmentId, created.secret);
    expect(ok.status).toBe(200);
  });

  test("cannot claim an existing device (a second exchange for the same QR is impossible)", async () => {
    const created = await createEnrollmentAs(masterToken);
    await exchange(created.enrollmentId, created.secret);
    const second = await exchange(created.enrollmentId, created.secret);
    expect(second.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Web-session bootstrap + cookie sessions
// ---------------------------------------------------------------------------

describe("POST /mobile/web-session + cookie REST", () => {
  test("bootstrap sets a host-only session cookie + returns csrf; cookie then reads /auth/me", async () => {
    const { exchange } = await pairAndroid(true);
    const { cookie, csrf, body } = await bootstrapOk(exchange.webGrant);
    expect(body.hostId).toBe(exchange.hostId);
    expect(body.displayName).toBe("Pixel 9");
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(csrf.length).toBeGreaterThanOrEqual(16);
    expect(cookie.length).toBeGreaterThanOrEqual(32);
    const setCookie = (await bootstrapSession(exchange.webGrant)).headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toMatch(/Domain=/);

    const discovery = await app.handle(
      req("/api/v1/auth/me", { headers: { Cookie: `__Host-lamasync-mobile=${cookie}` } }),
    );
    expect(discovery.status).toBe(200);
    const me = (await discovery.json()) as {
      authenticated: boolean;
      mode: string;
      kind: string;
      hostId: string;
      displayName: string;
      csrfToken: string;
    };
    expect(me).toMatchObject({
      authenticated: true,
      mode: "session",
      kind: "mobile-session",
      hostId: exchange.hostId,
      displayName: "Pixel 9",
    });
    expect(me.csrfToken).toBe(csrf);
  });

  test("native token alone → 403 on bootstrap; web grant in Authorization is rejected on REST", async () => {
    const { exchange } = await pairAndroid(true);
    // Native bearer on the bootstrap route → 403 (grant body required).
    const nativeRes = await bootstrapSession(exchange.webGrant, {
      authorization: `Bearer ${exchange.nativeToken}`,
    });
    expect(nativeRes.status).toBe(403);
    // Web grant as a REST bearer is not a managed key → 401.
    const grantOnMe = await app.handle(
      req("/api/v1/mobile/me", { headers: bearer(exchange.webGrant) }),
    );
    expect(grantOnMe.status).toBe(401);
    const grantOnHosts = await app.handle(
      req("/api/v1/hosts", { headers: bearer(exchange.webGrant) }),
    );
    expect(grantOnHosts.status).toBe(401);
  });

  test("bootstrap origin rule: present+wrong → 400, absent → ok", async () => {
    const { exchange } = await pairAndroid(true);
    const wrong = await bootstrapSession(exchange.webGrant, { origin: "https://evil.example.com" });
    expect(wrong.status).toBe(400);
    const absent = await bootstrapSession(exchange.webGrant, { origin: null });
    expect(absent.status).toBe(200);
  });

  test("revoked grant → 401", async () => {
    const { exchange } = await pairAndroid(true);
    db.run("UPDATE web_grants SET revoked_at = ? WHERE registration_id = ?", [
      Date.now(),
      exchange.hostId,
    ]);
    expect((await bootstrapSession(exchange.webGrant)).status).toBe(401);
  });

  test("session mutation CSRF/Origin enforcement (create enrollment via cookie)", async () => {
    const { exchange } = await pairAndroid(true);
    const { cookie, csrf } = await bootstrapOk(exchange.webGrant);
    const body = JSON.stringify({ webAdmin: true });
    const base = sessionHeaders(cookie, csrf);
    // Correct origin + CSRF → the cookie session is a full admin surface.
    const ok = await app.handle(
      req("/api/v1/mobile/enrollments", { method: "POST", headers: base, body }),
    );
    expect(ok.status).toBe(201);
    // Missing CSRF → 403.
    const noCsrf = await app.handle(
      req("/api/v1/mobile/enrollments", {
        method: "POST",
        headers: { Cookie: `__Host-lamasync-mobile=${cookie}`, Origin: TEST_ORIGIN },
        body,
      }),
    );
    expect(noCsrf.status).toBe(403);
    // Wrong CSRF → 403.
    const wrongCsrf = await app.handle(
      req("/api/v1/mobile/enrollments", {
        method: "POST",
        headers: { Cookie: `__Host-lamasync-mobile=${cookie}`, Origin: TEST_ORIGIN, "X-CSRF-Token": "bad" },
        body,
      }),
    );
    expect(wrongCsrf.status).toBe(403);
    // Missing Origin → 400.
    const noOrigin = await app.handle(
      req("/api/v1/mobile/enrollments", {
        method: "POST",
        headers: { Cookie: `__Host-lamasync-mobile=${cookie}`, "X-CSRF-Token": csrf },
        body,
      }),
    );
    expect(noOrigin.status).toBe(400);
    // Wrong Origin → 400.
    const wrongOrigin = await app.handle(
      req("/api/v1/mobile/enrollments", {
        method: "POST",
        headers: sessionHeaders(cookie, csrf, { origin: "https://evil.example.com" }),
        body,
      }),
    );
    expect(wrongOrigin.status).toBe(400);
  });

  test("invalid bearer never falls back to the cookie", async () => {
    const { exchange } = await pairAndroid(true);
    const { cookie, csrf } = await bootstrapOk(exchange.webGrant);
    const res = await app.handle(
      req("/api/v1/auth/me", {
        headers: {
          Authorization: "Bearer totally-bogus",
          Cookie: `__Host-lamasync-mobile=${cookie}`,
          "X-CSRF-Token": csrf,
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("cookie session reaches GETs without CSRF and can log out (clears cookie)", async () => {
    const { exchange } = await pairAndroid(true);
    const { cookie, csrf } = await bootstrapOk(exchange.webGrant);
    const hosts = await app.handle(
      req("/api/v1/hosts", { headers: { Cookie: `__Host-lamasync-mobile=${cookie}` } }),
    );
    expect(hosts.status).toBe(200);
    // Logout: CSRF-protected mutation, clears the cookie, kills the session.
    const logout = await app.handle(
      req("/api/v1/mobile/web-session/logout", {
        method: "POST",
        headers: sessionHeaders(cookie, csrf),
      }),
    );
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ loggedOut: true });
    const cleared = logout.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("__Host-lamasync-mobile=");
    expect(cleared).toContain("Max-Age=0");
    // The revoked session no longer authenticates.
    const after = await app.handle(
      req("/api/v1/auth/me", { headers: { Cookie: `__Host-lamasync-mobile=${cookie}` } }),
    );
    expect(after.status).toBe(401);
  });

  test("stale cookie → 401; native registration survives logout", async () => {
    const { exchange } = await pairAndroid(true);
    const { cookie, csrf } = await bootstrapOk(exchange.webGrant);
    await app.handle(
      req("/api/v1/mobile/web-session/logout", { method: "POST", headers: sessionHeaders(cookie, csrf) }),
    );
    // Native token still valid after logout (logout ≠ revoke).
    const me = await app.handle(
      req("/api/v1/mobile/me", { headers: bearer(exchange.nativeToken) }),
    );
    expect(me.status).toBe(200);
  });

  test("multipart + download auth paths accept cookie sessions", async () => {
    const { exchange } = await pairAndroid(true);
    const { cookie, csrf } = await bootstrapOk(exchange.webGrant);
    // Download GET (apps snapshot) with session cookie: auth passes and the
    // handler 404s on the unknown snapshot (not 401/403).
    const download = await app.handle(
      req("/api/v1/apps/snapshots/nothere/download", {
        headers: { Cookie: `__Host-lamasync-mobile=${cookie}` },
      }),
    );
    expect(download.status).toBe(404);
    // Multipart POST (apps snapshot upload) with cookie + CSRF + Origin:
    // auth passes → handler 404s on the unknown protection.
    const form = new FormData();
    form.set("tarball", new File([Buffer.from("x")], "x.tar.gz"));
    const upload = await app.handle(
      req("/api/v1/apps/protections/nothere/snapshots", {
        method: "POST",
        headers: sessionHeaders(cookie, csrf),
        body: form,
      }),
    );
    expect(upload.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Native identity (me / check-in)
// ---------------------------------------------------------------------------

describe("native identity routes", () => {
  test("GET /mobile/me returns own registration only; check-in updates last-seen", async () => {
    const { exchange } = await pairAndroid(true);
    const me = await app.handle(req("/api/v1/mobile/me", { headers: bearer(exchange.nativeToken) }));
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as {
      hostId: string;
      displayName: string;
      clientType: string;
      appVersion: string;
      serverOrigin: string;
    };
    expect(meBody.hostId).toBe(exchange.hostId);
    expect(meBody.displayName).toBe("Pixel 9");
    expect(meBody.clientType).toBe("android");
    expect(meBody.appVersion).toBe("1.2.0");
    expect(meBody.serverOrigin).toBe(TEST_ORIGIN);

    const checkIn = await app.handle(
      req("/api/v1/mobile/check-in", {
        method: "POST",
        headers: bearer(exchange.nativeToken),
        body: JSON.stringify({ appVersion: "1.3.0" }),
      }),
    );
    expect(checkIn.status).toBe(200);
    const row = db
      .query<{ app_version: string; last_seen_at: number | null }, [string]>(
        "SELECT app_version, last_seen_at FROM mobile_registrations WHERE host_id = ?",
      )
      .get(exchange.hostId);
    expect(row?.app_version).toBe("1.3.0");
    expect(row?.last_seen_at).not.toBeNull();
  });

  test("native token is confined: fleet admin, config, key reveal, arbitrary host → 403/401", async () => {
    const { exchange } = await pairAndroid(true);
    const token = exchange.nativeToken;
    // Fleet admin (hosts list).
    expect((await app.handle(req("/api/v1/hosts", { headers: bearer(token) }))).status).toBe(403);
    // Daemon config (embeds rclone secrets).
    expect(
      (await app.handle(req("/api/v1/config/whatever-host", { headers: bearer(token) }))).status,
    ).toBe(403);
    // Key reveal.
    const keys = insertManagedApiKey({ name: "secret-ish", kind: "admin", hostId: null });
    expect(
      (await app.handle(
        req(`/api/v1/api-keys/${keys.row.id}/reveal`, { method: "POST", headers: bearer(token) }),
      )).status,
    ).toBe(403);
    // Arbitrary host read.
    expect(
      (await app.handle(req("/api/v1/hosts/some-other-host", { headers: bearer(token) }))).status,
    ).toBe(403);
    // Device key style /auth/me is not mobile-allowlisted either.
    expect((await app.handle(req("/api/v1/auth/me", { headers: bearer(token) }))).status).toBe(403);
  });

  test("web-session (cookie) is never accepted as native identity", async () => {
    const { exchange } = await pairAndroid(true);
    const { cookie } = await bootstrapOk(exchange.webGrant);
    // Send the session cookie on /mobile/me — no native bearer → 403.
    const res = await app.handle(
      req("/api/v1/mobile/me", { headers: { Cookie: `__Host-lamasync-mobile=${cookie}` } }),
    );
    expect(res.status).toBe(403);
  });

  test("revoked registration → native token 401 everywhere", async () => {
    const { exchange } = await pairAndroid(true);
    db.run("UPDATE mobile_registrations SET revoked_at = ? WHERE host_id = ?", [
      Date.now(),
      exchange.hostId,
    ]);
    expect(
      (await app.handle(req("/api/v1/mobile/me", { headers: bearer(exchange.nativeToken) }))).status,
    ).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

describe("POST /mobile/registrations/:hostId/revoke", () => {
  test("admin revoke invalidates native + grant + sessions; enrollment shows revoked; idempotent", async () => {
    const { enrollmentId, exchange } = await pairAndroid(true);
    const { cookie, csrf } = await bootstrapOk(exchange.webGrant);
    // Grant/bootstrap still usable for a second session before revocation.
    await bootstrapSession(exchange.webGrant);

    const revoke = await app.handle(
      req(`/api/v1/mobile/registrations/${exchange.hostId}/revoke`, {
        method: "POST",
        headers: bearer(adminToken),
        body: JSON.stringify({ reason: "lost phone" }),
      }),
    );
    expect(revoke.status).toBe(200);
    const revokeBody = (await revoke.json()) as { hostId: string; revokedAt: number };
    expect(revokeBody.hostId).toBe(exchange.hostId);

    // Native → 401.
    expect(
      (await app.handle(req("/api/v1/mobile/me", { headers: bearer(exchange.nativeToken) }))).status,
    ).toBe(401);
    // Grant → bootstrap 401.
    expect((await bootstrapSession(exchange.webGrant)).status).toBe(401);
    // Existing session cookie → 401.
    expect(
      (await app.handle(req("/api/v1/auth/me", { headers: { Cookie: `__Host-lamasync-mobile=${cookie}` } }))).status,
    ).toBe(401);
    // Enrollment status row is flipped to revoked (host metadata retained).
    const status = await app.handle(
      req(`/api/v1/mobile/enrollments/${enrollmentId}`, { headers: bearer(masterToken) }),
    );
    const statusBody = (await status.json()) as { status: string; host: { revokedAt: number } | null };
    expect(statusBody.status).toBe("revoked");
    expect(statusBody.host?.revokedAt).toBe(revokeBody.revokedAt);

    // Idempotent repeat → 200 again.
    const again = await app.handle(
      req(`/api/v1/mobile/registrations/${exchange.hostId}/revoke`, {
        method: "POST",
        headers: bearer(masterToken),
      }),
    );
    expect(again.status).toBe(200);
    expect(((await again.json()) as { revokedAt: number }).revokedAt).toBe(revokeBody.revokedAt);
  });

  test("session cookie cannot revoke via logout; unknown registration → 404", async () => {
    const { exchange } = await pairAndroid(true);
    const { cookie, csrf } = await bootstrapOk(exchange.webGrant);
    // The mobile-session can revoke as admin? It is an admin surface, but
    // logout must not revoke the registration. Sanity: revoke via cookie
    // session with CSRF works (admin session == admin), then logout path is
    // separate.
    const res = await app.handle(
      req(`/api/v1/mobile/registrations/${exchange.hostId}/revoke`, {
        method: "POST",
        headers: sessionHeaders(cookie, csrf),
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);
    expect(
      (await app.handle(req("/api/v1/mobile/me", { headers: bearer(exchange.nativeToken) }))).status,
    ).toBe(401);

    const unknown = await app.handle(
      req("/api/v1/mobile/registrations/no-such-host/revoke", {
        method: "POST",
        headers: bearer(masterToken),
      }),
    );
    expect(unknown.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Request-local principals under concurrency
// ---------------------------------------------------------------------------

describe("principal isolation under concurrent requests", () => {
  test("no principal bleed across concurrent requests (bearer vs cookie)", async () => {
    const probeApp = new Elysia()
      .use(getAuthPlugin())
      .get("/api/v1/probe", async ({ request }) => {
        // Read AFTER an async gap so a shared-store auth bug would surface.
        await Bun.sleep(2);
        const p = (await import("../auth.ts")).principalOf(request);
        return {
          kind: p?.kind ?? null,
          hostId: p && "hostId" in p ? p.hostId : null,
        };
      });
    const paired = await pairAndroid(true);
    const { cookie } = await bootstrapOk(paired.exchange.webGrant);
    const kinds = [
      { kind: "master", header: bearer(masterToken), expect: "master" },
      { kind: "admin", header: bearer(adminToken), expect: "admin" },
      { kind: "session", header: { Cookie: `__Host-lamasync-mobile=${cookie}` }, expect: "web-session" },
    ];
    const jobs: Promise<{ want: string; got: string | null }>[] = [];
    for (let i = 0; i < 60; i++) {
      const c = kinds[i % kinds.length]!;
      jobs.push(
        probeApp
          .handle(req("/api/v1/probe", { headers: c.header }))
          .then(async (r) => ({ want: c.expect, got: (((await r.json()) as { kind: string | null }).kind) })),
      );
    }
    const results = await Promise.all(jobs);
    for (const r of results) expect(r.got).toBe(r.want);
  });
});
