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
  applyChannelInput,
  deliverTestToChannel,
  emitNotificationEvent,
  getChannel,
  listChannels,
  validateChannelInput,
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
  .get(
    "/notifications/channels",
    () => listChannels(activeDb),
    {
      detail: {
        summary: "List notification channels",
        tags: ["Notifications"],
        responses: {
          200: { description: "Notification channel list" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/notifications/channels",
    ({ body, set }) => {
      const validationError = validateChannelInput(body);
      if (validationError) {
        set.status = 400;
        return { error: validationError };
      }
      const channel = applyChannelInput(
        activeDb,
        crypto.randomUUID(),
        body,
        true,
      );
      if (!channel) {
        set.status = 500;
        return { error: "Failed to create channel" };
      }
      set.status = 201;
      return channel;
    },
    {
      body: t.Object({
        kind: t.Union([t.Literal("ntfy"), t.Literal("webhook")]),
        name: t.String(),
        url: t.String(),
        enabled: t.Optional(t.Boolean()),
        severities: t.Array(
          t.Union([
            t.Literal("critical"),
            t.Literal("default"),
            t.Literal("info"),
          ]),
        ),
      }),
      detail: {
        summary: "Create a notification channel",
        tags: ["Notifications"],
        responses: {
          201: { description: "Channel created" },
          400: { description: "Invalid channel input" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .patch(
    "/notifications/channels/:channelId",
    ({ params, body, set }) => {
      const validationError = validateChannelInput(body);
      if (validationError) {
        set.status = 400;
        return { error: validationError };
      }
      const existing = getChannel(activeDb, params.channelId);
      if (!existing) {
        set.status = 404;
        return { error: "Channel not found" };
      }
      const channel = applyChannelInput(
        activeDb,
        params.channelId,
        body,
        false,
      );
      if (!channel) {
        set.status = 404;
        return { error: "Channel not found" };
      }
      return channel;
    },
    {
      params: t.Object({ channelId: t.String() }),
      body: t.Object({
        kind: t.Optional(t.Union([t.Literal("ntfy"), t.Literal("webhook")])),
        name: t.Optional(t.String()),
        url: t.Optional(t.String()),
        enabled: t.Optional(t.Boolean()),
        severities: t.Optional(
          t.Array(
            t.Union([
              t.Literal("critical"),
              t.Literal("default"),
              t.Literal("info"),
            ]),
          ),
        ),
      }),
      detail: {
        summary: "Update a notification channel",
        tags: ["Notifications"],
        responses: {
          200: { description: "Channel updated" },
          400: { description: "Invalid channel input" },
          404: { description: "Channel not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .delete(
    "/notifications/channels/:channelId",
    ({ params, set }) => {
      const result = activeDb.run(
        "DELETE FROM notification_channels WHERE id = ?",
        [params.channelId],
      );
      if (result.changes === 0) {
        set.status = 404;
        return { error: "Channel not found" };
      }
      set.status = 204;
      return null;
    },
    {
      params: t.Object({ channelId: t.String() }),
      detail: {
        summary: "Delete a notification channel",
        tags: ["Notifications"],
        responses: {
          204: { description: "Channel removed" },
          404: { description: "Channel not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/notifications/test",
    async ({ body, set }) => {
      // LAMA-221: with a channelId this delivers through ONLY that channel
      // (Admin per-channel Test button). Without a body it exercises the
      // whole record+fan-out pipeline like before.
      if (body?.channelId) {
        const result = await deliverTestToChannel(activeDb, body.channelId);
        if (!result) {
          set.status = 404;
          return { error: "Channel not found" };
        }
        return { channelId: body.channelId, ...result };
      }
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
      body: t.Optional(t.Object({ channelId: t.String() })),
      detail: {
        summary: "Send and record a test notification (optionally via one channel)",
        tags: ["Notifications"],
        responses: {
          201: { description: "Test notification recorded" },
          404: { description: "Channel not found (channelId provided)" },
          401: { description: "Unauthorized" },
          500: { description: "Notification could not be recorded" },
        },
      },
    },
  );
