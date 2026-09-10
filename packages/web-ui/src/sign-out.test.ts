// LAMA-329 phase 5: one shared sign-out, now reachable from three surfaces.
//
// The review asked for session sign-out on the browser Settings page. Rather
// than paste the sequence a third time, it moved into `sign-out.ts`, and these
// tests pin the LAMA-296 ordering it exists to protect: the server invalidates
// the HttpOnly session BEFORE anything local is cleared, and a server that will
// not confirm the logout must leave the session usable rather than pretend it
// ended.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  clearApiKey,
  clearSessionAuth,
  getApiKey,
  getAuthMode,
  probeSession,
  setApiKey,
} from "./api.ts";
import { performSignOut } from "./sign-out.ts";

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

function installWindow(): void {
  const stub = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  globalThis.window = stub as unknown as Window & typeof globalThis;
}

type FetchCall = { url: string; init: RequestInit };
let fetchCalls: FetchCall[] = [];

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>): void {
  fetchCalls = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call = { url, init: init ?? {} };
    fetchCalls.push(call);
    return handler(call);
  };
  globalThis.fetch = stub as typeof fetch;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SESSION_ME = {
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

const LOGOUT = "/api/v1/mobile/web-session/logout";

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

describe("performSignOut", () => {
  it("clears a bearer key locally and makes no server call", async () => {
    setApiKey("bearer-key");
    installFetch(() => {
      throw new Error("bearer sign-out must not touch the network");
    });

    expect(await performSignOut()).toBe("signed-out");
    expect(getApiKey()).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });

  it("invalidates a session on the server before clearing local state", async () => {
    installFetch((call) => {
      if (call.url === "/api/v1/auth/me") return json(200, SESSION_ME);
      if (call.url === LOGOUT) return json(200, { ok: true });
      throw new Error(`unexpected request ${call.url}`);
    });

    await probeSession();
    expect(getAuthMode()).toBe("session");

    expect(await performSignOut()).toBe("signed-out");
    // Server first, then local: the logout really was called, and only then did
    // the in-memory identity go away.
    expect(fetchCalls.map((call) => call.url)).toContain(LOGOUT);
    expect(getAuthMode()).toBe("none");
  });

  it("keeps the session usable when the server will not confirm the logout", async () => {
    installFetch((call) => {
      if (call.url === "/api/v1/auth/me") return json(200, SESSION_ME);
      if (call.url === LOGOUT) return Promise.reject(new TypeError("Failed to fetch"));
      throw new Error(`unexpected request ${call.url}`);
    });

    await probeSession();
    const result = await performSignOut();

    // A local-only sign-out would sign straight back in on reload, so a failure
    // must be reported rather than faked.
    expect(result).toBe("failed");
    expect(getAuthMode()).toBe("session");
  });

  it("treats an already-invalid session as signed out", async () => {
    installFetch((call) => {
      if (call.url === "/api/v1/auth/me") return json(200, SESSION_ME);
      if (call.url === LOGOUT) return json(401, { error: "Unauthorized" });
      throw new Error(`unexpected request ${call.url}`);
    });

    await probeSession();
    expect(await performSignOut()).toBe("signed-out");
    expect(getAuthMode()).toBe("none");
  });
});
