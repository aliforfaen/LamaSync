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

const ACTION_TYPES: QueuedActionType[] = [
  "trigger_sync",
  "trigger_backup",
  "check_update",
  "refresh_config",
];

const PENDING_TAKE_LIMIT = 10;
const ACTION_HISTORY_LIMIT = 50;
const ACTION_HISTORY_MAX_LIMIT = 200;

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

export const actionsRoutes = new Elysia({ prefix: "/api/v1" })
  .post(
    "/hosts/:hostId/actions",
    ({ params, body, set }) => {
      const { type, payload } = body as {
        type: QueuedActionType;
        payload?: Record<string, unknown> | null;
      };
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
    ({ query, set }) => {
      const { hostId, limit } = query as {
        hostId?: string;
        limit?: number | string;
      };
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
  .post(
    "/actions/:id/complete",
    ({ params, body, set }) => {
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
    ({ params, query }) => {
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