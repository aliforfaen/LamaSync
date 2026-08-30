import type { Folder, FolderAssignment } from "./types.ts";

/**
 * LAMA-294: canonical destination resolution.
 *
 * LamaSync separates the rclone *connection alias* (`FolderAssignment.remoteName`)
 * from the *destination path/prefix* within that connection (`destination`). This
 * module owns the single source of truth for:
 *
 *   - how a folder/assignment resolves to its concrete destination path, and
 *   - how that destination maps to a canonical lock key used for server-side
 *     writer serialization.
 *
 * Canonical key rules (see LAMA-294 goal 3):
 *   - same canonical backup destination  => serialized writers;
 *   - different prefixes in the same backend/bucket => may run concurrently;
 *   - same Restic repository             => serialized;
 *   - ordinary backups are host-scoped by default (`<folder-name>/<host-id>`),
 *     so distinct hosts do NOT collapse onto one destination;
 *   - sync/mount destinations stay shared (`<folder-name>`).
 *
 * The key is intentionally free of credentials and deterministic, so the
 * daemon (in-process guard) and the server (cross-host lock) agree.
 */

type FolderIdentity = Pick<Folder, "id" | "name" | "type"> & {
  backend?: Folder["backend"];
  backendId?: string | null;
  s3Bucket?: string | null;
};
type AssignmentIdentity = Pick<
  FolderAssignment,
  "hostId" | "remoteName" | "destination" | "resticRepository" | "resticPassword"
>;

/** Join two path segments with a single "/", trimming empty segments. */
function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join("/");
}

/**
 * Normalize a remote destination prefix into one canonical relative path.
 * Backslashes are treated as separators so a Windows-authored assignment
 * cannot create a second lock identity for the same remote path. Dot
 * segments and absolute paths are rejected because a destination is a
 * namespace/prefix, not an arbitrary filesystem escape hatch.
 */
export function normalizeDestination(value: string): string | null {
  const raw = value.trim().replaceAll("\\", "/");
  if (raw.length === 0) return null;
  if (raw.startsWith("/")) return null;
  const parts = raw.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    return null;
  }
  return parts.join("/");
}

/**
 * The concrete destination path/prefix for an assignment.
 *
 * Honors an explicitly configured `destination`; otherwise derives the default:
 *   - backup (and restic)  => `<folder-name>/<host-id>`  (host-scoped)
 *   - everything else      => `<folder-name>`            (shared)
 */
export function resolveDestination(
  folder: FolderIdentity,
  assignment: AssignmentIdentity,
): string {
  const explicit = assignment.destination?.trim();
  if (explicit && explicit.length > 0) {
    // Server-side assignment writes validate this before persistence. Throwing
    // here makes a malformed legacy/config payload fail closed rather than
    // silently targeting a different prefix.
    const normalized = normalizeDestination(explicit);
    if (normalized === null) throw new Error("invalid backup destination prefix");
    return normalized;
  }
  return defaultDestination(folder, assignment);
}

/** Default destination when `destination` is not explicitly set. */
export function defaultDestination(
  folder: FolderIdentity,
  assignment: AssignmentIdentity,
): string {
  if (folder.type === "backup") {
    return joinPath(folder.name, assignment.hostId);
  }
  return joinPath(folder.name);
}

/** Backend/bucket identity used to key a remote destination namespace. */
function backendIdentity(folder: FolderIdentity, assignment: AssignmentIdentity): string {
  // A reusable backend row is the most precise "same connection" identity:
  // two folders referencing the same backendId share a connection. The S3
  // bucket is still part of the namespace, so different buckets must not
  // unnecessarily serialize each other.
  if (folder.backendId) {
    const bucket = folder.backend === "s3" && folder.s3Bucket
      ? `:bucket:${normalizeDestination(folder.s3Bucket) ?? folder.s3Bucket.trim()}`
      : "";
    return `${folder.backend ?? "remote"}:${folder.backendId}${bucket}`;
  }
  // Legacy SFTP and S3 folders keep the rclone connection alias on the
  // assignment. Include it so equal paths on different remotes are not
  // mistaken for the same physical destination.
  const remoteName = assignment.remoteName?.trim();
  if (remoteName) {
    if (folder.backend === "s3" && folder.s3Bucket) {
      return `s3:${remoteName}:bucket:${folder.s3Bucket.trim()}`;
    }
    return `${folder.backend ?? "remote"}:${remoteName}`;
  }
  // Legacy per-folder S3: the bucket namespaces the destination.
  if (folder.backend === "s3" && folder.s3Bucket) {
    return `s3:${folder.s3Bucket}`;
  }
  // Fallback: isolate per folder (preserves the pre-LAMA-294 single-folder
  // lock roughly, but still lets per-destination paths coexist).
  return `folder:${folder.id}`;
}

/**
 * Canonical destination/repository key for server-side locking.
 *
 * Two operations resolve to the same key iff they write the same physical
 * destination (or use the same Restic repository) and must therefore be
 * serialized. Different prefixes in the same backend/bucket yield different
 * keys and may run concurrently.
 */
export function canonicalDestinationKey(
  folder: FolderIdentity,
  assignment: AssignmentIdentity,
): string {
  // Restic repositories are their own serialization unit regardless of host.
  if (assignment.resticRepository) {
    const repo = assignment.resticRepository.trim().replace(/\/+$/, "") || "/";
    return `repo:${repo}`;
  }
  return `${backendIdentity(folder, assignment)}:path:${resolveDestination(folder, assignment)}`;
}
