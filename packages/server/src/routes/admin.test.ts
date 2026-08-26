// P-B cleanup #6: operation-log archival export tests. Round-trip:
// populate operation_log with rows spanning past + future; call the
// route with a tempdir; assert the archive decodes back to the expected
// JSON, the rows are gone from the DB, and a second call archives zero.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "admin-export-test-key";
process.env.LAMASYNC_DATA_DIR =
  process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-admin-export-test-data";

const { getAuthPlugin } = await import("../auth.ts");
const {
  adminRoutes,
  archiveAndPruneOperationLog,
  __setDb: __setAdminDb,
  __exportHelpersForTests,
} = await import("./admin.ts");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("expected an object response");
  return body;
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${process.env.LAMASYNC_API_KEY}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // migrations are intentionally idempotent for pre-existing schemas
    }
  }
  __setAdminDb(db);
  app = new Elysia().use(getAuthPlugin()).use(adminRoutes);
});

afterEach(() => {
  db.close();
});

function seedOpRow(args: {
  hostId: string;
  ts: number;
  operation?: string;
  status?: string;
  summary?: string | null;
  folderId?: string | null;
  demo?: number;
}): number {
  const result = db.run(
    `INSERT INTO operation_log
       (timestamp, host_id, folder_id, operation, status, summary, duration_ms, demo)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      args.ts,
      args.hostId,
      args.folderId ?? null,
      args.operation ?? "sync",
      args.status ?? "success",
      args.summary ?? null,
      args.demo ?? 0,
    ],
  );
  return Number(result.lastInsertRowid);
}

describe("admin export route", () => {
  test("round-trips older rows to NDJSON.gz, deletes the archiveable set, and is idempotent on a second call", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // The prune-and-archive contract preserves the LATEST old row per
    // host (so an offline host keeps a visible last-status entry) and
    // archives every other old row. Future rows (timestamp > cutoff)
    // are never touched.
    //
    // Hosts:
    //   alpha  future only                   → 0 archive
    //   beta   1 old (-10d) + future         → 0 archive (the 1 old IS the latest-old)
    //   gamma  2 old (-100d, -50d) + future  → 1 archive (-100d deleted, -50d preserved)
    //   delta  2 old (-200d, -150d) + future → 1 archive (-200d deleted, -150d preserved)
    // Archive set: gamma-100d, delta-200d = 2 rows.
    seedOpRow({ hostId: "alpha", ts: now + 1 * day, status: "success", summary: "alpha-future" });

    seedOpRow({ hostId: "beta", ts: now - 10 * day, status: "success", summary: "beta-10d" });
    seedOpRow({ hostId: "beta", ts: now + 1 * day, status: "success", summary: "beta-future" });

    seedOpRow({ hostId: "gamma", ts: now - 100 * day, status: "failed", summary: "gamma-100d" });
    seedOpRow({ hostId: "gamma", ts: now - 50 * day, status: "failed", summary: "gamma-50d" });
    seedOpRow({ hostId: "gamma", ts: now + 1 * day, status: "success", summary: "gamma-future" });

    seedOpRow({ hostId: "delta", ts: now - 200 * day, status: "failed", summary: "delta-200d" });
    seedOpRow({ hostId: "delta", ts: now - 150 * day, status: "failed", summary: "delta-150d" });
    seedOpRow({ hostId: "delta", ts: now + 1 * day, status: "success", summary: "delta-future" });

    const tempDir = mkdtempSync(join(tmpdir(), "lamasync-export-test-"));
    try {
      const response = await app.handle(
        request("/api/v1/admin/export", {
          method: "POST",
          body: JSON.stringify({
            olderThanMs: 7 * day,
            targetDir: tempDir,
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await responseObject(response);

      expect(body["olderThanMs"]).toBe(7 * day);
      expect(body["targetDir"]).toBe(tempDir);
      expect(body["archived"]).toBe(2);
      expect(body["deleted"]).toBe(2);
      const archivePath = String(body["file"]);
      expect(archivePath.length).toBeGreaterThan(0);
      expect(archivePath.startsWith(tempDir)).toBe(true);
      expect(archivePath.endsWith(".ndjson.gz")).toBe(true);

      // No stray .tmp file left behind.
      const { readdirSync } = await import("node:fs");
      const siblings = readdirSync(tempDir);
      const tmps = siblings.filter((name) => name.endsWith(".tmp"));
      expect(tmps).toEqual([]);

      // After the archive the DB has 7 rows: 4 futures + 3 preserved "latest-old"
      // (one per host that had any old rows: beta-10d, gamma-50d, delta-150d).
      // The two very-old archiveable rows are gone from the DB.
      const remaining = db
        .query<{ host_id: string; summary: string | null }, []>(
          "SELECT host_id, summary FROM operation_log ORDER BY id ASC",
        )
        .all();
      expect(remaining).toHaveLength(7);
      const summaries = remaining
        .map((r) => `${r.host_id}:${r.summary ?? ""}`)
        .sort();
      expect(summaries).toEqual([
        "alpha:alpha-future",
        "beta:beta-10d",
        "beta:beta-future",
        "delta:delta-150d",
        "delta:delta-future",
        "gamma:gamma-50d",
        "gamma:gamma-future",
      ]);

      // Round-trip the archive: gz → NDJSON → array of row objects, one
      // per archived row, in id ASC order so the consumer can replay in
      // insertion order.
      const fileBytes = await Bun.file(archivePath).bytes();
      const decoded = __exportHelpersForTests.decodeNdjson(
        new Uint8Array(fileBytes),
      );
      const lines = decoded.split("\n").filter((line) => line.length > 0);
      expect(lines).toHaveLength(2);
      const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      // Each archived row carried the verbatim summary + status + hostId
      // so the archive is a verifiable audit trail, not an opaque blob.
      const archivedSummaries = parsed
        .map((row) => String(row["summary"] ?? ""))
        .sort();
      expect(archivedSummaries).toEqual(["delta-200d", "gamma-100d"]);
      // Sorted by id ASC (replay-friendly).
      const ids = parsed.map((row) => Number(row["id"]));
      const sortedIds = [...ids].sort((a, b) => a - b);
      expect(ids).toEqual(sortedIds);
      // Canonical camelCase field shape for downstream tooling.
      expect(typeof parsed[0]?.["hostId"]).toBe("string");
      expect(typeof parsed[0]?.["operation"]).toBe("string");
      expect(typeof parsed[0]?.["status"]).toBe("string");
      expect(typeof parsed[0]?.["timestamp"]).toBe("number");

      // Idempotent re-call: zero rows in the cutoff window now, so the
      // route returns 200 with archived=0 / file=null / deleted=0 and
      // leaves the database untouched.
      const second = await app.handle(
        request("/api/v1/admin/export", {
          method: "POST",
          body: JSON.stringify({
            olderThanMs: 7 * day,
            targetDir: tempDir,
          }),
        }),
      );
      expect(second.status).toBe(200);
      const secondBody = await responseObject(second);
      expect(secondBody["archived"]).toBe(0);
      expect(secondBody["deleted"]).toBe(0);
      expect(secondBody["file"]).toBeNull();
      // DB row count unchanged.
      const stillRemaining = db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM operation_log",
        )
        .get();
      expect(stillRemaining?.count).toBe(7);
      // No second archive file was written.
      const after = readdirSync(tempDir);
      expect(after.filter((name) => name.endsWith(".ndjson.gz"))).toHaveLength(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("preserves the latest row per host and archives every older row", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // delta has TWO old rows: -100d and -50d. Only the latest OLD one
    // (-50d) should be preserved; the -100d should be archived.
    seedOpRow({ hostId: "delta", ts: now - 100 * day, status: "failed" });
    seedOpRow({ hostId: "delta", ts: now - 50 * day, status: "failed" });
    seedOpRow({ hostId: "delta", ts: now + 1 * day, status: "success" });

    const tempDir = mkdtempSync(join(tmpdir(), "lamasync-export-delta-"));
    try {
      const result = archiveAndPruneOperationLog(7 * day, tempDir);
      expect(result.archived).toBe(1);
      expect(result.deleted).toBe(1);
      expect(result.file).not.toBeNull();
      const remaining = db
        .query<{ host_id: string }, []>(
          "SELECT host_id FROM operation_log ORDER BY id ASC",
        )
        .all();
      // Preserved: -50d (latest per host older than cutoff) and +1d (future).
      expect(remaining).toHaveLength(2);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("resolveArchiveDir() picks the override, then LAMASYNC_BACKUP_DIR, then os.tmpdir()", () => {
    // Direct resolver unit-test: the helper's fallback chain is its only
    // behavior, and verifying it doesn't need a database.
    const priorEnv = process.env.LAMASYNC_BACKUP_DIR;
    try {
      delete process.env.LAMASYNC_BACKUP_DIR;
      // Empty env + no override → os.tmpdir().
      expect(__exportHelpersForTests.resolveArchiveDir(undefined)).toBe(tmpdir());
      expect(__exportHelpersForTests.resolveArchiveDir("")).toBe(tmpdir());

      // Explicit override always wins.
      expect(__exportHelpersForTests.resolveArchiveDir("/tmp/custom")).toBe(
        "/tmp/custom",
      );

      // Env var wins when no override is given.
      process.env.LAMASYNC_BACKUP_DIR = "/srv/backup";
      expect(__exportHelpersForTests.resolveArchiveDir(undefined)).toBe(
        "/srv/backup",
      );
      // Explicit override still beats the env var.
      expect(__exportHelpersForTests.resolveArchiveDir("/tmp/override")).toBe(
        "/tmp/override",
      );
    } finally {
      if (priorEnv === undefined) delete process.env.LAMASYNC_BACKUP_DIR;
      else process.env.LAMASYNC_BACKUP_DIR = priorEnv;
    }
  });

  test("rejects negative retention input with 400", async () => {
    const response = await app.handle(
      request("/api/v1/admin/export", {
        method: "POST",
        body: JSON.stringify({ olderThanMs: -1 }),
      }),
    );
    expect(response.status).toBe(400);
    const body = await responseObject(response);
    expect(String(body["error"])).toMatch(/olderThanMs/);
  });

  test("requires auth (401 without bearer token)", async () => {
    const response = await app.handle(
      new Request("http://localhost/api/v1/admin/export", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(401);
  });

  test("zero rows → 200 with file=null, deleted=0 (no file written)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lamasync-export-empty-"));
    try {
      const result = archiveAndPruneOperationLog(7 * 24 * 60 * 60 * 1000, tempDir);
      expect(result.archived).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.file).toBeNull();
      // Nothing was written to the target dir.
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(tempDir)).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
