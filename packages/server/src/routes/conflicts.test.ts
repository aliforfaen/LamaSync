// Unit tests for the /api/v1/conflicts routes.

process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-test-data";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Elysia } from "elysia";
import { initDb } from "@lamasync/core";
import type { Database } from "bun:sqlite";
import { __resetNotificationStateForTests } from "../notifications.ts";
import { __setDb, conflictsRoutes } from "./conflicts.ts";

let db: Database;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lamasync-conflicts-test-"));
  db = initDb(join(dataDir, "test.db"));
  __resetNotificationStateForTests();
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

    const event = db
      .query<{ type: string; payload: string | null }, []>(
        "SELECT type, payload FROM notification_events",
      )
      .get();
    expect(event).toEqual({
      type: "conflict_pending",
      payload: '{"path":"file.txt"}',
    });
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

    const refresh = await app.handle(
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
    expect(refresh.status).toBe(201);
    const eventCount = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM notification_events WHERE type = 'conflict_pending'",
      )
      .get();
    expect(eventCount?.count).toBe(1);
  });

  test("LAMA-268: per-side sizes round-trip through POST and GET", async () => {
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
              path: "notes.md",
              localMtime: 1000,
              remoteMtime: 2000,
              localSizeBytes: 1842,
              remoteSizeBytes: 2011,
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as Array<Record<string, unknown>>;
    expect(created[0]!.localSizeBytes).toBe(1842);
    expect(created[0]!.remoteSizeBytes).toBe(2011);

    const list = (await (await app.handle(
      new Request("http://localhost/api/v1/conflicts?status=pending"),
    )).json()) as Array<Record<string, unknown>>;
    expect(list[0]!.localSizeBytes).toBe(1842);
    expect(list[0]!.remoteSizeBytes).toBe(2011);
  });
});
