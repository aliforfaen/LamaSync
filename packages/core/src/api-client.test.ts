import { describe, expect, test } from "bun:test";
import { LamaSyncApiClient, LamaSyncApiError } from "./api-client.ts";
import type { ApiKeySummary } from "./types.ts";

const API_KEY = "test-key";

type FetchState = {
  calls: Array<{ url: string; init?: RequestInit }>;
};

function makeFetch(responses: Array<() => Response | Promise<Response>>, state: FetchState): typeof fetch {
  let index = 0;
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    state.calls.push({ url: String(input), init });
    const response = responses[index] ?? responses[responses.length - 1];
    index++;
    return Promise.resolve(response());
  }) as typeof fetch;
}

describe("LamaSyncApiClient request resilience", () => {
  test("retries idempotent GETs on TypeError network failures", async () => {
    const state: FetchState = { calls: [] };
    const client = new LamaSyncApiClient("http://localhost:8080", API_KEY, {
      fetchImpl: makeFetch(
        [
          () => {
            throw new TypeError("fetch failed");
          },
          () => Response.json({ ok: true }),
        ],
        state,
      ),
      timeoutMs: 5_000,
      maxRetries: 2,
    });

    const result = (await client.getHealth()) as unknown as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(state.calls).toHaveLength(2);
  });

  test("retries idempotent GETs on 5xx responses", async () => {
    const state: FetchState = { calls: [] };
    const client = new LamaSyncApiClient("http://localhost:8080", API_KEY, {
      fetchImpl: makeFetch(
        [
          () => Response.json({ error: "overloaded" }, { status: 503 }),
          () => Response.json({ ok: true }),
        ],
        state,
      ),
      timeoutMs: 5_000,
      maxRetries: 2,
    });

    const result = (await client.getHealth()) as unknown as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(state.calls).toHaveLength(2);
  });

  test("does not retry 4xx GET responses", async () => {
    const state: FetchState = { calls: [] };
    const client = new LamaSyncApiClient("http://localhost:8080", API_KEY, {
      fetchImpl: makeFetch([() => Response.json({ error: "not_found" }, { status: 404 })], state),
      timeoutMs: 5_000,
      maxRetries: 2,
    });

    await expect(client.getHealth()).rejects.toThrow(LamaSyncApiError);
    expect(state.calls).toHaveLength(1);
  });

  test("does not retry non-idempotent POST failures", async () => {
    const state: FetchState = { calls: [] };
    const client = new LamaSyncApiClient("http://localhost:8080", API_KEY, {
      fetchImpl: makeFetch(
        [
          () => Response.json({ error: "conflict" }, { status: 409 }),
        ],
        state,
      ),
      timeoutMs: 5_000,
      maxRetries: 2,
    });

    await expect(
      client.reportOperation({
        hostId: "host-a",
        folderId: "f1",
        operation: "sync",
        status: "success",
      }),
    ).rejects.toThrow(LamaSyncApiError);
    expect(state.calls).toHaveLength(1);
  });

  test("applies timeout signal to fetch calls", async () => {
    const state: FetchState = { calls: [] };
    const client = new LamaSyncApiClient("http://localhost:8080", API_KEY, {
      fetchImpl: ((input, init) => {
        state.calls.push({ url: String(input), init });
        const signal = init?.signal;
        if (!signal) {
          return Promise.reject(new TypeError("expected signal"));
        }
        return new Promise((_, reject) => {
          const handler = () => reject(new DOMException("Timeout", "TimeoutError"));
          if (signal.aborted) {
            handler();
            return;
          }
          signal.addEventListener("abort", handler, { once: true });
        });
      }) as typeof fetch,
      timeoutMs: 1,
      maxRetries: 0,
    });

    await expect(client.getHealth()).rejects.toMatchObject({
      name: "TimeoutError",
      message: "Timeout",
    });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("parses JSON error body code", async () => {
    const client = new LamaSyncApiClient("http://localhost:8080", API_KEY, {
      fetchImpl: makeFetch([() => Response.json({ error: "bad_request" }, { status: 422 })], { calls: [] }),
      timeoutMs: 5_000,
      maxRetries: 0,
    });

    await expect(client.getHealth()).rejects.toMatchObject({
      status: 422,
      code: "bad_request",
    });
  });
});

describe("LamaSyncApiClient LAMA-234 API-key + identity methods", () => {
  test("getAuthMe GETs /api/v1/auth/me with the bearer key and parses identity", async () => {
    const state: FetchState = { calls: [] };
    const client = new LamaSyncApiClient("http://localhost:8080", API_KEY, {
      fetchImpl: makeFetch(
        [
          () =>
            Response.json(
              { kind: "device", keyId: "key_1", name: "cachy", hostId: "host-a" },
              { status: 200 },
            ),
        ],
        state,
      ),
      timeoutMs: 5_000,
      maxRetries: 0,
    });

    const me = await client.getAuthMe();
    expect(me).toEqual({
      kind: "device",
      keyId: "key_1",
      name: "cachy",
      hostId: "host-a",
    });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.url).toBe("http://localhost:8080/api/v1/auth/me");
    expect(state.calls[0]?.init?.method).toBe("GET");
    expect(state.calls[0]?.init?.headers).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
    });
  });

  test("listApiKeys GETs /api/v1/api-keys and returns masked summaries only", async () => {
    const state: FetchState = { calls: [] };
    const rows: ApiKeySummary[] = [
      {
        id: "key_1",
        name: "Admin laptop",
        kind: "admin",
        hostId: null,
        createdAt: 1000,
        lastUsedAt: 2000,
        revealedAt: null,
        revokedAt: null,
        revokedReason: null,
        fingerprint: "a3f2b9c01d",
      },
    ];
    const client = new LamaSyncApiClient("http://localhost:8080", API_KEY, {
      fetchImpl: makeFetch([() => Response.json(rows, { status: 200 })], state),
      timeoutMs: 5_000,
      maxRetries: 0,
    });

    const keys = await client.listApiKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toEqual(rows[0]);
    expect(JSON.stringify(keys)).not.toContain("secret");
    expect(state.calls[0]?.url).toBe("http://localhost:8080/api/v1/api-keys");
  });

  test("createApiKey POSTs the label and returns the once-only secret", async () => {
    const state: FetchState = { calls: [] };
    const created = {
      key: {
        id: "key_2",
        name: "Ops key",
        kind: "admin" as const,
        hostId: null,
        createdAt: 3000,
        lastUsedAt: null,
        revealedAt: null,
        revokedAt: null,
        revokedReason: null,
        fingerprint: "ff0011aa22",
      },
      secret: "lamasync-admin-0123456789abcdef",
    };
    const client = new LamaSyncApiClient("http://localhost:8080", API_KEY, {
      fetchImpl: makeFetch([() => Response.json(created, { status: 200 })], state),
      timeoutMs: 5_000,
      maxRetries: 0,
    });

    const res = await client.createApiKey({ name: "Ops key" });
    expect(res).toEqual(created);
    expect(state.calls[0]?.url).toBe("http://localhost:8080/api/v1/api-keys");
    expect(state.calls[0]?.init?.method).toBe("POST");
    expect(state.calls[0]?.init?.body).toBe(JSON.stringify({ name: "Ops key" }));
  });

  test("revealApiKey POSTs the reveal route and encodes the id", async () => {
    const state: FetchState = { calls: [] };
    const client = new LamaSyncApiClient("http://localhost:8080", API_KEY, {
      fetchImpl: makeFetch(
        [
          () =>
            Response.json(
              { id: "key/with/slash", secret: "raw-secret", revealedAt: 4000 },
              { status: 200 },
            ),
        ],
        state,
      ),
      timeoutMs: 5_000,
      maxRetries: 0,
    });

    const res = await client.revealApiKey("key/with/slash");
    expect(res.secret).toBe("raw-secret");
    expect(state.calls[0]?.url).toBe(
      "http://localhost:8080/api/v1/api-keys/key%2Fwith%2Fslash/reveal",
    );
    expect(state.calls[0]?.init?.method).toBe("POST");
  });

  test("revokeApiKey POSTs the revoke route with an optional reason", async () => {
    const state: FetchState = { calls: [] };
    const client = new LamaSyncApiClient("http://localhost:8080", API_KEY, {
      fetchImpl: makeFetch(
        [
          () =>
            Response.json(
              { id: "key_1", revokedAt: 5000 },
              { status: 200 },
            ),
        ],
        state,
      ),
      timeoutMs: 5_000,
      maxRetries: 0,
    });

    const res = await client.revokeApiKey("key_1", { reason: "replaced laptop" });
    expect(res.revokedAt).toBe(5000);
    expect(state.calls[0]?.url).toBe("http://localhost:8080/api/v1/api-keys/key_1/revoke");
    expect(state.calls[0]?.init?.method).toBe("POST");
    expect(state.calls[0]?.init?.body).toBe(JSON.stringify({ reason: "replaced laptop" }));
  });

  test("revokeApiKey without a reason still sends a JSON body", async () => {
    const state: FetchState = { calls: [] };
    const client = new LamaSyncApiClient("http://localhost:8080", API_KEY, {
      fetchImpl: makeFetch(
        [() => Response.json({ id: "key_1", revokedAt: 5000 }, { status: 200 })],
        state,
      ),
      timeoutMs: 5_000,
      maxRetries: 0,
    });

    await client.revokeApiKey("key_1");
    expect(state.calls[0]?.init?.body).toBe("{}");
  });
});
