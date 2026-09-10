// LAMA-328: how one folder's size is presented in the Folders/Backups table.
// Kept out of the page component (same pattern as `trash.ts` and
// `backup-health.ts`) so the freshness rules are unit-testable: a last-known
// measurement marked `stale` by the server must never read as current, and an
// in-flight refresh must be visible while it runs.
//
// The server's FolderSize contract:
//   bytes === null            -> nothing measured (never measured, or the folder
//                                is not measurable server-side / the backend is
//                                unreachable) — `error` says which
//   measuredAt                -> when `bytes` were really measured (null when the
//                                measurement has never succeeded)
//   stale                     -> those bytes are last-known, not current
//   refreshing                -> a bounded background refresh is queued/running

import type { FolderSize } from "@lamasync/core";
import { formatBytes } from "./format-bytes.ts";
import { formatTimeAgo } from "./relative-time.ts";

export interface SizeCell {
  /** Text for the Size column. */
  text: string;
  /** The raw value, so callers can decide whether a suffix makes sense. */
  bytes?: number | null;
  /** The most recent measurement attempt failed. */
  error?: boolean;
  /** Last-known bytes that are past the freshness window. */
  stale?: boolean;
  /** A refresh is queued or running for this folder. */
  refreshing?: boolean;
  measuredAt?: number | null;
}

export function toSizeCell(size: FolderSize | undefined): SizeCell {
  if (size === undefined) return { text: "—" };
  return {
    text:
      size.bytes === null
        ? size.refreshing === true
          ? "measuring…"
          : "n/a"
        : formatBytes(size.bytes),
    bytes: size.bytes,
    error: size.error !== null,
    stale: size.stale === true,
    refreshing: size.refreshing === true,
    measuredAt: size.measuredAt,
  };
}

/** Tooltip for a Size cell: never let last-known bytes read as current. */
export function sizeTitle(size: SizeCell): string | undefined {
  if (size.bytes === null || size.bytes === undefined) {
    return size.error
      ? "size unavailable (not measurable server-side, or the backend is unreachable)"
      : undefined;
  }
  const measured =
    size.measuredAt === null || size.measuredAt === undefined
      ? "never measured"
      : `measured ${formatTimeAgo(size.measuredAt)}`;
  if (size.error) return `${measured} — the last refresh failed`;
  if (size.stale) return `${measured} — refreshing in the background`;
  if (size.refreshing) return `${measured} — refreshing in the background`;
  return measured;
}

/** Suffix rendered after a known value (" · stale" / " · refreshing"), if any.
 *  A value that has never been measured already says so in `text`. */
export function sizeSuffix(size: SizeCell): string | null {
  if (size.bytes === null || size.bytes === undefined) return null;
  if (size.stale) return "stale";
  if (size.refreshing) return "refreshing";
  return null;
}
