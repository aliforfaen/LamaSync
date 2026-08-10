// LAMA-226: pure helpers for the Data Browser write-operation engine.
//
// `browse-jobs.ts` owns the side effects (rclone spawn, DB rows, WS events).
// This module owns the *decisions*: which rclone sections a job needs, what
// argv the spawn runs with, which folder paths the user-facing label maps to.
// Splitting them lets unit tests assert the wire-level behaviour without
// touching the filesystem, the DB, or `Bun.spawn` — the AGENTS.md invariant
// "`bun test` always works" stays true even on machines without rclone.

import type { BrowseJobOperation, BrowseRef, Folder } from "@lamasync/core";

/**
 * Canonical destination key for the concurrency guard. Stored as
 * `browse_jobs.destination` AND used to probe the in-flight set so the
 * busy check actually matches what was stored (LAMA-226 P1-3).
 */
export function destKey(ref: BrowseRef): string {
  const path = ref.path.replace(/^\/+/, "").replace(/\/+$/, "");
  return `${ref.kind}:${ref.folderId ?? ""}:${path}`;
}

/** Human-readable label for a ref, used in the job + operation log. */
export function refLabel(ref: BrowseRef): string {
  const p = ref.path.replace(/\/+$/, "") || ".";
  return ref.kind === "s3" ? `s3:${ref.folderId ?? "?"}:${p}` : `local:${p}`;
}

/**
 * Resolve a ref's relative path into an rclone remote path string.
 *
 * For `local` refs the result is `<prefix>/<name>` (joined to whatever
 * `ref.path` was, which is itself already validated). For `s3` refs the
 * result is `<bucket>/<prefix>/<name>` — rclone S3 paths are
 * `remote:bucket/key`, and the bucket comes from the folder row (never the
 * client-supplied `path`, which is the prefix within the bucket).
 */
export function remotePath(
  ref: BrowseRef,
  name: string | undefined,
  bucket: string | undefined,
): string {
  const base = ref.path.replace(/^\/+/, "").replace(/\/+$/, "");
  const parts = [base, name].filter((p): p is string => p !== undefined && p !== "");
  const joined = parts.join("/");
  if (ref.kind === "s3") {
    return bucket ? `${bucket}/${joined}` : joined;
  }
  return joined;
}

/** Local backup root — same root the read-only browser uses. */
export function backupRoot(): string {
  return process.env.LAMASYNC_BACKUP_DIR ?? "/backups";
}

export interface S3SectionInput {
  /** Existing `[name]` section to write into the rclone config. */
  name: string;
  folder: Folder;
  endpoint: string;
  provider: "aws" | "other";
  accessKeyId: string;
  secretAccessKey: string;
  region: string | null;
  bucket: string;
}

export interface LocalSectionInput {
  name: string;
}

export interface BuildConfigInput {
  /** Pre-resolved sections for each side of the operation. */
  src: S3SectionInput | LocalSectionInput | null;
  dst: S3SectionInput | LocalSectionInput | null;
}

/**
 * Build the text of a per-job rclone config. Pure: takes pre-resolved
 * S3 inputs (so the caller controls the secret fetch) and emits a complete
 * config file body. Callers write the result to a temp file (see
 * `withTempRcloneConfig`).
 */
export function buildRcloneConfig(input: BuildConfigInput): string {
  const lines: string[] = [];
  if (input.src) {
    if ("endpoint" in input.src) {
      lines.push(`[${input.src.name}]`);
      lines.push("type = s3");
      lines.push(`provider = ${input.src.provider === "aws" ? "AWS" : "Other"}`);
      lines.push("env_auth = false");
      lines.push(`access_key_id = ${input.src.accessKeyId}`);
      lines.push(`secret_access_key = ${input.src.secretAccessKey}`);
      lines.push(`endpoint = ${input.src.endpoint}`);
      if (input.src.region) lines.push(`region = ${input.src.region}`);
      lines.push("");
    } else {
      lines.push(`[${input.src.name}]`);
      lines.push("type = local");
      lines.push("");
    }
  }
  if (input.dst) {
    if ("endpoint" in input.dst) {
      lines.push(`[${input.dst.name}]`);
      lines.push("type = s3");
      lines.push(`provider = ${input.dst.provider === "aws" ? "AWS" : "Other"}`);
      lines.push("env_auth = false");
      lines.push(`access_key_id = ${input.dst.accessKeyId}`);
      lines.push(`secret_access_key = ${input.dst.secretAccessKey}`);
      lines.push(`endpoint = ${input.dst.endpoint}`);
      if (input.dst.region) lines.push(`region = ${input.dst.region}`);
      lines.push("");
    } else {
      lines.push(`[${input.dst.name}]`);
      lines.push("type = local");
      lines.push("");
    }
  }
  return lines.join("\n");
}

