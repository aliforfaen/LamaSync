// LAMA-345 — bisync listing-pair inspection.
//
// The daemon used to decide "is this the first bisync?" by looking for
// `<workdir>/bisync.state`. rclone has never written that file: it persists
// one *listing per path* in the workdir, named after the two paths
// (`<path1>..<path2>.path1.lst` / `.path2.lst`) plus transient siblings
// (`.lst-new` while a run is writing, `.lst-err` after a critical error).
// The sentinel therefore never existed, every run looked like a first run,
// and LamaSync forced `--resync` on every invocation — with the command's
// implicit Path 1 (= remote) authority. That is the defect this module fixes.
//
// Everything here is pure filesystem inspection: no rclone invocation, no
// network, no credentials.

import { readdirSync, readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";

/** The workdir the daemon passes to `rclone bisync --workdir`. */
export function bisyncStateDir(folderId: string, home: string = homedir()): string {
  return join(home, ".local", "share", "lamasync", "bisync", folderId);
}

/** Acknowledged effective-filter fingerprint lives beside the listings. */
export const FILTER_FINGERPRINT_FILENAME = ".filter-fingerprint";
/** Pre-LAMA-345 name of the same file (gitignore rules only). */
export const LEGACY_FILTER_HASH_FILENAME = ".filter-snapshot.hash";
/**
 * Present (with the pending fingerprint as its content) while a forced safe
 * resync is outstanding because the synchronization universe changed. The
 * executor writes it when it detects the change and deletes it only after the
 * resync actually succeeded — so a failed resync can never silently
 * acknowledge a new filter set.
 */
export const RESYNC_REQUIRED_FILENAME = ".resync-required";

export interface BisyncListingFile {
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface BisyncBaselineInspection {
  /** A complete `<stem>.path1.lst` + `<stem>.path2.lst` pair exists. */
  present: boolean;
  /**
   * The pair is usable: no `.lst-err` marker and no in-flight `.lst-new`
   * file. Only a ready pair proves a resumable baseline.
   */
  ready: boolean;
  /** rclone wrote a critical-error marker; runs abort until `--resync`. */
  error: boolean;
  /** Matching stems (bounded — a workdir holds one pair per path combo). */
  stems: string[];
  /** Newest listing mtime across the pairs. */
  updatedAt: number | null;
  /** Entry counts, only populated when `readCounts` was requested. */
  path1Count: number | null;
  path2Count: number | null;
}

const EMPTY: BisyncBaselineInspection = {
  present: false,
  ready: false,
  error: false,
  stems: [],
  updatedAt: null,
  path1Count: null,
  path2Count: null,
};

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(file: string): BisyncListingFile | null {
  try {
    const s = statSync(file);
    return { name: file, sizeBytes: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Count entries in one rclone listing file. The format is a one-line JSON
 * header followed by one JSON line per entry, so the count is
 * `non-empty lines - 1`. Unreadable files count as 0 rather than throwing —
 * a health probe must never fail a run.
 */
export function countListingEntries(file: string): number {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  let lines = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) lines += 1;
  }
  return Math.max(0, lines - 1);
}

/**
 * Inspect the bisync workdir for a usable listing pair.
 *
 * `readCounts` is deliberately opt-in: reading a listing file is linear in
 * the number of entries, so the lightweight heartbeat path leaves it false
 * and only post-run / explicit-diagnose paths ask for real counts.
 */
export function inspectBisyncBaseline(
  stateDir: string,
  opts: { readCounts?: boolean } = {},
): BisyncBaselineInspection {
  const entries = safeReaddir(stateDir);
  if (entries.length === 0) return { ...EMPTY };

  const path1 = new Map<string, BisyncListingFile>();
  const path2 = new Map<string, BisyncListingFile>();
  const inFlight = new Set<string>();
  let error = false;

  for (const name of entries) {
    if (name.endsWith(".lst-err")) {
      error = true;
      continue;
    }
    if (name.endsWith(".path1.lst-new")) {
      inFlight.add(name.slice(0, -".path1.lst-new".length));
      continue;
    }
    if (name.endsWith(".path2.lst-new")) {
      inFlight.add(name.slice(0, -".path2.lst-new".length));
      continue;
    }
    if (name.endsWith(".path1.lst")) {
      const stat = safeStat(join(stateDir, name));
      if (stat) path1.set(name.slice(0, -".path1.lst".length), stat);
      continue;
    }
    if (name.endsWith(".path2.lst")) {
      const stat = safeStat(join(stateDir, name));
      if (stat) path2.set(name.slice(0, -".path2.lst".length), stat);
    }
  }

  const stems: string[] = [];
  let updatedAt: number | null = null;
  for (const [stem, file] of path1) {
    if (!path2.has(stem)) continue;
    stems.push(stem);
    const other = path2.get(stem)!;
    const newest = Math.max(file.mtimeMs, other.mtimeMs);
    if (updatedAt === null || newest > updatedAt) updatedAt = newest;
  }
  stems.sort();

  if (stems.length === 0) {
    // An `.lst-err` with no surviving pair is still a real error state.
    return { ...EMPTY, error };
  }

  const present = true;
  const ready = !error && !stems.some((stem) => inFlight.has(stem));
  let path1Count: number | null = null;
  let path2Count: number | null = null;
  if (opts.readCounts === true) {
    const stem = stems[0]!;
    path1Count = countListingEntries(join(stateDir, `${stem}.path1.lst`));
    path2Count = countListingEntries(join(stateDir, `${stem}.path2.lst`));
  }

  return { present, ready, error, stems, updatedAt, path1Count, path2Count };
}

/**
 * Stable identity of the baseline for plan invalidation: the paired stems and
 * their listing mtimes/sizes. Any re-write of the listings (a run, a resync, a
 * manual archive) changes it, which is exactly when a reviewed plan stops
 * being trustworthy.
 */
export function baselineFingerprint(inspection: BisyncBaselineInspection): string {
  if (!inspection.present) return "none";
  return createHash("sha256")
    .update(`${inspection.stems.join(",")}|${inspection.updatedAt ?? 0}`)
    .digest("hex");
}

/**
 * Fingerprint of the effective filter universe. Combines the Git-ignore
 * rule snapshot (when `respectGitignore` is on) with the `.lamasyncignore`
 * patterns, so a change to *either* source is detected. A changed universe
 * must never silently reuse stale listings.
 */
export function effectiveFilterFingerprint(
  gitignoreRules: readonly string[] | null,
  patterns: readonly string[],
): string {
  const git = gitignoreRules === null ? "" : gitignoreRules.join("\n");
  return createHash("sha256")
    .update(`${git}\u0000${patterns.join("\n")}`)
    .digest("hex");
}

/** Hash of the Git-ignore rules alone — the pre-LAMA-345 fingerprint. */
export function gitignoreOnlyFingerprint(gitignoreRules: readonly string[]): string {
  return createHash("sha256").update(gitignoreRules.join("\n")).digest("hex");
}

/**
 * Read the acknowledged effective-filter fingerprint from the workdir.
 * Returns null when nothing has been acknowledged yet (first run) — the
 * caller then forces one resync, which is the pre-existing first-run rule.
 */
export function readAcknowledgedFingerprint(stateDir: string): string | null {
  const current = readTrimmed(join(stateDir, FILTER_FINGERPRINT_FILENAME));
  if (current !== null) return current;
  return readTrimmed(join(stateDir, LEGACY_FILTER_HASH_FILENAME));
}

/**
 * The fingerprint a pending forced resync is waiting to acknowledge, or null
 * when no resync is outstanding. Cheap (one stat + small read), so the
 * heartbeat probe can call it on every report.
 */
export function readPendingResyncFingerprint(stateDir: string): string | null {
  return readTrimmed(join(stateDir, RESYNC_REQUIRED_FILENAME));
}

function readTrimmed(file: string): string | null {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Reconcile the acknowledged fingerprint with the live one.
 *
 * Migration rule: a workdir written before LAMA-345 holds the *Git-ignore-only*
 * hash. When the stored value still matches the current Git-ignore-only hash
 * (i.e. nothing changed on that side), the unified fingerprint is adopted
 * WITHOUT a resync — that matches the pre-upgrade behaviour exactly, where a
 * `.lamasyncignore` change alone did not force a resync. Any other mismatch is
 * a real change and must force one.
 */
export function reconcileFingerprint(
  stored: string | null,
  unified: string,
  gitignoreOnly: string | null,
): { changed: boolean; acknowledge: string } {
  if (stored === null) return { changed: true, acknowledge: unified };
  if (stored === unified) return { changed: false, acknowledge: unified };
  if (gitignoreOnly !== null && stored === gitignoreOnly) {
    return { changed: false, acknowledge: unified };
  }
  return { changed: true, acknowledge: unified };
}
