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
  return {
    wouldCopy,
    wouldDelete: stringList(d.wouldDelete),
    wouldMkdir: stringList(d.wouldMkdir),
    // rclone's dry-run stats are not reliable for a plan; the explicit change
    // list is. Files = the would-copy count, bytes = transfers when reported.
    files: wouldCopy.length,
    bytes: numberField(stats["bytes"]),
  };
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
  const changeText = parts.length > 0 ? parts.join(", ") : "no file changes detected";
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
  const changes = parseDryRunChanges(report?.details ?? null);

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
