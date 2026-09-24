// LAMA-346 — server-side persistence and the seed-plan preflight.
//
// Two durable shapes:
//
//   folder_seed_plans  an operator-approved seed plan, built from the cached
//                      measurements and archive tooling the daemon already
//                      reports with its heartbeat. Read-only: creating a plan
//                      never runs rclone and never touches a target.
//   folder_seed_jobs   the resumable job state machine with a renewable lease.
//
// The plan is deliberately built from *reported* facts rather than a fresh
// probe: the heartbeat already carries the local tree measurement (on the slow
// cadence), the free space and the archive tooling, so preparing a plan is
// cheap and cannot itself time out. When a fact is missing the plan says so
// and refuses to be runnable — it never guesses.

import type { Database } from "bun:sqlite";
import {
  checkSeedPlanValidity,
  computeSeedSpacePlan,
  parentPathOf,
  recommendSeed,
  seedArchiveToolingReady,
  seedPhaseIndex,
  seedPlanExecution,
  seedStagingPath,
  selectSeedArchiveFormat,
  validateStagingLocation,
  SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED,
  SEED_FILTER_UNIVERSE_REQUIRED_REASON,
  SEED_JOB_HANDOVER_GRACE_MS,
  SEED_JOB_PHASE_COUNT,
  SEED_PLAN_TTL_MS,
  SEED_SOURCE_MEASUREMENT_MAX_AGE_MS,
  type SeedPilotEligibility,
  type SeedArchiveFormat,
  type SeedArchiveTooling,
  type SeedFilterUniverseFacts,
  type SeedJob,
  normalizeSeedJobArchiveFacts,
  type SeedJobArchiveFacts,
  type SeedJobPhase,
  type SeedJobPhaseOrTerminal,
  type SeedJobProgress,
  type SeedJobStagingFacts,
  type SeedJobStatus,
  type SeedPlan,
  type SeedPlanValidity,
  type SeedSourceAuthority,
  type SeedSourceFacts,
  type SeedSpacePlan,
  type SeedTargetFacts,
} from "@lamasync/core";
import { loadDerivedFolderHealth } from "./folder-health.ts";
import { seedPilotEligibilityForFolderPair } from "./seed-pilot.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeParse(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plan rows
// ---------------------------------------------------------------------------

interface SeedPlanRow {
  id: string;
  folder_id: string;
  host_id: string;
  assignment_id: string;
  recommended: number;
  threshold_files: number;
  recommendation: string;
  source_file_count: number;
  source_bytes: number;
  source_measured_at: number;
  source_authority_host_id: string | null;
  source_authority: string | null;
  filter_universe: string | null;
  source_host_id: string | null;
  source_manifest_fingerprint: string | null;
  target_free_bytes: number | null;
  target_free_measured_at: number | null;
  target_host_id: string | null;
  staging_root: string | null;
  staging_same_filesystem: number | null;
  target_measured_entries: number | null;
  space: string;
  archive_format: string;
  archive_tooling: string;
  archive_tooling_ready: number;
  archive_estimate_bytes: number;
  archive_choice_reason: string;
  archive_fallback: number;
  staging_policy: string;
  config_revision: number;
  filter_fingerprint: string | null;
  baseline_fingerprint: string | null;
  execution_available: number;
  execution_reason: string;
  created_at: number;
  expires_at: number;
}

function rowToSeedPlan(row: SeedPlanRow): SeedPlan {
  const space = safeParse(row.space);
  const tooling = safeParse(row.archive_tooling);
  const policy = safeParse(row.staging_policy);
  const authority = safeParse(row.source_authority);
  const filterUniverse = safeParse(row.filter_universe);
  const sourceHostId = row.source_authority_host_id ?? row.source_host_id ?? "";
  return {
    id: row.id,
    hostId: row.host_id,
    folderId: row.folder_id,
    assignmentId: row.assignment_id,
    recommendation: {
      recommended: row.recommended === 1,
      thresholdFiles: row.threshold_files,
      reason: row.recommendation,
    },
    sourceHostId,
    sourceAuthority: isRecord(authority)
      ? {
          hostId: typeof authority["hostId"] === "string" ? authority["hostId"] : sourceHostId,
          assignmentId: typeof authority["assignmentId"] === "string" ? authority["assignmentId"] : "",
          selectedBy: "operator",
          assigned: authority["assigned"] === true,
          isTarget: authority["isTarget"] === true,
          measurementUsable: authority["measurementUsable"] === true,
          measurementAgeMs: typeof authority["measurementAgeMs"] === "number" ? authority["measurementAgeMs"] : null,
          fileCount: typeof authority["fileCount"] === "number" ? authority["fileCount"] : 0,
          totalBytes: typeof authority["totalBytes"] === "number" ? authority["totalBytes"] : 0,
          measuredAt: typeof authority["measuredAt"] === "number" ? authority["measuredAt"] : null,
          message: typeof authority["message"] === "string" ? authority["message"] : "The source device is not usable.",
        }
      : {
          hostId: sourceHostId,
          assignmentId: "",
          selectedBy: "operator",
          assigned: false,
          isTarget: false,
          measurementUsable: false,
          measurementAgeMs: null,
          fileCount: row.source_file_count,
          totalBytes: row.source_bytes,
          measuredAt: null,
          message:
            "This plan predates the explicit source authority; prepare a new plan naming the source device.",
        },
    source: {
      fileCount: row.source_file_count,
      totalBytes: row.source_bytes,
      measuredAt: row.source_measured_at,
      measuredOnHostId: row.source_host_id,
      manifestFingerprint: row.source_manifest_fingerprint,
    },
    target: {
      freeBytes: row.target_free_bytes,
      freeBytesMeasuredAt: row.target_free_measured_at,
      measuredOnHostId: row.target_host_id,
      stagingRoot: row.staging_root,
      stagingSameFilesystem: row.staging_same_filesystem === null ? null : row.staging_same_filesystem === 1,
      measuredEntries: row.target_measured_entries,
    },
    space: isRecord(space) ? (space as unknown as SeedSpacePlan) : computeSeedSpacePlan({
      sourceBytes: 0,
      sourceFiles: 0,
      targetFreeBytes: null,
    }),
    filterUniverse: isRecord(filterUniverse)
      ? {
          fingerprint: typeof filterUniverse["fingerprint"] === "string" ? filterUniverse["fingerprint"] : null,
          targetFingerprint:
            typeof filterUniverse["targetFingerprint"] === "string" ? filterUniverse["targetFingerprint"] : null,
          match: filterUniverse["match"] === true,
          patternCount: typeof filterUniverse["patternCount"] === "number" ? filterUniverse["patternCount"] : 0,
          archiveImplemented: filterUniverse["archiveImplemented"] === true,
          message:
            typeof filterUniverse["message"] === "string"
              ? filterUniverse["message"]
              : SEED_FILTER_UNIVERSE_REQUIRED_REASON,
        }
      : {
          fingerprint: null,
          targetFingerprint: null,
          match: false,
          patternCount: 0,
          archiveImplemented: false,
          message: SEED_FILTER_UNIVERSE_REQUIRED_REASON,
        },
    archive: {
      format: row.archive_format === "tar.zstd" ? "tar.zstd" : "tar.gz",
      tooling: isRecord(tooling)
        ? {
            tar: tooling["tar"] === true,
            zstd: tooling["zstd"] === true,
            gzip: tooling["gzip"] === true,
          }
        : { tar: false, zstd: false, gzip: false },
      toolingReady: row.archive_tooling_ready === 1,
      estimateBytes: row.archive_estimate_bytes,
      choiceReason: row.archive_choice_reason,
      fallback: row.archive_fallback === 1,
    },
    stagingPolicy: isRecord(policy)
      ? {
          adjacentToTarget: policy["adjacentToTarget"] !== false,
          derivedSibling: policy["derivedSibling"] !== false,
          insideTarget: policy["insideTarget"] === true,
          sameFilesystem:
            typeof policy["sameFilesystem"] === "boolean" ? policy["sameFilesystem"] : null,
          message: typeof policy["message"] === "string" ? policy["message"] : "Staging is a sibling of the target.",
        }
      : {
          adjacentToTarget: true,
          derivedSibling: true,
          insideTarget: false,
          sameFilesystem: null,
          message: "Staging is a sibling of the target.",
        },
    configRevision: row.config_revision,
    filterFingerprint: row.filter_fingerprint,
    baselineFingerprint: row.baseline_fingerprint,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    execution: {
      available: row.execution_available === 1,
      reason: row.execution_reason,
    },
  };
}

