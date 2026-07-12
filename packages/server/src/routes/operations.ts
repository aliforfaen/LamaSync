import { Elysia, t } from "elysia";
import { db } from "../db.ts";
import type { OperationLog, OperationStatus } from "@lamasync/core";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

interface OpRow {
  id: number;
  timestamp: number;
  host_id: string;
  folder_id: string | null;
  operation: string;
  status: string;
  summary: string | null;
  details: string | null;
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
  };
}

export const operationsRoutes = new Elysia({ prefix: "/api/v1" }).get(
  "/operations",
  ({ query }) => {
    const { hostId, status, limit } = query as {
      hostId?: string;
      status?: string;
      limit?: number | string;
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

    const limNum =
      typeof limit === "number"
        ? limit
        : limit
          ? Number.parseInt(limit, 10)
          : DEFAULT_LIMIT;
    const safeLimit = Number.isFinite(limNum)
      ? Math.min(Math.max(1, limNum), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT id, timestamp, host_id, folder_id, operation, status, summary, details
                 FROM operation_log
                 ${whereSql}
                 ORDER BY timestamp DESC
                 LIMIT ?`;
    const rows = db.query<OpRow, (string | number)[]>(sql).all(...args, safeLimit);
    return rows.map(rowToLog);
  },
  {
    query: t.Object({
      hostId: t.Optional(t.String()),
      status: t.Optional(t.String()),
      limit: t.Optional(t.Union([t.Number(), t.String()])),
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
);

