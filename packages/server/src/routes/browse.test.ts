import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { initDb } from "@lamasync/core";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseRoutes, __setDb, __setListS3Impl } from "./browse.ts";
import { S3ListObjectsError, __setDefaultS3Fetch } from "../s3-list.ts";
import type { S3Listing } from "../s3-list.ts";
import { encryptSecret } from "../crypto.ts";
import { __resetBrowseJobsForTests } from "../browse-jobs.ts";

process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "browse-test-secret-key-0123456789abcdef";

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
  __resetBrowseJobsForTests();
  __setDefaultS3Fetch(globalThis.fetch);
  rmSync(dataDir, { recursive: true, force: true });
});

function makeS3Folder(name: string, id: string): void {
  const backendId = crypto.randomUUID();
  // LAMA-222: credentials live on the Backend row; the folder references it.
  db.run(
    "INSERT INTO backends (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, created_at) VALUES (?, ?, 's3', 'other', 's3.example.com', 'us-east-1', 'KEY', ?, ?)",
    [backendId, `${name}-backend`, encryptSecret("SECRET"), Date.now()],
  );
  db.run(
    "INSERT INTO folders (id, name, type, backend, backend_id, s3_bucket) VALUES (?, ?, ?, ?, ?, ?)",
    [id, name, "backup", "s3", backendId, "bucket"],
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

describe("POST /api/v1/browse/download", () => {
  test("round-trips a local file's bytes", async () => {
    mkdirSync(join(dataDir, "docs"));
    const original = Buffer.from([0, 1, 2, 254, 255, 10, 13, 0, 65]);
    writeFileSync(join(dataDir, "docs", "blob.bin"), original);

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: { kind: "local", path: "docs" }, name: "blob.bin" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; content: string };
    expect(body.name).toBe("blob.bin");
    expect(Buffer.from(body.content, "base64")).toEqual(original);
  });

  test("rejects directories", async () => {
    mkdirSync(join(dataDir, "docs"));
    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: { kind: "local", path: "" }, name: "docs" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cannot download a directory");
  });

  test("returns 404 for a missing entry", async () => {
    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: { kind: "local", path: "" }, name: "nope.txt" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("rejects traversal names", async () => {
    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: { kind: "local", path: "" }, name: "../etc/passwd" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("download failed");
  });

  test("over-cap file names the 64 MiB limit", async () => {
    // 64 MiB + 1 byte — slightly over so the cap check trips.
    const big = Buffer.alloc(64 * 1024 * 1024 + 1, 0x61);
    writeFileSync(join(dataDir, "big.bin"), big);

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: { kind: "local", path: "" }, name: "big.bin" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("64 MiB");
  });

  test("refuses a symlink that escapes the backup root", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "lamasync-outside-"));
    writeFileSync(join(outsideDir, "secret.txt"), "top secret");
    symlinkSync(join(outsideDir, "secret.txt"), join(dataDir, "escape.txt"));

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: { kind: "local", path: "" }, name: "escape.txt" }),
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("entry not found");

    rmSync(outsideDir, { recursive: true, force: true });
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

  test("returns 400 for unresolvable backend", async () => {
    // Folder claims s3 but the referenced backend does not exist.
    db.run(
      "INSERT INTO folders (id, name, type, backend, backend_id, s3_bucket) VALUES (?, ?, ?, ?, ?, ?)",
      ["folder-1", "BadS3", "backup", "s3", "no-such-backend", "bucket"],
    );
    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/s3?folderId=folder-1"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no resolvable S3 backend");
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

// LAMA-321: freedesktop trash detection + on-demand recursive size.
function trashOf(body: unknown): Array<{ uid: number; prefix: string }> {
  const asRecord = body as { trash?: Array<{ uid: number; prefix: string }> };
  return asRecord.trash ?? [];
}

function addConfiguredLocalDestination(path: string): void {
  db.run("INSERT INTO hosts (id, hostname) VALUES ('trash-host', 'trash-host')");
  db.run(
    "INSERT INTO folders (id, name, type, backend) VALUES ('trash-folder', 'trash-folder', 'sync', 'sftp')",
  );
  db.run(
    `INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path, destination)
     VALUES ('trash-assignment', 'trash-folder', 'trash-host', 'both', '/tmp/trash', ?)`,
    [path],
  );
}

async function waitTerminalJob(id: string, timeoutMs = 15000): Promise<{
  status: string;
  error: string | null;
}> {
  const start = Date.now();
  for (;;) {
    const row = db
      .query<{ status: string; error: string | null }, [string]>(
        "SELECT status, error FROM browse_jobs WHERE id = ?",
      )
      .get(id);
    if (row && (row.status === "done" || row.status === "failed" || row.status === "cancelled")) {
      return { status: row.status, error: row.error };
    }
    if (Date.now() - start > timeoutMs) throw new Error("job did not reach a terminal state in time");
    await Bun.sleep(50);
  }
}

describe("LAMA-321 GET /api/v1/browse/local trash detection", () => {
  test("flags a root-level .Trash-1000 directory", async () => {
    mkdirSync(join(dataDir, ".Trash-1000", "files"), { recursive: true });
    mkdirSync(join(dataDir, ".Trash-1000", "info"), { recursive: true });
    mkdirSync(join(dataDir, "work"));

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(new Request("http://localhost/api/v1/browse/local"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trash?: Array<{ uid: number; prefix: string }> };
    expect(body.trash).toEqual([{ uid: 1000, prefix: ".Trash-1000" }]);
  });

  test("detects the nested .Trash/<uid> layout", async () => {
    mkdirSync(join(dataDir, ".Trash", "1000", "files"), { recursive: true });
    mkdirSync(join(dataDir, ".Trash", "2000", "files"), { recursive: true });

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(new Request("http://localhost/api/v1/browse/local"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trash?: Array<{ uid: number; prefix: string }> };
    expect(body.trash).toEqual([
      { uid: 1000, prefix: ".Trash/1000" },
      { uid: 2000, prefix: ".Trash/2000" },
    ]);
  });

  test("ignores lookalikes and invalid .Trash layouts", async () => {
    mkdirSync(join(dataDir, ".Trash-1000x"));
    mkdirSync(join(dataDir, ".Trash1000"));
    mkdirSync(join(dataDir, ".trash-1000"));
    mkdirSync(join(dataDir, ".Trash", "1000x"), { recursive: true });
    writeFileSync(join(dataDir, ".Trash-1001"), "a file, not a dir");
    mkdirSync(join(dataDir, ".Trash", "files"), { recursive: true }); // non-numeric child only

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(new Request("http://localhost/api/v1/browse/local"));
    expect(res.status).toBe(200);
    expect(trashOf(await res.json())).toEqual([]);
  });

  test("detects trash inside a subdirectory listing", async () => {
    addConfiguredLocalDestination("mounts/bucket");
    mkdirSync(join(dataDir, "mounts", "bucket", ".Trash-1000", "files"), {
      recursive: true,
    });
    mkdirSync(join(dataDir, "mounts", "bucket", "keep"));

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/local?path=mounts/bucket"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; trash?: Array<{ uid: number; prefix: string }> };
    expect(body.path).toBe("mounts/bucket");
    expect(body.trash).toEqual([{ uid: 1000, prefix: ".Trash-1000" }]);
  });

  test("does not label a matching directory outside a configured destination root", async () => {
    mkdirSync(join(dataDir, "project", ".Trash-1000", "files"), {
      recursive: true,
    });

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/local?path=project"),
    );
    expect(res.status).toBe(200);
    expect(trashOf(await res.json())).toEqual([]);
  });
});

describe("LAMA-321 GET /api/v1/browse/s3 trash detection", () => {
  test("flags .Trash-1000 and .Trash/<uid> from the listing + peek", async () => {
    makeS3Folder("Vault", "folder-1");
    __setListS3Impl(async (_s3, prefix) => {
      if (prefix === ".Trash/") {
        const listing: S3Listing = {
          entries: [
            { name: "1000", type: "dir", size: 0, lastModified: 0 },
            { name: "2000", type: "dir", size: 0, lastModified: 0 },
            { name: "note.txt", type: "file", size: 3, lastModified: 0 },
          ],
        };
        return listing;
      }
      const listing: S3Listing = {
        entries: [
          { name: ".Trash-1000", type: "dir", size: 0, lastModified: 0 },
          { name: ".Trash", type: "dir", size: 0, lastModified: 0 },
          { name: ".Trash-1000x", type: "dir", size: 0, lastModified: 0 },
          { name: ".Trash1000", type: "dir", size: 0, lastModified: 0 },
          { name: "work", type: "dir", size: 0, lastModified: 0 },
        ],
      };
      return listing;
    });

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/s3?folderId=folder-1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { trash?: Array<{ uid: number; prefix: string }> };
    expect(body.trash).toEqual([
      { uid: 1000, prefix: ".Trash-1000" },
      { uid: 1000, prefix: ".Trash/1000" },
      { uid: 2000, prefix: ".Trash/2000" },
    ]);
  });

  test("ignores .Trash whose peek returns no numeric dir children", async () => {
    makeS3Folder("Vault", "folder-1");
    __setListS3Impl(async () => {
      const listing: S3Listing = {
        entries: [
          { name: ".Trash", type: "dir", size: 0, lastModified: 0 },
          { name: "keep", type: "dir", size: 0, lastModified: 0 },
        ],
      };
      return listing;
    });

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/s3?folderId=folder-1"),
    );
    expect(res.status).toBe(200);
    expect(trashOf(await res.json())).toEqual([]);
  });

  test("a failed .Trash peek drops only the annotation, never the listing", async () => {
    makeS3Folder("Vault", "folder-1");
    __setListS3Impl(async (_s3, prefix) => {
      if (prefix === ".Trash/") {
        throw new S3ListObjectsError("peek exploded", new Error("boom"));
      }
      const listing: S3Listing = {
        entries: [
          { name: ".Trash", type: "dir", size: 0, lastModified: 0 },
          { name: "keep", type: "dir", size: 0, lastModified: 0 },
        ],
      };
      return listing;
    });

    const app = new Elysia().use(browseRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/browse/s3?folderId=folder-1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ name: string }>; trash?: unknown };
    expect(body.entries).toHaveLength(2);
    expect(body.trash).toBeUndefined();
  });
});

describe("LAMA-321 size jobs over the API", () => {
  function postJson(path: string, body: unknown): Promise<Response> {
    const app = new Elysia().use(browseRoutes);
    return Promise.resolve(
      app.handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );
  }

  test("local size job: measures a tree, caches it, merges into the listing", async () => {
    addConfiguredLocalDestination("work");
    mkdirSync(join(dataDir, "work", ".Trash-1000", "files"), { recursive: true });
    writeFileSync(join(dataDir, "work", ".Trash-1000", "files", "a.txt"), "12345");
    writeFileSync(join(dataDir, "work", ".Trash-1000", "files", "b.bin"), Buffer.alloc(10, 7));
    writeFileSync(join(dataDir, "work", "keep.txt"), "x");

    const startRes = await postJson("/api/v1/browse/size", {
      ref: { kind: "local", path: "work" },
      prefix: ".Trash-1000",
    });
    expect(startRes.status).toBe(201);
    const job = (await startRes.json()) as { id: string; operation: string };
    expect(job.operation).toBe("size");

    const terminal = await waitTerminalJob(job.id);
    expect(terminal.status).toBe("done");

    // Cached read reports object count, bytes, calculated-at.
    const readRes = await new Elysia()
      .use(browseRoutes)
      .handle(
        new Request(
          "http://localhost/api/v1/browse/size?kind=local&path=work&prefix=.Trash-1000",
        ),
      );
    expect(readRes.status).toBe(200);
    const cached = (await readRes.json()) as {
      cached: true;
      objectCount: number;
      bytes: number;
      calculatedAt: number;
    };
    expect(cached).toMatchObject({ cached: true, objectCount: 2, bytes: 15 });
    expect(cached.calculatedAt).toBeGreaterThan(0);

    // The directory listing now shows the real bytes for the sized prefix.
    const listRes = await new Elysia()
      .use(browseRoutes)
      .handle(new Request("http://localhost/api/v1/browse/local?path=work"));
    expect(listRes.status).toBe(200);
    const listing = (await listRes.json()) as {
      entries: Array<{ name: string; type: string; size: number }>;
      trash?: Array<{ uid: number; prefix: string }>;
    };
    const trashDir = listing.entries.find((e) => e.name === ".Trash-1000");
    expect(trashDir).toBeTruthy();
    expect(trashDir?.size).toBe(15);
    expect(listing.trash).toEqual([{ uid: 1000, prefix: ".Trash-1000" }]);

    // Audit: manual origin + terminal success + prefix + counts in details.
    const log = db
      .query<
        {
          operation: string;
          status: string;
          trigger: string | null;
          summary: string | null;
          details: string | null;
        },
        []
      >(
        "SELECT operation, status, trigger, summary, details FROM operation_log WHERE operation = 'browse_size' ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(log).toBeTruthy();
    expect(log?.status).toBe("success");
    expect(log?.trigger).toBe("manual");
    expect(log?.summary).toContain("work/.Trash-1000");
    expect(log?.summary).toContain("2 objects");
    expect(log?.summary).toContain("15 bytes");
    const details = JSON.parse(log?.details ?? "null") as Record<string, unknown>;
    expect(details.prefix).toBe("work/.Trash-1000");
    expect(details.objectCount).toBe(2);
    expect(details.bytes).toBe(15);
  });

  test("local size cache read misses before a job runs", async () => {
    const res = await new Elysia()
      .use(browseRoutes)
      .handle(
        new Request(
          "http://localhost/api/v1/browse/size?kind=local&path=&prefix=.Trash-1000",
        ),
      );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cached: false });
  });

  test("rejects empty and traversal prefixes with 400", async () => {
    const emptyRes = await postJson("/api/v1/browse/size", {
      ref: { kind: "local", path: "" },
      prefix: "",
    });
    expect(emptyRes.status).toBe(400);

    const traversalRes = await postJson("/api/v1/browse/size", {
      ref: { kind: "local", path: "" },
      prefix: "../etc",
    });
    expect(traversalRes.status).toBe(400);
  });

  test("s3 size job aggregates paginated pages and scrubs upstream errors", async () => {
    makeS3Folder("Vault", "folder-1");
    const contentXml = (key: string, size: number): string =>
      `<Contents><Key>${key}</Key><LastModified>2024-01-15T10:30:00.000Z</LastModified><Size>${size}</Size></Contents>`;
    const requestedTokens: Array<string | null> = [];
    __setDefaultS3Fetch((url) => {
      const parsed = new URL(url.toString());
      requestedTokens.push(parsed.searchParams.get("continuation-token"));
      const prefix = parsed.searchParams.get("prefix") ?? "";
      const page = parsed.searchParams.get("continuation-token") === "TOKEN2" ? 1 : 0;
      const body =
        page === 0
          ? `<?xml version="1.0"?><ListBucketResult><Prefix>${prefix}</Prefix><IsTruncated>true</IsTruncated><NextContinuationToken>TOKEN2</NextContinuationToken>${contentXml(`${prefix}f1`, 100)}${contentXml(`${prefix}f2`, 50)}</ListBucketResult>`
          : `<?xml version="1.0"?><ListBucketResult><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${contentXml(`${prefix}deep/f3`, 3)}</ListBucketResult>`;
      return Promise.resolve(new Response(body, { status: 200 }));
    });

    const startRes = await postJson("/api/v1/browse/size", {
      ref: { kind: "s3", folderId: "folder-1", path: "" },
      prefix: ".Trash-1000",
    });
    expect(startRes.status).toBe(201);
    const job = (await startRes.json()) as { id: string };
    const terminal = await waitTerminalJob(job.id);
    expect(terminal.status).toBe("done");

    // Pagination: first page had no token, second carried the continuation.
    expect(requestedTokens).toEqual([null, "TOKEN2"]);

    const readRes = await new Elysia()
      .use(browseRoutes)
      .handle(
        new Request(
          "http://localhost/api/v1/browse/size?kind=s3&folderId=folder-1&path=&prefix=.Trash-1000",
        ),
      );
    const cached = (await readRes.json()) as { cached: true; objectCount: number; bytes: number };
    expect(cached).toMatchObject({ cached: true, objectCount: 3, bytes: 153 });

    // The listing must surface the same directory entry for the merge.
    __setListS3Impl(async () => {
      const listing: S3Listing = {
        entries: [
          { name: ".Trash-1000", type: "dir", size: 0, lastModified: 0 },
        ],
      };
      return listing;
    });
    const listRes = await new Elysia()
      .use(browseRoutes)
      .handle(
        new Request("http://localhost/api/v1/browse/s3?folderId=folder-1"),
      );
    const listing = (await listRes.json()) as {
      entries: Array<{ name: string; type: string; size: number }>;
    };
    const trashDir = listing.entries.find((e) => e.name === ".Trash-1000");
    expect(trashDir?.size).toBe(153);
  });

  test("s3 size job failure scrubs the upstream error body", async () => {
    makeS3Folder("Vault", "folder-1");
    __setDefaultS3Fetch(() =>
      Promise.resolve(
        new Response("AccessDenied super-secret-bucket-internal-detail", {
          status: 403,
        }),
      ),
    );

    const startRes = await postJson("/api/v1/browse/size", {
      ref: { kind: "s3", folderId: "folder-1", path: "" },
      prefix: ".Trash-1000",
    });
    expect(startRes.status).toBe(201);
    const job = (await startRes.json()) as { id: string };
    const terminal = await waitTerminalJob(job.id);
    expect(terminal.status).toBe("failed");
    expect(terminal.error).toBe("S3 listing failed");
    expect(terminal.error).not.toContain("super-secret");

    const readRes = await new Elysia()
      .use(browseRoutes)
      .handle(
        new Request(
          "http://localhost/api/v1/browse/size?kind=s3&folderId=folder-1&path=&prefix=.Trash-1000",
        ),
      );
    expect(await readRes.json()).toEqual({ cached: false });

    // The failed job still leaves a manual audit row naming the prefix.
    const log = db
      .query<
        { operation: string; status: string; trigger: string | null; summary: string | null },
        []
      >(
        "SELECT operation, status, trigger, summary FROM operation_log WHERE operation = 'browse_size' ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(log?.status).toBe("failed");
    expect(log?.trigger).toBe("manual");
    expect(log?.summary).toContain(".Trash-1000");
  });
});
