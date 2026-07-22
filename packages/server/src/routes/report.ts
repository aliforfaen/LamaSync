import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import type { OperationStatus, WSEvent, OperationLog } from "@lamasync/core";
import { broadcast } from "../ws.ts";

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

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
      dotfileAppName,
      dotfileDirection,
    } = body as {
      hostId: string;
      folderId?: string | null;
      operation: string;
      status: OperationStatus;
      summary?: string | null;
      details?: string | null;
      timestamp?: number;
      durationMs?: number | null;
      dotfileAppName?: string | null;
      dotfileDirection?: "upload" | "download" | null;
    };
    const ts = typeof timestamp === "number" ? timestamp : Date.now();

    const result = activeDb.run(
      `INSERT INTO operation_log (timestamp, host_id, folder_id, operation, status, summary, details, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [ts, hostId, folderId ?? null, operation, status, summary ?? null, details ?? null, durationMs ?? null],
    );
    const opId = Number(result.lastInsertRowid);

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

    // Dotfile deployment tracking (LAMA-168): a successful report that names a
    // manifest updates its last_sync_at/last_sync_direction. The host-specific
    // manifest wins; fall back to the _global manifest for the app.
    if (dotfileAppName && status === "success") {
      const manifest = activeDb
        .query<{ id: string }, [string, string, string]>(
          `SELECT id FROM dotfile_manifests
           WHERE app_name = ? AND host_id IN (?, '_global')
           ORDER BY CASE WHEN host_id = ? THEN 0 ELSE 1 END
           LIMIT 1`,
        )
        .get(dotfileAppName, hostId, hostId);
      if (manifest) {
        activeDb.run(
          `UPDATE dotfile_manifests
           SET last_sync_at = ?, last_sync_direction = ?
           WHERE id = ?`,
          [ts, dotfileDirection === "download" ? "download" : "upload", manifest.id],
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
