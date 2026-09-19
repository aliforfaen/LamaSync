// LAMA-345 — managed-folder health and reviewed sync plans.
//
// Two device-scoped write surfaces (the daemon reports) and two admin-scoped
// read surfaces (the Web UI reads). No route here invokes rclone or exposes
// rclone configuration; a device can only report how its own assignment is
// doing, exactly like /report and /sync-progress.

import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import {
  checkFolderPlanValidity,
  type FolderHealthFacts,
  type FolderHealthState,
  type FolderSyncPlan,
  type WSEvent,
} from "@lamasync/core";
import { broadcast } from "../ws.ts";
import { deviceMayAccessHost, principalOf, requireAdmin } from "../auth.ts";
import {
  getFolderPlan,
  listFolderHealth,
  listFolderPlans,
  normalizeFolderHealthFacts,
  normalizeFolderHealthReasons,
  pruneExpiredFolderPlans,
  recordFolderHealth,
  recordFolderPlan,
} from "../folder-health.ts";

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

const HEALTH_STATES: readonly FolderHealthState[] = [
  "healthy",
  "new_host",
  "resync_required",
  "recoverable",
  "unsafe",
  "blocked",
  "busy",
  "unknown",
];

const INTERVENTIONS = ["initialize", "seed", "resync"] as const;

interface AssignmentRef {
  id: string;
  folder_id: string;
}

function assignmentFor(folderId: string, hostId: string): AssignmentRef | null {
  return activeDb
    .query<AssignmentRef, [string, string]>(
      "SELECT id, folder_id FROM folder_assignments WHERE folder_id = ? AND host_id = ?",
    )
    .get(folderId, hostId);
}

function assignmentById(id: string): AssignmentRef | null {
  return activeDb
    .query<AssignmentRef, [string]>(
      "SELECT id, folder_id FROM folder_assignments WHERE id = ?",
    )
    .get(id);
}

/** Host config revision, used for plan validity. */
function hostConfigRevision(hostId: string): number {
  const row = activeDb
    .query<{ config_revision: number | null }, [string]>(
      "SELECT config_revision FROM hosts WHERE id = ?",
    )
    .get(hostId);
  return row?.config_revision ?? 0;
}

/**
 * Validity of a stored plan against the live assignment state.
 *
 * When there is NO health report yet there is no live device identity to
 * compare against, so the plan's own identity is trusted (a freshly planned
 * folder that has not reported since must not read as "stale") while expiry
 * and the config revision — the two facts the server definitely knows — are
 * still enforced.
 */
function planValidityFor(
  plan: FolderSyncPlan,
  record: { facts: FolderHealthFacts } | null,
  now: number,
): ReturnType<typeof checkFolderPlanValidity> {
  return checkFolderPlanValidity(plan, {
    now,
    configRevision: hostConfigRevision(plan.hostId),
    filterFingerprint: record?.facts.filter.fingerprint ?? plan.filterFingerprint,
    baselineFingerprint: record?.facts.baseline.fingerprint ?? plan.baselineFingerprint,
  });
}

