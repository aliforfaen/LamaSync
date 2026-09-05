import { basename, dirname, isAbsolute, join, relative } from "path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import type { AppCaptureAssignment, ConflictStrategy, EffectivePause, Folder, FolderAssignment, FolderType, HostConfig, LamaSyncApiClient, OperationReport, OperationStatus, ResticSnapshot } from "@lamasync/core";
import { resolveDestination } from "@lamasync/core";
import { runHook } from "./hooks.ts";
import { loadFilterPatterns, resolveFilterPath, writeExcludeFile } from "./ignore.ts";
import { startLanPeerSession, type LanPeerSession } from "./lan-peer.ts";
import { getRemoteName } from "./rclone.ts";
import { materialiseGitignoreFilter } from "./gitignore.ts";
import { expandHomePath } from "./config.ts";

export interface ExecuteOptions {
  assignment: FolderAssignment;
  folder: Folder;
  hostConfig: HostConfig;
  client: LamaSyncApiClient;
  hostId: string;
  configPath: string;
  dryRun?: boolean;
  signal?: AbortSignal;
}

interface TransferStats {
  files: number; bytes: number; errors: number; checks: number; transfers: number;
}

/**
 * LAMA-247 #12: aggregated rclone JSON-log state + dry-run candidates.
 * `files` counts per-file "Copied …" messages; the rest mirror the final
 * `stats` block rclone emits (transfers/bytes/checks/errors).
 */
export interface RcloneLogStats extends TransferStats {
  wouldCopy: string[];
  wouldDelete: string[];
  wouldMkdir: string[];
}

/**
 * Feed one chunk of raw rclone `--use-json-log` output into `acc` (returns
 * it for chaining). Stat lines update cumulative counters; per-file messages
 * count copied files and dry-run candidates. Non-JSON lines are skipped.
 *
 * Exported for the fixture test (LAMA-247 #12): modern rclone (>= 1.63)
 * writes the JSON log to stderr while older writers use stdout, so the
 * daemon feeds BOTH streams through this accumulator.
 */
export function accumulateRcloneJsonLog(
  text: string,
  acc: RcloneLogStats,
): RcloneLogStats {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as {
        stats?: {
          bytes?: unknown;
          checks?: unknown;
          errors?: unknown;
          transfers?: unknown;
        };
        msg?: unknown;
        object?: unknown;
      };
      const s = obj.stats;
      if (s) {
        if (typeof s.bytes === "number") acc.bytes = s.bytes;
        if (typeof s.errors === "number") acc.errors = s.errors;
        if (typeof s.checks === "number") acc.checks = s.checks;
        if (typeof s.transfers === "number") acc.transfers = s.transfers;
      }
      const msg = obj.msg;
      if (msg === "Copied (new)" || msg === "Copied (server-side copy)") acc.files += 1;
      if (msg === "Would copy" && typeof obj.object === "string") acc.wouldCopy.push(obj.object);
      if (msg === "Would delete" && typeof obj.object === "string") acc.wouldDelete.push(obj.object);
      if (msg === "Would make directory" && typeof obj.object === "string") acc.wouldMkdir.push(obj.object);
    } catch {}
  }
  return acc;
}
interface CommandResult {
  exitCode: number; timedOut: boolean; aborted: boolean; abortReason?: string;
  stats: TransferStats;
  stdoutTail: string; stderrTail: string; durationMs: number;
  wouldCopy: string[]; wouldDelete: string[]; wouldMkdir: string[];
}
const DEFAULT_TIMEOUT_SEC = 600;
const DRY_RUN_TIMEOUT_SEC = 60;
const MOUNT_TIMEOUT_SEC = 30;
const DISK_SPACE_DEFAULT = 1_000_000_000;
const BISYNC_CORRUPTION_MARKERS = ["bisync aborted", "inconsistent state", "must use --resync", "state corruption"];

// LAMA-294: rclone's documented exit codes (lib/exitcode/exitcode.go).
//   0 Success          5 RetryError (temporary, may retry)
//   9 NoFilesTransferred (everything succeeded, no transfer made)
// The daemon must only retry transient failures (5, or a timeout); it must
// NOT retry missing paths (3/4 Dir?File not found), usage/syntax errors (2),
// uncategorized (1), no-retry (6), fatal (7), or quota-exceeded (8/10).
export type RcloneExitCategory = "success" | "no-transfer" | "retryable" | "non-retryable";

export function classifyRcloneExit(
  code: number,
  folderType?: FolderType,
): RcloneExitCategory {
  switch (code) {
    case 0:
      return "success";
    case 9:
      return "no-transfer"; // everything succeeded but nothing was copied
    case 5:
      return "retryable"; // temporary error the operation may be retried
    case 1:
      // bisync documents exit 1 as a non-critical failing run where a rerun
      // may succeed. For one-shot copy/mount operations, retain the stricter
      // generic rclone classification and surface it as a real failure.
      return folderType === "sync" ? "retryable" : "non-retryable";
    default:
      return "non-retryable";
  }
}

/**
 * LAMA-309: make sure the assignment's local directory exists for the folder
 * types that write into it (sync / mount). `backup` and `dotfile` types are
 * deliberately skipped — a missing source must keep failing, because creating
 * an empty dir here then one-way-syncing could silently wipe remote data.
 *
 * Returns a human-readable failure summary when the directory cannot be
 * created (EACCES / EROFS / ENOTDIR …), or `null` on success. Callers fail
 * the run before invoking rclone.
 */
export function ensureLocalDirectory(
  folderType: FolderType,
  localPath: string,
): string | null {
  if (folderType !== "sync" && folderType !== "mount") return null;
  try {
    mkdirSync(localPath, { recursive: true });
    return null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `local directory ${localPath} could not be created: ${reason}`;
  }
}

// ---------------------------------------------------------------------------
// Disk space pre-flight (LAMA-116)
// ---------------------------------------------------------------------------
interface DiskCheck {
  ok: boolean;
  availableBytes: number;
  error?: string;
}
async function checkDiskSpace(path: string, requiredBytes: number): Promise<DiskCheck> {
  try {
    const df = Bun.spawnSync(["df", "-B1", "--output=avail", path]);
    if (df.exitCode !== 0) return { ok: true, availableBytes: 0, error: `df exit=${df.exitCode}` };
    const lines = new TextDecoder().decode(df.stdout).trim().split(/\r?\n/);
    const avail = lines.length >= 2 ? Number.parseInt(lines[1], 10) : NaN;
    if (!Number.isFinite(avail)) return { ok: true, availableBytes: 0, error: "could not parse df" };
    if (avail < requiredBytes) return { ok: false, availableBytes: avail };
    return { ok: true, availableBytes: avail };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: true, availableBytes: 0, error: msg };
  }
}

function parseCacheMax(size: string): number {
  const m = /^(\d+)([KMGT])?$/i.exec(size);
  if (!m) return 1024 * 1024 * 1024; // 1 GiB
  const n = Number.parseInt(m[1], 10);
  const u = (m[2] ?? "").toUpperCase();
  if (u === "G") return n * 1024 * 1024 * 1024;
  if (u === "M") return n * 1024 * 1024;
  if (u === "K") return n * 1024;
  return n;
}

// ---------------------------------------------------------------------------
// Restic helpers (LAMA-133)
// ---------------------------------------------------------------------------
interface TempFile {
  path: string;
  cleanup(): void;
}

