// UX workstream 4: health route tests — the Admin page reads
// `serverVersion` / `dbSizeBytes` from GET /health.
//
// NOTE: `bun test` can share a process across test files, and other files
// mutate `LAMASYNC_DATA_DIR` in their beforeEach (e.g. stats.test.ts), so
// the db.ts singleton may point at a path that was cleaned up before this
// file runs. The assertions therefore read the server's own `dbFilePath()`
// and only require the size match when that file actually exists.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "health-test-key";
// Unconditional (not `?? `) so a shared-process env from another test file
// can't redirect the db.ts singleton to a path that file will delete.
process.env.LAMASYNC_DATA_DIR = mkdtempSync(join(tmpdir(), "lamasync-health-"));
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "health-test-secret-key-0123456789abcdef";

const { getAuthPlugin } = await import("../auth.ts");
const { __setCachedLatestVersionForTests } = (await import("../release-cache.ts")) as typeof import("../release-cache.ts");
const { healthRoutes } = await import("./health.ts");
const { dbFilePath, db } = (await import("../db.ts")) as typeof import("../db.ts") & {
  db: import("bun:sqlite").Database;
};

let app: { handle(request: Request): Response | Promise<Response> };

beforeEach(() => {
  __setCachedLatestVersionForTests("9.9.9");
  app = new Elysia().use(getAuthPlugin()).use(healthRoutes);
});

