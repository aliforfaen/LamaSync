// LAMA-346 — initial large-folder seeding and progress-aware sync timeouts.
//
// Why this exists: a first bisync against a large folder is not a sync, it is
// a full-tree transfer. On 2026-09-17 the dev-vm initial bisync against the
// master's 91,660-file / 14.86 GB Projects tree repeatedly hit the fixed
// 600-second wall-clock timeout with exit 143, before any completed
// transfer/check was recorded; each top-level retry cycle lasted ~43.5
// minutes and the recovery that finally worked moved 850 items / 16.9 MiB.
// The timeout is the defect: it measures elapsed time, not progress.
//
// This module is the shared, dependency-free contract for the replacement:
//
//   * a user-approved SEED PLAN (never automatic) that is only *recommended*
//     above a file-count threshold;
//   * a deterministic space calculation for a temporary archive plus a
//     staging directory beside the final target;
//   * a resumable, persisted job state machine with phases, bounded progress
//     and a renewable lease;
//   * a progress-aware deadline: long work is allowed while measurable phase
//     progress continues, and fails when it stalls.
//
// It must stay free of node built-ins so the web UI can import it unchanged.

// ---------------------------------------------------------------------------
// Limits and thresholds
// ---------------------------------------------------------------------------

/**
 * Above this many files a first full bisync is *recommended* to be replaced by
 * an explicit seed transfer. It is a recommendation, never a trigger: the
 * plan is only ever created by an operator request (`POST /folders/:id/seed-plans`).
 *
 * 3,000 is the value the issue names. It is deliberately well below the
 * 91,660-file case that produced the incident so the recommendation appears
 * long before a folder becomes un-syncable, and well above the 850-file
 * dev-vm recovery that completed normally.
 */
export const SEED_RECOMMENDATION_FILE_THRESHOLD = 3_000;

/**
 * A seed plan is ALWAYS an explicit operator decision. Exported as a named
 * constant (and asserted by tests) so nobody can quietly make seeding
 * automatic: a plan must carry `createdBy` evidence of a human/admin request.
 */
export const SEED_PLAN_REQUIRES_OPERATOR = true;

/** Safety multiplier applied to the estimated peak staging footprint. */
export const SEED_SPACE_SAFETY_FACTOR = 1.25;

/** Fixed per-job overhead (manifest, checksums, temp files, journal). */
export const SEED_SPACE_FIXED_OVERHEAD_BYTES = 64 * 1024 * 1024;

/**
 * Default compression ratio used when no archive has been produced yet.
 * `1` is deliberately conservative: an incompressible tree produces an
 * archive as large as its input, so the reservation never under-estimates.
 * A measured ratio replaces it once an archive exists.
 */
export const SEED_ARCHIVE_RATIO_DEFAULT = 1;

/**
 * How long a seed stage may make no measurable progress before it is failed.
 * This is the OLD wall-clock timeout (600 s) reinterpreted as a *stall*
 * budget: a stage that keeps reporting progress may run far longer, while a
 * stage that stops moving is still killed promptly.
 */
export const SEED_STALL_TIMEOUT_FALLBACK_SEC = 600;

/**
 * Absolute ceiling for one seed stage regardless of progress. Bounds the
 * blast radius of a stage that reports progress forever (a pathological tar
 * or a network that trickles bytes). Six hours is far above the 43.5-minute
 * retry cycle the incident observed.
 */
export const SEED_STAGE_HARD_CAP_MS = 6 * 60 * 60_000;

/** A running seed job's lease is renewed by its owner; a stale one is reclaimable. */
export const SEED_JOB_LEASE_MS = 10 * 60_000;

/** Plans are a reviewed intent, not a standing grant. */
export const SEED_PLAN_TTL_MS = 30 * 60_000;

/** Bounded sample of archive members carried on the wire. */
export const SEED_ARCHIVE_MEMBER_SAMPLE_CAP = 20;

/** Bound for a stored staging/archive path on the wire. */
export const SEED_PATH_MAX_LENGTH = 4096;

/** Staging directory name created beside (never inside) the final target. */
export const SEED_STAGING_DIR_PREFIX = ".lamasync-seed-staging-";

/** Dedicated, temporary object namespace for seed archives. Deliberately
 *  NOT the managed-folder namespace: a seed archive is transport, not data,
 *  and must never be mistaken for a synced file. */
export const SEED_OBJECT_KEY_PREFIX = "lamasync/seed";

// ---------------------------------------------------------------------------
// Archive formats
// ---------------------------------------------------------------------------

