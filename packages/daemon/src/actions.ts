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
  reportStatus: "success" | "failed" | "conflict" | "retry" | "recovery" | "started",
  reportSummary: string | null,
  fallback: string,
): ActionCompletion {
  const summary = reportSummary ?? fallback;
  if (reportStatus === "failed" && summary.startsWith("skipped:")) {
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
    type !== "refresh_config"
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