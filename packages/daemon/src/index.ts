import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from "fs";
import { networkInterfaces } from "os";
import { homedir } from "os";
import { join } from "path";
import type {
  Folder,
  FolderAssignment,
  HostConfig,
  OperationLog,
  OperationReport,
  ResticRestoreJob,
} from "@lamasync/core";
import { LamaSyncApiClient, VERSION } from "@lamasync/core";
import { loadConfig } from "./config.ts";
import { CACHE_PATH, loadCache, saveCache } from "./config-cache.ts";
import { executeAssignment, executeResticRestore } from "./executor.ts";
import { Scheduler } from "./scheduler.ts";
import {
  buildSocketState,
  startSocketServer,
  type SocketState,
} from "./socket.ts";
import { getRemoteName, writeRcloneConfig } from "./rclone.ts";
import {
  acquireLock,
  heartbeatLock,
  releaseLock,
  releaseStaleLocks,
  type LockAcquireResult,
} from "./lock.ts";
import { createReportQueue, type ReportQueue } from "./report-queue.ts";
import {
  adoptMount,
  getInternalMount,
  listMounts,
  startMount,
  startMountHealthChecks,
  stopAllMounts,
  stopMount,
} from "./mounts.ts";
import {
  disableMountUnit,
  isMountUnitActive,
  isSystemdAvailable,
  removeMountUnit,
  startMountUnit,
  stopMountUnit,
  waitForMountUnitActive,
  writeMountUnit,
} from "./systemd.ts";
import { downloadAndReplace, fetchLatestRelease, isNewer } from "./self-update.ts";

const HEARTBEAT_INTERVAL_MS = 30_000;
const CONFIG_REFRESH_MS = 5 * 60 * 1000;
const OPERATIONS_RING_SIZE = 200;

function defaultSocketPath(): string {
  return process.env.LAMASYNC_SOCKET_PATH ?? join(homedir(), "lamasync.sock");
}

export function getLocalLanIp(): string | null {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.internal) continue;
      if (info.family !== "IPv4") continue;
      if (info.address === "127.0.0.1" || info.address === "::1") continue;
      return info.address;
    }
  }
  return null;
}

export interface SwitchContext {
  acquireLock: (folderId: string) => Promise<LockAcquireResult>;
  releaseLock: (folderId: string, status: string, summary?: string) => Promise<void>;
  getHostConfig: () => HostConfig | null;
  runOnce: (assignment: FolderAssignment) => Promise<void>;
  startMount: (opts: {
    folderId: string;
    remotePath: string;
    mountPath: string;
    configPath: string;
    cacheProfile?: "normal" | "media" | "minimal";
    cacheMaxSize?: string;
  }) => Promise<unknown>;
  stopMount: (folderId: string) => Promise<void>;
  getRemoteName: (remoteName: string | null | undefined, folderId: string) => string;
  updateFolderType: (folderId: string, type: "sync" | "mount") => Promise<unknown>;
}

let switchCtx: SwitchContext | null = null;

export function setSwitchContext(ctx: SwitchContext | null): void {
  switchCtx = ctx;
}

function getSwitchCtx(): SwitchContext {
  if (!switchCtx) {
    throw new Error("switch context not initialized");
  }
  return switchCtx;
}

function trashDirFor(folderId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(
    homedir(),
    ".local",
    "share",
    "lamasync",
    "trash",
    `${folderId}_${stamp}`,
  );
}

function listLocalEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function moveContentsToTrash(srcDir: string, trashDir: string): void {
  mkdirSync(trashDir, { recursive: true });
  const entries = listLocalEntries(srcDir);
  for (const entry of entries) {
    renameSync(join(srcDir, entry), join(trashDir, entry));
  }
}

function restoreContentsFromTrash(trashDir: string, destDir: string): void {
  if (!existsSync(trashDir)) return;
  mkdirSync(destDir, { recursive: true });
  const entries = listLocalEntries(trashDir);
  for (const entry of entries) {
    try {
      renameSync(join(trashDir, entry), join(destDir, entry));
    } catch {
      // best-effort
    }
  }
}

function removeTrash(trashDir: string): void {
  if (!existsSync(trashDir)) return;
  try {
    rmSync(trashDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

async function processResticRestoreJobs(
  client: LamaSyncApiClient,
  hostId: string,
  getHostConfig: () => HostConfig | null,
): Promise<void> {
  let jobs: ResticRestoreJob[];
  try {
    jobs = await client.listResticRestoreJobs(hostId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[restic-restore] failed to list jobs: ${msg}`);
    return;
  }
  for (const job of jobs) {
    if (job.status !== "pending") continue;
    const cfg = getHostConfig();
    const assignment = cfg?.assignments.find((a) => a.folderId === job.folderId);
    if (!assignment || !assignment.resticRepository || !assignment.resticPassword) {
      try {
        await client.updateResticRestoreJob(job.id, "failed", "target host lacks restic assignment");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[restic-restore] failed to mark job ${job.id} failed: ${msg}`);
      }
      continue;
    }

    try {
      await client.updateResticRestoreJob(job.id, "running");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[restic-restore] failed to mark job ${job.id} running: ${msg}`);
    }

    const result = await executeResticRestore(assignment, job, assignment.timeoutSec ?? 600);
    try {
      await client.updateResticRestoreJob(job.id, result.ok ? "done" : "failed", result.error);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[restic-restore] failed to ack job ${job.id}: ${msg}`);
    }
    console.log(
      `[restic-restore] job=${job.id} snapshot=${job.snapshotId} target=${job.targetPath} ok=${result.ok}`,
    );
  }
}

export interface SwitchResult {
  ok: boolean;
  error?: string;
  trashDir?: string;
}

export async function switchToMount(folderId: string): Promise<SwitchResult> {
  const ctx = getSwitchCtx();
  const hostConfig = ctx.getHostConfig();
  if (!hostConfig) {
    return { ok: false, error: "no host config loaded" };
  }
  const folder = hostConfig.folders.find((f) => f.id === folderId);
  const assignment = hostConfig.assignments.find((a) => a.folderId === folderId);
  if (!folder || !assignment) {
    return { ok: false, error: `folder=${folderId} not found in host config` };
  }
  if (folder.type !== "sync") {
    return { ok: false, error: `folder=${folderId} type=${folder.type}; expected sync` };
  }

  const lockResult = await ctx.acquireLock(folderId);
  if (!lockResult.ok) {
    const reason =
      lockResult.reason === "contended"
        ? `locked by ${lockResult.lockedBy === assignment.hostId ? "this host" : lockResult.lockedBy}`
        : "server unreachable, lock not acquired";
    return { ok: false, error: `folder=${folderId} ${reason}` };
  }

  const trashDir = trashDirFor(folderId);
  const localPath = assignment.localPath;
  let trashed = false;

  try {
    await ctx.runOnce(assignment);

    if (listLocalEntries(localPath).length > 0) {
      moveContentsToTrash(localPath, trashDir);
      trashed = true;
    }

    const { configPath, cleanup } = writeRcloneConfig(hostConfig.rcloneConfig);
    try {
      await ctx.startMount({
        folderId,
        remotePath: `${ctx.getRemoteName(assignment.remoteName, folderId)}:${folder.name}`,
        mountPath: localPath,
        configPath,
        cacheProfile: assignment.cacheProfile ?? undefined,
        cacheMaxSize: assignment.cacheMaxSize ?? undefined,
      });
    } finally {
      cleanup();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (trashed) {
      restoreContentsFromTrash(trashDir, localPath);
      removeTrash(trashDir);
    }
    await ctx.releaseLock(folderId, "failed", `mount switch failed: ${msg}`);
    return { ok: false, error: `mount failed: ${msg}` };
  }

  const purgeTimer = setTimeout(() => removeTrash(trashDir), 24 * 60 * 60 * 1000);
  purgeTimer.unref?.();

  await ctx.releaseLock(folderId, "success", "switched to mount");

  try {
    await ctx.updateFolderType(folderId, "mount");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: true, trashDir, error: `mount is up but server update failed: ${msg}` };
  }

  return { ok: true, trashDir };
}

