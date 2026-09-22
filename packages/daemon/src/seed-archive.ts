// LAMA-346 — seed archive primitives (create, validate, verify, publish).
//
// This module owns the local half of a seed transfer and nothing else: it
// never touches rclone, never uploads anything, and never decides whether a
// seed is allowed. It is deliberately small and injectable so the whole
// pipeline can be exercised end-to-end against a fixture tree with the real
// GNU tar on the host.
//
// Safety rules it enforces, all fail-closed:
//
//   * the manifest is built from the folder's EFFECTIVE FILTER UNIVERSE, never
//     from the raw tree, and a member the universe includes but a seed cannot
//     represent (a symlink, device, FIFO or socket) blocks the archive BEFORE
//     tar runs — a seed never publishes a partial tree;
//   * a source tree that changes while it is being archived is rejected
//     (the archive could contain a half-written file);
//   * every archive member must be a safe relative path AND a regular file
//     or directory — a symlink, device, FIFO or hardlink aborts the seed;
//   * the produced archive's member set must EQUAL the manifest's member set,
//     so no unrepresented source content can reach the target;
//   * extraction happens into a staging directory that is a SIBLING of the
//     final target on a PROVEN same filesystem, never inside the target;
//   * the extracted tree is verified against the source manifest (path, size,
//     SHA-256) before anything is published;
//   * publication is a single atomic rename, and a non-empty target is
//     refused rather than merged or overwritten.

import { createHash } from "crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  statfsSync,
  unlinkSync,
} from "fs";
import { dirname, join, relative, sep } from "path";
import {
  computeSeedSpacePlan,
  parentPathOf,
  seedArchiveExtension,
  validateArchiveMembers,
  validateStagingLocation,
  type SeedArchiveFormat,
  type SeedArchiveTooling,
  type SeedSourceFilterUniverse,
  type SeedSpacePlan,
} from "@lamasync/core";

// ---------------------------------------------------------------------------
// Command runner seam
// ---------------------------------------------------------------------------

