// Admin endpoints — destructive operations guarded by auth.

import { Elysia, t } from "elysia";
import { db } from "../db.ts";
import type { PruneResult } from "@lamasync/core";

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const adminRoutes = new Elysia({ prefix: "/api/v1" }).post(
  "/admin/prune",
  ({ query, set }) => {
    const q = query as { olderThanMs?: number | string };
    const provided =
      typeof q.olderThanMs === "number"
        ? q.olderThanMs
        : q.olderThanMs
          ? Number.parseInt(String(q.olderThanMs), 10)
          : DEFAULT_RETENTION_MS;
    if (!Number.isFinite(provided) || provided < 0) {
      set.status = 400;
      return { error: "olderThanMs must be a non-negative integer" };
    }
    const cutoff = Date.now() - provided;
    const result = db.run(
      "DELETE FROM operation_log WHERE timestamp < ?",
      [cutoff],
    );
    const out: PruneResult = { deleted: result.changes, olderThanMs: provided };
    return out;
  },
  {
    query: t.Object({
      olderThanMs: t.Optional(t.Union([t.Number(), t.String()])),
    }),
    detail: {
      summary: "Prune operation_log entries older than the cutoff",
      tags: ["Admin"],
      responses: {
        200: { description: "Number of rows deleted" },
        400: { description: "Invalid input" },
        401: { description: "Unauthorized" },
      },
    },
  },
);