export async function switchToSync(folderId: string): Promise<SwitchResult> {
  const ctx = getSwitchCtx();
  const hostConfig = ctx.getHostConfig();
  if (!hostConfig) {
    return { ok: false, error: "no host config loaded" };
  }
  const folder = hostConfig.folders.find((f) => f.id === folderId);
  const assignment = hostConfig.assignments.find((a) => a.folderId === folderId);
  if (!folder || !assignment) {
    return { ok: false, error: `folder=${folderId} not found in host config` };
  }
  if (folder.type !== "mount") {
    return { ok: false, error: `folder=${folderId} type=${folder.type}; expected mount` };
  }

  const lockResult = await ctx.acquireLock(folderId);
  if (!lockResult.ok) {
    const reason =
      lockResult.reason === "contended"
        ? `locked by ${lockResult.lockedBy === assignment.hostId ? "this host" : lockResult.lockedBy}`
        : "server unreachable, lock not acquired";
    return { ok: false, error: `folder=${folderId} ${reason}` };
  }

  try {
    await ctx.stopMount(folderId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.releaseLock(folderId, "failed", `stopMount failed: ${msg}`);
    return { ok: false, error: `stopMount failed: ${msg}` };
  }

  try {
    await ctx.runOnce(assignment);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.releaseLock(folderId, "failed", `initial sync failed: ${msg}`);
    return { ok: false, error: `initial sync failed: ${msg}` };
  }

  await ctx.releaseLock(folderId, "success", "switched to sync");

  try {
    await ctx.updateFolderType(folderId, "sync");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: true, error: `sync is up but server update failed: ${msg}` };
  }

  return { ok: true };
}

/**
 * Bring up a mount via systemd if available; otherwise run the in-process
 * rclone spawn. Returns the result of the underlying mount lifecycle helper
 * so callers (notably switchToMount) can remain backend-agnostic.
 */
async function systemdAwareStartMount(opts: {
  folderId: string;
  remotePath: string;
  mountPath: string;
  configPath: string;
  cacheProfile?: "normal" | "media" | "minimal";
  cacheMaxSize?: string;
}): Promise<unknown> {
  if (!isSystemdAvailable()) {
    return startMount(opts);
  }

  let unitWritten = false;
  try {
    writeMountUnit(opts.folderId);
    unitWritten = true;
    startMountUnit(opts.folderId);
    const active = await waitForMountUnitActive(opts.folderId);
    if (!active) {
      console.warn(
        `[systemd] mount unit for folder=${opts.folderId} did not become active; falling back`,
      );
      return startMount(opts);
    }
    const adopted = adoptMount(opts.folderId, {
      mountPath: opts.mountPath,
      cacheProfile: opts.cacheProfile ?? "normal",
      remotePath: opts.remotePath,
      configPath: opts.configPath,
    });
    if (adopted === null) {
      console.warn(
        `[systemd] could not adopt folder=${opts.folderId}; falling back to in-process`,
      );
      return startMount(opts);
    }
    return adopted;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!unitWritten) {
      console.warn(
        `[systemd] writeMountUnit failed for folder=${opts.folderId} (${msg}); falling back`,
      );
    }
    return startMount(opts);
  }
}

/**
 * Stop a mount that was started by systemd if available; otherwise invoke the
 * in-process stopMount. Best-effort: never throws.
 */
async function systemdAwareStopMount(folderId: string): Promise<void> {
  if (!isSystemdAvailable()) {
    await stopMount(folderId);
    return;
  }
  try {
    disableMountUnit(folderId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[systemd] disable failed for folder=${folderId}: ${msg}`);
  }
  try {
    stopMountUnit(folderId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[systemd] stop failed for folder=${folderId}: ${msg}`);
  }
  removeMountUnit(folderId);
  // The unit may not have populated the in-process registry; clear regardless.
  await stopMount(folderId);
}

/**
 * Boot-time adoption: when the daemon restarts while mounts are still active
 * under their systemd units, register each in the in-process `mounts` map so
 * the scheduler and TUI see them as live.
 */
function adoptExistingMountUnits(getAssignments: () => FolderAssignment[]): void {
  if (!isSystemdAvailable()) return;
  for (const assignment of getAssignments()) {
    if (assignment.role === "source") continue;
    if (listMounts().some((m) => m.folderId === assignment.folderId)) continue;
    if (!isMountUnitActive(assignment.folderId)) continue;
    const adopted = adoptMount(assignment.folderId, {
      mountPath: assignment.localPath,
      cacheProfile: assignment.cacheProfile ?? "normal",
      remotePath: `${getRemoteName(assignment.remoteName, assignment.folderId)}:${assignment.folderId}`,
      configPath: "/dev/null",
    });
    if (adopted) {
      console.log(
        `[boot] adopted existing mount unit for folder=${assignment.folderId}`,
      );
    }
  }
}
async function main(): Promise<void> {

  const clientConfig = loadConfig();
  const hostId = clientConfig.hostname;
  const socketPath = defaultSocketPath();

  console.log(
    `lamasyncd starting host=${hostId} url=${clientConfig.serverUrl} socket=${socketPath}`,
  );

  const client = new LamaSyncApiClient(clientConfig.serverUrl, clientConfig.apiKey);
  const reportQueue = createReportQueue(clientConfig.dataDir, client);

  let hostConfig: HostConfig | null = loadCache();
  const operations: OperationLog[] = [];
  let lastHeartbeatAt = 0;

  const socketState = (): SocketState =>
    buildSocketState(hostId, hostConfig, operations);

  const refreshConfig = async (): Promise<void> => {
    try {
      const cfg = await client.getConfig(hostId);
      hostConfig = cfg;
      saveCache(cfg);
      console.log(
        `[config] refreshed host=${hostId} assignments=${cfg.assignments.length}`,
      );
      scheduler.refresh();
      adoptExistingMountUnits(() => cfg.assignments);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[config] refresh failed: ${msg}`);
    }
  };

  const recordOperation = (report: OperationReport): void => {
    const entry: OperationLog = {
      id: operations.length + 1,
      timestamp: Date.now(),
      hostId: report.hostId,
      folderId: report.folderId ?? null,
      operation: report.operation,
      status: report.status,
      summary: report.summary ?? null,
      details: report.details ?? null,
      durationMs: report.durationMs ?? null,
    };
    operations.push(entry);
    if (operations.length > OPERATIONS_RING_SIZE) {
      operations.splice(0, operations.length - OPERATIONS_RING_SIZE);
    }
  };

  const reportOperation = async (report: OperationReport): Promise<void> => {
    recordOperation(report);
    try {
      await client.reportOperation(report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[report] failed to send to server: ${msg} (queued for retry)`);
      reportQueue.enqueue(report);
    }
  };

  const runOnce = async (assignment: FolderAssignment): Promise<void> => {
    if (!hostConfig) {
      console.warn(`[run] no hostConfig cached; skipping folder=${assignment.folderId}`);
      return;
    }
    const folder: Folder | undefined = hostConfig.folders.find(
      (f) => f.id === assignment.folderId,
    );
    if (!folder) {
      console.warn(`[run] folder=${assignment.folderId} not in cache; refreshing`);
      await refreshConfig();
      return;
    }

    const lockResult = await acquireLock(client, assignment.folderId, hostId);
    if (!lockResult.ok) {
      const summary =
        lockResult.reason === "contended"
          ? `skipped: folder locked by ${lockResult.lockedBy === hostId ? "this host" : lockResult.lockedBy} (${lockResult.remainingSec}s remaining)`
          : "skipped: server unreachable, lock not acquired";
      console.warn(`[run] folder=${folder.name} ${summary}`);
      await reportOperation({
        hostId,
        folderId: folder.id,
        operation: folder.type,
        status: "failed",
        summary,
        durationMs: 0,
      });
      return;
    }
    const lock = lockResult.handle;

    const abortController = new AbortController();
    const heartbeatTimer = setInterval(() => {
      void (async () => {
        const hb = await heartbeatLock(client, assignment.folderId, hostId, lock);
        if (hb === "lost") {
          console.warn(`[run] folder=${folder.name} lock lost; aborting sync`);
          abortController.abort("lock lost");
        }
      })();
    }, 30_000);

    const { configPath, cleanup } = writeRcloneConfig(hostConfig.rcloneConfig);
    try {
      const report = await executeAssignment({
        assignment,
        folder,
        hostConfig,
        client,
        hostId,
        configPath,
        signal: abortController.signal,
      });
      console.log(
        `[run] folder=${folder.name} type=${folder.type} status=${report.status} summary=${report.summary ?? ""}`,
      );
      await releaseLock(
        client,
        folder.id,
        hostId,
        report.status,
        report.summary ?? undefined,
        lock,
      );
      await reportOperation(report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[run] executor threw: ${msg}`);
      await releaseLock(client, folder.id, hostId, "failed", msg, lock);
      await reportOperation({
        hostId,
        folderId: folder.id,
        operation: folder.type,
        status: "failed",
        summary: `executor threw: ${msg}`,
        durationMs: 0,
      });
    } finally {
      clearInterval(heartbeatTimer);
      cleanup();
    }
  };

  const scheduler = new Scheduler({
    onTick: runOnce,
    getAssignments: () => hostConfig?.assignments ?? [],
  });

  setSwitchContext({
    acquireLock: (folderId) => acquireLock(client, folderId, hostId),
    releaseLock: (folderId, status, summary) => releaseLock(client, folderId, hostId, status, summary),
    runOnce: (assignment) => runOnce(assignment),
    getHostConfig: () => hostConfig,
    getRemoteName,
    startMount: systemdAwareStartMount,
    stopMount: systemdAwareStopMount,
    updateFolderType: (folderId, type) => client.updateFolder(folderId, { type }),
  });

  try {
    await client.registerHost({
      id: hostId,
      hostname: hostId,
      tailnetIp: null,
    });
    const lanIp = getLocalLanIp();
    await client.reportHealth({
      hostId,
      timestamp: Date.now(),
      status: "online",
      lanIp,
    });
    lastHeartbeatAt = Date.now();
    await reportQueue.flush();
    console.log(`[boot] registered and reported online host=${hostId} lanIp=${lanIp ?? "(none)"}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[boot] initial registration failed: ${msg}`);
  }

  await releaseStaleLocks(client, hostId);

  if (!hostConfig) {
    await refreshConfig();
  } else {
    scheduler.start();
  }
  // One-shot update check on startup. Never throws — just logs.
  try {
    const latest = await fetchLatestRelease();
    if (latest && isNewer(VERSION, latest.version)) {
      console.log(
        `[update] newer release available: ${latest.tag} (current: v${VERSION})`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[update] startup check failed: ${msg}`);
  }

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    void (async () => {
      try {
        await client.reportHealth({
          hostId,
          timestamp: now,
          status: "online",
          lanIp: getLocalLanIp(),
        });
        lastHeartbeatAt = now;
        await reportQueue.flush();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[heartbeat] failed: ${msg}`);
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  const refreshTimer = setInterval(() => {
    void refreshConfig();
  }, CONFIG_REFRESH_MS);
  refreshTimer.unref?.();

  const restoreTimer = setInterval(() => {
    void processResticRestoreJobs(client, hostId, () => hostConfig);
  }, 60_000);
  restoreTimer.unref?.();
  // Run once shortly after startup if config is already cached.
  if (hostConfig) {
    setTimeout(() => {
      void processResticRestoreJobs(client, hostId, () => hostConfig);
    }, 5_000).unref?.();
  }

  const socketServer = startSocketServer({
    socketPath,
    getState: socketState,
    onSyncRequest: async (folderId) => {
      let assignment = hostConfig?.assignments.find(
        (a) => a.folderId === folderId,
      );
      if (!assignment) {
        console.log(`[socket] sync requested for unknown folder=${folderId}; refreshing config`);
        await refreshConfig();
        assignment = hostConfig?.assignments.find(
          (a) => a.folderId === folderId,
        );
        if (!assignment) {
          console.warn(`[socket] sync requested for unknown folder=${folderId} after refresh`);
          return;
        }
      }
      void runOnce(assignment);
    },
    onSyncAllRequest: async () => {
      let assignments = hostConfig?.assignments ?? [];
      if (assignments.length === 0) {
        console.log("[socket] sync-all requested with no cached assignments; refreshing config");
        await refreshConfig();
        assignments = hostConfig?.assignments ?? [];
      }
      console.log(`[socket] sync-all requested; queueing ${assignments.length} assignment(s)`);
      for (const assignment of assignments) {
        void runOnce(assignment);
      }
    },
   });
  console.log(`[socket] listening at ${socketPath}`);

  startMountHealthChecks();

  const shutdown = (signal: string): void => {
    console.log(`lamasyncd received ${signal}, shutting down`);
    scheduler.stop();
    socketServer.close();
    void stopAllMounts();
    clearInterval(heartbeatTimer);
    clearInterval(refreshTimer);
    clearInterval(restoreTimer);
    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch { /* ignore */ }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log(`lamasyncd ready; cache=${CACHE_PATH} lastHeartbeat=${lastHeartbeatAt}`);

  await new Promise<void>(() => {});
}

/**
 * Foreground mount entry point: `lamasyncd --mount <folderId>`. Writes the
 * rclone config, kicks off the mount, and blocks until the rclone process
 * exits. Started by the systemd user unit for the folder so the kernel
 * mount survives a daemon restart.
 */
async function runMountCommand(folderId: string): Promise<void> {
  const config = loadConfig();
  const hostId = config.hostname;
  const client = new LamaSyncApiClient(config.serverUrl, config.apiKey);

  let hostConfig: HostConfig | null = null;
  try {
    hostConfig = await client.getConfig(hostId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mount-cmd] getConfig failed (${msg}); trying cache`);
    hostConfig = loadCache();
  }

  if (!hostConfig) {
    console.error(`[mount-cmd] no host config available for host=${hostId}`);
    process.exit(1);
  }

  const folder = hostConfig.folders.find((f) => f.id === folderId);
  const assignment = hostConfig.assignments.find((a) => a.folderId === folderId);
  if (!folder || !assignment) {
    console.error(`[mount-cmd] folder=${folderId} not configured on this host`);
    process.exit(1);
  }

  const { configPath, cleanup } = writeRcloneConfig(hostConfig.rcloneConfig);
  const remotePath = `${getRemoteName(assignment.remoteName, folderId)}:${folder.name}`;
  const mountPath = assignment.localPath;
  const cacheProfile = (assignment.cacheProfile ?? "normal") as
    | "normal"
    | "media"
    | "minimal";

  let exitCode = 0;
  try {
    await startMount({
      folderId,
      remotePath,
      mountPath,
      configPath,
      cacheProfile,
      cacheMaxSize: assignment.cacheMaxSize ?? undefined,
    });

    const internal = getInternalMount(folderId);
    if (internal?.proc) {
      exitCode = await internal.proc.exited;
    } else {
      // Externally-started mount (e.g. rclone spawn issued elsewhere);
      // block until signaled.
      await new Promise<number>(() => {});
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mount-cmd] folder=${folderId} failed: ${msg}`);
    exitCode = 1;
  } finally {
    await stopMount(folderId).catch(() => undefined);
    cleanup();
  }
  process.exit(exitCode ?? 0);
}

function parseMountArg(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mount") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        console.error("lamasyncd: --mount requires a folderId argument");
        process.exit(2);
      }
      return next;
    }
    if (arg?.startsWith("--mount=")) {
      return arg.slice("--mount=".length);
    }
  }
  return null;
}
// --version flag
if (import.meta.main) {
  if (process.argv.includes("--version") || process.argv.includes("-V")) {
    console.log(`lamasyncd ${VERSION}`);
    process.exit(0);
  }

  // --check-update flag: print latest release vs current, exit.
  if (process.argv.includes("--check-update")) {
    (async () => {
      const latest = await fetchLatestRelease();
      if (!latest) {
        console.error("lamasyncd --check-update: unable to reach GitHub");
        process.exit(1);
      }
      if (isNewer(VERSION, latest.version)) {
        console.log(
          `update available: current=v${VERSION} latest=${latest.tag} (published ${latest.publishedAt})`,
        );
        process.exit(0);
      }
      console.log(`up to date: current=v${VERSION} latest=${latest.tag}`);
      process.exit(0);
    })().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`lamasyncd --check-update failed: ${msg}`);
      process.exit(1);
    });
  } else if (process.argv.includes("--update")) {
    // --update flag: fetch latest, pick the matching asset, replace this binary.
    (async () => {
      const latest = await fetchLatestRelease();
      if (!latest) {
        console.error("lamasyncd --update: unable to reach GitHub");
        process.exit(1);
      }
      if (!isNewer(VERSION, latest.version)) {
        console.log(`lamasyncd --update: already at latest (v${VERSION})`);
        process.exit(0);
      }
      const asset = latest.assets.find((a) => a.name === process.env.LAMASYNC_UPDATE_ASSET)
        ?? latest.assets.find((a) => a.name === "lamasyncd")
        ?? latest.assets.find((a) => a.name.startsWith("lamasyncd-") || a.name.startsWith("lamasync-"));
      if (!asset) {
        console.error(
          `lamasyncd --update: no suitable asset in release ${latest.tag} (have: ${latest.assets.map((a) => a.name).join(", ")})`,
        );
        process.exit(1);
      }
      const target = process.argv[1] ?? "lamasyncd";
      const ok = await downloadAndReplace(asset.downloadUrl, target);
      if (!ok) {
        console.error("lamasyncd --update: download/replace failed");
        process.exit(1);
      }
      console.log(
        `lamasyncd --update: replaced ${target} with ${asset.name} from ${latest.tag}`,
      );
      process.exit(0);
    })().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`lamasyncd --update failed: ${msg}`);
      process.exit(1);
    });
  } else {
    const mountFolderId = parseMountArg(process.argv.slice(2));
    if (mountFolderId !== null) {
      runMountCommand(mountFolderId).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`lamasyncd mount fatal: ${message}`);
        process.exit(1);
      });
    } else {
      main().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`lamasyncd fatal: ${message}`);
        process.exit(1);
      });
    }
  }
}
