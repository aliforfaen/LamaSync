// LAMA-324: app-backup storage adapter unit tests (hermetic — no rclone
// needed; s3 paths use the injected fake-rclone seam). Covers the fixed
// object key, server-local publish/delete, local/nfs containment, and the
// s3 rclone boundary (copyto argv, delete outcomes, not-found mapping).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "app-storage-test-secret-key-0001";
process.env.LAMASYNC_BACKUP_DIR = process.env.LAMASYNC_BACKUP_DIR ?? "/tmp/lamasync-app-storage-test";
process.env.LAMASYNC_APPS_STAGING_DIR = process.env.LAMASYNC_APPS_STAGING_DIR ?? "/tmp/lamasync-app-storage-staging";

const { encryptSecret } = await import("./crypto.ts");
const {
  __setRcloneExecForTest,
  appObjectKey,
  AppStorageError,
  deleteSnapshotArchive,
  locationForSnapshot,
  publishSnapshotArchive,
  resolveAppBackend,
  snapshotDownload,
} = await import("./app-storage.ts");

let db: Database;
let testRoot: string;
let stagingRoot: string;
let nextFile: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // idempotent
    }
  }
  testRoot = join(tmpdir(), `lamasync-app-storage-${crypto.randomUUID()}`);
  stagingRoot = join(testRoot, "staging");
  mkdirSync(stagingRoot, { recursive: true });
  process.env.LAMASYNC_BACKUP_DIR = join(testRoot, "backups");
  process.env.LAMASYNC_APPS_STAGING_DIR = stagingRoot;
  nextFile = 0;
  __setRcloneExecForTest(null);
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  db.close();
});

function stageFile(contents = "hello-app-archive"): string {
  const path = join(stagingRoot, `stage-${nextFile++}.tar.gz`);
  writeFileSync(path, contents);
  return path;
}

