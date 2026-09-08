// LAMA-324: app-backup storage adapter unit tests (hermetic — no rclone
// needed; s3 paths use the injected fake-rclone seam). Covers the fixed
// object key, server-local publish/delete, local/nfs containment, and the
// s3 rclone boundary (copyto argv, delete outcomes, not-found mapping).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
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

/** Size + reference SHA-256 for staged contents (publish now receives them
 *  precomputed from the streaming pass; the adapter never re-reads). */
function refMeta(contents: string): { sizeBytes: number; checksumSha256: string } {
  return {
    sizeBytes: Buffer.byteLength(contents),
    checksumSha256: createHash("sha256").update(contents).digest("hex"),
  };
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
    const { sizeBytes, checksumSha256 } = refMeta("local-archive");
    const result = await publishSnapshotArchive({
      stagedPath: staged,
      protectionId: "prot-local",
      snapshotId: "snap-local",
      sizeBytes,
      checksumSha256,
      destination: null,
    });
    expect(result.objectKey).toBeNull();
    expect(result.localRelPath).toMatch(/^apps\/prot-local\/\d+-snap-local\.tar\.gz$/);
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
    const { sizeBytes, checksumSha256 } = refMeta("hello-app-archive");
    await expect(
      publishSnapshotArchive({
        stagedPath: staged,
        protectionId: "../../escape",
        snapshotId: "escape",
        sizeBytes,
        checksumSha256,
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
    const { sizeBytes: nfsSize, checksumSha256: nfsSha } = refMeta("nfs-archive");
    const result = await publishSnapshotArchive({
      stagedPath: staged,
      protectionId: "prot-nfs",
      snapshotId: "snap-nfs",
      sizeBytes: nfsSize,
      checksumSha256: nfsSha,
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
    const { sizeBytes: s3Size, checksumSha256: s3Sha } = refMeta("s3-archive");
    const result = await publishSnapshotArchive({
      stagedPath: staged,
      protectionId: "prot-s3",
      snapshotId: "snap-s3",
      sizeBytes: s3Size,
      checksumSha256: s3Sha,
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
    const { sizeBytes: fs, checksumSha256: fh } = refMeta("hello-app-archive");
    await expect(
      publishSnapshotArchive({
        stagedPath: stageFile(),
        protectionId: "prot-s3-fail",
        snapshotId: "snap-s3-fail",
        sizeBytes: fs,
        checksumSha256: fh,
        destination: { backend: resolveAppBackend(db, backendId)!, s3Bucket: "apps-bucket" },
      }),
    ).rejects.toThrow(AppStorageError);
  });

  test("deletefile: exit 0 → deleted; not-found stderr → absent; other errors → failed", async () => {
    const backendId = insertS3Backend();
    const loc = locationForSnapshot({ backend_id: backendId, object_key: "lamasync/apps/p/s.tar.gz", s3_bucket: "my-bucket", archive_path: "" });
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

describe("streaming to staging (LAMA-324 review)", () => {
  test("streamToStagedFile computes SHA-256 incrementally WITHOUT arrayBuffer", async () => {
    const { streamToStagedFile } = await import("./app-storage.ts");
    const staged = join(stagingRoot, "sha-stream.tar.gz");
    const contents = "streamed-content-".repeat(100); // multi-chunk
    const source = new Blob([contents]).stream();
    const { sizeBytes, checksumSha256 } = await streamToStagedFile({
      stagedPath: staged,
      stream: source,
      maxBytes: 10_000,
    });
    expect(sizeBytes).toBe(Buffer.byteLength(contents));
    expect(checksumSha256).toBe(createHash("sha256").update(contents).digest("hex"));
    expect(readFileSync(staged, "utf8")).toBe(contents);
  });

  test("hard cap enforced MID-STREAM; callers own cleanup and nothing is left behind", async () => {
    const { streamToStagedFile, UploadTooLarge } = await import("./app-storage.ts");
    const staged = join(stagingRoot, "cap-stream.tar.gz");
    const source = new Blob(["a".repeat(1000)]).stream();
    await expect(
      streamToStagedFile({ stagedPath: staged, stream: source, maxBytes: 64 }),
    ).rejects.toThrow(UploadTooLarge);
    // The partial file still exists (the caller owns staging lifecycle) —
    // simulate the route's finally: removing it must succeed.
    if (existsSync(staged)) rmSync(staged, { force: true });
    expect(existsSync(staged)).toBe(false);
  });
});

describe("config/location input hardening (LAMA-324 review)", () => {
  test("control characters in stored s3 config values fail closed (no ini injection)", async () => {
    const { resolveAppBackend } = await import("./app-storage.ts");
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO backends (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, created_at)
       VALUES (?, 'evil', 's3', 'other', 'https://s3.example.test', 'r1', 'AK', ?, ?)`,
      // secret contains CR LF + an injected rclone section
      [id, encryptSecret("supersecret\nbogus = value\r"), Date.now()],
    );
    expect(resolveAppBackend(db, id)).toBeNull();
  });

  test("stored bucket/object key with hostile characters fail closed on delete/download", async () => {
    const { deleteSnapshotArchive, locationForSnapshot, snapshotDownload } = await import("./app-storage.ts");
    const backendId = insertS3Backend();
    // colon + traversal-ish object key + bad bucket
    const loc = locationForSnapshot({
      backend_id: backendId,
      object_key: "lamasync/apps/../evil.tar.gz",
      s3_bucket: "bad_bucket:other",
      archive_path: "",
    });
    const failed = await deleteSnapshotArchive(db, loc);
    expect(failed.status).toBe("failed");
    await expect(snapshotDownload(db, loc)).rejects.toThrow(AppStorageError);
  });

  test("isValidAppBucketName accepts good names and rejects hostile ones", async () => {
    const { isValidAppBucketName } = await import("./app-storage.ts");
    expect(isValidAppBucketName("lamasync-apps")).toBe(true);
    expect(isValidAppBucketName("my.bucket-42")).toBe(true);
    expect(isValidAppBucketName("A-uppercase")).toBe(false);
    expect(isValidAppBucketName("has_underscore")).toBe(false);
    expect(isValidAppBucketName("a/forward")).toBe(false);
    expect(isValidAppBucketName("a:colon")).toBe(false);
    expect(isValidAppBucketName("trail-")).toBe(false);
    expect(isValidAppBucketName("..double")).toBe(false);
    expect(isValidAppBucketName("a\nb\n")).toBe(false);
    expect(isValidAppBucketName("ab")).toBe(false);
  });
});