/**
 * Supported archive formats, most preferred first. `tar.zstd` is preferred
 * when `zstd` is on PATH; `tar.gz` is the documented compatibility fallback
 * (GNU tar + gzip are present on every host the fleet targets today, and the
 * daemon's app-capture path already depends on GNU tar).
 */
export const SEED_ARCHIVE_FORMATS = ["tar.zstd", "tar.gz"] as const;
export type SeedArchiveFormat = (typeof SEED_ARCHIVE_FORMATS)[number];

export interface SeedArchiveTooling {
  tar: boolean;
  zstd: boolean;
  gzip: boolean;
}

export interface SeedArchiveFormatChoice {
  format: SeedArchiveFormat;
  /** Plain-language reason, shown in the plan and the help text. */
  reason: string;
  /** True when the preferred format was unavailable and the fallback is used. */
  fallback: boolean;
}

/**
 * Pick the archive format from the tooling that is actually installed.
 *
 * `tar.zstd` when zstd is available; otherwise `tar.gz` (documented
 * compatibility fallback). When neither gzip nor zstd is present the choice
 * is still `tar.gz` but the caller must treat the plan as not runnable —
 * `seedArchiveToolingReady` is the gate, not this function.
 */
export function selectSeedArchiveFormat(tooling: SeedArchiveTooling): SeedArchiveFormatChoice {
  if (tooling.zstd) {
    return {
      format: "tar.zstd",
      reason: "zstd is installed, so the seed archive uses tar + zstd (fastest, smallest).",
      fallback: false,
    };
  }
  return {
    format: "tar.gz",
    reason:
      "zstd is not installed on this device, so the seed archive falls back to tar + gzip. " +
      "Install zstd for faster, smaller seeds; the archive is verified either way.",
    fallback: true,
  };
}

/** Is there enough tooling to build and read the chosen archive at all? */
export function seedArchiveToolingReady(
  format: SeedArchiveFormat,
  tooling: SeedArchiveTooling,
): boolean {
  if (!tooling.tar) return false;
  return format === "tar.zstd" ? tooling.zstd : tooling.gzip;
}

export function seedArchiveExtension(format: SeedArchiveFormat): string {
  return format === "tar.zstd" ? ".tar.zst" : ".tar.gz";
}

/** Object key for one seed job's archive in the dedicated seed namespace. */
export function seedArchiveObjectKey(jobId: string, format: SeedArchiveFormat): string {
  return `${SEED_OBJECT_KEY_PREFIX}/${jobId}/payload${seedArchiveExtension(format)}`;
}

// ---------------------------------------------------------------------------
// Archive member safety (fail closed)
// ---------------------------------------------------------------------------

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

/**
 * Is one archive member name safe to extract?
 *
 * Deliberately strict and fail-closed: an archive is untrusted input, and a
 * member that could escape the staging directory (absolute path, `..`
 * traversal, Windows drive/UNC prefix, NUL byte, backslash separator, control
 * character, or an over-long name) must abort the whole seed rather than be
 * skipped silently. A skipped member would leave a tree that only *looks*
 * complete.
 */
