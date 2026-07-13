import {
  mkdirSync,
  statSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import type { MountEntry, CacheProfile } from "@lamasync/core";

const HEALTH_CHECK_INTERVAL_MS = 60_000;
const MOUNT_WAIT_TIMEOUT_MS = 30_000;
const MOUNT_POLL_INTERVAL_MS = 500;

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

interface InternalMount extends MountEntry {
  remotePath: string;
  configPath: string;
  restartTimer: ReturnType<typeof setTimeout> | null;
  proc: Bun.Subprocess | null;
  stoppedByUs: boolean;
}

const internals = new Map<string, InternalMount>();

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

function isFuseMounted(mountPath: string): boolean {
  try {
    const st = statSync(mountPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

function waitForMount(mountPath: string, timeoutMs: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const deadline = Date.now() + timeoutMs;
  const tick = (): void => {
    if (isFuseMounted(mountPath)) {
      resolve(true);
      return;
    }
    if (Date.now() >= deadline) {
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

function buildRcloneArgs(opts: {
  remotePath: string;
  mountPath: string;
  configPath: string;
  cacheProfile: CacheProfile;
  cacheMaxSize: string;
  cacheDir: string;
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
    "--allow-other",
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

export async function startMount(opts: {
  folderId: string;
  remotePath: string;
  mountPath: string;
  configPath: string;
  cacheProfile?: CacheProfile;
  cacheMaxSize?: string;
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

  mkdirSync(opts.mountPath, { recursive: true });
  const cacheDir = getCacheDir(opts.folderId);
  mkdirSync(cacheDir, { recursive: true });

  // The caller already owns the rclone config file (typically a temp path
  // written by writeRcloneConfig in the daemon's hot path); we just consume it.
  const configPath = opts.configPath;

  const args = buildRcloneArgs({
    remotePath: opts.remotePath,
    mountPath: opts.mountPath,
    configPath,
    cacheProfile,
    cacheMaxSize,
    cacheDir,
  });

  const proc = Bun.spawn(["rclone", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

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

  const ready = await waitForMount(opts.mountPath, MOUNT_WAIT_TIMEOUT_MS);
  if (!ready) {
    setStatus(opts.folderId, "dead");
    try {
      proc.kill();
    } catch {
      // already exited
    }
    removePidFile(opts.folderId);
    mounts.delete(opts.folderId);
    internals.delete(opts.folderId);
    throw new Error(
      `mount for folder=${opts.folderId} did not become ready within ${MOUNT_WAIT_TIMEOUT_MS}ms`,
    );
  }

  setStatus(opts.folderId, "mounted");
  console.log(
    `[mount] folder=${opts.folderId} pid=${proc.pid} path=${opts.mountPath} profile=${cacheProfile}`,
  );
  // Lifecycle watcher: when rclone exits, mark dead and restart (unless we
  // intentionally stopped it via stopMount).
  void proc.exited.then((exitCode) => {
    const internal = internals.get(opts.folderId);
    if (!internal) return;
    if (internal.stoppedByUs) return;
    console.error(
      `[mount] folder=${opts.folderId} pid=${proc.pid} exited code=${exitCode}`,
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