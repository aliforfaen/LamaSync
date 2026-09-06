// LAMA-321: on-demand recursive size for one folder-relative browse prefix.
//
// Sizes are expensive to compute (an S3 prefix may need many paginated
// ListObjectsV2 round-trips; a local tree may hold hundreds of thousands of
// entries), so results are never computed during normal browsing. Instead a
// browse "size" job computes ONE prefix, seeds the module-level cache below,
// and the listing route merges a fresh cache hit into that directory row.
//
// Cache freshness: entries expire after SIZE_CACHE_TTL_MS, and every browse
// write (delete/copy/move/rename/mkdir/upload) drops the whole folder's
// cache. A per-folder write "generation" additionally stops an in-flight
// size job from seeding a snapshot that started BEFORE a write landed on
// the same folder (the write's completion already dropped the folder, so a
// late seed would resurrect stale numbers).

import { readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { BrowsePrefixSize, BrowseRef } from "@lamasync/core";
import { destKey } from "./browse-rclone.ts";
import { resolveBrowsePath } from "./browse-paths.ts";

export interface PrefixSizeCount {
  objectCount: number;
  bytes: number;
}

const SIZE_CACHE_TTL_MS = 5 * 60_000;

interface CachedSize extends BrowsePrefixSize {}

const prefixSizeCache = new Map<string, CacheEntry>();
// Folder scope (e.g. "s3:<folderId>:" / "local::") → number of browse
// writes started on that folder since server start.
const folderWriteGenerations = new Map<string, number>();

/**
 * Canonical destKey for `ref` with `prefix` appended — the identity of a
 * sized prefix (e.g. "s3:folder-1:a/.Trash-1000"). Mirrors the key browse
 * jobs use for the same target, so write drops line up with size seeds.
 */
export function prefixSizeKey(ref: BrowseRef, prefix: string): string {
  const base = ref.path.replace(/^\/+/, "").replace(/\/+$/, "");
  const joined = base === "" ? prefix : `${base}/${prefix}`;
  return destKey({ kind: ref.kind, folderId: ref.folderId ?? null, path: joined });
}

/** The kind/folder identity prefix every key of this folder starts with. */
function folderKeyPrefix(ref: BrowseRef): string {
  return `${ref.kind}:${ref.folderId ?? ""}:`;
}

interface CacheEntry {
  /** kind of the sized namespace ("local" | "s3"). */
  kind: string;
  /** Folder id for s3 ("" for local). */
  folderId: string;
  /** Canonical relative path of the measured prefix ("" = never cached). */
  path: string;
  size: CachedSize;
}

export function getCachedPrefixSize(
  ref: BrowseRef,
  prefix: string,
): BrowsePrefixSize | null {
  const key = prefixSizeKey(ref, prefix);
  const hit = prefixSizeCache.get(key);
  if (hit === undefined) return null;
  if (Date.now() - hit.size.calculatedAt > SIZE_CACHE_TTL_MS) {
    prefixSizeCache.delete(key);
    return null;
  }
  return { ...hit.size };
}

/**
 * Record a freshly computed size for `prefix`. Returns the cached entry, or
 * null when the folder's write generation moved past `unlessGenerationAfter`
 * while the size job was running (a concurrent write makes the snapshot
 * stale — do not resurrect it).
 */
export function seedPrefixSize(
  ref: BrowseRef,
  prefix: string,
  size: PrefixSizeCount,
  opts: { unlessGenerationAfter?: number } = {},
): BrowsePrefixSize | null {
  if (opts.unlessGenerationAfter !== undefined) {
    const current = folderWriteGenerations.get(folderScope(ref)) ?? 0;
    if (current > opts.unlessGenerationAfter) return null;
  }
  const path = prefixSizeKey(ref, prefix);
  const entry: CacheEntry = {
    kind: ref.kind,
    folderId: ref.folderId ?? "",
    path: canonicalEntryPath(ref, prefix),
    size: {
      objectCount: size.objectCount,
      bytes: size.bytes,
      calculatedAt: Date.now(),
    },
  };
  prefixSizeCache.set(path, entry);
  return { ...entry.size };
}

/** Canonical measured path stored with each cache entry. */
function canonicalEntryPath(ref: BrowseRef, prefix: string): string {
  const base = ref.path.replace(/^\/+/, "").replace(/\/+$/, "");
  return base === "" ? prefix : `${base}/${prefix}`;
}

/** Folder-wide identity used by the write-generation guard. */
function folderScope(ref: BrowseRef): string {
  return destKey({ kind: ref.kind, folderId: ref.folderId ?? null, path: "" });
}

/** Bump the folder write generation; returns the new value. */
export function bumpFolderWriteGeneration(ref: BrowseRef): number {
  const scope = folderScope(ref);
  const next = (folderWriteGenerations.get(scope) ?? 0) + 1;
  folderWriteGenerations.set(scope, next);
  return next;
}

/** Current write generation of the ref's folder (0 = no writes yet). */
export function folderWriteGeneration(ref: BrowseRef): number {
  return folderWriteGenerations.get(folderScope(ref)) ?? 0;
}

/**
 * Drop cached sizes a write at `ref` could have invalidated. A write at
 * path P changes the measured contents of P itself, anything nested under
 * P (keys "P/…"), and any measured ancestor directory of P. Sibling
 * prefixes under other directories are untouched, so one folder's writes
 * never evict an unrelated measurement.
 */
export function dropFolderPrefixSizes(ref: BrowseRef): void {
  const folderId = ref.folderId ?? "";
  const prefix = folderKeyPrefix(ref);
  const writePath = ref.path.replace(/^\/+/, "").replace(/\/+$/, "");
  for (const [key, entry] of prefixSizeCache) {
    if (entry.kind !== ref.kind || entry.folderId !== folderId) continue;
    if (!key.startsWith(prefix)) continue;
    if (pathsIntersect(writePath, entry.path)) {
      prefixSizeCache.delete(key);
    }
  }
}

/** True when a write at `a` can change the measured contents of `b`. */
function pathsIntersect(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === "") return true; // root write touches everything
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function __resetBrowseSizesForTests(): void {
  prefixSizeCache.clear();
  folderWriteGenerations.clear();
}

/**
 * Recursively measure a LOCAL directory. Dirent types come from the readdir
 * snapshot itself, so symbolic links are recognized and skipped without a
 * stat round-trip: the walk never follows a link and therefore can never
 * escape the resolved target. A file removed between readdir and its size
 * stat is skipped rather than fatal.
 */
function walkDirectory(dir: string): PrefixSizeCount {
  let objectCount = 0;
  let bytes = 0;
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      // Directory vanished mid-walk — the partial count is the truth.
      return { objectCount, bytes };
    }
    throw err;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walkDirectory(full);
      objectCount += sub.objectCount;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      try {
        const st = statSync(full);
        bytes += st.size;
        objectCount += 1;
      } catch {
        // Removed between readdir and stat.
      }
    }
  }
  return { objectCount, bytes };
}

/**
 * Resolve a local folder-relative prefix to an absolute directory under the
 * backup root and measure it. Returns zeroes when the prefix no longer
 * exists; throws (with no path material) when the tree cannot be read.
 */
export function computeLocalPrefixSize(rel: string): PrefixSizeCount {
  const root = process.env.LAMASYNC_BACKUP_DIR ?? "/backups";
  const resolved = resolveBrowsePath(root, rel);
  if (resolved === null) return { objectCount: 0, bytes: 0 };
  return walkDirectory(resolved);
}
