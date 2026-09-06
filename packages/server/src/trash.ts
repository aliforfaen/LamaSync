// LAMA-321: freedesktop trash detection for Data Browser listings.
//
// Only two exact directory layouts are ever treated as trash:
//   1. a directory named `.Trash-<numeric uid>` at the listed root, and
//   2. a directory named `.Trash` at the listed root whose DIRECT children
//      include a directory named `<numeric uid>` (i.e. `.Trash/<uid>`).
//
// Everything else — `.Trash1000`, `.Trash-1000x`, a *file* named
// `.Trash-1000`, a `.Trash` with no numeric-uid child, a `.Trash/1000/..`
// traversal — is deliberately not trash. Detection operates on server-side
// listing data only (entry names/types), so entries can never smuggle path
// separators or traversal segments in: delimiter-based S3 listings and
// readdir dirents both return single-segment names. The route layers decide
// whether the extra `.Trash` child peek is needed (`hasDotTrash`).

import type { BrowseTrash } from "@lamasync/core";

export interface TrashLikeEntry {
  name: string;
  type: "dir" | "file";
}

/** A numeric uid may be any safe positive integer (freedesktop uses real
 *  user ids, but 0 and large ids are still *numeric* and valid layouts). */
export function parseTrashUid(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const uid = Number(value);
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

/**
 * Match the root-level `.Trash-<uid>` layout against the directory entries
 * of one listing. Returns the direct trash candidates plus a flag telling
 * the caller whether a `.Trash` directory was present — when true, the
 * caller should peek at `.Trash/` children and feed them to
 * `nestedTrashCandidates`.
 */
export function directTrashCandidates(
  entries: TrashLikeEntry[],
): { items: BrowseTrash[]; hasDotTrash: boolean } {
  const items: BrowseTrash[] = [];
  let hasDotTrash = false;
  for (const entry of entries) {
    if (entry.type !== "dir") continue;
    if (entry.name === ".Trash") {
      hasDotTrash = true;
      continue;
    }
    const match = /^\.Trash-(\d+)$/.exec(entry.name);
    if (match === null) continue;
    const uid = parseTrashUid(match[1] ?? "");
    if (uid !== null) items.push({ uid, prefix: entry.name });
  }
  return { items, hasDotTrash };
}

/**
 * Match the nested `.Trash/<uid>` layout against the entries INSIDE the
 * `.Trash` directory. Only direct numeric-uid directories count; a `.Trash`
 * full of files or non-numeric names is not a valid trash layout.
 */
export function nestedTrashCandidates(
  dotTrashChildren: TrashLikeEntry[],
): BrowseTrash[] {
  const items: BrowseTrash[] = [];
  for (const entry of dotTrashChildren) {
    if (entry.type !== "dir") continue;
    const uid = parseTrashUid(entry.name);
    if (uid !== null) items.push({ uid, prefix: `.Trash/${entry.name}` });
  }
  return items;
}

/** Deterministic ordering for the response: prefix-sorted. */
export function sortTrashItems(items: BrowseTrash[]): BrowseTrash[] {
  return [...items].sort((a, b) => a.prefix.localeCompare(b.prefix));
}
