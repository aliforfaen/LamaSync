// LAMA-345 — daemon-side managed-folder health probing.
//
// Layered by cost, deliberately:
//
//   lightweight (every heartbeat)   stat/access on the local dir, one statfs,
//                                   the watch controller's in-memory state,
//                                   the acknowledged filter fingerprint, a
//                                   readdir of the bisync workdir
//   post-run / explicit diagnose    listing entry counts (linear in entries)
//   slow cadence (default 24 h)     a real local file/byte measurement
//
// The heartbeat path therefore never walks a managed tree. That constraint is
// the whole point: "refresh health" must not become a recursive scan of every
// folder every 30 seconds.

import { accessSync, constants, readdirSync, statSync, statfsSync } from "fs";
import { join } from "path";
import type {
  FolderAssignment,
  FolderHealthDeepMeasurement,
  FolderHealthFacts,
  FolderHealthLocalDirState,
  FolderHealthReason,
  FolderHealthReport,
  FolderHealthState,
  FolderHealthWatcherFacts,
  FolderType,
  SeedArchiveTooling,
  SeedStagingProof,
} from "@lamasync/core";
import { deriveFolderHealth, parentPathOf, seedStagingPath } from "@lamasync/core";
import { expandHomePath } from "./config.ts";
import {
  baselineFingerprint,
  bisyncStateDir,
  inspectBisyncBaseline,
  readAcknowledgedFingerprint,
  readPendingResyncFingerprint,
} from "./bisync-baseline.ts";
import { effectiveSyncFilterPatterns, loadFilterPatterns, resolveFilterPath } from "./ignore.ts";
import { materialiseGitignoreFilter } from "./gitignore.ts";
import { effectiveFilterFingerprint } from "./bisync-baseline.ts";

/** Mirror of the executor's default disk-space floor (core may not import it). */
export const HEALTH_DISK_SPACE_DEFAULT = 1_000_000_000;

/** Upper bound for one deep measurement so a pathological tree cannot hang a
 *  scheduled probe forever. Reaching it still reports the partial total and
 *  is honest about being a floor. */
export const DEEP_MEASURE_ENTRY_CAP = 500_000;

/** LAMA-346: archive tooling present on this device. */
let cachedArchiveTooling: SeedArchiveTooling | null = null;

/**
 * Detect `tar`/`zstd`/`gzip` on PATH once per process.
 *
 * These are plain PATH lookups (no spawn), and they are reported with the
 * ordinary heartbeat so a seed plan can be built for this device without a
 * second round-trip. `force` is for tests and for an explicit re-diagnose.
 */
export function archiveToolingCached(force = false): SeedArchiveTooling {
  if (force || cachedArchiveTooling === null) {
    cachedArchiveTooling = {
      tar: Bun.which("tar") !== null,
      zstd: Bun.which("zstd") !== null,
      gzip: Bun.which("gzip") !== null,
    };
  }
  return cachedArchiveTooling;
}

/**
 * LAMA-346: the target's own proof that a seed's staging sibling can be
 * published with one atomic rename.
 *
 * The server cannot stat the target's filesystem, so it cannot prove this; the
 * device can. `seedStagingPath` always derives a sibling, so the proof reduces
 * to: the staging sibling's parent IS the target's parent, and that directory
 * is readable (one `statSync`, no walk). When it is not readable the verdict is
 * `null` — unknown, which the plan refuses rather than assumes.
 */
export function seedStagingProofFor(localPath: string, now: number = Date.now()): SeedStagingProof {
  const targetPath = expandHomePath(localPath);
  const targetParent = parentPathOf(targetPath);
  const staging = seedStagingPath(targetPath, "probe");
  const stagingParent = staging === null ? null : parentPathOf(staging);
  let device: number | null = null;
  if (targetParent !== null && stagingParent === targetParent) {
    try {
      device = statSync(targetParent).dev;
    } catch {
      device = null;
    }
  }
  const sameFilesystem =
    targetParent !== null && stagingParent === targetParent && device !== null ? true : null;
  return {
    targetPath: targetParent === null ? null : targetPath,
    targetParent,
    stagingParent,
    sameFilesystem,
    device,
    checkedAt: now,
  };
}

export interface FolderHealthProbeOptions {
  assignment: FolderAssignment;
  /** Folder type after the per-host sync/mount override. */
  effectiveType: FolderType;
  enabled: boolean;
  paused: boolean;
  runInProgress: boolean;
  activePhase: string | null;
  rcloneAvailable: boolean;
  pendingConflicts: number;
  watcher: FolderHealthWatcherFacts | null;
  lastRun: { status: string; summary: string | null; at: number | null } | null;
  /** Reused deep measurement (only refreshed on the slow cadence). */
  measurement: FolderHealthDeepMeasurement | null;
  /** Read listing entry counts (post-run / explicit diagnose only). */
  readCounts: boolean;
  /** Override the workdir (tests). */
  stateDir?: string;
  now?: number;
}

export interface FolderHealthProbeResult {
  report: FolderHealthReport;
  /** True when a forced safe resync is outstanding. */
  resyncPending: boolean;
}

interface StatfsLike {
  bavail?: number;
  bsize?: number;
  blocks?: number;
  bfree?: number;
}

/** Free bytes for the filesystem holding `path`, or null when unresolvable. */
export function freeSpaceBytes(path: string): number | null {
  try {
    const stat = statfsSync(path) as unknown as StatfsLike;
    const available = stat.bavail ?? stat.bfree;
    const size = stat.bsize;
    if (typeof available !== "number" || typeof size !== "number") return null;
    const bytes = available * size;
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Classify the local directory without walking it: existence, directory-ness,
 * readability and writability. Read/write checks are `access(2)` calls, not
 * content probes, so a huge or slow tree costs nothing.
 */
export function probeLocalDir(localPath: string): FolderHealthLocalDirState {
  let stat;
  try {
    stat = statSync(localPath);
  } catch {
    return "missing";
  }
  if (!stat.isDirectory()) return "not_directory";
  try {
    accessSync(localPath, constants.R_OK);
  } catch {
    return "unreadable";
  }
  try {
    accessSync(localPath, constants.W_OK);
  } catch {
    return "unwritable";
  }
  return "ok";
}

/**
 * Bounded recursive local measurement. Only called deliberately — never from
 * the heartbeat path. Directories without read permission are counted but not
 * descended into, and the walk stops at `DEEP_MEASURE_ENTRY_CAP` entries.
 */
export function measureLocalTree(root: string): FolderHealthDeepMeasurement {
  let pathCount = 0;
  let totalBytes = 0;
  const stack: string[] = [root];
  while (stack.length > 0 && pathCount < DEEP_MEASURE_ENTRY_CAP) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (pathCount >= DEEP_MEASURE_ENTRY_CAP) break;
      pathCount += 1;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      try {
        totalBytes += statSync(full).size;
      } catch {
        // Raced with a deletion — the count is a floor, never a hard claim.
      }
    }
  }
  return { pathCount, totalBytes, measuredAt: Date.now() };
}

/** Type-safe filter mode string for `resolveFilterPath`. */
function filterModeFor(effectiveType: string): "sync" | "mount" {
  return effectiveType === "mount" ? "mount" : "sync";
}

export interface EffectiveFilterInfo {
  patterns: string[];
  source: FolderHealthFacts["filter"]["source"];
}

/**
 * The cheap half of the filter universe: the configured `.lamasyncignore`
 * patterns plus the `- .git/**` rule. The Git-ignore snapshot component is
 * deliberately NOT recomputed here (it walks the tree); the executor owns
 * that during a run and the resulting acknowledged fingerprint is what the
 * probe reports.
 */
export function cheapEffectiveFilter(
  assignment: FolderAssignment,
  folderType: FolderType,
): EffectiveFilterInfo {
  const filterPath = resolveFilterPath(
    assignment.ignorePath ?? null,
    assignment.mountIgnorePath ?? null,
    filterModeFor(folderType),
  );
  const configured = loadFilterPatterns(filterPath, expandHomePath(assignment.localPath));
  const patterns = effectiveSyncFilterPatterns(
    configured,
    folderType,
    assignment.ignoreGitMetadata,
  );
  const source: EffectiveFilterInfo["source"] =
    patterns.length === 0
      ? "none"
      : assignment.respectGitignore === true
        ? "combined"
        : "lamasyncignore";
  return { patterns, source };
}

/**
 * The full live effective-filter fingerprint. This one DOES walk a Git
 * worktree (via the snapshot builder), so it is only called from paths that
 * already justify that cost: a real run, an explicit plan, or an explicit
 * diagnose.
 */
export function liveFilterFingerprint(
  assignment: FolderAssignment,
  effectiveType: FolderType,
): { fingerprint: string | null; source: FolderHealthFacts["filter"]["source"]; patternCount: number } {
  const info = cheapEffectiveFilter(assignment, effectiveType);
  let rules: string[] | null = null;
  if (assignment.respectGitignore) {
    const gf = materialiseGitignoreFilter(
      expandHomePath(assignment.localPath),
      info.patterns,
    );
    rules = gf ? gf.rules : [];
  }
  if (rules === null && info.patterns.length === 0) {
    return { fingerprint: null, source: info.source, patternCount: 0 };
  }
  return {
    fingerprint: effectiveFilterFingerprint(rules, info.patterns),
    source: info.source,
    patternCount: info.patterns.length,
  };
}

/**
 * Build one assignment health report. Pure with respect to the filesystem
 * (reads only), so it is safe to call on every heartbeat.
 */
