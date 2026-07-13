// Admin endpoints — destructive operations guarded by auth.

import { Elysia, t } from "elysia";
import { db } from "../db.ts";
import type { PruneResult } from "@lamasync/core";

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Delete operation_log entries older than `olderThanMs` ago. The most recent
 * entry per host is preserved (older than the cutoff) so the last-known status
 * of an offline host remains visible.
 *
 * Idempotent; safe to call from a startup hook and a daily timer.
 */
export function pruneOperationLog(
  olderThanMs: number,
): PruneResult {
  const cutoff = Date.now() - olderThanMs;
  // Preserve the latest operation_log row per host so the last-known status
  // of an offline host does not silently disappear after pruning.
  const lastByHost = db
    .query<{ id: number }, [number]>(
      "SELECT MAX(id) AS id FROM operation_log WHERE timestamp < ? GROUP BY host_id",
    )
    .all(cutoff);
  const excludedIds = lastByHost
    .map((r) => r.id)
    .filter((id): id is number => typeof id === "number");
  let result;
  if (excludedIds.length > 0) {
    const placeholders = excludedIds.map(() => "?").join(",");
    result = db.run(
      `DELETE FROM operation_log WHERE timestamp < ? AND id NOT IN (${placeholders})`,
      [cutoff, ...excludedIds],
    );
  } else {
    result = db.run("DELETE FROM operation_log WHERE timestamp < ?", [cutoff]);
  }
  return { deleted: result.changes, olderThanMs };
}

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
    return pruneOperationLog(provided);
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
