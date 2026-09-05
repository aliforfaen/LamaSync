import {
  mkdirSync,
  statSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import type { MountEntry, CacheProfile } from "@lamasync/core";

const HEALTH_CHECK_INTERVAL_MS = 60_000;
const MOUNT_WAIT_TIMEOUT_MS = 30_000;
const MOUNT_POLL_INTERVAL_MS = 500;

// LAMA-320: bounded per-folder rclone stderr tail kept for diagnostics.
const STDERR_TAIL_MAX_BYTES = 8 * 1024;
const DEFAULT_MOUNTINFO_PATH = "/proc/self/mountinfo";
const DEFAULT_FUSE_CONF_PATH = "/etc/fuse.conf";

// Restart backoff: 1min, 5min, 15min, then give up.
const RESTART_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
const MAX_RESTART_ATTEMPTS = RESTART_DELAYS_MS.length;

const CACHE_PROFILE_DEFAULTS: Record<
  CacheProfile,
  { mode: string; maxAge: string; maxSize: string }
> = {
  normal: { mode: "full", maxAge: "24h", maxSize: "1G" },
  media: { mode: "writes", maxAge: "1h", maxSize: "10G" },
  minimal: { mode: "minimal", maxAge: "5m", maxSize: "256M" },
};

const mounts = new Map<string, MountEntry>();

export interface InternalMount extends MountEntry {
  remotePath: string;
  configPath: string;
  restartTimer: ReturnType<typeof setTimeout> | null;
  proc: Bun.Subprocess | null;
  stoppedByUs: boolean;
  restartCount: number;
}

const internals = new Map<string, InternalMount>();

/**
 * Bounded stderr accumulator used for mount diagnostics (LAMA-320). Raw pipe
 * chunks are appended and the buffer is trimmed from the front on line
 * boundaries, so the retained text never exceeds `maxBytes` and starts at a
 * line beginning whenever the dropped prefix ends mid-line.
 */
export interface StderrTail {
  push(chunk: string): void;
  text(): string;
}

export function createStderrTail(
  maxBytes: number = STDERR_TAIL_MAX_BYTES,
): StderrTail {
  let buffer = "";
  return {
    push(chunk: string): void {
      if (chunk.length === 0) return;
      buffer += chunk;
      if (buffer.length <= maxBytes) return;
      const overflowAt = buffer.length - maxBytes;
      const nextLineBreak = buffer.indexOf("\n", overflowAt);
      buffer =
        nextLineBreak === -1
          ? buffer.slice(overflowAt)
          : buffer.slice(nextLineBreak + 1);
    },
    text(): string {
      return buffer;
    },
  };
}

// Per-folder rclone stderr tail (LAMA-320); cleared when a mount entry is
// removed (stopMount / dead-start cleanup / re-registration of a live mount).
const recentStderr = new Map<string, StderrTail>();

/** Recent rclone stderr for `folderId` (bounded tail, last 8 KiB), or null. */
export function getRecentMountStderr(folderId: string): string | null {
  return recentStderr.get(folderId)?.text() ?? null;
}

/**
 * Drain a child pipe, forwarding decoded chunks to `onText`. Never rejects:
 * once the process dies (or the pipe is closed under us) it settles quietly.
 */
async function drainStream(
  stream: ReadableStream<Uint8Array> | null,
  onText: (chunk: string) => void,
): Promise<void> {
  if (stream === null) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && value.byteLength > 0) {
        onText(decoder.decode(value, { stream: true }));
      }
    }
    onText(decoder.decode());
  } catch {
    // Pipe closed while reading (process killed); drop whatever is left.
  }
}

/** Decode the octal escapes used by /proc/self/mountinfo (\040, \011, \012, \134, …). */
function unescapeMountinfo(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, oct: string) =>
    String.fromCharCode(Number.parseInt(oct, 8)),
  );
}

function getPidDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return `/run/user/${uid}/lamasync/mounts`;
}

function getPidFilePath(folderId: string): string {
  return join(getPidDir(), `${folderId}.pid`);
}

function getCacheDir(folderId: string): string {
  return join(homedir(), ".cache", "lamasync", "vfs", folderId);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * True iff `mountPath` is currently the mount point of a live FUSE
 * filesystem. Parses mountinfo directly (no shell-outs): a path only counts
 * when it appears as the mount point (field after `major:minor`) of a line
 * whose filesystem type — the field right after the `-` separator that ends
 * the optional tag:value group — starts with `fuse` (fuse, fuse.rclone,
 * fuse.sshfs, …). Octal-escaped mount points (`\040` = space, …) are
 * decoded. Fails closed: missing/unreadable mountinfo or a non-existent path
 * → false. `mountinfoPath` is injectable for tests.
 */
export function isFuseMounted(
  mountPath: string,
  mountinfoPath: string = DEFAULT_MOUNTINFO_PATH,
): boolean {
  let content: string;
  try {
    content = readFileSync(mountinfoPath, "utf8");
  } catch {
    return false; // missing/unreadable mountinfo — fail closed
  }

  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(mountPath);
  } catch {
    return false; // non-existent (or unresolvable) path cannot be mounted
  }

  for (const line of content.split("\n")) {
    if (line.length === 0) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 2) continue;
    // mountinfo(5): id parent major:minor root mountpoint mount-options
    // [optional tag:value fields…] - filesystem-type mount-source [super-options]
    const sepIdx = fields.indexOf("-");
    if (sepIdx < 5 || sepIdx + 1 >= fields.length) continue;
    const fsType = fields[sepIdx + 1]!;
    if (!fsType.startsWith("fuse")) continue;
    const mountPoint = unescapeMountinfo(fields[4]!);
    if (mountPoint === resolvedPath || mountPoint === mountPath) return true;
  }
  return false;
}

function waitForMount(
  mountPath: string,
  timeoutMs: number,
  shouldAbort: () => boolean = () => false,
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const deadline = Date.now() + timeoutMs;
  const tick = (): void => {
    if (isFuseMounted(mountPath)) {
      resolve(true);
      return;
    }
    if (Date.now() >= deadline || shouldAbort()) {
      resolve(false);
      return;
    }
    setTimeout(tick, MOUNT_POLL_INTERVAL_MS);
  };
  tick();
  return promise;
}

function unmountForce(mountPath: string): Promise<void> {
  const proc = Bun.spawn(["fusermount", "-u", mountPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exited.then(() => undefined);
}

/**
 * True iff the FUSE conf enables `user_allow_other`: any non-comment line
 * (content after the first `#` stripped, whitespace-trimmed) equals
 * `user_allow_other`. Missing/unreadable conf → false (fail closed).
 */
export function isUserAllowOtherEnabled(
  fuseConfPath: string = DEFAULT_FUSE_CONF_PATH,
): boolean {
  let content: string;
  try {
    content = readFileSync(fuseConfPath, "utf8");
  } catch {
    return false;
  }
  for (const line of content.split(/\r?\n/)) {
    const stripped = line.replace(/#.*/, "").trim();
    if (stripped === "user_allow_other") return true;
  }
  return false;
}

export function buildRcloneArgs(opts: {
  remotePath: string;
  mountPath: string;
  configPath: string;
  cacheProfile: CacheProfile;
  cacheMaxSize: string;
  cacheDir: string;
  allowOther: boolean;
}): string[] {
  const profile = CACHE_PROFILE_DEFAULTS[opts.cacheProfile];
  return [
    "mount",
    opts.remotePath,
    opts.mountPath,
    "--config",
    opts.configPath,
    "--vfs-cache-mode",
    profile.mode,
    "--vfs-cache-max-age",
    profile.maxAge,
    "--vfs-cache-max-size",
    opts.cacheMaxSize,
    "--cache-dir",
    opts.cacheDir,
    // LAMA-320: --allow-other only when user_allow_other is enabled in
    // /etc/fuse.conf; otherwise libfuse refuses the mount for non-root users.
    ...(opts.allowOther ? ["--allow-other"] : []),
    "--attr-timeout",
    "10s",
    "--dir-cache-time",
    "1m",
    "--poll-interval",
    "1m",
  ];
}

function writePidFile(folderId: string, pid: number): void {
  mkdirSync(getPidDir(), { recursive: true });
  writeFileSync(getPidFilePath(folderId), String(pid), { mode: 0o644 });
}

function removePidFile(folderId: string): void {
  try {
    unlinkSync(getPidFilePath(folderId));
  } catch {
    // best-effort
  }
}

function setStatus(folderId: string, status: MountEntry["status"]): void {
  const entry = mounts.get(folderId);
  if (entry) entry.status = status;
  const internal = internals.get(folderId);
  if (internal) internal.status = status;
}

function scheduleRestart(folderId: string): void {
  const internal = internals.get(folderId);
  if (!internal) return;
  if (internal.restartCount >= MAX_RESTART_ATTEMPTS) {
    console.error(
      `[mount] folder=${folderId} exceeded ${MAX_RESTART_ATTEMPTS} restarts; giving up`,
    );
    setStatus(folderId, "dead");
    return;
  }
  const delay = RESTART_DELAYS_MS[internal.restartCount]!;
  internal.restartCount += 1;
  console.warn(
    `[mount] folder=${folderId} scheduling restart attempt=${internal.restartCount} in ${delay}ms`,
  );
  internal.restartTimer = setTimeout(() => {
    void attemptRestart(folderId);
  }, delay);
}

async function attemptRestart(folderId: string): Promise<void> {
  const internal = internals.get(folderId);
  if (!internal) return;
  try {
    await startMount({
      folderId: internal.folderId,
      remotePath: internal.remotePath,
      mountPath: internal.path,
      configPath: internal.configPath,
      cacheProfile: internal.cacheProfile,
      cacheMaxSize: CACHE_PROFILE_DEFAULTS[internal.cacheProfile].maxSize,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mount] folder=${folderId} restart failed: ${msg}`);
    scheduleRestart(folderId);
  }
}
export function getMountStatus(folderId: string): MountEntry | null {
  return mounts.get(folderId) ?? null;
}

export function listMounts(): MountEntry[] {
  return Array.from(mounts.values());
}

export function getInternalMount(folderId: string): InternalMount | null {
  return internals.get(folderId) ?? null;
}

/**
 * Register a mount that was started externally (currently by a systemd user
 * unit launched via `--mount <folderId>`) into the daemon's mounts map. If
 * the recorded PID is dead or the mount path isn't FUSE-mounted, returns
 * `null` so the caller can fall back to starting the mount in-process.
 */
export function adoptMount(
  folderId: string,
  opts: {
    mountPath: string;
    cacheProfile: CacheProfile;
    remotePath: string;
    configPath: string;
  },
): MountEntry | null {
  const pid = readPidFile(getPidFilePath(folderId));
  if (pid === null || !isProcessAlive(pid)) return null;
  if (!isFuseMounted(opts.mountPath)) return null;

  // The adopted process supersedes whatever produced a previous stderr tail.
  recentStderr.delete(folderId);

  const entry: MountEntry = {
    folderId,
    pid,
    path: opts.mountPath,
    cacheDir: getCacheDir(folderId),
    startedAt: Date.now(),
    status: "mounted",
    restartCount: 0,
    cacheProfile: opts.cacheProfile,
  };
  mounts.set(folderId, entry);
  internals.set(folderId, {
    ...entry,
    remotePath: opts.remotePath,
    configPath: opts.configPath,
    restartTimer: null,
    proc: null,
    stoppedByUs: false,
  });
  return mounts.get(folderId)!;
}

export async function startMount(opts: {
  folderId: string;
  remotePath: string;
  mountPath: string;
  configPath: string;
  cacheProfile?: CacheProfile;
  cacheMaxSize?: string;
  /** rclone binary to spawn (default: `rclone` resolved from PATH). Injectable for tests. */
  rcloneBin?: string;
}): Promise<MountEntry> {
  const cacheProfile: CacheProfile = opts.cacheProfile ?? "normal";
  const profileDefaults = CACHE_PROFILE_DEFAULTS[cacheProfile];
  const cacheMaxSize = opts.cacheMaxSize ?? profileDefaults.maxSize;

  // Already tracked: return the live entry as-is.
  const existing = mounts.get(opts.folderId);
  if (existing && existing.status !== "dead") {
    return existing;
  }

  // Stale mount detection: if the mount point is FUSE-mounted but the recorded
  // PID is dead (or unreadable), force-unmount before continuing.
  if (isFuseMounted(opts.mountPath)) {
    const stalePid = readPidFile(getPidFilePath(opts.folderId));
    if (stalePid === null || !isProcessAlive(stalePid)) {
      console.warn(
        `[mount] folder=${opts.folderId} stale FUSE mount detected; force-unmounting`,
      );
      await unmountForce(opts.mountPath);
    } else {
      // Live mount from a previous session — re-register it.
      recentStderr.delete(opts.folderId);
      const entry: MountEntry = {
        folderId: opts.folderId,
        pid: stalePid,
        path: opts.mountPath,
        cacheDir: getCacheDir(opts.folderId),
        startedAt: Date.now(),
        status: "mounted",
        restartCount: 0,
        cacheProfile,
      };
      mounts.set(opts.folderId, entry);
      internals.set(opts.folderId, {
        ...entry,
        remotePath: opts.remotePath,
        configPath: opts.configPath,
        restartTimer: null,
        proc: null,
        stoppedByUs: false,
      });
      console.log(
        `[mount] folder=${opts.folderId} re-registered live pid=${stalePid}`,
      );
      return entry;
    }
  }

  // LAMA-309: surface a clear reason when the mount point can't be created
  // (EACCES / EROFS / ENOTDIR …) instead of a bare fs error propagating.
  try {
    mkdirSync(opts.mountPath, { recursive: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const message = `local directory ${opts.mountPath} could not be created: ${reason}`;
    throw new Error(message);
  }
  const cacheDir = getCacheDir(opts.folderId);
  mkdirSync(cacheDir, { recursive: true });

  // The caller already owns the rclone config file (typically a temp path
  // written by writeRcloneConfig in the daemon's hot path); we just consume it.
  const configPath = opts.configPath;

  // LAMA-320: --allow-other is only usable when /etc/fuse.conf enables
  // user_allow_other; otherwise libfuse refuses the mount for non-root users.
  // Pass it only when preflight passes, and say so when it does not.
  const allowOther = isUserAllowOtherEnabled();
  if (!allowOther) {
    console.warn(
      "[mount] user_allow_other not enabled in /etc/fuse.conf; mounting without --allow-other (other users, including root via systemd, may not access this mount)",
    );
  }

  const args = buildRcloneArgs({
    remotePath: opts.remotePath,
    mountPath: opts.mountPath,
    configPath,
    cacheProfile,
    cacheMaxSize,
    cacheDir,
    allowOther,
  });

  const rcloneBin = opts.rcloneBin ?? "rclone";
  const proc = Bun.spawn([rcloneBin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // LAMA-320: consume both pipes so a chatty rclone can never block on a full
  // pipe, and keep a bounded per-folder stderr tail so startup failures
  // surface the real rclone error instead of a bare timeout. Draining keeps
  // running (silently) for the lifetime of the mount.
  const stderrTail = createStderrTail();
  recentStderr.set(opts.folderId, stderrTail);
  const drainOut = drainStream(proc.stdout, () => {});
  const drainErr = drainStream(proc.stderr, (chunk) => stderrTail.push(chunk));

  // Fail fast when rclone dies before the mount becomes ready: the readiness
  // poll aborts as soon as the child has exited.
  let childExitCode: number | null = null;
  void proc.exited.then(
    (code) => {
      childExitCode = code;
    },
    () => {
      // spawn-side failure (e.g. binary missing); leave the timeout to fire
    },
  );

  const startedAt = Date.now();
  const entry: MountEntry = {
    folderId: opts.folderId,
    pid: proc.pid,
    path: opts.mountPath,
    cacheDir,
    startedAt,
    status: "starting",
    restartCount: 0,
    cacheProfile,
  };
  mounts.set(opts.folderId, entry);
  internals.set(opts.folderId, {
    ...entry,
    remotePath: opts.remotePath,
    configPath,
    restartTimer: null,
    proc,
    stoppedByUs: false,
  });
  writePidFile(opts.folderId, proc.pid);

  const ready = await waitForMount(
    opts.mountPath,
    MOUNT_WAIT_TIMEOUT_MS,
    () => childExitCode !== null,
  );
  if (!ready) {
    setStatus(opts.folderId, "dead");
    try {
      proc.kill();
    } catch {
      // already exited
    }
    // Let the pipe drains finish so the stderr tail below is complete (the
    // child is dead, so EOF is imminent; the 2s cap guards a stuck pipe).
    await Promise.race([
      Promise.all([drainOut, drainErr]),
      Bun.sleep(2_000),
    ]);
    const stderrText = stderrTail.text();
    removePidFile(opts.folderId);
    mounts.delete(opts.folderId);
    internals.delete(opts.folderId);
    recentStderr.delete(opts.folderId);
    const failure =
      childExitCode !== null
        ? `rclone exited with code ${childExitCode}`
        : `did not become ready within ${MOUNT_WAIT_TIMEOUT_MS}ms`;
    const details =
      stderrText.length > 0 ? `; rclone stderr (last 8 KiB):\n${stderrText}` : "";
    throw new Error(`mount for folder=${opts.folderId} ${failure}${details}`);
  }

  setStatus(opts.folderId, "mounted");
  console.log(
    `[mount] folder=${opts.folderId} pid=${proc.pid} path=${opts.mountPath} profile=${cacheProfile}`,
  );
  // Lifecycle watcher: when rclone exits, mark dead and restart (unless we
  // intentionally stopped it via stopMount). Surface the retained stderr tail
  // alongside the exit code so unexpected deaths are diagnosable; the drains
  // are awaited (they end at EOF once the child is gone) so the tail is
  // complete before it is logged.
  void proc.exited.then(async (exitCode) => {
    const internal = internals.get(opts.folderId);
    if (!internal) return;
    if (internal.stoppedByUs) return;
    await Promise.race([
      Promise.all([drainOut, drainErr]),
      Bun.sleep(2_000),
    ]);
    const stderrText = recentStderr.get(opts.folderId)?.text() ?? "";
    console.error(
      `[mount] folder=${opts.folderId} pid=${proc.pid} exited code=${exitCode}` +
        (stderrText.length > 0 ? `; rclone stderr (last 8 KiB):\n${stderrText}` : ""),
    );
    setStatus(opts.folderId, "dead");
    scheduleRestart(opts.folderId);
  });

  return mounts.get(opts.folderId)!;
}

export async function stopMount(folderId: string): Promise<void> {
  const internal = internals.get(folderId);
  if (!internal) return;

  if (internal.restartTimer !== null) {
    clearTimeout(internal.restartTimer);
    internal.restartTimer = null;
  }

  setStatus(folderId, "unmounting");
  internal.stoppedByUs = true;

  if (internal.proc !== null && isProcessAlive(internal.pid)) {
    try {
      internal.proc.kill();
    } catch {
      // already exited
    }
    await Promise.race([
      internal.proc.exited,
      new Promise<void>((r) => setTimeout(r, 5_000)),
    ]);
  }

  await unmountForce(internal.path).catch(() => {
    // best-effort; the kernel may have already cleaned up
  });

  mounts.delete(folderId);
  internals.delete(folderId);
  recentStderr.delete(folderId);
  removePidFile(folderId);
}

export async function stopAllMounts(): Promise<void> {
  const ids = Array.from(mounts.keys());
  for (const id of ids) {
    await stopMount(id);
  }
}

export function startMountHealthChecks(
  onMountDied?: (folderId: string) => void,
): void {
  const timer = setInterval(() => {
    for (const entry of mounts.values()) {
      if (entry.status !== "mounted") continue;
      try {
        statSync(entry.path);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOTCONN" || code === "ENODEV" || code === "ENOENT") {
          console.error(
            `[mount] health-check folder=${entry.folderId} dead (${code})`,
          );
          entry.status = "dead";
          const internal = internals.get(entry.folderId);
          if (internal) internal.status = "dead";
          onMountDied?.(entry.folderId);
        }
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);
  timer.unref?.();
}