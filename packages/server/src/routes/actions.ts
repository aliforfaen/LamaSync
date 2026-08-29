// Queued-action routes (LAMA-198). The control plane (Web UI) enqueues
// actions for a specific host; the daemon polls `GET /actions/pending`,
// executes each one, and acks via `POST /actions/:id/complete`. The
// completion also inserts an `operation_log` row so the audit trail stays
// uniform with regular sync/backup reports — `Operations` and `Actions`
// are two views of the same underlying log.

import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import {
  type QueuedAction,
  type QueuedActionStatus,
  type QueuedActionType,
  type WSEvent,
} from "@lamasync/core";
import { broadcast } from "../ws.ts";
import { deviceMayAccessHost, principalOf, requireAdmin } from "../auth.ts";

const ACTION_TYPES: QueuedActionType[] = [
  "trigger_sync",
  "trigger_backup",
  "check_update",
  "refresh_config",
];

const PENDING_TAKE_LIMIT = 10;
const ACTION_HISTORY_LIMIT = 50;
const ACTION_HISTORY_MAX_LIMIT = 200;
// LAMA-232: an action claimed by a daemon that died before acking is stuck
// in 'taken' forever. Sweeps flip taken rows older than this back to
// 'pending' so the next poll re-claims them. Long syncs legitimately take
// minutes, so 10 min is a safe distance from any in-flight execution.
const STALE_TAKEN_MS = 10 * 60_000;

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

interface ActionRow {
  id: string;
  host_id: string;
  type: string;
  payload: string | null;
  status: string;
  created_at: number;
  taken_at: number | null;
  completed_at: number | null;
  result: string | null;
}

