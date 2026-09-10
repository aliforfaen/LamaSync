// LAMA-329 phase 7 review fix: the connectivity notifier must cover EVERY
// request path, not just the JSON helper.
//
// `apiFetch` published `lamasync:request-failed` / `lamasync:request-succeeded`,
// but three raw-fetch paths bypassed it: the binary download (`apiBlob`) and the
// two multipart uploads. A transport rejection there left the banner saying
// "Live updates paused" ("the data shown was fetched successfully") after an
// upload that never reached the server — the exact lie the connectivity module
// exists to prevent. These tests pin the invariant at the raw paths.
//
// Same DOM-free convention as api-auth.test.ts: minimal storage/window stubs and
// a scripted global fetch.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  api,
  apiFetch,
  clearApiKey,
  clearSessionAuth,
  fetchWithTransportSignal,
  REQUEST_FAILED_EVENT,
  REQUEST_SUCCEEDED_EVENT,
  setApiKey,
} from "./api.ts";

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
    dispatchEvent: (event: Event) => {
      dispatched.push(event);
      return true;
    },
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

/** A browser transport rejection: `fetch` itself rejects, no response exists. */
function transportRejection(): Promise<Response> {
  return Promise.reject(new TypeError("Failed to fetch"));
}

function eventTypes(): string[] {
  return dispatched.map((event) => event.type);
}

beforeEach(() => {
  globalThis.sessionStorage = memoryStorage();
  globalThis.localStorage = memoryStorage();
  installWindow();
  clearApiKey();
  clearSessionAuth();
  setApiKey("test-bearer-key");
});

afterEach(() => {
  clearApiKey();
  clearSessionAuth();
  globalThis.fetch = originalFetch;
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  delete (globalThis as { localStorage?: unknown }).localStorage;
  delete (globalThis as { window?: unknown }).window;
});

describe("fetchWithTransportSignal", () => {
  it("publishes success for any response, failure only for a rejection", async () => {
    installFetch(() => new Response("nope", { status: 500 }));
    const failed = await fetchWithTransportSignal("/api/v1/anything");
    expect(failed.status).toBe(500);
    expect(eventTypes()).toEqual([REQUEST_SUCCEEDED_EVENT]);

    installFetch(() => transportRejection());
    await expect(fetchWithTransportSignal("/api/v1/anything")).rejects.toThrow("Failed to fetch");
    expect(eventTypes().at(-1)).toBe(REQUEST_FAILED_EVENT);
    expect(eventTypes().filter((type) => type === REQUEST_FAILED_EVENT).length).toBe(1);
  });
});

describe("raw-fetch paths publish transport outcomes (review regression)", () => {
  it("apiBlob — a rejected snapshot download reports the failure", async () => {
    installFetch(() => transportRejection());
    await expect(api.downloadAppSnapshot("snap-1")).rejects.toThrow("Failed to fetch");
    // The endpoint really is the blob route, so this is not a stray apiFetch.
    expect(fetchCalls[0]?.url).toBe("/api/v1/apps/snapshots/snap-1/download");
    expect(eventTypes()).toContain(REQUEST_FAILED_EVENT);
  });

  it("apiBlob — a server error is a success signal, not a transport failure", async () => {
    // 404 means the server answered; the banner must not claim unreachability.
    installFetch(() => new Response("missing", { status: 404 }));
    await expect(api.downloadAppSnapshot("snap-404")).rejects.toThrow();
    expect(eventTypes()).toContain(REQUEST_SUCCEEDED_EVENT);
    expect(eventTypes()).not.toContain(REQUEST_FAILED_EVENT);
  });

  it("uploadAppSnapshot — a rejected multipart upload reports the failure", async () => {
    installFetch(() => transportRejection());
    await expect(api.uploadAppSnapshot("prot-1", new Blob(["x"]))).rejects.toThrow(
      "Failed to fetch",
    );
    expect(fetchCalls[0]?.url).toBe("/api/v1/apps/protections/prot-1/snapshots");
    expect(fetchCalls[0]?.init.method).toBe("POST");
    expect(eventTypes()).toContain(REQUEST_FAILED_EVENT);
  });

  it("uploadFolderFile — a rejected multipart upload reports the failure", async () => {
    installFetch(() => transportRejection());
    await expect(api.uploadFolderFile("folder-1", new Blob(["x"]))).rejects.toThrow(
      "Failed to fetch",
    );
    expect(fetchCalls[0]?.url).toBe("/api/v1/folders/folder-1/files");
    expect(fetchCalls[0]?.init.method).toBe("POST");
    expect(eventTypes()).toContain(REQUEST_FAILED_EVENT);
  });

  it("a multipart upload the server rejected clears the failure state", async () => {
    installFetch(() => new Response(JSON.stringify({ error: "too large" }), {
      status: 413,
      headers: { "content-type": "application/json" },
    }));
    await expect(api.uploadFolderFile("folder-1", new Blob(["x"]))).rejects.toThrow("too large");
    expect(eventTypes()).toContain(REQUEST_SUCCEEDED_EVENT);
    expect(eventTypes()).not.toContain(REQUEST_FAILED_EVENT);
  });

  it("keeps apiFetch's own behaviour unchanged", async () => {
    installFetch(() => transportRejection());
    await expect(apiFetch("/health")).rejects.toThrow("Failed to fetch");
    expect(eventTypes()).toContain(REQUEST_FAILED_EVENT);
  });
});
