// LAMA-224: storage statistics route + engine. Measurements are lazy and
// never fail the report; unreachable backends surface as per-entry errors.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_SCHEMA, MIGRATIONS } from "@lamasync/core";
import type { Folder, FolderSize } from "@lamasync/core";
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
type SizeMeasurer = (
  configText: string,
  target: string,
) => Promise<{ bytes: number; objectCount: number | null; error: string | null }>;

const {
  __resetStatsCaches,
  recordSizeHistory,
  getStorageHistory,
  folderDestinationPrefixes,
  __setSizeMeasurer,
} = (await import("../stats.ts")) as unknown as {
  __resetStatsCaches: () => void;
  recordSizeHistory: (db: Database, folder: Folder, size: FolderSize) => void;
  getStorageHistory: (db: Database) => Record<string, Array<{ measuredAt: number; bytes: number | null }>>;
  folderDestinationPrefixes: (db: Database, folder: Folder) => string[];
  __setSizeMeasurer: (measurer: SizeMeasurer | null) => void;
};

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

afterEach(() => {
  // LAMA-304: the fake measurer is only installed for this file's tests;
  // always restore the real rclone spawn path so sibling tests never see a stub.
  if (typeof __setSizeMeasurer === "function") __setSizeMeasurer(null);
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

function insertAssignments(
  folderId: string,
  rows: Array<{
    id: string;
    hostId: string;
    destination?: string | null;
    resticRepository?: string | null;
  }>,
): void {
  for (const r of rows) {
    db.run(
      `INSERT INTO folder_assignments
         (id, folder_id, host_id, role, local_path, destination, restic_repository, enabled)
       VALUES (?, ?, ?, 'both', ?, ?, ?, 1)`,
      [r.id, folderId, r.hostId, `/local/${r.hostId}`, r.destination ?? null, r.resticRepository ?? null],
    );
  }
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

describe("LAMA-269: size history + storage donut/sparkline data", () => {
  function folderObj(id: string, backendId: string | null): Folder {
    return { id, name: id, type: "backup", backend: "s3", backendId, s3Bucket: "b" };
  }
  function seedFolder(id: string, backendId: string | null): Folder {
    const f = folderObj(id, backendId);
    db.run(
      "INSERT INTO folders (id, name, type, backend, backend_id) VALUES (?, ?, 'backup', 's3', ?)",
      [id, id, backendId],
    );
    return f;
  }

  test("recordSizeHistory aggregates a destination's total across its folders", () => {
    seedFolder("f1", "b1");
    seedFolder("f2", "b1");
    // Two measurements at different times; the backend snapshot reflects
    // the destination's running total (f1 measured first, then f2 added).
    recordSizeHistory(db, folderObj("f1", "b1"), {
      folderId: "f1", bytes: 100, objectCount: 5, error: null, measuredAt: 1000,
    });
    recordSizeHistory(db, folderObj("f2", "b1"), {
      folderId: "f2", bytes: 200, objectCount: 8, error: null, measuredAt: 2000,
    });
    const history = getStorageHistory(db);
    expect(history["b1"]).toEqual([
      { measuredAt: 1000, bytes: 100 },
      { measuredAt: 2000, bytes: 300 },
    ]);
  });

  test("backend aggregate tracks the latest per-folder size over time", () => {
    seedFolder("f1", "b1");
    recordSizeHistory(db, folderObj("f1", "b1"), {
      folderId: "f1", bytes: 100, objectCount: 1, error: null, measuredAt: 1000,
    });
    recordSizeHistory(db, folderObj("f1", "b1"), {
      folderId: "f1", bytes: 150, objectCount: 2, error: null, measuredAt: 2000,
    });
    expect(getStorageHistory(db)["b1"]).toEqual([
      { measuredAt: 1000, bytes: 100 },
      { measuredAt: 2000, bytes: 150 },
    ]);
  });

  test("failed / unmeasured sizes are not recorded (no fake zero)", () => {
    seedFolder("f1", "b1");
    recordSizeHistory(db, folderObj("f1", "b1"), {
      folderId: "f1", bytes: null, objectCount: null,
      error: "not measurable server-side", measuredAt: 1000,
    });
    expect(getStorageHistory(db)).toEqual({});
  });

  test("GET /stats/storage/history returns a per-backend time series", async () => {
    const backendId = insertS3BackendWithFolder();
    recordSizeHistory(db, folderObj("folder-s3", backendId), {
      folderId: "folder-s3", bytes: 42, objectCount: 3, error: null, measuredAt: 5000,
    });
    const res = await app.handle(request("/api/v1/stats/storage/history"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      backends: Record<string, Array<{ measuredAt: number; bytes: number | null }>>;
    };
    expect(body.backends[backendId]).toEqual([{ measuredAt: 5000, bytes: 42 }]);
  });

  test("GET /folders/sizes returns a map; non-S3 folders are bytes:null", async () => {
    insertS3BackendWithFolder();
    db.run(
      "INSERT INTO folders (id, name, type, backend) VALUES ('local1', 'localdoc', 'sync', 'sftp')",
    );
    const res = await app.handle(request("/api/v1/folders/sizes"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, FolderSize>;
    expect(body["local1"].bytes).toBeNull();
    expect(body["folder-s3"]).toBeTruthy();
  });
});

describe("LAMA-304: per-prefix S3 folder sizing", () => {
  test("folderDestinationPrefixes: backup folders are host-scoped by default", () => {
    db.run(
      "INSERT INTO folders (id, name, type, backend) VALUES ('fb', 'photos', 'backup', 's3')",
    );
    insertAssignments("fb", [
      { id: "a1", hostId: "host-a" },
      { id: "a2", hostId: "host-b" },
    ]);
    const folder: Folder = {
      id: "fb",
      name: "photos",
      type: "backup",
      backend: "s3",
      backendId: "b1",
      s3Bucket: "bucket",
    };
    expect(folderDestinationPrefixes(db, folder)).toEqual([
      "photos/host-a",
      "photos/host-b",
    ]);
  });

  test("folderDestinationPrefixes: sync folders stay shared (folder name)", () => {
    db.run(
      "INSERT INTO folders (id, name, type, backend) VALUES ('fs', 'work', 'sync', 'sftp')",
    );
    insertAssignments("fs", [
      { id: "s1", hostId: "host-a" },
      { id: "s2", hostId: "host-b" },
    ]);
    const folder: Folder = { id: "fs", name: "work", type: "sync", backend: "sftp" };
    expect(folderDestinationPrefixes(db, folder)).toEqual(["work"]);
  });

  test("folderDestinationPrefixes: an explicit destination wins over the default", () => {
    db.run(
      "INSERT INTO folders (id, name, type, backend) VALUES ('fd', 'docs', 'backup', 's3')",
    );
    insertAssignments("fd", [{ id: "d1", hostId: "host-a", destination: "shared/docs" }]);
    const folder: Folder = { id: "fd", name: "docs", type: "backup", backend: "s3" };
    expect(folderDestinationPrefixes(db, folder)).toEqual(["shared/docs"]);
  });

  test("folderDestinationPrefixes: restic-repo assignments are excluded", () => {
    db.run(
      "INSERT INTO folders (id, name, type, backend) VALUES ('fr', 'vault', 'backup', 's3')",
    );
    insertAssignments("fr", [
      { id: "r1", hostId: "host-a", resticRepository: "restic://repo" },
      { id: "r2", hostId: "host-b" },
    ]);
    const folder: Folder = { id: "fr", name: "vault", type: "backup", backend: "s3" };
    expect(folderDestinationPrefixes(db, folder)).toEqual(["vault/host-b"]);
  });

  test("folderDestinationPrefixes: duplicate resolved destinations are de-duplicated", () => {
    db.run(
      "INSERT INTO folders (id, name, type, backend) VALUES ('fd2', 'videos', 'backup', 's3')",
    );
    insertAssignments("fd2", [
      { id: "v1", hostId: "host-a", destination: "shared/media" },
      { id: "v2", hostId: "host-b", destination: "shared/media" },
    ]);
    const folder: Folder = { id: "fd2", name: "videos", type: "backup", backend: "s3" };
    expect(folderDestinationPrefixes(db, folder)).toEqual(["shared/media"]);
  });
});

describe("GET /api/v1/folders/:id/size per-prefix (LAMA-304)", () => {
  test("measures each distinct destination prefix and sums them", async () => {
    insertS3BackendWithFolder();
    insertAssignments("folder-s3", [
      { id: "pa1", hostId: "host-a" },
      { id: "pa2", hostId: "host-b" },
    ]);
    const targets: string[] = [];
    __setSizeMeasurer(async (_configText, target) => {
      targets.push(target);
      if (target.endsWith("/host-a")) return { bytes: 100, objectCount: 2, error: null };
      if (target.endsWith("/host-b")) return { bytes: 200, objectCount: 5, error: null };
      return { bytes: 0, objectCount: 0, error: null };
    });
    const res = await app.handle(request("/api/v1/folders/folder-s3/size"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bytes: number | null;
      objectCount: number | null;
      error: string | null;
    };
    expect(targets).toEqual([
      "stats:cold-archive-bucket/vault/host-a",
      "stats:cold-archive-bucket/vault/host-b",
    ]);
    expect(body.bytes).toBe(300);
    expect(body.objectCount).toBe(7);
    expect(body.error).toBeNull();
  });

  test("any prefix failure makes the folder size null with the first error", async () => {
    insertS3BackendWithFolder();
    insertAssignments("folder-s3", [
      { id: "pf1", hostId: "host-a" },
      { id: "pf2", hostId: "host-b" },
    ]);
    __setSizeMeasurer(async () => ({
      bytes: 0,
      objectCount: null,
      error: "S3 unavailable",
    }));
    const res = await app.handle(request("/api/v1/folders/folder-s3/size"));
    const body = (await res.json()) as { bytes: number | null; error: string | null };
    expect(body.bytes).toBeNull();
    expect(body.error).toBe("S3 unavailable");
  });

  test("no assignments yields 'no resolvable destination prefix'", async () => {
    insertS3BackendWithFolder();
    const res = await app.handle(request("/api/v1/folders/folder-s3/size"));
    const body = (await res.json()) as { bytes: number | null; error: string | null };
    expect(body.bytes).toBeNull();
    expect(body.error).toBe("no resolvable destination prefix");
  });

  test("distinct assignments resolving to one destination are counted once", async () => {
    const backendId = insertS3BackendWithFolder();
    db.run(
      "INSERT INTO folders (id, name, type, backend, backend_id, s3_bucket) VALUES ('folder-dup', 'shared', 'backup', 's3', ?, 'cold-archive-bucket')",
      [backendId],
    );
    insertAssignments("folder-dup", [
      { id: "pd1", hostId: "host-a", destination: "shared/media" },
      { id: "pd2", hostId: "host-b", destination: "shared/media" },
    ]);
    const targets: string[] = [];
    __setSizeMeasurer(async (_configText, target) => {
      targets.push(target);
      return { bytes: 500, objectCount: 9, error: null };
    });
    const res = await app.handle(request("/api/v1/folders/folder-dup/size"));
    const body = (await res.json()) as {
      bytes: number | null;
      objectCount: number | null;
      error: string | null;
    };
    expect(targets).toEqual(["stats:cold-archive-bucket/shared/media"]);
    expect(body.bytes).toBe(500);
    expect(body.objectCount).toBe(9);
  });
});
