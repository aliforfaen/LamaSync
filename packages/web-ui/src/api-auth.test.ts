// LAMA-296: SPA dual-mode auth — bearer vs cookie web-session.
//
// Covers the wave-2 acceptance surface for web-ui/src/api.ts:
//   - session discovery: GET /api/v1/auth/me (cookie only) detects a live
//     mobile session and installs in-memory session auth (hostId,
//     displayName, CSRF token) — no dummy key ever touches sessionStorage
//   - an invalid Authorization header FAILS (401) and never falls back to
//     the cookie
//   - the CSRF header rides on cookie-authenticated mutations and is absent
//     for bearer requests (bearer sends Authorization instead)
//   - logout clears local session state and calls ONLY the web-session
//     logout endpoint — nothing server-side beyond the session is touched
//
// The module under test is DOM-free until called, so we install minimal
// sessionStorage/localStorage/window stubs and a scripted global fetch.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  apiFetch,
  clearApiKey,
  clearSessionAuth,
  CSRF_HEADER,
  getAuthMode,
  getSessionAuth,
  probeSession,
  sessionLogout,
  setApiKey,
  UNAUTHORIZED_EVENT,
  type AuthMeInfo,
} from "./api.ts";

// ---------------------------------------------------------------------------
// Stub plumbing
// ---------------------------------------------------------------------------

// Captured once at module load: Bun's test runner shares a process across
// files, so replacing the global must be reverted in afterEach — deleting it
// leaves fetch === undefined for every later file in the same run.
const originalFetch: typeof globalThis.fetch = globalThis.fetch;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => {
      const keys = [...map.keys()];
      return index >= 0 && index < keys.length ? (keys[index] as string) : null;
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  };
}

const dispatched: Event[] = [];

function installWindow(): void {
  dispatched.length = 0;
  const stub = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: (e: Event) => {
      dispatched.push(e);
      return true;
    },
  };
  // The full Window surface is irrelevant here; the stub only needs the
  // event trio notifyUnauthorized touches.
  globalThis.window = stub as unknown as Window & typeof globalThis;
}

// Scripted fetch: every call is recorded; the handler decides the response.
type FetchCall = { url: string; init: RequestInit };
let fetchCalls: FetchCall[] = [];
let fetchHandler: (call: FetchCall) => Response | Promise<Response>;

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>): void {
  fetchCalls = [];
  fetchHandler = handler;
  const stub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push({ url, init: init ?? {} });
    return fetchHandler({ url, init: init ?? {} });
  };
  // Test seam: the runtime fetch is a plain function; the global type adds
  // static helpers (e.g. preconnect) irrelevant to these tests.
  globalThis.fetch = stub as typeof fetch;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headersOf(call: FetchCall): Headers {
  return new Headers(call.init.headers);
}

const SESSION_ME: AuthMeInfo = {
  authenticated: true,
  mode: "session",
  kind: "mobile-session",
  keyId: null,
  name: "Pixel 9",
  hostId: "host-pixel-9",
  displayName: "Pixel 9",
  clientType: "android",
  expiresAt: 1_784_000_000_000,
  csrfToken: "csrf-token-abc",
};

const SESSION_CREATE = {
  enrollmentId: "enr_9zXy7AbC",
  secret: "s3cR3t_MiXeDcAsE",
  serverOrigin: "https://fleet.example.com",
  clientType: "android",
  webAdmin: true,
  expiresAt: 1_783_999_400_000,
  expiresInSeconds: 600,
};

beforeEach(() => {
  globalThis.sessionStorage = memoryStorage();
  globalThis.localStorage = memoryStorage();
  installWindow();
  clearApiKey();
  clearSessionAuth();
});

afterEach(() => {
  clearApiKey();
  clearSessionAuth();
  globalThis.fetch = originalFetch;
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  delete (globalThis as { localStorage?: unknown }).localStorage;
  delete (globalThis as { window?: unknown }).window;
});

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

describe("probeSession — session discovery via GET /auth/me", () => {
  it("installs session auth from a live-session response (cookie only, no dummy key)", async () => {
    installFetch((call) => {
      expect(call.url).toBe("/api/v1/auth/me");
      expect(call.init.method ?? "GET").toBe("GET");
      // Discovery never sends an Authorization header.
      expect(headersOf(call).has("authorization")).toBe(false);
      expect(call.init.credentials).toBe("same-origin");
      return json(200, SESSION_ME);
    });

    const result = await probeSession();

    expect(result).toEqual({ mode: "session" });
    expect(getAuthMode()).toBe("session");
    expect(getSessionAuth()).toEqual({
      hostId: "host-pixel-9",
      displayName: "Pixel 9",
      clientType: "android",
      expiresAt: SESSION_ME.expiresAt,
      csrfToken: "csrf-token-abc",
    });
    // No dummy key: storage stays empty (the cookie is HttpOnly and never
    // re-created by the SPA).
    expect(globalThis.sessionStorage.getItem("lamasync_api_key")).toBeNull();
  });

  it("returns none on 401 (no/expired/revoked session)", async () => {
    installFetch(() => json(401, { error: "Unauthorized" }));
    expect(await probeSession()).toEqual({ mode: "none", reachable: true });
    expect(getAuthMode()).toBe("none");
    expect(getSessionAuth()).toBeNull();
  });

  it("returns none for a 200 that is not a live session payload", async () => {
    installFetch(() =>
      json(200, { authenticated: false, mode: "session" }),
    );
    expect(await probeSession()).toEqual({ mode: "none", reachable: true });
    installFetch(() => json(200, { authenticated: true, mode: "bearer", kind: "admin" }));
    expect(await probeSession()).toEqual({ mode: "none", reachable: true });
    expect(getSessionAuth()).toBeNull();
  });

  it("returns unreachable when the server cannot be reached", async () => {
    installFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await probeSession()).toEqual({ mode: "none", reachable: false });
  });

  it("clears any stale in-memory session when the probe comes back negative", async () => {
    installFetch(() => json(200, SESSION_ME));
    await probeSession();
    expect(getAuthMode()).toBe("session");

    installFetch(() => json(401, { error: "Unauthorized" }));
    expect(await probeSession()).toEqual({ mode: "none", reachable: true });
    expect(getAuthMode()).toBe("none");
  });
});

describe("auth mode resolution", () => {
  it("is none without a key or session", () => {
    expect(getAuthMode()).toBe("none");
  });

  it("is bearer when a key is stored, even with session auth present", async () => {
    installFetch(() => json(200, SESSION_ME));
    await probeSession();
    setApiKey("lmsk.admin.123", false);
    expect(getAuthMode()).toBe("bearer");
  });
});

// ---------------------------------------------------------------------------
// Bearer path + invalid-bearer hard fail
// ---------------------------------------------------------------------------

describe("bearer requests", () => {
  it("send Authorization on every method and never a CSRF header", async () => {
    installFetch((call) => {
      const headers = headersOf(call);
      expect(headers.get("authorization")).toBe("Bearer lmsk.admin.123");
      expect(headers.has(CSRF_HEADER)).toBe(false);
      return json(200, { ok: true });
    });
    setApiKey("lmsk.admin.123", false);
    await apiFetch("/health", { method: "POST", body: JSON.stringify({}) });
    expect(fetchCalls).toHaveLength(1);
  });
});

describe("invalid bearer fails — never silently falls back to the cookie", () => {
  it("keeps the bearer on a 401 and logs out instead of retrying via cookie", async () => {
    // A live cookie session exists, but a (rotten) stored key must win: the
    // request carries the invalid Authorization, the server rejects it, and
    // the SPA drops to login — it does NOT fall back to the cookie.
    installFetch(() => json(200, SESSION_ME));
    await probeSession();

    installFetch((call) => {
      const headers = headersOf(call);
      expect(headers.get("authorization")).toBe("Bearer rotten-key");
      expect(headers.has(CSRF_HEADER)).toBe(false);
      return json(401, { error: "Unauthorized" });
    });
    setApiKey("rotten-key", false);

    await expect(
      apiFetch("/hosts", { method: "POST", body: JSON.stringify({}) }),
    ).rejects.toMatchObject({ status: 401 });

    expect(getAuthMode()).toBe("none");
    expect(getApiKeyStored()).toBeNull();
    expect(getSessionAuth()).toBeNull();
    expect(dispatched.some((e) => e.type === UNAUTHORIZED_EVENT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CSRF: cookie mutations only
// ---------------------------------------------------------------------------

describe("CSRF header placement", () => {
  async function installSession(): Promise<void> {
    installFetch(() => json(200, SESSION_ME));
    await probeSession();
  }

  it("attaches X-CSRF-Token to cookie-authenticated mutations", async () => {
    await installSession();
    installFetch((call) => {
      const headers = headersOf(call);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.get(CSRF_HEADER)).toBe("csrf-token-abc");
      expect(call.init.credentials).toBe("same-origin");
      return json(200, { ok: true });
    });
    await apiFetch("/pause", { method: "POST", body: JSON.stringify({ mode: "slow" }) });
  });

  it("omits X-CSRF-Token on cookie-authenticated reads", async () => {
    await installSession();
    installFetch((call) => {
      const headers = headersOf(call);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has(CSRF_HEADER)).toBe(false);
      return json(200, []);
    });
    await apiFetch("/hosts", { method: "GET" });
  });

  it("never adds CSRF to bearer mutations (Authorization is the credential)", async () => {
    setApiKey("lmsk.admin.123", false);
    installFetch((call) => {
      const headers = headersOf(call);
      expect(headers.get("authorization")).toBe("Bearer lmsk.admin.123");
      expect(headers.has(CSRF_HEADER)).toBe(false);
      return json(200, { ok: true });
    });
    await apiFetch("/pause", { method: "POST", body: JSON.stringify({ mode: "slow" }) });
  });

  it("multipart uploads carry CSRF in session mode (no Authorization, no forced content-type)", async () => {
    await installSession();
    installFetch((call) => {
      expect(call.url).toBe("/api/v1/folders/folder-1/files");
      expect(call.init.method ?? "GET").toBe("POST");
      const headers = headersOf(call);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.get(CSRF_HEADER)).toBe("csrf-token-abc");
      // The client never forces a content-type on FormData — the browser
      // adds the multipart boundary itself (a forced JSON type would break
      // the upload).
      expect(headers.has("content-type")).toBe(false);
      return json(200, { ok: true, name: "x.bin", path: "/x.bin", size: 1 });
    });
    await api.uploadFolderFile("folder-1", new Blob(["x"]), {});
  });

  it("multipart uploads carry the bearer in bearer mode and no CSRF", async () => {
    setApiKey("lmsk.admin.123", false);
    installFetch((call) => {
      const headers = headersOf(call);
      expect(headers.get("authorization")).toBe("Bearer lmsk.admin.123");
      expect(headers.has(CSRF_HEADER)).toBe(false);
      return json(200, { ok: true, name: "x.bin", path: "/x.bin", size: 1 });
    });
    await api.uploadFolderFile("folder-1", new Blob(["x"]), {});
  });
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

describe("session logout", () => {
  async function installSession(): Promise<void> {
    installFetch(() => json(200, SESSION_ME));
    await probeSession();
  }

  it("invalidates the web session only and clears local state", async () => {
    await installSession();
    installFetch((call) => {
      // The ONLY server call during logout is the web-session logout POST —
      // never a registration revoke or any other destructive route.
      expect(call.url).toBe("/api/v1/mobile/web-session/logout");
      expect(call.init.method ?? "GET").toBe("POST");
      expect(headersOf(call).get(CSRF_HEADER)).toBe("csrf-token-abc");
      return json(200, { loggedOut: true });
    });

    const result = await sessionLogout();

    expect(result).toBe("logged-out");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("/api/v1/mobile/web-session/logout");
    expect(getAuthMode()).toBe("none");
    expect(getSessionAuth()).toBeNull();
  });

  it("reports failure and KEEPS the session when the server is unreachable", async () => {
    await installSession();
    installFetch(() => json(500, { error: "boom" }));
    expect(await sessionLogout()).toBe("failed");
    expect(getAuthMode()).toBe("session");
    expect(getSessionAuth()?.csrfToken).toBe("csrf-token-abc");
  });

  it("treats a 401 as already-invalid and clears local state", async () => {
    await installSession();
    installFetch(() => json(401, { error: "Unauthorized" }));
    expect(await sessionLogout()).toBe("already-invalid");
    expect(getAuthMode()).toBe("none");
    expect(getSessionAuth()).toBeNull();
  });

  it("in bearer mode clears locally without any network call", async () => {
    installFetch(() => {
      throw new Error("must not fetch");
    });
    setApiKey("lmsk.admin.123", false);
    expect(await sessionLogout()).toBe("logged-out");
    expect(fetchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Desktop Android-enrollment endpoints (wire shape)
// ---------------------------------------------------------------------------

describe("mobile enrollment api (desktop flow)", () => {
  async function installSession(): Promise<void> {
    installFetch(() => json(200, SESSION_ME));
    await probeSession();
  }

  it("createMobileEnrollment POSTs webAdmin + android and parses the response", async () => {
    await installSession();
    installFetch((call) => {
      expect(call.url).toBe("/api/v1/mobile/enrollments");
      expect(call.init.method ?? "GET").toBe("POST");
      expect(headersOf(call).get(CSRF_HEADER)).toBe("csrf-token-abc");
      const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
      expect(body.webAdmin).toBe(true);
      expect(body.clientType).toBe("android");
      return json(201, SESSION_CREATE);
    });

    const created = await api.createMobileEnrollment({ webAdmin: true, clientType: "android" });
    expect(created.enrollmentId).toBe("enr_9zXy7AbC");
    expect(created.secret).toBe("s3cR3t_MiXeDcAsE");
  });

  it("getMobileEnrollment reads status by id", async () => {
    setApiKey("lmsk.admin.123", false);
    installFetch((call) => {
      expect(call.url).toBe("/api/v1/mobile/enrollments/enr_9zXy7AbC");
      return json(200, {
        enrollmentId: "enr_9zXy7AbC",
        status: "used",
        expiresAt: 1_783_999_400_000,
        host: {
          hostId: "host-pixel-9",
          displayName: "Pixel 9",
          clientType: "android",
          appVersion: "1.2.0",
          createdAt: 1_783_999_300_000,
          lastSeenAt: null,
          revokedAt: null,
        },
      });
    });
    const status = await api.getMobileEnrollment("enr_9zXy7AbC");
    expect(status.status).toBe("used");
    expect(status.host?.hostId).toBe("host-pixel-9");
  });

  it("revokeMobileRegistration POSTs the revoke body with reason", async () => {
    setApiKey("lmsk.admin.123", false);
    installFetch((call) => {
      expect(call.url).toBe("/api/v1/mobile/registrations/host-pixel-9/revoke");
      expect(call.init.method ?? "GET").toBe("POST");
      const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
      expect(body.reason).toBe("Revoked from the desktop web UI");
      return json(200, { hostId: "host-pixel-9", revokedAt: 1_784_000_100_000 });
    });
    const result = await api.revokeMobileRegistration(
      "host-pixel-9",
      "Revoked from the desktop web UI",
    );
    expect(result.revokedAt).toBe(1_784_000_100_000);
  });

  it("listMobileRegistrations GETs the admin projection as a bare array", async () => {
    setApiKey("lmsk.admin.123", false);
    installFetch((call) => {
      // Persistent paired-device listing (finding 6): a plain admin GET of
      // the projection route, no CSRF (read), no body, no enrollment id.
      expect(call.url).toBe("/api/v1/mobile/registrations");
      expect(call.init.method ?? "GET").toBe("GET");
      expect(headersOf(call).get("authorization")).toBe("Bearer lmsk.admin.123");
      expect(headersOf(call).has(CSRF_HEADER)).toBe(false);
      return json(200, [
        {
          hostId: "host-pixel-9",
          displayName: "Pixel 9",
          clientType: "android",
          appVersion: "1.2.0",
          createdAt: 1_783_999_300_000,
          lastSeenAt: 1_784_000_000_000,
          revokedAt: null,
          revokedReason: null,
        },
        {
          hostId: "host-old-phone",
          displayName: "Old phone",
          clientType: "android",
          appVersion: "1.0.0",
          createdAt: 1_783_000_000_000,
          lastSeenAt: 1_783_500_000_000,
          revokedAt: 1_783_800_000_000,
          revokedReason: "Lost device",
        },
      ]);
    });

    const rows = await api.listMobileRegistrations();
    expect(rows).toHaveLength(2);
    // Most recent first as served; revoked rows included with reason.
    expect(rows[0]?.hostId).toBe("host-pixel-9");
    expect(rows[1]?.revokedAt).not.toBeNull();
    expect(rows[1]?.revokedReason).toBe("Lost device");
  });
});

// Small helper asserting storage state (kept at the bottom so the test list
// reads top-down).
function getApiKeyStored(): string | null {
  return (
    globalThis.sessionStorage.getItem("lamasync_api_key") ??
    globalThis.localStorage.getItem("lamasync_api_key_persist")
  );
}
