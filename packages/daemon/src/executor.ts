import { dirname, join } from "path";
import { mkdirSync, statSync, existsSync } from "fs";
import { tmpdir } from "os";
import type {
  Folder,
  FolderAssignment,
  FolderType,
  HostConfig,
  LamaSyncApiClient,
  OperationReport,
  OperationStatus,
} from "@lamasync/core";
import { runHook } from "./hooks.ts";
import { loadIgnorePatterns, writeExcludeFile } from "./ignore.ts";
import { getRemoteName } from "./rclone.ts";

export interface ExecuteOptions {
  assignment: FolderAssignment;
  folder: Folder;
  hostConfig: HostConfig;
  client: LamaSyncApiClient;
  hostId: string;
  configPath: string;
}

interface TransferStats {
  files: number;
  bytes: number;
  errors: number;
  checks: number;
  transfers: number;
}

const DEFAULT_TIMEOUT_SEC = 600;
const MOUNT_TIMEOUT_SEC = 30;

/**
 * One rclone run, end to end: pre-hook → rclone → post-hook → report.
 *
 * The dispatch table is intentionally small; new folder types only need a new
 * branch. The common plumbing (timeout, stats parsing, exclude file) lives
 * inside `runCommand`.
 */
export async function executeAssignment(
  opts: ExecuteOptions,
): Promise<OperationReport> {
  const { assignment, folder, hostConfig, hostId } = opts;
  const start = Date.now();

  // Fail fast when rclone isn't installed: type-checking must not require it,
  // and a missing binary is far more likely on a fresh box than a broken config.
  if (!Bun.which("rclone")) {
    return report(hostId, folder.id, folder.type, "failed", start, {
      summary: "rclone binary not found in PATH",
      details: { reason: "rclone-missing" },
    });
  }

  const remoteName = getRemoteName(assignment.remoteName, folder.id);
  const remotePath = `${remoteName}:${folder.name}`;
  const patterns = loadIgnorePatterns(assignment.ignorePath, assignment.localPath);
  const exclude = patterns.length > 0 ? writeExcludeFile(patterns) : null;

  // Pre-hook. A non-zero exit aborts the run before we touch rclone.
  if (assignment.preSyncCmd) {
    const hook = await runHook(assignment.preSyncCmd, {
      folderId: folder.id,
      localPath: assignment.localPath,
      op: "pre",
    });
    if (hook.exitCode !== 0) {
      exclude?.cleanup();
      return report(hostId, folder.id, folder.type, "failed", start, {
        summary: `pre-hook failed (exit ${hook.exitCode})`,
        details: {
          phase: "pre-hook",
          exitCode: hook.exitCode,
          stderr: hook.stderr,
          stdout: hook.stdout,
          durationMs: hook.durationMs,
        },
      });
    }
  }

  // Conflict strategy gates some folder types outright.
  if (folder.type === "sync") {
    if (assignment.conflictStrategy === "manual") {
      exclude?.cleanup();
      return report(hostId, folder.id, folder.type, "conflict", start, {
        summary: "manual strategy requires UI resolution; not supported by executor",
        details: { conflictStrategy: "manual" },
      });
    }
    if (assignment.conflictStrategy === "keep_both") {
      // TODO: implement two-way sync with backup-dir when the protocol is settled.
      console.warn(
        `[executor] folder=${folder.id} conflictStrategy=keep_both: ` +
          `falling back to default bisync; backup-dir support is pending`,
      );
    }
  }

  let command: string[];
  let timeoutSec: number;

  switch (folder.type) {
    case "sync":
      command = [
        "bisync",
        remotePath,
        assignment.localPath,
        "--config",
        opts.configPath,
        "--use-json-log",
        "-v",
        "--resync",
      ];
      timeoutSec = assignment.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
      break;
    case "mount":
      // Long-running; we run with a short timeout and report it as not-yet-supported.
      command = [
        "mount",
        remotePath,
        assignment.localPath,
        "--config",
        opts.configPath,
        "--daemon",
      ];
      timeoutSec = MOUNT_TIMEOUT_SEC;
      break;
    case "backup":
      command = [
        "copy",
        assignment.localPath,
        remotePath,
        "--config",
        opts.configPath,
        "--use-json-log",
        "-v",
      ];
      timeoutSec = assignment.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
      break;
    case "dotfile":
      // Implemented separately because it bundles a tarball upload.
      exclude?.cleanup();
      return await runDotfileUpload(opts, hostConfig, start);
    default:
      exclude?.cleanup();
      return report(hostId, folder.id, folder.type as FolderType, "failed", start, {
        summary: `unsupported folder type: ${folder.type}`,
        details: { folderType: folder.type },
      });
  }

  if (exclude) {
    command.push("--exclude-from", exclude.path);
  }

  let runResult: CommandResult;
  try {
    runResult = await runCommand(command, timeoutSec);
  } catch (err) {
    exclude?.cleanup();
    return report(hostId, folder.id, folder.type, "failed", start, {
      summary: `executor error: ${err instanceof Error ? err.message : String(err)}`,
      details: { error: String(err) },
    });
  } finally {
    exclude?.cleanup();
  }

  // Post-hook: only on a successful rclone run; failures should propagate first.
  let postHookMs = 0;
  if (assignment.postSyncCmd && runResult.exitCode === 0) {
    const hook = await runHook(assignment.postSyncCmd, {
      folderId: folder.id,
      localPath: assignment.localPath,
      op: "post",
    });
    postHookMs = hook.durationMs;
    if (hook.exitCode !== 0) {
      return report(hostId, folder.id, folder.type, "failed", start, {
        summary: `post-hook failed (exit ${hook.exitCode})`,
        details: {
          phase: "post-hook",
          exitCode: hook.exitCode,
          stderr: hook.stderr,
          stdout: hook.stdout,
          durationMs: hook.durationMs,
          rclone: runResult.stats,
        },
      });
    }
  }

  const status = runResult.timedOut
    ? "failed"
    : runResult.exitCode === 0
      ? "success"
      : "failed";
  const summary = buildSummary(folder.type, runResult, start, postHookMs);

  return report(hostId, folder.id, folder.type, status, start, {
    summary,
    details: {
      rclone: runResult.stats,
      exitCode: runResult.exitCode,
      timedOut: runResult.timedOut,
      stderrTail: runResult.stderrTail,
      durationMs: runResult.durationMs,
    },
  });
}

