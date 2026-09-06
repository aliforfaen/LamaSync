// LAMA-321: pure helpers + copy for the Data Browser trash cards. Kept out
// of the page component so the exact-prefix labels and the irreversible
// confirmation copy are unit-testable without a DOM.

/** Human "folder/prefix" location shown in the card and confirm dialog. */
export function trashLocationPath(listingPath: string, prefix: string): string {
  const base = listingPath.replace(/^\/+/, "").replace(/\/+$/, "");
  return base === "" ? prefix : `${base}/${prefix}`;
}

/** Heading + action label for the empty-trash confirm dialog. */
export const EMPTY_TRASH_TITLE = "Empty trash";
export const EMPTY_TRASH_CONFIRM_LABEL = "Empty trash";

/** Must state the deletion is permanent / irreversible. */
export const EMPTY_TRASH_PERMANENT_COPY =
  "Deleting a trash is permanent and irreversible — the files cannot be recovered.";

/** One-line card description: location, owner uid, and (when known) size. */
export function trashCardSummary(
  location: string,
  uid: number,
  bytes: number | null,
  objectCount: number | null,
  measuredAt: number | null,
): string {
  const owner = `user ${uid}`;
  if (bytes === null || objectCount === null || measuredAt === null) {
    return `${location} — ${owner}, size not measured`;
  }
  return `${location} — ${owner}, ${objectCount} object${objectCount === 1 ? "" : "s"}, ${bytes} bytes`;
}
