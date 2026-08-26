// Dotfile restore diff helper (P-B item #15 / `docs/cleanup-2026-08-18.md`).
//
// Walks a tarball's contents and compares each entry against the
// corresponding file on disk (sha256 over the file body when sizes match,
// otherwise just sizes — sha256 catches content swaps inside an unchanged
// shell-script wrapper etc.).
//
// Designed so the IO layer (`listTarballEntries` + `readTarballContents` +
// `readDiskEntries`) is separated from the pure diff function
// (`diffTarAgainstDisk`). The tests exercise the pure half with fixture
// data; the IO wrappers are exercised only when the system has `tar` + a
// writable tmp dir available.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A single entry inside the tarball. */
export interface TarEntry {
  /** Path inside the tarball, slash-separated, no leading `./`. */
  path: string;
  /** Size in bytes as reported by `tar -tvzf` (`size` column). */
  size: number;
  /**
   * Sha256 over the entry's contents. Populated by `readTarballContents`
   * (which extracts the tarball to a temp dir). When omitted the diff
   * falls back to size-only comparison (still detects NEW vs CHANGED,
   * but cannot distinguish SAME from a same-size content swap).
   */
  sha256?: string;
}

/** A file that exists on disk inside the extract dir. */
export interface DiskEntry {
  path: string;
  size: number;
  sha256: string;
}

export type DiffKind = "NEW" | "CHANGED" | "SAME";

export type DiffLine =
  | { kind: "NEW"; path: string; toSize: number }
  | { kind: "SAME"; path: string; size: number }
  | { kind: "CHANGED"; path: string; fromSize: number; toSize: number };

export interface DiffResult {
  lines: DiffLine[];
  /** Number of entries trimmed from `lines` because the cap was hit. */
  truncated: number;
  /** Counts for the trailing summary line. */
  counts: { NEW: number; CHANGED: number; SAME: number; total: number };
}

const DEFAULT_MAX_LINES = 50;

/**
 * Pure diff: takes the tarball entries and a map of on-disk files, and
 * returns one DiffLine per tar entry. Size mismatch is always CHANGED.
 * Size match + sha256 match is SAME. Size match + sha256 mismatch is
 * CHANGED (size X→X — content). Missing sha256 on a size-equal entry is
 * optimistic SAME (the IO layer can avoid hashing by skipping the
 * extract step).
 */
export function diffTarAgainstDisk(
  tar: ReadonlyArray<TarEntry>,
  disk: ReadonlyMap<string, DiskEntry>,
): DiffLine[] {
  const out: DiffLine[] = [];
  for (const entry of tar) {
    const onDisk = disk.get(entry.path);
    if (onDisk === undefined) {
      out.push({ kind: "NEW", path: entry.path, toSize: entry.size });
      continue;
    }
    if (onDisk.size !== entry.size) {
      out.push({
        kind: "CHANGED",
        path: entry.path,
        fromSize: onDisk.size,
        toSize: entry.size,
      });
      continue;
    }
    // Sizes match — fall back to sha256 if both sides have it.
    if (entry.sha256 !== undefined && entry.sha256 === onDisk.sha256) {
      out.push({ kind: "SAME", path: entry.path, size: entry.size });
      continue;
    }
    if (entry.sha256 !== undefined && entry.sha256 !== onDisk.sha256) {
      out.push({
        kind: "CHANGED",
        path: entry.path,
        fromSize: onDisk.size,
        toSize: entry.size,
      });
      continue;
    }
    // Sizes match, no sha256 — optimistic SAME (caller can request a
    // hash pass by populating `entry.sha256`).
    out.push({ kind: "SAME", path: entry.path, size: entry.size });
  }
  return out;
}

/**
 * Cap + count wrapper around `diffTarAgainstDisk`. The truncation marker
 * (`+N more`) is rendered by the caller from `result.truncated`.
 */
export function capDiff(
  lines: ReadonlyArray<DiffLine>,
  max = DEFAULT_MAX_LINES,
): DiffResult {
  const counts = { NEW: 0, CHANGED: 0, SAME: 0, total: lines.length };
  for (const l of lines) counts[l.kind] += 1;
  if (lines.length <= max) {
    return { lines: [...lines], truncated: 0, counts };
  }
  return { lines: lines.slice(0, max), truncated: lines.length - max, counts };
}

/**
 * Render a DiffResult into a short unified-style preview string. One line
 * per entry, prefixed with a kind tag (`NEW ` / `SAME ` / `CHANGED size
 * X→Y`), capped by `capDiff` upstream. Designed for an 80-col TUI status
 * block.
 */
export function formatDiffPreview(result: DiffResult): string {
  const head = result.lines.map((l) => {
    switch (l.kind) {
      case "NEW":
        return `NEW       ${l.path}  (${formatBytes(l.toSize)})`;
      case "SAME":
        return `SAME      ${l.path}  (skipped)`;
      case "CHANGED":
        return `CHANGED   ${l.path}  (${formatBytes(l.fromSize)} → ${formatBytes(l.toSize)})`;
    }
  });
  const tail: string[] = [];
  if (result.truncated > 0) {
    tail.push(`+${result.truncated} more`);
  }
  tail.push(
    `Summary: ${result.counts.NEW} new, ${result.counts.CHANGED} changed, ${result.counts.SAME} same, ${result.counts.total} total`,
  );
  return [...head, ...tail].join("\n");
}

