// Action dispatcher (LAMA-198). The pure parts — payload parsing and
// "which assignments get run" — live here so they're unit-testable without
// a network or server. The orchestrator (poll loop, fetch, ack) stays in
// `index.ts` where the existing closures (client, runOnce, refreshConfig)
// already live.

import type {
  Folder,
  FolderAssignment,
  FolderType,
  QueuedAction,
  QueuedActionType,
} from "@lamasync/core";

/** Result the action dispatcher wants to write back to the server. */
export interface ActionCompletion {
  status: "done" | "failed";
  result: string;
}

/**
 * Folders that the `trigger_backup` action should fire. From the user's
 * perspective both `backup` (rclone copy to a remote) and `dotfile`
 * (tar+upload to the server) are backup operations — the dotfile type
 * produces a versioned tarball on the server's `/data` volume, so the
 * "Trigger backup" button on HostDetail should fire it. (LAMA-219)
 */
const BACKUP_FOLDER_TYPES: ReadonlySet<FolderType> = new Set(["backup", "dotfile"]);

/**
 * Whether a queued-action payload asks for a dry-run sync. The daemon's
 * `trigger_sync` handler forwards this into `runOnce(assignment, { dryRun })`
 * → `executeAssignment({ dryRun: true })`, which makes rclone run with
 * `--dry-run` (see `buildRcloneCommand`). Selection is unaffected — this
 * only flips how the matched assignments are executed.
 *
 * Only `trigger_sync` honors this flag; `trigger_backup` currently ignores
 * it (a dry-run backup is not wired up).
 */
export function isDryRunRequested(payload: Record<string, unknown> | null): boolean {
  return payload?.["dryRun"] === true;
}

/**
 * Resolve the `trigger_sync` / `trigger_backup` action into the list of
 * assignments the daemon should run. The empty-list / unknown-folder
 * branches are caller errors that the dispatcher turns into a `failed`
 * completion; this helper just expresses the rule.
 *
 *   payload.folderId === undefined  → every assignment (or every backup
 *                                       assignment, for `trigger_backup`)
 *   payload.folderId === "f-1"      → only assignments whose folderId
 *                                       matches; an unknown folder is an
 *                                       error (the route handler returns 404
 *                                       server-side; this client returns
 *                                       an empty list to surface "no work").
 *   payload.dryRun === true         → `trigger_sync` only: the dispatcher
 *                                       runs the matched assignments in
 *                                       dry-run mode (`rclone --dry-run`),
 *                                       so the UI can preview a sync without
 *                                       touching files. The selection rules
 *                                       above are unchanged; this flag only
 *                                       affects how the executor runs them.
 *
 * @see isDryRunRequested — single source of truth for reading the flag.
 *
 * The `folderTypes` lookup (assignment id → Folder.type) lets the helper
 * filter by folder type when `backupOnly` is requested, per the LAMA-198
 * spec ("trigger_backup … filter assignments to folder type 'backup' when
 * no folderId given"). LAMA-219 extends the set to also include
 * `dotfile` folders, since both produce versioned backups.
 */
export function selectAssignmentsForSyncAction(
  assignments: readonly FolderAssignment[],
  payload: Record<string, unknown> | null,
  options: {
    backupOnly: boolean;
    folderTypes?: ReadonlyMap<string, FolderType> | null;
  },
): FolderAssignment[] {
  const folderIdRaw = payload?.["folderId"];
  const folderId = typeof folderIdRaw === "string" ? folderIdRaw : null;
  if (folderId === null) {
    if (!options.backupOnly) return [...assignments];
    const lookup = options.folderTypes ?? null;
    return assignments.filter((a) => {
      const t = lookup?.get(a.folderId);
      return t !== undefined && BACKUP_FOLDER_TYPES.has(t);
    });
  }
  const matches = assignments.filter((a) => a.folderId === folderId);
  if (!options.backupOnly) return matches;
  const lookup = options.folderTypes ?? null;
  return matches.filter((a) => {
    const t = lookup?.get(a.folderId);
    // Without a lookup we still keep the explicit match — the user asked
    // for a specific folder; refusing it because we don't know the type
    // would be a worse UX than firing it.
    return t === undefined || BACKUP_FOLDER_TYPES.has(t);
  });
}

/**
 * Map an OperationReport into the wire-side completion the action poller
 * writes back. "skipped: …" failures are upgraded to a `done` completion
 * because a lock-contention skip is not an error from the user's POV — the
 * action did its job (it asked for a sync; the daemon said "another run is
 * already in flight").
 */
export function summarizeReportForAction(
  reportStatus: "success" | "failed" | "conflict" | "retry" | "recovery" | "started" | "deferred",
  reportSummary: string | null,
  fallback: string,
): ActionCompletion {
  const summary = reportSummary ?? fallback;
  if (reportStatus === "failed" && summary.startsWith("skipped:")) {
    return { status: "done", result: summary };
  }
  // LAMA-294: lock contention / control-plane outage is a first-class
  // deferral — no transfer started, so it must not surface as a permanent
  // failure.
  if (reportStatus === "deferred") {
    return { status: "done", result: summary };
  }
  return {
    status: reportStatus === "success" ? "done" : "failed",
    result: summary,
  };
}

