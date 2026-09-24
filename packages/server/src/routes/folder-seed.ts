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
  seedArchiveFactsComplete,
  seedArchiveFactsEqual,
  seedJobPhaseRole,
  seedJobRoleFor,
  seedJobRoleMayComplete,
  seedJobRoleMayEnterPhase,
  seedJobRoleMayReportArchive,
  seedPlanExecution,
  startSeedProgress,
  type AuthPrincipal,
  type SeedJob,
  type SeedJobPhase,
  type SeedJobPhaseOrTerminal,
  type SeedJobRole,
  type SeedPlan,
  type WSEvent,
} from "@lamasync/core";
import { broadcast } from "../ws.ts";
import { principalOf, requireAdmin } from "../auth.ts";
import {
  buildSeedPlan,
  createSeedJob,
  finishSeedJobAsOperator,
  finishSeedJobOwnedBy,
  getSeedJob,
  getSeedPlan,
  activeSeedJobForPair,
  initialSeedJobProgress,
  listSeedJobs,
  listSeedPlans,
  pruneExpiredSeedPlans,
  reapStaleSeedJobs,
  recordSeedPlan,
  reportSeedJobArchiveOnce,
  reportSeedJobProgressGuarded,
  renewSeedJobLeaseGuarded,
  seedPilotEligibilityForPlan,
  seedPlanValidityFor,
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

// ---------------------------------------------------------------------------
// Who may act on ONE seed job (LAMA-346 Stage 2d)
// ---------------------------------------------------------------------------
//
// A seed has two parties — the SOURCE the operator named on the plan and the
// TARGET whose folder is being seeded — and neither needs a master or admin key
// to do its half. The rules are stated once in `@lamasync/core`
// (`seedJobRoleFor`, `seedJobRoleMayEnterPhase`, `seedJobRoleMayReportArchive`,
// `seedJobRoleMayComplete`) and resolved for a request here.
//
// The operator (master / managed admin / admin web session) is a deliberate
// third authority: it may read any job, cancel any job and force a terminal
// outcome, because reconciling a stuck transfer is an operator's job. It is NOT
// a party: it holds no lease, and it may never author a party's facts.

type SeedJobAuthority =
  | { kind: "operator" }
  | { kind: "party"; role: SeedJobRole; hostId: string }
  | { kind: "denied" };

/** The host id of a device principal, or null for every other credential kind. */
function deviceHostId(principal: AuthPrincipal | null): string | null {
  return principal !== null && principal.kind === "device" ? principal.hostId : null;
}

/**
 * Resolve the caller's authority on one seed job.
 *
 * A device that is neither the target nor the named source is a STRANGER: not a
 * party, not the operator, and denied. A mobile native token or a deploy key is
 * denied too — only the two parties and the operator are authorities here. The
 * role comes from the JOB (which carries `sourceHostId`), never from the
 * request, so a caller cannot claim to be the source.
 */
function seedJobAuthority(
  request: Request,
  job: { hostId: string; sourceHostId: string | null },
): SeedJobAuthority {
  const principal = principalOf(request);
  if (requireAdmin({ principal }) !== null) return { kind: "operator" };
  const hostId = deviceHostId(principal);
  if (hostId === null) return { kind: "denied" };
  const role = seedJobRoleFor(job, hostId);
  return role === null ? { kind: "denied" } : { kind: "party", role, hostId };
}

/** A human label for a role, for an operator-facing refusal. */
function roleLabel(role: SeedJobRole): string {
  return role === "source" ? "source" : "target";
}

/**
 * Enqueue one `seed_job` action per PARTY (LAMA-346 Stage 2d).
 *
 * This is the remote orchestration: the server decides which host runs which
 * half, and each daemon claims its own action with its own device key. The
 * payload is the bounded `{ jobId, role }` grammar — the daemon re-derives its
 * role from the job and refuses a payload that disagrees — so an action cannot
 * make a device act outside its half, and no path, flag or credential travels
 * in the queue.
 *
 * Only reachable from `POST /seed-jobs`, which itself refuses unless the
 * operator's seed pilot authorizes this exact folder and pair, so a build with
 * no pilot enqueues nothing.
 */
function enqueueSeedJobActions(job: SeedJob): void {
  const parties: Array<{ hostId: string; role: SeedJobRole }> = [];
  if (job.sourceHostId !== null && job.sourceHostId.length > 0) {
    parties.push({ hostId: job.sourceHostId, role: "source" });
  }
  parties.push({ hostId: job.hostId, role: "target" });
  const createdAt = Date.now();
  for (const party of parties) {
    const id = crypto.randomUUID();
    activeDb.run(
      `INSERT INTO queued_actions (id, host_id, type, payload, status, created_at)
       VALUES (?, ?, 'seed_job', ?, 'pending', ?)`,
      [id, party.hostId, JSON.stringify({ jobId: job.id, role: party.role }), createdAt],
    );
    const event: WSEvent = {
      kind: "action",
      action: {
        id,
        hostId: party.hostId,
        type: "seed_job",
        payload: { jobId: job.id, role: party.role },
        status: "pending",
        createdAt,
        takenAt: null,
        completedAt: null,
        result: null,
      },
    };
    broadcast(event);
  }
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
      // Both PARTIES may read the plan they were approved for: the target needs
      // its staging/format decisions and the source needs the filter universe
      // it must archive. `seedJobRoleFor` is structural, so it serves the plan
      // exactly as it serves the job.
      if (
        requireAdmin({ principal }) === null &&
        seedJobRoleFor(plan, deviceHostId(principal)) === null
      ) {
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
          403: { description: "Admin only, or a party to the plan" },
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
      // The gate is the OPERATOR'S SEED PILOT, not a build flag: it authorizes
      // one folder and one source/target pair, and only after the temporary
      // seed space has been probed. A plan for any other folder, pair, or an
      // unprobed space is refused here with the exact reason.
      const execution = seedPlanExecution({
        pilot: seedPilotEligibilityForPlan(activeDb, plan.folderId, plan.sourceHostId, plan.hostId),
      });
      if (!execution.available) {
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
      const activeJobId = activeSeedJobForPair(
        activeDb,
        plan.folderId,
        plan.sourceHostId,
        plan.hostId,
      );
      if (activeJobId !== null) {
        set.status = 409;
        return { error: "A seed is already active for this folder and host pair", activeJobId };
      }
      const now = Date.now();
      const job: SeedJob = {
        id: crypto.randomUUID(),
        planId: plan.id,
        folderId: plan.folderId,
        hostId: plan.hostId,
        // The source authority travels WITH the job (Stage 2d), so the server
        // can authorize the source device from the job row alone — the plan is
        // pruned on a TTL and must not be load-bearing for authorization.
        sourceHostId: plan.sourceHostId,
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
      // Remote orchestration: each party is told to run its own half. A
      // daemon that is offline simply claims its pending action later.
      enqueueSeedJobActions(job);
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
          409: { description: "Plan is stale, not runnable, or this pair already has an active seed" },
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
      // Both parties read the SAME row: the target must see the source's
      // recorded facts to verify them, and the source must see the phase it
      // left the job in. A stranger sees nothing — not even that the job exists
      // (404 stays reserved for a job that genuinely does not exist, so a
      // stranger never learns the difference from an authorized party).
      if (seedJobAuthority(request, job).kind === "denied") {
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
          403: { description: "Admin, or one of the job's two parties" },
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
      const authority = seedJobAuthority(request, job);
      if (authority.kind === "denied") {
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
      const next: SeedJobPhase = parsed.payload.phase;
      if (authority.kind === "party") {
        // A party may only ever report ITS OWN half of the pipeline, and the
        // job — not the request — says which half that is. A source may not
        // claim to be downloading, and a target may not claim to be archiving.
        // This is the AUTHORIZATION rule and it is checked first: a refusal
        // must name the rule that actually applies.
        if (!seedJobRoleMayEnterPhase(authority.role, next)) {
          set.status = 403;
          return {
            error:
              `This device is the ${roleLabel(authority.role)} of the seed, so it may not report ` +
              `the ${next} phase — that phase belongs to the ${roleLabel(seedJobPhaseRole(next))}.`,
          };
        }
        // The source's archive report is FINAL and is also the lease handover,
        // so once those facts are recorded the source has no more phases to
        // report. Without this refusal a late source progress line would
        // RE-CLAIM the lease it just handed over (the claim predicate sees a
        // free lease) and strand the target behind a live holder — which is
        // exactly the footgun this rule closes. A refusal is safe: the source
        // has nothing left to do, and its action ack is separate from progress.
        if (authority.role === "source" && job.archive.sha256 !== null) {
          set.status = 409;
          return {
            error:
              "This device has already recorded the archive facts, which handed the job to the " +
              "target. The source's half is finished and it may not report again.",
          };
        }
        // The target may not start before the source's immutable facts exist.
        // Without a digest and a manifest there is nothing to verify against,
        // so starting would mean extracting bytes nobody can check. The source's
        // archive report is also the lease handover, so this is the mirror of
        // that write: no facts, no start.
        if (authority.role === "target" && !seedArchiveFactsComplete(job.archive)) {
          set.status = 409;
          return {
            error:
              "The source has not recorded the archive facts yet, so there is nothing to verify " +
              "against. The target starts only after the source's archive and manifest are recorded.",
          };
        }
      }
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
      // The lease owner is the AUTHENTICATED device, never a client-supplied
      // string: `leaseOwner` in the body is honored only for the operator, who
      // has no host of its own.
      const owner =
        authority.kind === "party" ? authority.hostId : (parsed.payload.leaseOwner ?? job.hostId);
      const leaseMs = parsed.payload.leaseMs ?? SEED_JOB_LEASE_MS;
      const updated = reportSeedJobProgressGuarded(activeDb, job.id, progress, {
        owner,
        expiresAt: now + Math.min(Math.max(leaseMs, 30_000), 60 * 60_000),
        now,
        fromPhase: job.phase,
      });
      if (updated === null) {
        // The compare-and-set matched nothing: the job moved on between our read
        // and our write (a cancellation, the other party advancing, or a lease
        // we no longer hold). Reporting the old row would be a lie.
        set.status = 409;
        return { error: "This seed job moved on while the report was in flight" };
      }
      const event: WSEvent = { kind: "seed_job", job: updated };
      broadcast(event);
      return updated;
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
      const job = getSeedJob(activeDb, params.jobId);
      if (!job) {
        set.status = 404;
        return { error: "Seed job not found" };
      }
      // The same gate as `POST /seed-jobs`, re-checked at the write that
      // actually moves the handover: recording the source's immutable archive
      // facts is only meaningful for a job the operator's pilot authorized. The
      // body is normalized fail-closed, so a malformed digest becomes null and
      // the target then refuses to download rather than trusting a shape it
      // cannot verify.
      const pilot = seedPilotEligibilityForPlan(
        activeDb,
        job.folderId,
        job.sourceHostId ?? "",
        job.hostId,
      );
      if (!pilot.eligible) {
        set.status = 503;
        return { error: pilot.reason, executionAvailable: false, jobId: job.id };
      }
      const authority = seedJobAuthority(request, job);
      if (authority.kind === "denied") {
        set.status = 403;
        return { error: "Forbidden" };
      }
      // The facts are the PRODUCER's statement about an archive it just built
      // and uploaded. The target re-derives and checks them; it may never author
      // them, because a target that could rewrite the digest could make any
      // bytes on disk verify. The operator is not a producer either.
      if (authority.kind !== "party" || !seedJobRoleMayReportArchive(authority.role)) {
        set.status = 403;
        return {
          error:
            authority.kind === "operator"
              ? "The archive facts are recorded by the SOURCE device that produced them; an operator has no archive to report."
              : "Only the source device may record a seed job's archive facts. The target verifies them; it never authors them.",
        };
      }
      if (isTerminalSeedPhase(job.phase)) {
        set.status = 409;
        return { error: "This seed job is already finished" };
      }
      // The source's final act is the one that follows the upload. Recording
      // facts from any other phase would let a source stamp identities for an
      // upload that has not happened (or has already been handed over).
      if (job.phase !== "uploading_archive") {
        set.status = 409;
        return {
          error: `Archive facts are recorded while the job is uploading_archive; this job is ${job.phase}.`,
        };
      }
      const facts = normalizeSeedJobArchiveFacts(
        { ...job.archive, ...body },
        job.archive.format,
      );
      const updated = reportSeedJobArchiveOnce(activeDb, job.id, facts, {
        owner: authority.hostId,
        now: Date.now(),
        fromPhase: job.phase,
      });
      if (updated === null) {
        // The write was refused. The one refusal that is NOT an error is a
        // byte-identical retry of the same report (a lost response), and the
        // only way to tell the two apart is to read the row back and compare
        // the identity fields — never the caller's assertion.
        const current = getSeedJob(activeDb, job.id);
        if (current !== null && seedArchiveFactsEqual(current.archive, facts)) {
          return current;
        }
        set.status = 409;
        return {
          error:
            "This seed job's archive facts are already recorded and immutable. A differing report is refused; " +
            "only a byte-identical retry of the recorded facts is accepted.",
        };
      }
      const event: WSEvent = { kind: "seed_job", job: updated };
      broadcast(event);
      return updated;
    },
    {
      params: t.Object({ jobId: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
      detail: {
        summary: "Record a seed job's immutable archive/manifest facts (device → server; pilot-authorized jobs only)",
        tags: ["Folder Seed"],
        responses: {
          200: { description: "Seed job with the recorded archive facts" },
          403: { description: "Device may not report for this job" },
          404: { description: "Seed job not found" },
          409: { description: "Job already finished" },
          503: { description: "The seed pilot does not authorize this job's folder and device pair" },
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
      const authority = seedJobAuthority(request, job);
      if (authority.kind === "denied") {
        set.status = 403;
        return { error: "Forbidden" };
      }
      // Only the party that owns the CURRENT phase may hold the lease. The
      // source cannot keep renewing into the target's half, and the target
      // cannot take the lease before its own half begins.
      if (
        authority.kind === "party" &&
        !isTerminalSeedPhase(job.phase) &&
        !seedJobRoleMayEnterPhase(authority.role, job.phase)
      ) {
        set.status = 409;
        return {
          error: `This device is the ${roleLabel(authority.role)}, and the job is in the ${job.phase} phase, which belongs to the ${roleLabel(seedJobPhaseRole(job.phase))}.`,
        };
      }
      const now = Date.now();
      const leaseMs = Math.min(Math.max(body.leaseMs ?? SEED_JOB_LEASE_MS, 30_000), 60 * 60_000);
      // The owner is the AUTHENTICATED device. `owner` in the body is honored
      // only for the operator, which has no host of its own — a device may not
      // renew a lease in another host's name.
      const owner =
        authority.kind === "party" ? authority.hostId : (body.owner ?? job.leaseOwner ?? job.hostId);
      const updated = renewSeedJobLeaseGuarded(activeDb, job.id, owner, now + leaseMs, now, job.phase);
      if (!updated) {
        set.status = 409;
        return { error: "This seed job is not running, or this device no longer holds its lease" };
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
      const authority = seedJobAuthority(request, job);
      if (authority.kind === "denied") {
        set.status = 403;
        return { error: "Forbidden" };
      }
      // Idempotent: a duplicate acknowledgement returns the stored outcome
      // instead of rewriting it.
      if (isTerminalSeedPhase(job.phase)) return job;
      // Who may declare WHICH outcome is the role rule, and it is the point of
      // the split: only the TARGET can say a seed completed, because only the
      // target holds the manifest comparison and the zero-change baseline
      // verdict. Either party may report its own half FAILED. A device may not
      // cancel — cancellation is the operator's, on its own route.
      if (authority.kind === "party") {
        if (body.status === "completed" && !seedJobRoleMayComplete(authority.role)) {
          set.status = 403;
          return {
            error:
              "Only the target device may report a seed as completed: it is the side that verifies the " +
              "published tree and the following zero-change resync. A source may report its own side failed.",
          };
        }
        if (body.status === "cancelled") {
          set.status = 403;
          return { error: "A device may not cancel a seed job; cancellation is operator-only." };
        }
      }
      const now = Date.now();
      const phase: SeedJobPhaseOrTerminal =
        body.status === "completed" ? "completed" : body.status === "cancelled" ? "cancelled" : "failed";
      const updated =
        authority.kind === "party"
          ? finishSeedJobOwnedBy(activeDb, job.id, {
              owner: authority.hostId,
              status: body.status === "completed" ? "completed" : "failed",
              phase,
              summary: body.summary ?? null,
              error: body.error ?? null,
              now,
              fromPhase: job.phase,
            })
          : finishSeedJobAsOperator(activeDb, job.id, {
              status: body.status,
              phase,
              summary: body.summary ?? null,
              error: body.error ?? null,
              now,
              fromPhase: job.phase,
            });
      if (updated === null) {
        set.status = 409;
        return {
          error:
            "This seed job moved on while the outcome was in flight (it finished, was cancelled, or this " +
            "device no longer holds its lease).",
        };
      }
      const event: WSEvent = { kind: "seed_job", job: updated };
      broadcast(event);
      return updated;
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
      const updated = finishSeedJobAsOperator(activeDb, job.id, {
        status: "cancelled",
        phase: "cancelled",
        summary: "Cancelled by an operator.",
        error: null,
        now,
        fromPhase: job.phase,
      });
      if (updated === null) {
        set.status = 409;
        return { error: "This seed job moved on while the cancellation was in flight" };
      }
      const event: WSEvent = { kind: "seed_job", job: updated };
      broadcast(event);
      return updated;
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