export interface BuildArgvInput {
  operation: "copyto" | "moveto" | "mkdir" | "delete" | "deletefile" | "purge" | "cat" | "size";
  /** rclone config path on disk (caller writes the temp file). */
  configPath: string;
  /**
   * For copyto/moveto: srcRemote + srcPath (joined as `srcRemote:srcPath`).
   * For mkdir/delete/deletefile/purge/size: the single remote:path (src side).
   */
  srcRemote: string;
  srcPath: string;
  /**
   * For copyto/moveto: dstRemote + dstPath. Omit for single-side ops.
   */
  dstRemote?: string;
  dstPath?: string;
  /** Per-op timeout forwarded to rclone. */
  timeout?: string;
  /** Pass `--rmdirs` for `rclone delete <path>`. */
  rmdirs?: boolean;
}

/**
 * Build the argv to invoke `rclone` for one step of a browse operation.
 * Pure: no spawn, no fs, no env access. The caller hands the resulting
 * array to `Bun.spawn` (or tests assert it).
 */
export function buildRcloneArgv(input: BuildArgvInput): string[] {
  const argv = ["rclone", input.operation];
  if (input.operation === "copyto" || input.operation === "moveto") {
    if (input.dstRemote === undefined || input.dstPath === undefined) {
      throw new Error(`${input.operation} requires dstRemote + dstPath`);
    }
    argv.push(
      `${input.srcRemote}:${input.srcPath}`,
      `${input.dstRemote}:${input.dstPath}`,
    );
  } else if (
    input.operation === "mkdir" ||
    input.operation === "delete" ||
    input.operation === "deletefile" ||
    input.operation === "purge" ||
    input.operation === "cat" ||
    input.operation === "size"
  ) {
    argv.push(`${input.srcRemote}:${input.srcPath}`);
  } else {
    // Exhaustiveness: TS narrows to `never` here.
    const _exhaustive: never = input.operation;
    throw new Error(`unknown rclone operation: ${String(_exhaustive)}`);
  }
  argv.push("--config", input.configPath);
  if (input.timeout) argv.push("--timeout", input.timeout);
  if (input.rmdirs) argv.push("--rmdirs");
  return argv;
}

/**
 * Resolve the local-path check that decides whether a same-kind local
 * move would clobber its own source (LAMA-226 P1-2). Returns true when:
 *   - `dstPath === srcPath` — rclone copies src/name to src/name (no-op),
 *     then `deleteSource` rmSyncs the same path → data loss, OR
 *   - `dstPath` equals `srcPath/<srcName>` — rclone copyto of a file/dir
 *     onto itself, no-op then rmSync, OR
 *   - `dstPath` is nested under `srcPath/<srcName>` — recursive copy
 *     eats itself.
 * The route blocks on a true result.
 */
export function isContainedLocalMove(
  srcPath: string,
  srcName: string,
  dstPath: string,
): boolean {
  if (srcPath === dstPath) return true;
  const srcDir = `${srcPath.replace(/\/+$/, "")}/${srcName}`;
  const dst = dstPath.replace(/\/+$/, "");
  if (dst === srcDir) return true;
  return dst.startsWith(`${srcDir}/`);
}

/**
 * Resolve the s3 same-folder check (LAMA-226 P1-2). Returns true when an
 * intra-folder prefix move is safe — i.e. the destination prefix doesn't
 * fold a moved entry into itself. Each entry in `names` resolves to
 * `<src>/<name>`; a destination prefix equal to or nested under any of them
 * means rclone no-ops the copy and the source delete destroys the data.
 * Moving `dir` from the bucket root into prefix `dir` is the classic case.
 */
export function isSafeS3IntraFolderMove(
  srcPath: string,
  dstPath: string,
  names: string[],
): boolean {
  const norm = (p: string): string => p.replace(/^\/+/, "").replace(/\/+$/, "");
  const src = norm(srcPath);
  const dst = norm(dstPath);
  // Same prefix: rclone copies each entry onto itself (no-op), then the
  // source delete removes it.
  if (src === dst) return false;
  for (const name of names) {
    const srcEntry = src === "" ? norm(name) : `${src}/${norm(name)}`;
    if (dst === srcEntry || dst.startsWith(`${srcEntry}/`)) return false;
  }
  return true;
}

export type { BrowseJobOperation };