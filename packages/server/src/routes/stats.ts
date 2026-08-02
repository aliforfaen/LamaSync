import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import { getStorageReport } from "../stats.ts";

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
  );
