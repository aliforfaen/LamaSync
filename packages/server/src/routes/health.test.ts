// UX workstream 4: health route tests — the Admin page reads
// `serverVersion` / `dbSizeBytes` from GET /health.
//
// NOTE: `bun test` can share a process across test files, and other files
// mutate `LAMASYNC_DATA_DIR` in their beforeEach (e.g. stats.test.ts), so
// the db.ts singleton may point at a path that was cleaned up before this
// file runs. The assertions therefore read the server's own `dbFilePath()`
// and only require the size match when that file actually exists.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "health-test-key";
// Unconditional (not `?? `) so a shared-process env from another test file
// can't redirect the db.ts singleton to a path that file will delete.
process.env.LAMASYNC_DATA_DIR = mkdtempSync(join(tmpdir(), "lamasync-health-"));
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "health-test-secret-key-0123456789abcdef";

const { getAuthPlugin } = await import("../auth.ts");
const { __setCachedLatestVersionForTests } = (await import("../release-cache.ts")) as typeof import("../release-cache.ts");
const { healthRoutes } = await import("./health.ts");
const { dbFilePath } = await import("../db.ts");

let app: { handle(request: Request): Response | Promise<Response> };

beforeEach(() => {
  __setCachedLatestVersionForTests("9.9.9");
  app = new Elysia().use(getAuthPlugin()).use(healthRoutes);
});

describe("GET /api/v1/health", () => {
  test("reports a non-empty server version", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/health", {
        headers: { Authorization: `Bearer ${process.env.LAMASYNC_API_KEY}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; serverVersion: string };
    expect(body.status).toBe("ok");
    expect(typeof body.serverVersion).toBe("string");
    expect(body.serverVersion.length).toBeGreaterThan(0);
  });

  test("dbSizeBytes matches the server's DB file when it exists", async () => {
    // The db.ts singleton may have fallen back to :memory: in a shared test
    // process (unwritable/removed path) — in that case dbFilePath() has no
    // file and the route correctly reports null. Only assert when the file
    // is actually on disk.
    let expected: number | null = null;
    try {
      expected = statSync(dbFilePath()).size;
    } catch {
      expected = null;
    }
    const res = await app.handle(
      new Request("http://localhost/api/v1/health", {
        headers: { Authorization: `Bearer ${process.env.LAMASYNC_API_KEY}` },
      }),
    );
    const body = (await res.json()) as { dbSizeBytes: number | null };
    if (expected === null) {
      expect(body.dbSizeBytes).toBeNull();
    } else {
      expect(body.dbSizeBytes).toBe(expected);
    }
  });
});
