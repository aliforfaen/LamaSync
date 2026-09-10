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
  __refreshState,
  __drainFolderRefreshes,
  __folderCacheSize,
  invalidateFolderSize,
} = (await import("../stats.ts")) as unknown as {
  __resetStatsCaches: () => void;
  recordSizeHistory: (db: Database, folder: Folder, size: FolderSize) => void;
  getStorageHistory: (db: Database, options?: { days?: number; granularity?: "day" | "raw" }) => Record<string, Array<{ measuredAt: number; bytes: number | null }>>;
  folderDestinationPrefixes: (db: Database, folder: Folder) => string[];
  __setSizeMeasurer: (measurer: SizeMeasurer | null) => void;
  __refreshState: () => { active: number; queued: number; scheduled: number };
  __drainFolderRefreshes: () => Promise<void>;
  __folderCacheSize: () => number;
  invalidateFolderSize: (db: Database, folderId: string) => void;
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

afterEach(async () => {
  // LAMA-328: finish any scheduled background refresh before the database it
  // is measuring against goes away.
  await __drainFolderRefreshes();
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
  // LAMA-328: history is now served through a bounded window, so these tests
  // anchor on real (recent) timestamps instead of epoch milliseconds.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = Date.now();

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
      folderId: "f1", bytes: 100, objectCount: 5, error: null, measuredAt: NOW - 2 * DAY_MS,
    });
    recordSizeHistory(db, folderObj("f2", "b1"), {
      folderId: "f2", bytes: 200, objectCount: 8, error: null, measuredAt: NOW - DAY_MS,
    });
    const history = getStorageHistory(db);
    expect(history["b1"]).toEqual([
      { measuredAt: NOW - 2 * DAY_MS, bytes: 100 },
      { measuredAt: NOW - DAY_MS, bytes: 300 },
    ]);
  });

  test("backend aggregate tracks the latest per-folder size over time", () => {
    seedFolder("f1", "b1");
    recordSizeHistory(db, folderObj("f1", "b1"), {
      folderId: "f1", bytes: 100, objectCount: 1, error: null, measuredAt: NOW - 2 * DAY_MS,
    });
    recordSizeHistory(db, folderObj("f1", "b1"), {
      folderId: "f1", bytes: 150, objectCount: 2, error: null, measuredAt: NOW - DAY_MS,
    });
    expect(getStorageHistory(db)["b1"]).toEqual([
      { measuredAt: NOW - 2 * DAY_MS, bytes: 100 },
      { measuredAt: NOW - DAY_MS, bytes: 150 },
    ]);
  });

  test("failed / unmeasured sizes are not recorded (no fake zero)", () => {
    seedFolder("f1", "b1");
    recordSizeHistory(db, folderObj("f1", "b1"), {
      folderId: "f1", bytes: null, objectCount: null,
      error: "not measurable server-side", measuredAt: NOW,
    });
    expect(getStorageHistory(db)).toEqual({});
  });

  test("GET /stats/storage/history returns a per-backend time series", async () => {
    const backendId = insertS3BackendWithFolder();
    recordSizeHistory(db, folderObj("folder-s3", backendId), {
      folderId: "folder-s3", bytes: 42, objectCount: 3, error: null, measuredAt: NOW,
    });
    const res = await app.handle(request("/api/v1/stats/storage/history"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      backends: Record<string, Array<{ measuredAt: number; bytes: number | null }>>;
    };
    expect(body.backends[backendId]).toEqual([{ measuredAt: NOW, bytes: 42 }]);
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

// LAMA-328: the folder-size read path is stale-while-revalidate. These tests
// pin the observable contract: a cold server answers from persisted history, at
// most one refresh runs per folder, refresh work is bounded globally and per
// backend, a failed refresh keeps the last known bytes, and an explicit
// refresh measures on the request.
describe("LAMA-328: stale-while-revalidate folder sizes", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Gated measurer: counts calls and blocks until released. */
  function gatedMeasurer(): {
    calls: () => number;
    release: () => void;
  } {
    let calls = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Safety: a failing assertion must not leave a refresh blocked forever.
    const timer = setTimeout(release, 2000);
    __setSizeMeasurer(async () => {
      calls += 1;
      await gate;
      return { bytes: 1000, objectCount: 3, error: null };
    });
    return {
      calls: () => calls,
      release: () => {
        clearTimeout(timer);
        release();
      },
    };
  }

  /** A persisted successful measurement, as a restarting server would find it. */
  function persistSize(folderId: string, bytes: number, measuredAt: number): void {
    db.run(
      "INSERT INTO size_history (scope, ref_id, bytes, object_count, measured_at) VALUES ('folder', ?, ?, 1, ?)",
      [folderId, bytes, measuredAt],
    );
  }

  function insertBackendWithFolder(folderId: string, label: string): string {
    const backendId = crypto.randomUUID();
    db.run(
      `INSERT INTO backends (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, created_at)
       VALUES (?, ?, 's3', 'other', 's3.example.com', 'us-east-1', 'K', ?, ?)`,
      [backendId, label, encryptSecret("S"), Date.now()],
    );
    db.run(
      "INSERT INTO folders (id, name, type, backend, backend_id, s3_bucket) VALUES (?, ?, 'backup', 's3', ?, 'bucket')",
      [folderId, label, backendId],
    );
    return backendId;
  }

  function sizeOf(res: Response): Promise<FolderSize> {
    return res.json() as Promise<FolderSize>;
  }

  test("a cold server serves the persisted measurement without measuring", async () => {
    insertBackendWithFolder("folder-cold", "cold");
    insertAssignments("folder-cold", [{ id: "c1", hostId: "host-a" }]);
    const measuredAt = Date.now() - DAY_MS;
    persistSize("folder-cold", 4096, measuredAt);
    const measurer = gatedMeasurer();

    const body = await sizeOf(await app.handle(request("/api/v1/folders/folder-cold/size")));
    // Returned while the measurement is still blocked: no request-path rclone.
    expect(body.bytes).toBe(4096);
    expect(body.measuredAt).toBe(measuredAt);
    expect(body.stale).toBe(true);
    expect(body.refreshing).toBe(true);
    // The persisted row seeded the in-memory cache, so a restart re-learns it.
    expect(__folderCacheSize()).toBe(1);

    measurer.release();
    await __drainFolderRefreshes();
    expect(measurer.calls()).toBe(1);

    const after = await sizeOf(await app.handle(request("/api/v1/folders/folder-cold/size")));
    expect(after.bytes).toBe(1000);
    expect(after.stale).toBe(false);
    expect(after.refreshing).toBe(false);
    // Serving the fresh cache must not have scheduled more work.
    expect(measurer.calls()).toBe(1);
  });

  test("two reads of one stale folder share a single background refresh", async () => {
    insertBackendWithFolder("folder-dedupe", "dedupe");
    insertAssignments("folder-dedupe", [{ id: "d1", hostId: "host-a" }]);
    persistSize("folder-dedupe", 10, Date.now() - 2 * DAY_MS);
    const measurer = gatedMeasurer();

    const [first, second] = await Promise.all([
      app.handle(request("/api/v1/folders/folder-dedupe/size")),
      app.handle(request("/api/v1/folders/folder-dedupe/size")),
    ]);
    expect((await sizeOf(first)).bytes).toBe(10);
    expect((await sizeOf(second)).bytes).toBe(10);
    expect(measurer.calls()).toBe(1);
    expect(__refreshState().scheduled).toBe(1);

    measurer.release();
    await __drainFolderRefreshes();
    expect(__refreshState()).toEqual({ active: 0, queued: 0, scheduled: 0 });
  });

  test("the bulk surface never blocks and bounds refreshes globally and per backend", async () => {
    for (const n of ["a", "b", "c"]) {
      insertBackendWithFolder(`folder-${n}`, `backend-${n}`);
      insertAssignments(`folder-${n}`, [{ id: `as-${n}`, hostId: "host-a" }]);
    }
    db.run(
      "INSERT INTO folders (id, name, type, backend) VALUES ('local-1', 'localdoc', 'sync', 'sftp')",
    );
    const measurer = gatedMeasurer();

    const res = await app.handle(request("/api/v1/folders/sizes"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, FolderSize>;
    // Unknown folders are reported as refreshing with no fabricated measurement
    // (the response is built while every measurement is still blocked).
    expect(body["folder-a"]).toEqual({
      folderId: "folder-a",
      bytes: null,
      objectCount: null,
      error: null,
      measuredAt: null,
      stale: true,
      refreshing: true,
    });
    // Non-S3 folders stay a typed null and never get a refresh.
    expect(body["local-1"]).toEqual({
      folderId: "local-1",
      bytes: null,
      objectCount: null,
      error: "not measurable server-side",
      measuredAt: null,
      stale: false,
      refreshing: false,
    });
    // Two refreshes run (global bound), the third waits, and the per-backend
    // bound keeps a single bucket from filling both slots.
    expect(__refreshState().active).toBe(2);
    expect(__refreshState().queued).toBe(1);
    expect(measurer.calls()).toBe(2);

    measurer.release();
    await __drainFolderRefreshes();
    expect(__refreshState()).toEqual({ active: 0, queued: 0, scheduled: 0 });
  });

  test("a failed refresh keeps the last known bytes and reports the error", async () => {
    insertBackendWithFolder("folder-fail", "fail");
    insertAssignments("folder-fail", [{ id: "f1", hostId: "host-a" }]);
    persistSize("folder-fail", 2048, Date.now() - 2 * DAY_MS);
    __setSizeMeasurer(async () => ({ bytes: 0, objectCount: null, error: "S3 unavailable" }));

    const first = await sizeOf(await app.handle(request("/api/v1/folders/folder-fail/size")));
    expect(first.bytes).toBe(2048);
    expect(first.error).toBeNull();

    await __drainFolderRefreshes();
    const second = await sizeOf(await app.handle(request("/api/v1/folders/folder-fail/size")));
    expect(second.bytes).toBe(2048);
    expect(second.error).toBe("S3 unavailable");
    expect(second.stale).toBe(true);
    // The failed attempt was the refresh: it is not retried on every read.
    expect(second.refreshing).toBe(false);
    expect(__refreshState().scheduled).toBe(0);

    const rows = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM size_history WHERE scope = 'folder'")
      .get();
    expect(rows?.c).toBe(1);
  });

  test("a first-ever failure reports no measurement time and persists nothing", async () => {
    insertBackendWithFolder("folder-never", "never");
    insertAssignments("folder-never", [{ id: "n1", hostId: "host-a" }]);
    __setSizeMeasurer(async () => ({ bytes: 0, objectCount: null, error: "unreachable" }));

    const body = await sizeOf(
      await app.handle(request("/api/v1/folders/folder-never/size?refresh=true")),
    );
    expect(body.bytes).toBeNull();
    expect(body.measuredAt).toBeNull();
    expect(body.error).toBe("unreachable");
    expect(body.stale).toBe(true);
    const rows = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM size_history").get();
    expect(rows?.c).toBe(0);
  });

  test("refresh=true measures on the request instead of serving persisted bytes", async () => {
    insertBackendWithFolder("folder-force", "force");
    insertAssignments("folder-force", [{ id: "x1", hostId: "host-a" }]);
    persistSize("folder-force", 4096, Date.now() - 2 * DAY_MS);
    __setSizeMeasurer(async () => ({ bytes: 777, objectCount: 2, error: null }));

    const body = await sizeOf(
      await app.handle(request("/api/v1/folders/folder-force/size?refresh=true")),
    );
    expect(body.bytes).toBe(777);
    expect(body.stale).toBe(false);
    expect(body.refreshing).toBe(false);
    expect(__refreshState().scheduled).toBe(0);
    const rows = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM size_history WHERE scope = 'folder'")
      .get();
    expect(rows?.c).toBe(2);
  });

  test("refresh=true on the bulk surface schedules work without blocking", async () => {
    insertBackendWithFolder("folder-bulk-force", "bulk-force");
    insertAssignments("folder-bulk-force", [{ id: "b1", hostId: "host-a" }]);
    persistSize("folder-bulk-force", 32, Date.now() - 2 * DAY_MS);
    const measurer = gatedMeasurer();

    const body = (await (
      await app.handle(request("/api/v1/folders/sizes?refresh=true"))
    ).json()) as Record<string, FolderSize>;
    // Known bytes are still reported, flagged as refreshing.
    expect(body["folder-bulk-force"].bytes).toBe(32);
    expect(body["folder-bulk-force"].refreshing).toBe(true);
    expect(__refreshState().scheduled).toBe(1);

    measurer.release();
    await __drainFolderRefreshes();
    expect(measurer.calls()).toBe(1);
  });

  test("every read reports an in-flight refresh until it lands", async () => {
    insertBackendWithFolder("folder-inflight", "inflight");
    insertAssignments("folder-inflight", [{ id: "i1", hostId: "host-a" }]);
    persistSize("folder-inflight", 512, Date.now() - 2 * DAY_MS);
    const measurer = gatedMeasurer();

    const first = await sizeOf(await app.handle(request("/api/v1/folders/folder-inflight/size")));
    const second = await sizeOf(await app.handle(request("/api/v1/folders/folder-inflight/size")));
    expect(first.refreshing).toBe(true);
    // The refresh is still gated, so the second read must not claim it finished
    // — a polling caller would stop and never render the new value.
    expect(second.refreshing).toBe(true);
    expect(second.stale).toBe(true);
    expect(second.bytes).toBe(512);
    expect(__refreshState().scheduled).toBe(1);

    measurer.release();
    await __drainFolderRefreshes();
    const third = await sizeOf(await app.handle(request("/api/v1/folders/folder-inflight/size")));
    expect(third.bytes).toBe(1000);
    expect(third.refreshing).toBe(false);
    expect(third.stale).toBe(false);
  });

  test("a persisted measurement inside the TTL is served as current, not re-measured", async () => {
    insertBackendWithFolder("folder-fresh", "fresh");
    insertAssignments("folder-fresh", [{ id: "fr1", hostId: "host-a" }]);
    const measuredAt = Date.now() - 60_000;
    persistSize("folder-fresh", 777, measuredAt);
    let calls = 0;
    __setSizeMeasurer(async () => {
      calls += 1;
      return { bytes: 1, objectCount: 1, error: null };
    });

    const body = await sizeOf(await app.handle(request("/api/v1/folders/folder-fresh/size")));
    expect(body.bytes).toBe(777);
    expect(body.measuredAt).toBe(measuredAt);
    expect(body.stale).toBe(false);
    expect(body.refreshing).toBe(false);
    // A restart must not re-measure every folder that already has a fresh row.
    expect(__refreshState().scheduled).toBe(0);
    expect(calls).toBe(0);
  });

  test("a mutation invalidates persisted bytes even with a cold cache", async () => {
    insertBackendWithFolder("folder-inval", "inval");
    insertAssignments("folder-inval", [{ id: "iv1", hostId: "host-a" }]);
    persistSize("folder-inval", 100, Date.now() - 60_000); // inside the TTL
    const measurer = gatedMeasurer();

    // A browse/report write after a restart: nothing is in memory, so the
    // invalidation has to outlive the cache to mean anything.
    invalidateFolderSize(db, "folder-inval");
    const body = await sizeOf(await app.handle(request("/api/v1/folders/folder-inval/size")));
    expect(body.bytes).toBe(100); // still answered immediately
    expect(body.stale).toBe(true); // but never presented as current
    expect(body.refreshing).toBe(true);
    expect(__refreshState().scheduled).toBe(1);

    measurer.release();
    await __drainFolderRefreshes();
  });

  test("a mutation during a measurement keeps the result marked not-current", async () => {
    insertBackendWithFolder("folder-race", "race");
    insertAssignments("folder-race", [{ id: "rc1", hostId: "host-a" }]);
    // Two gates: the explicit measurement waits on gate 1; any follow-up
    // refresh it schedules waits on gate 2, so the follow-up cannot race the
    // next read with an instant success (the response would then legitimately
    // say "fresh" and the assertion would be timing-dependent).
    let release = (): void => {};
    const gate1 = new Promise<void>((resolve) => {
      release = resolve;
    });
    let releaseFollowup = (): void => {};
    const gate2 = new Promise<void>((resolve) => {
      releaseFollowup = resolve;
    });
    const timer = setTimeout(() => {
      release();
      releaseFollowup();
    }, 2000);
    let calls = 0;
    __setSizeMeasurer(async () => {
      calls += 1;
      await (calls === 1 ? gate1 : gate2);
      return { bytes: 4096, objectCount: 1, error: null };
    });

    const inflight = app.handle(request("/api/v1/folders/folder-race/size?refresh=true"));
    // The write must land while the measurement is genuinely running (rclone
    // gated), not merely scheduled: a mutation that lands before the
    // measurement starts is superseded by it, one that lands during it is not.
    await Bun.sleep(20);
    // A write lands while rclone is still running: its result predates the write.
    invalidateFolderSize(db, "folder-race");
    release();

    const body = await sizeOf(await inflight);
    expect(body.bytes).toBe(4096);
    expect(body.stale).toBe(true);
    // The explicit read schedules the follow-up refresh for the invalidated
    // bytes; the next read must report it as in-flight, not as current.
    const next = await sizeOf(await app.handle(request("/api/v1/folders/folder-race/size")));
    expect(next.refreshing).toBe(true);
    expect(next.stale).toBe(true);

    releaseFollowup();
    clearTimeout(timer);
    await __drainFolderRefreshes();
    // The follow-up began after the write, so its result is genuinely current.
    // Same-millisecond starts cost one extra refresh by design (the `>=`
    // convention in `measureFolderSize` never reports post-mutation bytes as
    // current), so poll until the read settles rather than assuming exactly
    // one follow-up ran.
    let done = await sizeOf(await app.handle(request("/api/v1/folders/folder-race/size")));
    for (let settle = 0; settle < 10 && (done.stale || done.refreshing); settle += 1) {
      await Bun.sleep(5);
      await __drainFolderRefreshes();
      done = await sizeOf(await app.handle(request("/api/v1/folders/folder-race/size")));
    }
    expect(done.bytes).toBe(4096);
    expect(done.stale).toBe(false);
    expect(done.refreshing).toBe(false);
  });

  test("refreshes for one backend are serialized", async () => {
    const backendId = insertBackendWithFolder("folder-same-a", "same-backend");
    db.run(
      "INSERT INTO folders (id, name, type, backend, backend_id, s3_bucket) VALUES ('folder-same-b', 'same-b', 'backup', 's3', ?, 'bucket')",
      [backendId],
    );
    insertAssignments("folder-same-a", [{ id: "sa1", hostId: "host-a" }]);
    insertAssignments("folder-same-b", [{ id: "sb1", hostId: "host-b" }]);
    const measurer = gatedMeasurer();

    const res = await app.handle(request("/api/v1/folders/sizes"));
    expect(res.status).toBe(200);
    // Both folders share a backend, so the per-backend limit (one) is what
    // binds here — the global limit of two is never reached.
    expect(__refreshState().active).toBe(1);
    expect(__refreshState().queued).toBe(1);
    expect(measurer.calls()).toBe(1);

    measurer.release();
    await __drainFolderRefreshes();
    expect(__refreshState()).toEqual({ active: 0, queued: 0, scheduled: 0 });
  });

  test("a folder measured twice in one millisecond counts once per backend", () => {
    const backendId = insertBackendWithFolder("folder-dupms", "dupms");
    const folder: Folder = {
      id: "folder-dupms",
      name: "dupms",
      type: "backup",
      backend: "s3",
      backendId,
      s3Bucket: "bucket",
    };
    const measuredAt = Date.now() - 60_000;
    // Two measurements of the same folder at the same timestamp (a forced
    // refresh overlapping a background one) must not double the destination.
    recordSizeHistory(db, folder, { folderId: folder.id, bytes: 300, objectCount: 3, error: null, measuredAt });
    recordSizeHistory(db, folder, { folderId: folder.id, bytes: 300, objectCount: 3, error: null, measuredAt });
    expect(getStorageHistory(db)[backendId]).toEqual([{ measuredAt, bytes: 300 }]);
  });

  test("storage history is bounded by window and daily downsampling", async () => {
    const backendId = insertBackendWithFolder("folder-window", "window");
    const now = Date.now();
    const startOfToday = Math.floor(now / DAY_MS) * DAY_MS;
    const point = (measuredAt: number, bytes: number): void => {
      db.run(
        "INSERT INTO size_history (scope, ref_id, bytes, object_count, measured_at) VALUES ('backend', ?, ?, 1, ?)",
        [backendId, bytes, measuredAt],
      );
    };
    point(Math.min(startOfToday + 1000, now - 1), 9); // earlier the same UTC day
    point(now, 10);
    point(now - 3 * DAY_MS, 8);
    point(now - 200 * DAY_MS, 7);

    const res = await app.handle(request("/api/v1/stats/storage/history"));
    const body = (await res.json()) as {
      backends: Record<string, Array<{ measuredAt: number; bytes: number }>>;
    };
    expect(body.backends[backendId]).toEqual([
      { measuredAt: now - 3 * DAY_MS, bytes: 8 },
      { measuredAt: now, bytes: 10 },
    ]);

    const raw = await app.handle(
      request("/api/v1/stats/storage/history?days=400&granularity=raw"),
    );
    const rawBody = (await raw.json()) as {
      backends: Record<string, Array<{ measuredAt: number; bytes: number }>>;
    };
    expect(rawBody.backends[backendId].map((p) => p.bytes)).toEqual([7, 8, 9, 10]);

    const badDays = await app.handle(request("/api/v1/stats/storage/history?days=0"));
    expect(badDays.status).toBe(400);
    const badGranularity = await app.handle(
      request("/api/v1/stats/storage/history?granularity=hour"),
    );
    expect(badGranularity.status).toBe(400);
  });

  test("?days is a strict positive integer; malformed values are a 400", async () => {
    // parseInt used to accept `1x` (as 1) and `1.5` (as 1); the docs promise a
    // 400 for invalid values, so the parser is strict about the whole string.
    for (const bad of ["1x", "1.5", "abc", "0", "-1", "1e3", "+7", "1,000"]) {
      const res = await app.handle(
        request(`/api/v1/stats/storage/history?days=${encodeURIComponent(bad)}`),
      );
      expect(res.status).toBe(400);
    }
    const ok = await app.handle(request("/api/v1/stats/storage/history?days=7"));
    expect(ok.status).toBe(200);
    const omitted = await app.handle(request("/api/v1/stats/storage/history"));
    expect(omitted.status).toBe(200);
  });

  test("?days above the documented max is clamped to 3650, not rejected", async () => {
    const backendId = insertS3BackendWithFolder();
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const point = (measuredAt: number, bytes: number): void => {
      db.run(
        "INSERT INTO size_history (scope, ref_id, bytes, object_count, measured_at) VALUES ('backend', ?, ?, 1, ?)",
        [backendId, bytes, measuredAt],
      );
    };
    point(now - 3600 * DAY, 11); // inside the 3650-day clamp
    point(now - 3660 * DAY, 12); // outside it
    const res = await app.handle(
      request("/api/v1/stats/storage/history?days=999999&granularity=raw"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      backends: Record<string, Array<{ bytes: number }>>;
    };
    expect(body.backends[backendId].map((p) => p.bytes)).toEqual([11]);
  });

  test("an invalidation survives a restart: persisted bytes stay stale until a later measurement supersedes it", async () => {
    insertBackendWithFolder("folder-restart", "restart");
    insertAssignments("folder-restart", [{ id: "rs1", hostId: "host-a" }]);
    const measuredAt = Date.now() - 60_000; // inside the TTL
    persistSize("folder-restart", 4096, measuredAt);
    invalidateFolderSize(db, "folder-restart");

    // Simulate a server restart: every in-memory structure is gone; only the
    // database survives. The persisted measurement is recent, but the durable
    // watermark is newer — it must be served stale, never fresh.
    __resetStatsCaches();
    const measurer = gatedMeasurer();
    const body = await sizeOf(await app.handle(request("/api/v1/folders/folder-restart/size")));
    expect(body.bytes).toBe(4096);
    expect(body.measuredAt).toBe(measuredAt);
    expect(body.stale).toBe(true);
    expect(body.refreshing).toBe(true);
    expect(__refreshState().scheduled).toBe(1);

    measurer.release();
    await __drainFolderRefreshes();
    // The successful measurement began after the invalidation, so it supersedes
    // the watermark: a second restart now serves the fresh bytes without work.
    __resetStatsCaches();
    const after = await sizeOf(await app.handle(request("/api/v1/folders/folder-restart/size")));
    expect(after.bytes).toBe(1000);
    expect(after.stale).toBe(false);
    expect(after.refreshing).toBe(false);
    expect(__refreshState().scheduled).toBe(0);
    const watermarks = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM folder_size_invalidations WHERE folder_id = 'folder-restart'",
      )
      .get();
    expect(watermarks?.c).toBe(0);
  });

  test("a failed refresh does not supersede the durable invalidation watermark", async () => {
    insertBackendWithFolder("folder-fail-inval", "fail-inval");
    insertAssignments("folder-fail-inval", [{ id: "fi1", hostId: "host-a" }]);
    persistSize("folder-fail-inval", 128, Date.now() - 60_000);
    invalidateFolderSize(db, "folder-fail-inval");
    __setSizeMeasurer(async () => ({ bytes: 0, objectCount: null, error: "boom" }));

    const first = await sizeOf(await app.handle(request("/api/v1/folders/folder-fail-inval/size")));
    expect(first.bytes).toBe(128);
    await __drainFolderRefreshes();

    // The attempt began after the invalidation but did not produce current
    // bytes: the watermark must remain so a restart keeps serving the
    // persisted value as stale.
    const watermarks = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM folder_size_invalidations WHERE folder_id = 'folder-fail-inval'",
      )
      .get();
    expect(watermarks?.c).toBe(1);

    __resetStatsCaches();
    let calls = 0;
    __setSizeMeasurer(async () => {
      calls += 1;
      return { bytes: 5, objectCount: 1, error: null };
    });
    const second = await sizeOf(await app.handle(request("/api/v1/folders/folder-fail-inval/size")));
    expect(second.bytes).toBe(128);
    expect(second.stale).toBe(true);
    expect(second.refreshing).toBe(true);
    await __drainFolderRefreshes();
    expect(calls).toBe(1);
  });

  test("concurrent explicit refresh=true calls share one measurement (dedupe)", async () => {
    insertBackendWithFolder("folder-rr", "rr");
    insertAssignments("folder-rr", [{ id: "rr1", hostId: "host-a" }]);
    persistSize("folder-rr", 10, Date.now() - 2 * DAY_MS);
    const measurer = gatedMeasurer();

    // Five simultaneous explicit refreshes: one measurement runs, the other
    // four await the same task instead of spawning parallel rclone work.
    const pending = Array.from({ length: 5 }, () =>
      app.handle(request("/api/v1/folders/folder-rr/size?refresh=true")),
    );
    await Bun.sleep(20);
    expect(measurer.calls()).toBe(1);
    expect(__refreshState().scheduled).toBe(1);
    expect(__refreshState().active).toBe(1);

    measurer.release();
    const responses = await Promise.all(pending);
    const bodies = await Promise.all(responses.map(sizeOf));
    for (const body of bodies) {
      expect(body.bytes).toBe(1000);
      expect(body.stale).toBe(false);
      expect(body.refreshing).toBe(false);
    }
    expect(measurer.calls()).toBe(1);
    expect(__refreshState()).toEqual({ active: 0, queued: 0, scheduled: 0 });
  });

  test("explicit refreshes still honor the per-backend bound", async () => {
    insertBackendWithFolder("folder-eb-a", "eb");
    db.run(
      "INSERT INTO folders (id, name, type, backend, backend_id, s3_bucket) VALUES ('folder-eb-b', 'eb-b', 'backup', 's3', (SELECT id FROM backends WHERE name = 'eb'), 'bucket')",
    );
    insertAssignments("folder-eb-a", [{ id: "eb1", hostId: "host-a" }]);
    insertAssignments("folder-eb-b", [{ id: "eb2", hostId: "host-b" }]);
    const measurer = gatedMeasurer();

    const pending = [
      app.handle(request("/api/v1/folders/folder-eb-a/size?refresh=true")),
      app.handle(request("/api/v1/folders/folder-eb-b/size?refresh=true")),
 ];
    await Bun.sleep(20);
    // Both explicit refreshes are scheduled, but the shared backend allows
    // only one measurement at a time — the second waits its turn.
    expect(__refreshState().scheduled).toBe(2);
    expect(__refreshState().active).toBe(1);
    expect(__refreshState().queued).toBe(1);
    expect(measurer.calls()).toBe(1);

    measurer.release();
    await Promise.all(pending);
    await __drainFolderRefreshes();
    expect(measurer.calls()).toBe(2);
    expect(__refreshState()).toEqual({ active: 0, queued: 0, scheduled: 0 });
  });
});