describe("GET /api/v1/health", () => {
  test("reports a non-empty server version", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/health", {
        headers: { Authorization: `Bearer ${process.env.LAMASYNC_API_KEY}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; serverVersion: string };
    expect(body.status).toBe("ok");
    expect(typeof body.serverVersion).toBe("string");
    expect(body.serverVersion.length).toBeGreaterThan(0);
  });

  test("dbSizeBytes matches the server's DB file when it exists", async () => {
    // The db.ts singleton may have fallen back to :memory: in a shared test
    // process (unwritable/removed path) — in that case dbFilePath() has no
    // file and the route correctly reports null. Only assert when the file
    // is actually on disk.
    let expected: number | null = null;
    try {
      expected = statSync(dbFilePath()).size;
    } catch {
      expected = null;
    }
    const res = await app.handle(
      new Request("http://localhost/api/v1/health", {
        headers: { Authorization: `Bearer ${process.env.LAMASYNC_API_KEY}` },
      }),
    );
    const body = (await res.json()) as { dbSizeBytes: number | null };
    if (expected === null) {
      expect(body.dbSizeBytes).toBeNull();
    } else {
      expect(body.dbSizeBytes).toBe(expected);
    }
  });
});

// LAMA-345 follow-up: the /health route now carries the shared fleet summary
// and the evidence-based update verdict, so the Dashboard, the Hosts page,
// HostDetail and the notifications all read the same facts.
describe("GET /api/v1/health — fleet summary + update evidence (LAMA-345)", () => {
  const HOST = "lama345-health-host";

  function seed(over: {
    version?: string | null;
    status?: string;
    lastSeen?: number | null;
    hostClass?: string;
  } = {}): void {
    db.run("DELETE FROM hosts WHERE id = ?", [HOST]);
    db.run(
      `INSERT INTO hosts (id, hostname, last_seen, status, version, host_class)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        HOST,
        HOST,
        over.lastSeen === undefined ? Date.now() : over.lastSeen,
        over.status ?? "online",
        over.version === undefined ? "0.3.7" : over.version,
        over.hostClass ?? "server",
      ],
    );
  }

  async function fetchHealth(): Promise<{
    hosts: Array<{ id: string; updateAvailable: boolean; updateStatus?: { kind: string; reason: string; label: string } }>;
    fleetHealth: {
      generatedAt: number;
      headline: string;
      buckets: Record<string, { total: number; items: Array<{ kind: string; title: string; href: string }> }>;
      healthy: { folders: number; hosts: number };
      updatesActionable: number;
      updatesNotEvaluated: number;
    };
  }> {
    const res = await app.handle(
      new Request("http://localhost/api/v1/health", {
        headers: { Authorization: `Bearer ${process.env.LAMASYNC_API_KEY}` },
      }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as never;
  }

  test("the response carries a fleet summary with all four buckets", async () => {
    const body = await fetchHealth();
    expect(typeof body.fleetHealth.generatedAt).toBe("number");
    expect(typeof body.fleetHealth.headline).toBe("string");
    for (const key of ["needsIntervention", "checkWhenOnline", "healthy", "unknownOrStale"]) {
      expect(body.fleetHealth.buckets[key]).toBeDefined();
      expect(typeof body.fleetHealth.buckets[key]!.total).toBe("number");
    }
  });

  test("an online host on an older build is flagged as an actionable update", async () => {
    const publishedAt = new Date(Date.now() - 3_600_000).toISOString();
    __setCachedLatestVersionForTests("0.3.11", publishedAt);
    seed({ version: "0.3.7", lastSeen: Date.now(), status: "online" });
    const body = await fetchHealth();
    const host = body.hosts.find((h) => h.id === HOST)!;
    expect(host.updateAvailable).toBe(true);
    expect(host.updateStatus?.kind).toBe("available");
  });

  test("a host offline since BEFORE the release is not told to update", async () => {
    const publishedAt = Date.now();
    __setCachedLatestVersionForTests("0.3.11", publishedAt);
    seed({ version: "0.3.7", lastSeen: publishedAt - 86_400_000, status: "offline" });
    const body = await fetchHealth();
    const host = body.hosts.find((h) => h.id === HOST)!;
    expect(host.updateAvailable).toBe(false);
    expect(host.updateStatus?.kind).toBe("not_evaluated");
    expect(host.updateStatus?.reason).toBe("checked_before_release");
    expect(host.updateStatus?.label).toContain("not been heard from since before");
    // …and the summary counts it as unevaluated rather than as a pending update.
    expect(
      body.fleetHealth.buckets.checkWhenOnline!.items.some((i) => i.kind === "update"),
    ).toBe(false);
  });

  test("checking in exactly at the publication instant is eligible", async () => {
    const publishedAt = Date.now();
    __setCachedLatestVersionForTests("0.3.11", publishedAt);
    seed({ version: "0.3.7", lastSeen: publishedAt, status: "online" });
    const { hosts } = await fetchHealth();
    expect(hosts.find((h) => h.id === HOST)!.updateAvailable).toBe(true);
  });

  test("a never-seen host is not evaluated in either direction", async () => {
    __setCachedLatestVersionForTests("0.3.11", Date.now() - 1_000);
    seed({ version: "0.3.7", lastSeen: null, status: "unknown" });
    const { hosts } = await fetchHealth();
    const host = hosts.find((h) => h.id === HOST)!;
    expect(host.updateAvailable).toBe(false);
    expect(host.updateStatus?.kind).toBe("not_evaluated");
    expect(host.updateStatus?.reason).toBe("never_seen");
  });

  test("an always-on host that is offline is red in the summary; a phone is not", async () => {
    __setCachedLatestVersionForTests("0.3.11", new Date(Date.now() - 60_000).toISOString());
    seed({ version: "0.3.11", lastSeen: Date.now() - 3_600_000, status: "offline", hostClass: "nas" });
    const alwaysOn = await fetchHealth();
    expect(
      alwaysOn.fleetHealth.buckets.needsIntervention!.items.some((i) => i.title === HOST),
    ).toBe(true);

    seed({ version: "0.3.11", lastSeen: Date.now() - 3_600_000, status: "offline", hostClass: "phone" });
    const sleepy = await fetchHealth();
    expect(
      sleepy.fleetHealth.buckets.needsIntervention!.items.some((i) => i.title === HOST),
    ).toBe(false);
    expect(
      sleepy.fleetHealth.buckets.checkWhenOnline!.items.some((i) => i.title === HOST),
    ).toBe(true);
  });

  test("every summary item links somewhere the operator can go", async () => {
    __setCachedLatestVersionForTests("0.3.11", Date.now() - 60_000);
    seed({ version: "0.3.7", lastSeen: Date.now(), status: "online" });
    const body = await fetchHealth();
    for (const bucket of Object.values(body.fleetHealth.buckets)) {
      for (const item of bucket.items) {
        expect(item.href.startsWith("/")).toBe(true);
      }
    }
  });
});
