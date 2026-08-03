import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "hosts-test-key";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-hosts-test-data";

const { getAuthPlugin } = await import("../auth.ts");
const { __setCachedLatestVersionForTests } = (await import("../release-cache.ts")) as typeof import("../release-cache.ts");
const { __resetNotificationStateForTests } = await import("../notifications.ts");
const { __setDb, hostsRoutes } = (await import("./hosts.ts")) as typeof import("./hosts.ts");
const { __setDb: __setConfigRevisionDb } = (await import("../config-revision.ts")) as typeof import("../config-revision.ts");

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
  __resetNotificationStateForTests();
  __setDb(db);
  // config-revision.ts holds its own activeDb; point it at the test DB so
  // bumps issued by the routes land in the same in-memory database.
  __setConfigRevisionDb(db);
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
  tailnet_ip: string | null;
  last_seen: number | null;
  status: string | null;
} {
  const row = db
    .query<
      {
        version: string | null;
        lan_ip: string | null;
        tailnet_ip: string | null;
        last_seen: number | null;
        status: string | null;
      },
      [string]
    >("SELECT version, lan_ip, tailnet_ip, last_seen, status FROM hosts WHERE id = ?")
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

  test("heartbeat persists tailnetIp alongside lanIp (LAMA-223)", async () => {
    const res = await post("/api/v1/report/health", {
      hostId: "host-a",
      timestamp: 1_700_000_000_000,
      status: "online",
      lanIp: "192.168.10.183",
      tailnetIp: "100.64.0.5",
    });
    expect(res.status).toBe(204);
    const row = loadHostRow("host-a");
    expect(row.tailnet_ip).toBe("100.64.0.5");
    expect(row.lan_ip).toBe("192.168.10.183");
  });

  test("heartbeat with null tailnetIp preserves the stored value (LAMA-223)", async () => {
    db.run(`UPDATE hosts SET tailnet_ip = '100.64.0.5' WHERE id = 'host-a'`);

    const res = await post("/api/v1/report/health", {
      hostId: "host-a",
      timestamp: Date.now(),
      status: "online",
      tailnetIp: null,
    });
    expect(res.status).toBe(204);
    const row = loadHostRow("host-a");
    expect(row.tailnet_ip).toBe("100.64.0.5");
  });

  // LAMA-223 P1-4: tailnet_ip change must bump config_revision so
  // every daemon pulls /config/:hostId with the new peer sections.
  test("heartbeat with a new tailnetIp bumps config_revision", async () => {
    db.run("UPDATE hosts SET config_revision = 2 WHERE id = 'host-a'");
    const res = await post("/api/v1/report/health", {
      hostId: "host-a",
      timestamp: Date.now(),
      status: "online",
      tailnetIp: "100.64.0.5",
    });
    expect(res.status).toBe(204);
    const row = loadHostRow("host-a");
    expect(row.tailnet_ip).toBe("100.64.0.5");
    const rev = db
      .query<{ config_revision: number | null }, [string]>(
        "SELECT config_revision FROM hosts WHERE id = ?",
      )
      .get("host-a");
    expect(rev?.config_revision).toBe(3);
  });

  test("heartbeat with an unchanged tailnetIp does not bump config_revision", async () => {
    db.run(
      "UPDATE hosts SET tailnet_ip = '100.64.0.5', config_revision = 4 WHERE id = 'host-a'",
    );
    const res = await post("/api/v1/report/health", {
      hostId: "host-a",
      timestamp: Date.now(),
      status: "online",
      tailnetIp: "100.64.0.5",
    });
    expect(res.status).toBe(204);
    const rev = db
      .query<{ config_revision: number | null }, [string]>(
        "SELECT config_revision FROM hosts WHERE id = ?",
      )
      .get("host-a");
    expect(rev?.config_revision).toBe(4);
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

describe("GET /api/v1/hosts and /api/v1/hosts/:hostId (LAMA-198)", () => {
  async function get(path: string): Promise<Response> {
    return app.handle(request(path));
  }

  test("GET /hosts lists every registered host with configRevision exposed", async () => {
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('host-b', 'host-b')`);
    // Bump host-b explicitly so configRevision shows up non-zero.
    db.run(`UPDATE hosts SET config_revision = 7 WHERE id = 'host-b'`);

    const res = await get("/api/v1/hosts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    const a = body.find((h) => h.id === "host-a");
    const b = body.find((h) => h.id === "host-b");
    expect(a?.configRevision).toBe(0);
    expect(b?.configRevision).toBe(7);
    // Sorted by hostname ASC
    expect(body[0]?.hostname).toBe("host-a");
    expect(body[1]?.hostname).toBe("host-b");
  });

  test("GET /hosts/:hostId returns the single host", async () => {
    const res = await get("/api/v1/hosts/host-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("host-a");
    expect(body.hostname).toBe("host-a");
    expect(body.configRevision).toBe(0);
  });

  test("GET /hosts/:hostId returns 404 for an unknown host", async () => {
    const res = await get("/api/v1/hosts/ghost");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Host not found");
  });

  test("POST /register bumps every other host's config_revision", async () => {
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('host-b', 'host-b')`);
    db.run(`UPDATE hosts SET config_revision = 2 WHERE id = 'host-b'`);

    await post("/api/v1/register", {
      id: "host-c",
      hostname: "host-c",
      tailnetIp: null,
    });

    const row = db
      .query<{ config_revision: number | null }, [string]>(
        "SELECT config_revision FROM hosts WHERE id = ?",
      )
      .get("host-b");
    expect(row?.config_revision).toBe(3);
  });

  test("POST /register emits host_online when an offline host re-registers", async () => {
    db.run("UPDATE hosts SET status = 'offline' WHERE id = 'host-a'");

    const res = await post("/api/v1/register", {
      id: "host-a",
      hostname: "host-a",
      tailnetIp: null,
    });
    expect(res.status).toBe(201);

    const events = db
      .query<{ type: string; host_id: string | null }, []>(
        "SELECT type, host_id FROM notification_events",
      )
      .all();
    expect(events).toEqual([{ type: "host_online", host_id: "host-a" }]);
  });

  test("POST /register does not emit host_online for a brand-new host", async () => {
    const res = await post("/api/v1/register", {
      id: "host-new",
      hostname: "host-new",
      tailnetIp: null,
    });
    expect(res.status).toBe(201);

    const count = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM notification_events WHERE type = 'host_online'",
      )
      .get();
    expect(count?.count).toBe(0);
  });

  test("POST /register does not emit host_online for an already-online host", async () => {
    db.run("UPDATE hosts SET status = 'online' WHERE id = 'host-a'");

    const res = await post("/api/v1/register", {
      id: "host-a",
      hostname: "host-a",
      tailnetIp: null,
    });
    expect(res.status).toBe(201);

    const count = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM notification_events WHERE type = 'host_online'",
      )
      .get();
    expect(count?.count).toBe(0);
  });

  test("POST /report/health emits host_online when an offline host heartbeats online", async () => {
    db.run("UPDATE hosts SET status = 'offline' WHERE id = 'host-a'");

    const res = await post("/api/v1/report/health", {
      hostId: "host-a",
      timestamp: Date.now(),
      status: "online",
    });
    expect(res.status).toBe(204);

    const events = db
      .query<{ type: string; host_id: string | null }, []>(
        "SELECT type, host_id FROM notification_events",
      )
      .all();
    expect(events).toEqual([{ type: "host_online", host_id: "host-a" }]);
  });
});

