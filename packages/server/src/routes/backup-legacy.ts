import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import { principalOf, requireAdmin } from "../auth.ts";
import { pruneLegacyRoots, reportLegacyRoots } from "../legacy-root.ts";

// Test seam: allows unit tests to substitute the production DB.
let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

export const backupLegacyRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/backups/legacy-root",
    ({ set, store, query }) => {
      if (!requireAdmin({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      // Sizes are opt-in: computing rclone size per child is far too slow for
      // a default dry-run against S3. The fast path lists orphan names only.
      const includeSizes = query.sizes === true || query.sizes === "true" || query.sizes === "1";
      return reportLegacyRoots(activeDb, { includeSizes });
    },
    {
      query: t.Object({
        sizes: t.Optional(t.Union([t.String(), t.Boolean()])),
      }),
      detail: {
        summary:
          "Report orphaned legacy shared backup data under backup folder roots (dry-run)",
        tags: ["Backups"],
        responses: {
          200: { description: "Legacy-root orphans (no remote mutation)" },
          403: { description: "Forbidden" },
        },
      },
    },
  )
  .post(
    "/backups/legacy-root/prune",
    ({ body: { confirm }, set, store }) => {
      // Deleting backup data is destructive. Only master/admin may do it and
      // the caller must explicitly affirm (confirm === true). The handler
      // itself recomputes the orphan set fresh and never touches host-scoped
      // prefixes.
      if (!requireAdmin({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (confirm !== true) {
        set.status = 400;
        return { error: "confirm_required", message: "pass confirm: true to prune orphaned legacy backup data" };
      }
      return pruneLegacyRoots(activeDb);
    },
    {
      body: t.Object({ confirm: t.Boolean() }),
      detail: {
        summary:
          "Prune orphaned legacy shared backup data (never touches host-scoped prefixes)",
        tags: ["Backups"],
        responses: {
          200: { description: "Prune result per backup folder" },
          400: { description: "confirm_required" },
          403: { description: "Forbidden" },
        },
      },
    },
  );
