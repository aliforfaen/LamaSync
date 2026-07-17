import { describe, expect, test } from "bun:test";
import { LamaSyncApiClient, LamaSyncApiError } from "./api-client.ts";

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
