/**
 * Result of running a user-supplied pre/post hook command.
 */
export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface HookContext {
  folderId: string;
  localPath: string;
  op: "pre" | "post";
}

const DEFAULT_HOOK_TIMEOUT_MS = 300_000;

/**
 * Run a user-supplied shell command and capture its output. Empty/null commands
 * are treated as a no-op success — this keeps the executor simple when a host
 * config simply has no pre/post hook configured.
 */
export async function runHook(
  cmd: string | null | undefined,
  ctx: HookContext,
  timeoutMs: number = DEFAULT_HOOK_TIMEOUT_MS,
): Promise<HookResult> {
  if (!cmd || cmd.trim().length === 0) {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false };
  }
  const start = Date.now();
  const proc = Bun.spawn(["sh", "-c", cmd], {
    cwd: ctx.localPath,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      LAMASYNC_FOLDER_ID: ctx.folderId,
      LAMASYNC_LOCAL_PATH: ctx.localPath,
      LAMASYNC_HOOK_PHASE: ctx.op,
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - start,
    timedOut,
  };
}