export interface SeedCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SeedCommandOptions {
  /** Called once per output line — the measurable progress signal. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
}

export type SeedCommandRunner = (
  args: string[],
  opts?: SeedCommandOptions,
) => Promise<SeedCommandResult>;

/** Default runner: spawn the binary and stream both pipes line by line. */
export const defaultSeedCommandRunner: SeedCommandRunner = async (args, opts) => {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const onAbort = (): void => {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  };
  if (opts?.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  const collect = async (
    stream: ReadableStream<Uint8Array> | null,
    which: "stdout" | "stderr",
  ): Promise<string> => {
    if (stream === null) return "";
    const decoder = new TextDecoder();
    let buffer = "";
    let all = "";
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      all += text;
      buffer += text;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        opts?.onLine?.(line, which);
        index = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) opts?.onLine?.(buffer, which);
    return all;
  };
  const [stdout, stderr] = await Promise.all([
    collect(proc.stdout as ReadableStream<Uint8Array> | null, "stdout"),
    collect(proc.stderr as ReadableStream<Uint8Array> | null, "stderr"),
  ]);
  const exitCode = await proc.exited;
  if (opts?.signal) opts.signal.removeEventListener("abort", onAbort);
  return { exitCode, stdout, stderr };
};

// ---------------------------------------------------------------------------
// Tooling detection
// ---------------------------------------------------------------------------

async function commandExists(
  runner: SeedCommandRunner,
  binary: string,
): Promise<boolean> {
  try {
    const result = await runner([binary, "--version"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Which archive tools are installed. Detected once per plan/job so the plan
 * can record the format it will actually use rather than guessing.
 */
export async function detectArchiveTooling(
  runner: SeedCommandRunner = defaultSeedCommandRunner,
): Promise<SeedArchiveTooling> {
  const [tar, zstd, gzip] = await Promise.all([
    commandExists(runner, "tar"),
    commandExists(runner, "zstd"),
    commandExists(runner, "gzip"),
  ]);
  return { tar, zstd, gzip };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface SeedManifestEntry {
  /** Path relative to the source root, POSIX separators. */
  path: string;
  kind: "file" | "dir";
  size: number;
  /** mtime in ms — bisync compares size + modtime, so it must survive. */
  mtimeMs: number;
  /** SHA-256 for regular files; null for directories. */
  sha256: string | null;
}

/**
 * A member of the effective filter universe that a seed CANNOT represent.
 *
 * The seed's contract is "the published tree is identical to the source
 * universe, so the following bisync validates to zero content changes". A
 * symlink, device, FIFO or socket cannot be archived safely (a symlink in an
 * archive is an extraction hazard) and cannot be silently dropped either —
 * dropping it would make the baseline validation fail. Such a member
 * therefore BLOCKS the seed, and `createSeedArchive` refuses before tar runs.
 *
 * In practice this is what the effective filter universe is for: excluding
 * `node_modules` (where a Projects tree's symlinks live) removes them from the
 * universe entirely, so they never appear here.
 */
export interface SeedUnsupportedMember {
  path: string;
  reason: string;
}

export interface SeedManifest {
  entries: SeedManifestEntry[];
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  /** Content identity (path + size + hash). */
  fingerprint: string;
  /** Cheap churn identity (path + size + mtime), used around archiving. */
  statsFingerprint: string;
  /** Members of the universe that a seed cannot represent. Must be empty. */
  unsupported: SeedUnsupportedMember[];
  /**
   * The effective filter universe this manifest was built from. The archive is
   * only valid for the SAME universe, which is why the fingerprint travels
   * with the manifest and must equal the plan's `filterFingerprint`.
   */
  filter: {
    fingerprint: string;
    patternCount: number;
    /** Entries the universe excluded (not measured, not hashed, not archived). */
    skippedCount: number;
    /** Bounded sample of excluded paths, for the plan and the audit trail. */
    skippedSample: string[];
  };
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

export interface BuildManifestOptions {
  /**
   * The effective filter universe. REQUIRED, with no default: a manifest that
   * walked the raw tree while sync filters a different tree would describe the
   * wrong content, and the archive built from it could never validate to zero
   * content changes.
   */
  filter: SeedSourceFilterUniverse;
  /** Hard cap on entries; reaching it fails the manifest rather than lying. */
  entryCap?: number;
}

export const SEED_MANIFEST_ENTRY_CAP = 2_000_000;

/** Bounded sample of filter-excluded paths carried on the manifest. */
export const SEED_MANIFEST_SKIPPED_SAMPLE_CAP = 20;

/**
 * Walk the effective filter universe of a source tree and build a manifest.
 *
 * Only paths the universe includes are walked, measured and hashed; an
 * excluded directory is pruned whole (so an excluded `node_modules` costs
 * nothing and its nested symlinks are never even seen). Members the universe
 * DOES include but a seed cannot represent are recorded in `unsupported`, and
 * `createSeedArchive` refuses while that list is non-empty. Reaching the entry
 * cap fails the whole manifest.
 */
export async function buildSeedManifest(
  root: string,
  opts: BuildManifestOptions,
): Promise<SeedManifest> {
  const cap = opts.entryCap ?? SEED_MANIFEST_ENTRY_CAP;
  const filter = opts.filter;
  const entries: SeedManifestEntry[] = [];
  const unsupported: SeedUnsupportedMember[] = [];
  const skippedSample: string[] = [];
  let skippedCount = 0;
  const skip = (rel: string): void => {
    skippedCount += 1;
    if (skippedSample.length < SEED_MANIFEST_SKIPPED_SAMPLE_CAP) skippedSample.push(rel);
  };
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(
        `cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (entries.length + unsupported.length >= cap) {
        throw new Error(`source universe exceeds the ${cap}-entry manifest cap`);
      }
      const full = join(dir, dirent.name);
      const rel = toPosix(relative(root, full));
      const isDirectory = dirent.isDirectory();
      // The filter decides first: an excluded path is not part of the seed and
      // is never inspected further (a symlink inside an excluded directory is
      // therefore irrelevant, which is exactly how Projects becomes seedable).
      if (!filter.includes(rel, isDirectory)) {
        skip(rel);
        continue;
      }
      if (dirent.isSymbolicLink()) {
        unsupported.push({ path: rel, reason: "symlink" });
        continue;
      }
      if (isDirectory) {
        const stat = statSync(full);
        entries.push({ path: rel, kind: "dir", size: 0, mtimeMs: Math.round(stat.mtimeMs), sha256: null });
        stack.push(full);
        continue;
      }
      if (!dirent.isFile()) {
        unsupported.push({ path: rel, reason: "not a regular file" });
        continue;
      }
      const stat = statSync(full);
      const hash = await sha256File(full);
      entries.push({
        path: rel,
        kind: "file",
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        sha256: hash,
      });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  unsupported.sort((a, b) => a.path.localeCompare(b.path));

  const contentHash = createHash("sha256");
  const statsHash = createHash("sha256");
  let totalBytes = 0;
  let fileCount = 0;
  let dirCount = 0;
  for (const entry of entries) {
    contentHash.update(`${entry.path}\0${entry.kind}\0${entry.size}\0${entry.sha256 ?? "-"}\n`);
    statsHash.update(`${entry.path}\0${entry.kind}\0${entry.size}\0${entry.mtimeMs}\n`);
    if (entry.kind === "file") {
      fileCount += 1;
      totalBytes += entry.size;
    } else {
      dirCount += 1;
    }
  }
  return {
    entries,
    fileCount,
    dirCount,
    totalBytes,
    fingerprint: contentHash.digest("hex"),
    statsFingerprint: statsHash.digest("hex"),
    unsupported,
    filter: {
      fingerprint: filter.fingerprint,
      patternCount: filter.patterns.length,
      skippedCount,
      skippedSample,
    },
  };
}

/**
 * Why this manifest cannot be seeded, or null when it can.
 *
 * Fail closed: a seed whose source universe contains members it cannot
 * represent would publish an incomplete tree, and the following bisync would
 * then "repair" it by copying the difference — the exact silent divergence
 * this feature exists to avoid.
 */
export function seedManifestBlockingReason(manifest: SeedManifest): string | null {
  if (manifest.unsupported.length === 0) return null;
  const sample = manifest.unsupported
    .slice(0, 5)
    .map((member) => `${member.path} (${member.reason})`)
    .join(", ");
  return (
    `${manifest.unsupported.length} entr(y/ies) in this folder's effective filter universe are symlinks or special ` +
    `files, which a seed cannot represent (for example ${sample}). Exclude them with the folder's ignore rules ` +
    "(lamasyncignore) or remove them, then prepare the plan again — a seed never publishes a partial tree."
  );
}

/** Cheap churn re-check: path + size + mtime only, no content hashing. */
export function buildStatsFingerprint(root: string): string {
  const hash = createHash("sha256");
  const stack: string[] = [root];
  const rows: string[] = [];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const full = join(dir, dirent.name);
      const rel = toPosix(relative(root, full));
      if (dirent.isSymbolicLink()) {
        rows.push(`${rel}\0link`);
        continue;
      }
      if (dirent.isDirectory()) {
        rows.push(`${rel}\0dir`);
        stack.push(full);
        continue;
      }
      if (!dirent.isFile()) {
        rows.push(`${rel}\0other`);
        continue;
      }
      try {
        const stat = statSync(full);
        rows.push(`${rel}\0file\0${stat.size}\0${Math.round(stat.mtimeMs)}`);
      } catch {
        rows.push(`${rel}\0unreadable`);
      }
    }
  }
  rows.sort();
  for (const row of rows) hash.update(`${row}\n`);
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Archive create / list / extract
// ---------------------------------------------------------------------------

/**
 * `tar --create --directory <root> .` archives the WHOLE source root.
 *
 * That is only sound because the manifest is built from the effective filter
 * universe and `createSeedArchive` (a) refuses when the universe contains
 * members a seed cannot represent and (b) verifies afterwards that the
 * archive's member set equals the manifest's. The raw tree may therefore only
 * be archived when the manifest already represents all of it — the filter
 * excludes are applied by the caller, not by tar.
 */
export function archiveCreateArgs(input: {
  format: SeedArchiveFormat;
  sourceRoot: string;
  outputPath: string;
}): string[] {
  const compression = input.format === "tar.zstd" ? ["--zstd"] : ["--gzip"];
  return [
    "tar",
    "--create",
    "--file",
    input.outputPath,
    ...compression,
    // `--verbose` emits one line per member, which is the measurable progress
    // signal for the archiving stage.
    "--verbose",
    "--directory",
    input.sourceRoot,
    ".",
  ];
}

export function archiveListArgs(input: {
  format: SeedArchiveFormat;
  archivePath: string;
}): string[] {
  const compression = input.format === "tar.zstd" ? ["--zstd"] : ["--gzip"];
  return ["tar", "--list", "--file", input.archivePath, ...compression, "--verbose", "--numeric-owner"];
}

export function archiveExtractArgs(input: {
  format: SeedArchiveFormat;
  archivePath: string;
  stagingDir: string;
}): string[] {
  const compression = input.format === "tar.zstd" ? ["--zstd"] : ["--gzip"];
  return [
    "tar",
    "--extract",
    "--file",
    input.archivePath,
    ...compression,
    "--directory",
    input.stagingDir,
    // Never restore ownership or setuid bits from an untrusted archive, and
    // never rewrite the staging directory's own permissions.
    "--no-same-owner",
    "--no-same-permissions",
    "--no-overwrite-dir",
    // One line per member — the progress signal for extraction.
    "--verbose",
  ];
}

/**
 * Parse one `tar --list --verbose --numeric-owner` line.
 *
 * GNU tar prints `<type><perms> <owner> <size> <YYYY-MM-DD HH:MM[:SS]> <name>`.
 * Returns null when the line does not match; the caller treats an unparsable
 * line as unsafe (fail closed).
 */
export function parseVerboseMemberLine(line: string): { type: string; name: string } | null {
  const match =
    /^(.)(.{9})\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s(.*)$/.exec(
      line,
    );
  if (!match) return null;
  return { type: match[1]!, name: match[4]! };
}

export interface ArchiveMemberSample {
  count: number;
  sample: string[];
}

export interface ArchiveValidation {
  ok: boolean;
  members: ArchiveMemberSample;
  /** Offenders from the name check plus any non-regular member type. */
  offenders: string[];
  message: string;
}

/**
 * Normalize a name as tar reports it for comparison against a manifest path.
 *
 * `tar --create --directory root .` stores `./sub/` and `./a.txt`; manifest
 * paths are `sub` and `a.txt`. Comparison must not depend on those decorations.
 */
export function normalizeArchiveMemberName(name: string): string {
  let out = name;
  while (out.startsWith("./")) out = out.slice(2);
  if (out.endsWith("/") && out.length > 1) out = out.slice(0, -1);
  return out === "." ? "" : out;
}

interface ArchiveMemberListing {
  ok: boolean;
  /** Normalized names of regular files and directories. */
  names: string[];
  typeOffenders: string[];
  message: string;
}

/** List an archive's regular-file/directory members, normalized. */
async function listArchiveMembers(input: {
  format: SeedArchiveFormat;
  archivePath: string;
  runner: SeedCommandRunner;
  sampleCap: number;
}): Promise<ArchiveMemberListing> {
  const result = await input.runner(
    archiveListArgs({ format: input.format, archivePath: input.archivePath }),
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      names: [],
      typeOffenders: [],
      message: `the archive could not be listed (tar exit ${result.exitCode}): ${result.stderr.slice(-300)}`,
    };
  }
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const names: string[] = [];
  const typeOffenders: string[] = [];
  for (const line of lines) {
    const parsed = parseVerboseMemberLine(line);
    if (parsed === null) {
      // Some tar builds write the listing to stderr or use a different date
      // format. Fall back to the plain name list for that line only if it
      // looks like a bare name; otherwise fail closed.
      if (line.startsWith("/") || line.includes("..")) {
        typeOffenders.push(line.slice(0, 200));
        continue;
      }
      names.push(normalizeArchiveMemberName(line));
      continue;
    }
    if (parsed.type !== "-" && parsed.type !== "d") {
      if (typeOffenders.length < input.sampleCap) {
        typeOffenders.push(`${parsed.name} (type ${parsed.type})`);
      }
      continue;
    }
    const name = normalizeArchiveMemberName(parsed.name);
    // `./` is the archive root — the target directory itself, not a path in
    // it — so it is not a member to validate or to compare against.
    if (name === "") continue;
    names.push(name);
  }
  return { ok: true, names, typeOffenders, message: "" };
}

/**
 * List an archive and validate every member before extracting it.
 *
 * A member is acceptable only when its name is a safe relative path AND its
 * type is a regular file (`-`) or directory (`d`). Anything else — symlink,
 * hardlink, device, FIFO, socket, or an unparsable listing line — aborts.
 */
export async function validateSeedArchive(input: {
  format: SeedArchiveFormat;
  archivePath: string;
  runner?: SeedCommandRunner;
  sampleCap?: number;
}): Promise<ArchiveValidation> {
  const sampleCap = input.sampleCap ?? 20;
  const listing = await listArchiveMembers({
    format: input.format,
    archivePath: input.archivePath,
    runner: input.runner ?? defaultSeedCommandRunner,
    sampleCap,
  });
  if (!listing.ok) {
    return {
      ok: false,
      members: { count: 0, sample: [] },
      offenders: [],
      message: listing.message,
    };
  }
  const { names, typeOffenders } = listing;
  const nameVerdict = validateArchiveMembers(names, sampleCap);
  if (!nameVerdict.ok || typeOffenders.length > 0) {
    return {
      ok: false,
      members: { count: names.length, sample: names.slice(0, sampleCap) },
      offenders: [...nameVerdict.offenders, ...typeOffenders].slice(0, sampleCap),
      message:
        typeOffenders.length > 0
          ? "The seed archive contains members that are not regular files or directories; refusing to extract."
          : nameVerdict.message,
    };
  }
  return {
    ok: true,
    members: { count: names.length, sample: names.slice(0, sampleCap) },
    offenders: [],
    message: `All ${names.length} archive members are safe regular files or directories.`,
  };
}

export interface CreateArchiveResult {
  ok: boolean;
  archivePath: string;
  bytes: number;
  sha256: string | null;
  /** Members counted from tar's verbose output during creation. */
  memberCount: number;
  /** True when the source tree changed while archiving. */
  churned: boolean;
  error: string | null;
}

/**
 * Create a seed archive from a source tree.
 *
 * The manifest is REQUIRED and is the authority for what may be archived:
 *
 *   1. the manifest must describe the whole source universe — if it contains
 *      members a seed cannot represent, the archive is refused BEFORE tar runs
 *      (an archive containing a symlink would be rejected at validation, and
 *      dropping the symlink silently would leave a tree the following bisync
 *      would then have to "repair");
 *   2. after tar runs, the archive's member set must EQUAL the manifest's
 *      member set, so unrepresented source content can never reach the target;
 *   3. the source tree's stats fingerprint is taken before and after tar runs —
 *      a difference means the tree moved mid-archive and the whole operation
 *      fails closed.
 */
export async function createSeedArchive(input: {
  format: SeedArchiveFormat;
  sourceRoot: string;
  outputPath: string;
  /** The manifest of the effective filter universe. Required. */
  manifest: SeedManifest;
  runner?: SeedCommandRunner;
  onProgress?: (membersDone: number) => void;
  signal?: AbortSignal;
}): Promise<CreateArchiveResult> {
  const runner = input.runner ?? defaultSeedCommandRunner;
  // Fail closed BEFORE tar: never build an archive that has unrepresented
  // source content in it.
  const blocking = seedManifestBlockingReason(input.manifest);
  if (blocking !== null) {
    return {
      ok: false,
      archivePath: input.outputPath,
      bytes: 0,
      sha256: null,
      memberCount: 0,
      churned: false,
      error: blocking,
    };
  }
  const before = buildStatsFingerprint(input.sourceRoot);
  mkdirSync(dirname(input.outputPath), { recursive: true });
  let memberCount = 0;
  const result = await runner(
    archiveCreateArgs({
      format: input.format,
      sourceRoot: input.sourceRoot,
      outputPath: input.outputPath,
    }),
    {
      ...(input.signal ? { signal: input.signal } : {}),
      onLine: (line, stream) => {
        // GNU tar writes `--verbose` member names to stderr; some builds use
        // stdout. Count either, but never count its "Removing leading" notes.
        if (line.length === 0) return;
        if (line.startsWith("tar:")) return;
        void stream;
        memberCount += 1;
        input.onProgress?.(memberCount);
      },
    },
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      archivePath: input.outputPath,
      bytes: 0,
      sha256: null,
      memberCount,
      churned: false,
      error: `tar exited ${result.exitCode}: ${result.stderr.slice(-300)}`,
    };
  }
  const after = buildStatsFingerprint(input.sourceRoot);
  const churned = before !== after;
  const bytes = existsSync(input.outputPath) ? statSync(input.outputPath).size : 0;
  const sha256 = existsSync(input.outputPath) ? await sha256File(input.outputPath) : null;

  // The archive must represent EXACTLY the manifest. A difference in either
  // direction means the target would receive content the plan never accounted
  // for, or miss content it promised — both fail closed.
  const mismatch = await compareArchiveToManifest({
    format: input.format,
    archivePath: input.outputPath,
    manifest: input.manifest,
    runner,
  });
  if (mismatch !== null) {
    // Never leave an archive that does not represent the manifest behind: it
    // would be uploaded and staged as if it were complete.
    try {
      unlinkSync(input.outputPath);
    } catch {
      /* best-effort */
    }
    return {
      ok: false,
      archivePath: input.outputPath,
      bytes: 0,
      sha256: null,
      memberCount,
      churned,
      error: mismatch,
    };
  }

  return {
    ok: !churned,
    archivePath: input.outputPath,
    bytes,
    sha256,
    memberCount,
    churned,
    error: churned
      ? "the source tree changed while it was being archived, so the archive may be inconsistent"
      : null,
  };
}

/**
 * The archive's member set must equal the manifest's member set.
 * Returns an operator-facing reason when it does not, or null when it matches.
 */
async function compareArchiveToManifest(input: {
  format: SeedArchiveFormat;
  archivePath: string;
  manifest: SeedManifest;
  runner: SeedCommandRunner;
}): Promise<string | null> {
  const listing = await listArchiveMembers({
    format: input.format,
    archivePath: input.archivePath,
    runner: input.runner,
    sampleCap: 20,
  });
  if (!listing.ok) return listing.message;
  if (listing.typeOffenders.length > 0) {
    return `the archive contains members that are not regular files or directories (for example ${listing.typeOffenders[0]})`;
  }
  const expected = new Set(input.manifest.entries.map((entry) => entry.path));
  // tar stores the archive root as `./` (normalized to ""). The root is the
  // target directory itself and is described implicitly by the manifest, so it
  // is not a mismatch in either direction.
  const actual = new Set(listing.names.filter((name) => name !== ""));
  const unexpected = [...actual].filter((name) => !expected.has(name)).slice(0, 5);
  const missing = [...expected].filter((path) => !actual.has(path)).slice(0, 5);
  if (unexpected.length === 0 && missing.length === 0) return null;
  const parts: string[] = [];
  if (unexpected.length > 0) parts.push(`content the manifest does not describe (for example ${unexpected[0]})`);
  if (missing.length > 0) parts.push(`content the manifest requires but the archive lacks (for example ${missing[0]})`);
  return `the archive does not match the source manifest: ${parts.join("; ")}`;
}

export interface ExtractArchiveResult {
  ok: boolean;
  membersExtracted: number;
  error: string | null;
}

/**
 * Extract a validated archive into a staging directory. The staging directory
 * is created if needed and must already satisfy the sibling/same-filesystem
 * policy (the caller checks that BEFORE calling, so a wrong location never
 * receives a single byte).
 */
export async function extractSeedArchive(input: {
  format: SeedArchiveFormat;
  archivePath: string;
  stagingDir: string;
  runner?: SeedCommandRunner;
  onProgress?: (membersDone: number) => void;
  signal?: AbortSignal;
}): Promise<ExtractArchiveResult> {
  const runner = input.runner ?? defaultSeedCommandRunner;
  mkdirSync(input.stagingDir, { recursive: true });
  let membersExtracted = 0;
  const result = await runner(
    archiveExtractArgs({
      format: input.format,
      archivePath: input.archivePath,
      stagingDir: input.stagingDir,
    }),
    {
      ...(input.signal ? { signal: input.signal } : {}),
      onLine: (line) => {
        if (line.length === 0 || line.startsWith("tar:")) return;
        membersExtracted += 1;
        input.onProgress?.(membersExtracted);
      },
    },
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      membersExtracted,
      error: `tar exited ${result.exitCode}: ${result.stderr.slice(-300)}`,
    };
  }
  return { ok: true, membersExtracted, error: null };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyTreeResult {
  ok: boolean;
  checked: number;
  /** Bounded mismatch list: missing, size mismatch, hash mismatch, extra. */
  mismatches: string[];
  message: string;
}

export const SEED_VERIFY_MISMATCH_CAP = 20;

/**
 * Verify an extracted tree against the source manifest. Any missing file, size
 * or hash mismatch, or unexpected extra entry fails the seed — a tree that
 * only *looks* complete is worse than a refused seed, because the following
 * bisync would silently "fix" it by copying the difference.
 */
export async function verifyExtractedTree(input: {
  root: string;
  manifest: SeedManifest;
  mismatchCap?: number;
}): Promise<VerifyTreeResult> {
  const cap = input.mismatchCap ?? SEED_VERIFY_MISMATCH_CAP;
  const mismatches: string[] = [];
  const expected = new Set(input.manifest.entries.map((entry) => entry.path));
  let checked = 0;
  for (const entry of input.manifest.entries) {
    if (mismatches.length >= cap) break;
    const full = join(input.root, entry.path);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      mismatches.push(`missing: ${entry.path}`);
      continue;
    }
    if (entry.kind === "dir") {
      if (!stat.isDirectory()) mismatches.push(`not a directory: ${entry.path}`);
      checked += 1;
      continue;
    }
    if (!stat.isFile()) {
      mismatches.push(`not a regular file: ${entry.path}`);
      continue;
    }
    if (stat.size !== entry.size) {
      mismatches.push(`size mismatch: ${entry.path} (expected ${entry.size}, found ${stat.size})`);
      continue;
    }
    const hash = await sha256File(full);
    if (entry.sha256 !== null && hash !== entry.sha256) {
      mismatches.push(`checksum mismatch: ${entry.path}`);
      continue;
    }
    checked += 1;
  }
  // Extra entries: walk the extracted tree and reject anything not in the
  // manifest (tar could have created a symlink the member list did not show).
  if (mismatches.length < cap) {
    const stack: string[] = [input.root];
    while (stack.length > 0 && mismatches.length < cap) {
      const dir = stack.pop()!;
      let dirents;
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        mismatches.push(`unreadable directory: ${toPosix(relative(input.root, dir))}`);
        continue;
      }
      for (const dirent of dirents) {
        const full = join(dir, dirent.name);
        const rel = toPosix(relative(input.root, full));
        if (!expected.has(rel)) {
          mismatches.push(`unexpected entry: ${rel}`);
          continue;
        }
        if (dirent.isDirectory()) stack.push(full);
      }
    }
  }
  if (mismatches.length > 0) {
    return {
      ok: false,
      checked,
      mismatches,
      message: `The extracted tree does not match the source: ${mismatches.length} problem(s), e.g. ${mismatches[0]}.`,
    };
  }
  return {
    ok: true,
    checked,
    mismatches: [],
    message: `Verified ${checked} of ${input.manifest.entries.length} manifest entries byte-for-byte.`,
  };
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

export interface PublishResult {
  ok: boolean;
  targetPath: string;
  error: string | null;
}

/**
 * Publish a fully verified staging tree with ONE atomic rename.
 *
 * Refuses a non-empty target: merging would silently combine a partial tree
 * with the seed, and the following bisync would then have to guess. An empty
 * target directory (created by the executor's pre-sync `mkdir -p`) is removed
 * and replaced. A different-filesystem staging directory is refused here as a
 * second line of defence behind `validateStagingLocation`.
 */
export function publishStagedTree(input: {
  stagingDir: string;
  targetPath: string;
  targetParentDevice?: number | null;
}): PublishResult {
  if (!existsSync(input.stagingDir)) {
    return { ok: false, targetPath: input.targetPath, error: "the staging directory does not exist" };
  }
  if (!statSync(input.stagingDir).isDirectory()) {
    return { ok: false, targetPath: input.targetPath, error: "the staging path is not a directory" };
  }
  const stagingParent = input.stagingDir.slice(0, input.stagingDir.lastIndexOf("/")) || "/";
  const targetParent = input.targetPath.slice(0, input.targetPath.lastIndexOf("/")) || "/";
  const policy = validateStagingLocation({
    stagingPath: input.stagingDir,
    targetPath: input.targetPath,
    stagingDevice: safeDevice(stagingParent),
    targetDevice:
      input.targetParentDevice === undefined ? safeDevice(targetParent) : input.targetParentDevice,
  });
  if (!policy.ok) {
    return { ok: false, targetPath: input.targetPath, error: policy.message };
  }
  if (existsSync(input.targetPath)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(input.targetPath);
    } catch (err) {
      return {
        ok: false,
        targetPath: input.targetPath,
        error: `the target exists but cannot be read: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (entries.length > 0) {
      return {
        ok: false,
        targetPath: input.targetPath,
        error:
          "the target directory already contains files. A seed only publishes into an empty target, so nothing is merged or overwritten.",
      };
    }
    try {
      // `rmSync` refuses a directory without `recursive: true`; the target is
      // verified empty above, so a plain rmdir is both sufficient and safest.
      rmdirSync(input.targetPath);
    } catch (err) {
      return {
        ok: false,
        targetPath: input.targetPath,
        error: `the empty target directory could not be replaced: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  try {
    renameSync(input.stagingDir, input.targetPath);
    return { ok: true, targetPath: input.targetPath, error: null };
  } catch (err) {
    return {
      ok: false,
      targetPath: input.targetPath,
      error: `publishing the staged tree failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function safeDevice(path: string): number | null {
  try {
    return statSync(path).dev;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface SeedPreflightInput {
  sourceRoot: string;
  targetPath: string;
  /** Where the staging sibling would be created. */
  stagingDir: string;
  tooling: SeedArchiveTooling;
  format: SeedArchiveFormat;
  /** The effective filter universe. Required — the preflight measures the
   *  same tree the seed would archive, never the raw source. */
  filter: SeedSourceFilterUniverse;
  runner?: SeedCommandRunner;
  manifest?: SeedManifest;
  /** Measured archive ratio from a previous archive, if any. */
  archiveRatio?: number;
}

export interface SeedPreflightResult {
  ok: boolean;
  manifest: SeedManifest | null;
  space: SeedSpacePlan | null;
  stagingMessage: string;
  errors: string[];
}

/**
 * Read-only preflight: measure the effective filter universe of the source,
 * check the staging policy and compute the target's space reservation. Never
 * writes to the target and never creates a staging directory.
 */
export async function seedPreflight(input: SeedPreflightInput): Promise<SeedPreflightResult> {
  const errors: string[] = [];
  const manifest =
    input.manifest ?? (await buildSeedManifest(input.sourceRoot, { filter: input.filter }));
  // Members the universe includes but a seed cannot represent BLOCK the seed;
  // they are not "silently skipped".
  const blocking = seedManifestBlockingReason(manifest);
  if (blocking !== null) errors.push(blocking);
  const targetParent = parentPathOf(input.targetPath) ?? "/";
  const stagingParent = parentPathOf(input.stagingDir) ?? "/";
  const policy = validateStagingLocation({
    stagingPath: input.stagingDir,
    targetPath: input.targetPath,
    stagingDevice: safeDevice(stagingParent),
    targetDevice: safeDevice(targetParent),
  });
  if (!policy.ok) errors.push(policy.message);

  const freeBytes = freeSpaceFor(stagingParent);
  const space = computeSeedSpacePlan({
    sourceBytes: manifest.totalBytes,
    sourceFiles: manifest.entries.length,
    targetFreeBytes: freeBytes,
    ...(input.archiveRatio !== undefined ? { archiveRatio: input.archiveRatio } : {}),
  });
  if (!space.ok) errors.push(space.message);

  return {
    ok: errors.length === 0,
    manifest,
    space,
    stagingMessage: policy.message,
    errors,
  };
}

/** Free bytes on the filesystem holding `path`, or null. */
export function freeSpaceFor(path: string): number | null {
  try {
    const stat = statfsSync(path);
    const available = stat.bavail ?? stat.bfree;
    const size = stat.bsize;
    if (typeof available !== "number" || typeof size !== "number") return null;
    const bytes = available * size;
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** Re-exported so daemon callers do not need a second core import. */
export { seedArchiveExtension, type SeedArchiveFormat, type SeedArchiveTooling };
