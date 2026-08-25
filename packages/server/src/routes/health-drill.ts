// LAMA-266: backup "Prove it" + monthly fire-drill routes.
//
// Three endpoints, all additive under /api/v1:
//
//   POST /backends/:backendId/prove   — one-shot restore-test (Part A)
//   POST /backends/:backendId/drill   — full drill + audit (Part B)
//   GET  /health/drills               — recent drill history
//
// All restic invocations go through the engine in ../health-drill.ts,
// which exposes the `__setResticRunnerForTests` seam the unit tests
// use to swap in a fake spawn. Secrets (restic password, s3 keys) are
// never included in responses — only scrubbed failure summaries.

import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import type { ErrorResponse } from "@lamasync/core";
import {
  HealthDrillError,
  __setDb as __setEngineDb,
  listDrills,
  runDrill,
  runProve,
  stampProveFromOutcome,
} from "../health-drill.ts";

let activeDb: Database = defaultDb;

/** Test seam: keeps the route queries and the engine on the same DB. */
export function __setDb(next: Database): void {
  activeDb = next;
  __setEngineDb(next);
}

export const healthDrillRoutes = new Elysia({ prefix: "/api/v1" })
  .post(
    "/backends/:backendId/prove",
    async ({ params, set }) => {
      try {
        const outcome = await runProve({ backendId: params.backendId });
        // LAMA-266: stamp the backend's last_prove_at/_ok columns on both
        // success and failure so the badge reflects the most recent run.
        // Drill runs do this inside runDrill; bare proves don't, so we
        // call the helper here (DB failure is non-fatal — see helper).
        stampProveFromOutcome(params.backendId, outcome);
        if (!outcome.ok) {
          // 502 — the upstream restic call failed; we keep the tempdir
          // cleaned up and only return the scrubbed detail.
          set.status = 502;
          return {
            ok: false,
            checkedAt: new Date(outcome.checkedAt).toISOString(),
            durationMs: outcome.durationMs,
            detail: outcome.detail,
          };
        }
        set.status = 200;
        return {
          ok: true,
          file: outcome.file,
          checkedAt: new Date(outcome.checkedAt).toISOString(),
          durationMs: outcome.durationMs,
          detail: outcome.detail,
        };
      } catch (err) {
        // LAMA-266: non-restic backends surface as 409 (per api.md),
        // distinct from genuine restic-run failures which stay 502.
        // runDrill throws the same error class for the same condition;
        // we keep one error message per endpoint so each route's
        // documented wording stays unambiguous.
        if (err instanceof HealthDrillError) {
          set.status = 409;
          return { error: err.message };
        }
        // runProve swallows its own restic errors into the outcome;
        // anything reaching here is a true unexpected failure (e.g. the
        // DB closing mid-run). Log + return 500 with a generic message.
        console.error(`[health-drill] prove crashed: ${String(err)}`);
        set.status = 500;
        const body: ErrorResponse = { error: "internal_server_error" };
        return body;
      }
    },
    {
      params: t.Object({ backendId: t.String() }),
      detail: {
        summary: "Run a 'Prove it' restore test against the backend's latest restic snapshot",
        tags: ["Health"],
        responses: {
          200: { description: "Prove succeeded; `file` is the restored relative path" },
          404: { description: "Backend not found" },
          409: { description: "Prove requires a restic backend with snapshots (missing repository or password)" },
          502: { description: "restic reported an error; `detail` is a scrubbed summary" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/backends/:backendId/drill",
    async ({ params, set }) => {
      try {
        const outcome = await runDrill({
          backendId: params.backendId,
          kind: "drill",
        });
        if (!outcome.ok) {
          set.status = 502;
        } else {
          set.status = 201;
        }
        return {
          ok: outcome.ok,
          checkedAt: new Date(outcome.checkedAt).toISOString(),
          durationMs: outcome.durationMs,
          summary: outcome.summary,
          detail: outcome.detail ?? null,
          drillId: outcome.drillId,
          livenessOk: outcome.livenessOk,
          file: outcome.file,
          backendId: outcome.backendId,
          backendName: outcome.backendName,
          kind: outcome.kind,
        };
      } catch (err) {
        if (err instanceof HealthDrillError) {
          // Backend isn't a restic backend (or is missing repo/password) —
          // refuse to "drill" something that can't be proven. Distinct
          // from the "snapshot listing failed" 502 case above.
          set.status = 409;
          return { error: err.message };
        }
        console.error(`[health-drill] drill crashed: ${String(err)}`);
        set.status = 500;
        const body: ErrorResponse = { error: "internal_server_error" };
        return body;
      }
    },
    {
      params: t.Object({ backendId: t.String() }),
      detail: {
        summary: "Run a backup fire drill (liveness probe + prove-it restore + audit row + notification)",
        tags: ["Health"],
        responses: {
          201: { description: "Drill succeeded" },
          404: { description: "Backend not found" },
          409: { description: "Drill requires a restic backend (missing repository or password)" },
          502: { description: "restic reported an error; `detail` is a scrubbed summary" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/health/drills",
    ({ query }) => {
      const limit = query.limit;
      const rows = listDrills(limit);
      return {
        drills: rows.map((d) => ({
          id: d.id,
          backendId: d.backendId,
          backendName: d.backendName,
          kind: d.kind,
          ranAt: new Date(d.ranAt).toISOString(),
          ok: d.ok,
          detail: d.detail,
        })),
      };
    },
    {
      query: t.Object({
        limit: t.Optional(t.Union([t.Number(), t.String()])),
      }),
      detail: {
        summary: "Recent fire-drill history (newest first) joined with destination names",
        tags: ["Health"],
        responses: {
          200: { description: "Drill history" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );
