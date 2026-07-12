import { Elysia, t } from "elysia";
import { db } from "../db.ts";
import type { OperationStatus } from "@lamasync/core";

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
    } = body as {
      hostId: string;
      folderId?: string | null;
      operation: string;
      status: OperationStatus;
      summary?: string | null;
      details?: string | null;
      timestamp?: number;
    };
    const ts = typeof timestamp === "number" ? timestamp : Date.now();

    db.run(
      `INSERT INTO operation_log (timestamp, host_id, folder_id, operation, status, summary, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ts, hostId, folderId ?? null, operation, status, summary ?? null, details ?? null],
    );

    if (folderId) {
      // Update schedule_state if a matching assignment exists.
      const assignment = db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM folder_assignments WHERE folder_id = ? AND host_id = ?",
        )
        .get(folderId, hostId);
      if (assignment) {
        // Idempotent upsert keyed on folder_assignment_id.
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
