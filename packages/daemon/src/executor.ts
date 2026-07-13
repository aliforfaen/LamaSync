import { basename, dirname, join } from "path";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import type { Folder, FolderAssignment, FolderType, HostConfig, LamaSyncApiClient, OperationReport, OperationStatus } from "@lamasync/core";
import { runHook } from "./hooks.ts";
import { loadFilterPatterns, resolveFilterPath, writeExcludeFile } from "./ignore.ts";
import { startLanPeerSession, type LanPeerSession } from "./lan-peer.ts";
import { getRemoteName } from "./rclone.ts";

export interface ExecuteOptions {
  assignment: FolderAssignment;
  folder: Folder;
  hostConfig: HostConfig;
  client: LamaSyncApiClient;
  hostId: string;
  configPath: string;
  dryRun?: boolean;
}

interface TransferStats {
  files: number; bytes: number; errors: number; checks: number; transfers: number;
}
interface CommandResult {
  exitCode: number; timedOut: boolean; stats: TransferStats;
  stdoutTail: string; stderrTail: string; durationMs: number;
  wouldCopy: string[]; wouldDelete: string[]; wouldMkdir: string[];
}
const DEFAULT_TIMEOUT_SEC = 600;
const DRY_RUN_TIMEOUT_SEC = 60;
const MOUNT_TIMEOUT_SEC = 30;
const DISK_SPACE_DEFAULT = 1_000_000_000;
const BISYNC_CORRUPTION_MARKERS = ["bisync aborted", "inconsistent state", "must use --resync", "state corruption"];

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
// Main executor
// ---------------------------------------------------------------------------
export async function executeAssignment(opts: ExecuteOptions): Promise<OperationReport> {
  const { assignment, folder, hostConfig, hostId, client } = opts;
  const start = Date.now();

  if (!Bun.which("rclone")) {
    return report(hostId, folder.id, folder.type, "failed", start, { summary: "rclone binary not found in PATH", details: { reason: "rclone-missing" } });
  }

  const remoteName = getRemoteName(assignment.remoteName, folder.id);
  const remotePath = `${remoteName}:${folder.name}`;
  const filterMode = folder.type === "mount" ? "mount" : "sync";
  const filterPath = resolveFilterPath(assignment.ignorePath, assignment.mountIgnorePath ?? null, filterMode);
  const patterns = loadFilterPatterns(filterPath, assignment.localPath);
  const exclude = patterns.length > 0 ? writeExcludeFile(patterns) : null;

  if (folder.type === "sync" && assignment.conflictStrategy === "manual") {
    exclude?.cleanup();
    return report(hostId, folder.id, folder.type, "conflict", start, { summary: "manual strategy requires UI resolution", details: { conflictStrategy: "manual" } });
  }

  let command: string[];
  let timeoutSec: number;
  const dry = opts.dryRun === true;

  switch (folder.type) {
    case "sync":
      if (dry) {
        command = ["bisync", remotePath, assignment.localPath, "--config", opts.configPath, "--use-json-log", "-v", "--dry-run"];
        timeoutSec = DRY_RUN_TIMEOUT_SEC;
      } else {
        const sd = join(homedir(), ".local", "share", "lamasync", "bisync", folder.id);
        const first = !existsSync(join(sd, "bisync.state"));
        mkdirSync(sd, { recursive: true });
        command = ["bisync", remotePath, assignment.localPath, "--config", opts.configPath, "--use-json-log", "-v", "--workdir", sd, "--resilient", "--recover", "--max-lock", "10m"];
        if (first) command.push("--resync");
        timeoutSec = assignment.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
      }
      break;
    case "backup":
      command = ["copy", assignment.localPath, remotePath, "--config", opts.configPath, "--use-json-log", "-v"];
      if (dry) command.push("--dry-run");
      timeoutSec = dry ? DRY_RUN_TIMEOUT_SEC : (assignment.timeoutSec ?? DEFAULT_TIMEOUT_SEC);
      break;
    case "mount":
      command = ["mount", remotePath, assignment.localPath, "--config", opts.configPath, "--daemon"];
      timeoutSec = MOUNT_TIMEOUT_SEC;
      break;
    case "dotfile":
      if (assignment.preSyncCmd) {
        const h = await runHook(assignment.preSyncCmd, { folderId: folder.id, localPath: assignment.localPath, op: "pre" });
        if (h.exitCode !== 0) {
          exclude?.cleanup();
          return report(hostId, folder.id, folder.type, "failed", start, { summary: `pre-hook failed (exit ${h.exitCode})`, details: { phase: "pre-hook", exitCode: h.exitCode, stderr: h.stderr, stdout: h.stdout, durationMs: h.durationMs } });
        }
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

  if (exclude) command.push("--filter-from", exclude.path);

  // LAMA-114: bandwidth schedule
  if (assignment.bandwidthSchedule && assignment.bandwidthSchedule.trim().length > 0) {
    command.push("--bwlimit", assignment.bandwidthSchedule.trim());
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
    const peerPath = `${lanPeer.useRemote}:${folder.name}`;
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
        runResult = await runCommand(command, timeoutSec);
      } catch (err) {
        return report(hostId, folder.id, folder.type, "failed", start, { summary: `executor error: ${err instanceof Error ? err.message : String(err)}`, details: { attempt, error: String(err) } });
      }
      if (folder.type === "sync" && hasBisyncCorruption(runResult.stderrTail)) {
        const sd = join(homedir(), ".local", "share", "lamasync", "bisync", folder.id);
        try {
          const corrupted = archiveBisyncState(sd);
          console.warn(`[executor] folder=${folder.id} bisync state corrupted; archived=${corrupted}; retrying with --resync`);
          mkdirSync(sd, { recursive: true });
          if (!command.includes("--resync")) command.push("--resync");
          runResult = await runCommand(command, timeoutSec);
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
      if (runResult.exitCode === 0 && !runResult.timedOut) break;
      const retryable = runResult.exitCode === 9 || (runResult.exitCode === 2 && runResult.timedOut);
      if (!retryable || attempt === maxAttempts) break;
      const delayMs = 30_000 * 2 ** (attempt - 1);
      console.warn(`[executor] folder=${folder.id} transient failure attempt=${attempt}/${maxAttempts}; retry in ${delayMs / 1000}s`);
      try { await client.reportOperation(report(hostId, folder.id, folder.type, "retry", start, { summary: `${folder.type} retry ${attempt + 1}/${maxAttempts} exit=${runResult.exitCode}`, details: { attempt, next: attempt + 1, maxAttempts, delayMs, exitCode: runResult.exitCode, timedOut: runResult.timedOut, stderrTail: runResult.stderrTail } })); } catch { /* ignore */ }
      await Bun.sleep(delayMs);
    }
  } finally {
    exclude?.cleanup();
    if (lanPeer.serveHandle !== null) {
      void lanPeer.serveHandle.close();
    }
  }
  if (!runResult) {
    return report(hostId, folder.id, folder.type, "failed", start, { summary: "executor did not run rclone", details: { attempts } });
  }
  const ok = !runResult.timedOut && runResult.exitCode === 0;
  const status: OperationStatus = ok ? (isRecovery ? "recovery" : "success") : "failed";
  const summary = buildSummary(folder.type, runResult, start, postHookMs, dry);
  return report(hostId, folder.id, folder.type, status, start, { summary, details: { rclone: runResult.stats, exitCode: runResult.exitCode, timedOut: runResult.timedOut, stderrTail: runResult.stderrTail, durationMs: runResult.durationMs, attempts, isRecovery, wouldCopy: runResult.wouldCopy, wouldDelete: runResult.wouldDelete, wouldMkdir: runResult.wouldMkdir, lanPeer: lanPeer.detail } });
}

// ---------------------------------------------------------------------------
// rclone runner
// ---------------------------------------------------------------------------
async function runCommand(command: string[], timeoutSec: number): Promise<CommandResult> {
  const t0 = Date.now();
  const proc = Bun.spawn(["rclone", ...command], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, timeoutSec * 1000);
  const stats: TransferStats = { files: 0, bytes: 0, errors: 0, checks: 0, transfers: 0 };
  const wouldCopy: string[] = [], wouldDelete: string[] = [], wouldMkdir: string[] = [];
  const parse = (line: string): void => {
    if (!line.startsWith("{")) return;
    try {
      const obj = JSON.parse(line);
      const s = obj.stats;
      if (s) {
        if (typeof s.bytes === "number") stats.bytes = s.bytes;
        if (typeof s.errors === "number") stats.errors = s.errors;
        if (typeof s.checks === "number") stats.checks = s.checks;
        if (typeof s.transfers === "number") stats.transfers = s.transfers;
      }
      const msg = obj.msg;
      if (msg === "Copied (new)" || msg === "Copied (server-side copy)") stats.files += 1;
      if (msg === "Would copy" && typeof obj.object === "string") wouldCopy.push(obj.object);
      if (msg === "Would delete" && typeof obj.object === "string") wouldDelete.push(obj.object);
      if (msg === "Would make directory" && typeof obj.object === "string") wouldMkdir.push(obj.object);
    } catch {}
  };
  const rdr = (async () => { const t = await new Response(proc.stdout).text(); t.split(/\r?\n/).forEach(parse); return t; })();
  const stderrText = await new Response(proc.stderr).text();
  const stdoutText = await rdr;
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { exitCode, timedOut, stats, stdoutTail: tail(stdoutText, 2000), stderrTail: tail(stderrText, 2000), durationMs: Date.now() - t0, wouldCopy, wouldDelete, wouldMkdir };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function tail(s: string, max: number): string { return s.length <= max ? s : s.slice(s.length - max); }
function hasBisyncCorruption(stderr: string): boolean { const n = stderr.toLowerCase(); return BISYNC_CORRUPTION_MARKERS.some((m) => n.includes(m)); }
function archiveBisyncState(stateDir: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const corrupted = `${stateDir}.corrupted.${ts}`;
  renameSync(stateDir, corrupted);
  const p = dirname(stateDir); const prefix = `${basename(stateDir)}.corrupted.`;
  const backups = readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith(prefix)).map((e) => join(p, e.name)).sort((a, b) => basename(b).localeCompare(basename(a)));
  for (const old of backups.slice(5)) rmSync(old, { recursive: true, force: true });
  return corrupted;
}
function buildSummary(type: FolderType, r: CommandResult, t0: number, postMs: number, dry?: boolean): string {
  const total = Date.now() - t0;
  if (dry) { const p: string[] = []; if (r.wouldCopy.length) p.push(`${r.wouldCopy.length} would-copy`); if (r.wouldDelete.length) p.push(`${r.wouldDelete.length} would-delete`); if (r.wouldMkdir.length) p.push(`${r.wouldMkdir.length} would-mkdir`); return `dry-run: ${p.length ? p.join(", ") : "0 changes"}`; }
  if (r.timedOut) return `${type} timed out after ${Math.round(r.durationMs / 1000)}s`;
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
async function runDotfileUpload(opts: ExecuteOptions, hostConfig: HostConfig, start: number): Promise<OperationReport> {
  const { assignment, folder, hostId, configPath } = opts;
  const manifest = hostConfig.manifests.find((m) => m.appName === folder.name);
  if (!manifest || manifest.paths.length === 0) return report(hostId, folder.id, folder.type, "failed", start, { summary: "no dotfile manifest", details: { folderName: folder.name } });
  const tmpDir = join(tmpdir(), `lamasync-dotfile-${process.pid}-${start}`);
  mkdirSync(tmpDir, { recursive: true });
  const tarball = join(tmpDir, `${start}.tar.gz`);
  const byParent = new Map<string, string[]>();
  for (const path of manifest.paths) {
    const p = dirname(path);
    const n = byParent.get(p); if (n) n.push(basename(path)); else byParent.set(p, [basename(path)]);
  }
  for (const p of manifest.paths) { if (!existsSync(p)) return report(hostId, folder.id, folder.type, "failed", start, { summary: `dotfile path missing: ${p}`, details: { missing: p } }); }
  const inputs = Array.from(byParent, ([pp, bn]) => ["-C", pp, ...bn]).flat();
  const tar = Bun.spawn(["tar", "czf", tarball, ...inputs], { stdout: "pipe", stderr: "pipe" });
  const tarStderr = await new Response(tar.stderr).text();
  if (await tar.exited !== 0) return report(hostId, folder.id, folder.type, "failed", start, { summary: `tar failed (exit ${await tar.exited})`, details: { tarStderr: tail(tarStderr, 1000) } });
  const size = existsSync(tarball) ? statSync(tarball).size : 0;
  const remote = `${getRemoteName(assignment.remoteName, folder.id)}:${folder.name}/${start}.tar.gz`;
  const rclone = Bun.spawn(["rclone", "copyto", tarball, remote, "--config", configPath, "--use-json-log", "-v"], { stdout: "pipe", stderr: "pipe" });
  const rcloneStderr = await new Response(rclone.stderr).text();
  const rcloneExit = await rclone.exited;
  const status: OperationStatus = rcloneExit === 0 ? "success" : "failed";
  return report(hostId, folder.id, folder.type, status, start, { summary: rcloneExit === 0 ? `dotfile ok: ${manifest.paths.length} paths, ${formatBytes(size)} uploaded` : `dotfile upload failed (exit ${rcloneExit})`, details: { tarball, sizeBytes: size, paths: manifest.paths, rcloneExit, stderrTail: tail(rcloneStderr, 1000) } });
}

// ---------------------------------------------------------------------------
// Git folder type (LAMA-120)
// ---------------------------------------------------------------------------
async function runGit(opts: ExecuteOptions, start: number): Promise<OperationReport> {
  const { assignment, folder, hostId } = opts;
  const lp = assignment.localPath;
  if (!existsSync(join(lp, ".git"))) return report(hostId, folder.id, folder.type, "failed", start, { summary: "no git repository", details: { reason: "no-git" } });
  if (!Bun.which("git")) return report(hostId, folder.id, folder.type, "failed", start, { summary: "git not found", details: { reason: "git-missing" } });
  const dirty = Bun.spawnSync(["git", "-C", lp, "status", "--porcelain"]);
  if (dirty.stdout.length > 0) { const files = new TextDecoder().decode(dirty.stdout).split("\n").filter(Boolean); return report(hostId, folder.id, folder.type, "failed", start, { summary: "dirty worktree, sync skipped", details: { reason: "dirty", dirtyFiles: files } }); }
  const remotes = new TextDecoder().decode(Bun.spawnSync(["git", "-C", lp, "remote"]).stdout).split("\n").filter(Boolean);
  if (!remotes.includes("origin")) return report(hostId, folder.id, folder.type, "failed", start, { summary: "no origin remote", details: { reason: "no-remote" } });
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
