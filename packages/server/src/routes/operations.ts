import { Elysia, t } from "elysia";
import { db } from "../db.ts";
import { broadcast } from "../ws.ts";
import type { OperationLog, OperationStatus } from "@lamasync/core";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const DEFAULT_LOCK_TTL = 1200;

interface LockStateRow {
  id: string;
  locked_by: string | null;
  locked_at: number | null;
  lock_ttl: number | null;
}

interface LockOwnerRow {
  locked_by: string | null;
}

interface ActiveLockRow {
  folder_id: string;
  locked_by: string;
  locked_at: number;
  lock_ttl: number;
}

interface OpRow {
  id: number;
  timestamp: number;
  host_id: string;
  folder_id: string | null;
  operation: string;
  status: string;
  summary: string | null;
  details: string | null;
  duration_ms: number | null;
}

function rowToLog(r: OpRow): OperationLog {
  return {
    id: r.id,
    timestamp: r.timestamp,
    hostId: r.host_id,
    folderId: r.folder_id,
    operation: r.operation,
    status: r.status as OperationStatus,
    summary: r.summary,
    details: r.details,
    durationMs: r.duration_ms,
  };
}

export const operationsRoutes = new Elysia({ prefix: "/api/v1" }).get(
  "/operations",
  ({ query }) => {
    const { hostId, status, folderId, limit } = query as {
      hostId?: string;
      status?: string;
      folderId?: string;
      limit?: number | string;
    };

    const where: string[] = [];
    const args: (string | number)[] = [];

    if (hostId) {
      where.push("host_id = ?");
      args.push(hostId);
    }
    if (status) {
      where.push("status = ?");
      args.push(status);
    }
    if (folderId) {
      where.push("folder_id = ?");
      args.push(folderId);
    }

    const limNum =
      typeof limit === "number"
        ? limit
        : limit
          ? Number.parseInt(limit, 10)
          : DEFAULT_LIMIT;
    const safeLimit = Number.isFinite(limNum)
      ? Math.min(Math.max(1, limNum), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT id, timestamp, host_id, folder_id, operation, status, summary, details, duration_ms
                 FROM operation_log
                 ${whereSql}
                 ORDER BY timestamp DESC
                 LIMIT ?`;
    const rows = db.query<OpRow, (string | number)[]>(sql).all(...args, safeLimit);
    return rows.map(rowToLog);
  },
  {
    query: t.Object({
      hostId: t.Optional(t.String()),
      status: t.Optional(t.String()),
      folderId: t.Optional(t.String()),
      limit: t.Optional(t.Union([t.Number(), t.String()])),
    }),
    detail: {
      summary: "Query operation log (newest first)",
      tags: ["Operations"],
      responses: {
        200: { description: "Operation log entries" },
        401: { description: "Unauthorized" },
      },
    },
  },
)
  .post(
    "/operations/acquire",
    ({ body: { folderId, hostId }, set }) => {
      const now = Date.now();
      const lock = db
        .query<LockStateRow, [string]>(
          `SELECT fa.id, ss.locked_by, ss.locked_at, ss.lock_ttl
           FROM folder_assignments fa
           LEFT JOIN schedule_state ss ON ss.folder_assignment_id = fa.id
           WHERE fa.folder_id = ?`,
        )
        .get(folderId);

      const lockedAt = lock?.locked_at;
      const lockTtl = lock?.lock_ttl ?? DEFAULT_LOCK_TTL;
      if (
        lock?.locked_by &&
        lock.locked_by !== hostId &&
        lockedAt !== null &&
        lockedAt !== undefined &&
        now - lockedAt < lockTtl * 1000
      ) {
        set.status = 409;
        return {
          error: "folder_locked",
          lockedBy: lock.locked_by,
          lockedAt,
          lockTtl,
          remainingSec: Math.ceil((lockedAt + lockTtl * 1000 - now) / 1000),
        };
      }

      db.query<never, [string, string, number, number]>(
        `INSERT OR REPLACE INTO schedule_state
           (folder_assignment_id, locked_by, locked_at, lock_ttl)
         VALUES ((SELECT id FROM folder_assignments WHERE folder_id = ?), ?, ?, ?)`,
      ).run(folderId, hostId, now, DEFAULT_LOCK_TTL);
      broadcast({ kind: "lock", folderId, hostId, action: "acquired" });

      return {
        lockId: crypto.randomUUID(),
        ttl: DEFAULT_LOCK_TTL,
        acquired: true,
      };
    },
    {
      body: t.Object({
        folderId: t.String(),
        hostId: t.String(),
      }),
      detail: {
        summary: "Acquire a folder operation lock",
        tags: ["Operations"],
      },
    },
  )
  .post(
    "/operations/heartbeat",
    ({ body: { folderId, hostId }, set }) => {
      const lock = db
        .query<LockOwnerRow, [string]>(
          `SELECT locked_by
           FROM schedule_state
           WHERE folder_assignment_id = (
             SELECT id FROM folder_assignments WHERE folder_id = ?
           )`,
        )
        .get(folderId);

      if (!lock || lock.locked_by === null) {
        set.status = 404;
        return { error: "no_active_lock" };
      }
      if (lock.locked_by !== hostId) {
        set.status = 409;
        return { error: "lock_held_by_other", lockedBy: lock.locked_by };
      }

      const renewedAt = Date.now();
      db.query<never, [number, string]>(
        `UPDATE schedule_state
         SET locked_at = ?
         WHERE folder_assignment_id = (
           SELECT id FROM folder_assignments WHERE folder_id = ?
         )`,
      ).run(renewedAt, folderId);

      return { ok: true, renewedAt };
    },
    {
      body: t.Object({
        folderId: t.String(),
        hostId: t.String(),
      }),
      detail: {
        summary: "Renew a folder operation lock",
        tags: ["Operations"],
      },
    },
  )
  .post(
    "/operations/release",
    ({ body: { folderId, hostId, status } }) => {
      db.query<never, [number, string, string]>(
        `UPDATE schedule_state
         SET locked_by = NULL, locked_at = NULL, last_run = ?, last_status = ?
         WHERE folder_assignment_id = (
           SELECT id FROM folder_assignments WHERE folder_id = ?
         )`,
      ).run(Date.now(), status, folderId);
      broadcast({ kind: "lock", folderId, hostId, action: "released", status });

      return { ok: true };
    },
    {
      body: t.Object({
        folderId: t.String(),
        hostId: t.String(),
        status: t.String(),
        summary: t.Optional(t.String()),
      }),
      detail: {
        summary: "Release a folder operation lock",
        tags: ["Operations"],
      },
    },
  )
  .get(
    "/operations/locks",
    () => {
      const rows = db
        .query<ActiveLockRow, []>(
          `SELECT fa.folder_id, ss.locked_by, ss.locked_at, ss.lock_ttl
           FROM schedule_state ss
           JOIN folder_assignments fa ON fa.id = ss.folder_assignment_id
           WHERE ss.locked_by IS NOT NULL`,
        )
        .all();

      return rows.map((row) => ({
        folderId: row.folder_id,
        lockedBy: row.locked_by,
        lockedAt: row.locked_at,
        lockTtl: row.lock_ttl,
      }));
    },
    {
      detail: {
        summary: "List active folder operation locks",
        tags: ["Operations"],
      },
    },
  );


