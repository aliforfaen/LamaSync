// Unit tests for the /api/v1/conflicts routes.

process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-test-data";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Elysia } from "elysia";
import { initDb } from "@lamasync/core";
import type { Database } from "bun:sqlite";
import { __setDb, conflictsRoutes } from "./conflicts.ts";

let db: Database;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lamasync-conflicts-test-"));
  db = initDb(join(dataDir, "test.db"));
  __setDb(db);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("conflictsRoutes", () => {
  test("GET /api/v1/conflicts returns empty list by default", async () => {
    const app = new Elysia().use(conflictsRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/conflicts"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("POST /api/v1/conflicts creates conflicts and GET filters by status", async () => {
    const app = new Elysia().use(conflictsRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/conflicts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conflicts: [
            {
              hostId: "host-1",
              folderId: "folder-1",
              path: "file.txt",
              localMtime: 1000,
              remoteMtime: 2000,
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as Array<Record<string, unknown>>;
    expect(created).toHaveLength(1);
    expect(created[0]?.path).toBe("file.txt");
    expect(created[0]?.status).toBe("pending");

    const pending = await app.handle(
      new Request("http://localhost/api/v1/conflicts?status=pending"),
    );
    expect(pending.status).toBe(200);
    const items = (await pending.json()) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
  });

  test("POST /api/v1/conflicts/:id/resolve marks conflict resolved", async () => {
    const app = new Elysia().use(conflictsRoutes);
    const create = await app.handle(
      new Request("http://localhost/api/v1/conflicts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conflicts: [
            {
              hostId: "host-1",
              folderId: "folder-1",
              path: "file.txt",
            },
          ],
        }),
      }),
    );
    const created = (await create.json()) as Array<Record<string, unknown>>;
    const id = String(created[0]!.id);

    const resolve = await app.handle(
      new Request(`http://localhost/api/v1/conflicts/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution: "local" }),
      }),
    );
    expect(resolve.status).toBe(200);
    const updated = (await resolve.json()) as Record<string, unknown>;
    expect(updated.status).toBe("resolved");
    expect(updated.resolution).toBe("local");
  });
});