describe("PATCH /api/v1/hosts/:hostId — host rename (LAMA-225)", () => {
  async function patch(path: string, body: Record<string, unknown>): Promise<Response> {
    return app.handle(request(path, { method: "PATCH", body: JSON.stringify(body) }));
  }

  test("renames the display label; id stays stable", async () => {
    const res = await patch("/api/v1/hosts/host-a", { hostname: "cachy-laptop" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("host-a");
    expect(body.hostname).toBe("cachy-laptop");

    const row = db
      .query<{ id: string; hostname: string }, [string]>(
        "SELECT id, hostname FROM hosts WHERE id = ?",
      )
      .get("host-a");
    expect(row).toEqual({ id: "host-a", hostname: "cachy-laptop" });
  });

  test("returns 404 for an unknown host", async () => {
    const res = await patch("/api/v1/hosts/ghost", { hostname: "new-name" });
    expect(res.status).toBe(404);
  });

  test("returns 409 when the hostname collides with another host's hostname (case-insensitive)", async () => {
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('host-b', 'cachy-laptop')`);
    const res = await patch("/api/v1/hosts/host-a", { hostname: "CACHY-LAPTOP" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("already in use");
  });

  test("returns 409 when the hostname collides with another host's id", async () => {
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('host-b', 'host-b')`);
    const res = await patch("/api/v1/hosts/host-a", { hostname: "host-b" });
    expect(res.status).toBe(409);
  });

  test("rejects non-DNS-safe hostnames with 400", async () => {
    const badNames = ["Upper Case", "has space", "leading-", "-trailing", "", "x".repeat(64)];
    for (const bad of badNames) {
      const res = await patch("/api/v1/hosts/host-a", { hostname: bad });
      expect(res.status).toBe(400);
    }
  });

  test("records a host_rename row in operation_log", async () => {
    const res = await patch("/api/v1/hosts/host-a", { hostname: "cachy-laptop" });
    expect(res.status).toBe(200);
    const rows = db
      .query<
        { operation: string; status: string; summary: string | null; host_id: string },
        []
      >(
        "SELECT operation, status, summary, host_id FROM operation_log WHERE operation = 'host_rename'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      operation: "host_rename",
      status: "success",
      summary: "host-a → cachy-laptop",
      host_id: "host-a",
    });
  });

  test("bumps the renamed host's own config revision so its daemon refreshes promptly", async () => {
    db.run("UPDATE hosts SET config_revision = 3 WHERE id = 'host-a'");
    const res = await patch("/api/v1/hosts/host-a", { hostname: "cachy-laptop" });
    expect(res.status).toBe(200);
    const row = db
      .query<{ config_revision: number | null }, [string]>(
        "SELECT config_revision FROM hosts WHERE id = 'host-a'",
      )
      .get("host-a");
    expect(row?.config_revision).toBe(4);
  });
});

describe("POST /api/v1/register — renamed-host re-key (LAMA-225)", () => {
  function seedDependentRows(hostId: string): void {
    // LAMA-225 P1-5: seed every host-keyed column the cascade touches.
    // P0 used a subset (folder_assignments, operation_log, queued_actions);
    // the wider coverage guards against future column additions silently
    // breaking re-key again.
    db.run(
      `INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path)
       VALUES ('fa-1', 'folder-1', ?, 'source', '/tmp/f1')`,
      [hostId],
    );
    db.run(
      `INSERT INTO dotfile_manifests (id, host_id, app_name, paths, original_uploader_host_id)
       VALUES ('dm-1', ?, 'git', '["~/.gitconfig"]', ?)`,
      [hostId, hostId],
    );
    db.run(
      `INSERT INTO operation_log (timestamp, host_id, operation, status, summary)
       VALUES (1700000000000, ?, 'sync', 'success', 'seed')`,
      [hostId],
    );
    db.run(
      `INSERT INTO queued_actions (id, host_id, type, created_at)
       VALUES ('qa-1', ?, 'check_update', 1700000000000)`,
      [hostId],
    );
    db.run(
      `INSERT INTO conflicts (id, host_id, folder_id, path, created_at)
       VALUES ('cf-1', ?, 'folder-1', 'a.txt', 1700000000000)`,
      [hostId],
    );
    db.run(
      `INSERT INTO restic_snapshots (id, folder_id, host_id, snapshot_id, timestamp, paths)
       VALUES ('rs-1', 'folder-1', ?, 'snap-1', 1700000000000, '[]')`,
      [hostId],
    );
    db.run(
      `INSERT INTO restic_restore_jobs (id, snapshot_id, folder_id, target_host_id, target_path, created_at)
       VALUES ('rr-1', 'snap-1', 'folder-1', ?, '/tmp/restore', 1700000000000)`,
      [hostId],
    );
    db.run(
      `INSERT INTO notification_events (id, type, severity, message, host_id, created_at)
       VALUES ('ne-1', 'host_online', 'info', 'seed', ?, 1700000000000)`,
      [hostId],
    );
    db.run(
      `INSERT INTO folder_locks (folder_id, locked_by) VALUES ('folder-1', ?)`,
      [hostId],
    );
    db.run(
      `INSERT INTO schedule_state (folder_assignment_id, locked_by) VALUES ('fa-1', ?)`,
      [hostId],
    );
  }

  test("re-keys a renamed host on re-registration, preserving history", async () => {
    // Operator renamed host-a → cachy via the UI (label-only PATCH).
    db.run("UPDATE hosts SET hostname = 'cachy' WHERE id = 'host-a'");
    seedDependentRows("host-a");

    // Daemon restarts with client.toml hostname = 'cachy'.
    const res = await post("/api/v1/register", {
      id: "cachy",
      hostname: "cachy",
      tailnetIp: null,
    });
    expect(res.status).toBe(201);

    // The row was re-keyed: id is now cachy, no duplicate host remains.
    const hosts = db
      .query<{ id: string; hostname: string }, []>(
        "SELECT id, hostname FROM hosts ORDER BY id",
      )
      .all();
    expect(hosts).toEqual([{ id: "cachy", hostname: "cachy" }]);

    // Every host_id reference followed the host.
    const fa = db.query<{ host_id: string }, []>("SELECT host_id FROM folder_assignments").all();
    expect(fa).toEqual([{ host_id: "cachy" }]);
    const ops = db.query<{ host_id: string }, []>("SELECT host_id FROM operation_log").all();
    expect(ops).toEqual([{ host_id: "cachy" }]);
    const qa = db.query<{ host_id: string }, []>("SELECT host_id FROM queued_actions").all();
    expect(qa).toEqual([{ host_id: "cachy" }]);
    const cf = db.query<{ host_id: string }, []>("SELECT host_id FROM conflicts").all();
    expect(cf).toEqual([{ host_id: "cachy" }]);
    const rs = db.query<{ host_id: string }, []>("SELECT host_id FROM restic_snapshots").all();
    expect(rs).toEqual([{ host_id: "cachy" }]);
    const rr = db
      .query<{ target_host_id: string }, []>("SELECT target_host_id FROM restic_restore_jobs")
      .all();
    expect(rr).toEqual([{ target_host_id: "cachy" }]);
    const ne = db.query<{ host_id: string | null }, []>("SELECT host_id FROM notification_events").all();
    expect(ne).toEqual([{ host_id: "cachy" }]);
    // LAMA-225 P1-5: dotfile_manifests has TWO host-keyed columns.
    const dm = db
      .query<{ host_id: string; original_uploader_host_id: string | null }, []>(
        "SELECT host_id, original_uploader_host_id FROM dotfile_manifests",
      )
      .all();
    expect(dm).toEqual([{ host_id: "cachy", original_uploader_host_id: "cachy" }]);
    // Locks/schedule: locked_by column re-keyed.
    const fl = db.query<{ locked_by: string | null }, []>("SELECT locked_by FROM folder_locks").all();
    expect(fl).toEqual([{ locked_by: "cachy" }]);
    const ss = db
      .query<{ locked_by: string | null }, []>("SELECT locked_by FROM schedule_state")
      .all();
    expect(ss).toEqual([{ locked_by: "cachy" }]);
  });

  test("normal registration of an existing host does not re-key", async () => {
    seedDependentRows("host-a");
    const res = await post("/api/v1/register", {
      id: "host-a",
      hostname: "host-a",
      tailnetIp: null,
    });
    expect(res.status).toBe(201);
    const row = db
      .query<{ id: string; hostname: string }, [string]>(
        "SELECT id, hostname FROM hosts WHERE id = ?",
      )
      .get("host-a");
    expect(row).toEqual({ id: "host-a", hostname: "host-a" });
    const fa = db.query<{ host_id: string }, []>("SELECT host_id FROM folder_assignments").all();
    expect(fa).toEqual([{ host_id: "host-a" }]);
  });
});
