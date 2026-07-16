import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import { broadcast } from "../ws.ts";
import type { OperationLog, OperationStatus } from "@lamasync/core";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const DEFAULT_LOCK_TTL = 1200;

// Test seam: allows unit tests to substitute the production DB.
let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

interface LockRow {
  locked_by: string | null;
  locked_at: number | null;
  lock_ttl: number | null;
  lock_id: string | null;
}

interface LockOwnerRow {
  locked_by: string | null;
  lock_id: string | null;
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
    const { hostId, status, folderId, limit, offset } = query as {
      hostId?: string;
      status?: string;
      folderId?: string;
      limit?: number | string;
      offset?: number | string;
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

    const offNum =
      typeof offset === "number"
        ? offset
        : offset
          ? Number.parseInt(offset, 10)
          : 0;
    const safeOffset = Number.isFinite(offNum) && offNum > 0 ? Math.floor(offNum) : 0;

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT id, timestamp, host_id, folder_id, operation, status, summary, details, duration_ms
                 FROM operation_log
                 ${whereSql}
                 ORDER BY timestamp DESC
                 LIMIT ? OFFSET ?`;
    const rows = activeDb
      .query<OpRow, (string | number)[]>(sql)
      .all(...args, safeLimit, safeOffset);
    return rows.map(rowToLog);
  },
  {
    query: t.Object({
      hostId: t.Optional(t.String()),
      status: t.Optional(t.String()),
      folderId: t.Optional(t.String()),
      limit: t.Optional(t.Union([t.Number(), t.String()])),
      offset: t.Optional(t.Union([t.Number(), t.String()])),
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
      const lock = activeDb
        .query<LockRow, [string]>(
          `SELECT locked_by, locked_at, lock_ttl, lock_id
           FROM folder_locks
           WHERE folder_id = ?`,
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

      const lockId = crypto.randomUUID();
      activeDb
        .query<never, [string, string, number, number, string]>(
          `INSERT OR REPLACE INTO folder_locks
             (folder_id, locked_by, locked_at, lock_ttl, lock_id)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(folderId, hostId, now, DEFAULT_LOCK_TTL, lockId);
      broadcast({ kind: "lock", folderId, hostId, action: "acquired", lockId });

      return { lockId, ttl: DEFAULT_LOCK_TTL, acquired: true };
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
    ({ body: { folderId, hostId, lockId }, set }) => {
      const lock = activeDb
        .query<LockRow, [string]>(
          `SELECT locked_by, locked_at, lock_ttl, lock_id
           FROM folder_locks
           WHERE folder_id = ?`,
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

      const now = Date.now();
      const lockedAt = lock.locked_at ?? 0;
      const lockTtl = lock.lock_ttl ?? DEFAULT_LOCK_TTL;
      if (now - lockedAt >= lockTtl * 1000) {
        set.status = 404;
        return { error: "lock_expired" };
      }
      if (lockId !== undefined && lockId !== lock.lock_id) {
        set.status = 409;
        return { error: "lock_id_mismatch" };
      }

      activeDb
        .query<never, [number, string]>(
          "UPDATE folder_locks SET locked_at = ? WHERE folder_id = ?",
        )
        .run(now, folderId);

      return { ok: true, renewedAt: now };
    },
    {
      body: t.Object({
        folderId: t.String(),
        hostId: t.String(),
        lockId: t.Optional(t.String()),
      }),
      detail: {
        summary: "Renew a folder operation lock",
        tags: ["Operations"],
      },
    },
  )
  .post(
    "/operations/release",
    ({ body: { folderId, hostId, status, lockId }, set }) => {
      const lock = activeDb
        .query<LockOwnerRow, [string]>(
          `SELECT locked_by, lock_id
           FROM folder_locks
           WHERE folder_id = ?`,
        )
        .get(folderId);

      if (!lock) {
        set.status = 404;
        return { error: "no_active_lock" };
      }
      if (lock.locked_by !== hostId) {
        set.status = 409;
        return { error: "lock_held_by_other" };
      }
      if (lockId !== undefined && lockId !== lock.lock_id) {
        set.status = 409;
        return { error: "lock_id_mismatch" };
      }

      const releasedLockId = lock.lock_id ?? undefined;
      const now = Date.now();
      activeDb
        .query<never, [string]>("DELETE FROM folder_locks WHERE folder_id = ?")
        .run(folderId);
      activeDb
        .query<never, [number, string, string, string]>(
          `UPDATE schedule_state
           SET last_run = ?, last_status = ?
           WHERE folder_assignment_id = (
             SELECT id FROM folder_assignments WHERE folder_id = ? AND host_id = ?
           )`,
        )
        .run(now, status, folderId, hostId);
      broadcast({ kind: "lock", folderId, hostId, action: "released", lockId: releasedLockId, status });

      return { ok: true };
    },
    {
      body: t.Object({
        folderId: t.String(),
        hostId: t.String(),
        status: t.String(),
        summary: t.Optional(t.String()),
        lockId: t.Optional(t.String()),
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
      const rows = activeDb
        .query<ActiveLockRow, []>(
          `SELECT folder_id, locked_by, locked_at, lock_ttl
           FROM folder_locks
           WHERE locked_by IS NOT NULL`,
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