export function probeFolderHealth(opts: FolderHealthProbeOptions): FolderHealthProbeResult {
  const { assignment } = opts;
  const now = opts.now ?? Date.now();
  const localPath = expandHomePath(assignment.localPath);
  const stateDir = opts.stateDir ?? bisyncStateDir(assignment.folderId);

  const localDir = probeLocalDir(localPath);
  const free = localDir === "missing" ? null : freeSpaceBytes(localPath);
  const threshold =
    opts.effectiveType === "sync" ||
    opts.effectiveType === "backup" ||
    opts.effectiveType === "mount"
      ? assignment.availableSpaceThreshold ?? HEALTH_DISK_SPACE_DEFAULT
      : null;

  const baseline = inspectBisyncBaseline(stateDir, { readCounts: opts.readCounts });
  const pending = readPendingResyncFingerprint(stateDir);
  const acknowledged = readAcknowledgedFingerprint(stateDir);
  const filterInfo = cheapEffectiveFilter(assignment, opts.effectiveType);

  const facts: FolderHealthFacts = {
    folderType: opts.effectiveType,
    effectiveType: opts.effectiveType,
    enabled: opts.enabled,
    paused: opts.paused,
    runInProgress: opts.runInProgress,
    rcloneAvailable: opts.rcloneAvailable,
    archive: archiveToolingCached(),
    seedStaging: seedStagingProofFor(assignment.localPath, now),
    localDir,
    freeSpaceBytes: free,
    freeSpaceThresholdBytes: threshold,
    watcher: opts.watcher,
    filter: {
      // The acknowledged fingerprint is what the *baseline* was built with;
      // reporting the live cheap value here would claim a state the listings
      // do not have.
      fingerprint: acknowledged,
      source: filterInfo.source,
      changedSinceBaseline: pending !== null,
      // Countable without a tree walk; the Git-ignore snapshot is added at run
      // time, so this is a floor and is labelled as one.
      patternCount: filterInfo.patterns.length,
    },
    baseline: {
      present: baseline.present,
      ready: baseline.ready,
      error: baseline.error,
      path1Count: baseline.path1Count,
      path2Count: baseline.path2Count,
      updatedAt: baseline.updatedAt === null ? null : Math.round(baseline.updatedAt),
      fingerprint: baselineFingerprint(baseline),
    },
    activePhase: opts.activePhase,
    pendingConflicts: opts.pendingConflicts,
    lastRun: opts.lastRun,
    measurement: opts.measurement,
  };

  const { state, reasons } = deriveFolderHealth(facts);
  return {
    report: {
      hostId: assignment.hostId,
      folderId: assignment.folderId,
      assignmentId: assignment.id,
      state,
      reasons,
      facts,
      reportedAt: now,
    },
    resyncPending: pending !== null,
  };
}

/**
 * Read-only diagnosis for the `diagnose_folder` action: the same probe plus
 * the listing-pair identity and the acknowledged/pending fingerprints, which
 * the lightweight heartbeat deliberately leaves out.
 */
export interface FolderDiagnosis {
  assignmentId: string;
  folderId: string;
  hostId: string;
  state: FolderHealthState;
  reasons: FolderHealthReason[];
  localPath: string;
  localDir: FolderHealthLocalDirState;
  freeSpaceBytes: number | null;
  freeSpaceThresholdBytes: number | null;
  baseline: {
    present: boolean;
    ready: boolean;
    error: boolean;
    stems: string[];
    updatedAt: number | null;
    path1Count: number | null;
    path2Count: number | null;
    fingerprint: string;
  };
  filter: {
    source: FolderHealthFacts["filter"]["source"];
    patternCount: number;
    acknowledgedFingerprint: string | null;
    pendingFingerprint: string | null;
  };
  measurement: FolderHealthDeepMeasurement | null;
  rcloneAvailable: boolean;
  diagnosedAt: number;
}

export function diagnoseFolder(opts: FolderHealthProbeOptions): FolderDiagnosis {
  const probe = probeFolderHealth(opts);
  const stateDir = opts.stateDir ?? bisyncStateDir(opts.assignment.folderId);
  const inspection = inspectBisyncBaseline(stateDir, { readCounts: true });
  const filterInfo = cheapEffectiveFilter(opts.assignment, opts.effectiveType);
  return {
    assignmentId: opts.assignment.id,
    folderId: opts.assignment.folderId,
    hostId: opts.assignment.hostId,
    state: probe.report.state,
    reasons: probe.report.reasons,
    localPath: expandHomePath(opts.assignment.localPath),
    localDir: probe.report.facts.localDir,
    freeSpaceBytes: probe.report.facts.freeSpaceBytes,
    freeSpaceThresholdBytes: probe.report.facts.freeSpaceThresholdBytes,
    baseline: {
      present: inspection.present,
      ready: inspection.ready,
      error: inspection.error,
      stems: inspection.stems,
      updatedAt: inspection.updatedAt === null ? null : Math.round(inspection.updatedAt),
      path1Count: inspection.path1Count,
      path2Count: inspection.path2Count,
      fingerprint: baselineFingerprint(inspection),
    },
    filter: {
      source: filterInfo.source,
      patternCount: filterInfo.patterns.length,
      acknowledgedFingerprint: readAcknowledgedFingerprint(stateDir),
      pendingFingerprint: readPendingResyncFingerprint(stateDir),
    },
    measurement: opts.measurement,
    rcloneAvailable: opts.rcloneAvailable,
    diagnosedAt: opts.now ?? Date.now(),
  };
}
