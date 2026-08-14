// LAMA-239: per-host mount/sync override.
//
// A folder has a single global `type` (`sync | mount | backup | dotfile | git`);
// a folder assignment may carry an `AssignmentMode` override (`inherit | sync
// | mount`). The override is only meaningful for `sync` and `mount` folders —
// `backup`, `dotfile`, and `git` folders keep their folder-level type
// regardless of any per-host `mode` value (those types don't have a mount
// equivalent, so an override would either silently no-op or, worse, change
// behavior the operator didn't ask for).
//
// Keep this helper allocation-free; it's called on the hot path of every
// `runOnce` and inside the scheduler.
import type { AssignmentMode, Folder, FolderAssignment, FolderType } from "./types.ts";

export function effectiveFolderType(
  folder: Folder,
  assignment: FolderAssignment,
): FolderType {
  if (folder.type !== "sync" && folder.type !== "mount") return folder.type;
  return assignment.mode === "mount" || assignment.mode === "sync"
    ? assignment.mode
    : folder.type;
}

/** Narrow an arbitrary string to a valid AssignmentMode, with a default. */
export function normalizeAssignmentMode(value: unknown): AssignmentMode {
  return value === "sync" || value === "mount" || value === "inherit"
    ? value
    : "inherit";
}