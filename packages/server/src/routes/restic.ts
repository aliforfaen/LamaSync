import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import { broadcast } from "../ws.ts";
import type { ResticRestoreJob, ResticSnapshot, WSEvent } from "@lamasync/core";

// Test seam: allows unit tests to substitute the production DB.
let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

interface SnapshotRow {
  id: string;
  folder_id: string;
  host_id: string;
  snapshot_id: string;
  timestamp: number;
  paths: string;
  size_bytes: number | null;
  tags: string | null;
}

interface RestoreRow {
  id: string;
  snapshot_id: string;
  folder_id: string;
  target_host_id: string;
  target_path: string;
  include: string | null;
  status: string;
  created_at: number;
  resolved_at: number | null;
  error: string | null;
}

function rowToSnapshot(r: SnapshotRow): ResticSnapshot {
  return {
    id: r.id,
    folderId: r.folder_id,
    hostId: r.host_id,
    snapshotId: r.snapshot_id,
    timestamp: r.timestamp,
    paths: parseJson(r.paths, []),
    sizeBytes: r.size_bytes,
    tags: parseJson(r.tags, []),
  };
}

function rowToRestoreJob(r: RestoreRow): ResticRestoreJob {
  return {
    id: r.id,
    snapshotId: r.snapshot_id,
    folderId: r.folder_id,
    targetHostId: r.target_host_id,
    targetPath: r.target_path,
    include: parseJson(r.include, []),
    status: r.status as ResticRestoreJob["status"],
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    error: r.error,
  };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const resticRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/restic/snapshots",
    ({ query }) => {
      const { folderId, hostId } = query as {
        folderId?: string;
        hostId?: string;
      };
      const where: string[] = [];
      const args: string[] = [];
      if (folderId) {
        where.push("folder_id = ?");
        args.push(folderId);
      }
      if (hostId) {
        where.push("host_id = ?");
        args.push(hostId);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const sql = `SELECT id, folder_id, host_id, snapshot_id, timestamp, paths, size_bytes, tags
                   FROM restic_snapshots
                   ${whereSql}
                   ORDER BY timestamp DESC`;
      const rows = activeDb.query<SnapshotRow, string[]>(sql).all(...args);
      return rows.map(rowToSnapshot);
    },
    {
      query: t.Object({
        folderId: t.Optional(t.String()),
        hostId: t.Optional(t.String()),
      }),
      detail: {
        summary: "List restic snapshot metadata",
        tags: ["Restic"],
        responses: {
          200: { description: "Snapshot list" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/restic/snapshots",
    ({ body, set }) => {
      const {
        folderId,
        hostId,
        snapshotId,
        timestamp,
        paths,
        sizeBytes,
        tags,
      } = body as {
        folderId: string;
        hostId: string;
        snapshotId: string;
        timestamp: number;
        paths: string[];
        sizeBytes?: number | null;
        tags?: string[];
      };
      const id = crypto.randomUUID();
      activeDb.run(
        `INSERT INTO restic_snapshots
           (id, folder_id, host_id, snapshot_id, timestamp, paths, size_bytes, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          folderId,
          hostId,
          snapshotId,
          timestamp,
          JSON.stringify(paths),
          sizeBytes ?? null,
          JSON.stringify(tags ?? []),
        ],
      );
      const row = activeDb
        .query<SnapshotRow, [string]>(
          "SELECT id, folder_id, host_id, snapshot_id, timestamp, paths, size_bytes, tags FROM restic_snapshots WHERE id = ?",
        )
        .get(id);
      if (!row) {
        set.status = 500;
        return { error: "Failed to load snapshot" };
      }
      const snapshot = rowToSnapshot(row);
      const event: WSEvent = { kind: "restic_snapshot", snapshot };
      broadcast(event);
      set.status = 201;
      return snapshot;
    },
    {
      body: t.Object({
        folderId: t.String(),
        hostId: t.String(),
        snapshotId: t.String(),
        timestamp: t.Number(),
        paths: t.Array(t.String()),
        sizeBytes: t.Optional(t.Union([t.Number(), t.Null()])),
        tags: t.Optional(t.Array(t.String())),
      }),
      detail: {
        summary: "Report a restic snapshot created by a daemon",
        tags: ["Restic"],
        responses: {
          201: { description: "Snapshot recorded" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/restic/restore",
    ({ query }) => {
      const { targetHostId, status } = query as {
        targetHostId?: string;
        status?: string;
      };
      const where: string[] = [];
      const args: string[] = [];
      if (targetHostId) {
        where.push("target_host_id = ?");
        args.push(targetHostId);
      }
      if (status) {
        where.push("status = ?");
        args.push(status);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const sql = `SELECT id, snapshot_id, folder_id, target_host_id, target_path, include, status, created_at, resolved_at, error
                   FROM restic_restore_jobs
                   ${whereSql}
                   ORDER BY created_at DESC`;
      const rows = activeDb.query<RestoreRow, string[]>(sql).all(...args);
      return rows.map(rowToRestoreJob);
    },
    {
      query: t.Object({
        targetHostId: t.Optional(t.String()),
        status: t.Optional(t.String()),
      }),
      detail: {
        summary: "List restic restore jobs",
        tags: ["Restic"],
        responses: {
          200: { description: "Restore job list" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/restic/restore",
    ({ body, set }) => {
      const { snapshotId, folderId, targetHostId, targetPath, include } = body as {
        snapshotId: string;
        folderId: string;
        targetHostId: string;
        targetPath: string;
        include?: string[];
      };
      const id = crypto.randomUUID();
      const now = Date.now();
      activeDb.run(
        `INSERT INTO restic_restore_jobs
           (id, snapshot_id, folder_id, target_host_id, target_path, include, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, snapshotId, folderId, targetHostId, targetPath, JSON.stringify(include ?? []), "pending", now],
      );
      const row = activeDb
        .query<RestoreRow, [string]>(
          "SELECT id, snapshot_id, folder_id, target_host_id, target_path, include, status, created_at, resolved_at, error FROM restic_restore_jobs WHERE id = ?",
        )
        .get(id);
      if (!row) {
        set.status = 500;
        return { error: "Failed to load restore job" };
      }
      const job = rowToRestoreJob(row);
      const event: WSEvent = { kind: "restic_restore", job };
      broadcast(event);
      set.status = 201;
      return job;
    },
    {
      body: t.Object({
        snapshotId: t.String(),
        folderId: t.String(),
        targetHostId: t.String(),
        targetPath: t.String(),
        include: t.Optional(t.Array(t.String())),
      }),
      detail: {
        summary: "Create a restic restore job for a target host",
        tags: ["Restic"],
        responses: {
          201: { description: "Restore job created" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/restic/restore/:id/status",
    ({ params, body, set }) => {
      const { status, error } = body as {
        status: ResticRestoreJob["status"];
        error?: string | null;
      };
      const existing = activeDb
        .query<RestoreRow, [string]>(
          "SELECT id, snapshot_id, folder_id, target_host_id, target_path, include, status, created_at, resolved_at, error FROM restic_restore_jobs WHERE id = ?",
        )
        .get(params.id);
      if (!existing) {
        set.status = 404;
        return { error: "Restore job not found" };
      }
      const resolvedAt = status === "done" || status === "failed" ? Date.now() : existing.resolved_at;
      activeDb.run(
        "UPDATE restic_restore_jobs SET status = ?, error = ?, resolved_at = ? WHERE id = ?",
        [status, error ?? null, resolvedAt, params.id],
      );
      const row = activeDb
        .query<RestoreRow, [string]>(
          "SELECT id, snapshot_id, folder_id, target_host_id, target_path, include, status, created_at, resolved_at, error FROM restic_restore_jobs WHERE id = ?",
        )
        .get(params.id);
      const job = rowToRestoreJob(row!);
      const event: WSEvent = { kind: "restic_restore", job };
      broadcast(event);
      return job;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        status: t.Union([
          t.Literal("pending"),
          t.Literal("running"),
          t.Literal("done"),
          t.Literal("failed"),
        ]),
        error: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary: "Update restore job status (daemon pickup/ack)",
        tags: ["Restic"],
        responses: {
          200: { description: "Updated job" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );
