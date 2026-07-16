import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import { broadcast } from "../ws.ts";
import type { Conflict, ConflictResolution, WSEvent } from "@lamasync/core";

// Test seam: allows unit tests to substitute the production DB.
let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

interface ConflictRow {
  id: string;
  host_id: string;
  folder_id: string;
  path: string;
  local_mtime: number | null;
  remote_mtime: number | null;
  status: string;
  resolution: string | null;
  created_at: number;
  resolved_at: number | null;
}

function rowToConflict(r: ConflictRow): Conflict {
  return {
    id: r.id,
    hostId: r.host_id,
    folderId: r.folder_id,
    path: r.path,
    localMtime: r.local_mtime,
    remoteMtime: r.remote_mtime,
    status: r.status as Conflict["status"],
    resolution: (r.resolution as ConflictResolution | null) ?? null,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export const conflictsRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/conflicts",
    ({ query }) => {
      const { hostId, folderId, status } = query as {
        hostId?: string;
        folderId?: string;
        status?: string;
      };
      const where: string[] = [];
      const args: string[] = [];
      if (hostId) {
        where.push("host_id = ?");
        args.push(hostId);
      }
      if (folderId) {
        where.push("folder_id = ?");
        args.push(folderId);
      }
      if (status) {
        where.push("status = ?");
        args.push(status);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const sql = `SELECT id, host_id, folder_id, path, local_mtime, remote_mtime, status, resolution, created_at, resolved_at
                   FROM conflicts
                   ${whereSql}
                   ORDER BY created_at DESC`;
      const rows = activeDb.query<ConflictRow, string[]>(sql).all(...args);
      return rows.map(rowToConflict);
    },
    {
      query: t.Object({
        hostId: t.Optional(t.String()),
        folderId: t.Optional(t.String()),
        status: t.Optional(t.String()),
      }),
      detail: {
        summary: "List manual sync conflicts",
        tags: ["Conflicts"],
        responses: {
          200: { description: "Conflict list" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/conflicts",
    ({ body, set }) => {
      const { conflicts } = body as {
        conflicts: Array<{
          hostId: string;
          folderId: string;
          path: string;
          localMtime?: number | null;
          remoteMtime?: number | null;
        }>;
      };
      const created: Conflict[] = [];
      const now = Date.now();
      for (const c of conflicts) {
        const id = crypto.randomUUID();
        activeDb.run(
          `INSERT INTO conflicts
             (id, host_id, folder_id, path, local_mtime, remote_mtime, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(host_id, folder_id, path) DO UPDATE SET
             local_mtime = excluded.local_mtime,
             remote_mtime = excluded.remote_mtime,
             status = 'pending',
             resolution = NULL,
             resolved_at = NULL`,
          [
            id,
            c.hostId,
            c.folderId,
            c.path,
            c.localMtime ?? null,
            c.remoteMtime ?? null,
            "pending",
            now,
          ],
        );
        const row = activeDb
          .query<ConflictRow, [string]>(
            "SELECT id, host_id, folder_id, path, local_mtime, remote_mtime, status, resolution, created_at, resolved_at FROM conflicts WHERE id = ?",
          )
          .get(id);
        if (row) {
          const conflict = rowToConflict(row);
          created.push(conflict);
          const event: WSEvent = { kind: "conflict", conflict };
          broadcast(event);
        }
      }
      set.status = 201;
      return created;
    },
    {
      body: t.Object({
        conflicts: t.Array(
          t.Object({
            hostId: t.String(),
            folderId: t.String(),
            path: t.String(),
            localMtime: t.Optional(t.Union([t.Number(), t.Null()])),
            remoteMtime: t.Optional(t.Union([t.Number(), t.Null()])),
          }),
        ),
      }),
      detail: {
        summary: "Bulk-create or refresh manual conflicts from a daemon",
        tags: ["Conflicts"],
        responses: {
          201: { description: "Conflicts recorded" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/conflicts/:id/resolve",
    ({ params, body, set }) => {
      const { resolution } = body as { resolution: ConflictResolution };
      const existing = activeDb
        .query<ConflictRow, [string]>(
          "SELECT id, host_id, folder_id, path, local_mtime, remote_mtime, status, resolution, created_at, resolved_at FROM conflicts WHERE id = ?",
        )
        .get(params.id);
      if (!existing) {
        set.status = 404;
        return { error: "Conflict not found" };
      }
      activeDb.run(
        "UPDATE conflicts SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ?",
        [resolution, Date.now(), params.id],
      );
      const row = activeDb
        .query<ConflictRow, [string]>(
          "SELECT id, host_id, folder_id, path, local_mtime, remote_mtime, status, resolution, created_at, resolved_at FROM conflicts WHERE id = ?",
        )
        .get(params.id);
      const conflict = rowToConflict(row!);
      const event: WSEvent = { kind: "conflict", conflict };
      broadcast(event);
      return conflict;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        resolution: t.Union([
          t.Literal("local"),
          t.Literal("remote"),
          t.Literal("both"),
        ]),
      }),
      detail: {
        summary: "Resolve a manual conflict (local, remote, or both)",
        tags: ["Conflicts"],
        responses: {
          200: { description: "Resolved conflict" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );
