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
} from "@lamasync/core";
import { LamaSyncApiClient } from "@lamasync/core";
import { loadConfig } from "./config.ts";
import { CACHE_PATH, loadCache, saveCache } from "./config-cache.ts";
import { executeAssignment } from "./executor.ts";
import { Scheduler } from "./scheduler.ts";
import {
  buildSocketState,
  startSocketServer,
  type SocketState,
} from "./socket.ts";
import { getRemoteName, writeRcloneConfig } from "./rclone.ts";
import { acquireLock, heartbeatLock, releaseLock, releaseStaleLocks } from "./lock.ts";
import {
  listMounts,
  startMount,
  startMountHealthChecks,
  stopAllMounts,
  stopMount,
} from "./mounts.ts";

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
  acquireLock: (folderId: string) => Promise<unknown>;
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

  const lock = await ctx.acquireLock(folderId);
  if (!lock) {
    return { ok: false, error: `folder=${folderId} is locked by another host` };
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

  const lock = await ctx.acquireLock(folderId);
  if (!lock) {
    return { ok: false, error: `folder=${folderId} is locked by another host` };
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

async function main(): Promise<void> {
  const clientConfig = loadConfig();
  const hostId = clientConfig.hostname;
  const socketPath = defaultSocketPath();

  console.log(
    `lamasyncd starting host=${hostId} url=${clientConfig.serverUrl} socket=${socketPath}`,
  );

  const client = new LamaSyncApiClient(clientConfig.serverUrl, clientConfig.apiKey);

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
      console.error(`[report] failed to send to server: ${msg} (kept locally)`);
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

    const lock = await acquireLock(client, assignment.folderId, hostId);
    if (!lock) {
      console.warn(`[run] folder=${folder.name} skipped: lock held by another host`);
      await reportOperation({
        hostId,
        folderId: folder.id,
        operation: folder.type,
        status: "failed",
        summary: "skipped: folder locked by another host",
        durationMs: 0,
      });
      return;
    }

    const heartbeatTimer = setInterval(() => {
      void heartbeatLock(client, assignment.folderId, hostId);
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
      });
      console.log(
        `[run] folder=${folder.name} type=${folder.type} status=${report.status} summary=${report.summary ?? ""}`,
      );
      await releaseLock(client, folder.id, hostId, report.status, report.summary ?? undefined);
      await reportOperation(report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[run] executor threw: ${msg}`);
      await releaseLock(client, folder.id, hostId, "failed", msg);
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
    startMount,
    stopMount,
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

  const socketServer = startSocketServer({
    socketPath,
    getState: socketState,
    onSyncRequest: (folderId) => {
      const assignment = hostConfig?.assignments.find(
        (a) => a.folderId === folderId,
      );
      if (!assignment) {
        console.warn(`[socket] sync requested for unknown folder=${folderId}`);
        return;
      }
      void runOnce(assignment);
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

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`lamasyncd fatal: ${message}`);
  process.exit(1);
});
