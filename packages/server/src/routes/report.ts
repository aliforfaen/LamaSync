import { Elysia, t } from "elysia";
import { db } from "../db.ts";
import type { OperationStatus, WSEvent, OperationLog } from "@lamasync/core";
import { broadcast } from "../ws.ts";

export const reportRoutes = new Elysia({ prefix: "/api/v1" }).post(
  "/report",
  ({ body, set }) => {
    const {
      hostId,
      folderId,
      operation,
      status,
      summary,
      details,
      timestamp,
      durationMs,
    } = body as {
      hostId: string;
      folderId?: string | null;
      operation: string;
      status: OperationStatus;
      summary?: string | null;
      details?: string | null;
      timestamp?: number;
      durationMs?: number | null;
    };
    const ts = typeof timestamp === "number" ? timestamp : Date.now();

    const result = db.run(
      `INSERT INTO operation_log (timestamp, host_id, folder_id, operation, status, summary, details, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [ts, hostId, folderId ?? null, operation, status, summary ?? null, details ?? null, durationMs ?? null],
    );
    const opId = Number(result.lastInsertRowid);

    if (folderId) {
      const assignment = db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM folder_assignments WHERE folder_id = ? AND host_id = ?",
        )
        .get(folderId, hostId);
      if (assignment) {
        db.run(
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
    };
    const event: WSEvent = { kind: "operation", entry };
    broadcast(event);

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
      ]),
      summary: t.Optional(t.Union([t.String(), t.Null()])),
      details: t.Optional(t.Union([t.String(), t.Null()])),
      timestamp: t.Optional(t.Number()),
      durationMs: t.Optional(t.Union([t.Number(), t.Null()])),
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
