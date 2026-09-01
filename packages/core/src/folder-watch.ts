// LAMA-302: event-triggered sync for active local worktrees.
//
// Shared helpers for the watch configuration contract. These live in core so
// the server (API validation), daemon (default resolution), and CLI all agree
// on the same constants without importing each other.
//
// The four fields live on `FolderAssignment`:
//   watchEnabled      default false
//   watchQuietSec     null => 30 s default; validated 10-300 s
//   ignoreGitMetadata default false (exclude .git/)
//   respectGitignore  default false (apply Git ignore semantics)
//
// They are only honored for effective `sync` assignments — see
// ./effective-type.ts. Nothing here starts a watcher; it only defines the
// configuration contract.

/** Default debounce window (seconds) after the last local write. */
export const WATCH_QUIET_SEC_DEFAULT = 30;

/** Inclusive lower bound for `watchQuietSec`. */
export const WATCH_QUIET_SEC_MIN = 10;

/** Inclusive upper bound for `watchQuietSec`. */
export const WATCH_QUIET_SEC_MAX = 300;

/**
 * Resolve a stored `watchQuietSec` value to the effective quiet period.
 * `null`/`undefined` (or any non-positive value) maps to the 30 s default.
 * The API boundary rejects out-of-range values, so this is a defensive
 * fallback for rows written before validation or by a buggy client.
 */
export function resolveWatchQuietSec(
  value: number | null | undefined,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return WATCH_QUIET_SEC_DEFAULT;
  }
  if (value < WATCH_QUIET_SEC_MIN) return WATCH_QUIET_SEC_MIN;
  if (value > WATCH_QUIET_SEC_MAX) return WATCH_QUIET_SEC_MAX;
  return Math.trunc(value);
}

/**
 * True when `value` is a valid `watchQuietSec` (null, or an integer within
 * [WATCH_QUIET_SEC_MIN, WATCH_QUIET_SEC_MAX]). The wire contract permits
 * `null` (=> default) and rejects anything outside the validated range.
 */
export function isValidWatchQuietSec(value: number | null): boolean {
  if (value === null) return true;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (value !== Math.trunc(value)) return false;
  return value >= WATCH_QUIET_SEC_MIN && value <= WATCH_QUIET_SEC_MAX;
}

/**
 * Normalize an arbitrary `watchQuietSec` input (from a validated API body)
 * to `number | null`, where `null` means "use the default". Any invalid
 * value collapses to `null` so the stored row never carries a garbage
 * number; the API route rejects the bad input before this runs.
 */
export function normalizeWatchQuietSec(
  value: unknown,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value !== Math.trunc(value)) return null;
  if (value < WATCH_QUIET_SEC_MIN || value > WATCH_QUIET_SEC_MAX) return null;
  return value;
}
