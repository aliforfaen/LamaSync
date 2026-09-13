// LAMA-327 — live sync progress surface tests.
//
// Covers: device-key host scoping on the report route, admin-only hydration
// read, unauthenticated + malformed updates, WS broadcast semantics
// (phase-transition immediate, terminal removes the entry), registry TTL
// expiry, and the bounded-entry cap.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
import type { LiveSyncProgress, WSEvent } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "sync-progress-master-key-123";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "sync-progress-secret-key-123";

const { getAuthPlugin } = await import("../auth.ts");
const { insertManagedApiKey, __setApiKeysDb, __resetApiKeysDb } = await import("../api-keys.ts");
const { syncProgressRoutes } = await import("./sync-progress.ts");
const {
  upsertLiveProgress,
  listActiveLiveProgress,
  liveProgressSize,
  __resetLiveProgressForTests,
  __setNowSource,
  SYNC_PROGRESS_TTL_MS,
  SYNC_PROGRESS_MAX_ENTRIES,
  SYNC_PROGRESS_THROTTLE_MS,
} = await import("../live-progress.ts");
const { subscribe, __resetWsForTests } = await import("../ws.ts");

let db: Database;
let app: { handle(request: Request): Promise<Response> };
let masterToken: string;
let adminToken: string;
let deviceAToken: string; // bound to host-a
let deviceBToken: string; // bound to host-b

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // migrations are idempotent
    }
  }
  db.exec(`
    INSERT INTO hosts (id, hostname) VALUES ('host-a', 'host-a');
    INSERT INTO hosts (id, hostname) VALUES ('host-b', 'host-b');
  `);
  masterToken = process.env.LAMASYNC_API_KEY!;
  __setApiKeysDb(db);
  adminToken = insertManagedApiKey({ name: "admin", kind: "admin", hostId: null }).token;
  deviceAToken = insertManagedApiKey({ name: "dev-a", kind: "device", hostId: "host-a" }).token;
  deviceBToken = insertManagedApiKey({ name: "dev-b", kind: "device", hostId: "host-b" }).token;
  __resetLiveProgressForTests();
  __resetWsForTests();
  app = new Elysia().use(getAuthPlugin()).use(syncProgressRoutes);
});

