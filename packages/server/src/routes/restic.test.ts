// Unit tests for the /api/v1/restic routes.

process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-test-data";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Elysia } from "elysia";
import { initDb } from "@lamasync/core";
import type { Database } from "bun:sqlite";
import { __resetNotificationStateForTests } from "../notifications.ts";
import { __setDb, resticRoutes } from "./restic.ts";

let db: Database;
let dataDir: string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lamasync-restic-test-"));
  db = initDb(join(dataDir, "test.db"));
  __resetNotificationStateForTests();
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

  test("restore completion and failure emit notifications", async () => {
    const app = new Elysia().use(resticRoutes);

    async function createJob(snapshotId: string): Promise<string> {
      const response = await app.handle(
        new Request("http://localhost/api/v1/restic/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            snapshotId,
            folderId: "folder-1",
            targetHostId: "host-2",
            targetPath: "/tmp/restore",
          }),
        }),
      );
      const body: unknown = await response.json();
      if (!isRecord(body)) throw new Error("expected restore job response");
      return String(body.id);
    }

    const doneId = await createJob("done-snapshot");
    const done = await app.handle(
      new Request(`http://localhost/api/v1/restic/restore/${doneId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      }),
    );
    expect(done.status).toBe(200);

    const failedId = await createJob("failed-snapshot");
    const failed = await app.handle(
      new Request(`http://localhost/api/v1/restic/restore/${failedId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "failed", error: "disk full" }),
      }),
    );
    expect(failed.status).toBe(200);

    const events = db
      .query<{ type: string; severity: string; message: string }, []>(
        "SELECT type, severity, message FROM notification_events ORDER BY rowid",
      )
      .all();
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("restore_done");
    expect(events[0]?.severity).toBe("info");
    expect(events[1]).toEqual({
      type: "restore_failed",
      severity: "critical",
      message: "disk full",
    });
  });
});
