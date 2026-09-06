// LAMA-226 P0-2: these are real end-to-end tests that spawn rclone against a
// temp backup root. They are gated on `Bun.which("rclone")` so the unit
// suite stays green on hosts without rclone installed (AGENTS.md:
// "`bun test` always works"). The pure config/argv helpers — and the busy
// guard, self-move, and S3 bucket threading — are covered by
// `browse-rclone.test.ts` which has zero external deps.
//
// Set `LAMASYNC_TEST_RCLONE=1` to force-skip these tests even when rclone is
// installed (CI uses this when running a hermetic rclone-less job).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_SCHEMA, MIGRATIONS } from "@lamasync/core";
import type { BrowseJob } from "@lamasync/core";
process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "browse-ops-test-key";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-browse-ops-test-data";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "browse-ops-test-secret-key-0123456789abcdef";

const HAS_RCLONE = !!Bun.which("rclone") && process.env.LAMASYNC_TEST_RCLONE !== "1";
const e2e = HAS_RCLONE ? describe : describe.skip;

const { getAuthPlugin } = await import("../auth.ts");
const { browseRoutes, __setDb } = (await import("./browse.ts")) as unknown as {
  browseRoutes: Elysia;
  __setDb: (db: Database) => void;
};
const { __resetBrowseJobsForTests } = await import("../browse-jobs.ts");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };
let root: string;

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.LAMASYNC_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function postJson(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.handle(request(path, { method: "POST", body: JSON.stringify(body) })));
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lamasync-browse-ops-"));
  mkdirSync(join(root, "src", "dir"), { recursive: true });
  mkdirSync(join(root, "dst"), { recursive: true });
  writeFileSync(join(root, "src", "hello.txt"), "hello world");
  writeFileSync(join(root, "src", "dir", "nested.txt"), "nested");
  process.env.LAMASYNC_BACKUP_DIR = root;

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
  __resetBrowseJobsForTests();
  app = new Elysia().use(getAuthPlugin()).use(browseRoutes);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** Wait for a job row to reach a terminal state. */
async function waitForJob(id: string, timeoutMs = 15000): Promise<BrowseJob> {
  const start = Date.now();
  for (;;) {
    const row = db
      .query<{ status: string; error: string | null; progress_bytes: number | null; total_bytes: number | null }, [string]>(
        "SELECT status, error, progress_bytes, total_bytes FROM browse_jobs WHERE id = ?",
      )
      .get(id);
    if (row && (row.status === "done" || row.status === "failed" || row.status === "cancelled")) {
      return {
        id,
        operation: "copy",
        source: "",
        destination: "",
        status: row.status as BrowseJob["status"],
        error: row.error,
        progressBytes: row.progress_bytes,
        totalBytes: row.total_bytes,
        createdAt: 0,
        updatedAt: 0,
      };
    }
    if (Date.now() - start > timeoutMs) throw new Error("job did not reach a terminal state in time");
    await Bun.sleep(50);
  }
}

e2e("POST /api/v1/browse/mkdir", () => {
  test("creates a local directory", async () => {
    const res = await postJson("/api/v1/browse/mkdir", {
      ref: { kind: "local", path: "dst" },
      name: "newdir",
    });
    expect(res.status).toBe(201);
    const job = (await res.json()) as BrowseJob;
    const terminal = await waitForJob(job.id);
    expect(terminal.status).toBe("done");
    expect(existsSync(join(root, "dst", "newdir"))).toBe(true);
  });

  test("rejects unsafe names", async () => {
    const res = await postJson("/api/v1/browse/mkdir", {
      ref: { kind: "local", path: "dst" },
      name: "../../escape",
    });
    expect(res.status).toBe(400);
  });
});

e2e("POST /api/v1/browse/copy", () => {
  test("copies a file local → local; source stays", async () => {
    const res = await postJson("/api/v1/browse/copy", {
      source: { kind: "local", path: "src" },
      destination: { kind: "local", path: "dst" },
      names: ["hello.txt"],
    });
    expect(res.status).toBe(201);
    const job = (await res.json()) as BrowseJob;
    const terminal = await waitForJob(job.id);
    expect(terminal.status).toBe("done");
    expect(existsSync(join(root, "dst", "hello.txt"))).toBe(true);
    expect(existsSync(join(root, "src", "hello.txt"))).toBe(true);
  });
});