function makeTempFile(name: string, content: string): TempFile {
  const dir = join(tmpdir(), `lamasync-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, { mode: 0o600 });
  return {
    path,
    cleanup() {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    },
  };
}

async function initResticRepo(repo: string, passwordFile: string): Promise<{ ok: boolean; error?: string }> {
  const proc = Bun.spawn(["restic", "init", "--repo", repo, "--password-file", passwordFile], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  if (exit === 0) return { ok: true };
  // "already initialized" is not an error for us.
  if (stderr.includes("already initialized") || stderr.includes("repository master key and config already initialized")) {
    return { ok: true };
  }
  return { ok: false, error: `restic init exit=${exit}: ${stderr.slice(-500)}` };
}

interface ResticBackupResult {
  ok: boolean;
  snapshotId?: string;
  error?: string;
  durationMs: number;
}

async function runResticBackup(
  repo: string,
  passwordFile: string,
  paths: string[],
  tags: string[],
  timeoutSec: number,
): Promise<ResticBackupResult> {
  const t0 = Date.now();
  const args = ["backup", "--repo", repo, "--password-file", passwordFile, "--json", ...tags.map((t) => `--tag=${t}`), ...paths];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, timeoutSec * 1000);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  clearTimeout(timer);
  if (timedOut || exit !== 0) {
    return { ok: false, error: timedOut ? "restic backup timed out" : stderr.slice(-1000), durationMs: Date.now() - t0 };
  }
  const snapshotId = parseResticSnapshotId(stdout);
  return { ok: true, snapshotId, durationMs: Date.now() - t0 };
}

function parseResticSnapshotId(stdout: string): string | undefined {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.snapshot_id === "string" && obj.snapshot_id) return obj.snapshot_id;
      if (typeof obj.id === "string" && obj.id) return obj.id;
      // restic 0.17+ uses "snapshot_id" inside message_type=snapshot
      if (obj.message_type === "snapshot" && typeof obj.id === "string") return obj.id;
    } catch {
      // ignore malformed json lines
    }
  }
  return undefined;
}

export async function executeResticRestore(
  assignment: FolderAssignment,
  job: { snapshotId: string; targetPath: string; include?: string[] | null },
  timeoutSec = DEFAULT_TIMEOUT_SEC,
): Promise<{ ok: boolean; error?: string; durationMs: number }> {
  const repo = assignment.resticRepository;
  const password = assignment.resticPassword;
  if (!repo || !password) {
    return { ok: false, error: "assignment has no restic repository or password", durationMs: 0 };
  }
  const passwordFile = makeTempFile("restic-password", password);
  try {
    const init = await initResticRepo(repo, passwordFile.path);
    if (!init.ok) {
      return { ok: false, error: `restic init failed: ${init.error}`, durationMs: 0 };
    }
    return await runResticRestore(repo, passwordFile.path, job.snapshotId, job.targetPath, job.include ?? undefined, timeoutSec);
  } finally {
    passwordFile.cleanup();
  }
}

async function runResticRestore(
  repo: string,
  passwordFile: string,
  snapshotId: string,
  target: string,
  include: string[] | undefined,
  timeoutSec: number,
): Promise<{ ok: boolean; error?: string; durationMs: number }> {
  const t0 = Date.now();
  mkdirSync(target, { recursive: true });
  const args = ["restic", "restore", snapshotId, "--repo", repo, "--password-file", passwordFile, "--target", target, "--verify"];
  if (include && include.length > 0) {
    for (const pattern of include) {
      args.push("--include", pattern);
    }
  }
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, timeoutSec * 1000);
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  clearTimeout(timer);
  if (timedOut || exit !== 0) {
    return { ok: false, error: timedOut ? "restic restore timed out" : stderr.slice(-1000), durationMs: Date.now() - t0 };
  }
  return { ok: true, durationMs: Date.now() - t0 };
}

function hasResticConfig(assignment: FolderAssignment): boolean {
  return Boolean(assignment.resticRepository && assignment.resticPassword);
}

// ---------------------------------------------------------------------------
// Conflict resolution helpers (LAMA-122)
// ---------------------------------------------------------------------------
interface ParsedConflict {
  path: string;
  localMtime?: number;
  remoteMtime?: number;
}

/** Best-effort size of the local conflict file. stat can race with a
 *  deletion/rename, so unknown sizes stay null (the card renders "—").
 *  The remote size is deliberately NOT measured here — it would need an
 *  extra rclone call per conflict; null is the honest value. */
function localConflictSize(localPath: string, relPath: string): number | null {
  try {
    return statSync(join(localPath, relPath)).size;
  } catch {
    return null;
  }
}

function parseBisyncConflicts(stdout: string, stderr: string): ParsedConflict[] {
  const text = `${stdout}\n${stderr}`;
  const lines = text.split(/\r?\n/);
  const conflicts = new Map<string, ParsedConflict>();
  // rclone bisync prints conflict lines like:
  //   CONFLICT  path/to/file  (path1 mtime=... path2 mtime=...)
  // We also look for lines containing "conflict" and a path.
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!lower.includes("conflict")) continue;
    // Try to extract a path after the CONFLICT marker.
    const m = /CONFLICT\s+(\S+)/i.exec(line);
    const path = m ? m[1] : undefined;
    if (!path) continue;
    const localM = /path1\s+mtime=(\d+)/i.exec(line);
    const remoteM = /path2\s+mtime=(\d+)/i.exec(line);
    conflicts.set(path, {
      path,
      localMtime: localM ? Number.parseInt(localM[1], 10) : undefined,
      remoteMtime: remoteM ? Number.parseInt(remoteM[1], 10) : undefined,
    });
  }
  return [...conflicts.values()];
}

async function applyResolvedConflicts(
  client: LamaSyncApiClient,
  hostId: string,
  folderId: string,
  localPath: string,
  remotePath: string,
  configPath: string,
): Promise<{ applied: number; errors: string[] }> {
  let resolved: { id: string; path: string; resolution: import("@lamasync/core").ConflictResolution }[];
  try {
    resolved = (await client.listConflicts({ hostId, folderId, status: "resolved" }))
      .filter((c) => c.resolution !== null && c.resolution !== undefined)
      .map((c) => ({ id: c.id, path: c.path, resolution: c.resolution! }));
  } catch (err) {
    return { applied: 0, errors: [`failed to fetch resolved conflicts: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const errors: string[] = [];
  let applied = 0;
  for (const c of resolved) {
    const localFile = join(localPath, c.path);
    const remoteFile = `${remotePath}/${c.path}`;
    try {
      if (c.resolution === "local") {
        const proc = Bun.spawn(["rclone", "copyto", localFile, remoteFile, "--config", configPath, "-v"], { stdout: "pipe", stderr: "pipe" });
        const stderr = await new Response(proc.stderr).text();
        const exit = await proc.exited;
        if (exit !== 0) throw new Error(stderr.slice(-500));
      } else if (c.resolution === "remote") {
        const proc = Bun.spawn(["rclone", "copyto", remoteFile, localFile, "--config", configPath, "-v"], { stdout: "pipe", stderr: "pipe" });
        const stderr = await new Response(proc.stderr).text();
        const exit = await proc.exited;
        if (exit !== 0) throw new Error(stderr.slice(-500));
      } else if (c.resolution === "both") {
        const suffix = `.conflict-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
        Bun.spawnSync(["mv", localFile, `${localFile}${suffix}`]);
        const proc = Bun.spawn(["rclone", "copyto", remoteFile, localFile, "--config", configPath, "-v"], { stdout: "pipe", stderr: "pipe" });
        const stderr = await new Response(proc.stderr).text();
        const exit = await proc.exited;
        if (exit !== 0) throw new Error(stderr.slice(-500));
      }
      applied += 1;
      try {
        await client.resolveConflict(c.id, c.resolution);
      } catch (err) {
        errors.push(`${c.path}: ack failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      errors.push(`${c.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { applied, errors };
}

async function rcloneCopyto(src: string, dst: string, configPath: string): Promise<void> {
  const proc = Bun.spawn(["rclone", "copyto", src, dst, "--config", configPath, "-v"], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(stderr.slice(-500));
}

export type ConflictAction =
  | { kind: "local_wins" }
  | { kind: "remote_wins" }
  | { kind: "keep_both" };

export function pickConflictAction(
  strategy: ConflictStrategy,
  localMtime: number | undefined,
  remoteMtime: number | undefined,
  role: string,
): ConflictAction {
  if (strategy === "source_wins") {
    // "target" means the remote side is the designated source of truth;
    // otherwise the local side is treated as source ("source" or "both").
    return role === "target" ? { kind: "remote_wins" } : { kind: "local_wins" };
  }
  if (strategy === "keep_both") {
    return { kind: "keep_both" };
  }
  if (strategy === "newer_wins") {
    if (localMtime !== undefined && remoteMtime !== undefined) {
      if (localMtime > remoteMtime) return { kind: "local_wins" };
      if (remoteMtime > localMtime) return { kind: "remote_wins" };
    }
    // No clear winner (equal or missing mtimes): keep both to avoid data loss.
    return { kind: "keep_both" };
  }
  return { kind: "keep_both" };
}

async function applyAutomaticConflicts(
  conflicts: ParsedConflict[],
  strategy: ConflictStrategy,
  localPath: string,
  remotePath: string,
  role: string,
  configPath: string,
): Promise<{ resolved: number; errors: string[]; unresolved: ParsedConflict[] }> {
  const errors: string[] = [];
  const unresolved: ParsedConflict[] = [];
  let resolved = 0;
  for (const c of conflicts) {
    const localFile = join(localPath, c.path);
    const remoteFile = `${remotePath}/${c.path}`;
    try {
      const action = pickConflictAction(strategy, c.localMtime, c.remoteMtime, role);
      if (action.kind === "local_wins") {
        await rcloneCopyto(localFile, remoteFile, configPath);
      } else if (action.kind === "remote_wins") {
        await rcloneCopyto(remoteFile, localFile, configPath);
      } else if (action.kind === "keep_both") {
        if (existsSync(localFile)) {
          const suffix = `.conflict-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
          renameSync(localFile, `${localFile}${suffix}`);
        }
        await rcloneCopyto(remoteFile, localFile, configPath);
      }
      resolved += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${c.path}: ${msg}`);
      unresolved.push(c);
    }
  }
  return { resolved, errors, unresolved };
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

// LAMA-273: pause / slow-mode helpers. The server resolves the effective
// pause (host row if present, else global row, else null) and embeds it on
// `hostConfig.pause`. The daemon uses it two ways:
//   1. refuse fresh runs while the pause window is active (belt-and-braces
//      against manual / queued-action invocations that bypass the scheduler)
//   2. slow mode injects a `--bwlimit` override through the existing
//      `assignment.bandwidthSchedule` plumbing — we reuse that argv builder
//      path rather than introducing a new rclone argument stream.
export function effectiveBandwidthSchedule(
  assignment: Pick<FolderAssignment, "bandwidthSchedule">,
  pause: EffectivePause | null | undefined,
  now: number = Date.now(),
): string | null {
  if (pause && pause.mode === "slow") {
    const until = Date.parse(pause.until);
    if (Number.isFinite(until) && until > now && pause.bwlimit && pause.bwlimit.trim().length > 0) {
      return pause.bwlimit.trim();
    }
  }
  const schedule = assignment.bandwidthSchedule;
  return schedule && schedule.trim().length > 0 ? schedule.trim() : null;
}

/** True when `hostConfig.pause` is currently active. Pure helper so
 *  scheduler/executor tests can assert the rule without composing a
 *  full HostConfig. */
export function isPauseActive(
  pause: EffectivePause | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!pause) return false;
  const until = Date.parse(pause.until);
  return Number.isFinite(until) && until > now;
}

/**
 * Produce the rclone filter rules used for an assignment. Git metadata must
 * be excluded at transfer time when requested; watcher-side suppression alone
 * cannot prevent bisync from copying it.
 */
export function effectiveSyncFilterPatterns(
  configuredPatterns: readonly string[],
  folderType: FolderType,
  ignoreGitMetadata: boolean | null | undefined,
): string[] {
  if (ignoreGitMetadata && folderType === "sync") {
    return ["- .git/**", ...configuredPatterns];
  }
  return [...configuredPatterns];
}

export async function executeAssignment(opts: ExecuteOptions): Promise<OperationReport> {
  const { assignment, folder, hostConfig, hostId, client } = opts;
  const start = Date.now();

  // LAMA-273: belt-and-braces pause refusal. The scheduler is the primary
  // gate; this catches manual / queued-action runs that bypass it.
  if (isPauseActive(hostConfig.pause)) {
    const summary = `sync skipped: paused until ${hostConfig.pause!.until}`;
    console.log(`[executor] folder=${folder.name} ${summary}`);
    return report(hostId, folder.id, folder.type, "failed", start, {
      summary,
      details: { reason: "paused", mode: hostConfig.pause!.mode, until: hostConfig.pause!.until },
    });
  }

  if (!Bun.which("rclone")) {
    return report(hostId, folder.id, folder.type, "failed", start, { summary: "rclone binary not found in PATH", details: { reason: "rclone-missing" } });
  }

  // LAMA-309: ensure the local directory exists for sync folders before
  // building the rclone command. A missing dir is a normal pre-first-use
  // state and is created here. (Mount folders are handled in the mount case;
  // backup/dotfile must NOT be created — see ensureLocalDirectory.)
  if (folder.type === "sync") {
    const dirErr = ensureLocalDirectory(folder.type, assignment.localPath);
    if (dirErr) {
      return report(hostId, folder.id, folder.type, "failed", start, {
        summary: dirErr,
        details: { reason: "local-dir-create", localPath: assignment.localPath, folderType: folder.type },
      });
    }
  }

  const remoteName = getRemoteName(assignment.remoteName, folder.id);
  // LAMA-294: the destination path/prefix (host-scoped for backups by
  // default) is separate from the connection alias. Two hosts with ordinary
  // backups therefore target distinct namespaces and can run concurrently.
  const remotePath = `${remoteName}:${resolveDestination(folder, assignment)}`;
  const filterMode = folder.type === "mount" ? "mount" : "sync";
  const filterPath = resolveFilterPath(assignment.ignorePath, assignment.mountIgnorePath ?? null, filterMode);
  const configuredPatterns = loadFilterPatterns(filterPath, assignment.localPath);
  // This option is a transfer filter as well as a watcher-noise filter. The
  // recursive rclone pattern keeps Git's object database out of both sides of
  // bisync; merely ignoring inotify events would still copy `.git/`.
  const patterns = effectiveSyncFilterPatterns(
    configuredPatterns,
    folder.type,
    assignment.ignoreGitMetadata,
  );
  const exclude = patterns.length > 0 ? writeExcludeFile(patterns) : null;

  let command: string[];
  let timeoutSec: number;
  const dry = opts.dryRun === true;
  // LAMA-302: `respectGitignore` builds a deterministic Git-ignore filter
  // snapshot and, if the snapshot changed, forces a safe bisync resync (the
  // synchronization universe changed).
  let gitignoreFilter: { path: string; cleanup: () => void } | null = null;
  let gitignoreResync = false;
  let gitignoreHashFile: string | null = null;
  let pendingGitignoreHash: string | null = null;

  switch (folder.type) {
    case "sync": {
      if (!dry && assignment.conflictStrategy === "manual") {
        const resolved = await applyResolvedConflicts(client, hostId, folder.id, assignment.localPath, remotePath, opts.configPath);
        if (resolved.errors.length > 0) {
          console.warn(`[executor] folder=${folder.id} applying resolved conflicts had errors: ${resolved.errors.join("; ")}`);
        }
      }
      if (dry) {
        command = ["bisync", remotePath, assignment.localPath, "--config", opts.configPath, "--use-json-log", "-v", "--dry-run"];
        timeoutSec = DRY_RUN_TIMEOUT_SEC;
      } else {
        const sd = join(homedir(), ".local", "share", "lamasync", "bisync", folder.id);
        const first = !existsSync(join(sd, "bisync.state"));
        mkdirSync(sd, { recursive: true });
        command = ["bisync", remotePath, assignment.localPath, "--config", opts.configPath, "--use-json-log", "-v", "--workdir", sd, "--resilient", "--recover", "--max-lock", "10m"];
        // LAMA-302: respectGitignore → Git ignore semantics via a filter
        // snapshot (never pass .gitignore straight to rclone). The snapshot is
        // merged with any .lamasyncignore patterns and, on change, forces a
        // safe --resync rather than trusting stale bisync listings.
        if (assignment.respectGitignore) {
          const gf = materialiseGitignoreFilter(assignment.localPath, patterns);
          if (gf) {
            gitignoreFilter = gf;
            const hashFile = join(sd, ".filter-snapshot.hash");
            const prev = existsSync(hashFile)
              ? readFileSync(hashFile, "utf8").trim()
              : null;
            if (prev !== gf.hash) {
              gitignoreResync = true;
              gitignoreHashFile = hashFile;
              pendingGitignoreHash = gf.hash;
              console.warn(
                `[executor] folder=${folder.id} gitignore filter snapshot changed; forcing safe resync`,
              );
            }
          }
        }
        if (first || gitignoreResync) command.push("--resync");
        timeoutSec = assignment.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
      }
      break;
    }
    case "backup":
      if (hasResticConfig(assignment)) {
        exclude?.cleanup();
        return runResticBackupAssignment(opts, start);
      }
      command = ["copy", assignment.localPath, remotePath, "--config", opts.configPath, "--use-json-log", "-v"];
      if (dry) command.push("--dry-run");
      timeoutSec = dry ? DRY_RUN_TIMEOUT_SEC : (assignment.timeoutSec ?? DEFAULT_TIMEOUT_SEC);
      break;
    case "mount": {
      // LAMA-309: ensure the mount point directory exists before rclone
      // mount (which requires an existing directory as its target).
      const dirErr = ensureLocalDirectory(folder.type, assignment.localPath);
      if (dirErr) {
        exclude?.cleanup();
        return report(hostId, folder.id, folder.type, "failed", start, {
          summary: dirErr,
          details: { reason: "local-dir-create", localPath: assignment.localPath, folderType: folder.type },
        });
      }
      command = ["mount", remotePath, assignment.localPath, "--config", opts.configPath, "--daemon"];
      timeoutSec = MOUNT_TIMEOUT_SEC;
      break;
    }
    case "dotfile":
      if (assignment.preSyncCmd) {
        const h = await runHook(assignment.preSyncCmd, { folderId: folder.id, localPath: assignment.localPath, op: "pre" });
        if (h.exitCode !== 0) {
          exclude?.cleanup();
          return report(hostId, folder.id, folder.type, "failed", start, { summary: `pre-hook failed (exit ${h.exitCode})`, details: { phase: "pre-hook", exitCode: h.exitCode, stderr: h.stderr, stdout: h.stdout, durationMs: h.durationMs } });
        }
      }
      if (hasResticConfig(assignment)) {
        exclude?.cleanup();
        return runResticDotfileUpload(opts, start);
      }
      exclude?.cleanup();
      return runDotfileUpload(opts, hostConfig, start);
    case "git":
      exclude?.cleanup();
      return runGit(opts, start);
    default:
      exclude?.cleanup();
      return report(hostId, folder.id, folder.type as FolderType, "failed", start, { summary: `unsupported folder type: ${folder.type}`, details: { folderType: folder.type } });
  }

  // LAMA-302: prefer the Git-ignore filter snapshot over .lamasyncignore
  // when respectGitignore is on; otherwise fall back to the .lamasyncignore
  // exclude file.
  const filterFrom = gitignoreFilter ?? exclude;
  if (filterFrom) command.push("--filter-from", filterFrom.path);

  // LAMA-114 + LAMA-273: bandwidth schedule. Slow-mode pause (resolved
  // server-side into hostConfig.pause) wins over the per-assignment
  // schedule — the pause window caps the whole fleet, so the cap must
  // be applied here rather than per-folder. The pause check at the top
  // of executeAssignment guarantees we're outside the "pause" mode
  // window before reaching this branch.
  const effectiveBwlimit = effectiveBandwidthSchedule(assignment, hostConfig.pause);
  if (effectiveBwlimit) {
    command.push("--bwlimit", effectiveBwlimit);
  }

  // LAMA-116: disk-space pre-flight
  if (folder.type === "sync" || folder.type === "backup") {
    const threshold = assignment.availableSpaceThreshold ?? DISK_SPACE_DEFAULT;
    const d = await checkDiskSpace(assignment.localPath, threshold);
    if (!d.ok) {
      exclude?.cleanup();
      return report(hostId, folder.id, folder.type, "failed", start, { summary: "insufficient disk space", details: { reason: "disk-space", availableBytes: d.availableBytes, requiredBytes: threshold } });
    }
    if (d.error) console.warn(`[executor] disk-space warning folder=${folder.id}: ${d.error}`);
  }
  if (folder.type === "mount") {
    const cdir = join(homedir(), ".cache", "lamasync", "vfs", folder.id);
    const max = parseCacheMax(assignment.cacheMaxSize ?? "1G");
    const d = await checkDiskSpace(cdir, Math.ceil(max * 1.2));
    if (!d.ok) {
      exclude?.cleanup();
      return report(hostId, folder.id, folder.type, "failed", start, { summary: "insufficient disk space for mount cache", details: { reason: "disk-space", availableBytes: d.availableBytes, requiredBytes: Math.ceil(max * 1.2), phase: "mount-cache" } });
    }
  }

  // LAMA-123: LAN peer session — serve the local tree to a same-/24 peer
  // (this host's id is the smaller one) or use the peer's tree as the
  // rclone target. The serve handle is killed in the finally block.
  const lanPeer: LanPeerSession = await startLanPeerSession({
    hostId,
    hostConfig,
    assignment,
    folderId: folder.id,
    folderName: folder.name,
    apiKey: client.apiKey,
    configPath: opts.configPath,
    localPath: assignment.localPath,
  });
  if (lanPeer.useRemote !== null) {
    const peerPath = `${lanPeer.useRemote}:${resolveDestination(folder, assignment)}`;
    for (let i = 0; i < command.length; i += 1) {
      if (command[i] === remotePath) {
        command[i] = peerPath;
        break;
      }
    }
  }

  // Retry loop
  const maxRetries = Math.max(0, Math.trunc(assignment.maxRetries ?? 3));
  const maxAttempts = maxRetries + 1;
  let runResult: CommandResult | undefined;
  let postHookMs = 0;
  let attempts = 0;
  let isRecovery = false;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      if (assignment.preSyncCmd) {
        const h = await runHook(assignment.preSyncCmd, { folderId: folder.id, localPath: assignment.localPath, op: "pre" });
        if (h.exitCode !== 0) {
          return report(hostId, folder.id, folder.type, "failed", start, { summary: `pre-hook failed (exit ${h.exitCode})`, details: { phase: "pre-hook", attempt, exitCode: h.exitCode, stderr: h.stderr, stdout: h.stdout, durationMs: h.durationMs } });
        }
      }
      try {
        runResult = await runCommand(command, timeoutSec, opts.signal);
      } catch (err) {
        return report(hostId, folder.id, folder.type, "failed", start, { summary: `executor error: ${err instanceof Error ? err.message : String(err)}`, details: { attempt, error: String(err) } });
      }
      if (folder.type === "sync" && !runResult.aborted && hasBisyncCorruption(runResult.stderrTail)) {
        const sd = join(homedir(), ".local", "share", "lamasync", "bisync", folder.id);
        try {
          const corrupted = archiveBisyncState(sd);
          console.warn(`[executor] folder=${folder.id} bisync state corrupted; archived=${corrupted}; retrying with --resync`);
          mkdirSync(sd, { recursive: true });
          if (!command.includes("--resync")) command.push("--resync");
          runResult = await runCommand(command, timeoutSec, opts.signal);
          isRecovery = true;
        } catch (err) {
          return report(hostId, folder.id, folder.type, "failed", start, { summary: `bisync recovery failed: ${err instanceof Error ? err.message : String(err)}`, details: { attempt, phase: "recovery", error: String(err) } });
        }
      }
      if (assignment.postSyncCmd && runResult.exitCode === 0) {
        const h = await runHook(assignment.postSyncCmd, { folderId: folder.id, localPath: assignment.localPath, op: "post" });
        postHookMs = h.durationMs;
        if (h.exitCode !== 0) {
          return report(hostId, folder.id, folder.type, "failed", start, { summary: `post-hook failed (exit ${h.exitCode})`, details: { phase: "post-hook", attempt, exitCode: h.exitCode, stderr: h.stderr, stdout: h.stdout, durationMs: h.durationMs, rclone: runResult.stats } });
        }
      }
      // LAMA-294: exit 0 (success) and exit 9 (success, no files transferred)
      // both terminate the loop as a clean outcome.
      if ((runResult.exitCode === 0 || runResult.exitCode === 9) && !runResult.timedOut && !runResult.aborted) break;
      // Retry only transient failures (exit 5 / timeout). Missing paths,
      // auth/syntax, fatal and resync-required failures are NOT retried.
      const exitCategory = classifyRcloneExit(runResult.exitCode, folder.type);
      const retryable = !runResult.aborted && (exitCategory === "retryable" || runResult.timedOut);
      if (!retryable || attempt === maxAttempts) break;
      const delayMs = 30_000 * 2 ** (attempt - 1);
      console.warn(`[executor] folder=${folder.id} transient failure attempt=${attempt}/${maxAttempts}; retry in ${delayMs / 1000}s`);
      try { await client.reportOperation(report(hostId, folder.id, folder.type, "retry", start, { summary: `${folder.type} retry ${attempt + 1}/${maxAttempts} exit=${runResult.exitCode}`, details: { attempt, next: attempt + 1, maxAttempts, delayMs, exitCode: runResult.exitCode, exitCategory, retryable: true, timedOut: runResult.timedOut, stderrTail: runResult.stderrTail } })); } catch { /* ignore */ }
      await Bun.sleep(delayMs);
    }
  } finally {
    exclude?.cleanup();
    // LAMA-302: dispose the Git-ignore filter snapshot temp file.
    gitignoreFilter?.cleanup();
    if (lanPeer.serveHandle !== null) {
      void lanPeer.serveHandle.close();
    }
  }
  if (!runResult) {
    return report(hostId, folder.id, folder.type, "failed", start, { summary: "executor did not run rclone", details: { attempts } });
  }

  // Do not acknowledge a changed filter until the forced resync actually
  // succeeded. Otherwise a transient failure would leave old bisync listings
  // paired with a new hash and the next run could incorrectly omit --resync.
  if (
    gitignoreResync &&
    pendingGitignoreHash !== null &&
    gitignoreHashFile !== null &&
    (runResult.exitCode === 0 || runResult.exitCode === 9) &&
    !runResult.timedOut &&
    !runResult.aborted
  ) {
    try {
      writeFileSync(gitignoreHashFile, pendingGitignoreHash);
    } catch (err) {
      console.warn(
        `[executor] folder=${folder.id} could not persist gitignore filter snapshot: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // LAMA-122 / LAMA-162: conflict handling. If bisync reported conflicts,
  // either queue them for manual resolution or apply the folder's automatic
  // strategy (newer_wins, source_wins, keep_both). Unresolvable automatic
  // cases are still queued so the TUI can handle them.
  if (folder.type === "sync" && !dry) {
    const conflicts = parseBisyncConflicts(runResult.stdoutTail, runResult.stderrTail);
    if (conflicts.length > 0) {
      const strategy = assignment.conflictStrategy ?? "manual";
      if (strategy === "manual") {
        try {
          await client.createConflicts(
            conflicts.map((c) => ({
              hostId,
              folderId: folder.id,
              path: c.path,
              localMtime: c.localMtime,
              remoteMtime: c.remoteMtime,
              localSizeBytes: localConflictSize(assignment.localPath, c.path),
              remoteSizeBytes: null,
            })),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[executor] failed to queue conflicts: ${msg}`);
        }
        const paths = conflicts.map((c) => c.path).join(", ");
        return report(hostId, folder.id, folder.type, "conflict", start, {
          summary: `${conflicts.length} conflict(s) need manual resolution`,
          details: { conflicts, paths },
        });
      }

      const auto = await applyAutomaticConflicts(
        conflicts,
        strategy,
        assignment.localPath,
        remotePath,
        assignment.role,
        opts.configPath,
      );
      if (auto.errors.length > 0) {
        console.warn(`[executor] folder=${folder.id} auto-conflict errors: ${auto.errors.join("; ")}`);
      }
      if (auto.unresolved.length > 0) {
        try {
          await client.createConflicts(
            auto.unresolved.map((c) => ({
              hostId,
              folderId: folder.id,
              path: c.path,
              localMtime: c.localMtime,
              remoteMtime: c.remoteMtime,
              localSizeBytes: localConflictSize(assignment.localPath, c.path),
              remoteSizeBytes: null,
            })),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[executor] failed to queue unresolved conflicts: ${msg}`);
        }
        const paths = auto.unresolved.map((c) => c.path).join(", ");
        return report(hostId, folder.id, folder.type, "conflict", start, {
          summary: `${auto.unresolved.length} unresolved conflict(s) after ${strategy}`,
          details: { resolved: auto.resolved, errors: auto.errors, unresolved: auto.unresolved, paths },
        });
      }
      const ok = !runResult.timedOut && !runResult.aborted;
      const status: OperationStatus = ok ? (isRecovery ? "recovery" : "success") : "failed";
      const summary = `${conflicts.length} conflict(s) auto-resolved (${strategy})`;
      return report(hostId, folder.id, folder.type, status, start, {
        summary,
        details: { conflicts, strategy, rclone: runResult.stats, exitCode: runResult.exitCode, timedOut: runResult.timedOut, stderrTail: runResult.stderrTail, durationMs: runResult.durationMs, attempts, isRecovery, lanPeer: lanPeer.detail },
      });
    }
  }

  // LAMA-294: exit 9 (NoFilesTransferred) is success, not a failure.
  const ok = !runResult.timedOut && !runResult.aborted && (runResult.exitCode === 0 || runResult.exitCode === 9);
  const status: OperationStatus = ok ? (isRecovery ? "recovery" : "success") : "failed";
  const summary = buildSummary(folder.type, runResult, start, postHookMs, dry);
  const exitCategory = classifyRcloneExit(runResult.exitCode, folder.type);
  return report(hostId, folder.id, folder.type, status, start, { summary, details: { rclone: runResult.stats, exitCode: runResult.exitCode, exitCategory, retryable: !ok && exitCategory === "retryable", timedOut: runResult.timedOut, stderrTail: runResult.stderrTail, durationMs: runResult.durationMs, attempts, isRecovery, wouldCopy: runResult.wouldCopy, wouldDelete: runResult.wouldDelete, wouldMkdir: runResult.wouldMkdir, lanPeer: lanPeer.detail } });
}

// ---------------------------------------------------------------------------
// rclone runner
// ---------------------------------------------------------------------------
export interface RcloneCommandOptions {
  folderType: FolderType;
  remotePath: string;
  localPath: string;
  configPath: string;
  excludeFilePath: string | null;
  dryRun?: boolean;
  bandwidthSchedule?: string | null;
  /**
   * When true, include the `--workdir` + `--resilient` flags used by long-lived
   * bisync state and add `--resync` on the first run. Set false for one-shot
   * dry-run bisync invocations.
   */
  bisyncStateful?: boolean;
  bisyncStateDir?: string;
}

export function buildRcloneCommand(opts: RcloneCommandOptions): string[] {
  const command: string[] = [];
  const dry = opts.dryRun === true;
  switch (opts.folderType) {
    case "sync": {
      command.push(
        "bisync",
        opts.remotePath,
        opts.localPath,
        "--config",
        opts.configPath,
        "--use-json-log",
        "-v",
      );
      if (dry) {
        command.push("--dry-run");
      } else if (opts.bisyncStateful) {
        const sd = opts.bisyncStateDir ?? "/tmp";
        command.push("--workdir", sd, "--resilient", "--recover", "--max-lock", "10m");
      }
      break;
    }
    case "backup":
      command.push(
        "copy",
        opts.localPath,
        opts.remotePath,
        "--config",
        opts.configPath,
        "--use-json-log",
        "-v",
      );
      if (dry) command.push("--dry-run");
      break;
    case "mount":
      command.push(
        "mount",
        opts.remotePath,
        opts.localPath,
        "--config",
        opts.configPath,
        "--daemon",
      );
      break;
    default:
      throw new Error(`buildRcloneCommand: unsupported folder type ${opts.folderType}`);
  }
  if (opts.excludeFilePath) command.push("--filter-from", opts.excludeFilePath);
  if (opts.bandwidthSchedule && opts.bandwidthSchedule.trim().length > 0) {
    command.push("--bwlimit", opts.bandwidthSchedule.trim());
  }
  return command;
}

 async function runCommand(command: string[], timeoutSec: number, signal?: AbortSignal): Promise<CommandResult> {
  const t0 = Date.now();
  const proc = Bun.spawn(["rclone", ...command], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  let aborted = false;
  let abortReason: string | undefined;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, timeoutSec * 1000);
  const onAbort = (): void => {
    aborted = true;
    abortReason = typeof signal?.reason === "string" ? signal.reason : "aborted";
    timedOut = true;
    try { proc.kill(); } catch {}
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  const acc: RcloneLogStats = {
    files: 0, bytes: 0, errors: 0, checks: 0, transfers: 0,
    wouldCopy: [], wouldDelete: [], wouldMkdir: [],
  };
  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  // LAMA-247 #12: rclone >= 1.63 writes --use-json-log lines to STDERR;
  // older writers used stdout. Feed both so per-file/stats counters are not
  // silently zeroed on modern rclone (the "0 transfers, 0 B" misreport).
  accumulateRcloneJsonLog(stdoutText, acc);
  accumulateRcloneJsonLog(stderrText, acc);
  const { wouldCopy, wouldDelete, wouldMkdir, ...stats } = acc;
  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (signal) {
    signal.removeEventListener("abort", onAbort);
  }
  return { exitCode, timedOut, aborted, abortReason, stats, stdoutTail: tail(stdoutText, 2000), stderrTail: tail(stderrText, 2000), durationMs: Date.now() - t0, wouldCopy, wouldDelete, wouldMkdir };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function tail(s: string, max: number): string { return s.length <= max ? s : s.slice(s.length - max); }
function hasBisyncCorruption(stderr: string): boolean { const n = stderr.toLowerCase(); return BISYNC_CORRUPTION_MARKERS.some((m) => n.includes(m)); }
/**
 * LAMA-308: archive the (corrupted) bisync state dir and return the new path.
 * The timestamp carries full millisecond precision — the previous second-
 * resolution `.corrupted.<YYYYMMDDTHHmm>` suffix collided when several
 * recovery paths archived the same state dir within a second (concurrent
 * `trigger_sync` runs on one folder → ENOTEMPTY loop, 7 failed runs in 2s).
 * `now` is injectable for tests.
 */
export function archiveBisyncState(stateDir: string, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "");
  const base = `${stateDir}.corrupted.${ts}`;
  // Collision guard: if a same-millisecond archive already exists (still
  // theoretically possible with a clock tick between the naming and rename),
  // append an incrementing counter until the target is free.
  let corrupted = base;
  let n = 1;
  while (existsSync(corrupted)) {
    corrupted = `${base}.${n}`;
    n += 1;
  }
  renameSync(stateDir, corrupted);
  const p = dirname(stateDir); const prefix = `${basename(stateDir)}.corrupted.`;
  const backups = readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith(prefix)).map((e) => join(p, e.name)).sort((a, b) => basename(b).localeCompare(basename(a)));
  for (const old of backups.slice(5)) rmSync(old, { recursive: true, force: true });
  return corrupted;
}
function buildSummary(type: FolderType, r: CommandResult, t0: number, postMs: number, dry?: boolean): string {
  const total = Date.now() - t0;
  if (dry) { const p: string[] = []; if (r.wouldCopy.length) p.push(`${r.wouldCopy.length} would-copy`); if (r.wouldDelete.length) p.push(`${r.wouldDelete.length} would-delete`); if (r.wouldMkdir.length) p.push(`${r.wouldMkdir.length} would-mkdir`); return `dry-run: ${p.length ? p.join(", ") : "0 changes"}`; }
  if (r.aborted) return `${type} aborted: ${r.abortReason ?? "lock lost"}`;
  if (r.timedOut) return `${type} timed out after ${Math.round(r.durationMs / 1000)}s`;
  // LAMA-294: exit 9 = NoFilesTransferred — succeeded with nothing to copy.
  if (r.exitCode === 9) return `${type} ok: no files transferred`;
  if (r.exitCode !== 0) return `${type} failed (exit ${r.exitCode}) in ${Math.round(total / 1000)}s`;
  return `${type} ok: ${r.stats.transfers} transfers, ${formatBytes(r.stats.bytes)} in ${Math.round(total / 1000)}s${postMs ? `, post-hook ${postMs}ms` : ""}`;
}
function formatBytes(n: number): string { if (n < 1024) return `${n} B`; if (n < 1048576) return `${(n / 1024).toFixed(1)} KiB`; if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MiB`; return `${(n / 1073741824).toFixed(2)} GiB`; }
function report(hostId: string, folderId: string, operation: FolderType, status: OperationStatus, t0: number, body: { summary: string; details: Record<string, unknown> }): OperationReport {
  return { hostId, folderId, operation, status, summary: body.summary, details: JSON.stringify(body.details), durationMs: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Dotfile upload
// ---------------------------------------------------------------------------
export interface AppCaptureOptions {
  app: AppCaptureAssignment;
  client: LamaSyncApiClient;
  hostId: string;
}

function appCaptureReport(
  hostId: string,
  status: OperationStatus,
  start: number,
  body: { summary: string; details: Record<string, unknown> },
): OperationReport {
  return {
    hostId,
    folderId: null,
    operation: "app-capture",
    status,
    summary: body.summary,
    details: JSON.stringify(body.details),
    durationMs: Date.now() - start,
  };
}

/**
 * Produce a portable archive member root from a logical capture path.
 *
 * A home-relative path deliberately does not contain the source account name:
 * `~/.config/nvim` becomes `home/.config/nvim`. Absolute paths live beneath
 * `absolute/`, so they cannot collide with the portable home namespace. This
 * value is also recorded in the immutable snapshot spec by the server.
 */
export function appArchivePath(path: string): string | null {
  const toSegments = (raw: string): string[] | null => {
    const segments = raw.replaceAll("\\", "/").split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
    return segments;
  };
  if (path === "~") return "home";
  if (path.startsWith("~/")) {
    const segments = toSegments(path.slice(2));
    return segments ? `home/${segments.join("/")}` : null;
  }
  if (path.startsWith("/")) {
    const segments = toSegments(path.slice(1));
    return segments ? `absolute/${segments.join("/")}` : null;
  }
  const windows = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (windows) {
    const segments = toSegments(windows[2]!);
    return segments ? `windows/${windows[1]!.toLowerCase()}/${segments.join("/")}` : null;
  }
  return null;
}

function sourceArchiveMember(path: string): string | null {
  if (!isAbsolute(path)) return null;
  const member = relative("/", path);
  if (member.length === 0 || member.startsWith("../")) return null;
  return member;
}

/** Escape a GNU tar transform's regular-expression side. */
function tarTransformPattern(path: string): string {
  return path.replace(/[\\|.^$*+?()[\]{}]/g, "\\$&");
}

/** Escape a GNU tar transform's replacement side. */
function tarTransformReplacement(path: string): string {
  return path.replace(/[\\|&]/g, "\\$&");
}

/** Build boundary-aware transforms for one source/member mapping. */
export function appArchiveTransforms(sourceMember: string, archivePath: string): string[] {
  const sourcePattern = tarTransformPattern(sourceMember);
  const archiveReplacement = tarTransformReplacement(archivePath);
  return [
    `--transform=s|^${sourcePattern}/|${archiveReplacement}/|`,
    `--transform=s|^${sourcePattern}$|${archiveReplacement}|`,
  ];
}

/**
 * Capture one explicit application protection. This intentionally has no
 * FolderAssignment dependency: an application protection is its own
 * scheduled backup commitment, not a disguised dotfile folder.
 *
 * Archive entries use the portable layout described by `appArchivePath` rather
 * than bare basenames. The actual local source path is kept separate, which
 * means `~` expands for capture but never leaks the source username into a
 * migration archive.
 */
export async function captureAppSnapshot(opts: AppCaptureOptions): Promise<OperationReport> {
  const { app, hostId, client } = opts;
  const start = Date.now();
  if (app.paths.length === 0) {
    return appCaptureReport(hostId, "failed", start, {
      summary: "app protection has no paths",
      details: { protectionId: app.protectionId, appName: app.appName },
    });
  }
  const archiveInputs: string[] = [];
  const transforms: string[] = [];
  for (const [index, path] of app.paths.entries()) {
    const archivePath = appArchivePath(path);
    if (archivePath === null) {
      return appCaptureReport(hostId, "failed", start, {
        summary: `app path is invalid: ${path}`,
        details: { protectionId: app.protectionId, path },
      });
    }
    const resolvedPath = app.resolvedPaths?.[index] ?? expandHomePath(path);
    const sourceMember = sourceArchiveMember(resolvedPath);
    if (sourceMember === null) {
      return appCaptureReport(hostId, "failed", start, {
        summary: `app path is not supported on this host: ${path}`,
        details: { protectionId: app.protectionId, path, resolvedPath },
      });
    }
    if (!existsSync(resolvedPath)) {
      return appCaptureReport(hostId, "failed", start, {
        summary: `app path missing: ${path}`,
        details: { protectionId: app.protectionId, missing: path, resolvedPath },
      });
    }
    archiveInputs.push(sourceMember);
    // Two boundary-aware transforms prevent `/tmp/foo` from accidentally
    // rewriting a separately selected `/tmp/foobar` path.
    transforms.push(...appArchiveTransforms(sourceMember, archivePath));
  }
  const tmpDir = join(tmpdir(), `lamasync-dotfile-${process.pid}-${start}`);
  mkdirSync(tmpDir, { recursive: true });
  const tarball = join(tmpDir, `${start}.tar.gz`);
  const excludeArgs = (app.excludes ?? []).flatMap((e) => ["--exclude", e]);
  try {
    const tar = Bun.spawn(["tar", "czf", tarball, "-C", "/", ...excludeArgs, ...transforms, "--", ...archiveInputs], { stdout: "pipe", stderr: "pipe" });
    const tarStderr = await new Response(tar.stderr).text();
    const tarExit = await tar.exited;
    if (tarExit !== 0) {
      return appCaptureReport(hostId, "failed", start, {
        summary: `app archive failed (exit ${tarExit})`,
        details: { protectionId: app.protectionId, tarStderr: tail(tarStderr, 1000) },
      });
    }
    const size = existsSync(tarball) ? statSync(tarball).size : 0;
    try {
      const snapshot = await client.uploadAppSnapshot(app.protectionId, Bun.file(tarball), {
        description: `scheduled snapshot from ${hostId}`,
      });
      return appCaptureReport(hostId, "success", start, {
        summary: `app capture ok: ${app.paths.length} paths, ${formatBytes(size)} uploaded`,
        details: { protectionId: app.protectionId, snapshotId: snapshot.id, sizeBytes: size, paths: app.paths },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return appCaptureReport(hostId, "failed", start, {
        summary: `app capture upload failed: ${msg}`,
        details: { protectionId: app.protectionId, sizeBytes: size, paths: app.paths, error: msg },
      });
    }
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function runDotfileUpload(opts: ExecuteOptions, hostConfig: HostConfig, start: number): Promise<OperationReport> {
  const { folder, hostId, client } = opts;
  const app = hostConfig.apps.find((candidate) => candidate.appName === folder.name);
  if (!app) {
    return report(hostId, folder.id, folder.type, "failed", start, {
      summary: "no app protection",
      details: { folderName: folder.name },
    });
  }
  return captureAppSnapshot({ app, hostId, client });
}

// ---------------------------------------------------------------------------
// Restic backup / dotfile upload (LAMA-133)
// ---------------------------------------------------------------------------
async function runResticBackupAssignment(opts: ExecuteOptions, start: number): Promise<OperationReport> {
  const { assignment, folder, hostId, client } = opts;
  if (!Bun.which("restic")) {
    return report(hostId, folder.id, folder.type, "failed", start, { summary: "restic binary not found in PATH", details: { reason: "restic-missing" } });
  }
  const repo = assignment.resticRepository!;
  const password = assignment.resticPassword!;
  const passwordFile = makeTempFile("restic-password", password);
  try {
    const init = await initResticRepo(repo, passwordFile.path);
    if (!init.ok) {
      return report(hostId, folder.id, folder.type, "failed", start, { summary: `restic init failed: ${init.error}`, details: { reason: "restic-init" } });
    }
    const threshold = assignment.availableSpaceThreshold ?? DISK_SPACE_DEFAULT;
    const d = await checkDiskSpace(assignment.localPath, threshold);
    if (!d.ok) {
      return report(hostId, folder.id, folder.type, "failed", start, { summary: "insufficient disk space", details: { reason: "disk-space", availableBytes: d.availableBytes, requiredBytes: threshold } });
    }
    if (d.error) console.warn(`[executor] disk-space warning folder=${folder.id}: ${d.error}`);

    if (assignment.preSyncCmd) {
      const h = await runHook(assignment.preSyncCmd, { folderId: folder.id, localPath: assignment.localPath, op: "pre" });
      if (h.exitCode !== 0) {
        return report(hostId, folder.id, folder.type, "failed", start, { summary: `pre-hook failed (exit ${h.exitCode})`, details: { phase: "pre-hook", exitCode: h.exitCode, stderr: h.stderr, stdout: h.stdout, durationMs: h.durationMs } });
      }
    }

    const timeoutSec = assignment.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    const tags = ["lamasync", `folder:${folder.id}`, `host:${hostId}`];
    const result = await runResticBackup(repo, passwordFile.path, [assignment.localPath], tags, timeoutSec);

    if (assignment.postSyncCmd && result.ok) {
      const h = await runHook(assignment.postSyncCmd, { folderId: folder.id, localPath: assignment.localPath, op: "post" });
      if (h.exitCode !== 0) {
        return report(hostId, folder.id, folder.type, "failed", start, { summary: `post-hook failed (exit ${h.exitCode})`, details: { phase: "post-hook", exitCode: h.exitCode, stderr: h.stderr, stdout: h.stdout, durationMs: h.durationMs } });
      }
    }

    if (!result.ok) {
      return report(hostId, folder.id, folder.type, "failed", start, { summary: `restic backup failed: ${result.error}`, details: { reason: "restic-backup", durationMs: result.durationMs } });
    }

    const snapshot: Omit<ResticSnapshot, "id"> = {
      folderId: folder.id,
      hostId,
      snapshotId: result.snapshotId ?? "unknown",
      timestamp: Date.now(),
      paths: [assignment.localPath],
      tags,
    };
    try {
      await client.reportResticSnapshot(snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[executor] failed to report restic snapshot: ${msg}`);
    }

    return report(hostId, folder.id, folder.type, "success", start, { summary: `restic backup ok: ${result.snapshotId ?? "unknown"}`, details: { snapshotId: result.snapshotId, durationMs: result.durationMs, paths: [assignment.localPath] } });
  } finally {
    passwordFile.cleanup();
  }
}

