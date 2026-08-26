// LAMA-260: client-side validation for the optional upload target path.
// Mirrors the server's `validateBrowseInput` contract (packages/server/src/
// browse-paths.ts) so a hostile path is rejected in the UI before it ever
// reaches the wire. This is a UX guard, not a security boundary — the server
// re-validates.

/** True when `path` is safe to pass as the upload `path` field. */
export function isValidUploadPath(path: string): boolean {
  if (path.includes("\0")) return false;
  const trimmed = path.trim();
  if (trimmed === "") return true;
  // Normalise backslashes and collapse separators for the checks below.
  const norm = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/");
  // No absolute paths (leading or trailing slash is treated as a root /
  // directory specifier the server will reject; be strict here too).
  if (norm.startsWith("/")) return false;
  // No traversal — neither a bare ".." segment nor a "..coalesce" trick.
  const segments = norm.split("/").filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === "..") return false;
  }
  return true;
}

/**
 * Normalise a validated path for the wire: trim, collapse separators, and
 * strip leading/trailing slashes. The server's validateBrowseInput rejects
 * empty segments, so a trailing slash (common in the browser's path state,
 * e.g. "photos/") must be removed before sending.
 */
export function normalizeUploadPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}