e2e("POST /api/v1/browse/move", () => {
  test("moves a file; the source is gone afterwards", async () => {
    const res = await postJson("/api/v1/browse/move", {
      source: { kind: "local", path: "src" },
      destination: { kind: "local", path: "dst" },
      names: ["hello.txt"],
    });
    expect(res.status).toBe(201);
    const job = (await res.json()) as BrowseJob;
    const terminal = await waitForJob(job.id);
    expect(terminal.status).toBe("done");
    expect(existsSync(join(root, "dst", "hello.txt"))).toBe(true);
    expect(existsSync(join(root, "src", "hello.txt"))).toBe(false);
  });

  test("move appends an operation_log row", async () => {
    await postJson("/api/v1/browse/move", {
      source: { kind: "local", path: "src" },
      destination: { kind: "local", path: "dst" },
      names: ["hello.txt"],
    });
    // wait for the job to finish, then check the log
    const row = db
      .query<{ id: string }, []>("SELECT id FROM browse_jobs ORDER BY created_at DESC LIMIT 1")
      .get();
    await waitForJob(row!.id);
    const log = db
      .query<{ operation: string; status: string }, []>(
        "SELECT operation, status FROM operation_log WHERE operation = 'browse_move'",
      )
      .get();
    expect(log).toBeTruthy();
    expect(log?.status).toBe("success");
  });
});

e2e("POST /api/v1/browse/rename", () => {
  test("renames an entry in place", async () => {
    const res = await postJson("/api/v1/browse/rename", {
      ref: { kind: "local", path: "src" },
      from: "hello.txt",
      to: "renamed.txt",
    });
    expect(res.status).toBe(201);
    const job = (await res.json()) as BrowseJob;
    const terminal = await waitForJob(job.id);
    expect(terminal.status).toBe("done");
    expect(existsSync(join(root, "src", "renamed.txt"))).toBe(true);
    expect(existsSync(join(root, "src", "hello.txt"))).toBe(false);
  });
});

e2e("POST /api/v1/browse/upload", () => {
  test("uploads base64 content as a file", async () => {
    const res = await postJson("/api/v1/browse/upload", {
      destination: { kind: "local", path: "dst" },
      name: "pixel.png",
      content: Buffer.from("fake-png-bytes").toString("base64"),
    });
    expect(res.status).toBe(201);
    const job = (await res.json()) as BrowseJob;
    const terminal = await waitForJob(job.id);
    expect(terminal.status).toBe("done");
    expect(existsSync(join(root, "dst", "pixel.png"))).toBe(true);
  });
});

e2e("POST /api/v1/browse/delete", () => {
  test("deletes a file; the source is gone afterwards", async () => {
    const res = await postJson("/api/v1/browse/delete", {
      ref: { kind: "local", path: "src" },
      names: ["hello.txt"],
    });
    expect(res.status).toBe(201);
    const job = (await res.json()) as BrowseJob;
    const terminal = await waitForJob(job.id);
    expect(terminal.status).toBe("done");
    expect(existsSync(join(root, "src", "hello.txt"))).toBe(false);
  });

  test("purges a directory recursively", async () => {
    const res = await postJson("/api/v1/browse/delete", {
      ref: { kind: "local", path: "src" },
      names: ["dir"],
    });
    expect(res.status).toBe(201);
    const job = (await res.json()) as BrowseJob;
    const terminal = await waitForJob(job.id);
    expect(terminal.status).toBe("done");
    expect(existsSync(join(root, "src", "dir"))).toBe(false);
    expect(existsSync(join(root, "src"))).toBe(true);
  });

  test("rejects unsafe names", async () => {
    const res = await postJson("/api/v1/browse/delete", {
      ref: { kind: "local", path: "src" },
      names: ["../../escape"],
    });
    expect(res.status).toBe(400);
  });

  test("delete appends an operation_log row", async () => {
    await postJson("/api/v1/browse/delete", {
      ref: { kind: "local", path: "src" },
      names: ["hello.txt"],
    });
    const row = db
      .query<{ id: string }, []>("SELECT id FROM browse_jobs ORDER BY created_at DESC LIMIT 1")
      .get();
    await waitForJob(row!.id);
    const log = db
      .query<{ operation: string; status: string }, []>(
        "SELECT operation, status FROM operation_log WHERE operation = 'browse_delete'",
      )
      .get();
    expect(log).toBeTruthy();
    expect(log?.status).toBe("success");
  });
});

