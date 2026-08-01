import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "hosts-test-key";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-hosts-test-data";

const { getAuthPlugin } = await import("../auth.ts");
const { __setCachedLatestVersionForTests } = (await import("../release-cache.ts")) as typeof import("../release-cache.ts");
const { __setDb, hostsRoutes } = (await import("./hosts.ts")) as typeof import("./hosts.ts");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // Migrations are intentionally idempotent for pre-existing schemas.
    }
  }
  db.run(`INSERT INTO hosts (id, hostname) VALUES ('host-a', 'host-a')`);
  // Pin the release cache to a synthetic version so heartbeat tests never
  // hit the real GitHub API. 9.9.9 is newer than any daemon version these
  // tests use, so updateAvailable derivation stays deterministic.
  __setCachedLatestVersionForTests("9.9.9");
  __setDb(db);
  app = new Elysia().use(getAuthPlugin()).use(hostsRoutes);
});

afterEach(() => {
  db.close();
});

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${process.env.LAMASYNC_API_KEY}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(request(path, { method: "POST", body: JSON.stringify(body) }));
}

function loadHostRow(hostId: string): {
  version: string | null;
  lan_ip: string | null;
  last_seen: number | null;
  status: string | null;
} {
  const row = db
    .query<
      { version: string | null; lan_ip: string | null; last_seen: number | null; status: string | null },
      [string]
    >("SELECT version, lan_ip, last_seen, status FROM hosts WHERE id = ?")
    .get(hostId);
  if (!row) throw new Error(`host ${hostId} not found`);
  return row;
}

describe("POST /api/v1/report/health — version field (LAMA-199)", () => {
  test("heartbeat with version stores it on the host row", async () => {
    const res = await post("/api/v1/report/health", {
      hostId: "host-a",
      timestamp: Date.now(),
      status: "online",
      version: "0.4.2",
    });
    expect(res.status).toBe(204);
    const row = loadHostRow("host-a");
    expect(row.version).toBe("0.4.2");
  });

  test("heartbeat without version preserves the stored value", async () => {
    // Seed an existing version.
    db.run(`UPDATE hosts SET version = '0.3.0' WHERE id = 'host-a'`);

    // Heartbeat that omits `version` entirely.
    const res = await post("/api/v1/report/health", {
      hostId: "host-a",
      timestamp: Date.now(),
      status: "online",
    });
    expect(res.status).toBe(204);
    const row = loadHostRow("host-a");
    expect(row.version).toBe("0.3.0");
  });

  test("heartbeat with null version preserves the stored value", async () => {
    db.run(`UPDATE hosts SET version = '0.3.0' WHERE id = 'host-a'`);

    // Explicit `null` also doesn't downgrade.
    const res = await post("/api/v1/report/health", {
      hostId: "host-a",
      timestamp: Date.now(),
      status: "online",
      version: null,
    });
    expect(res.status).toBe(204);
    const row = loadHostRow("host-a");
    expect(row.version).toBe("0.3.0");
  });

  test("heartbeat with empty-string version is ignored", async () => {
    db.run(`UPDATE hosts SET version = '0.3.0' WHERE id = 'host-a'`);

    const res = await post("/api/v1/report/health", {
      hostId: "host-a",
      timestamp: Date.now(),
      status: "online",
      version: "",
    });
    expect(res.status).toBe(204);
    const row = loadHostRow("host-a");
    expect(row.version).toBe("0.3.0");
  });

  test("heartbeat still updates last_seen and status alongside version", async () => {
    const res = await post("/api/v1/report/health", {
      hostId: "host-a",
      timestamp: 1_700_000_000_000,
      status: "degraded",
      lanIp: "192.168.1.42",
      version: "0.5.0",
    });
    expect(res.status).toBe(204);
    const row = loadHostRow("host-a");
    expect(row.last_seen).toBe(1_700_000_000_000);
    expect(row.status).toBe("degraded");
    expect(row.lan_ip).toBe("192.168.1.42");
    expect(row.version).toBe("0.5.0");
  });

  test("heartbeat for an unknown host returns 404", async () => {
    const res = await post("/api/v1/report/health", {
      hostId: "ghost",
      timestamp: Date.now(),
      status: "online",
      version: "0.4.0",
    });
    expect(res.status).toBe(404);
  });

  test("heartbeat rejects unknown status values (existing validation still works)", async () => {
    const res = await post("/api/v1/report/health", {
      hostId: "host-a",
      timestamp: Date.now(),
      status: "nonsense",
      version: "0.4.0",
    });
    expect(res.status).toBe(422);
  });
});