function insertS3Backend(opts: { name?: string; secret?: string } = {}): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO backends (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, created_at)
     VALUES (?, ?, 's3', 'other', 'https://s3.example.test', 'region-1', 'AK', ?, ?)`,
    [id, opts.name ?? "test-s3", encryptSecret(opts.secret ?? "supersecret"), Date.now()],
  );
  return id;
}

function insertLocalBackend(path: string, kind: "local" | "nfs" = "local"): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO backends (id, name, kind, local_path, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, `test-${kind}`, kind, path, Date.now()],
  );
  return id;
}

describe("app object key (LAMA-324)", () => {
  test("fixed layout lamasync/apps/<protectionId>/<snapshotId>.tar.gz", () => {
    expect(appObjectKey("prot-1", "snap-2")).toBe("lamasync/apps/prot-1/snap-2.tar.gz");
    expect(appObjectKey("prot-1", "snap-2")).not.toContain("..");
  });
});

describe("server-local publish + delete (LAMA-324)", () => {
  test("publish renames staged file under backups/apps/..., records size + sha256", async () => {
    const staged = stageFile("local-archive");
    const result = await publishSnapshotArchive({
      stagedPath: staged,
      protectionId: "prot-local",
      snapshotId: "snap-local",
      destination: null,
    });
    expect(result.objectKey).toBeNull();
    expect(result.localRelPath).toMatch(/^apps\/prot-local\/\d+-snap-local\.tar\.gz$/);
    expect(result.sizeBytes).toBe(13);
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    const full = join(process.env.LAMASYNC_BACKUP_DIR!, result.localRelPath!);
    expect(readFileSync(full, "utf8")).toBe("local-archive");
    // staged file is consumed by rename
    expect(existsSync(staged)).toBe(false);

    // download dispatch reads the stored location
    const download = await snapshotDownload(
      db,
      locationForSnapshot({ backend_id: null, object_key: null, s3_bucket: null, archive_path: result.localRelPath! }),
    );
    expect(download.kind).toBe("file");
    if (download.kind === "file") {
      expect(readFileSync(download.absPath, "utf8")).toBe("local-archive");
    }

    const deleted = await deleteSnapshotArchive(
      db,
      locationForSnapshot({ backend_id: null, object_key: null, s3_bucket: null, archive_path: result.localRelPath! }),
    );
    expect(deleted.status).toBe("deleted");
    const absent = await deleteSnapshotArchive(
      db,
      locationForSnapshot({ backend_id: null, object_key: null, s3_bucket: null, archive_path: result.localRelPath! }),
    );
    expect(absent.status).toBe("absent");
  });

  test("publish refuses paths escaping the backup root", async () => {
    const staged = stageFile();
    await expect(
      publishSnapshotArchive({
        stagedPath: staged,
        protectionId: "../../escape",
        snapshotId: "escape",
        destination: null,
      }),
    ).rejects.toThrow(AppStorageError);
  });
});

describe("local/nfs backend publish + delete (LAMA-324)", () => {
  test("publish writes the fixed key under the backend path; delete removes it", async () => {
    const localPath = join(testRoot, "nfs-export");
    const backendId = insertLocalBackend(localPath, "nfs");
    const staged = stageFile("nfs-archive");
    const result = await publishSnapshotArchive({
      stagedPath: staged,
      protectionId: "prot-nfs",
      snapshotId: "snap-nfs",
      destination: { backend: resolveAppBackend(db, backendId)!, s3Bucket: "" },
    });
    expect(result.objectKey).toBe("lamasync/apps/prot-nfs/snap-nfs.tar.gz");
    const full = join(localPath, result.objectKey!);
    expect(readFileSync(full, "utf8")).toBe("nfs-archive");
    // staged remains for backend publishes (caller cleans it)
    expect(existsSync(staged)).toBe(true);

    const loc = locationForSnapshot({ backend_id: backendId, object_key: result.objectKey, s3_bucket: null, archive_path: "" });
    const download = await snapshotDownload(db, loc);
    expect(download.kind).toBe("file");
    if (download.kind === "file") expect(readFileSync(download.absPath, "utf8")).toBe("nfs-archive");

    expect((await deleteSnapshotArchive(db, loc)).status).toBe("deleted");
    expect((await deleteSnapshotArchive(db, loc)).status).toBe("absent");
  });
});

describe("s3 backend relay via fake rclone (LAMA-324)", () => {
  test("copyto uses the fixed key; delete dispatches to the same object", async () => {
    const backendId = insertS3Backend();
    const calls: string[][] = [];
    __setRcloneExecForTest(async (argv) => {
      calls.push(argv);
      if (argv.includes("copyto")) return { code: 0, stdout: "", stderr: "" };
      if (argv.includes("cat")) return { code: 0, stdout: "s3-archive", stderr: "" };
      if (argv.includes("deletefile")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const staged = stageFile("s3-archive");
    const result = await publishSnapshotArchive({
      stagedPath: staged,
      protectionId: "prot-s3",
      snapshotId: "snap-s3",
      destination: { backend: resolveAppBackend(db, backendId)!, s3Bucket: "apps-bucket" },
    });
    expect(result.objectKey).toBe("lamasync/apps/prot-s3/snap-s3.tar.gz");
    expect(calls[0]).toContain("copyto");
    const copyTo = calls[0]!.find((a) => a.startsWith("relay:"));
    expect(copyTo).toBe("relay:apps-bucket/lamasync/apps/prot-s3/snap-s3.tar.gz");

    const loc = locationForSnapshot({ backend_id: backendId, object_key: result.objectKey, s3_bucket: "apps-bucket", archive_path: "" });
    const dl = await snapshotDownload(db, loc);
    expect(dl.kind).toBe("stream");
    if (dl.kind === "stream") {
      expect(await new Response(dl.stream).text()).toBe("s3-archive");
      expect((await dl.run).code).toBe(0);
    }

    expect((await deleteSnapshotArchive(db, loc)).status).toBe("deleted");
    const delCall = calls.find((a) => a.includes("deletefile"))!;
    expect(delCall.find((a) => a.startsWith("relay:"))).toBe("relay:apps-bucket/lamasync/apps/prot-s3/snap-s3.tar.gz");
  });

  test("relay failure surfaces as AppStorageError (no snapshot row written by adapter)", async () => {
    const backendId = insertS3Backend();
    __setRcloneExecForTest(async () => ({ code: 1, stdout: "", stderr: "AccessDenied: denied\n" }));
    await expect(
      publishSnapshotArchive({
        stagedPath: stageFile(),
        protectionId: "prot-s3-fail",
        snapshotId: "snap-s3-fail",
        destination: { backend: resolveAppBackend(db, backendId)!, s3Bucket: "apps-bucket" },
      }),
    ).rejects.toThrow(AppStorageError);
  });

  test("deletefile: exit 0 → deleted; not-found stderr → absent; other errors → failed", async () => {
    const backendId = insertS3Backend();
    const loc = locationForSnapshot({ backend_id: backendId, object_key: "lamasync/apps/p/s.tar.gz", s3_bucket: "b", archive_path: "" });
    __setRcloneExecForTest(async () => ({ code: 1, stdout: "", stderr: "object does not exist" }));
    expect((await deleteSnapshotArchive(db, loc)).status).toBe("absent");
    __setRcloneExecForTest(async () => ({ code: 1, stdout: "", stderr: "network timeout" }));
    const failed = await deleteSnapshotArchive(db, loc);
    expect(failed.status).toBe("failed");
    __setRcloneExecForTest(async () => ({ code: 0, stdout: "", stderr: "" }));
    expect((await deleteSnapshotArchive(db, loc)).status).toBe("deleted");
  });

  test("missing/invalid/restic backends fail closed for deletes (never silent)", async () => {
    const loc = locationForSnapshot({ backend_id: "does-not-exist", object_key: "lamasync/apps/p/s.tar.gz", s3_bucket: "b", archive_path: "" });
    const failed = await deleteSnapshotArchive(db, loc);
    expect(failed.status).toBe("failed");

    const resticId = crypto.randomUUID();
    db.run(
      `INSERT INTO backends (id, name, kind, restic_repository, restic_password_enc, created_at)
       VALUES (?, 'test-restic', 'restic', 'repo:test', 'enc', ?)`,
      [resticId, Date.now()],
    );
    const resticLoc = locationForSnapshot({ backend_id: resticId, object_key: "lamasync/apps/p/s.tar.gz", s3_bucket: null, archive_path: "" });
    const failedRestic = await deleteSnapshotArchive(db, resticLoc);
    expect(failedRestic.status).toBe("failed");
  });
});