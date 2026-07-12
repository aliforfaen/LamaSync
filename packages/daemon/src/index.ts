import { existsSync, unlinkSync } from "fs";
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
import { writeRcloneConfig } from "./rclone.ts";

const HEARTBEAT_INTERVAL_MS = 30_000;
const CONFIG_REFRESH_MS = 5 * 60 * 1000;
const OPERATIONS_RING_SIZE = 200;

function defaultSocketPath(): string {
  return process.env.LAMASYNC_SOCKET_PATH ?? join(homedir(), "lamasync.sock");
}

async function main(): Promise<void> {
  const clientConfig = loadConfig();
  const hostId = clientConfig.hostname;
  const socketPath = defaultSocketPath();

  console.log(
    `lamasyncd starting host=${hostId} url=${clientConfig.serverUrl} socket=${socketPath}`,
  );

  const client = new LamaSyncApiClient(clientConfig.serverUrl, clientConfig.apiKey);

  // Mutable runtime state. The scheduler reads assignments from this; the
  // socket server exposes a snapshot to the TUI.
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
    // Mirror the server-side OperationLog shape so the TUI can render directly.
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

  const reportOperation = async (
    report: OperationReport,
  ): Promise<void> => {
    recordOperation(report);
    try {
      await client.reportOperation(report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[report] failed to send to server: ${msg} (kept locally)`,
      );
    }
  };

  const runOnce = async (assignment: FolderAssignment): Promise<void> => {
    if (!hostConfig) {
      console.warn(
        `[run] no hostConfig cached; skipping folder=${assignment.folderId}`,
      );
      return;
    }
    const folder: Folder | undefined = hostConfig.folders.find(
      (f) => f.id === assignment.folderId,
    );
    if (!folder) {
      console.warn(
        `[run] folder=${assignment.folderId} not in cache; refreshing`,
      );
      await refreshConfig();
      return;
    }

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
      await reportOperation(report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[run] executor threw: ${msg}`);
      await reportOperation({
        hostId,
        folderId: folder.id,
        operation: folder.type,
        status: "failed",
        summary: `executor threw: ${msg}`,
        durationMs: 0,
      });
    } finally {
      cleanup();
    }
  };

  const scheduler = new Scheduler({
    onTick: runOnce,
    getAssignments: () => hostConfig?.assignments ?? [],
  });

  // First connection: register + report health + load cache (if missing).
  try {
    await client.registerHost({
      id: hostId,
      hostname: hostId,
      tailnetIp: null,
    });
    await client.reportHealth({
      hostId,
      timestamp: Date.now(),
      status: "online",
    });
    lastHeartbeatAt = Date.now();
    console.log(`[boot] registered and reported online host=${hostId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[boot] initial registration failed: ${msg}`);
  }

  if (!hostConfig) {
    await refreshConfig();
  } else {
    scheduler.start();
  }

  // Background loops.
  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    void (async () => {
      try {
        await client.reportHealth({
          hostId,
          timestamp: now,
          status: "online",
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

  const shutdown = (signal: string): void => {
    console.log(`lamasyncd received ${signal}, shutting down`);
    scheduler.stop();
    socketServer.close();
    clearInterval(heartbeatTimer);
    clearInterval(refreshTimer);
    // Best-effort: clean up socket file even if Bun.serve.close already removed it.
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // ignore
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log(`lamasyncd ready; cache=${CACHE_PATH} lastHeartbeat=${lastHeartbeatAt}`);

  // Block forever. signal handlers exit the process directly.
  await new Promise<void>(() => {});
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`lamasyncd fatal: ${message}`);
  process.exit(1);
});