interface CommandResult {
  exitCode: number;
  timedOut: boolean;
  stats: TransferStats;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
}

/**
 * Spawn rclone with a hard timeout, stream stdout/stderr through a JSON-line
 * parser when `--use-json-log` is on, and return enough context to write a
 * useful report. Timeout is enforced by killing the subprocess and waiting for
 * its exit code (which Bun reports as a signal on POSIX).
 */
async function runCommand(
  command: string[],
  timeoutSec: number,
): Promise<CommandResult> {
  const start = Date.now();
  const proc = Bun.spawn(["rclone", ...command], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, timeoutSec * 1000);

  const stats: TransferStats = {
    files: 0,
    bytes: 0,
    errors: 0,
    checks: 0,
    transfers: 0,
  };

  const parseOne = (line: string): void => {
    if (!line.startsWith("{")) return;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const stats_ = obj.stats as Record<string, unknown> | undefined;
      if (stats_) {
        if (typeof stats_.bytes === "number") stats.bytes = stats_.bytes;
        if (typeof stats_.errors === "number") stats.errors = stats_.errors;
        if (typeof stats_.checks === "number") stats.checks = stats_.checks;
        if (typeof stats_.transfers === "number")
          stats.transfers = stats_.transfers;
      }
      const msg = obj.msg as string | undefined;
      if (msg === "Copied (new)" || msg === "Copied (server-side copy)") {
        stats.files += 1;
      }
    } catch {
      // not JSON; ignore
    }
  };

  // Drain stdout line-by-line to feed the stats parser while rclone runs.
  const stdoutReader = (async () => {
    const text = await new Response(proc.stdout).text();
    const lines = text.split(/\r?\n/);
    for (const line of lines) parseOne(line);
    return text;
  })();
  const stderrText = await new Response(proc.stderr).text();
  const stdoutText = await stdoutReader;

  const exitCode = await proc.exited;
  clearTimeout(timer);

  return {
    exitCode,
    timedOut,
    stats,
    stdoutTail: tail(stdoutText, 2000),
    stderrTail: tail(stderrText, 2000),
    durationMs: Date.now() - start,
  };
}

function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

