// LAMA-345 stage 2/3 — read-only planning and guarded intervention.
//
// The interaction model is Diagnose → Plan → Approve → Execute → Verify. This
// module owns Plan and Verify:
//
//   buildSyncPlan   an explicit rclone `--dry-run` against the REAL workdir,
//                   turning the parsed change list into a bounded, reviewed
//                   plan with an expiry and the config/filter/baseline
//                   identity it was built against
//   verifyPlan      re-check a stored plan against the live assignment before
//                   an intervention is allowed to touch anything
//
// Nothing here accepts a caller-supplied rclone flag, config path or command:
// the plan is built from the shared assignment contract and the intervention
// is executed by `executeAssignment` with the allowlisted `BisyncRunControl`.

import type {
  Folder,
  FolderAssignment,
  FolderBootstrapAuthority,
  FolderIntervention,
  FolderSyncPlan,
  HostConfig,
  OperationReport,
} from "@lamasync/core";
import {
  checkFolderPlanValidity,
  checkPlanSemantics,
  FOLDER_PLAN_TTL_MS,
  planHasContentChanges,
  type FolderPlanExecution,
  type FolderPlanInvalidReason,
  type PlanSemanticRequest,
} from "@lamasync/core";
import type { BisyncRunControl } from "./executor.ts";
import {
  baselineFingerprint,
  bisyncStateDir,
  inspectBisyncBaseline,
} from "./bisync-baseline.ts";
import { liveFilterFingerprint } from "./folder-health.ts";

/** rclone dry-run change list is bounded before it reaches the wire. */
export const PLAN_CHANGE_CAP = 20;

export interface PlanBuildOptions {
  assignment: FolderAssignment;
  folder: Folder;
  /** Folder type after the per-host sync/mount override. */
  effectiveType: Folder["type"];
  hostConfig: HostConfig;
  hostId: string;
  intervention: FolderSyncPlan["intervention"];
  authority: FolderBootstrapAuthority;
  /** Reviewed `--max-delete` PERCENTAGE (0-100); null/omitted = rclone default. */
  maxDeletePercent?: number | null;
  now?: number;
  /**
   * Executes the read-only dry run. Injected by the daemon so planning goes
   * through the SAME in-process mutex + destination lock as a real run: a dry
   * run writing listing artifacts into the workdir must never race a run.
   */
  runDryRun: (control: BisyncRunControl) => Promise<OperationReport | null>;
}

interface DryRunDetails {
  wouldCopy?: unknown;
  wouldDelete?: unknown;
  wouldMkdir?: unknown;
  rclone?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").slice(0, PLAN_CHANGE_CAP);
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
}

/**
 * Parse the bounded change list out of an `executeAssignment` report. The
 * executor already accumulates rclone's `Would copy` / `Would delete` /
 * `Would make directory` messages; this only narrows them.
 */
