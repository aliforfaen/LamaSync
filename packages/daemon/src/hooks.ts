/**
 * Result of running a user-supplied pre/post hook command.
 */
export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface HookContext {
  folderId: string;
  localPath: string;
  op: "pre" | "post";
}

/**
 * Run a user-supplied shell command and capture its output. Empty/null commands
 * are treated as a no-op success — this keeps the executor simple when a host
 * config simply has no pre/post hook configured.
 */
export async function runHook(
  cmd: string | null | undefined,
  ctx: HookContext,
): Promise<HookResult> {
  if (!cmd || cmd.trim().length === 0) {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
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
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - start,
  };
}