function buildSummary(
  type: FolderType,
  r: CommandResult,
  start: number,
  postHookMs: number,
): string {
  const totalMs = Date.now() - start;
  if (r.timedOut) {
    return `${type} timed out after ${Math.round(r.durationMs / 1000)}s`;
  }
  if (r.exitCode !== 0) {
    return `${type} failed (exit ${r.exitCode}) in ${Math.round(totalMs / 1000)}s`;
  }
  const t = r.stats.transfers;
  const b = r.stats.bytes;
  const sizeStr = formatBytes(b);
  const hookStr = postHookMs ? `, post-hook ${postHookMs}ms` : "";
  return `${type} ok: ${t} transfers, ${sizeStr} in ${Math.round(totalMs / 1000)}s${hookStr}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

interface ReportInput {
  summary: string;
  details: Record<string, unknown>;
}

function report(
  hostId: string,
  folderId: string,
  operation: FolderType,
  status: OperationStatus,
  start: number,
  body: ReportInput,
): OperationReport {
  return {
    hostId,
    folderId,
    operation,
    status,
    summary: body.summary,
    details: JSON.stringify(body.details),
    durationMs: Date.now() - start,
  };
}

/**
 * Dotfile folders don't sync a directory; they package declared paths into a
 * timestamped tarball and ship it to the remote under the folder's name.
 */
async function runDotfileUpload(
  opts: ExecuteOptions,
  hostConfig: HostConfig,
  start: number,
): Promise<OperationReport> {
  const { assignment, folder, hostId, configPath } = opts;
  const manifest = hostConfig.manifests.find((m) => m.appName === folder.name);
  if (!manifest || manifest.paths.length === 0) {
    return report(hostId, folder.id, folder.type, "failed", start, {
      summary: "no dotfile manifest for folder",
      details: { folderName: folder.name },
    });
  }

  const tmpDir = join(tmpdir(), `lamasync-dotfile-${process.pid}-${start}`);
  mkdirSync(tmpDir, { recursive: true });
  const tarball = join(tmpDir, `${start}.tar.gz`);

  // Tar the first path's parent and pull the basename out of it; rclone tar
  // semantics don't accept disjoint inputs, so we follow the simple convention
  // that dotfile manifests list siblings under one parent.
  const first = manifest.paths[0]!;
  const parent = dirname(first);
  const basenames = manifest.paths
    .map((p) => (p.startsWith(parent + "/") ? p.slice(parent.length + 1) : p))
    .filter(Boolean);

  // Validate every requested source exists up-front; partial tarballs are worse
  // than a clean failure.
  for (const p of manifest.paths) {
    if (!existsSync(p)) {
      return report(hostId, folder.id, folder.type, "failed", start, {
        summary: `dotfile path missing: ${p}`,
        details: { missing: p },
      });
    }
  }

  const tarProc = Bun.spawn(
    [
      "tar",
      "czf",
      tarball,
      "-C",
      parent,
      ...basenames,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const tarStderr = await new Response(tarProc.stderr).text();
  const tarExit = await tarProc.exited;
  if (tarExit !== 0) {
    return report(hostId, folder.id, folder.type, "failed", start, {
      summary: `tar failed (exit ${tarExit})`,
      details: { tarExit, tarStderr: tail(tarStderr, 1000) },
    });
  }

  const size = existsSync(tarball) ? statSync(tarball).size : 0;
  const remote = `${getRemoteName(assignment.remoteName, folder.id)}:${folder.name}/${start}.tar.gz`;
  const rclone = Bun.spawn(
    [
      "rclone",
      "copyto",
      tarball,
      remote,
      "--config",
      configPath,
      "--use-json-log",
      "-v",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const rcloneStderr = await new Response(rclone.stderr).text();
  const rcloneExit = await rclone.exited;

  const status: OperationStatus = rcloneExit === 0 ? "success" : "failed";
  const summary =
    rcloneExit === 0
      ? `dotfile ok: ${manifest.paths.length} paths, ${formatBytes(size)} uploaded`
      : `dotfile upload failed (exit ${rcloneExit})`;

  return report(hostId, folder.id, folder.type, status, start, {
    summary,
    details: {
      tarball,
      sizeBytes: size,
      paths: manifest.paths,
      rcloneExit,
      stderrTail: tail(rcloneStderr, 1000),
    },
  });
}