e2e("GET /api/v1/browse/jobs", () => {
  test("lists recent jobs newest-first", async () => {
    await postJson("/api/v1/browse/mkdir", { ref: { kind: "local", path: "dst" }, name: "a" });
    await postJson("/api/v1/browse/mkdir", { ref: { kind: "local", path: "dst" }, name: "b" });
    const res = await app.handle(request("/api/v1/browse/jobs"));
    expect(res.status).toBe(200);
    const jobs = (await res.json()) as BrowseJob[];
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    expect(jobs[0]!.destination).toContain("b");
  });
});

// LAMA-321: trash lifecycle. The busy-conflict test is hermetic (it hits the
// DB-backed guard before any rclone spawn); the empty-trash tests purge real
// local directories and are gated on rclone like the rest of this file.
describe("LAMA-321 empty-trash busy conflicts", () => {
  test("delete onto an in-flight destination returns 409 and logs a failed job", async () => {
    mkdirSync(join(root, "vault"));
    // Simulate an operator's other op currently writing this destination.
    db.run(
      `INSERT INTO browse_jobs (id, operation, source, destination, status, error, progress_bytes, total_bytes, created_at, updated_at)
       VALUES (?, 'move', 'local::vault|a', 'local::vault', 'running', NULL, 0, 1, ?, ?)`,
      ["in-flight-move", Date.now(), Date.now()],
    );

    const res = await postJson("/api/v1/browse/delete", {
      ref: { kind: "local", path: "vault" },
      names: [".Trash-1000"],
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("destination busy — another operation is writing there");

    const failed = db
      .query<{ operation: string; status: string; error: string | null }, []>(
        "SELECT operation, status, error FROM browse_jobs WHERE operation = 'delete' AND status = 'failed' ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    expect(failed).toBeTruthy();
    expect(failed?.error).toContain("destination busy");
  });

  test("a read-only size job does not occupy the writer destination lock", async () => {
    mkdirSync(join(root, "vault"));
    db.run(
      `INSERT INTO browse_jobs (id, operation, source, destination, status, error, progress_bytes, total_bytes, created_at, updated_at)
       VALUES (?, 'size', 'size:local::vault|.Trash-1000', 'size:local::vault|.Trash-1000', 'running', NULL, NULL, NULL, ?, ?)`,
      ["in-flight-size", Date.now(), Date.now()],
    );

    const res = await postJson("/api/v1/browse/delete", {
      ref: { kind: "local", path: "vault" },
      names: [".Trash-1000"],
    });
    expect(res.status).toBe(201);
  });
});

e2e("LAMA-321 empty trash (local)", () => {
  test("size, empty, audit, and cache invalidation round-trip", async () => {
    addConfiguredLocalDestination("vault");
    mkdirSync(join(root, "vault", ".Trash-1000", "files"), { recursive: true });
    mkdirSync(join(root, "vault", ".Trash-1000", "info"), { recursive: true });
    writeFileSync(join(root, "vault", ".Trash-1000", "files", "old.bin"), Buffer.alloc(10, 7));
    writeFileSync(join(root, "vault", ".Trash-1000", "info", "old.bin.trashinfo"), "hello");
    writeFileSync(join(root, "vault", "keep.txt"), "precious");

    // 1. The trash is detected with the exact prefix.
    const listRes = await app.handle(request("/api/v1/browse/local?path=vault"));
    expect(listRes.status).toBe(200);
    const listing = (await listRes.json()) as {
      trash?: Array<{ uid: number; prefix: string }>;
    };
    expect(listing.trash).toEqual([{ uid: 1000, prefix: ".Trash-1000" }]);

    // 2. On-demand recursive size measures real bytes.
    const sizeRes = await postJson("/api/v1/browse/size", {
      ref: { kind: "local", path: "vault" },
      prefix: ".Trash-1000",
    });
    expect(sizeRes.status).toBe(201);
    const sizeJob = (await sizeRes.json()) as BrowseJob;
    expect(await waitForJob(sizeJob.id)).toMatchObject({ status: "done" });

    const cachedRes = await app.handle(
      request("/api/v1/browse/size?kind=local&path=vault&prefix=.Trash-1000"),
    );
    const cached = (await cachedRes.json()) as {
      cached: true;
      objectCount: number;
      bytes: number;
    };
    expect(cached).toMatchObject({ cached: true, objectCount: 2, bytes: 15 });

    // 3. Empty trash reuses the browse-delete job.
    const delRes = await postJson("/api/v1/browse/delete", {
      ref: { kind: "local", path: "vault" },
      names: [".Trash-1000"],
    });
    expect(delRes.status).toBe(201);
    const delJob = (await delRes.json()) as BrowseJob;
    expect(await waitForJob(delJob.id)).toMatchObject({ status: "done" });

    // Purged, sibling data untouched, no trash left to detect.
    expect(existsSync(join(root, "vault", ".Trash-1000"))).toBe(false);
    expect(existsSync(join(root, "vault", "keep.txt"))).toBe(true);
    const after = (await (await app.handle(request("/api/v1/browse/local?path=vault"))).json()) as {
      trash?: unknown[];
    };
    expect(after.trash).toBeUndefined();

    // 4. Audit row: exact prefix + object count/bytes + manual origin.
    const log = db
      .query<
        { status: string; trigger: string | null; summary: string | null; details: string | null },
        []
      >(
        "SELECT status, trigger, summary, details FROM operation_log WHERE operation = 'browse_delete' ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(log?.status).toBe("success");
    expect(log?.trigger).toBe("manual");
    expect(log?.summary).toContain("vault/.Trash-1000");
    const details = JSON.parse(log?.details ?? "{}") as {
      prefix?: string;
      objectCount?: number;
      bytes?: number;
    };
    expect(details.prefix).toBe("vault/.Trash-1000");
    expect(details.objectCount).toBe(2);
    expect(details.bytes).toBe(15);

    // 5. The delete dropped the cached size (no stale listing numbers).
    const staleRes = await app.handle(
      request("/api/v1/browse/size?kind=local&path=vault&prefix=.Trash-1000"),
    );
    expect(await staleRes.json()).toEqual({ cached: false });
  });

  test("empties the nested .Trash/<uid> layout via a nested delete name", async () => {
    mkdirSync(join(root, ".Trash", "1000", "files"), { recursive: true });
    mkdirSync(join(root, ".Trash", "1000", "info"), { recursive: true });
    writeFileSync(join(root, ".Trash", "1000", "files", "junk.bin"), "junkjunk");
    mkdirSync(join(root, ".Trash", "2000"), { recursive: true }); // untouched
    writeFileSync(join(root, ".Trash", "2000", "note.txt"), "other user");

    const rootRes = await app.handle(request("/api/v1/browse/local"));
    const listing = (await rootRes.json()) as {
      trash?: Array<{ uid: number; prefix: string }>;
    };
    expect(listing.trash).toEqual([
      { uid: 1000, prefix: ".Trash/1000" },
      { uid: 2000, prefix: ".Trash/2000" },
    ]);

    // `.Trash/1000` is a nested folder-relative name for the delete job.
    const delRes = await postJson("/api/v1/browse/delete", {
      ref: { kind: "local", path: "" },
      names: [".Trash/1000"],
    });
    expect(delRes.status).toBe(201);
    const job = (await delRes.json()) as BrowseJob;
    expect(await waitForJob(job.id)).toMatchObject({ status: "done" });

    expect(existsSync(join(root, ".Trash", "1000"))).toBe(false);
    expect(existsSync(join(root, ".Trash", "2000"))).toBe(true);

    const after = (await (await app.handle(request("/api/v1/browse/local"))).json()) as {
      trash?: Array<{ uid: number; prefix: string }>;
    };
    expect(after.trash).toEqual([{ uid: 2000, prefix: ".Trash/2000" }]);
  });
});
