// LAMA-346 — initial large-folder seeding: plans, jobs, progress and cancel.
//
// Read surface (admin): prepare/read a seed plan, list plans and jobs.
// Device surface: report phase progress, renew a lease, complete a job.
//
// Execution is deliberately NOT available yet: the archive transport
// (temporary seed space → target staging) is unimplemented and unvalidated, so
// `POST /seed-jobs` refuses with an explicit reason and the UI shows a
// disabled control. There is no code path here that runs rclone.

import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import {
  canTransitionSeedPhase,
  emptySeedJobArchiveFacts,
  isTerminalSeedPhase,
  normalizeSeedJobArchiveFacts,
  parseSeedJobCreatePayload,
  parseSeedPlanRequestPayload,
  parseSeedProgressPayload,
  SEED_JOB_LEASE_MS,
  SEED_JOB_PHASES,
  seedPlanExecution,
  startSeedProgress,
  type SeedJob,
  type SeedJobPhaseOrTerminal,
  type SeedPlan,
  type WSEvent,
} from "@lamasync/core";
import { broadcast } from "../ws.ts";
import { deviceMayAccessHost, principalOf, requireAdmin } from "../auth.ts";
import {
  buildSeedPlan,
  createSeedJob,
  finishSeedJob,
  getSeedJob,
  getSeedPlan,
  initialSeedJobProgress,
  listSeedJobs,
  listSeedPlans,
  pruneExpiredSeedPlans,
  reapStaleSeedJobs,
  recordSeedPlan,
  renewSeedJobLease,
  seedPlanValidityFor,
  seedTransportE2eEnabled,
  updateSeedJobArchive,
  updateSeedJobProgress,
} from "../seed-jobs.ts";

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

const PHASES = SEED_JOB_PHASES;

function assignmentFor(folderId: string, hostId: string): { id: string } | null {
  return activeDb
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM folder_assignments WHERE folder_id = ? AND host_id = ?",
    )
    .get(folderId, hostId);
}

function folderExists(folderId: string): boolean {
  return (
    activeDb
      .query<{ id: string }, [string]>("SELECT id FROM folders WHERE id = ?")
      .get(folderId) !== null
  );
}

