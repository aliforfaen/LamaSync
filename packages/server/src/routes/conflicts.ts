import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import { broadcast } from "../ws.ts";
import type { Conflict, ConflictResolution, WSEvent } from "@lamasync/core";
import { deviceMayAccessHost, principalOf } from "../auth.ts";
import {
  __setDb as __setNotificationDb,
  emitNotification,
} from "../notifications.ts";

// Test seam: allows unit tests to substitute the production DB.
let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
  __setNotificationDb(next);
}

interface ConflictRow {
  id: string;
  host_id: string;
  folder_id: string;
  path: string;
  local_mtime: number | null;
  remote_mtime: number | null;
  local_size: number | null;
  remote_size: number | null;
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
    localSizeBytes: r.local_size,
    remoteSizeBytes: r.remote_size,
    status: r.status as Conflict["status"],
    resolution: (r.resolution as ConflictResolution | null) ?? null,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export const conflictsRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/conflicts",
    ({ query, set, store }) => {
      const { hostId, folderId, status } = query as {
        hostId?: string;
        folderId?: string;
        status?: string;
      };
      // LAMA-234: a device key must scope its conflict list to its own
      // host (a missing hostId fails for device keys — never a fleet leak).
      if (!deviceMayAccessHost(principalOf(store), hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
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
      const sql = `SELECT id, host_id, folder_id, path, local_mtime, remote_mtime, local_size, remote_size, status, resolution, created_at, resolved_at
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
    ({ body, set, store }) => {
      const { conflicts } = body as {
        conflicts: Array<{
          hostId: string;
          folderId: string;
          path: string;
          localMtime?: number | null;
          remoteMtime?: number | null;
          localSizeBytes?: number | null;
          remoteSizeBytes?: number | null;
        }>;
      };
      // LAMA-234: a device key may only report conflicts for its own host.
      const principal = principalOf(store);
      if (
        principal?.kind === "device" &&
        conflicts.some((c) => !deviceMayAccessHost(principal, c.hostId))
      ) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const created: Conflict[] = [];
      const now = Date.now();
      for (const c of conflicts) {
        const existing = activeDb
          .query<{ id: string; status: string }, [string, string, string]>(
            "SELECT id, status FROM conflicts WHERE host_id = ? AND folder_id = ? AND path = ?",
          )
          .get(c.hostId, c.folderId, c.path);
        const id = crypto.randomUUID();
        activeDb.run(
          `INSERT INTO conflicts
             (id, host_id, folder_id, path, local_mtime, remote_mtime, local_size, remote_size, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(host_id, folder_id, path) DO UPDATE SET
             local_mtime = excluded.local_mtime,
             remote_mtime = excluded.remote_mtime,
             local_size = excluded.local_size,
             remote_size = excluded.remote_size,
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
            c.localSizeBytes ?? null,
            c.remoteSizeBytes ?? null,
            "pending",
            now,
          ],
        );
        // Emit on any transition INTO pending: a brand-new conflict, or a
        // previously-resolved conflict that recurred (the upsert above flips
        // it back to pending). Already-pending repeats are deduped by the
        // notification cooldown.
        if (!existing || existing.status !== "pending") {
          emitNotification({
            type: "conflict_pending",
            hostId: c.hostId,
            folderId: c.folderId,
            message: `Conflict pending for ${c.path}`,
            payload: { path: c.path },
          });
        }
        const row = activeDb
          .query<ConflictRow, [string]>(
            "SELECT id, host_id, folder_id, path, local_mtime, remote_mtime, local_size, remote_size, status, resolution, created_at, resolved_at FROM conflicts WHERE id = ?",
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
            localSizeBytes: t.Optional(t.Union([t.Number(), t.Null()])),
            remoteSizeBytes: t.Optional(t.Union([t.Number(), t.Null()])),
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
    ({ params, body, set, store }) => {
      const { resolution } = body as { resolution: ConflictResolution };
      const existing = activeDb
        .query<ConflictRow, [string]>(
          "SELECT id, host_id, folder_id, path, local_mtime, remote_mtime, local_size, remote_size, status, resolution, created_at, resolved_at FROM conflicts WHERE id = ?",
        )
        .get(params.id);
      if (!existing) {
        set.status = 404;
        return { error: "Conflict not found" };
      }
      // LAMA-234: only the conflict's owning host may resolve it.
      if (!deviceMayAccessHost(principalOf(store), existing.host_id)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      activeDb.run(
        "UPDATE conflicts SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ?",
        [resolution, Date.now(), params.id],
      );
      const row = activeDb
        .query<ConflictRow, [string]>(
          "SELECT id, host_id, folder_id, path, local_mtime, remote_mtime, local_size, remote_size, status, resolution, created_at, resolved_at FROM conflicts WHERE id = ?",
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
