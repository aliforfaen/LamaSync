import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import { broadcast } from "../ws.ts";
import { canonicalDestinationKey } from "@lamasync/core";
import type { FolderBackend, FolderType, OperationLog, OperationStatus } from "@lamasync/core";
import { deviceMayAccessHost, principalOf } from "../auth.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const DEFAULT_LOCK_TTL = 1200;

// Test seam: allows unit tests to substitute the production DB.
let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

interface LockRow {
  destination_key: string;
  folder_id: string | null;
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
  destination_key: string;
  folder_id: string | null;
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
  trigger: string | null;
}

interface LockFolderRow {
  id: string;
  name: string;
  type: FolderType;
  backend: FolderBackend | null;
  backend_id: string | null;
  s3_bucket: string | null;
}

interface LockAssignmentRow {
  host_id: string;
  remote_name: string | null;
  destination: string | null;
  restic_repository: string | null;
  restic_password: string | null;
}

interface LockResticBackendRow {
  restic_repository: string | null;
  restic_password: string | null;
}

function folderBackend(value: FolderBackend | null): FolderBackend {
  return value === "s3" || value === "local" || value === "nfs" || value === "restic"
    ? value
    : "sftp";
}

/**
 * Compute the lock identity from server-owned assignment/folder state. The
 * optional client key remains accepted for legacy callers only when no
 * matching assignment exists; an authenticated daemon must not be able to
 * choose a second key for the same physical destination.
 */