export const folderHealthRoutes = new Elysia({ prefix: "/api/v1" })
  .post(
    "/folder-health",
    ({ body, set, request }) => {
      const report = body as {
        hostId: string;
        folderId: string;
        assignmentId?: string | null;
        state: FolderHealthState;
        reasons: unknown;
        facts: unknown;
        reportedAt: number;
      };
      if (!deviceMayAccessHost(principalOf(request), report.hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!HEALTH_STATES.includes(report.state)) {
        set.status = 400;
        return { error: `Invalid health state: ${String(report.state)}` };
      }
      const assignment = assignmentFor(report.folderId, report.hostId);
      if (!assignment) {
        set.status = 404;
        return { error: "Assignment not found for this host" };
      }
      // The assignment identity is resolved server-side; a daemon cannot
      // report health for another assignment by claiming its id.
      if (
        typeof report.assignmentId === "string" &&
        report.assignmentId !== assignment.id
      ) {
        set.status = 400;
        return { error: "assignmentId does not match this host's assignment" };
      }
      const facts = normalizeFolderHealthFacts(report.facts);
      if (facts === null) {
        set.status = 422;
        return { error: "facts are malformed" };
      }
      const reasons = Array.isArray(report.reasons) ? report.reasons : [];
      const reportedAt = Number.isFinite(report.reportedAt)
        ? Math.floor(report.reportedAt)
        : Date.now();
      recordFolderHealth(activeDb, {
        assignmentId: assignment.id,
        folderId: assignment.folder_id,
        hostId: report.hostId,
        state: report.state,
        reasons: normalizeFolderHealthReasons(reasons),
        facts,
        reportedAt,
      });
      const record = listFolderHealth(activeDb, assignment.folder_id).records.find(
        (r) => r.assignmentId === assignment.id,
      );
      if (record) {
        const event: WSEvent = { kind: "folder_health", record };
        broadcast(event);
      }
      set.status = 204;
      return null;
    },
    {
      body: t.Object({
        hostId: t.String(),
        folderId: t.String(),
        assignmentId: t.Optional(t.Union([t.String(), t.Null()])),
        state: t.Union([
          t.Literal("healthy"),
          t.Literal("new_host"),
          t.Literal("resync_required"),
          t.Literal("recoverable"),
          t.Literal("unsafe"),
          t.Literal("blocked"),
          t.Literal("busy"),
          t.Literal("unknown"),
        ]),
        reasons: t.Array(t.Record(t.String(), t.Unknown())),
        facts: t.Record(t.String(), t.Unknown()),
        reportedAt: t.Number(),
      }),
      detail: {
        summary: "Report assignment-level folder health (daemon → server)",
        tags: ["Folder Health"],
        responses: {
          204: { description: "Recorded" },
          400: { description: "Invalid state or assignment mismatch" },
          403: { description: "Device may not report for this host" },
          404: { description: "Assignment not found" },
          422: { description: "Malformed facts" },
        },
      },
    },
  )
  .post(
    "/folder-plans",
    ({ body, set, request }) => {
      const plan = body as unknown as FolderSyncPlan;
      if (!deviceMayAccessHost(principalOf(request), plan.hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const assignment = assignmentById(plan.assignmentId);
      if (!assignment || assignment.folder_id !== plan.folderId) {
        set.status = 404;
        return { error: "Assignment not found" };
      }
      if (!INTERVENTIONS.includes(plan.intervention)) {
        set.status = 400;
        return { error: `Invalid plan intervention: ${String(plan.intervention)}` };
      }
      if (plan.authority !== "remote" && plan.authority !== "local") {
        set.status = 400;
        return { error: "authority must be 'remote' or 'local'" };
      }
      recordFolderPlan(activeDb, {
        ...plan,
        changes: {
          wouldCopy: plan.changes?.wouldCopy ?? [],
          wouldDelete: plan.changes?.wouldDelete ?? [],
          wouldMkdir: plan.changes?.wouldMkdir ?? [],
          files: plan.changes?.files ?? 0,
          bytes: plan.changes?.bytes ?? 0,
        },
      });
      const stored = getFolderPlan(activeDb, plan.id);
      if (stored) {
        const event: WSEvent = { kind: "folder_plan", plan: stored };
        broadcast(event);
      }
      set.status = 201;
      return stored;
    },
    {
      body: t.Object({
        id: t.String(),
        hostId: t.String(),
        folderId: t.String(),
        assignmentId: t.String(),
        intervention: t.Union([
          t.Literal("initialize"),
          t.Literal("seed"),
          t.Literal("resync"),
        ]),
        authority: t.Union([t.Literal("remote"), t.Literal("local")]),
        summary: t.String({ maxLength: 400 }),
        changes: t.Object({
          wouldCopy: t.Array(t.String({ maxLength: 400 }), { maxItems: 20 }),
          wouldDelete: t.Array(t.String({ maxLength: 400 }), { maxItems: 20 }),
          wouldMkdir: t.Array(t.String({ maxLength: 400 }), { maxItems: 20 }),
          files: t.Number(),
          bytes: t.Number(),
        }),
        configRevision: t.Number(),
        filterFingerprint: t.Union([t.String({ maxLength: 128 }), t.Null()]),
        baselineFingerprint: t.Union([t.String({ maxLength: 128 }), t.Null()]),
        createdAt: t.Number(),
        expiresAt: t.Number(),
      }),
      detail: {
        summary: "Report a reviewed sync plan produced by a dry run (daemon → server)",
        tags: ["Folder Health"],
        responses: {
          201: { description: "Plan stored" },
          400: { description: "Invalid plan" },
          403: { description: "Device may not report for this host" },
          404: { description: "Assignment not found" },
        },
      },
    },
  )
  .get(
    "/folders/:id/health",
    ({ params, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const folder = activeDb
        .query<{ id: string }, [string]>("SELECT id FROM folders WHERE id = ?")
        .get(params.id);
      if (!folder) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const { records, history } = listFolderHealth(activeDb, params.id);
      return { folderId: params.id, records, history };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary: "Assignment-level health for a folder, with bounded history",
        tags: ["Folder Health"],
        responses: {
          200: { description: "Health records (freshest report wins per assignment)" },
          404: { description: "Folder not found" },
          403: { description: "Admin only" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/folders/:id/plans",
    ({ params, query, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const folder = activeDb
        .query<{ id: string }, [string]>("SELECT id FROM folders WHERE id = ?")
        .get(params.id);
      if (!folder) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const limit = typeof query.limit === "number" ? query.limit : Number.parseInt(String(query.limit ?? "10"), 10);
      const plans = listFolderPlans(activeDb, params.id, Number.isFinite(limit) ? limit : 10);
      const now = Date.now();
      const { records } = listFolderHealth(activeDb, params.id, now);
      return plans.map((plan) => {
        const record = records.find((r) => r.assignmentId === plan.assignmentId) ?? null;
        return { plan, validity: planValidityFor(plan, record, now) };
      });
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ limit: t.Optional(t.Union([t.Number(), t.String()])) }),
      detail: {
        summary: "Reviewed sync plans for a folder, newest first, each with a validity verdict",
        tags: ["Folder Health"],
        responses: {
          200: { description: "Plans with `validity` against the live assignment state" },
          404: { description: "Folder not found" },
          403: { description: "Admin only" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/folder-plans/:planId",
    ({ params, set, request }) => {
      const plan = getFolderPlan(activeDb, params.planId);
      if (!plan) {
        set.status = 404;
        return { error: "Plan not found" };
      }
      // Admin reads any plan; a device may read only a plan for its own host
      // (the daemon needs it to validate a queued intervention).
      const principal = principalOf(request);
      if (!requireAdmin({ principal }) && !deviceMayAccessHost(principal, plan.hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const now = Date.now();
      const { records } = listFolderHealth(activeDb, plan.folderId, now);
      const record = records.find((r) => r.assignmentId === plan.assignmentId) ?? null;
      return { plan, validity: planValidityFor(plan, record, now) };
    },
    {
      params: t.Object({ planId: t.String() }),
      detail: {
        summary: "One reviewed sync plan with its current validity",
        tags: ["Folder Health"],
        responses: {
          200: { description: "Plan and validity" },
          404: { description: "Plan not found" },
          403: { description: "Admin only, or the plan's own device" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );

/** Boot-time housekeeping for plan TTLs. */
export function sweepFolderPlans(): number {
  return pruneExpiredFolderPlans(activeDb);
}