const SEED_PLAN_SELECT = `SELECT id, folder_id, host_id, assignment_id, recommended, threshold_files,
       recommendation, source_file_count, source_bytes, source_measured_at,
       source_authority_host_id, source_authority, filter_universe, source_host_id,
       source_manifest_fingerprint, target_free_bytes, target_free_measured_at, target_host_id,
       staging_root, staging_same_filesystem, target_measured_entries, space, archive_format, archive_tooling,
       archive_tooling_ready, archive_estimate_bytes, archive_choice_reason, archive_fallback,
       staging_policy, config_revision, filter_fingerprint, baseline_fingerprint,
       execution_available, execution_reason, created_at, expires_at
  FROM folder_seed_plans`;

export function recordSeedPlan(database: Database, plan: SeedPlan): void {
  database.run(
    `INSERT INTO folder_seed_plans
       (id, folder_id, host_id, assignment_id, recommended, threshold_files, recommendation,
        source_file_count, source_bytes, source_measured_at,
        source_authority_host_id, source_authority, filter_universe, source_host_id,
        source_manifest_fingerprint, target_free_bytes, target_free_measured_at, target_host_id,
        staging_root, staging_same_filesystem, target_measured_entries, space, archive_format, archive_tooling,
        archive_tooling_ready, archive_estimate_bytes, archive_choice_reason, archive_fallback,
        staging_policy, config_revision, filter_fingerprint, baseline_fingerprint,
        execution_available, execution_reason, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       recommendation = excluded.recommendation,
       source_file_count = excluded.source_file_count,
       source_bytes = excluded.source_bytes,
       source_measured_at = excluded.source_measured_at,
       source_authority_host_id = excluded.source_authority_host_id,
       source_authority = excluded.source_authority,
       filter_universe = excluded.filter_universe,
       source_host_id = excluded.source_host_id,
       target_free_bytes = excluded.target_free_bytes,
       target_free_measured_at = excluded.target_free_measured_at,
       target_measured_entries = excluded.target_measured_entries,
       space = excluded.space,
       archive_format = excluded.archive_format,
       archive_tooling = excluded.archive_tooling,
       archive_tooling_ready = excluded.archive_tooling_ready,
       archive_estimate_bytes = excluded.archive_estimate_bytes,
       archive_choice_reason = excluded.archive_choice_reason,
       archive_fallback = excluded.archive_fallback,
       staging_policy = excluded.staging_policy,
       config_revision = excluded.config_revision,
       filter_fingerprint = excluded.filter_fingerprint,
       baseline_fingerprint = excluded.baseline_fingerprint,
       execution_available = excluded.execution_available,
       execution_reason = excluded.execution_reason,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
    [
      plan.id,
      plan.folderId,
      plan.hostId,
      plan.assignmentId,
      plan.recommendation.recommended ? 1 : 0,
      plan.recommendation.thresholdFiles,
      plan.recommendation.reason,
      plan.source.fileCount,
      plan.source.totalBytes,
      plan.source.measuredAt,
      plan.sourceHostId,
      JSON.stringify(plan.sourceAuthority),
      JSON.stringify(plan.filterUniverse),
      plan.source.measuredOnHostId,
      plan.source.manifestFingerprint,
      plan.target.freeBytes,
      plan.target.freeBytesMeasuredAt,
      plan.target.measuredOnHostId,
      plan.target.stagingRoot,
      plan.target.stagingSameFilesystem === null ? null : plan.target.stagingSameFilesystem ? 1 : 0,
      plan.target.measuredEntries,
      JSON.stringify(plan.space),
      plan.archive.format,
      JSON.stringify(plan.archive.tooling),
      plan.archive.toolingReady ? 1 : 0,
      plan.archive.estimateBytes,
      plan.archive.choiceReason,
      plan.archive.fallback ? 1 : 0,
      JSON.stringify(plan.stagingPolicy),
      plan.configRevision,
      plan.filterFingerprint,
      plan.baselineFingerprint,
      plan.execution.available ? 1 : 0,
      plan.execution.reason,
      plan.createdAt,
      plan.expiresAt,
    ],
  );
}

export function getSeedPlan(database: Database, planId: string): SeedPlan | null {
  const row = database
    .query<SeedPlanRow, [string]>(`${SEED_PLAN_SELECT} WHERE id = ?`)
    .get(planId);
  return row ? rowToSeedPlan(row) : null;
}

export function listSeedPlans(database: Database, folderId: string, limit = 10): SeedPlan[] {
  const capped = Math.min(Math.max(1, limit), 50);
  return database
    .query<SeedPlanRow, [string, number]>(
      `${SEED_PLAN_SELECT} WHERE folder_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(folderId, capped)
    .map(rowToSeedPlan);
}

export function deleteSeedPlansForAssignment(database: Database, assignmentId: string): void {
  database.run("DELETE FROM folder_seed_plans WHERE assignment_id = ?", [assignmentId]);
}

export function pruneExpiredSeedPlans(
  database: Database,
  now: number = Date.now(),
  graceMs: number = 24 * 60 * 60_000,
): number {
  const result = database.run("DELETE FROM folder_seed_plans WHERE expires_at < ?", [now - graceMs]);
  return Number(result.changes ?? 0);
}

// ---------------------------------------------------------------------------
// Job rows
// ---------------------------------------------------------------------------

interface SeedJobRow {
  id: string;
  plan_id: string;
  folder_id: string;
  host_id: string;
  source_host_id: string | null;
  assignment_id: string;
  status: string;
  phase: string;
  progress: string;
  source: string;
  archive: string;
  staging: string;
  lease_owner: string | null;
  lease_expires_at: number | null;
  error: string | null;
  summary: string | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  finished_at: number | null;
}

function fallbackProgress(): SeedJobProgress {
  return {
    phase: "preflight",
    phaseIndex: 0,
    phaseCount: 10,
    message: "",
    bytesDone: 0,
    bytesTotal: null,
    entriesDone: 0,
    entriesTotal: null,
    updatedAt: 0,
  };
}

function rowToSeedJob(row: SeedJobRow): SeedJob {
  const progress = safeParse(row.progress);
  const source = safeParse(row.source);
  const archive = safeParse(row.archive);
  const staging = safeParse(row.staging);
  return {
    id: row.id,
    planId: row.plan_id,
    folderId: row.folder_id,
    hostId: row.host_id,
    sourceHostId: row.source_host_id,
    assignmentId: row.assignment_id,
    status: row.status as SeedJobStatus,
    phase: row.phase as SeedJobPhaseOrTerminal,
    progress: isRecord(progress) ? (progress as unknown as SeedJobProgress) : fallbackProgress(),
    source: isRecord(source)
      ? (source as unknown as SeedSourceFacts)
      : { fileCount: 0, totalBytes: 0, measuredAt: 0, measuredOnHostId: null, manifestFingerprint: null },
    // Fail closed: a missing or malformed field becomes null/not_started, so
    // the transport refuses to download rather than trusting a shape it cannot
    // verify against.
    archive: normalizeSeedJobArchiveFacts(archive),
    staging: isRecord(staging)
      ? (staging as unknown as SeedJobStagingFacts)
      : { path: "", targetPath: "", requiredFreeBytes: 0, freeBytesAtPlan: null },
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    error: row.error,
    summary: row.summary,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

const SEED_JOB_SELECT = `SELECT id, plan_id, folder_id, host_id, source_host_id, assignment_id, status, phase,
       progress, source, archive, staging, lease_owner, lease_expires_at, error, summary,
       created_at, started_at, updated_at, finished_at
  FROM folder_seed_jobs`;

export function createSeedJob(database: Database, job: SeedJob): void {
  database.run(
    `INSERT INTO folder_seed_jobs
       (id, plan_id, folder_id, host_id, source_host_id, assignment_id, status, phase, progress, source,
        archive, staging, lease_owner, lease_expires_at, error, summary, created_at,
        started_at, updated_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      job.id,
      job.planId,
      job.folderId,
      job.hostId,
      job.sourceHostId,
      job.assignmentId,
      job.status,
      job.phase,
      JSON.stringify(job.progress),
      JSON.stringify(job.source),
      JSON.stringify(job.archive),
      JSON.stringify(job.staging),
      job.leaseOwner,
      job.leaseExpiresAt,
      job.error,
      job.summary,
      job.createdAt,
      job.startedAt,
      job.updatedAt,
      job.finishedAt,
    ],
  );
}

export function getSeedJob(database: Database, jobId: string): SeedJob | null {
  const row = database
    .query<SeedJobRow, [string]>(`${SEED_JOB_SELECT} WHERE id = ?`)
    .get(jobId);
  return row ? rowToSeedJob(row) : null;
}

/** A pilot pair can run only one seed at a time; host config carries one job credential. */
export function activeSeedJobForPair(
  database: Database,
  folderId: string,
  sourceHostId: string,
  targetHostId: string,
): string | null {
  return database
    .query<{ id: string }, [string, string, string]>(
      `SELECT id FROM folder_seed_jobs
       WHERE folder_id = ? AND source_host_id = ? AND host_id = ?
         AND phase NOT IN ('completed', 'failed', 'cancelled')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(folderId, sourceHostId, targetHostId)?.id ?? null;
}

export function listSeedJobs(database: Database, folderId: string, limit = 10): SeedJob[] {
  const capped = Math.min(Math.max(1, limit), 50);
  return database
    .query<SeedJobRow, [string, number]>(
      `${SEED_JOB_SELECT} WHERE folder_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(folderId, capped)
    .map(rowToSeedJob);
}

export function deleteSeedJobsForAssignment(database: Database, assignmentId: string): void {
  database.run("DELETE FROM folder_seed_jobs WHERE assignment_id = ?", [assignmentId]);
}

/**
 * Record a daemon progress report and renew the lease in one write. A report
 * for a job that is already terminal is ignored (the completion route owns
 * terminal state), so a late progress line can never reopen a finished job.
 */
export function updateSeedJobProgress(
  database: Database,
  jobId: string,
  progress: SeedJobProgress,
  lease: { owner: string; expiresAt: number },
): SeedJob | null {
  database.run(
    `UPDATE folder_seed_jobs
        SET phase = ?, progress = ?, status = 'running',
            started_at = COALESCE(started_at, ?),
            lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('planned', 'running')`,
    [
      progress.phase,
      JSON.stringify(progress),
      progress.updatedAt,
      lease.owner,
      lease.expiresAt,
      progress.updatedAt,
      jobId,
    ],
  );
  return getSeedJob(database, jobId);
}

/** Terminal transition. Idempotent: a second call cannot rewrite the outcome. */
export function finishSeedJob(
  database: Database,
  jobId: string,
  input: {
    status: Extract<SeedJobStatus, "completed" | "failed" | "cancelled">;
    phase: SeedJobPhaseOrTerminal;
    summary: string | null;
    error: string | null;
    now: number;
  },
): SeedJob | null {
  database.run(
    `UPDATE folder_seed_jobs
        SET status = ?, phase = ?, summary = ?, error = ?,
            lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ?, finished_at = ?
      WHERE id = ? AND status IN ('planned', 'running')`,
    [input.status, input.phase, input.summary, input.error, input.now, input.now, jobId],
  );
  return getSeedJob(database, jobId);
}

// ---------------------------------------------------------------------------
// Ownership-conditional writes (the coordinator's family)
// ---------------------------------------------------------------------------
//
// The three helpers above are LAST-WRITER-WINS, and they are the device routes'
// contract: a report from a device whose lease owner differs still lands, and
// that is deliberate — the routes are unchanged.
//
// The coordinator needs the opposite, so it uses the conditional family below.
// Every one of them:
//
//   * decides in the WHERE clause, so the check and the write are ONE atomic
//     statement (SQLite gives no useful row lock to take between two);
//   * returns null when the statement changed ZERO rows, and only then reads
//     the row back — a caller can therefore never mistake a refusal for a
//     success, which is exactly what the unguarded `UPDATE ... ; SELECT` pair
//     cannot express.
//
// The predicates they encode live in `@lamasync/core` (`seedJobClaimableBy`,
// `seedLeaseIsLive`) so the rule is stated once and tested without a database.

/** The lease a conditional write is asking for. */
export interface SeedConditionalLease {
  owner: string;
  expiresAt: number;
  now: number;
}

/**
 * Claim a job — or renew our own claim — only if it is actually claimable.
 *
 * This is the write that makes "owner B steals owner A's running job"
 * impossible: a live owner's lease is not in the predicate, so B's UPDATE
 * matches nothing and B is told so.
 *
 * A live lease is refused EVEN FOR THE SAME OWNER. The owner here is a host id,
 * not a run id, so "it says me" does not mean "it is this run": a second run on
 * the same host would otherwise claim, rewind the phase and work concurrently on
 * a job another run is already driving. Renewal is
 * `reportOwnedSeedJobProgress`, which needs no claim.
 */
export function claimSeedJobProgress(
  database: Database,
  jobId: string,
  progress: SeedJobProgress,
  lease: SeedConditionalLease,
): SeedJob | null {
  const result = database.run(
    `UPDATE folder_seed_jobs
        SET phase = ?, progress = ?, status = 'running',
            started_at = COALESCE(started_at, ?),
            lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ?
        AND status IN ('planned', 'running')
        AND phase NOT IN ('completed', 'failed', 'cancelled')
        AND (
              lease_owner IS NULL
           OR (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )`,
    [
      progress.phase,
      JSON.stringify(progress),
      progress.updatedAt,
      lease.owner,
      lease.expiresAt,
      progress.updatedAt,
      jobId,
      lease.now,
    ],
  );
  if (Number(result.changes ?? 0) === 0) return null;
  return getSeedJob(database, jobId);
}

/**
 * Report progress and renew the lease — but only while we still hold it.
 *
 * A zero-row result means the job was cancelled, reaped, or taken over while we
 * were working. The caller must stop rather than keep writing.
 */
export function reportOwnedSeedJobProgress(
  database: Database,
  jobId: string,
  progress: SeedJobProgress,
  lease: SeedConditionalLease,
): SeedJob | null {
  const result = database.run(
    `UPDATE folder_seed_jobs
        SET phase = ?, progress = ?, updated_at = ?,
            lease_expires_at = ?
      WHERE id = ?
        AND status = 'running'
        AND phase NOT IN ('completed', 'failed', 'cancelled')
        AND lease_owner = ?
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > ?`,
    [
      progress.phase,
      JSON.stringify(progress),
      progress.updatedAt,
      lease.expiresAt,
      jobId,
      lease.owner,
      lease.now,
    ],
  );
  if (Number(result.changes ?? 0) === 0) return null;
  return getSeedJob(database, jobId);
}

/**
 * Record IN-FLIGHT archive facts, conditional on still holding a live lease.
 *
 * The unguarded `updateSeedJobArchive` above is deliberately status-blind, and
 * that is right for the cleanup state — which is written after the job ends. It
 * is wrong for the transport facts: those are written while the job is running,
 * so a run whose lease lapsed during a long source/target phase could otherwise
 * overwrite the facts of the owner that took the job over. The archive digest is
 * the target's only authority for what may be extracted, so that write has to be
 * as conditional as the outcome write is.
 */
export function updateOwnedSeedJobArchive(
  database: Database,
  jobId: string,
  archive: SeedJobArchiveFacts,
  lease: { owner: string; now: number },
): SeedJob | null {
  const result = database.run(
    `UPDATE folder_seed_jobs
        SET archive = ?, updated_at = ?
      WHERE id = ?
        AND status = 'running'
        AND phase NOT IN ('completed', 'failed', 'cancelled')
        AND lease_owner = ?
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > ?`,
    [JSON.stringify(archive), lease.now, jobId, lease.owner, lease.now],
  );
  if (Number(result.changes ?? 0) === 0) return null;
  return getSeedJob(database, jobId);
}

/**
 * Terminal transition, conditional on still holding a live lease.
 *
 * A coordinator that lost the job must not be able to write the outcome: the
 * row it would have written belongs to whoever holds it now. A lease that
 * lapsed counts as lost, so the reaper (not a late writer) decides that job.
 */
export function finishOwnedSeedJob(
  database: Database,
  jobId: string,
  input: {
    owner: string;
    status: Extract<SeedJobStatus, "completed" | "failed" | "cancelled">;
    phase: SeedJobPhaseOrTerminal;
    summary: string | null;
    error: string | null;
    now: number;
  },
): SeedJob | null {
  const result = database.run(
    `UPDATE folder_seed_jobs
        SET status = ?, phase = ?, summary = ?, error = ?,
            lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ?, finished_at = ?
      WHERE id = ?
        AND status = 'running'
        AND phase NOT IN ('completed', 'failed', 'cancelled')
        AND lease_owner = ?
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > ?`,
    [
      input.status,
      input.phase,
      input.summary,
      input.error,
      input.now,
      input.now,
      jobId,
      input.owner,
      input.now,
    ],
  );
  if (Number(result.changes ?? 0) === 0) return null;
  return getSeedJob(database, jobId);
}

// ---------------------------------------------------------------------------
// Role-scoped writes (LAMA-346 Stage 2d — the device routes' contract)
// ---------------------------------------------------------------------------
//
// The coordinator's family above is role-blind and *demands* that the caller
// already hold a live lease. That is the right shape for one process driving one
// job. A seed between two hosts has a different shape: the SOURCE owns the first
// four phases (`preflight` → `uploading_archive`) and the TARGET owns the last
// six, so the lease is handed over exactly once — when the source records its
// archive facts — and the server must let the second party claim without letting
// either party touch the other's half.
//
// Every writer below is ONE atomic statement with a compare-and-set on the
// PHASE the route read (`phase = fromPhase`). That CAS is what removes the
// read-then-write window: if another writer moved the job between the route's
// read and its write, the statement matches zero rows, and the route answers 409
// instead of writing over the new state. The role and phase-ownership rules live
// in `@lamasync/core` (`seedJobRoleFor`, `seedJobRoleMayEnterPhase`,
// `seedJobRoleMayReportArchive`, `seedJobRoleMayComplete`) and are checked by the
// route before it writes; these functions enforce the LEASE half.

/** The lease predicate shared by the role-scoped writers: free, or ours. */
const CLAIMABLE_BY = `(lease_owner IS NULL OR lease_owner = ? OR (lease_expires_at IS NOT NULL AND lease_expires_at <= ?))`;

/**
 * Report a phase (or renew the current one) for a device that has been
 * authorized as a party.
 *
 * Claimable when the lease is free, held by this same host (a renewal — the
 * routes are the device's own state machine, so self-renewal is the normal
 * case), or demonstrably lapsed. A LIVE lease held by the other party — or by
 * the same host in another role — is not in the predicate, so the write matches
 * nothing and the route refuses: that is what makes the source's handover
 * meaningful, because until it happens the target cannot start.
 */
export function reportSeedJobProgressGuarded(
  database: Database,
  jobId: string,
  progress: SeedJobProgress,
  lease: SeedConditionalLease & { fromPhase: SeedJobPhaseOrTerminal },
): SeedJob | null {
  const result = database.run(
    `UPDATE folder_seed_jobs
        SET phase = ?, progress = ?, status = 'running',
            started_at = COALESCE(started_at, ?),
            lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ?
        AND phase = ?
        AND status IN ('planned', 'running')
        AND phase NOT IN ('completed', 'failed', 'cancelled')
        AND ${CLAIMABLE_BY}`,
    [
      progress.phase,
      JSON.stringify(progress),
      progress.updatedAt,
      lease.owner,
      lease.expiresAt,
      progress.updatedAt,
      jobId,
      lease.fromPhase,
      lease.owner,
      lease.now,
    ],
  );
  if (Number(result.changes ?? 0) === 0) return null;
  return getSeedJob(database, jobId);
}

/**
 * Record the source's IMMUTABLE archive facts — once — and hand the lease over.
 *
 * Three properties, each enforced by the statement rather than by the caller:
 *
 *   * IMMUTABLE — `json_extract(archive, '$.sha256') IS NULL` is in the
 *     predicate, so the transport facts can be written exactly once. A second
 *     report matches zero rows; the route then reads the row back and answers
 *     200 when the report is byte-identical (a retry) or 409 when it differs (a
 *     rewrite). The digest is the target's only authority for what may be
 *     extracted, so a rewrite would make any bytes verify.
 *   * OWNED — the reporter must hold the LIVE lease. A run whose lease lapsed
 *     during a long upload cannot stamp its facts over the new owner's, and the
 *     facts are always attributed to the source that actually uploaded.
 *   * ATOMIC HANDOVER — the same statement clears `lease_owner`, which is the
 *     source's final act and the only gate the target waits behind. Coupling it
 *     to the fact write means the target can never see a free lease without the
 *     facts it needs.
 */
export function reportSeedJobArchiveOnce(
  database: Database,
  jobId: string,
  archive: SeedJobArchiveFacts,
  lease: { owner: string; now: number; fromPhase: SeedJobPhaseOrTerminal },
): SeedJob | null {
  const result = database.run(
    `UPDATE folder_seed_jobs
        SET archive = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ?
        AND phase = ?
        AND status IN ('planned', 'running')
        AND phase NOT IN ('completed', 'failed', 'cancelled')
        AND lease_owner = ?
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > ?
        AND json_extract(archive, '$.sha256') IS NULL`,
    [JSON.stringify(archive), lease.now, jobId, lease.fromPhase, lease.owner, lease.now],
  );
  if (Number(result.changes ?? 0) === 0) return null;
  return getSeedJob(database, jobId);
}

/**
 * Renew the lease of the party that owns the CURRENT phase.
 *
 * Conditional on still holding a live lease and on the phase being unchanged,
 * so a renewal that races a handover or a cancellation is refused rather than
 * reviving a job someone else has moved on.
 */
export function renewSeedJobLeaseGuarded(
  database: Database,
  jobId: string,
  owner: string,
  expiresAt: number,
  now: number,
  fromPhase: SeedJobPhaseOrTerminal,
): SeedJob | null {
  const result = database.run(
    `UPDATE folder_seed_jobs
        SET lease_expires_at = ?, updated_at = ?
      WHERE id = ?
        AND phase = ?
        AND status = 'running'
        AND phase NOT IN ('completed', 'failed', 'cancelled')
        AND lease_owner = ?
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > ?`,
    [expiresAt, now, jobId, fromPhase, owner, now],
  );
  if (Number(result.changes ?? 0) === 0) return null;
  return getSeedJob(database, jobId);
}

/**
 * Terminal transition for a device party: only while it still holds the live
 * lease, and only from the phase the route read.
 *
 * A party may report its own half failed, and the TARGET alone may report
 * `completed` — the route enforces which statuses a role may send; this function
 * enforces that the writer still owned the job when it did.
 */
export function finishSeedJobOwnedBy(
  database: Database,
  jobId: string,
  input: {
    owner: string;
    status: Extract<SeedJobStatus, "completed" | "failed">;
    phase: SeedJobPhaseOrTerminal;
    summary: string | null;
    error: string | null;
    now: number;
    fromPhase: SeedJobPhaseOrTerminal;
  },
): SeedJob | null {
  const result = database.run(
    `UPDATE folder_seed_jobs
        SET status = ?, phase = ?, summary = ?, error = ?,
            lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ?, finished_at = ?
      WHERE id = ?
        AND phase = ?
        AND status = 'running'
        AND phase NOT IN ('completed', 'failed', 'cancelled')
        AND lease_owner = ?
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at > ?`,
    [
      input.status,
      input.phase,
      input.summary,
      input.error,
      input.now,
      input.now,
      jobId,
      input.fromPhase,
      input.owner,
      input.now,
    ],
  );
  if (Number(result.changes ?? 0) === 0) return null;
  return getSeedJob(database, jobId);
}

/**
 * Terminal transition by the OPERATOR (master/admin/web-session-admin).
 *
 * The operator holds no lease — it is not a party to the transfer — so this is
 * the one terminal writer that does not require one. It still compare-and-sets
 * on the phase the route read, so an operator report cannot clobber a job that
 * moved on, and it still refuses a job that is already terminal.
 */
export function finishSeedJobAsOperator(
  database: Database,
  jobId: string,
  input: {
    status: Extract<SeedJobStatus, "completed" | "failed" | "cancelled">;
    phase: SeedJobPhaseOrTerminal;
    summary: string | null;
    error: string | null;
    now: number;
    fromPhase: SeedJobPhaseOrTerminal;
  },
): SeedJob | null {
  const result = database.run(
    `UPDATE folder_seed_jobs
        SET status = ?, phase = ?, summary = ?, error = ?,
            lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ?, finished_at = ?
      WHERE id = ?
        AND phase = ?
        AND status IN ('planned', 'running')
        AND phase NOT IN ('completed', 'failed', 'cancelled')`,
    [
      input.status,
      input.phase,
      input.summary,
      input.error,
      input.now,
      input.now,
      jobId,
      input.fromPhase,
    ],
  );
  if (Number(result.changes ?? 0) === 0) return null;
  return getSeedJob(database, jobId);
}

/**
 * Record the archive/transport facts of a job.
 *
 * Deliberately NOT guarded on status: the archive metadata is written while the
 * job is running (the upload phase) and the cleanup state is written AFTER the
 * job reaches a terminal phase, which is exactly when its objects become
 * deletable. The job's OUTCOME stays owned by `finishSeedJob`; this function
 * only ever touches the `archive` block.
 */
export function updateSeedJobArchive(
  database: Database,
  jobId: string,
  archive: SeedJobArchiveFacts,
  now: number = Date.now(),
): SeedJob | null {
  database.run(
    `UPDATE folder_seed_jobs
        SET archive = ?, updated_at = ?
      WHERE id = ?`,
    [JSON.stringify(archive), now, jobId],
  );
  return getSeedJob(database, jobId);
}

/**
 * Flip a running job whose lease expired back to `failed`. This is the only
 * path that ends a job the daemon stopped reporting on, and it is deliberately
 * conservative: a live daemon renews every `SEED_JOB_LEASE_RENEW_INTERVAL_MS`,
 * so a 10-minute lease means "the owner is gone", not "the owner is slow".
 *
 * A running job with NO lease at all is NOT immediately stale: clearing the
 * owner is exactly how the source hands the job to the target, and the target
 * claims a fraction of a second later. Reaping on `lease_expires_at IS NULL`
 * would fail a healthy handover caught in that window, so a no-lease job is only
 * reaped once it has been untouched for `SEED_JOB_HANDOVER_GRACE_MS` — by which
 * time the handover is not in flight but abandoned (the target never showed up).
 */
export function reapStaleSeedJobs(database: Database, now: number = Date.now()): number {
  const result = database.run(
    `UPDATE folder_seed_jobs
        SET status = 'failed',
            phase = 'failed',
            error = 'the device stopped reporting progress and its lease expired',
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?,
            finished_at = ?
      WHERE status = 'running'
        AND (
              (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           OR (lease_expires_at IS NULL AND updated_at <= ?)
        )`,
    [now, now, now, now - SEED_JOB_HANDOVER_GRACE_MS],
  );
  return Number(result.changes ?? 0);
}

// ---------------------------------------------------------------------------
// Preflight / plan builder
// ---------------------------------------------------------------------------

interface AssignmentRow {
  id: string;
  folder_id: string;
  host_id: string;
  local_path: string;
}

interface HostRevisionRow {
  config_revision: number | null;
}

export type SeedPlanBuildResult =
  | { ok: true; plan: SeedPlan }
  | { ok: false; status: 404 | 409; error: string };

function dirnameOf(path: string): string | null {
  return parentPathOf(path);
}

/**
 * Build an operator-approved seed plan for one target assignment.
 *
 * Read-only. Sources of truth, in order:
 *   * the SOURCE device is the one the OPERATOR NAMED (`sourceHostId`). It must
 *     be assigned to this folder, must not be the target, and must hold a
 *     fresh usable measurement. Nothing is inferred from a size: picking "the
 *     largest other assignment" would silently choose an authority from a
 *     number, and a wrong source seeds the wrong tree.
 *   * the TARGET free space, archive tooling and staging-sibling proof come
 *     from the target assignment's own latest health report.
 *   * the FILTER UNIVERSE comes from the source device, because the archive
 *     must be built from the same universe the following sync baseline uses.
 *
 * Nothing here guesses: a missing fact makes the plan explicitly not runnable
 * with the exact reason, so the UI can say what to do instead of offering a
 * button that would fail halfway through.
 */
export function buildSeedPlan(
  database: Database,
  input: { folderId: string; targetHostId: string; sourceHostId: string; now?: number },
): SeedPlanBuildResult {
  const now = input.now ?? Date.now();
  const assignments = database
    .query<AssignmentRow, [string]>(
      "SELECT id, folder_id, host_id, local_path FROM folder_assignments WHERE folder_id = ?",
    )
    .all(input.folderId);
  if (assignments.length === 0) {
    return { ok: false, status: 404, error: "Folder has no assignments" };
  }
  const target = assignments.find((a) => a.host_id === input.targetHostId) ?? null;
  if (target === null) {
    return { ok: false, status: 404, error: "This device is not assigned to the folder" };
  }
  // The source authority is the operator's explicit choice, and it must be a
  // real, different assignment of THIS folder.
  if (input.sourceHostId === input.targetHostId) {
    return {
      ok: false,
      status: 409,
      error: "The source device must be a different device from the target — a device cannot seed itself",
    };
  }
  const sourceAssignment = assignments.find((a) => a.host_id === input.sourceHostId) ?? null;
  if (sourceAssignment === null) {
    return {
      ok: false,
      status: 404,
      error:
        "That device is not assigned to this folder, so it cannot be the source of this seed. " +
        "Assign the folder to the device that holds the data first.",
    };
  }

  const records = loadDerivedFolderHealth(database, now, input.folderId);
  const targetRecord = records.find((r) => r.assignmentId === target.id) ?? null;
  const sourceRecord = records.find((r) => r.assignmentId === sourceAssignment.id) ?? null;

  const sourceMeasurement = sourceRecord?.facts.measurement ?? null;
  const measurementAgeMs =
    sourceMeasurement === null ? null : Math.max(0, now - sourceMeasurement.measuredAt);
  const measurementFresh =
    measurementAgeMs !== null && measurementAgeMs <= SEED_SOURCE_MEASUREMENT_MAX_AGE_MS;
  const measurementUsable =
    sourceMeasurement !== null && measurementFresh && sourceMeasurement.pathCount > 0;
  const sourceAuthority: SeedSourceAuthority = {
    hostId: sourceAssignment.host_id,
    assignmentId: sourceAssignment.id,
    selectedBy: "operator",
    assigned: true,
    isTarget: false,
    measurementUsable,
    measurementAgeMs,
    fileCount: sourceMeasurement?.pathCount ?? 0,
    totalBytes: sourceMeasurement?.totalBytes ?? 0,
    measuredAt: sourceMeasurement?.measuredAt ?? null,
    message: measurementUsable
      ? `Source authority: ${sourceAssignment.host_id} — measured ${sourceMeasurement?.pathCount.toLocaleString("en-US")} entries ` +
        `(${sourceMeasurement?.totalBytes.toLocaleString("en-US")} bytes) ${Math.round((measurementAgeMs ?? 0) / 60_000)} minutes ago.`
      : sourceMeasurement === null
        ? `${sourceAssignment.host_id} is assigned to this folder but has not measured it yet. Open this folder on that ` +
          "device and choose Check this device now, then prepare the plan again."
        : !measurementFresh
          ? `The measurement from ${sourceAssignment.host_id} is ${Math.round((measurementAgeMs ?? 0) / 3_600_000)} hours old. ` +
            "Refresh it (Check this device now on that device) before approving a seed, so the reserved space matches the tree."
          : `${sourceAssignment.host_id} currently measures this folder as empty (0 entries), so there is nothing to seed.`,
  };

  const source: SeedSourceFacts = {
    fileCount: sourceMeasurement?.pathCount ?? 0,
    totalBytes: sourceMeasurement?.totalBytes ?? 0,
    measuredAt: sourceMeasurement?.measuredAt ?? 0,
    measuredOnHostId: sourceAssignment.host_id,
    manifestFingerprint: null,
  };

  // The archive must be built from the SOURCE's effective filter universe — the
  // same universe the following sync baseline uses — and must not contradict an
  // already-established target baseline.
  const sourceFilterFingerprint = sourceRecord?.facts.filter.fingerprint ?? null;
  const targetFilterFingerprint = targetRecord?.facts.filter.fingerprint ?? null;
  const filterMatch =
    targetFilterFingerprint === null || targetFilterFingerprint === sourceFilterFingerprint;
  const filterUniverse: SeedFilterUniverseFacts = {
    fingerprint: sourceFilterFingerprint,
    targetFingerprint: targetFilterFingerprint,
    match: filterMatch,
    // The source device's countable rule lines (a floor: the Git-ignore
    // snapshot is only built during a run). Reported rather than left at zero
    // so the plan describes the universe it will actually use.
    patternCount: sourceRecord?.facts.filter.patternCount ?? 0,
    archiveImplemented: SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED,
    message: !SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED
      ? SEED_FILTER_UNIVERSE_REQUIRED_REASON
      : !filterMatch
        ? "The target device's saved sync baseline was built with a different filter set than the source device's, " +
          "so a seed would be re-synced afterwards. Make both devices use the same ignore rules, then prepare a new plan."
        : `The archive will be built from ${sourceAssignment.host_id}'s effective filter universe ` +
          `(fingerprint ${sourceFilterFingerprint ?? "none"}).`,
  };

  const tooling: SeedArchiveTooling | null = targetRecord?.facts.archive ?? null;
  const formatChoice = tooling
    ? selectSeedArchiveFormat(tooling)
    : {
        format: "tar.gz" as SeedArchiveFormat,
        reason:
          "This device has not reported its archive tooling yet, so the plan assumes tar + gzip (the " +
          "documented fallback). Run Check this device now to confirm.",
        fallback: true,
      };
  const toolingReady = tooling !== null && seedArchiveToolingReady(formatChoice.format, tooling);

  const targetFacts: SeedTargetFacts = {
    freeBytes: targetRecord?.facts.freeSpaceBytes ?? null,
    freeBytesMeasuredAt: targetRecord?.reportedAt ?? null,
    measuredOnHostId: targetRecord === null ? null : target.host_id,
    stagingRoot: dirnameOf(target.local_path),
    stagingSameFilesystem: targetRecord?.facts.seedStaging?.sameFilesystem ?? null,
    // The TARGET's own deep measurement of the folder it would receive into.
    // `null` (never measured) is NOT "empty": the preflight refuses it, because
    // publishing into a target nobody has looked at could silently merge.
    measuredEntries: targetRecord?.facts.measurement?.pathCount ?? null,
  };

  const baseSpace = computeSeedSpacePlan({
    sourceBytes: source.totalBytes,
    sourceFiles: source.fileCount,
    targetFreeBytes: targetFacts.freeBytes,
  });
  const space: SeedSpacePlan =
    !measurementUsable
      ? { ...baseSpace, ok: false, message: sourceAuthority.message }
      : baseSpace;

  const targetPath = target.local_path;
  const derivedStaging = seedStagingPath(targetPath, "plan");
  // The server can compare the parents (a pure string check) but cannot stat
  // the target's filesystem, so the same-filesystem verdict comes from the
  // TARGET DEVICE's own proof. Unknown is refused, never assumed.
  const stagingPolicy =
    derivedStaging === null
      ? {
          adjacentToTarget: false,
          derivedSibling: false,
          insideTarget: false,
          sameFilesystem: null,
          message:
            "The device's local path is not an absolute path, so a staging sibling cannot be derived. " +
            "Set the assignment's local path to an absolute path first.",
        }
      : (() => {
          const verdict = validateStagingLocation({
            stagingPath: derivedStaging,
            targetPath,
            // The device's own proof: the staging sibling's parent IS the
            // target's parent, and the device read that directory's device.
            sameFilesystemProven: targetRecord?.facts.seedStaging?.sameFilesystem ?? null,
          });
          return {
            adjacentToTarget: verdict.adjacentToTarget,
            derivedSibling: verdict.derivedSibling,
            insideTarget: verdict.insideTarget,
            sameFilesystem: verdict.sameFilesystem,
            message: verdict.message,
          };
        })();

  const revisionRow = database
    .query<HostRevisionRow, [string]>("SELECT config_revision FROM hosts WHERE id = ?")
    .get(target.host_id);

  const plan: SeedPlan = {
    id: crypto.randomUUID(),
    hostId: target.host_id,
    folderId: input.folderId,
    assignmentId: target.id,
    recommendation: recommendSeed({ fileCount: source.fileCount, totalBytes: source.totalBytes }),
    sourceHostId: sourceAssignment.host_id,
    sourceAuthority,
    source,
    target: targetFacts,
    space,
    filterUniverse,
    archive: {
      format: formatChoice.format,
      tooling: tooling ?? { tar: false, zstd: false, gzip: false },
      toolingReady,
      estimateBytes: space.archiveBytesEstimate,
      choiceReason: formatChoice.reason,
      fallback: formatChoice.fallback,
    },
    stagingPolicy,
    configRevision: revisionRow?.config_revision ?? 0,
    filterFingerprint: targetFilterFingerprint,
    baselineFingerprint: targetRecord?.facts.baseline.fingerprint ?? null,
    createdAt: now,
    expiresAt: now + SEED_PLAN_TTL_MS,
    execution: seedPlanExecution({ pilot: seedPilotEligibilityForPlan(database, input.folderId, sourceAssignment.host_id, target.host_id) }),
  };
  return { ok: true, plan };
}

/**
 * The operator's pilot verdict for one folder+pair.
 *
 * Read from the stored pilot on every call rather than cached on the plan: the
 * authorization can be switched off between preparing a plan and approving it,
 * and a plan must never carry a stale "authorized".
 */
export function seedPilotEligibilityForPlan(
  database: Database,
  folderId: string,
  sourceHostId: string,
  targetHostId: string,
): SeedPilotEligibility {
  // Delegated to the server's pilot module, which is the only place that can
  // resolve the LIVE backend fingerprint the readiness verdict is bound to.
  return seedPilotEligibilityForFolderPair(database, { folderId, sourceHostId, targetHostId });
}

/** Validity of a stored seed plan against the live assignment state. */
export function seedPlanValidityFor(
  database: Database,
  plan: SeedPlan,
  now: number = Date.now(),
): SeedPlanValidity {
  const revisionRow = database
    .query<HostRevisionRow, [string]>("SELECT config_revision FROM hosts WHERE id = ?")
    .get(plan.hostId);
  const records = loadDerivedFolderHealth(database, now, plan.folderId);
  const record = records.find((r) => r.assignmentId === plan.assignmentId) ?? null;
  return checkSeedPlanValidity(
    plan,
    {
      now,
      configRevision: revisionRow?.config_revision ?? 0,
      filterFingerprint: record?.facts.filter.fingerprint ?? plan.filterFingerprint,
      baselineFingerprint: record?.facts.baseline.fingerprint ?? plan.baselineFingerprint,
    },
    { pilot: seedPilotEligibilityForPlan(database, plan.folderId, plan.sourceHostId, plan.hostId) },
  );
}

// LAMA-346 Stage 2f: the server-side test seam is GONE.
//
// Through Stage 2e the server opened `POST /seed-jobs` and the archive route
// only when BOTH `LAMASYNC_SEED_E2E=1` and `LAMASYNC_TEST=1` were set, because
// there was no production authorization to consult. There is now: the operator's
// seed pilot (`./seed-pilot.ts`), which authorizes one folder and one
// source/target pair after its temporary seed space has been probed. A test
// environment alone therefore opens NOTHING here — it can only exercise the
// surface by configuring a real pilot through the real admin route, exactly as
// an operator would, which is what the disposable E2E now does. The daemon keeps
// its own doubly-gated seam, for sandbox affordances only (a shortened lease, a
// held phase, a local resync peer, an environment-supplied relay space); the
// server has none, and `seed-transport-bounded.test.ts` asserts that this module
// reads no seed environment variable at all.

/** Build the starting progress record for a newly created job. */
export function initialSeedJobProgress(phase: SeedJobPhase, now: number): SeedJobProgress {
  return {
    phase,
    phaseIndex: seedPhaseIndex(phase),
    phaseCount: SEED_JOB_PHASE_COUNT,
    message: "Seed plan approved; waiting for the device to start.",
    bytesDone: 0,
    bytesTotal: null,
    entriesDone: 0,
    entriesTotal: null,
    updatedAt: now,
  };
}
