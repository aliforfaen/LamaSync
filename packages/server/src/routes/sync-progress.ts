// LAMA-327 — live sync progress surface.
//
// POST /api/v1/sync-progress — device-scoped live report. A device key may
// only report for its OWN host. The update is merged into the bounded
// in-memory registry (see live-progress.ts) and broadcast via a
// `sync_progress` WebSocket event on material change. There is deliberately
// NO operation_log write here: terminal outcomes continue to flow through
// `POST /api/v1/report` only, keeping the immutable Activity history intact.
//
// GET /api/v1/sync-progress — admin/master hydration read. Returns every
// active non-terminal run so reconnecting WebSocket clients can paint the
// "Running now" surface immediately and then live off events.

import { Elysia, t } from "elysia";
import { deviceMayAccessHost, principalOf, requireAdmin } from "../auth.ts";
import { upsertLiveProgress, listActiveLiveProgress } from "../live-progress.ts";

function reportedHostId(body: unknown): string | null {
  if (body === null || typeof body !== "object" || !("hostId" in body)) return null;
  const hostId = body.hostId;
  return typeof hostId === "string" ? hostId : null;
}

export const syncProgressRoutes = new Elysia({ prefix: "/api/v1" })
  .post(
    "/sync-progress",
    ({ body, set, request }) => {
      // LAMA-234: live reports are host-bound — a device key may only report
      // runs for its own host; the daemon never reports for other hosts.
      const principal = principalOf(request);
      const hostId = reportedHostId(body);
      if (!deviceMayAccessHost(principal, hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const stored = upsertLiveProgress(body);
      if (stored === null) {
        // Malformed (unknown phase, missing runId/hostId, non-finite
        // timestamps). 422 so a buggy daemon surfaces the problem while the
        // registry stays clean.
        set.status = 422;
        return { error: "invalid live progress update" };
      }
      set.status = 204;
      return null;
    },
    {
      body: t.Object({
        runId: t.String({ minLength: 1, maxLength: 64 }),
        hostId: t.String({ minLength: 1, maxLength: 64 }),
        hostname: t.Optional(t.Union([t.String({ maxLength: 64 }), t.Null()])),
        folderId: t.Optional(t.Union([t.String({ maxLength: 64 }), t.Null()])),
        folderName: t.Optional(t.Union([t.String({ maxLength: 96 }), t.Null()])),
        operation: t.String({ maxLength: 32 }),
        phase: t.String({ minLength: 1, maxLength: 32 }),
        startedAt: t.Number(),
        phaseStartedAt: t.Number(),
        transfers: t.Optional(t.Union([t.Number(), t.Null()])),
        bytes: t.Optional(t.Union([t.Number(), t.Null()])),
        checks: t.Optional(t.Union([t.Number(), t.Null()])),
        errors: t.Optional(t.Union([t.Number(), t.Null()])),
        files: t.Optional(t.Union([t.Number(), t.Null()])),
        detail: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
      }),
      detail: {
        summary:
          "Report live non-terminal sync phase progress (daemon → server; in-memory only, never written to operation_log)",
        tags: ["Sync Progress"],
        responses: {
          204: { description: "Accepted" },
          403: { description: "Forbidden — device keys may only report their own host" },
          422: { description: "Invalid update" },
        },
      },
    },
  )
  .get(
    "/sync-progress",
    ({ set, request }) => {
      // Admin hydration read: master / managed admin keys / admin web
      // sessions. Device keys are intentionally denied — the registry is
      // fleet-wide control-plane data.
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      return { runs: listActiveLiveProgress() };
    },
    {
      detail: {
        summary:
          "Hydrate the active live sync runs (admin/master) — reconnecting clients call this once after the WebSocket opens",
        tags: ["Sync Progress"],
        responses: {
          200: { description: "Active runs" },
          403: { description: "Forbidden — admin only" },
        },
      },
    },
  );
