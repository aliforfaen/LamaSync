// LAMA-296: mobile web-session WebSocket auth + live revocation tests.
//
// Evidence (spec): cookie upgrades require an exact Origin + a live admin
// session; existing bearer subprotocol support is preserved; revoking a
// mobile registration or expiring/logging out its session immediately
// disconnects live connections in-process; a restart revalidates stored
// state (each connection re-checks the DB rows at upgrade time).
//
// Timer note: this is an integration suite that deliberately exercises the
// platform clock — the in-process session-expiry timer (12 h absolute → a
// short-lived row) closes live sockets on real time, so deterministic fake
// timers cannot drive the server's socket lifecycle. Waits below poll at
// 10 ms for an observed message/close; the only fixed sleeps are 40 ms
// socket-settle pauses (Bun's server.stop() otherwise hangs on sockets the
// close frame has not yet fully reaped).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "mobile-ws-master-key-123456789";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "mobile-ws-secret-key-123456";
const TEST_ORIGIN = "https://fleet.example.com";
const ORIGINAL_ORIGIN = process.env.LAMASYNC_ORIGIN;

const { __setApiKeysDb, __resetApiKeysDb } = await import("./api-keys.ts");
const {
  __setMobileStoreDb,
  __resetMobileStoreDb,
  bootstrapMobileWebSession,
  createMobileEnrollment,
  exchangeMobileEnrollment,
  hashSecret,
  revokeMobileRegistration,
  revokeMobileWebSession,
} = await import("./mobile-store.ts");
const { wsRoutes, disconnectMobileRegistration, disconnectWebSession } = await import("./ws.ts");

let db: Database;
let serverApp: { stop: () => Promise<unknown> } | null = null;
let port: number;

async function startServer(): Promise<number> {
  const app = new Elysia().use(wsRoutes);
  serverApp = app;
  await app.listen({ port: 0, hostname: "127.0.0.1" });
  const p = (app.server as unknown as { port: number } | null)?.port;
  if (!p) throw new Error("no ws port");
  return p;
}

beforeAll(async () => {
  port = await startServer();
}, 20_000);

afterAll(async () => {
  await Bun.sleep(80); // let final close frames reap on the server side
  // Bun's server.stop() can linger on sockets whose close frame just
  // finished; the runner tears the process down right after, so cap it.
  await Promise.race([serverApp?.stop(), Bun.sleep(2000)]);
  serverApp = null;
}, 5000);

beforeEach(() => {
  process.env.LAMASYNC_ORIGIN = TEST_ORIGIN;
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
});

afterEach(() => {
  __resetApiKeysDb();
  __resetMobileStoreDb();
  db.close();
  if (ORIGINAL_ORIGIN === undefined) delete process.env.LAMASYNC_ORIGIN;
  else process.env.LAMASYNC_ORIGIN = ORIGINAL_ORIGIN;
});

interface WsHarness {
  socket: WebSocket;
  messages: string[];
  closed: Promise<void>;
}

function connect(headers: Record<string, string>): WsHarness {
  // Bun's native WebSocket accepts { headers } as its second argument at
  // runtime; the ambient DOM/lib typing only exposes the protocols
  // overload, so the constructor is narrowed once here (upgrade cookies +
  // Origin cannot ride any typed overload).
  const Ctor = WebSocket as unknown as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => WebSocket;
  const socket = new Ctor(`ws://127.0.0.1:${port}/api/v1/ws`, { headers });
  const messages: string[] = [];
  socket.onmessage = (ev) => {
    messages.push(String(ev.data));
  };
  const closed = new Promise<void>((resolve) => {
    socket.onclose = () => resolve();
  });
  return { socket, messages, closed };
}

async function open(headers: Record<string, string>, timeoutMs = 3000): Promise<WsHarness> {
  const h = connect(headers);
  await Promise.race([
    new Promise<void>((resolve) => {
      h.socket.onopen = () => resolve();
    }),
    new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error("ws open timeout")), timeoutMs);
    }),
  ]);
  return h;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

async function closeWs(h: WsHarness): Promise<void> {
  try {
    h.socket.close();
  } catch {
    // already closed
  }
  await Promise.race([h.closed, Bun.sleep(300)]);
  await Bun.sleep(40); // let the server-side close handler reap the socket
}

/** Seed one paired android registration + a live web session. Returns the
 *  session cookie secret + registration host id. */
function seedPairedSession(opts: { nearExpiryMs?: number } = {}): {
  cookieSecret: string;
  hostId: string;
} {
  const created = createMobileEnrollment({ webAdmin: true, clientType: "android" });
  const outcome = exchangeMobileEnrollment({
    enrollmentId: created.enrollmentId,
    secret: created.secret,
    displayName: "Pixel 9",
    appVersion: "1.2.0",
  });
  if (outcome.kind !== "ok") throw new Error("exchange failed");
  const boot = bootstrapMobileWebSession(outcome.response.webGrant);
  if (boot.kind !== "ok") throw new Error("bootstrap failed");
  if (opts.nearExpiryMs !== undefined) {
    db.run("UPDATE web_sessions SET expires_at = ? WHERE session_hash = ?", [
      Date.now() + opts.nearExpiryMs,
      hashSecret(boot.sessionSecret),
    ]);
  }
  return { cookieSecret: boot.sessionSecret, hostId: outcome.hostId };
}

function sessionIdOf(secret: string): string {
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM web_sessions WHERE session_hash = ?")
    .get(hashSecret(secret));
  if (!row) throw new Error("session not found");
  return row.id;
}

describe("WebSocket mobile session upgrades", () => {
  test("bearer subprotocol (master key) still connects (legacy contract)", async () => {
    const master = process.env.LAMASYNC_API_KEY!;
    const h = await open({
      "Sec-WebSocket-Protocol": `lamasync-auth, ${Buffer.from(master).toString("base64url")}`,
    });
    await waitFor(() => h.messages.some((m) => m.includes('"hello"')));
    expect(h.messages[0]).toContain('"hello"');
    await closeWs(h);
  });

  test("garbage bearer → error + close", async () => {
    const h = await open({ "Sec-WebSocket-Protocol": "lamasync-auth, bm9wZQ==" });
    await waitFor(() => h.messages.some((m) => m.includes("unauthorized")));
    expect(h.messages[0]).toContain("unauthorized");
    await h.closed;
  });

  test("session cookie + exact Origin connects", async () => {
    const { cookieSecret } = seedPairedSession();
    const h = await open({ Origin: TEST_ORIGIN, Cookie: `__Host-lamasync-mobile=${cookieSecret}` });
    await waitFor(() => h.messages.some((m) => m.includes('"hello"')));
    await closeWs(h);
  });

  test("cookie upgrade without Origin → refused", async () => {
    const { cookieSecret } = seedPairedSession();
    const h = await open({ Cookie: `__Host-lamasync-mobile=${cookieSecret}` });
    await waitFor(() => h.messages.some((m) => m.includes("origin not allowed")));
    await h.closed;
  });

  test("cookie upgrade with wrong Origin → refused", async () => {
    const { cookieSecret } = seedPairedSession();
    const h = await open({ Origin: "https://evil.example.com", Cookie: `__Host-lamasync-mobile=${cookieSecret}` });
    await waitFor(() => h.messages.some((m) => m.includes("origin not allowed")));
    await h.closed;
  });

  test("revoked registration refuses a NEW upgrade (restart revalidation analog)", async () => {
    const { cookieSecret, hostId } = seedPairedSession();
    revokeMobileRegistration(hostId, "stolen");
    const h = await open({ Origin: TEST_ORIGIN, Cookie: `__Host-lamasync-mobile=${cookieSecret}` });
    await waitFor(() => h.messages.some((m) => m.includes("unauthorized")));
    await h.closed;
  });

  test("revoking a registration disconnects its LIVE connection in-process", async () => {
    const { cookieSecret, hostId } = seedPairedSession();
    const h = await open({ Origin: TEST_ORIGIN, Cookie: `__Host-lamasync-mobile=${cookieSecret}` });
    await waitFor(() => h.messages.some((m) => m.includes('"hello"')));
    revokeMobileRegistration(hostId, "lost phone");
    disconnectMobileRegistration(hostId);
    await waitFor(() => h.messages.some((m) => m.includes("registration revoked")));
    expect(h.messages.at(-1)).toContain("registration revoked");
    await h.closed;
  });

  test("logout (session revoked) disconnects its LIVE connection; bearer unaffected", async () => {
    const { cookieSecret } = seedPairedSession();
    const h = await open({ Origin: TEST_ORIGIN, Cookie: `__Host-lamasync-mobile=${cookieSecret}` });
    await waitFor(() => h.messages.some((m) => m.includes('"hello"')));
    // Bearer connection stays up while the cookie session is logged out.
    const master = process.env.LAMASYNC_API_KEY!;
    const bearerWs = await open({ "Sec-WebSocket-Protocol": `lamasync-auth, ${master}` });
    revokeMobileWebSession(cookieSecret);
    disconnectWebSession(sessionIdOf(cookieSecret));
    await waitFor(() => h.messages.some((m) => m.includes("session logged out")));
    await h.closed;
    expect(bearerWs.socket.readyState).toBe(WebSocket.OPEN);
    await closeWs(bearerWs);
  });

  test("session expiry stops delivery to the live connection (absolute expiry)", async () => {
    const { cookieSecret } = seedPairedSession({ nearExpiryMs: 150 });
    const h = await open({ Origin: TEST_ORIGIN, Cookie: `__Host-lamasync-mobile=${cookieSecret}` });
    await waitFor(() => h.messages.some((m) => m.includes('"hello"')));
    await waitFor(() => h.messages.some((m) => m.includes("session expired")), 2000);
    expect(h.messages.at(-1)).toContain("session expired");
    await h.closed;
  });

  test("non-admin session (admin:0 grant) is refused the fleet stream", async () => {
    // LAMA-296 review finding 4: bootstrap now REFUSES admin:0 grants
    // outright (403 — see mobile.test.ts), so no such session can be
    // issued through the API anymore. This row is hand-seeded directly to
    // keep exercising the WebSocket gate's own admin check against stored
    // half-privileged state.
    const { cookieSecret } = seedPairedSession();
    db.run("UPDATE web_sessions SET admin = 0 WHERE session_hash = ?", [
      hashSecret(cookieSecret),
    ]);
    const h = await open({ Origin: TEST_ORIGIN, Cookie: `__Host-lamasync-mobile=${cookieSecret}` });
    await waitFor(() => h.messages.some((m) => m.includes("forbidden")));
    await h.closed;
  });
});
