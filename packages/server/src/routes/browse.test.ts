import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { initDb } from "@lamasync/core";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseRoutes, __setDb, __setListS3Impl } from "./browse.ts";
import { S3ListObjectsError } from "../s3-list.ts";
import type { S3Listing } from "../s3-list.ts";

let db: Database;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lamasync-browse-route-"));
  process.env.LAMASYNC_BACKUP_DIR = dataDir;
  db = initDb(join(dataDir, "test.db"));
  __setDb(db);
  __setListS3Impl(async () => ({ entries: [] }));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeS3Folder(name: string, id: string): void {
  db.run(
    "INSERT INTO folders (id, name, type, backend, s3_endpoint, s3_bucket, s3_access_key_id, s3_secret_access_key, s3_region) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, name, "backup", "s3", "s3.example.com", "bucket", "KEY", "SECRET", "us-east-1"],
  );
}

describe("GET /api/v1/browse/local", () => {
  test("lists root with folder ownership", async () => {
    db.run("INSERT INTO folders (id, name, type, backend) VALUES (?, ?, ?, ?)", [
      "folder-1",
      "Photos",
      "backup",
      "sftp",
    ]);
    mkdirSync(join(dataDir, "Photos"));
    mkdirSync(join(dataDir, "Other"));
    writeFileSync(join(dataDir, "readme.txt"), "hello");

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(new Request("http://localhost/api/v1/browse/local"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backend: string; path: string; entries: Array<{ name: string; type: string; folderId?: string }> };
    expect(body.backend).toBe("local");
    expect(body.path).toBe("");

    const photos = body.entries.find((e) => e.name === "Photos");
    expect(photos?.type).toBe("dir");
    expect(photos?.folderId).toBe("folder-1");

    const other = body.entries.find((e) => e.name === "Other");
    expect(other?.folderId).toBeUndefined();

    const readme = body.entries.find((e) => e.name === "readme.txt");
    expect(readme?.type).toBe("file");
  });

  test("descends into a subdirectory", async () => {
    mkdirSync(join(dataDir, "a", "b"), { recursive: true });
    writeFileSync(join(dataDir, "a", "b", "nested.txt"), "x");

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/local?path=a/b"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ name: string; type: string }> };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ name: "nested.txt", type: "file" });
  });

  test("rejects traversal", async () => {
    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/local?path=../etc"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid path" });
  });

  test("rejects absolute paths", async () => {
    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/local?path=/etc/passwd"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid path" });
  });

  test("returns 404 for a well-formed but non-existent path", async () => {
    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/local?path=missing-dir"),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "path not found" });
  });

  test("returns 400 sanitized for a file path (no ENOTDIR leak)", async () => {
    mkdirSync(join(dataDir, "folder"));
    writeFileSync(join(dataDir, "folder", "hello.txt"), "hi");

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/local?path=folder/hello.txt"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "path is not a directory" });
  });

  test("returns 400 sanitized when a path segment is a file", async () => {
    mkdirSync(join(dataDir, "folder"));
    writeFileSync(join(dataDir, "folder", "hello.txt"), "hi");

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/local?path=folder/hello.txt/sub"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "path is not a directory" });
  });
});

describe("GET /api/v1/browse/s3", () => {
  test("returns 404 for unknown folder", async () => {
    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/s3?folderId=missing"),
    );
    expect(res.status).toBe(404);
  });

  test("returns 400 for non-s3 folder", async () => {
    db.run("INSERT INTO folders (id, name, type, backend) VALUES (?, ?, ?, ?)", [
      "folder-1",
      "LocalFolder",
      "backup",
      "sftp",
    ]);
    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/s3?folderId=folder-1"),
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 for missing credentials", async () => {
    db.run("INSERT INTO folders (id, name, type, backend, s3_endpoint, s3_bucket) VALUES (?, ?, ?, ?, ?, ?)", [
      "folder-1",
      "BadS3",
      "backup",
      "s3",
      "s3.example.com",
      "bucket",
    ]);
    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/s3?folderId=folder-1"),
    );
    expect(res.status).toBe(400);
  });

  test("happy path maps S3 entries to BrowseResponse", async () => {
    makeS3Folder("Vault", "folder-1");
    const mockListing: S3Listing = {
      entries: [
        { name: "file.txt", type: "file", size: 12, lastModified: 1700000000000 },
        { name: "archive", type: "dir", size: 0, lastModified: 0 },
      ],
    };
    __setListS3Impl(async () => mockListing);

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/s3?folderId=folder-1&path=backups/"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backend: string; entries: Array<{ name: string; type: string; folderId: string }> };
    expect(body.backend).toBe("s3");
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].folderId).toBe("folder-1");
  });

  test("502 when S3 listing fails", async () => {
    makeS3Folder("Vault", "folder-1");
    __setListS3Impl(async () => {
      throw new S3ListObjectsError("network unreachable", new TypeError("fetch failed"));
    });

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/s3?folderId=folder-1"),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("S3 request failed");
  });
});

describe("GET /api/v1/browse/restic", () => {
  test("returns snapshots from the database", async () => {
    db.run(
      "INSERT INTO restic_snapshots (id, folder_id, host_id, snapshot_id, timestamp, paths, size_bytes, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "snap-1",
        "folder-1",
        "host-1",
        "abc123",
        1700000000000,
        JSON.stringify(["/tmp/a"]),
        1024,
        JSON.stringify(["lamasync"]),
      ],
    );

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(new Request("http://localhost/api/v1/browse/restic"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ snapshotId: string; paths: string[] }>;
    expect(body).toHaveLength(1);
    expect(body[0].snapshotId).toBe("abc123");
    expect(body[0].paths).toEqual(["/tmp/a"]);
  });
});
