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
