// LAMA-224: storage statistics route + engine. Measurements are lazy and
// never fail the report; unreachable backends surface as per-entry errors.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_SCHEMA, MIGRATIONS } from "@lamasync/core";
process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "stats-test-key";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "stats-test-secret-key-0123456789abcdef";

const { getAuthPlugin } = await import("../auth.ts");
const { __setDb, statsRoutes } = (await import("./stats.ts")) as unknown as {
  __setDb: (db: Database) => void;
  statsRoutes: Elysia;
};
const { __setDb: __setFoldersDb, foldersRoutes } = (await import("./folders.ts")) as unknown as {
  __setDb: (db: Database) => void;
  foldersRoutes: Elysia;
};
const { __setDb: __setConfigRevisionDb } = (await import("../config-revision.ts")) as unknown as {
  __setDb: (db: Database) => void;
};
const { encryptSecret } = await import("../crypto.ts");
const { __resetStatsCaches } = await import("../stats.ts");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };
let dataDir: string;
let backupDir: string;
let localRoot: string;
let base: string;

function request(path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { Authorization: `Bearer ${process.env.LAMASYNC_API_KEY}` },
  });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "lamasync-stats-"));
  dataDir = join(base, "data");
  backupDir = join(base, "backups");
  localRoot = join(base, "localroot");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(localRoot, { recursive: true });
  writeFileSync(join(dataDir, "server.db"), "x".repeat(2048));
  writeFileSync(join(backupDir, "backup.bin"), "y".repeat(4096));
  writeFileSync(join(localRoot, "file.txt"), "z".repeat(1024));
  process.env.LAMASYNC_DATA_DIR = dataDir;
  process.env.LAMASYNC_BACKUP_DIR = backupDir;

  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // idempotent
    }
  }
  __setDb(db);
  __setFoldersDb(db);
  __setConfigRevisionDb(db);
  __resetStatsCaches();
  app = new Elysia().use(getAuthPlugin()).use(statsRoutes).use(foldersRoutes);
});

afterEach(() => {
  db.close();
  // LAMA-224 P1-7: the previous afterEach tried to rm a literal prefix
  // path (`/tmp/lamasync-stats-`) which never matched the unique random
  // directory mkdtempSync produced — every test leaked its temp tree.
  // Capture and remove the actual base instead.
  rmSync(base, { recursive: true, force: true });
});

function insertS3BackendWithFolder(): string {
  const backendId = crypto.randomUUID();
  db.run(
    `INSERT INTO backends (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, created_at)
     VALUES (?, 'cold-archive', 's3', 'other', 's3.example.com', 'us-east-1', 'K', ?, ?)`,
    [backendId, encryptSecret("S"), Date.now()],
  );
  db.run(
    "INSERT INTO folders (id, name, type, backend, backend_id, s3_bucket) VALUES (?, 'vault', 'backup', 's3', ?, 'cold-archive-bucket')",
    ["folder-s3", backendId],
  );
  return backendId;
}

describe("GET /api/v1/stats/storage", () => {
  test("returns local roots + restic aggregate, totals computed", async () => {
    const res = await app.handle(request("/api/v1/stats/storage"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      generatedAt: number;
      totalBytes: number;
      backends: Array<{ backendId: string | null; kind: string; bytes: number; objectCount: number | null; error: string | null }>;
    };
    const local = body.backends.find((b) => b.kind === "local");
    expect(local).toBeTruthy();
    expect(local!.bytes).toBe(2048 + 4096);
    const restic = body.backends.find((b) => b.kind === "restic");
    expect(restic).toBeTruthy();
    expect(restic!.bytes).toBe(0);
    expect(restic!.objectCount).toBe(0);
    expect(body.totalBytes).toBe(2048 + 4096 + 0);
  });

  test("unreachable S3 backend yields an error entry, not a failed report", async () => {
    insertS3BackendWithFolder();
    const res = await app.handle(request("/api/v1/stats/storage"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      backends: Array<{ kind: string; bytes: number; objectCount: number | null; error: string | null }>;
    };
    const s3 = body.backends.find((b) => b.kind === "s3");
    expect(s3).toBeTruthy();
    // rclone is not installed in unit tests; the measurement fails gracefully.
    expect(s3!.error).toBeTruthy();
    expect(s3!.bytes).toBe(0);
  });

  test("caches for 5 minutes; ?refresh=1 bypasses", async () => {
    insertS3BackendWithFolder();
    const first = await app.handle(request("/api/v1/stats/storage"));
    const a = (await first.json()) as { generatedAt: number };
    await Bun.sleep(5);
    const second = await app.handle(request("/api/v1/stats/storage"));
    const b = (await second.json()) as { generatedAt: number };
    expect(b.generatedAt).toBe(a.generatedAt); // served from cache

    const refreshed = await app.handle(request("/api/v1/stats/storage?refresh=1"));
    const c = (await refreshed.json()) as { generatedAt: number };
    expect(c.generatedAt).not.toBe(a.generatedAt); // recomputed
  });
});

describe("GET /api/v1/folders/:id/size", () => {
  test("returns a typed null for non-S3 folders (LAMA-224 P1-7)", async () => {
    // Local/sftp folders store their working set on the daemon host —
    // running `du` server-side always returns ENOENT. The endpoint now
    // returns a typed null + 'not measurable server-side' error so the
    // Folders page renders "n/a" instead of a misleading error dash.
    db.run(
      "INSERT INTO folders (id, name, type, backend) VALUES ('f1', 'mydocs', 'sync', 'sftp')",
    );
    db.run(
      "INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path) VALUES ('a1', 'f1', 'h1', 'source', ?)",
      [localRoot],
    );
    const res = await app.handle(request("/api/v1/folders/f1/size"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      folderId: string;
      bytes: number | null;
      error: string | null;
    };
    expect(body.folderId).toBe("f1");
    expect(body.bytes).toBeNull();
    expect(body.error).toBe("not measurable server-side");
  });

  test("404 for unknown folder", async () => {
    const res = await app.handle(request("/api/v1/folders/missing/size"));
    expect(res.status).toBe(404);
  });
});
