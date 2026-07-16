// Unit tests for the /api/v1/restic routes.

process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-test-data";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Elysia } from "elysia";
import { initDb } from "@lamasync/core";
import type { Database } from "bun:sqlite";
import { __setDb, resticRoutes } from "./restic.ts";

let db: Database;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lamasync-restic-test-"));
  db = initDb(join(dataDir, "test.db"));
  __setDb(db);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("resticRoutes", () => {
  test("GET /api/v1/restic/snapshots returns empty list by default", async () => {
    const app = new Elysia().use(resticRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/restic/snapshots"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("POST /api/v1/restic/snapshots records a snapshot", async () => {
    const app = new Elysia().use(resticRoutes);
    const body = {
      folderId: "folder-1",
      hostId: "host-1",
      snapshotId: "abc123",
      timestamp: Date.now(),
      paths: ["/tmp/a"],
      sizeBytes: 1024,
      tags: ["lamasync"],
    };
    const res = await app.handle(
      new Request("http://localhost/api/v1/restic/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, unknown>;
    expect(created.folderId).toBe("folder-1");
    expect(created.snapshotId).toBe("abc123");
    expect(created.paths).toEqual(["/tmp/a"]);

    const list = await app.handle(
      new Request("http://localhost/api/v1/restic/snapshots?folderId=folder-1"),
    );
    expect(list.status).toBe(200);
    const items = (await list.json()) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.snapshotId).toBe("abc123");
  });

  test("POST /api/v1/restic/restore creates a restore job", async () => {
    const app = new Elysia().use(resticRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/restic/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          snapshotId: "abc123",
          folderId: "folder-1",
          targetHostId: "host-2",
          targetPath: "/tmp/restore",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const job = (await res.json()) as Record<string, unknown>;
    expect(job.snapshotId).toBe("abc123");
    expect(job.status).toBe("pending");

    const list = await app.handle(
      new Request("http://localhost/api/v1/restic/restore?targetHostId=host-2"),
    );
    expect(list.status).toBe(200);
    const items = (await list.json()) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.targetPath).toBe("/tmp/restore");
  });
});