function rowToAction(row: ActionRow): QueuedAction {
  let payload: Record<string, unknown> | null = null;
  if (row.payload) {
    try {
      const parsed: unknown = JSON.parse(row.payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // ignore malformed payloads — null is the safe fallback for the wire
    }
  }
  return {
    id: row.id,
    hostId: row.host_id,
    type: row.type as QueuedActionType,
    payload,
    status: row.status as QueuedActionStatus,
    createdAt: row.created_at,
    takenAt: row.taken_at,
    completedAt: row.completed_at,
    result: row.result,
  };
}

const ACTION_SELECT =
  "SELECT id, host_id, type, payload, status, created_at, taken_at, completed_at, result FROM queued_actions";

function isActionType(value: unknown): value is QueuedActionType {
  return (
    typeof value === "string" &&
    ACTION_TYPES.includes(value as QueuedActionType)
  );
}

function isCompletionStatus(value: unknown): value is "done" | "failed" {
  return value === "done" || value === "failed";
}

/**
 * LAMA-232: flip 'taken' actions older than STALE_TAKEN_MS back to
 * 'pending' (clearing taken_at) so a daemon that died mid-execution
 * doesn't orphan them forever. Called on every daemon poll; the next poll
 * re-claims and re-executes the survivors.
 */
export function reapStaleTakenActions(database: Database): number {
  const cutoff = Date.now() - STALE_TAKEN_MS;
  const result = database.run(
    `UPDATE queued_actions
       SET status = 'pending', taken_at = NULL
       WHERE status = 'taken' AND taken_at IS NOT NULL AND taken_at < ?`,
    [cutoff],
  );
  return Number(result.changes ?? 0);
}

export const actionsRoutes = new Elysia({ prefix: "/api/v1" })
  .post(
    "/hosts/:hostId/actions",
    ({ params, body, set, store }) => {
      const { type, payload } = body as {
        type: QueuedActionType;
        payload?: Record<string, unknown> | null;
      };
      // Enqueueing is a control-plane action. Daemons only claim and ack
      // queued work, so a stolen device credential must never create work.
      if (!requireAdmin({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!isActionType(type)) {
        set.status = 400;
        return { error: `Invalid action type: ${String(type)}` };
      }
      const host = activeDb
        .query<{ id: string }, [string]>("SELECT id FROM hosts WHERE id = ?")
        .get(params.hostId);
      if (!host) {
        set.status = 404;
        return { error: "Host not found" };
      }
      const id = crypto.randomUUID();
      const createdAt = Date.now();
      const payloadText =
        payload === undefined || payload === null ? null : JSON.stringify(payload);
      activeDb.run(
        `INSERT INTO queued_actions
           (id, host_id, type, payload, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        [id, params.hostId, type, payloadText, createdAt],
      );
      const row = activeDb
        .query<ActionRow, [string]>(`${ACTION_SELECT} WHERE id = ?`)
        .get(id);
      if (!row) {
        set.status = 500;
        return { error: "Failed to load action after insert" };
      }
      const action = rowToAction(row);
      const event: WSEvent = { kind: "action", action };
      broadcast(event);
      set.status = 201;
      return action;
    },
    {
      params: t.Object({ hostId: t.String() }),
      body: t.Object({
        type: t.Union([
          t.Literal("trigger_sync"),
          t.Literal("trigger_backup"),
          t.Literal("check_update"),
          t.Literal("refresh_config"),
        ]),
        payload: t.Optional(
          t.Union([t.Record(t.String(), t.Unknown()), t.Null()]),
        ),
      }),
      detail: {
        summary: "Enqueue an action for a host (control-plane → daemon)",
        tags: ["Actions"],
        responses: {
          201: { description: "Action queued" },
          400: { description: "Invalid action type" },
          404: { description: "Host not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/actions/pending",
    ({ query, set, store }) => {
      const { hostId, limit } = query as {
        hostId?: string;
        limit?: number | string;
      };
      // LAMA-234: an action queue belongs to one host; a device key may
      // only claim its own host's pending actions.
      if (!deviceMayAccessHost(principalOf(store), hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!hostId) {
        set.status = 400;
        return { error: "hostId is required" };
      }
      const requested =
        typeof limit === "number"
          ? limit
          : limit
            ? Number.parseInt(limit, 10)
            : PENDING_TAKE_LIMIT;
      const safeLimit = Number.isFinite(requested)
        ? Math.min(Math.max(1, requested), ACTION_HISTORY_MAX_LIMIT)
        : PENDING_TAKE_LIMIT;

      // Atomically select up to `safeLimit` pending ids for this host,
      // mark them taken, then return the full rows. Bun SQLite is sync, so
      // a transaction here is mostly for the "no other writer sneaks in
      // between SELECT and UPDATE" guarantee.
      // LAMA-232: first reap stale 'taken' rows (a daemon that died before
      // acking) so they are re-claimed by this poll instead of orphaned.
      reapStaleTakenActions(activeDb);
      const ids = activeDb.transaction(() => {
        const pendingRows = activeDb
          .query<{ id: string }, [string, number]>(
            `${ACTION_SELECT}
             WHERE host_id = ? AND status = 'pending'
             ORDER BY created_at ASC
             LIMIT ?`,
          )
          .all(hostId, safeLimit);
        const takenIds = pendingRows.map((r) => r.id);
        if (takenIds.length === 0) return [] as string[];
        const placeholders = takenIds.map(() => "?").join(",");
        const now = Date.now();
        activeDb.run(
          `UPDATE queued_actions
             SET status = 'taken', taken_at = ?
             WHERE id IN (${placeholders}) AND status = 'pending'`,
          [now, ...takenIds],
        );
        return takenIds;
      })();

      if (ids.length === 0) return [] as QueuedAction[];
      const placeholders = ids.map(() => "?").join(",");
      const rows = activeDb
        .query<ActionRow, string[]>(
          `${ACTION_SELECT} WHERE id IN (${placeholders})`,
        )
        .all(...ids);
      return rows.map(rowToAction);
    },
    {
      query: t.Object({
        hostId: t.String(),
        limit: t.Optional(t.Union([t.Number(), t.String()])),
      }),
      detail: {
        summary: "Atomically claim and return pending actions for a host",
        tags: ["Actions"],
        responses: {
          200: { description: "Taken actions" },
          400: { description: "Missing hostId" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/actions/taken",
    ({ query, set, store }) => {
      // LAMA-232: boot-time reclaim. A freshly booted daemon has no
      // in-flight work, so every 'taken' action for the host was orphaned
      // by the previous incarnation — return them all and let the daemon
      // re-execute + ack. The periodic reaper (inside /actions/pending)
      // covers the "daemon alive but execution silently died" case.
      const { hostId } = query as { hostId?: string };
      // LAMA-234: same host scoping as /actions/pending.
      if (!deviceMayAccessHost(principalOf(store), hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!hostId) {
        set.status = 400;
        return { error: "hostId is required" };
      }
      const rows = activeDb
        .query<ActionRow, [string]>(
          `${ACTION_SELECT}
           WHERE host_id = ? AND status = 'taken'
           ORDER BY created_at ASC`,
        )
        .all(hostId);
      return rows.map(rowToAction);
    },
    {
      query: t.Object({ hostId: t.String() }),
      detail: {
        summary: "Return all 'taken' actions for a host (daemon boot reclaim)",
        tags: ["Actions"],
        responses: {
          200: { description: "Taken actions for the host" },
          400: { description: "Missing hostId" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/actions/:id/complete",
    ({ params, body, set, store }) => {
      const { status, result } = body as {
        status: "done" | "failed";
        result?: string | null;
      };
      if (!isCompletionStatus(status)) {
        set.status = 400;
        return { error: `Invalid completion status: ${String(status)}` };
      }
      const existing = activeDb
        .query<{ id: string; host_id: string; type: string }, [string]>(
          "SELECT id, host_id, type FROM queued_actions WHERE id = ?",
        )
        .get(params.id);
      if (!existing) {
        set.status = 404;
        return { error: "Action not found" };
      }
      // LAMA-234: only the action's owning host may ack it.
      if (!deviceMayAccessHost(principalOf(store), existing.host_id)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const completedAt = Date.now();
      activeDb.run(
        `UPDATE queued_actions
           SET status = ?, completed_at = ?, result = ?
           WHERE id = ?`,
        [status, completedAt, result ?? null, params.id],
      );

      // Audit trail: mirror the action outcome into operation_log so the
      // dashboard and `GET /operations` reflect the manual triggers
      // uniformly with regular sync/backup reports.
      activeDb.run(
        `INSERT INTO operation_log
           (timestamp, host_id, folder_id, operation, status, summary, details, duration_ms)
         VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)`,
        [completedAt, existing.host_id, existing.type, status, result ?? null],
      );

      const row = activeDb
        .query<ActionRow, [string]>(`${ACTION_SELECT} WHERE id = ?`)
        .get(params.id);
      if (!row) {
        set.status = 500;
        return { error: "Failed to load action after completion" };
      }
      const action = rowToAction(row);
      const event: WSEvent = { kind: "action", action };
      broadcast(event);
      return action;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        status: t.Union([t.Literal("done"), t.Literal("failed")]),
        result: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary: "Mark a queued action done or failed (daemon ack)",
        tags: ["Actions"],
        responses: {
          200: { description: "Action completed" },
          400: { description: "Invalid status" },
          404: { description: "Action not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/hosts/:hostId/actions",
    ({ params, query, store, set }) => {
      // Action history is a control-plane view. Daemons use /actions/pending
      // and /actions/taken instead, so device credentials do not receive it.
      if (!requireAdmin({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const { status, limit } = query as {
        status?: string;
        limit?: number | string;
      };
      const where: string[] = ["host_id = ?"];
      const args: (string | number)[] = [params.hostId];
      if (status) {
        where.push("status = ?");
        args.push(status);
      }
      const requested =
        typeof limit === "number"
          ? limit
          : limit
            ? Number.parseInt(limit, 10)
            : ACTION_HISTORY_LIMIT;
      const safeLimit = Number.isFinite(requested)
        ? Math.min(Math.max(1, requested), ACTION_HISTORY_MAX_LIMIT)
        : ACTION_HISTORY_LIMIT;
      const rows = activeDb
        .query<ActionRow, (string | number)[]>(
          `${ACTION_SELECT}
           WHERE ${where.join(" AND ")}
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(...args, safeLimit);
      return rows.map(rowToAction);
    },
    {
      params: t.Object({ hostId: t.String() }),
      query: t.Object({
        status: t.Optional(t.String()),
        limit: t.Optional(t.Union([t.Number(), t.String()])),
      }),
      detail: {
        summary: "List queued actions for a host, newest first",
        tags: ["Actions"],
        responses: {
          200: { description: "Action history" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );
