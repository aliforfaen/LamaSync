import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import type {
  NotificationEvent,
  NotificationSeverity,
  NotificationType,
} from "@lamasync/core";
import { db as defaultDb } from "../db.ts";
import {
  __setDb as __setNotificationDb,
  emitNotificationEvent,
} from "../notifications.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const TEST_MESSAGE = "Test notification from Admin UI";

interface NotificationRow {
  id: string;
  type: string;
  severity: string;
  message: string;
  host_id: string | null;
  folder_id: string | null;
  payload: string | null;
  created_at: number;
  ntfy_delivered: number | null;
  webhook_delivered: number | null;
}

let activeDb: Database = defaultDb;

/** Test seam: keep route queries and the event router on the same database. */
export function __setDb(next: Database): void {
  activeDb = next;
  __setNotificationDb(next);
}

function notificationType(value: string): NotificationType | null {
  switch (value) {
    case "operation_failed":
    case "operation_success":
    case "conflict_pending":
    case "host_offline":
    case "host_online":
    case "update_available":
    case "restore_failed":
    case "restore_done":
    case "test":
      return value;
    default:
      return null;
  }
}

function notificationSeverity(value: string): NotificationSeverity | null {
  switch (value) {
    case "critical":
    case "default":
    case "info":
      return value;
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePayload(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rowToNotification(row: NotificationRow): NotificationEvent | null {
  const type = notificationType(row.type);
  const severity = notificationSeverity(row.severity);
  if (type === null || severity === null) return null;
  return {
    id: row.id,
    type,
    severity,
    message: row.message,
    hostId: row.host_id,
    folderId: row.folder_id,
    payload: parsePayload(row.payload),
    createdAt: row.created_at,
    ntfyDelivered: row.ntfy_delivered === 1,
    webhookDelivered: row.webhook_delivered === 1,
  };
}

const NOTIFICATION_SELECT = `SELECT id, type, severity, message, host_id, folder_id,
  payload, created_at, ntfy_delivered, webhook_delivered
  FROM notification_events`;

export const notificationsRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/notifications",
    ({ query }) => {
      const rawLimit = query.limit;
      const parsedLimit =
        typeof rawLimit === "number"
          ? rawLimit
          : rawLimit
            ? Number.parseInt(rawLimit, 10)
            : DEFAULT_LIMIT;
      const safeLimit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(1, Math.floor(parsedLimit)), MAX_LIMIT)
        : DEFAULT_LIMIT;
      const rows = activeDb
        .query<NotificationRow, [number]>(
          `${NOTIFICATION_SELECT} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(safeLimit);
      const events: NotificationEvent[] = [];
      for (const row of rows) {
        const event = rowToNotification(row);
        if (event) events.push(event);
      }
      return events;
    },
    {
      query: t.Object({
        limit: t.Optional(t.Union([t.Number(), t.String()])),
      }),
      detail: {
        summary: "List notification events (newest first)",
        tags: ["Notifications"],
        responses: {
          200: { description: "Notification event list" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/notifications/test",
    ({ set }) => {
      const event = emitNotificationEvent({
        type: "test",
        message: TEST_MESSAGE,
      });
      if (!event) {
        set.status = 500;
        return { error: "Failed to record test notification" };
      }
      set.status = 201;
      return event;
    },
    {
      detail: {
        summary: "Send and record a test notification",
        tags: ["Notifications"],
        responses: {
          201: { description: "Test notification recorded" },
          401: { description: "Unauthorized" },
          500: { description: "Notification could not be recorded" },
        },
      },
    },
  );
