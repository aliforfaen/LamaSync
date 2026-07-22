import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "report-test-key";

const { getAuthPlugin } = await import("../auth.ts");
const { __setDb, reportRoutes } = (await import("./report.ts")) as typeof import("./report.ts");

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
  db.exec(`
    INSERT INTO hosts (id, hostname) VALUES ('host-a', 'host-a');
    INSERT INTO folders (id, name, type) VALUES ('f1', 'folder1', 'sync');
    INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path, enabled)
      VALUES ('a1', 'f1', 'host-a', 'both', '/tmp/f1', 1);
    INSERT INTO schedule_state (folder_assignment_id) VALUES ('a1');
  `);
  __setDb(db);
  app = new Elysia().use(getAuthPlugin()).use(reportRoutes);
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

describe("POST /api/v1/report", () => {
  test("accepts all OperationStatus values including retry and recovery", async () => {
    const statuses = ["started", "success", "failed", "conflict", "retry", "recovery"] as const;

    for (const status of statuses) {
      const res = await post("/api/v1/report", {
        hostId: "host-a",
        folderId: "f1",
        operation: "sync",
        status,
        summary: `test ${status}`,
      });
      expect(res.status).toBe(204);
    }

    const rows = db
      .query<{ status: string }, []>("SELECT status FROM operation_log ORDER BY id")
      .all();
    expect(rows.map((r) => r.status)).toEqual([...statuses]);
  });

  test("rejects unknown status values", async () => {
    const res = await post("/api/v1/report", {
      hostId: "host-a",
      folderId: "f1",
      operation: "sync",
      status: "unknown_status",
    });
    expect(res.status).toBe(422);
  });

  test("tracks dotfile deployment on successful dotfile report (LAMA-168)", async () => {
    db.run(
      `INSERT INTO dotfile_manifests (id, host_id, app_name, paths) VALUES ('m1', '_global', 'nvim', '[]')`,
    );

    const res = await post("/api/v1/report", {
      hostId: "host-a",
      operation: "dotfile-restore",
      status: "success",
      summary: "restored nvim",
      dotfileAppName: "nvim",
      dotfileDirection: "download",
    });
    expect(res.status).toBe(204);

    const row = db
      .query<{ last_sync_at: number | null; last_sync_direction: string | null }, []>(
        "SELECT last_sync_at, last_sync_direction FROM dotfile_manifests WHERE id = 'm1'",
      )
      .get();
    expect(row?.last_sync_at).not.toBeNull();
    expect(row?.last_sync_direction).toBe("download");
  });

  test("prefers the host-specific manifest over the global one", async () => {
    db.run(
      `INSERT INTO dotfile_manifests (id, host_id, app_name, paths) VALUES ('mg', '_global', 'nvim', '[]')`,
    );
    db.run(
      `INSERT INTO dotfile_manifests (id, host_id, app_name, paths) VALUES ('mh', 'host-a', 'nvim', '[]')`,
    );

    const res = await post("/api/v1/report", {
      hostId: "host-a",
      operation: "dotfile-restore",
      status: "success",
      dotfileAppName: "nvim",
      dotfileDirection: "download",
    });
    expect(res.status).toBe(204);

    const hostRow = db
      .query<{ last_sync_direction: string | null }, []>(
        "SELECT last_sync_direction FROM dotfile_manifests WHERE id = 'mh'",
      )
      .get();
    const globalRow = db
      .query<{ last_sync_direction: string | null }, []>(
        "SELECT last_sync_direction FROM dotfile_manifests WHERE id = 'mg'",
      )
      .get();
    expect(hostRow?.last_sync_direction).toBe("download");
    expect(globalRow?.last_sync_direction).toBeNull();
  });

  test("ignores failed dotfile reports for deployment tracking", async () => {
    db.run(
      `INSERT INTO dotfile_manifests (id, host_id, app_name, paths) VALUES ('m1', '_global', 'nvim', '[]')`,
    );

    const res = await post("/api/v1/report", {
      hostId: "host-a",
      operation: "dotfile-restore",
      status: "failed",
      dotfileAppName: "nvim",
      dotfileDirection: "download",
    });
    expect(res.status).toBe(204);

    const row = db
      .query<{ last_sync_at: number | null; last_sync_direction: string | null }, []>(
        "SELECT last_sync_at, last_sync_direction FROM dotfile_manifests WHERE id = 'm1'",
      )
      .get();
    expect(row?.last_sync_at).toBeNull();
    expect(row?.last_sync_direction).toBeNull();
  });
});