async function runResticDotfileUpload(opts: ExecuteOptions, start: number): Promise<OperationReport> {
  const { assignment, folder, hostId, hostConfig, client } = opts;
  if (!Bun.which("restic")) {
    return report(hostId, folder.id, folder.type, "failed", start, { summary: "restic binary not found in PATH", details: { reason: "restic-missing" } });
  }
  const app = hostConfig.apps.find((a) => a.appName === folder.name);
  if (!app || app.paths.length === 0) {
    return report(hostId, folder.id, folder.type, "failed", start, { summary: "no app protection", details: { folderName: folder.name } });
  }
  const resolvedPaths = app.resolvedPaths ?? app.paths.map(expandHomePath);
  for (const p of resolvedPaths) {
    if (!existsSync(p)) {
      return report(hostId, folder.id, folder.type, "failed", start, { summary: `dotfile path missing: ${p}`, details: { missing: p } });
    }
  }

  const repo = assignment.resticRepository!;
  const password = assignment.resticPassword!;
  const passwordFile = makeTempFile("restic-password", password);
  const filesFrom = makeTempFile("restic-files-from", resolvedPaths.join("\n") + "\n");
  try {
    const init = await initResticRepo(repo, passwordFile.path);
    if (!init.ok) {
      return report(hostId, folder.id, folder.type, "failed", start, { summary: `restic init failed: ${init.error}`, details: { reason: "restic-init" } });
    }

    const timeoutSec = assignment.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    const tags = ["lamasync", `folder:${folder.id}`, `host:${hostId}`, "dotfile"];
    const excludeArgs = (app.excludes ?? []).flatMap((e) => ["--exclude", e]);
    const result = await runResticBackup(repo, passwordFile.path, [...excludeArgs, "--files-from", filesFrom.path], tags, timeoutSec);

    if (!result.ok) {
      return report(hostId, folder.id, folder.type, "failed", start, { summary: `restic dotfile backup failed: ${result.error}`, details: { reason: "restic-backup", durationMs: result.durationMs } });
    }

    const snapshot: Omit<ResticSnapshot, "id"> = {
      folderId: folder.id,
      hostId,
      snapshotId: result.snapshotId ?? "unknown",
      timestamp: Date.now(),
      paths: app.paths,
      tags,
    };
    try {
      await client.reportResticSnapshot(snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[executor] failed to report restic snapshot: ${msg}`);
    }

    return report(hostId, folder.id, folder.type, "success", start, { summary: `restic dotfile ok: ${app.paths.length} paths, snapshot ${result.snapshotId ?? "unknown"}`, details: { snapshotId: result.snapshotId, durationMs: result.durationMs, paths: app.paths } });
  } finally {
    passwordFile.cleanup();
    filesFrom.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Git folder type (LAMA-120)
// ---------------------------------------------------------------------------
async function runGit(opts: ExecuteOptions, start: number): Promise<OperationReport> {
  const { assignment, folder, hostId } = opts;
  const lp = assignment.localPath;
  if (folder.gitProvider === "gh") {
    if (typeof folder.gitRemote !== "string" || folder.gitRemote.trim() === "") {
      return report(hostId, folder.id, folder.type, "failed", start, { summary: "gh provider missing remote", details: { reason: "gh-missing-remote" } });
    }
    if (!Bun.which("gh")) {
      return report(hostId, folder.id, folder.type, "failed", start, { summary: "gh CLI not found", details: { reason: "gh-missing" } });
    }
    const remoteName = folder.gitRemote.trim();
    const pathExists = existsSync(lp);
    const hasDotGit = existsSync(join(lp, ".git"));
    if (!pathExists || !hasDotGit) {
      const clone = Bun.spawnSync(["gh", "repo", "clone", remoteName, lp], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (clone.exitCode !== 0) {
        const e = new TextDecoder().decode(clone.stderr).slice(-1000);
        return report(hostId, folder.id, folder.type, "failed", start, { summary: "gh repo clone failed", details: { reason: "gh-clone-failed", exitCode: clone.exitCode, stderrTail: e } });
      }
    } else {
      const remotes = new TextDecoder().decode(Bun.spawnSync(["git", "-C", lp, "remote"]).stdout).split("\n").filter(Boolean);
      if (!remotes.includes("origin")) {
        const remoteUrl = /^https?:\/\//.test(remoteName) || /^git@/.test(remoteName) || remoteName.includes("://")
          ? remoteName
          : `https://github.com/${remoteName}.git`;
        const addRemote = Bun.spawnSync(["git", "-C", lp, "remote", "add", "origin", remoteUrl]);
        if (addRemote.exitCode !== 0) {
          const e = new TextDecoder().decode(addRemote.stderr).slice(-1000);
          return report(hostId, folder.id, folder.type, "failed", start, { summary: "git remote add origin failed", details: { reason: "git-remote-add-failed", exitCode: addRemote.exitCode, stderrTail: e } });
        }
      }
    }
  }
  if (!existsSync(join(lp, ".git"))) return report(hostId, folder.id, folder.type, "failed", start, { summary: "no git repository", details: { reason: "no-git" } });
  if (!Bun.which("git")) return report(hostId, folder.id, folder.type, "failed", start, { summary: "git not found", details: { reason: "git-missing" } });
  const fetch = Bun.spawnSync(["git", "-C", lp, "fetch", "origin"]);
  if (fetch.exitCode !== 0) { const e = new TextDecoder().decode(fetch.stderr).slice(-1000); return report(hostId, folder.id, folder.type, "failed", start, { summary: "git fetch failed", details: { reason: "fetch-failed", exitCode: fetch.exitCode, stderrTail: e } }); }
  const head = new TextDecoder().decode(Bun.spawnSync(["git", "-C", lp, "rev-parse", "HEAD"]).stdout).trim();
  // Check upstream
  const upCheck = Bun.spawnSync(["git", "-C", lp, "rev-parse", "--abbrev-ref", "HEAD@{u}"]);
  if (upCheck.exitCode !== 0) return report(hostId, folder.id, folder.type, "failed", start, { summary: "no upstream configured", details: { reason: "no-upstream" } });
  const rl = new TextDecoder().decode(Bun.spawnSync(["git", "-C", lp, "rev-list", "--left-right", "--count", "HEAD...@{u}"]).stdout).trim().split(/\s+/);
  const ahead = rl.length >= 2 ? Number.parseInt(rl[0], 10) || 0 : 0;
  const behind = rl.length >= 2 ? Number.parseInt(rl[1], 10) || 0 : 0;
  const pull = Bun.spawnSync(["git", "-C", lp, "pull", "--ff-only"]);
  if (pull.exitCode !== 0) { const e = new TextDecoder().decode(pull.stderr).slice(-1000); return report(hostId, folder.id, folder.type, "failed", start, { summary: "git pull failed", details: { reason: "pull-failed", exitCode: pull.exitCode, stderrTail: e } }); }
  const lc = new TextDecoder().decode(Bun.spawnSync(["git", "-C", lp, "log", "-1", "--pretty=%H %s"]).stdout).trim();
  return report(hostId, folder.id, folder.type, "success", start, { summary: `git ok: +${ahead}/-${behind}`, details: { commitsAhead: ahead, commitsBehind: behind, lastCommit: lc, head } });
}
