import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LamaSyncApiClient } from "@lamasync/core";
import { acquireLock, heartbeatLock, __clearActiveLocks } from "./lock.ts";

const HOST_ID = "host-a";
const FOLDER_ID = "folder-1";

function makeClient(responses: Array<Response | (() => Response)>): LamaSyncApiClient {
  let index = 0;
  return new LamaSyncApiClient("http://localhost:8080", "test-key", {
    fetchImpl: (() => {
      const r = responses[index] ?? responses[responses.length - 1];
      index += 1;
      return Promise.resolve(typeof r === "function" ? r() : r);
    }) as unknown as typeof fetch,
    timeoutMs: 5_000,
    maxRetries: 0,
  });
}

describe("acquireLock", () => {
  beforeEach(() => {
    __clearActiveLocks();
  });
  afterEach(() => {
    __clearActiveLocks();
  });

  test("returns handle on successful acquisition", async () => {
    const client = makeClient([
      Response.json({ lockId: "lock-1", ttl: 1200, acquired: true }),
    ]);
    const result = await acquireLock(client, FOLDER_ID, HOST_ID);
    expect(result).toEqual({
      ok: true,
      handle: {
        folderId: FOLDER_ID,
        lockId: "lock-1",
        ttl: 1200,
        acquiredAt: expect.any(Number),
      },
    });
  });

  test("same-host overlap guard returns contended", async () => {
    const client = makeClient([
      Response.json({ lockId: "lock-1", ttl: 1200, acquired: true }),
      Response.json({ lockId: "lock-2", ttl: 1200, acquired: true }),
    ]);
    const first = await acquireLock(client, FOLDER_ID, HOST_ID);
    expect(first.ok).toBe(true);

    const second = await acquireLock(client, FOLDER_ID, HOST_ID);
    expect(second).toMatchObject({
      ok: false,
      reason: "contended",
      lockedBy: HOST_ID,
    });
  });

  test("409 folder_locked returns contended with details", async () => {
    const client = makeClient([
      Response.json(
        { error: "folder_locked", lockedBy: "host-b", remainingSec: 45 },
        { status: 409 },
      ),
    ]);
    const result = await acquireLock(client, FOLDER_ID, HOST_ID);
    expect(result).toEqual({
      ok: false,
      reason: "contended",
      lockedBy: "host-b",
      remainingSec: 45,
    });
  });

  test("network error returns unreachable", async () => {
    const client = new LamaSyncApiClient("http://localhost:8080", "test-key", {
      fetchImpl: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
      timeoutMs: 5_000,
      maxRetries: 0,
    });
    const result = await acquireLock(client, FOLDER_ID, HOST_ID);
    expect(result).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});

describe("heartbeatLock", () => {
  test("200 ok returns ok", async () => {
    const client = makeClient([Response.json({ ok: true, renewedAt: Date.now() })]);
    const result = await heartbeatLock(client, FOLDER_ID, HOST_ID, {
      folderId: FOLDER_ID,
      lockId: "lock-1",
      ttl: 1200,
      acquiredAt: Date.now(),
    });
    expect(result).toBe("ok");
  });

  test("404 no_active_lock returns lost", async () => {
    const client = makeClient([Response.json({ error: "no_active_lock" }, { status: 404 })]);
    const result = await heartbeatLock(client, FOLDER_ID, HOST_ID);
    expect(result).toBe("lost");
  });

  test("409 lock_held_by_other returns lost", async () => {
    const client = makeClient([
      Response.json({ error: "lock_held_by_other", lockedBy: "host-b" }, { status: 409 }),
    ]);
    const result = await heartbeatLock(client, FOLDER_ID, HOST_ID);
    expect(result).toBe("lost");
  });

  test("network error returns unknown", async () => {
    const client = new LamaSyncApiClient("http://localhost:8080", "test-key", {
      fetchImpl: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
      timeoutMs: 5_000,
      maxRetries: 0,
    });
    const result = await heartbeatLock(client, FOLDER_ID, HOST_ID);
    expect(result).toBe("unknown");
  });
});