afterEach(() => {
  __resetApiKeysDb();
  db.close();
});

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function postReport(
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.handle(
    request("/api/v1/sync-progress", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

function baseUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "run-1",
    hostId: "host-a",
    hostname: "cachy",
    folderId: "f1",
    folderName: "Projects",
    operation: "sync",
    phase: "enumerating",
    startedAt: 1_000,
    phaseStartedAt: 1_000,
    detail: "building listings for both paths",
    ...overrides,
  };
}

describe("POST /api/v1/sync-progress (device-scoped report)", () => {
  test("a device key may report its OWN host (204) and the run becomes readable", async () => {
    const res = await postReport(deviceAToken, baseUpdate());
    expect(res.status).toBe(204);

    const hydrate = await app.handle(
      request("/api/v1/sync-progress", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(hydrate.status).toBe(200);
    const list = (await hydrate.json()) as { runs: LiveSyncProgress[] };
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]?.runId).toBe("run-1");
    expect(list.runs[0]?.hostId).toBe("host-a");
    expect(list.runs[0]?.elapsedMs).toBeGreaterThan(0);
  });

  test("a device key CANNOT report another host's run (403)", async () => {
    const res = await postReport(deviceAToken, baseUpdate({ hostId: "host-b" }));
    expect(res.status).toBe(403);
    expect(liveProgressSize()).toBe(0);
  });

  test("master and admin keys may report any host", async () => {
    expect((await postReport(masterToken, baseUpdate({ hostId: "host-b" }))).status).toBe(204);
    expect((await postReport(adminToken, baseUpdate({ runId: "run-2" }))).status).toBe(204);
    expect(liveProgressSize()).toBe(2);
  });

  test("unauthenticated updates are rejected (401)", async () => {
    const res = await app.handle(
      request("/api/v1/sync-progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baseUpdate()),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("malformed updates are rejected with 422 and do not pollute the registry", async () => {
    const badPhase = await postReport(deviceAToken, baseUpdate({ phase: "invented_phase" }));
    expect(badPhase.status).toBe(422);
    const missingRunId = await postReport(deviceAToken, baseUpdate({ runId: "" }));
    expect(missingRunId.status).toBe(422);
    const badTime = await postReport(deviceAToken, baseUpdate({ startedAt: "now" }));
    expect(badTime.status).toBe(422);
    expect(liveProgressSize()).toBe(0);
  });
});

describe("GET /api/v1/sync-progress (admin hydration read)", () => {
  test("admin/master may read; device and anonymous are denied", async () => {
    await postReport(deviceAToken, baseUpdate());
    expect(
      (await app.handle(request("/api/v1/sync-progress", { headers: { Authorization: `Bearer ${masterToken}` } }))).status,
    ).toBe(200);
    expect(
      (await app.handle(request("/api/v1/sync-progress", { headers: { Authorization: `Bearer ${adminToken}` } }))).status,
    ).toBe(200);
    expect(
      (await app.handle(request("/api/v1/sync-progress", { headers: { Authorization: `Bearer ${deviceAToken}` } }))).status,
    ).toBe(403);
    expect((await app.handle(request("/api/v1/sync-progress"))).status).toBe(401);
  });
});

describe("WS broadcast semantics (registry level)", () => {
  test("a new run broadcasts a sync_progress event immediately", () => {
    const seen: WSEvent[] = [];
    subscribe((e) => seen.push(e));
    upsertLiveProgress(baseUpdate(), 10_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("sync_progress");
    expect(seen[0]?.kind === "sync_progress" && seen[0].progress.phase).toBe("enumerating");
  });

  test("a phase transition broadcasts immediately", () => {
    const seen: WSEvent[] = [];
    subscribe((e) => seen.push(e));
    upsertLiveProgress(baseUpdate(), 10_000);
    upsertLiveProgress(baseUpdate({ phase: "transferring", transfers: 3 }), 10_001);
    const kinds = seen.filter((e) => e.kind === "sync_progress");
    expect(kinds).toHaveLength(2);
  });

  test("counter-only updates are throttled to the throttle window", () => {
    const seen: WSEvent[] = [];
    subscribe((e) => seen.push(e));
    upsertLiveProgress(baseUpdate(), 10_000);
    // Same phase, counters changed — inside the throttle window: no broadcast.
    upsertLiveProgress(baseUpdate({ transfers: 5, bytes: 500 }), 10_001);
    expect(seen).toHaveLength(1);
    // Past the window: broadcast.
    upsertLiveProgress(baseUpdate({ transfers: 6, bytes: 600 }), 10_000 + SYNC_PROGRESS_THROTTLE_MS);
    expect(seen).toHaveLength(2);
    const last = seen[1];
    expect(last?.kind === "sync_progress" && last.progress.transfers).toBe(6);
  });

  test("a terminal phase broadcasts once and REMOVES the entry", () => {
    const seen: WSEvent[] = [];
    subscribe((e) => seen.push(e));
    upsertLiveProgress(baseUpdate(), 10_000);
    upsertLiveProgress(baseUpdate({ phase: "success" }), 10_001);
    expect(liveProgressSize()).toBe(0);
    const terminals = seen.filter(
      (e) => e.kind === "sync_progress" && (e.progress.phase === "success" || e.progress.phase === "failed"),
    );
    expect(terminals).toHaveLength(1);
  });

  test("terminal then re-report for the same runId is a fresh run", () => {
    upsertLiveProgress(baseUpdate(), 10_000);
    upsertLiveProgress(baseUpdate({ phase: "failed" }), 10_001);
    expect(liveProgressSize()).toBe(0);
    upsertLiveProgress(baseUpdate(), 20_000);
    expect(liveProgressSize()).toBe(1);
  });
});

describe("registry bounds (LAMA-327)", () => {
  test("stale entries expire after the TTL", () => {
    __setNowSource(() => 10_000);
    upsertLiveProgress(baseUpdate(), 10_000);
    // An update at TTL-later sweeps the stale entry out.
    const at = 10_000 + SYNC_PROGRESS_TTL_MS + 1;
    listActiveLiveProgress(at);
    expect(liveProgressSize()).toBe(0);
    __setNowSource(() => null);
  });

  test("the entry cap evicts the oldest-started run", () => {
    for (let i = 0; i < SYNC_PROGRESS_MAX_ENTRIES + 10; i += 1) {
      upsertLiveProgress(baseUpdate({ runId: `run-${i}`, startedAt: i }), 10_000 + i);
    }
    expect(liveProgressSize()).toBe(SYNC_PROGRESS_MAX_ENTRIES);
    const oldest = listActiveLiveProgress(50_000);
    // The ten oldest (run-0..run-9) were evicted; run-10 is the oldest left.
    expect(oldest.some((r) => r.runId === "run-0")).toBe(false);
    expect(oldest.some((r) => r.runId === "run-10")).toBe(true);
  });

  test("hydration sorts newest-started first", () => {
    upsertLiveProgress(baseUpdate({ runId: "old", startedAt: 100 }), 500);
    upsertLiveProgress(baseUpdate({ runId: "new", startedAt: 400 }), 500);
    const runs = listActiveLiveProgress(600);
    expect(runs.map((r) => r.runId)).toEqual(["new", "old"]);
  });
});