// ---------------------------------------------------------------------------
// IO layer — small wrappers that the dotfiles view calls. Kept here so the
// pure diff function stays unit-testable without Bun.spawn or fs access.
// ---------------------------------------------------------------------------

/**
 * Parse `tar -tvzf` output into a `TarEntry[]`. Each non-empty,
 * non-directory line produces one entry.
 */
export async function listTarballEntries(
  tarball: string,
): Promise<TarEntry[]> {
  const proc = Bun.spawn(["tar", "tvzf", tarball], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(`tar tvzf failed (${exit}): ${errText.trim()}`);
  }
  return parseTarListing(stdout);
}

/** Pure parser for the listing — exported for tests. */
export function parseTarListing(text: string): TarEntry[] {
  const entries: TarEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/u, "");
    if (line.length === 0) continue;
    // `tar -tvzf` line shape (GNU):
    //   `-rw-r--r--  user/group  1234  2026-01-02 03:04  path/to/file`
    // The size column is the third whitespace-separated field; the path
    // comes after the date+time columns.
    const parts = line.split(/\s+/u);
    if (parts.length < 6) continue;
    const size = Number.parseInt(parts[2] ?? "", 10);
    if (!Number.isFinite(size)) continue;
    const path = parts.slice(5).join(" ");
    if (path.endsWith("/")) continue; // directory entries
    entries.push({ path, size });
  }
  return entries;
}

/**
 * Extract the tarball into a fresh temp dir and walk it, returning one
 * `TarEntry` per file with sha256 populated. Cleans up the temp dir on
 * return. Used by `computeRestoreDiff` to make SAME detection reliable
 * (size-only would miss same-size content swaps).
 */
export async function readTarballContents(
  tarball: string,
): Promise<{ entries: TarEntry[]; stagingDir: string }> {
  const stagingDir = mkdtempSync(join(tmpdir(), "lamasync-diff-"));
  try {
    const proc = Bun.spawn(["tar", "xzf", tarball, "-C", stagingDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const errText = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    if (exit !== 0) {
      throw new Error(`tar xzf failed (${exit}): ${errText.trim()}`);
    }
    const listing = await listTarballEntries(tarball);
    const map = new Map<string, { size: number; sha256: string }>();
    walkHashed(stagingDir, "", map);
    const entries: TarEntry[] = listing.map((e) => {
      const hit = map.get(e.path);
      return { ...e, sha256: hit?.sha256 ?? "" };
    });
    return { entries, stagingDir };
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Walk `dir` recursively and return a map of every regular file found
 * (`path → DiskEntry`). The map keys are slash-relative paths — i.e. the
 * same shape tarball entries use — so the diff is a straight lookup.
 *
 * Missing `dir` is treated as an empty map (NEW-only diff): that matches
 * the user expectation for a first restore.
 */
export function readDiskEntries(dir: string): Map<string, DiskEntry> {
  const out = new Map<string, DiskEntry>();
  const root = dir.replace(/\/$/u, "");
  if (root.length === 0) return out;
  try {
    const rootStat = statSync(root);
    if (!rootStat.isDirectory()) return out;
  } catch {
    return out;
  }
  const map = new Map<string, { size: number; sha256: string }>();
  walkHashed(root, "", map);
  for (const [path, info] of map) {
    out.set(path, { path, size: info.size, sha256: info.sha256 });
  }
  return out;
}

/**
 * End-to-end helper: list the tarball, extract it to a temp dir for
 * hashing, walk the extract dir, return the capped diff result.
 *
 * Cleans up the temp staging dir on return. Errors from
 * `listTarballEntries` / `readTarballContents` propagate so the view can
 * surface them in the preview pane.
 */
export async function computeRestoreDiff(
  tarball: string,
  extractDir: string,
  opts: { max?: number } = {},
): Promise<DiffResult> {
  const { entries, stagingDir } = await readTarballContents(tarball);
  try {
    const disk = readDiskEntries(extractDir);
    const lines = diffTarAgainstDisk(entries, disk);
    return capDiff(lines, opts.max ?? DEFAULT_MAX_LINES);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Walk a directory recursively and populate `out` with each regular
 * file's size + sha256. Symlinks and special files are skipped — the
 * diff surface is plain files only.
 */
function walkHashed(
  root: string,
  prefix: string,
  out: Map<string, { size: number; sha256: string }>,
): void {
  let names: string[];
  try {
    names = readdirSync(join(root, prefix));
  } catch {
    return;
  }
  for (const name of names) {
    const child = join(root, prefix, name);
    let stat;
    try {
      stat = statSync(child);
    } catch {
      continue;
    }
    const rel = prefix.length === 0 ? name : `${prefix}/${name}`;
    if (stat.isDirectory()) {
      walkHashed(root, rel, out);
      continue;
    }
    if (!stat.isFile()) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(child);
    } catch {
      continue;
    }
    out.set(rel, {
      size: stat.size,
      sha256: createHash("sha256").update(buf).digest("hex"),
    });
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
