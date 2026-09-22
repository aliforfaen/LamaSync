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
  normalizeAbsolutePath,
  recommendSeed,
  seedArchiveToolingReady,
  seedPhaseIndex,
  seedPlanExecution,
  seedStagingPath,
  selectSeedArchiveFormat,
  validateStagingLocation,
  SEED_JOB_PHASE_COUNT,
  SEED_PLAN_TTL_MS,
  type SeedArchiveFormat,
  type SeedArchiveTooling,
  type SeedJob,
  type SeedJobArchiveFacts,
  type SeedJobPhase,
  type SeedJobPhaseOrTerminal,
  type SeedJobProgress,
  type SeedJobStagingFacts,
  type SeedJobStatus,
  type SeedPlan,
  type SeedPlanValidity,
  type SeedSourceFacts,
  type SeedSpacePlan,
  type SeedTargetFacts,
} from "@lamasync/core";
import { loadDerivedFolderHealth } from "./folder-health.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeParse(text: string): unknown {
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
  source_host_id: string | null;
  source_manifest_fingerprint: string | null;
  target_free_bytes: number | null;
  target_free_measured_at: number | null;
  target_host_id: string | null;
  staging_root: string | null;
  staging_same_filesystem: number | null;
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
    },
    space: isRecord(space) ? (space as unknown as SeedSpacePlan) : computeSeedSpacePlan({
      sourceBytes: 0,
      sourceFiles: 0,
      targetFreeBytes: null,
    }),
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
          insideTarget: policy["insideTarget"] === true,
          sameFilesystem:
            typeof policy["sameFilesystem"] === "boolean" ? policy["sameFilesystem"] : null,
          message: typeof policy["message"] === "string" ? policy["message"] : "Staging is a sibling of the target.",
        }
      : {
          adjacentToTarget: true,
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
       recommendation, source_file_count, source_bytes, source_measured_at, source_host_id,
       source_manifest_fingerprint, target_free_bytes, target_free_measured_at, target_host_id,
       staging_root, staging_same_filesystem, space, archive_format, archive_tooling,
       archive_tooling_ready, archive_estimate_bytes, archive_choice_reason, archive_fallback,
       staging_policy, config_revision, filter_fingerprint, baseline_fingerprint,
       execution_available, execution_reason, created_at, expires_at
  FROM folder_seed_plans`;

export function recordSeedPlan(database: Database, plan: SeedPlan): void {
  database.run(
    `INSERT INTO folder_seed_plans
       (id, folder_id, host_id, assignment_id, recommended, threshold_files, recommendation,
        source_file_count, source_bytes, source_measured_at, source_host_id,
        source_manifest_fingerprint, target_free_bytes, target_free_measured_at, target_host_id,
        staging_root, staging_same_filesystem, space, archive_format, archive_tooling,
        archive_tooling_ready, archive_estimate_bytes, archive_choice_reason, archive_fallback,
        staging_policy, config_revision, filter_fingerprint, baseline_fingerprint,
        execution_available, execution_reason, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       recommendation = excluded.recommendation,
       source_file_count = excluded.source_file_count,
       source_bytes = excluded.source_bytes,
       source_measured_at = excluded.source_measured_at,
       source_host_id = excluded.source_host_id,
       target_free_bytes = excluded.target_free_bytes,
       target_free_measured_at = excluded.target_free_measured_at,
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
      plan.source.measuredOnHostId,
      plan.source.manifestFingerprint,
      plan.target.freeBytes,
      plan.target.freeBytesMeasuredAt,
      plan.target.measuredOnHostId,
      plan.target.stagingRoot,
      plan.target.stagingSameFilesystem === null ? null : plan.target.stagingSameFilesystem ? 1 : 0,
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
    assignmentId: row.assignment_id,
    status: row.status as SeedJobStatus,
    phase: row.phase as SeedJobPhaseOrTerminal,
    progress: isRecord(progress) ? (progress as unknown as SeedJobProgress) : fallbackProgress(),
    source: isRecord(source)
      ? (source as unknown as SeedSourceFacts)
      : { fileCount: 0, totalBytes: 0, measuredAt: 0, measuredOnHostId: null, manifestFingerprint: null },
    archive: isRecord(archive)
      ? (archive as unknown as SeedJobArchiveFacts)
      : { format: "tar.gz", bytes: null, sha256: null, objectKey: null, memberCount: null },
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

const SEED_JOB_SELECT = `SELECT id, plan_id, folder_id, host_id, assignment_id, status, phase,
       progress, source, archive, staging, lease_owner, lease_expires_at, error, summary,
       created_at, started_at, updated_at, finished_at
  FROM folder_seed_jobs`;

export function createSeedJob(database: Database, job: SeedJob): void {
  database.run(
    `INSERT INTO folder_seed_jobs
       (id, plan_id, folder_id, host_id, assignment_id, status, phase, progress, source,
        archive, staging, lease_owner, lease_expires_at, error, summary, created_at,
        started_at, updated_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      job.id,
      job.planId,
      job.folderId,
      job.hostId,
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

/** Renew a live lease without changing progress. */
export function renewSeedJobLease(
  database: Database,
  jobId: string,
  owner: string,
  expiresAt: number,
  now: number,
): SeedJob | null {
  database.run(
    `UPDATE folder_seed_jobs
        SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'`,
    [owner, expiresAt, now, jobId],
  );
  return getSeedJob(database, jobId);
}

/**
 * Flip a running job whose lease expired back to `failed`. This is the only
 * path that ends a job the daemon stopped reporting on, and it is deliberately
 * conservative: a live daemon renews every minute, so a 10-minute lease means
 * "the owner is gone", not "the owner is slow".
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
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    [now, now, now],
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
  const normalized = normalizeAbsolutePath(path);
  if (normalized === null) return null;
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

/**
 * Build an operator-approved seed plan for one target assignment.
 *
 * Read-only. Sources of truth, in order:
 *   * the SOURCE tree size comes from the largest measurement any assignment
 *     of this folder has reported (the heartbeat's slow-cadence deep
 *     measurement). No measurement → the plan is created but not runnable.
 *   * the TARGET free space and archive tooling come from the target
 *     assignment's own latest health report.
 *
 * Nothing here guesses: a missing fact makes the plan explicitly not runnable
 * with the exact reason, so the UI can say what to do instead of offering a
 * button that would fail halfway through.
 */
export function buildSeedPlan(
  database: Database,
  input: { folderId: string; targetHostId: string; now?: number },
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

  const records = loadDerivedFolderHealth(database, now, input.folderId);
  const targetRecord = records.find((r) => r.assignmentId === target.id) ?? null;

  // Source: the largest reported deep measurement on a DIFFERENT assignment,
  // falling back to any assignment's measurement (a single-host folder can
  // still be seeded to a re-imaged device).
  let sourceRecord = null as (typeof records)[number] | null;
  for (const record of records) {
    if (record.facts.measurement === null) continue;
    if (record.assignmentId === target.id) continue;
    if (sourceRecord === null) {
      sourceRecord = record;
      continue;
    }
    const current = sourceRecord.facts.measurement;
    const candidate = record.facts.measurement;
    if (candidate !== null && current !== null && candidate.totalBytes > current.totalBytes) {
      sourceRecord = record;
    }
  }

  const sourceMeasurement = sourceRecord?.facts.measurement ?? null;
  const source: SeedSourceFacts = {
    fileCount: sourceMeasurement?.pathCount ?? 0,
    totalBytes: sourceMeasurement?.totalBytes ?? 0,
    measuredAt: sourceMeasurement?.measuredAt ?? 0,
    measuredOnHostId: sourceRecord?.hostId ?? null,
    manifestFingerprint: null,
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
    stagingSameFilesystem: null,
  };

  const baseSpace = computeSeedSpacePlan({
    sourceBytes: source.totalBytes,
    sourceFiles: source.fileCount,
    targetFreeBytes: targetFacts.freeBytes,
  });
  const space: SeedSpacePlan =
    sourceMeasurement === null || source.totalBytes === 0
      ? {
          ...baseSpace,
          ok: false,
          message:
            "The source device has not been measured yet, so the seed size is unknown. Open this " +
            "folder on the device that holds the data and choose Check this device now, then prepare the plan again.",
        }
      : baseSpace;

  const targetPath = target.local_path;
  const derivedStaging = seedStagingPath(
    normalizeAbsolutePath(targetPath) ?? "/target",
    "plan",
  );
  const stagingPolicy = derivedStaging === null
    ? {
        adjacentToTarget: true,
        insideTarget: false,
        sameFilesystem: null,
        message:
          "The device derives the staging directory as a sibling of its local path; it is never placed " +
          "inside the target. The same-filesystem check runs on the device before any byte is written.",
      }
    : (() => {
        const verdict = validateStagingLocation({ stagingPath: derivedStaging, targetPath });
        return {
          adjacentToTarget: true,
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
    source,
    target: targetFacts,
    space,
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
    filterFingerprint: targetRecord?.facts.filter.fingerprint ?? null,
    baselineFingerprint: targetRecord?.facts.baseline.fingerprint ?? null,
    createdAt: now,
    expiresAt: now + SEED_PLAN_TTL_MS,
    execution: seedPlanExecution(),
  };
  return { ok: true, plan };
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
  return checkSeedPlanValidity(plan, {
    now,
    configRevision: revisionRow?.config_revision ?? 0,
    filterFingerprint: record?.facts.filter.fingerprint ?? plan.filterFingerprint,
    baselineFingerprint: record?.facts.baseline.fingerprint ?? plan.baselineFingerprint,
  });
}

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
