import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import type { OperationStatus, WSEvent, OperationLog } from "@lamasync/core";
import { broadcast } from "../ws.ts";
import { deviceMayAccessHost, principalOf } from "../auth.ts";
import {
  __setDb as __setNotificationDb,
  emitNotification,
} from "../notifications.ts";
import { invalidateFolderSize, invalidateStorageReport } from "../stats.ts";

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
  __setNotificationDb(next);
}

export const reportRoutes = new Elysia({ prefix: "/api/v1" }).post(
  "/report",
  ({ body, set, store }) => {
    const {
      hostId,
      folderId,
      operation,
      status,
      summary,
      details,
      timestamp,
      durationMs,
      trigger,
    } = body as {
      hostId: string;
      folderId?: string | null;
      operation: string;
      status: OperationStatus;
      summary?: string | null;
      details?: string | null;
      timestamp?: number;
      durationMs?: number | null;
      // LAMA-302: trigger origin (watch | schedule | manual). Optional and
      // additive — older daemons report no trigger.
      trigger?: string | null;
    };
    // LAMA-234: operation reports are host-bound; a device key may only
    // report operations for its own host.
    if (!deviceMayAccessHost(principalOf(store), hostId)) {
      set.status = 403;
      return { error: "Forbidden" };
    }
    const ts = typeof timestamp === "number" ? timestamp : Date.now();

    const result = activeDb.run(
      `INSERT INTO operation_log (timestamp, host_id, folder_id, operation, status, summary, details, duration_ms, trigger)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ts,
        hostId,
        folderId ?? null,
        operation,
        status,
        summary ?? null,
        details ?? null,
        durationMs ?? null,
        trigger && trigger !== "" ? trigger : null,
      ],
    );
    const opId = Number(result.lastInsertRowid);

    // LAMA-224: a completed sync/backup/dotfile changes the stored size —
    // drop the cached storage report and the folder's size entry.
    if (operation === "sync" || operation === "backup" || operation === "dotfile") {
      invalidateStorageReport();
      if (folderId) invalidateFolderSize(folderId);
    }

    if (folderId) {
      const assignment = activeDb
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM folder_assignments WHERE folder_id = ? AND host_id = ?",
        )
        .get(folderId, hostId);
      if (assignment) {
        activeDb.run(
          `INSERT INTO schedule_state (folder_assignment_id, last_run, last_status)
           VALUES (?, ?, ?)
           ON CONFLICT(folder_assignment_id) DO UPDATE SET
             last_run = excluded.last_run,
             last_status = excluded.last_status`,
          [assignment.id, ts, status],
        );
      }
    }

    // Broadcast a typed event to live subscribers.
    const entry: OperationLog = {
      id: opId,
      timestamp: ts,
      hostId,
      folderId: folderId ?? null,
      operation,
      status,
      summary: summary ?? null,
      details: details ?? null,
      durationMs: durationMs ?? null,
      trigger: trigger && trigger !== "" ? trigger as OperationLog["trigger"] : null,
    };
    const event: WSEvent = { kind: "operation", entry };
    broadcast(event);

    if (status === "failed") {
      emitNotification({
        type: "operation_failed",
        hostId,
        folderId,
        message: summary || `${operation} failed${folderId ? ` for ${folderId}` : ""}`,
        payload: { operation },
      });
    } else if (status === "success") {
      emitNotification({
        type: "operation_success",
        hostId,
        folderId,
        message: summary || `${operation} succeeded${folderId ? ` for ${folderId}` : ""}`,
      });
    }

    set.status = 204;
    return null;
  },
  {
    body: t.Object({
      hostId: t.String(),
      folderId: t.Optional(t.Union([t.String(), t.Null()])),
      operation: t.String(),
      status: t.Union([
        t.Literal("started"),
        t.Literal("success"),
        t.Literal("failed"),
        t.Literal("conflict"),
        t.Literal("retry"),
        t.Literal("recovery"),
      ]),
      summary: t.Optional(t.Union([t.String(), t.Null()])),
      details: t.Optional(t.Union([t.String(), t.Null()])),
      timestamp: t.Optional(t.Number()),
      durationMs: t.Optional(t.Union([t.Number(), t.Null()])),
      dotfileAppName: t.Optional(t.Union([t.String(), t.Null()])),
      dotfileDirection: t.Optional(
        t.Union([t.Literal("upload"), t.Literal("download"), t.Null()]),
      ),
      trigger: t.Optional(
        t.Union([t.Literal("watch"), t.Literal("schedule"), t.Literal("manual"), t.Null()]),
      ),
    }),
    detail: {
      summary: "Report an operation result (sync, backup, etc.)",
      tags: ["Operations"],
      responses: {
        204: { description: "Recorded" },
        401: { description: "Unauthorized" },
      },
    },
  },
);