export function isSafeArchiveMember(member: string): boolean {
  if (typeof member !== "string") return false;
  if (member.length === 0 || member.length > SEED_PATH_MAX_LENGTH) return false;
  if (member.includes("\0")) return false;
  if (member.startsWith("/") || member.startsWith("\\")) return false;
  if (WINDOWS_DRIVE_RE.test(member)) return false;
  if (member.includes("\\")) return false;
  // Control characters (including newline) never appear in a legitimate name
  // produced by our own tar invocation; they are a strong tamper signal.
  for (let i = 0; i < member.length; i += 1) {
    const code = member.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  const segments = member.split("/");
  for (const segment of segments) {
    if (segment === "..") return false;
  }
  // "./" and "dir/" style names are fine; an all-empty name is not.
  if (segments.every((s) => s.length === 0)) return false;
  return true;
}

export interface ArchiveMemberVerdict {
  ok: boolean;
  /** Bounded list of offending member names (never the whole archive). */
  offenders: string[];
  /** Total members considered. */
  count: number;
  message: string;
}

/**
 * Validate a complete member list before extracting anything. Fail closed:
 * one unsafe member rejects the archive.
 */
export function validateArchiveMembers(
  members: readonly string[],
  sampleCap: number = SEED_ARCHIVE_MEMBER_SAMPLE_CAP,
): ArchiveMemberVerdict {
  const offenders: string[] = [];
  for (const member of members) {
    if (isSafeArchiveMember(member)) continue;
    if (offenders.length < sampleCap) offenders.push(String(member).slice(0, 200));
  }
  if (offenders.length > 0) {
    return {
      ok: false,
      offenders,
      count: members.length,
      message:
        `The seed archive contains ${offenders.length} unsafe path(s); refusing to extract. ` +
        "Unsafe members are absolute paths, `..` traversal, or control characters.",
    };
  }
  return { ok: true, offenders: [], count: members.length, message: "All archive members are safe relative paths." };
}

// ---------------------------------------------------------------------------
// Space calculation
// ---------------------------------------------------------------------------

export interface SeedSpaceInput {
  /** Source tree size in bytes (exact from the source manifest). */
  sourceBytes: number;
  /** Source tree entry count (files + directories). */
  sourceFiles: number;
  /** Free bytes on the filesystem that holds the staging directory. */
  targetFreeBytes: number | null;
  /**
   * Measured archive/source ratio. Omit until an archive exists; the
   * conservative default (1.0) is then used.
   */
  archiveRatio?: number;
  safetyFactor?: number;
  fixedOverheadBytes?: number;
}

export interface SeedSpacePlan {
  sourceBytes: number;
  sourceFiles: number;
  /** Estimated size of the compressed archive on the target. */
  archiveBytesEstimate: number;
  /** Bytes the extracted tree will occupy (exact, from the manifest). */
  extractedBytes: number;
  /** Peak simultaneous footprint: archive + extracted tree. */
  peakBytes: number;
  /** Peak × safety factor + fixed overhead. */
  requiredFreeBytes: number;
  /** Free bytes measured on the target filesystem, or null when unknown. */
  targetFreeBytes: number | null;
  /** How much more space the target needs; 0 when it fits. */
  shortfallBytes: number;
  /** True only when the target free space is known AND sufficient. */
  ok: boolean;
  /** Plain-language sentence for the plan/UI. */
  message: string;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Compute the free space a target must reserve for a seed.
 *
 * The peak is `archive + extracted tree` because the archive is verified
 * before extraction and deleted after publication, so both exist at once.
 * The reservation is the peak times a safety factor plus fixed overhead.
 * When the target's free space is unknown the plan is NOT ok — failing closed
 * is the only honest answer, because a half-extracted tree is worse than a
 * refused seed.
 */
export function computeSeedSpacePlan(input: SeedSpaceInput): SeedSpacePlan {
  const sourceBytes = nonNegative(input.sourceBytes);
  const sourceFiles = nonNegative(input.sourceFiles);
  const ratio =
    input.archiveRatio === undefined || !Number.isFinite(input.archiveRatio) || input.archiveRatio <= 0
      ? SEED_ARCHIVE_RATIO_DEFAULT
      : input.archiveRatio;
  const safety =
    input.safetyFactor === undefined || !Number.isFinite(input.safetyFactor) || input.safetyFactor <= 0
      ? SEED_SPACE_SAFETY_FACTOR
      : input.safetyFactor;
  const overhead =
    input.fixedOverheadBytes === undefined ? SEED_SPACE_FIXED_OVERHEAD_BYTES : nonNegative(input.fixedOverheadBytes);

  const archiveBytesEstimate = Math.ceil(sourceBytes * ratio);
  const extractedBytes = sourceBytes;
  const peakBytes = archiveBytesEstimate + extractedBytes;
  const requiredFreeBytes = Math.ceil(peakBytes * safety) + overhead;
  const targetFreeBytes =
    input.targetFreeBytes === null || !Number.isFinite(input.targetFreeBytes)
      ? null
      : Math.max(0, Math.floor(input.targetFreeBytes));
  const ok = targetFreeBytes !== null && targetFreeBytes >= requiredFreeBytes;
  const shortfallBytes = targetFreeBytes === null ? 0 : Math.max(0, requiredFreeBytes - targetFreeBytes);

  const message =
    targetFreeBytes === null
      ? "Target free space is not known yet, so the seed cannot be approved. Measure the target device first."
      : ok
        ? `Target needs ${formatSeedBytes(requiredFreeBytes)} free (archive + extracted tree + safety margin); it has ${formatSeedBytes(targetFreeBytes)}.`
        : `Target is short ${formatSeedBytes(shortfallBytes)}: it needs ${formatSeedBytes(requiredFreeBytes)} free but has ${formatSeedBytes(targetFreeBytes)}.`;

  return {
    sourceBytes,
    sourceFiles,
    archiveBytesEstimate,
    extractedBytes,
    peakBytes,
    requiredFreeBytes,
    targetFreeBytes,
    shortfallBytes,
    ok,
    message,
  };
}

/** Byte formatting shared with the UI wording (kept local so core stays pure). */
export function formatSeedBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "unknown";
  if (n < 1024) return `${Math.floor(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  if (n < 1024 * 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  return `${(n / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TiB`;
}

// ---------------------------------------------------------------------------
// Staging policy
// ---------------------------------------------------------------------------

export interface StagingLocationInput {
  /** Absolute path of the staging directory. */
  stagingPath: string;
  /** Absolute path of the final target directory. */
  targetPath: string;
  /** `stat().dev` of the staging directory's parent, when known. */
  stagingDevice?: number | null;
  /** `stat().dev` of the final target's parent, when known. */
  targetDevice?: number | null;
}

export interface StagingLocationVerdict {
  ok: boolean;
  insideTarget: boolean;
  sameFilesystem: boolean | null;
  message: string;
}

/**
 * The staging directory must be a SIBLING of the final target on the same
 * filesystem — never inside it.
 *
 * Inside the target it would (a) be seen by bisync as managed content and
 * (b) make the final publish a copy instead of an atomic rename. A different
 * filesystem makes the publish a copy too, which reintroduces the very
 * timeout this feature exists to remove. Both are refused.
 */
export function validateStagingLocation(input: StagingLocationInput): StagingLocationVerdict {
  const staging = normalizeAbsolutePath(input.stagingPath);
  const target = normalizeAbsolutePath(input.targetPath);
  if (staging === null || target === null) {
    return {
      ok: false,
      insideTarget: false,
      sameFilesystem: null,
      message: "Staging and target must both be absolute paths.",
    };
  }
  const insideTarget = staging === target || staging.startsWith(`${target}/`);
  const sameFilesystem =
    typeof input.stagingDevice === "number" && typeof input.targetDevice === "number"
      ? input.stagingDevice === input.targetDevice
      : null;
  if (insideTarget) {
    return {
      ok: false,
      insideTarget,
      sameFilesystem,
      message:
        "The staging directory is inside the final target. Staging must be a sibling of the target, " +
        "so the finished tree can be published with one atomic rename and never appears as managed content.",
    };
  }
  if (sameFilesystem === false) {
    return {
      ok: false,
      insideTarget,
      sameFilesystem,
      message:
        "The staging directory is on a different filesystem from the final target, so publishing would " +
        "be a copy instead of an atomic rename. Put the staging directory beside the target.",
    };
  }
  return {
    ok: true,
    insideTarget,
    sameFilesystem,
    message: sameFilesystem === true
      ? "Staging is a sibling of the target on the same filesystem."
      : "Staging is a sibling of the target (same-filesystem check needs both paths to exist).",
  };
}

/** Normalize to a POSIX-style absolute path with no trailing slash, or null. */
export function normalizeAbsolutePath(path: string): string | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (trimmed.length === 0 || trimmed.length > SEED_PATH_MAX_LENGTH) return null;
  if (!trimmed.startsWith("/")) return null;
  const collapsed = trimmed.replace(/\/+/g, "/");
  if (collapsed === "/") return "/";
  return collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

/** The staging directory path beside a final target, for one job. */
export function seedStagingPath(targetPath: string, jobId: string): string | null {
  const target = normalizeAbsolutePath(targetPath);
  if (target === null) return null;
  const parent = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) || "/" : "/";
  const base = target.slice(target.lastIndexOf("/") + 1) || "target";
  const safeJob = jobId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || "job";
  return `${parent === "/" ? "" : parent}/${SEED_STAGING_DIR_PREFIX}${base}-${safeJob}`;
}

// ---------------------------------------------------------------------------
// Recommendation (never automatic)
// ---------------------------------------------------------------------------

export interface SeedRecommendation {
  /** True when a seed transfer is worth offering. */
  recommended: boolean;
  /** The threshold this verdict used. */
  thresholdFiles: number;
  /** Plain-language sentence for the health card. */
  reason: string;
}

/**
 * Should LamaSync *recommend* a seed transfer for this measurement?
 *
 * This is a recommendation surface only. It never creates a plan, never
 * enqueues an action, and never changes a sync: the operator must open the
 * seed panel and approve a plan explicitly.
 */
export function recommendSeed(input: {
  fileCount: number;
  totalBytes: number;
  thresholdFiles?: number;
}): SeedRecommendation {
  const thresholdFiles = input.thresholdFiles ?? SEED_RECOMMENDATION_FILE_THRESHOLD;
  const fileCount = Number.isFinite(input.fileCount) ? Math.max(0, Math.floor(input.fileCount)) : 0;
  const totalBytes = Number.isFinite(input.totalBytes) ? Math.max(0, Math.floor(input.totalBytes)) : 0;
  if (fileCount >= thresholdFiles) {
    return {
      recommended: true,
      thresholdFiles,
      reason:
        `This folder holds ${fileCount.toLocaleString("en-US")} entries (${formatSeedBytes(totalBytes)}). ` +
        `Above ${thresholdFiles.toLocaleString("en-US")} entries a first full sync is slow and fragile, so a one-time ` +
        "seed transfer is recommended. Nothing happens until you review and approve a plan.",
    };
  }
  return {
    recommended: false,
    thresholdFiles,
    reason:
      `This folder holds ${fileCount.toLocaleString("en-US")} entries (${formatSeedBytes(totalBytes)}), below the ` +
      `${thresholdFiles.toLocaleString("en-US")}-entry threshold where a seed transfer is recommended. Ordinary sync is the simpler choice.`,
  };
}

// ---------------------------------------------------------------------------
// Phases, state machine, progress
// ---------------------------------------------------------------------------

/**
 * One seed job's phases, in order. They narrate work on BOTH sides of the
 * transfer (source archive, target staging), because the operator cares about
 * the whole operation, not which host is currently busy.
 */
export const SEED_JOB_PHASES = [
  "preflight",
  "measuring_source",
  "archiving_source",
  "uploading_archive",
  "downloading_archive",
  "verifying_archive",
  "extracting_target",
  "verifying_target",
  "publishing",
  "baseline_validation",
] as const;
export type SeedJobPhase = (typeof SEED_JOB_PHASES)[number];

export const SEED_JOB_TERMINAL_PHASES = ["completed", "failed", "cancelled"] as const;
export type SeedJobTerminalPhase = (typeof SEED_JOB_TERMINAL_PHASES)[number];

export type SeedJobPhaseOrTerminal = SeedJobPhase | SeedJobTerminalPhase;

export type SeedJobStatus = "planned" | "running" | "failed" | "completed" | "cancelled";

export function isTerminalSeedPhase(phase: SeedJobPhaseOrTerminal): phase is SeedJobTerminalPhase {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}

export function seedPhaseIndex(phase: SeedJobPhase): number {
  const index = SEED_JOB_PHASES.indexOf(phase);
  return index < 0 ? 0 : index;
}

export const SEED_JOB_PHASE_COUNT = SEED_JOB_PHASES.length;

/**
 * Legal phase transition: strictly forward by one, or to any terminal phase.
 * No skipping (a job can never jump from `archiving_source` straight to
 * `publishing`) and no going back. Re-entering the SAME phase is allowed so a
 * resumable retry of a phase does not need a synthetic transition.
 */
export function canTransitionSeedPhase(
  from: SeedJobPhaseOrTerminal,
  to: SeedJobPhaseOrTerminal,
): boolean {
  if (isTerminalSeedPhase(from)) return false;
  if (isTerminalSeedPhase(to)) return true;
  if (from === to) return true;
  return seedPhaseIndex(to) === seedPhaseIndex(from) + 1;
}

export interface SeedJobProgress {
  phase: SeedJobPhase;
  phaseIndex: number;
  phaseCount: number;
  /** One bounded, human-readable sentence. */
  message: string;
  bytesDone: number;
  bytesTotal: number | null;
  entriesDone: number;
  entriesTotal: number | null;
  updatedAt: number;
}

/** Overall fraction 0..1 when a total is known, else null. Never a guess. */
export function seedProgressFraction(progress: SeedJobProgress): number | null {
  if (progress.bytesTotal !== null && progress.bytesTotal > 0) {
    return Math.min(1, Math.max(0, progress.bytesDone / progress.bytesTotal));
  }
  if (progress.entriesTotal !== null && progress.entriesTotal > 0) {
    return Math.min(1, Math.max(0, progress.entriesDone / progress.entriesTotal));
  }
  return null;
}

/** Fresh progress record for a phase. Pure; the caller supplies the clock. */
export function startSeedProgress(
  phase: SeedJobPhase,
  now: number,
  message: string,
  totals: { bytesTotal?: number | null; entriesTotal?: number | null } = {},
): SeedJobProgress {
  return {
    phase,
    phaseIndex: seedPhaseIndex(phase),
    phaseCount: SEED_JOB_PHASE_COUNT,
    message,
    bytesDone: 0,
    bytesTotal: totals.bytesTotal ?? null,
    entriesDone: 0,
    entriesTotal: totals.entriesTotal ?? null,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Progress-aware deadline (the timeout fix)
// ---------------------------------------------------------------------------

export type SeedDeadlineAction = "continue" | "fail";
export type SeedDeadlineReason = "progressing" | "stalled" | "hard_cap";

export interface SeedDeadlineVerdict {
  action: SeedDeadlineAction;
  reason: SeedDeadlineReason;
  /** Time since the last measurable progress, ms. */
  sinceProgressMs: number;
  /** Time since the stage started, ms. */
  elapsedMs: number;
  /** Stall budget that was applied, ms. */
  stallMs: number;
  /** Absolute ceiling that was applied, ms. */
  hardCapMs: number;
  message: string;
}

export interface SeedDeadlineInput {
  startedAt: number;
  /** Last time measurable progress was observed (equal to `startedAt` at start). */
  lastProgressAt: number;
  now: number;
  /** Stall budget. Defaults to `SEED_STALL_TIMEOUT_FALLBACK_SEC`. */
  stallMs?: number;
  /** Absolute ceiling. Defaults to `SEED_STAGE_HARD_CAP_MS`. */
  hardCapMs?: number;
}

/**
 * The heart of LAMA-346's timeout fix.
 *
 * A fixed wall-clock timeout kills a large but healthy transfer. A purely
 * progress-based one can hang forever on a stage that reports progress. The
 * verdict therefore fails on EITHER a stall (no measurable progress within
 * the stall budget) OR the absolute hard cap, and otherwise continues —
 * so long work is allowed while it keeps moving.
 */
export function shouldExtendSeedDeadline(input: SeedDeadlineInput): SeedDeadlineVerdict {
  const stallMs =
    input.stallMs !== undefined && Number.isFinite(input.stallMs) && input.stallMs > 0
      ? input.stallMs
      : SEED_STALL_TIMEOUT_FALLBACK_SEC * 1000;
  const hardCapMs =
    input.hardCapMs !== undefined && Number.isFinite(input.hardCapMs) && input.hardCapMs > 0
      ? input.hardCapMs
      : SEED_STAGE_HARD_CAP_MS;
  const elapsedMs = Math.max(0, input.now - input.startedAt);
  const sinceProgressMs = Math.max(0, input.now - input.lastProgressAt);

  if (elapsedMs >= hardCapMs) {
    return {
      action: "fail",
      reason: "hard_cap",
      sinceProgressMs,
      elapsedMs,
      stallMs,
      hardCapMs,
      message: `The stage reached its absolute ceiling of ${Math.round(hardCapMs / 60_000)} minutes and was stopped.`,
    };
  }
  if (sinceProgressMs >= stallMs) {
    return {
      action: "fail",
      reason: "stalled",
      sinceProgressMs,
      elapsedMs,
      stallMs,
      hardCapMs,
      message: `No measurable progress for ${Math.round(sinceProgressMs / 1000)} s (budget ${Math.round(stallMs / 1000)} s); the stage was stopped.`,
    };
  }
  return {
    action: "continue",
    reason: "progressing",
    sinceProgressMs,
    elapsedMs,
    stallMs,
    hardCapMs,
    message: `Progress continues (${Math.round(elapsedMs / 1000)} s elapsed, last progress ${Math.round(sinceProgressMs / 1000)} s ago).`,
  };
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface SeedSourceFacts {
  fileCount: number;
  totalBytes: number;
  measuredAt: number;
  /** Host that measured the source tree. */
  measuredOnHostId: string | null;
  /** Manifest digest — the identity the plan was built from. */
  manifestFingerprint: string | null;
}

export interface SeedTargetFacts {
  freeBytes: number | null;
  freeBytesMeasuredAt: number | null;
  measuredOnHostId: string | null;
  /** Directory the staging sibling will live in (the target's parent). */
  stagingRoot: string | null;
  stagingSameFilesystem: boolean | null;
}

export interface SeedPlanExecution {
  /** False until the archive transport is implemented AND validated. */
  available: boolean;
  /** Exact operator-facing reason when `available` is false. */
  reason: string;
}

export interface SeedPlan {
  id: string;
  hostId: string;
  folderId: string;
  assignmentId: string;
  recommendation: SeedRecommendation;
  source: SeedSourceFacts;
  target: SeedTargetFacts;
  space: SeedSpacePlan;
  archive: {
    format: SeedArchiveFormat;
    tooling: SeedArchiveTooling;
    toolingReady: boolean;
    estimateBytes: number;
    choiceReason: string;
    fallback: boolean;
  };
  /**
   * Recorded so a plan can never be approved with staging inside the target.
   * Both flags are plain booleans rather than literal types so a plan built by
   * an older/newer daemon can still be read and then REFUSED by
   * `checkSeedPlanValidity`, instead of failing to parse. The invariant is
   * enforced there: `adjacentToTarget === true && insideTarget === false`.
   */
  stagingPolicy: {
    adjacentToTarget: boolean;
    insideTarget: boolean;
    sameFilesystem: boolean | null;
    message: string;
  };
  configRevision: number;
  filterFingerprint: string | null;
  baselineFingerprint: string | null;
  createdAt: number;
  expiresAt: number;
  execution: SeedPlanExecution;
}

export interface SeedPlanValidity {
  valid: boolean;
  reason: "expired" | "config_changed" | "filter_changed" | "baseline_changed" | "not_runnable" | "missing" | null;
  message: string;
}

export interface SeedJobArchiveFacts {
  format: SeedArchiveFormat;
  bytes: number | null;
  sha256: string | null;
  objectKey: string | null;
  memberCount: number | null;
}

export interface SeedJobStagingFacts {
  path: string;
  targetPath: string;
  requiredFreeBytes: number;
  freeBytesAtPlan: number | null;
}

export interface SeedJob {
  id: string;
  planId: string;
  folderId: string;
  hostId: string;
  assignmentId: string;
  status: SeedJobStatus;
  phase: SeedJobPhaseOrTerminal;
  progress: SeedJobProgress;
  source: SeedSourceFacts;
  archive: SeedJobArchiveFacts;
  staging: SeedJobStagingFacts;
  /** Renewable lease held by the executing daemon. */
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  /** Bounded error detail (never credentials or rclone argv). */
  error: string | null;
  summary: string | null;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
}

/** Is a job's lease stale enough to be reclaimed by another owner? */
export function isSeedLeaseExpired(job: Pick<SeedJob, "leaseExpiresAt">, now: number): boolean {
  if (job.leaseExpiresAt === null) return true;
  return job.leaseExpiresAt <= now;
}

/**
 * The explicit execution capability. Flipped to `true` only when the archive
 * transport (temporary S3 seed space → target staging) is implemented and
 * validated end-to-end; until then the API refuses job creation and the UI
 * must show a disabled control with this reason — never a fake button.
 */
export const SEED_ARCHIVE_TRANSPORT_IMPLEMENTED = false;

export const SEED_EXECUTION_UNAVAILABLE_REASON =
  "Seed archive transport is not implemented yet. The plan, space calculation, staging rules and progress " +
  "model are ready and reviewed, but uploading the archive to temporary seed space and staging it on the " +
  "target has not been validated end-to-end. Ordinary sync is unaffected.";

export function seedPlanExecution(): SeedPlanExecution {
  return {
    available: SEED_ARCHIVE_TRANSPORT_IMPLEMENTED,
    reason: SEED_ARCHIVE_TRANSPORT_IMPLEMENTED
      ? "Seed execution is available."
      : SEED_EXECUTION_UNAVAILABLE_REASON,
  };
}

// ---------------------------------------------------------------------------
// Validity
// ---------------------------------------------------------------------------

/**
 * A seed plan dies on expiry, on a config-revision bump, on a filter change
 * and on a baseline change — exactly like a reviewed sync plan. It also dies
 * when the operation itself is not runnable (tooling missing, space short,
 * staging policy violated), because approving such a plan could only fail
 * partway through.
 */
export function checkSeedPlanValidity(
  plan: Pick<
    SeedPlan,
    | "expiresAt"
    | "configRevision"
    | "filterFingerprint"
    | "baselineFingerprint"
    | "space"
    | "archive"
    | "stagingPolicy"
  >,
  live: {
    now: number;
    configRevision: number;
    filterFingerprint: string | null;
    baselineFingerprint: string | null;
  },
): SeedPlanValidity {
  if (live.now >= plan.expiresAt) {
    return { valid: false, reason: "expired", message: "This seed plan has expired — prepare a new one." };
  }
  if (live.configRevision !== plan.configRevision) {
    return {
      valid: false,
      reason: "config_changed",
      message: "The assignment changed since this seed plan was built — prepare a new one.",
    };
  }
  if (live.filterFingerprint !== plan.filterFingerprint) {
    return {
      valid: false,
      reason: "filter_changed",
      message: "The ignore/filter set changed since this seed plan was built — prepare a new one.",
    };
  }
  if (live.baselineFingerprint !== plan.baselineFingerprint) {
    return {
      valid: false,
      reason: "baseline_changed",
      message: "The saved sync record changed since this seed plan was built — prepare a new one.",
    };
  }
  if (!plan.archive.toolingReady) {
    return {
      valid: false,
      reason: "not_runnable",
      message: "The target device is missing tar or the archive compressor, so this seed cannot run.",
    };
  }
  if (!plan.space.ok) {
    return { valid: false, reason: "not_runnable", message: plan.space.message };
  }
  if (!plan.stagingPolicy.adjacentToTarget || plan.stagingPolicy.insideTarget) {
    return { valid: false, reason: "not_runnable", message: plan.stagingPolicy.message };
  }
  return { valid: true, reason: null, message: "Seed plan is current and runnable." };
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface SeedPlanRequestPayload {
  folderId: string;
  hostId: string;
  /** The operator explicitly asked for a seed plan (never automatic). */
  confirm: true;
}

export type SeedPlanRequestParseResult =
  | { ok: true; payload: SeedPlanRequestPayload }
  | { ok: false; error: string };

/**
 * Validate a seed-plan request. `confirm: true` is required so a stray
 * request can never create a plan: the whole feature is operator-approved.
 */
export function parseSeedPlanRequestPayload(value: unknown): SeedPlanRequestParseResult {
  if (!isRecord(value)) return { ok: false, error: "payload must be an object" };
  const allowed = new Set(["folderId", "hostId", "confirm"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return { ok: false, error: `unsupported field: ${key}` };
  }
  const folderId = value["folderId"];
  if (typeof folderId !== "string" || folderId.length === 0) {
    return { ok: false, error: "folderId is required" };
  }
  const hostId = value["hostId"];
  if (typeof hostId !== "string" || hostId.length === 0) {
    return { ok: false, error: "hostId is required" };
  }
  if (value["confirm"] !== true) {
    return { ok: false, error: "confirm: true is required — seed plans are always operator-approved" };
  }
  return { ok: true, payload: { folderId, hostId, confirm: true } };
}

export interface SeedJobCreatePayload {
  planId: string;
  confirm: true;
}

export type SeedJobCreateParseResult =
  | { ok: true; payload: SeedJobCreatePayload }
  | { ok: false; error: string };

export function parseSeedJobCreatePayload(value: unknown): SeedJobCreateParseResult {
  if (!isRecord(value)) return { ok: false, error: "payload must be an object" };
  const allowed = new Set(["planId", "confirm"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return { ok: false, error: `unsupported field: ${key}` };
  }
  const planId = value["planId"];
  if (typeof planId !== "string" || planId.length === 0) {
    return { ok: false, error: "planId is required" };
  }
  if (value["confirm"] !== true) {
    return { ok: false, error: "confirm: true is required" };
  }
  return { ok: true, payload: { planId, confirm: true } };
}

export interface SeedProgressPayload {
  phase: SeedJobPhase;
  message: string;
  bytesDone: number;
  bytesTotal: number | null;
  entriesDone: number;
  entriesTotal: number | null;
  leaseOwner?: string;
  leaseMs?: number;
}

export type SeedProgressParseResult =
  | { ok: true; payload: SeedProgressPayload }
  | { ok: false; error: string };

function boundedCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  if (floored < 0) return null;
  return Math.min(floored, Number.MAX_SAFE_INTEGER);
}

/**
 * Validate a daemon progress report. Every field is bounded and the phase
 * must be a known phase (a terminal phase is reported through the completion
 * route, not here). Unknown fields are rejected so the wire stays closed.
 */
export function parseSeedProgressPayload(value: unknown): SeedProgressParseResult {
  if (!isRecord(value)) return { ok: false, error: "payload must be an object" };
  const allowed = new Set([
    "phase",
    "message",
    "bytesDone",
    "bytesTotal",
    "entriesDone",
    "entriesTotal",
    "leaseOwner",
    "leaseMs",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return { ok: false, error: `unsupported field: ${key}` };
  }
  const phase = value["phase"];
  if (typeof phase !== "string" || !(SEED_JOB_PHASES as readonly string[]).includes(phase)) {
    return { ok: false, error: `phase must be one of ${SEED_JOB_PHASES.join(", ")}` };
  }
  const message = typeof value["message"] === "string" ? value["message"].slice(0, 300) : "";
  const bytesDone = boundedCount(value["bytesDone"]) ?? 0;
  const bytesTotal = value["bytesTotal"] === null || value["bytesTotal"] === undefined
    ? null
    : boundedCount(value["bytesTotal"]);
  const entriesDone = boundedCount(value["entriesDone"]) ?? 0;
  const entriesTotal = value["entriesTotal"] === null || value["entriesTotal"] === undefined
    ? null
    : boundedCount(value["entriesTotal"]);
  const leaseOwner = typeof value["leaseOwner"] === "string" ? value["leaseOwner"].slice(0, 128) : undefined;
  const leaseMs = boundedCount(value["leaseMs"]) ?? undefined;
  return {
    ok: true,
    payload: {
      phase: phase as SeedJobPhase,
      message,
      bytesDone,
      bytesTotal,
      entriesDone,
      entriesTotal,
      ...(leaseOwner !== undefined ? { leaseOwner } : {}),
      ...(leaseMs !== undefined ? { leaseMs } : {}),
    },
  };
}
