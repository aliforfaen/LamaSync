import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LamaSyncApiClient } from "@lamasync/core";
import { acquireLock, acquireLockWithRetry, buildDeferredReport, heartbeatLock, __clearActiveLocks } from "./lock.ts";

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
        destinationKey: `folder:${FOLDER_ID}`,
        lockId: "lock-1",
        ttl: 1200,
        acquiredAt: expect.any(Number),
      },
      destinationKey: `folder:${FOLDER_ID}`,
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
      destinationKey: `folder:${FOLDER_ID}`,
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
      destinationKey: `folder:${FOLDER_ID}`,
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
      destinationKey: `folder:${FOLDER_ID}`,
    });
  });
});

describe("acquireLockWithRetry (LAMA-294)", () => {
  beforeEach(() => {
    __clearActiveLocks();
  });
  afterEach(() => {
    __clearActiveLocks();
  });

  test("succeeds immediately when the destination is free", async () => {
    const client = makeClient([
      Response.json({ lockId: "lock-1", ttl: 1200, acquired: true }),
    ]);
    const outcome = await acquireLockWithRetry(client, FOLDER_ID, HOST_ID, "dest:free");
    expect(outcome).toMatchObject({
      ok: true,
      attempts: 1,
      destinationKey: "dest:free",
    });
  });

  test("retries a contended destination and succeeds after it clears", async () => {
    const client = makeClient([
      Response.json({ error: "folder_locked", lockedBy: "host-b", remainingSec: 5 }, { status: 409 }),
      Response.json({ lockId: "lock-2", ttl: 1200, acquired: true }),
    ]);
    const outcome = await acquireLockWithRetry(
      client,
      FOLDER_ID,
      HOST_ID,
      "dest:shared",
      { baseDelayMs: 0, maxDelayMs: 0 },
    );
    expect(outcome).toMatchObject({
      ok: true,
      attempts: 2,
      destinationKey: "dest:shared",
    });
    expect(outcome.handle?.lockId).toBe("lock-2");
  });

  test("gives up after bounded attempts and reports the contention as first-class deferred", async () => {
    // Factory so every retry gets a fresh body (a single Response is
    // consumed after the first .text(), which would otherwise classify as
    // unreachable).
    const client = makeClient([
      () => Response.json({ error: "folder_locked", lockedBy: "host-b", remainingSec: 120 }, { status: 409 }),
    ]);
    const outcome = await acquireLockWithRetry(
      client,
      FOLDER_ID,
      HOST_ID,
      "dest:shared",
      { baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 3 },
    );
    expect(outcome).toMatchObject({
      ok: false,
      reason: "contended",
      lockedBy: "host-b",
      attempts: 3,
      destinationKey: "dest:shared",
    });
  });

  test("retries a server outage and defers without starting a transfer", async () => {
    const client = new LamaSyncApiClient("http://localhost:8080", "test-key", {
      fetchImpl: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
      timeoutMs: 5_000,
      maxRetries: 0,
    });
    const outcome = await acquireLockWithRetry(
      client,
      FOLDER_ID,
      HOST_ID,
      "dest:foo",
      { baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 3 },
    );
    expect(outcome).toMatchObject({
      ok: false,
      reason: "unreachable",
      attempts: 3,
      destinationKey: "dest:foo",
    });
  });
});

describe("buildDeferredReport (LAMA-294)", () => {
  test("contention maps to a first-class 'deferred' report, not failed", () => {
    const report = buildDeferredReport(
      { ok: false, reason: "contended", lockedBy: "host-b", remainingSec: 45, attempts: 3, destinationKey: "dest:shared" },
      "host-a",
      "f1",
      "backup",
      1_700_000_000_000,
    );
    expect(report.status).toBe("deferred");
    expect(report.summary).toContain("destination locked by host-b");
    expect(report.summary).toContain("3 attempt(s)");
    expect(JSON.parse(report.details!)).toMatchObject({
      destinationKey: "dest:shared",
      reason: "contended",
      lockedBy: "host-b",
      attempts: 3,
    });
  });

  test("server outage maps to a deferred report with the canonical key", () => {
    const report = buildDeferredReport(
      { ok: false, reason: "unreachable", attempts: 5, destinationKey: "s3:be1/folder1/host-a" },
      "host-a",
      "f1",
      "backup",
      1_700_000_000_000,
    );
    expect(report.status).toBe("deferred");
    expect(report.summary).toContain("server unreachable");
    expect(JSON.parse(report.details!)).toMatchObject({
      destinationKey: "s3:be1/folder1/host-a",
      reason: "unreachable",
      attempts: 5,
    });
  });

  test("the owning host is described as 'this host' for internal contention", () => {
    const report = buildDeferredReport(
      { ok: false, reason: "contended", lockedBy: "host-a", remainingSec: 0, attempts: 2, destinationKey: "dest:x" },
      "host-a",
      "f1",
      "sync",
      1,
    );
    expect(report.summary).toContain("locked by this host");
  });
});

describe("heartbeatLock", () => {
  test("200 ok returns ok", async () => {
    const client = makeClient([Response.json({ ok: true, renewedAt: Date.now() })]);
    const result = await heartbeatLock(client, FOLDER_ID, HOST_ID, {
      folderId: FOLDER_ID,
      destinationKey: `folder:${FOLDER_ID}`,
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