export const folderSeedRoutes = new Elysia({ prefix: "/api/v1" })
  .post(
    "/folders/:id/seed-plans",
    ({ params, body, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!folderExists(params.id)) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const parsed = parseSeedPlanRequestPayload({ ...body, folderId: params.id });
      if (!parsed.ok) {
        set.status = 400;
        return { error: parsed.error };
      }
      const result = buildSeedPlan(activeDb, {
        folderId: params.id,
        targetHostId: parsed.payload.hostId,
        sourceHostId: parsed.payload.sourceHostId,
      });
      if (!result.ok) {
        set.status = result.status;
        return { error: result.error };
      }
      recordSeedPlan(activeDb, result.plan);
      const stored = getSeedPlan(activeDb, result.plan.id) ?? result.plan;
      const event: WSEvent = { kind: "seed_plan", plan: stored };
      broadcast(event);
      set.status = 201;
      return { plan: stored, validity: seedPlanValidityFor(activeDb, stored) };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        hostId: t.String({ minLength: 1 }),
        // The source device is named explicitly and is never inferred from a
        // size: a wrong source would seed the wrong tree.
        sourceHostId: t.String({ minLength: 1 }),
        // Seed plans are ALWAYS operator-approved; there is no automatic path.
        confirm: t.Literal(true),
      }),
      detail: {
        summary: "Prepare an operator-approved seed plan for one device (read-only preflight)",
        tags: ["Folder Seed"],
        responses: {
          201: { description: "Seed plan prepared with its current validity" },
          400: { description: "Invalid request (hostId, sourceHostId or confirm missing)" },
          403: { description: "Admin only" },
          404: { description: "Folder, target assignment or source assignment not found" },
          409: { description: "sourceHostId is the target device" },
          422: { description: "Body failed schema validation (confirm must be true)" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/folders/:id/seed-plans",
    ({ params, query, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!folderExists(params.id)) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const limit = Number.parseInt(String(query.limit ?? "10"), 10);
      return listSeedPlans(activeDb, params.id, Number.isFinite(limit) ? limit : 10).map(
        (plan) => ({ plan, validity: seedPlanValidityFor(activeDb, plan) }),
      );
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ limit: t.Optional(t.Union([t.Number(), t.String()])) }),
      detail: {
        summary: "Seed plans for a folder, newest first, each with a validity verdict",
        tags: ["Folder Seed"],
        responses: {
          200: { description: "Seed plans with `validity` against the live assignment state" },
          403: { description: "Admin only" },
          404: { description: "Folder not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/seed-plans/:planId",
    ({ params, set, request }) => {
      const plan = getSeedPlan(activeDb, params.planId);
      if (!plan) {
        set.status = 404;
        return { error: "Seed plan not found" };
      }
      const principal = principalOf(request);
      if (!requireAdmin({ principal }) && !deviceMayAccessHost(principal, plan.hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      return { plan, validity: seedPlanValidityFor(activeDb, plan) };
    },
    {
      params: t.Object({ planId: t.String() }),
      detail: {
        summary: "One seed plan with its current validity and the execution capability",
        tags: ["Folder Seed"],
        responses: {
          200: { description: "Seed plan and validity" },
          403: { description: "Admin only, or the plan's own device" },
          404: { description: "Seed plan not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/seed-jobs",
    ({ body, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const parsed = parseSeedJobCreatePayload(body);
      if (!parsed.ok) {
        set.status = 400;
        return { error: parsed.error };
      }
      const plan = getSeedPlan(activeDb, parsed.payload.planId);
      if (!plan) {
        set.status = 404;
        return { error: "Seed plan not found" };
      }
      const execution = seedPlanExecution({ transportImplemented: seedTransportE2eEnabled() });
      if (!execution.available) {
        // Explicitly unavailable — never a fake button. The plan, space
        // calculation and progress model are reviewed; the transport is not.
        set.status = 503;
        return {
          error: execution.reason,
          executionAvailable: false,
          planId: plan.id,
        };
      }
      const validity = seedPlanValidityFor(activeDb, plan);
      if (!validity.valid) {
        set.status = 409;
        return { error: validity.message };
      }
      const now = Date.now();
      const job: SeedJob = {
        id: crypto.randomUUID(),
        planId: plan.id,
        folderId: plan.folderId,
        hostId: plan.hostId,
        assignmentId: plan.assignmentId,
        status: "planned",
        phase: "preflight",
        progress: initialSeedJobProgress("preflight", now),
        source: plan.source,
        archive: emptySeedJobArchiveFacts(plan.archive.format),
        staging: {
          path: "",
          targetPath: "",
          requiredFreeBytes: plan.space.requiredFreeBytes,
          freeBytesAtPlan: plan.target.freeBytes,
        },
        leaseOwner: null,
        leaseExpiresAt: null,
        error: null,
        summary: null,
        createdAt: now,
        startedAt: null,
        updatedAt: now,
        finishedAt: null,
      };
      createSeedJob(activeDb, job);
      const event: WSEvent = { kind: "seed_job", job };
      broadcast(event);
      set.status = 201;
      return job;
    },
    {
      body: t.Object({
        planId: t.String({ minLength: 1 }),
        confirm: t.Literal(true),
      }),
      detail: {
        summary: "Create a seed job from an approved plan (currently refused: transport not implemented)",
        tags: ["Folder Seed"],
        responses: {
          201: { description: "Seed job created (planned)" },
          400: { description: "Invalid request" },
          403: { description: "Admin only" },
          404: { description: "Seed plan not found" },
          409: { description: "Plan is stale or not runnable" },
          422: { description: "Body failed schema validation (confirm must be true)" },
          503: { description: "Seed execution is not available yet" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/folders/:id/seed-jobs",
    ({ params, query, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!folderExists(params.id)) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const limit = Number.parseInt(String(query.limit ?? "10"), 10);
      return listSeedJobs(activeDb, params.id, Number.isFinite(limit) ? limit : 10);
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ limit: t.Optional(t.Union([t.Number(), t.String()])) }),
      detail: {
        summary: "Seed jobs for a folder, newest first",
        tags: ["Folder Seed"],
        responses: {
          200: { description: "Seed jobs with phase, progress and lease state" },
          403: { description: "Admin only" },
          404: { description: "Folder not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/seed-jobs/:jobId",
    ({ params, set, request }) => {
      const job = getSeedJob(activeDb, params.jobId);
      if (!job) {
        set.status = 404;
        return { error: "Seed job not found" };
      }
      const principal = principalOf(request);
      if (!requireAdmin({ principal }) && !deviceMayAccessHost(principal, job.hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      return job;
    },
    {
      params: t.Object({ jobId: t.String() }),
      detail: {
        summary: "One seed job's phase, progress, lease and outcome",
        tags: ["Folder Seed"],
        responses: {
          200: { description: "Seed job" },
          403: { description: "Admin only, or the job's own device" },
          404: { description: "Seed job not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/seed-jobs/:jobId/progress",
    ({ params, body, set, request }) => {
      const job = getSeedJob(activeDb, params.jobId);
      if (!job) {
        set.status = 404;
        return { error: "Seed job not found" };
      }
      if (!deviceMayAccessHost(principalOf(request), job.hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (isTerminalSeedPhase(job.phase)) {
        set.status = 409;
        return { error: "This seed job is already finished" };
      }
      const parsed = parseSeedProgressPayload(body);
      if (!parsed.ok) {
        set.status = 400;
        return { error: parsed.error };
      }
      const next: SeedJobPhaseOrTerminal = parsed.payload.phase;
      if (!canTransitionSeedPhase(job.phase, next)) {
        set.status = 409;
        return {
          error: `illegal phase transition ${job.phase} → ${next}; seed phases only move forward one step at a time`,
        };
      }
      const now = Date.now();
      const progress = startSeedProgress(next, now, parsed.payload.message, {
        bytesTotal: parsed.payload.bytesTotal,
        entriesTotal: parsed.payload.entriesTotal,
      });
      progress.bytesDone = parsed.payload.bytesDone;
      progress.entriesDone = parsed.payload.entriesDone;
      const owner = parsed.payload.leaseOwner ?? job.hostId;
      const leaseMs = parsed.payload.leaseMs ?? SEED_JOB_LEASE_MS;
      const updated = updateSeedJobProgress(activeDb, job.id, progress, {
        owner,
        expiresAt: now + Math.min(Math.max(leaseMs, 30_000), 60 * 60_000),
      });
      if (updated) {
        const event: WSEvent = { kind: "seed_job", job: updated };
        broadcast(event);
      }
      return updated ?? job;
    },
    {
      params: t.Object({ jobId: t.String() }),
      body: t.Object({
        phase: t.Union(PHASES.map((phase) => t.Literal(phase))),
        message: t.Optional(t.String({ maxLength: 300 })),
        bytesDone: t.Optional(t.Number({ minimum: 0 })),
        bytesTotal: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()])),
        entriesDone: t.Optional(t.Number({ minimum: 0 })),
        entriesTotal: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()])),
        leaseOwner: t.Optional(t.String({ maxLength: 128 })),
        leaseMs: t.Optional(t.Number({ minimum: 30_000, maximum: 3_600_000 })),
      }),
      detail: {
        summary: "Report a seed job's phase/progress and renew its lease (device → server)",
        tags: ["Folder Seed"],
        responses: {
          200: { description: "Updated seed job" },
          400: { description: "Malformed progress payload" },
          403: { description: "Device may not report for this job" },
          404: { description: "Seed job not found" },
          409: { description: "Job finished, or the phase transition is illegal" },
        },
      },
    },
  )
  .post(
    "/seed-jobs/:jobId/archive",
    ({ params, body, set, request }) => {
      // LAMA-346 Stage 2c, TEST-ONLY. Recording the source's immutable archive
      // facts is a real remote-orchestration need, but the whole seed surface
      // stays inert until the E2E is reviewed: without the seam this answers
      // 503 exactly like POST /seed-jobs. The body is normalized fail-closed,
      // so a malformed digest becomes null and the target then refuses to
      // download rather than trusting a shape it cannot verify.
      if (!seedTransportE2eEnabled()) {
        set.status = 503;
        return {
          error: "Seed execution is not available yet.",
          executionAvailable: false,
          jobId: params.jobId,
        };
      }
      const job = getSeedJob(activeDb, params.jobId);
      if (!job) {
        set.status = 404;
        return { error: "Seed job not found" };
      }
      if (!deviceMayAccessHost(principalOf(request), job.hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (isTerminalSeedPhase(job.phase)) {
        set.status = 409;
        return { error: "This seed job is already finished" };
      }
      const facts = normalizeSeedJobArchiveFacts(
        { ...job.archive, ...body },
        job.archive.format,
      );
      const updated = updateSeedJobArchive(activeDb, job.id, facts, Date.now());
      if (updated) {
        const event: WSEvent = { kind: "seed_job", job: updated };
        broadcast(event);
      }
      return updated ?? job;
    },
    {
      params: t.Object({ jobId: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
      detail: {
        summary: "Record a seed job's immutable archive/manifest facts (device → server; test-gated)",
        tags: ["Folder Seed"],
        responses: {
          200: { description: "Seed job with the recorded archive facts" },
          403: { description: "Device may not report for this job" },
          404: { description: "Seed job not found" },
          409: { description: "Job already finished" },
          503: { description: "Seed execution is not available yet" },
        },
      },
    },
  )
  .post(
    "/seed-jobs/:jobId/lease",
    ({ params, body, set, request }) => {
      const job = getSeedJob(activeDb, params.jobId);
      if (!job) {
        set.status = 404;
        return { error: "Seed job not found" };
      }
      if (!deviceMayAccessHost(principalOf(request), job.hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const now = Date.now();
      const leaseMs = Math.min(Math.max(body.leaseMs ?? SEED_JOB_LEASE_MS, 30_000), 60 * 60_000);
      const updated = renewSeedJobLease(
        activeDb,
        job.id,
        body.owner ?? job.hostId,
        now + leaseMs,
        now,
      );
      if (!updated) {
        set.status = 409;
        return { error: "This seed job is not running" };
      }
      return updated;
    },
    {
      params: t.Object({ jobId: t.String() }),
      body: t.Object({
        owner: t.Optional(t.String({ maxLength: 128 })),
        leaseMs: t.Optional(t.Number({ minimum: 30_000, maximum: 3_600_000 })),
      }),
      detail: {
        summary: "Renew a running seed job's lease so it cannot be reclaimed (device → server)",
        tags: ["Folder Seed"],
        responses: {
          200: { description: "Seed job with the renewed lease" },
          403: { description: "Device may not renew this job" },
          404: { description: "Seed job not found" },
          409: { description: "Job is not running" },
        },
      },
    },
  )
  .post(
    "/seed-jobs/:jobId/complete",
    ({ params, body, set, request }) => {
      const job = getSeedJob(activeDb, params.jobId);
      if (!job) {
        set.status = 404;
        return { error: "Seed job not found" };
      }
      if (!deviceMayAccessHost(principalOf(request), job.hostId)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      // Idempotent: a duplicate acknowledgement returns the stored outcome
      // instead of rewriting it.
      if (isTerminalSeedPhase(job.phase)) return job;
      const now = Date.now();
      const phase: SeedJobPhaseOrTerminal =
        body.status === "completed" ? "completed" : body.status === "cancelled" ? "cancelled" : "failed";
      const updated = finishSeedJob(activeDb, job.id, {
        status: body.status,
        phase,
        summary: body.summary ?? null,
        error: body.error ?? null,
        now,
      });
      if (updated) {
        const event: WSEvent = { kind: "seed_job", job: updated };
        broadcast(event);
      }
      return updated ?? job;
    },
    {
      params: t.Object({ jobId: t.String() }),
      body: t.Object({
        status: t.Union([t.Literal("completed"), t.Literal("failed"), t.Literal("cancelled")]),
        summary: t.Optional(t.Union([t.String({ maxLength: 400 }), t.Null()])),
        error: t.Optional(t.Union([t.String({ maxLength: 400 }), t.Null()])),
      }),
      detail: {
        summary: "Report a seed job's terminal outcome (device → server, idempotent)",
        tags: ["Folder Seed"],
        responses: {
          200: { description: "Seed job (unchanged when it was already terminal)" },
          403: { description: "Device may not complete this job" },
          404: { description: "Seed job not found" },
        },
      },
    },
  )
  .post(
    "/seed-jobs/:jobId/cancel",
    ({ params, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const job = getSeedJob(activeDb, params.jobId);
      if (!job) {
        set.status = 404;
        return { error: "Seed job not found" };
      }
      if (isTerminalSeedPhase(job.phase)) return job;
      const now = Date.now();
      const updated = finishSeedJob(activeDb, job.id, {
        status: "cancelled",
        phase: "cancelled",
        summary: "Cancelled by an operator.",
        error: null,
        now,
      });
      if (updated) {
        const event: WSEvent = { kind: "seed_job", job: updated };
        broadcast(event);
      }
      return updated ?? job;
    },
    {
      params: t.Object({ jobId: t.String() }),
      detail: {
        summary: "Cancel a seed job (admin). The device observes the terminal state and stops.",
        tags: ["Folder Seed"],
        responses: {
          200: { description: "Seed job (unchanged when it was already terminal)" },
          403: { description: "Admin only" },
          404: { description: "Seed job not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );

/** Convenience for tests and callers that need the plan type. */
export type { SeedPlan };

/** Boot-time housekeeping for seed plan TTLs. */
export function sweepSeedPlans(): number {
  return pruneExpiredSeedPlans(activeDb);
}

/**
 * Boot-time housekeeping for seed jobs whose owner stopped reporting. A live
 * daemon renews its lease every minute, so an expired lease means the owner is
 * gone — never merely slow.
 */
export function sweepSeedJobs(): number {
  return reapStaleSeedJobs(activeDb);
}