function canonicalKeyForAcquire(
  folderId: string,
  hostId: string,
  requestedKey: string | undefined,
): string {
  const folder = activeDb
    .query<LockFolderRow, [string]>(
      "SELECT id, name, type, backend, backend_id, s3_bucket FROM folders WHERE id = ?",
    )
    .get(folderId);
  const assignment = activeDb
    .query<LockAssignmentRow, [string, string]>(
      "SELECT host_id, remote_name, destination, restic_repository, restic_password FROM folder_assignments WHERE folder_id = ? AND host_id = ?",
    )
    .get(folderId, hostId);
  if (folder && assignment) {
    let repository = assignment.restic_repository;
    let password = assignment.restic_password;
    if (!repository && folder.backend === "restic" && folder.backend_id) {
      const backend = activeDb
        .query<LockResticBackendRow, [string]>(
          "SELECT restic_repository, restic_password FROM backends WHERE id = ?",
        )
        .get(folder.backend_id);
      repository = backend?.restic_repository ?? null;
      password = backend?.restic_password ?? null;
    }
    return canonicalDestinationKey(
      {
        id: folder.id,
        name: folder.name,
        type: folder.type,
        backend: folderBackend(folder.backend),
        backendId: folder.backend_id,
        s3Bucket: folder.s3_bucket,
      },
      {
        hostId: assignment.host_id,
        remoteName: assignment.remote_name,
        destination: assignment.destination,
        resticRepository: repository,
        resticPassword: password,
      },
    );
  }
  const trimmed = requestedKey?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : `folder:${folderId}`;
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
    trigger: (r.trigger === "watch" || r.trigger === "schedule" || r.trigger === "manual")
      ? r.trigger
      : null,
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
    const sql = `SELECT id, timestamp, host_id, folder_id, operation, status, summary, details, duration_ms, trigger
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
    ({ body: { folderId, hostId, destinationKey }, set, store }) => {
      // LAMA-234: locks are host-bound; a device key may only lock as its
      // own host.
      if (!deviceMayAccessHost(principalOf(store), hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      // LAMA-294: derive the canonical identity from server-owned config.
      // The request field is only a compatibility fallback for old callers
      // that have no matching assignment row; it is never authoritative for
      // a real daemon assignment.
      const key = canonicalKeyForAcquire(folderId, hostId, destinationKey);
      const now = Date.now();
      const lock = activeDb
        .query<LockRow, [string]>(
          `SELECT destination_key, folder_id, locked_by, locked_at, lock_ttl, lock_id
           FROM folder_locks
           WHERE destination_key = ?`,
        )
        .get(key);

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
          destinationKey: key,
          remainingSec: Math.ceil((lockedAt + lockTtl * 1000 - now) / 1000),
        };
      }

      const lockId = crypto.randomUUID();
      activeDb
        .query<never, [string, string, string, number, number, string]>(
          `INSERT OR REPLACE INTO folder_locks
             (destination_key, folder_id, locked_by, locked_at, lock_ttl, lock_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(key, folderId, hostId, now, DEFAULT_LOCK_TTL, lockId);
      broadcast({ kind: "lock", folderId, hostId, action: "acquired", lockId, destinationKey: key });

      return { lockId, ttl: DEFAULT_LOCK_TTL, acquired: true, destinationKey: key };
    },
    {
      body: t.Object({
        folderId: t.String(),
        hostId: t.String(),
        destinationKey: t.Optional(t.String()),
      }),
      detail: {
        summary: "Acquire a canonical destination operation lock",
        tags: ["Operations"],
      },
    },
  )
  .post(
    "/operations/heartbeat",
    ({ body: { folderId, hostId, lockId, destinationKey }, set, store }) => {
      // LAMA-234: host-bound like acquire.
      if (!deviceMayAccessHost(principalOf(store), hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const key = (destinationKey && destinationKey.trim().length > 0)
        ? destinationKey
        : canonicalKeyForAcquire(folderId, hostId, undefined);
      const lock = activeDb
        .query<LockRow, [string]>(
          `SELECT locked_by, locked_at, lock_ttl, lock_id
           FROM folder_locks
           WHERE destination_key = ?`,
        )
        .get(key);

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
          "UPDATE folder_locks SET locked_at = ? WHERE destination_key = ?",
        )
        .run(now, key);

      return { ok: true, renewedAt: now };
    },
    {
      body: t.Object({
        folderId: t.String(),
        hostId: t.String(),
        lockId: t.Optional(t.String()),
        destinationKey: t.Optional(t.String()),
      }),
      detail: {
        summary: "Renew a canonical destination operation lock",
        tags: ["Operations"],
      },
    },
  )
  .post(
    "/operations/release",
    ({ body: { folderId, hostId, status, lockId, destinationKey }, set, store }) => {
      // LAMA-234: host-bound like acquire/heartbeat.
      if (!deviceMayAccessHost(principalOf(store), hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const key = (destinationKey && destinationKey.trim().length > 0)
        ? destinationKey
        : canonicalKeyForAcquire(folderId, hostId, undefined);
      const lock = activeDb
        .query<LockOwnerRow, [string]>(
          `SELECT locked_by, lock_id
           FROM folder_locks
           WHERE destination_key = ?`,
        )
        .get(key);

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
        .query<never, [string]>("DELETE FROM folder_locks WHERE destination_key = ?")
        .run(key);
      activeDb
        .query<never, [number, string, string, string]>(
          `UPDATE schedule_state
           SET last_run = ?, last_status = ?
           WHERE folder_assignment_id = (
             SELECT id FROM folder_assignments WHERE folder_id = ? AND host_id = ?
           )`,
        )
        .run(now, status, folderId, hostId);
      broadcast({ kind: "lock", folderId, hostId, action: "released", lockId: releasedLockId, status, destinationKey: key });

      return { ok: true };
    },
    {
      body: t.Object({
        folderId: t.String(),
        hostId: t.String(),
        status: t.String(),
        summary: t.Optional(t.String()),
        lockId: t.Optional(t.String()),
        destinationKey: t.Optional(t.String()),
      }),
      detail: {
        summary: "Release a canonical destination operation lock",
        tags: ["Operations"],
      },
    },
  )
  .get(
    "/operations/locks",
    ({ store }) => {
      // LAMA-234: device keys see only their own host's locks (the daemon's
      // stale-lock recovery filters client-side by lockedBy); master/admin
      // see every lock.
      const principal = principalOf(store);
      const where =
        principal?.kind === "device"
          ? "WHERE locked_by = ?"
          : "WHERE locked_by IS NOT NULL";
      const args: string[] = principal?.kind === "device" && principal.hostId ? [principal.hostId] : [];
      const rows = activeDb
        .query<ActiveLockRow, string[]>(
          `SELECT destination_key, folder_id, locked_by, locked_at, lock_ttl
           FROM folder_locks
           ${where}`,
        )
        .all(...args);

      return rows.map((row) => ({
        destinationKey: row.destination_key,
        folderId: row.folder_id,
        lockedBy: row.locked_by,
        lockedAt: row.locked_at,
        lockTtl: row.lock_ttl,
      }));
    },
    {
      detail: {
        summary: "List active destination operation locks",
        tags: ["Operations"],
      },
    },
  );

/**
 * Delete `folder_locks` rows whose `locked_at + lock_ttl*1000` is at or
 * before `now`. Rows survive a daemon crash because release only runs
 * inside the daemon's try/finally; without this reaper an orphaned lock
 * stays visible until the next acquire overwrites it — which never
 * happens for folders no other host is watching, so the row pollutes
 * `GET /operations/locks` indefinitely and `acquire` from any other host
 * gets `409 folder_locked` until either (a) the reaper runs or (b) the
 * folder is never re-acquired at all.
 *
 * Broadcasts one `lock` event with action `"reaped"` per deleted row so
 * connected TUI/web clients can drop the stale lock from their view.
 *
 * Idempotent; safe to call from a startup hook and a periodic timer.
 *
 * LAMA-244.
 */
export function reapExpiredFolderLocks(now: number = Date.now()): {
  deleted: number;
  folderIds: string[];
} {
  // Treat a row as expired when (locked_at + lock_ttl*1000) <= now. Rows
  // with NULL locked_at / lock_ttl are kept (defensive; shouldn't exist
  // in production but we don't want to nuke a half-built row).
  const expired = activeDb
    .query<{ folderId: string; lockedBy: string | null }, [number]>(
      `SELECT folder_id AS folderId, locked_by AS lockedBy
       FROM folder_locks
       WHERE locked_at IS NOT NULL
         AND lock_ttl IS NOT NULL
         AND (locked_at + lock_ttl * 1000) <= ?`,
    )
    .all(now);
  if (expired.length === 0) return { deleted: 0, folderIds: [] };

  const result = activeDb.run(
    `DELETE FROM folder_locks
     WHERE locked_at IS NOT NULL
       AND lock_ttl IS NOT NULL
       AND (locked_at + lock_ttl * 1000) <= ?`,
    [now],
  );
  const deleted = Number(result.changes ?? 0);
  for (const row of expired) {
    broadcast({
      kind: "lock",
      folderId: row.folderId,
      hostId: row.lockedBy ?? "unknown",
      action: "reaped",
    });
  }
  return { deleted, folderIds: expired.map((row) => row.folderId) };
}
