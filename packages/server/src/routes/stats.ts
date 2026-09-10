import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import { getStorageReport, getStorageHistory } from "../stats.ts";

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

export const statsRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/stats/storage",
    async ({ query }) => {
      const refresh = query.refresh === "1" || query.refresh === "true";
      const report = await getStorageReport(activeDb, refresh);
      return report;
    },
    {
      query: t.Object({
        refresh: t.Optional(t.String()),
      }),
      detail: {
        summary: "Storage usage report (local roots, S3 backends, restic)",
        tags: ["Stats"],
        responses: {
          200: { description: "Storage report" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/stats/storage/history",
    ({ query, set }) => {
      // LAMA-269: per-backend size time series for the growth sparkline.
      // Backends with no measured folder sizes are simply absent.
      // LAMA-328: the payload is bounded — a 90-day window by default, with one
      // point per backend per UTC day unless `granularity=raw` is asked for.
      const days = parseHistoryDays(query.days, set);
      if (days instanceof Error) return { error: days.message };
      const granularity = query.granularity ?? "day";
      if (granularity !== "day" && granularity !== "raw") {
        set.status = 400;
        return { error: `granularity must be 'day' or 'raw' (got '${granularity}')` };
      }
      const backends = getStorageHistory(activeDb, { days, granularity });
      return { backends };
    },
    {
      query: t.Object({
        days: t.Optional(t.String()),
        granularity: t.Optional(t.String()),
      }),
      detail: {
        summary: "Per-backend size time series for the growth sparkline (bounded, LAMA-269/328)",
        tags: ["Stats"],
        responses: {
          200: {
            description:
              "Map of backendId -> chronological {measuredAt, bytes}[]. `days` (default 90, max 3650) bounds the window and `granularity=day|raw` (default day) bounds the point count.",
          },
          400: { description: "Invalid days/granularity" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );

/** `days` for the history query: absent is fine; anything that is not a strict
 *  base-10 positive integer is a 400. `parseInt` used to accept values the
 *  docs promised to reject (`days=1x`, `days=1.5`); the regex is strict about
 *  the whole string, and the upper bound is a documented clamp (3650) done in
 *  `getStorageHistory`, not a 400 (LAMA-328 review finding 3). */
function parseHistoryDays(
  raw: string | undefined,
  set: { status?: number | string },
): number | undefined | Error {
  if (raw === undefined || raw === "") return undefined;
  if (!/^[0-9]+$/.test(raw)) {
    set.status = 400;
    return new Error(`days must be a positive integer (got '${raw}')`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    set.status = 400;
    return new Error(`days must be a positive integer (got '${raw}')`);
  }
  return parsed;
}