/**
 * Build the completion body for a `check_update` action from the latest
 * release info. Keeps the wording uniform between the daemon's
 * `--check-update` flag and the action path.
 */
export function summarizeUpdateCheck(
  currentVersion: string,
  latestVersion: string,
): ActionCompletion {
  if (currentVersion === latestVersion) {
    return { status: "done", result: `up to date (v${currentVersion})` };
  }
  return {
    status: "done",
    result: `update available: v${latestVersion} (current v${currentVersion})`,
  };
}

/**
 * Build the completion body for a `refresh_config` action from the
 * resulting assignment count.
 */
export function summarizeConfigRefresh(assignmentCount: number): ActionCompletion {
  const noun = assignmentCount === 1 ? "assignment" : "assignments";
  return {
    status: "done",
    result: `refreshed config (${assignmentCount} ${noun})`,
  };
}

/**
 * Aggregate per-folder sync/backup outcomes into a single headline
 * suitable for the Operations view.
 *
 * The naive version — `join("; ")` of every per-folder
 * `"backup ok: 0 transfers, 0 B in 1s"` line — bloats a row to thousands
 * of characters when many no-op folders report the same string; the
 * Operations view then looks like raw rclone stdout pasted verbatim and
 * pushes the rest of the table off-screen.
 *
 * The per-folder `OperationLog` entries already carry the full detail
 * (transferred bytes, per-folder errors, etc.) via `reportOperation` →
 * `client.reportOperation`, so the batched ack only needs a compact
 * headline. This helper:
 *
 * - reports `"<verb> N folder(s)"` when nothing failed,
 * - reports `"<verb> X/N folder(s), N failed: <first failure>"` when
 *   any folder failed, with the first failure trimmed so the line stays
 *   well below 200 chars,
 * - prefixes `dry-run: ` when `dryRun` is set,
 * - delegates the empty-batch case to the caller via the `empty`
 *   override (the dispatcher already short-circuits on no assignments
 *   with a domain-specific message).
 *
 * Note: `summarizeReportForAction` upgrades `"skipped: …"` failures to
 * `done` (lock contention isn't an error), so only true failures count
 * here.
 *
 * Pure; safe to test without a network or server. LAMA-245.
 */
export function summarizeBatchSync(
  outcomes: readonly ActionCompletion[],
  options: {
    verb: "synced" | "backed up";
    dryRun?: boolean;
    empty?: string;
  },
): ActionCompletion {
  const n = outcomes.length;
  const done = outcomes.filter((o) => o.status === "done").length;
  const failed = n - done;
  const status: "done" | "failed" = failed > 0 ? "failed" : "done";
  const prefix = options.dryRun === true ? "dry-run: " : "";

  if (n === 0) {
    return { status: "done", result: options.empty ?? `${prefix}${options.verb} 0 folder(s)` };
  }

  if (failed === 0) {
    return { status: "done", result: `${prefix}${options.verb} ${n} folder(s)` };
  }

  const firstFailure = outcomes.find((o) => o.status !== "done")?.result ?? "";
  const MAX_TAIL = 80;
  const tail = firstFailure
    ? firstFailure.length > MAX_TAIL
      ? `: ${firstFailure.slice(0, MAX_TAIL - 3)}…`
      : `: ${firstFailure}`
    : "";
  return {
    status,
    result: `${prefix}${options.verb} ${done}/${n} folder(s), ${failed} failed${tail}`,
  };
}

/** Build the completion body when the action type is unknown to the daemon. */
export function unknownActionTypeCompletion(): ActionCompletion {
  return { status: "failed", result: "unknown action type" };
}

/**
 * Type guard for the wire-side action shape. Returns `null` when the
 * payload is missing required fields; the dispatcher converts that to a
 * `failed` completion with a clear message.
 */
export function validateActionShape(
  value: unknown,
): QueuedAction | null {
  if (value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const id = obj["id"];
  const hostId = obj["hostId"];
  const type = obj["type"];
  const status = obj["status"];
  const createdAt = obj["createdAt"];
  if (typeof id !== "string") return null;
  if (typeof hostId !== "string") return null;
  if (
    type !== "trigger_sync" &&
    type !== "trigger_backup" &&
    type !== "check_update" &&
    type !== "refresh_config" &&
    type !== "update_daemon"
  ) {
    return null;
  }
  if (
    status !== "pending" &&
    status !== "taken" &&
    status !== "done" &&
    status !== "failed"
  ) {
    return null;
  }
  if (typeof createdAt !== "number") return null;
  return value as QueuedAction;
}