export function parseDryRunChanges(details: string | null | undefined): FolderSyncPlan["changes"] {
  if (typeof details !== "string" || details.length === 0) {
    return { wouldCopy: [], wouldDelete: [], wouldMkdir: [], files: 0, bytes: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    return { wouldCopy: [], wouldDelete: [], wouldMkdir: [], files: 0, bytes: 0 };
  }
  if (!isRecord(parsed)) {
    return { wouldCopy: [], wouldDelete: [], wouldMkdir: [], files: 0, bytes: 0 };
  }
  const d = parsed as DryRunDetails;
  const stats = isRecord(d.rclone) ? d.rclone : {};
  const wouldCopy = stringList(d.wouldCopy);
  const wouldDelete = stringList(d.wouldDelete);
  const wouldMkdir = stringList(d.wouldMkdir);
  // The lists are deliberately capped on the wire, so their lengths are a
  // floor. rclone's dry-run accounting counts suppressed copies as transfers
  // and suppressed deletes as deletes, which gives the true total for a plan
  // larger than the cap. Fall back to the list lengths when a daemon (or a
  // failed run) reported no stats.
  const transfers = numberField(stats["transfers"]);
  const deletes = numberField(stats["deletes"]);
  const accounted = transfers + deletes;
  return {
    wouldCopy,
    wouldDelete,
    wouldMkdir,
    files: accounted > 0 ? accounted : wouldCopy.length + wouldDelete.length + wouldMkdir.length,
    bytes: numberField(stats["bytes"]),
  };
}

/**
 * LAMA-345 follow-up: the execution-time proof that a reviewed zero-content
 * plan may run as a BASELINE-ONLY RECOVERY.
 *
 * A plan whose dry run reported no copies, deletes or directory creation is a
 * legitimate operation when the listing pair is missing or unsafe but both
 * sides already agree: the intervention then only rebuilds the baseline and
 * mutates no content. It may only run, however, if a FRESH dry run — using the
 * plan's own reviewed control — still proves there is nothing to move. Any
 * copy/delete/mkdir the fresh dry run reveals means the folder moved since the
 * review, so the plan is refused and the operator must plan a content run.
 *
 * The invariant is "no unreviewed content mutation": a zero-content plan never
 * authorizes a transfer, and a plan with content is still executed exactly as
 * reviewed (authority + `--max-delete` untouched).
 */
export type ZeroContentRecheck =
  | { ok: true; changes: FolderSyncPlan["changes"] }
  | {
      ok: false;
      reason: "no-report" | "failed" | "unreadable" | "changed";
      message: string;
      changes: FolderSyncPlan["changes"] | null;
    };

export function recheckZeroContentExecution(
  report: OperationReport | null,
): ZeroContentRecheck {
  if (!report) {
    return { ok: false, reason: "no-report", message: "the fresh dry run did not run", changes: null };
  }
  if (report.status !== "success") {
    return {
      ok: false,
      reason: "failed",
      message: `the fresh dry run did not complete (${report.status}): ${report.summary ?? "no summary"}`,
      changes: null,
    };
  }
  const details = report.details;
  if (typeof details !== "string" || details.trim().length === 0) {
    return {
      ok: false,
      reason: "unreadable",
      message: "the fresh dry run reported no change detail",
      changes: null,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: "unreadable",
      message: "the fresh dry run's change detail could not be read",
      changes: null,
    };
  }
  const changes = parseDryRunChanges(details);
  if (planHasContentChanges({ changes })) {
    return {
      ok: false,
      reason: "changed",
      message: `${changes.files} file(s) would transfer since the review`,
      changes,
    };
  }
  return { ok: true, changes };
}

/** Human-readable, bounded plan headline. Pure so it is unit-tested. */
export function buildPlanSummary(
  intervention: FolderSyncPlan["intervention"],
  authority: FolderBootstrapAuthority,
  changes: FolderSyncPlan["changes"],
  filterChanged: boolean,
): string {
  const verb =
    intervention === "initialize"
      ? "Initialize this host from remote"
      : intervention === "seed"
        ? "Seed the remote from this host"
        : "Reseed the baseline";
  // The authority decides the winner for a file that changed on BOTH sides;
  // it is not a statement about unique files (those are copied across).
  const side =
    authority === "remote"
      ? "the remote wins conflicting files"
      : "this device wins conflicting files";
  const parts: string[] = [];
  if (changes.wouldCopy.length > 0) parts.push(`${changes.wouldCopy.length} to copy`);
  if (changes.wouldDelete.length > 0) parts.push(`${changes.wouldDelete.length} to delete`);
  if (changes.wouldMkdir.length > 0) parts.push(`${changes.wouldMkdir.length} director(ies) to create`);
  const changeText =
    parts.length > 0
      ? parts.join(", ")
      : "no file changes detected (baseline rebuild only)";
  const filterText = filterChanged ? " The ignore/filter set changed, so listings must be rebuilt." : "";
  return `${verb} — ${side}. Dry run: ${changeText}.${filterText}`;
}

/**
 * Run one explicit dry run and turn it into a reviewed plan. Read-only from
 * the data path's perspective: the executor is called with `dryRun: true`, so
 * rclone never copies or deletes.
 */
export async function buildSyncPlan(opts: PlanBuildOptions): Promise<FolderSyncPlan> {
  const now = opts.now ?? Date.now();
  const maxDeletePercent =
    opts.maxDeletePercent === undefined ? null : opts.maxDeletePercent;
  const control: BisyncRunControl = {
    mode: opts.intervention,
    authority: opts.authority,
    ...(maxDeletePercent !== null ? { maxDeletePercent } : {}),
  };
  const report = await opts.runDryRun(control);
  // A plan is only as trustworthy as the dry run behind it. A missing or
  // non-successful dry run must fail planning outright — it must never be
  // flattened into a "no changes" plan (a failed dry run produced exactly the
  // zero-change plan the cachy incident approved).
  if (!report) {
    throw new Error("the dry run did not run (no report); nothing to review");
  }
  if (report.status !== "success") {
    throw new Error(
      `the dry run did not complete (${report.status}): ${report.summary ?? "no summary"}`,
    );
  }
  const changes = parseDryRunChanges(report.details ?? null);

  const stateDir = bisyncStateDir(opts.assignment.folderId);
  const inspection = inspectBisyncBaseline(stateDir, { readCounts: true });
  const filter = liveFilterFingerprint(opts.assignment, opts.effectiveType);

  return {
    id: crypto.randomUUID(),
    hostId: opts.hostId,
    folderId: opts.folder.id,
    assignmentId: opts.assignment.id,
    intervention: opts.intervention,
    authority: opts.authority,
    // The reviewed deletion threshold is part of the plan's semantics: an
    // execution whose request disagrees with this value is refused.
    maxDeletePercent,
    summary: buildPlanSummary(
      opts.intervention,
      opts.authority,
      changes,
      filter.fingerprint !== null && inspection.present,
    ),
    changes,
    configRevision: opts.hostConfig.host.configRevision ?? 0,
    filterFingerprint: filter.fingerprint,
    baselineFingerprint: baselineFingerprint(inspection),
    createdAt: now,
    expiresAt: now + FOLDER_PLAN_TTL_MS,
  };
}

export interface PlanVerification {
  ok: boolean;
  reason: FolderPlanInvalidReason | "semantics" | null;
  message: string;
  /** Present only when `ok` — the plan's own reviewed execution parameters. */
  execution: FolderPlanExecution | null;
}

/**
 * Re-check a stored plan against the *live* assignment AND against the
 * operation being requested, before an intervention is allowed to touch
 * anything.
 *
 * Two independent gates:
 *   1. freshness — expiry, config revision, filter universe, listing pair;
 *   2. semantics — the request must be exactly what was reviewed
 *      (intervention, authoritative side, deletion threshold).
 *
 * On success the returned `execution` is the plan's own values: the caller
 * executes THOSE, so a request can only ever be refused, never widen a review.
 */
export function verifyPlanAgainstLive(
  plan: Pick<
    FolderSyncPlan,
    | "assignmentId"
    | "hostId"
    | "folderId"
    | "expiresAt"
    | "configRevision"
    | "filterFingerprint"
    | "baselineFingerprint"
    | "intervention"
    | "authority"
    | "maxDeletePercent"
  >,
  live: {
    assignmentId: string;
    hostId: string;
    folderId: string;
    configRevision: number;
    filterFingerprint: string | null;
    baselineFingerprint: string;
    now?: number;
  },
  requested: PlanSemanticRequest,
): PlanVerification {
  if (plan.assignmentId !== live.assignmentId || plan.hostId !== live.hostId || plan.folderId !== live.folderId) {
    return {
      ok: false,
      reason: "missing",
      message: "This plan belongs to a different assignment.",
      execution: null,
    };
  }
  const semantics = checkPlanSemantics(plan, requested);
  if (!semantics.ok) {
    return { ok: false, reason: "semantics", message: semantics.message ?? "This plan does not match the requested operation.", execution: null };
  }
  const verdict = checkFolderPlanValidity(plan, {
    now: live.now ?? Date.now(),
    configRevision: live.configRevision,
    filterFingerprint: live.filterFingerprint,
    baselineFingerprint: live.baselineFingerprint,
  });
  return {
    ok: verdict.valid,
    reason: verdict.reason,
    message: verdict.message,
    execution: verdict.valid ? semantics.execution : null,
  };
}

/** Map an allowlisted intervention onto the executor's run control. */
export function runControlFor(
  intervention: FolderIntervention,
  payload: { authority?: FolderBootstrapAuthority; maxDeletePercent?: number | null },
): BisyncRunControl {
  const percent =
    payload.maxDeletePercent === undefined || payload.maxDeletePercent === null
      ? null
      : payload.maxDeletePercent;
  const cap = percent === null ? {} : { maxDeletePercent: percent };
  switch (intervention) {
    case "initialize":
      return { mode: "initialize", authority: "remote", ...cap };
    case "seed":
      return { mode: "seed", authority: "local", ...cap };
    case "resync":
      return { mode: "resync", authority: payload.authority ?? "remote", ...cap };
    case "resume":
      // A resumable run is a normal bisync run: `--recover` is already part of
      // the command, and no listings are discarded.
      return { mode: "normal", ...cap };
    case "cancel":
      // Cancellation never spawns rclone; the dispatcher aborts the live run.
      return { mode: "normal" };
  }
}

/**
 * Build the run control from a REVIEWED plan's execution parameters. Used
 * after `verifyPlanAgainstLive` succeeds so execution follows the review
 * rather than the request.
 */
export function runControlFromExecution(execution: FolderPlanExecution): BisyncRunControl {
  return {
    mode: execution.intervention,
    authority: execution.authority,
    ...(execution.maxDeletePercent !== null
      ? { maxDeletePercent: execution.maxDeletePercent }
      : {}),
  };
}
