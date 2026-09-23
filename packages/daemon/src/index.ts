import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from "fs";
import { networkInterfaces } from "os";
import { homedir } from "os";
import { join } from "path";
import type {
  AppCaptureAssignment,
  Folder,
  FolderAssignment,
  FolderHealthDeepMeasurement,
  HostConfig,
  OperationLog,
  MountCacheMode,
  OperationReport,
  QueuedAction,
  QueuedActionStatus,
  ResticRestoreJob,
  TriggerOrigin,
} from "@lamasync/core";
import {
  ACTION_LEASE_RENEW_INTERVAL_MS,
  LamaSyncApiClient,
  VERSION,
  canonicalDestinationKey,
  defaultSocketPath,
  effectiveFolderType,
  parseFolderDiagnosePayload,
  parseFolderInterventionPayload,
  parseFolderPlanRequestPayload,
  parseSeedJobActionPayload,
  planHasContentChanges,
  resolveDestination,
  resolveWatchQuietSec,
} from "@lamasync/core";
import { locateSkillAsset, SKILL_DIR, downloadSkillBundle, readInstalledSkillVersion } from "./skill-update.ts";
import {
  actionClaimDecision,
  isDryRunRequested,
  selectActionTargets,
  summarizeConfigRefresh,
  summarizeReportForAction,
  summarizeUpdateCheck,
  unassignedFolderCompletion,
} from "./actions.ts";
import { expandConfigPaths, expandHomePath, loadConfig, missingAssignmentPaths } from "./config.ts";
import { CACHE_PATH, loadCache, saveCache } from "./config-cache.ts";
import {
  UPDATE_CHECK_COOLDOWN_MS,
  markUpdateCheckAttempted,
  withinUpdateCooldown,
} from "./update-check.ts";
import { captureAppSnapshot, executeAssignment, executeResticRestore, isPauseActive } from "./executor.ts";
import type { BisyncRunControl } from "./executor.ts";
import { diagnoseFolder, measureLocalTree, probeFolderHealth } from "./folder-health.ts";
import {
  buildSyncPlan,
  recheckZeroContentExecution,
  runControlFor,
  runControlFromExecution,
  verifyPlanAgainstLive,
} from "./intervention.ts";
import {
  baselineFingerprint,
  bisyncStateDir,
  inspectBisyncBaseline,
} from "./bisync-baseline.ts";
import { liveFilterFingerprint } from "./folder-health.ts";
import { createSyncProgressReporter } from "./live-progress.ts";
import { Scheduler } from "./scheduler.ts";
import {
  buildSocketState,
  startSocketServer,
  type SocketState,
} from "./socket.ts";
import { getRemoteName, writeRcloneConfig } from "./rclone.ts";
import { KeyedMutex } from "./keyed-mutex.ts";
import { detectTailnetIp, TailnetReportTracker } from "./lan-peer.ts";
import {
  acquireLock,
  acquireLockWithRetry,
  buildDeferredReport,
  heartbeatLock,
  releaseLock,
  releaseStaleLocks,
  type LockAcquireResult,
} from "./lock.ts";
import { summarizeBatchSync } from "./actions.ts";
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
import { detectHostClass, osLabel, readHostClassFacts, storageUsedBytes } from "./device-info.ts";
import {
  disableMountUnit,
  isMountUnitActive,
  isSystemdAvailable,
  reconcileDaemonServiceUnit,
  removeMountUnit,
  restartDaemonService,
  startMountUnit,
  stopMountUnit,
  waitForMountUnitActive,
  writeMountUnit,
} from "./systemd.ts";
import { downloadAndReplace, isNewer, resolveSelfBinaryPath } from "./self-update.ts";
import {
  performDaemonUpdate,
  runDaemonUpdateAction,
  scrubForOutcome,
  summarizeUnitReconcile,
} from "./daemon-update.ts";
import { DAEMON_KNOWN_FLAGS, daemonUsage } from "./usage.ts";
import { createLinuxInotifyFactory } from "./folder-watch.ts";
import { WatchCoordinator } from "./watch-control.ts";
import { seedDaemonE2eEnabled } from "./seed-daemon-seam.ts";

const HEARTBEAT_INTERVAL_MS = 30_000;
const CONFIG_REFRESH_MS = 5 * 60 * 1000;
const OPERATIONS_RING_SIZE = 200;

// LAMA-218: the shared helper in @lamasync/core owns the resolution
// (env → XDG_RUNTIME_DIR → ~/.lamasync). Kept exported as a name for
// `socket.ts` callers and any external tools that want to point at the
// daemon.
export { defaultSocketPath };

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
  // LAMA-239: the host id is needed so the switch can flip THIS host's
  // per-assignment `mode` (instead of the folder-level type).
  hostId: string;
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
    /** LAMA-345: validated per-assignment mount cache mode override. */
    cacheMode?: MountCacheMode | null;
  }) => Promise<unknown>;
  stopMount: (folderId: string) => Promise<void>;
  getRemoteName: (remoteName: string | null | undefined, folderId: string) => string;
  // LAMA-239: per-host mode setter (replaces the global folder.type setter
  // the LAMA-238-era switch used). updateAssignmentMode is hosted on the
  // existing API client as `client.updateAssignment(folderId, hostId,
  // { mode })`.
  updateAssignmentMode: (
    folderId: string,
    hostId: string,
    mode: "sync" | "mount",
  ) => Promise<unknown>;
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
  // LAMA-239: gate on the EFFECTIVE type — the folder-level type alone
  // isn't enough when a per-host override flips the meaning for this
  // host. A `sync` folder with this host's mode = "sync" still goes
  // through the final-sync → trash → mount dance; a `mount` folder with
  // mode = "inherit" already mounts and the switch is a no-op error.
  const effective = effectiveFolderType(folder, assignment);
  if (effective !== "sync") {
    return { ok: false, error: `folder=${folderId} effective=${effective}; expected sync` };
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
        remotePath: `${ctx.getRemoteName(assignment.remoteName, folderId)}:${resolveDestination(folder, assignment)}`,
        mountPath: localPath,
        configPath,
        cacheProfile: assignment.cacheProfile ?? undefined,
        cacheMaxSize: assignment.cacheMaxSize ?? undefined,
        cacheMode: assignment.mountCacheMode ?? null,
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
    // LAMA-239: per-host mode setter (replaces the global
    // updateFolderType). Reconcile on the next refresh will keep the
    // mount up if this daemon restarts.
    await ctx.updateAssignmentMode(folderId, ctx.hostId, "mount");
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
  // LAMA-239: gate on the EFFECTIVE type, not folder.type. The web UI
  // may have set this host's mode to "mount" without changing the
  // folder-level type — the switch still has work to do (stop the mount
  // + initial sync + reset the override) for that host.
  const effective = effectiveFolderType(folder, assignment);
  if (effective !== "mount") {
    return { ok: false, error: `folder=${folderId} effective=${effective}; expected mount` };
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
    // LAMA-239: per-host mode setter. Resetting mode to "sync" (rather
    // than "inherit") is the explicit switch semantic — the host
    // requested sync, so its mode stays "sync" until an operator changes
    // it back. If the folder-level type is "sync" too, "inherit" and
    // "sync" produce the same effective behavior, but "sync" keeps the
    // intent visible on the assignment.
    await ctx.updateAssignmentMode(folderId, ctx.hostId, "sync");
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
  /** LAMA-345: validated per-assignment mount cache mode override. */
  cacheMode?: MountCacheMode | null;
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
    let adopted = adoptMount(opts.folderId, {
      mountPath: opts.mountPath,
      cacheProfile: opts.cacheProfile ?? "normal",
      cacheMode: opts.cacheMode ?? null,
      cacheMaxSize: opts.cacheMaxSize ?? null,
      remotePath: opts.remotePath,
      configPath: opts.configPath,
    });
    const deadline = Date.now() + 30_000;
    while (adopted === null && Date.now() < deadline && isMountUnitActive(opts.folderId)) {
      await Bun.sleep(500);
      adopted = adoptMount(opts.folderId, {
        mountPath: opts.mountPath,
        cacheProfile: opts.cacheProfile ?? "normal",
        cacheMode: opts.cacheMode ?? null,
        cacheMaxSize: opts.cacheMaxSize ?? null,
        remotePath: opts.remotePath,
        configPath: opts.configPath,
      });
    }
    if (adopted === null) {
      stopMountUnit(opts.folderId);
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
 * LAMA-239: reconcile the local mount state against the effective type of
 * every assignment after a config refresh (and at boot). Today mounts only
 * start via an explicit `switch_to_mount` socket command; an effective
 * `mount` set from the web UI never brings up the unit. This pass makes
 * the override actually do something:
 *
 *   - effective `mount`, role != `source`, mount unit inactive → start it
 *     (write + start + adopt). systemdAwareStartMount falls back to the
 *     in-process mount when systemd isn't available, matching the existing
 *     switch path.
 *   - effective `mount`, role != `source`, mount unit already active →
 *     adopt it into the in-process registry so the scheduler and local CLI see
 *     it as live (this is the old `adoptExistingMountUnits` behavior).
 *   - effective anything-else, mount unit active → stop it so a host
 *     flipped back to sync doesn't keep a stale mount running. The cron
 *     scheduler then resumes its normal job.
 *
 * `role === "source"` assignments are never auto-started even when the
 * folder is `mount` — the operator only mounts a folder on hosts that are
 * supposed to serve it (matching the existing switch/adopt behavior).
 */
async function reconcileMountsOnRefresh(
  getHostConfig: () => HostConfig | null,
): Promise<void> {
  const cfg = getHostConfig();
  if (!cfg) return;
  const foldersById = new Map(cfg.folders.map((f) => [f.id, f]));
  for (const assignment of cfg.assignments) {
    if (assignment.role === "source") continue;
    const folder = foldersById.get(assignment.folderId);
    if (!folder) continue;
    const effective = effectiveFolderType(folder, assignment);
    const active = isMountUnitActive(assignment.folderId);
    if (effective === "mount") {
      const wantedCacheMode = assignment.mountCacheMode ?? null;
      if (active) {
        // Already up under systemd — adopt it into the in-process registry
        // so the scheduler and local CLI see it as live.
        const tracked = getInternalMount(assignment.folderId);
        const trackedMode = tracked?.cacheMode ?? null;
        // LAMA-345: a changed mount cache mode is a mount-lifecycle change,
        // not a decoration. An adopted-from-unit process keeps running with
        // the mode it was started with, so reconcile must restart it.
        if (tracked && trackedMode !== wantedCacheMode) {
          console.log(
            `[reconcile] mount cache mode changed for folder=${assignment.folderId} (${trackedMode ?? "profile"} → ${wantedCacheMode ?? "profile"}); restarting mount`,
          );
          await systemdAwareStopMount(assignment.folderId);
        } else {
          if (tracked) continue;
          const adopted = adoptMount(assignment.folderId, {
            mountPath: assignment.localPath,
            cacheProfile: assignment.cacheProfile ?? "normal",
            cacheMode: wantedCacheMode,
            cacheMaxSize: assignment.cacheMaxSize ?? null,
            remotePath: `${getRemoteName(assignment.remoteName, assignment.folderId)}:${assignment.folderId}`,
            configPath: "/dev/null",
          });
          if (adopted) {
            console.log(
              `[reconcile] adopted existing mount unit for folder=${assignment.folderId}`,
            );
          }
          continue;
        }
      }
      // Not running — start it. systemdAwareStartMount writes the unit,
      // starts it, waits, and falls back to in-process when systemd is
      // unavailable (same semantics as switchToMount).
      const hostConfigForStart = cfg;
      try {
        const { configPath, cleanup } = writeRcloneConfig(hostConfigForStart.rcloneConfig);
        try {
          await systemdAwareStartMount({
            folderId: assignment.folderId,
            remotePath: `${getRemoteName(assignment.remoteName, assignment.folderId)}:${resolveDestination(folder, assignment)}`,
            mountPath: assignment.localPath,
            configPath,
            cacheProfile: assignment.cacheProfile ?? undefined,
            cacheMaxSize: assignment.cacheMaxSize ?? undefined,
            cacheMode: assignment.mountCacheMode ?? null,
          });
          console.log(
            `[reconcile] started mount for folder=${assignment.folderId} (effective=mount)`,
          );
        } finally {
          cleanup();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[reconcile] failed to start mount for folder=${assignment.folderId}: ${msg}`,
        );
      }
      continue;
    }
    // Effective type is sync/backup/dotfile/git — if a mount unit happens
    // to be active, stop it so this host returns to its scheduled jobs.
    if (active) {
      try {
        await systemdAwareStopMount(assignment.folderId);
        console.log(
          `[reconcile] stopped stale mount for folder=${assignment.folderId} (effective=${effective})`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[reconcile] failed to stop stale mount for folder=${assignment.folderId}: ${msg}`,
        );
      }
    }
  }
}
async function main(): Promise<void> {

  const clientConfig = loadConfig();
  const hostId = clientConfig.hostname;
  // LAMA-218: client.toml's `socketPath` overrides every default when
  // set. env (LAMASYNC_SOCKET_PATH) and the helper's fallback chain
  // remain in effect otherwise.
  const socketPath = defaultSocketPath(clientConfig.socketPath ?? undefined);

  console.log(
    `lamasyncd starting host=${hostId} url=${clientConfig.serverUrl} socket=${socketPath}`,
  );

  const client = new LamaSyncApiClient(clientConfig.serverUrl, clientConfig.apiKey);
  const reportQueue = createReportQueue(clientConfig.dataDir, client);
  // LAMA-247 #8: tailnet address lifecycle — sustained detection failure
  // clears the stored address after a 5-minute grace.
  const tailnetTracker = new TailnetReportTracker();

  let hostConfig: HostConfig | null = loadCache();
  const operations: OperationLog[] = [];
  let lastHeartbeatAt = 0;
  // LAMA-345: per-assignment health runtime state. All bounded by the
  // assignment count and never produced by a tree walk on the heartbeat path.
  const lastRunByFolder = new Map<
    string,
    { status: string; summary: string | null; at: number | null }
  >();
  const measurementByFolder = new Map<string, FolderHealthDeepMeasurement>();
  // LAMA-345: assign the health-report closure once the watch coordinator
  // exists (below). Runs call it through this hook; until it is assigned the
  // calls are no-ops, which is correct during boot.
  // LAMA-345: in-flight rclone runs, keyed by folder id, so the deliberate
  // `cancel` intervention can abort exactly one run and report it distinctly.
  const activeRuns = new Map<string, AbortController>();
  let requestHealthReport:
    | ((opts?: { folderIds?: string[]; readCounts?: boolean; measure?: boolean }) => Promise<void>)
    | null = null;
  // LAMA-225: last hostname the server returned for this daemon, so the
  // rename log line fires once per change instead of every refresh.
  let lastServerHostname = clientConfig.hostname;

  const socketState = (): SocketState =>
    buildSocketState(hostId, hostConfig, operations);

  // Returns true on success, false when the fetch failed (so the
  // `refresh_config` action can ack `failed` instead of reporting a stale
  // success). Callers that don't care about the result ignore the return.
  const refreshConfig = async (): Promise<boolean> => {
    try {
      const cfg = await client.getConfig(hostId);
      // LAMA-309: expand assignment local paths once at config load so every
      // consumer (rclone argv, checkDiskSpace `df`, watch-control existsSync,
      // mounts, systemd units) sees absolute paths. Persist the expanded form
      // so the on-disk cache stays canonical even for pre-fix daemons.
      const config = expandConfigPaths(cfg);
      hostConfig = config;
      saveCache(config);
      // LAMA-225: the server owns the display label. When an operator
      // renamed this host via the UI, /config/:hostId returns the new
      // hostname while this daemon still identifies by its local
      // client.toml hostname — log the change so the operator sees it.
      if (cfg.host.hostname !== lastServerHostname) {
        console.log(
          `[config] host renamed: ${lastServerHostname} → ${cfg.host.hostname}`,
        );
        lastServerHostname = cfg.host.hostname;
      }
      console.log(
        `[config] refreshed host=${hostId} assignments=${cfg.assignments.length}`,
      );
      warnMissingLocalPaths();
      scheduler.refresh();
      // LAMA-302: reconcile watch controllers against the fresh config
      // (starts/updates/stops watchers for eligible `sync` assignments).
      watchCoordinator.reconcile();
      // LAMA-239: fire-and-forget — a slow reconcile (systemd unit write
      // + wait) shouldn't block the cache save / heartbeat / action
      // acks. Failures log inside reconcileMountsOnRefresh.
      void reconcileMountsOnRefresh(() => hostConfig);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[config] refresh failed: ${msg}`);
      return false;
    }
  };

  // LAMA-311: folder id → folder type for the `backupOnly` filter. Built from
  // the *current* cache on every call so a refresh inside the action dispatcher
  // re-selects against the fresh folder types, not a pre-refresh snapshot.
  const folderTypesFor = (): Map<string, Folder["type"]> => {
    const types = new Map<string, Folder["type"]>();
    for (const folder of hostConfig?.folders ?? []) {
      types.set(folder.id, folder.type);
    }
    return types;
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
      trigger: report.trigger ?? null,
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

  const runMutex = new KeyedMutex();

  // LAMA-327: deterministic-crypto run id for the live progress registry.
  // Keyed per run so concurrent runs on one host (different folders / apps)
  // and retries within one run stay distinguishable.
  const newRunId = (): string => crypto.randomUUID();

  // LAMA-327: whether this run participates in the live progress surface.
  // rclone-driven operations only (sync / mount / backup) and NOT the
  // restic-backed paths (they have no `--use-json-log` stream). Dotfile,
  // git, and app-capture runs keep their immutable operation_log row and
  // stay off the live surface — the live registry is for long rclone runs.
  const usesLiveProgress = (folder: Folder, assignment: FolderAssignment): boolean => {
    // restic-backed backup/dotfile runs have no `--use-json-log` stream —
    // keep them off the live surface (checked before type narrowing).
    if (
      (folder.type === "backup" || folder.type === "dotfile") &&
      Boolean(assignment.resticRepository && assignment.resticPassword)
    ) {
      return false;
    }
    if (
      folder.type !== "sync" &&
      folder.type !== "mount" &&
      folder.type !== "backup"
    ) {
      return false;
    }
    return true;
  };

  // LAMA-308: the run body, extracted so runOnce can serialize concurrent
  // runs for the same folder through the in-process keyed mutex. Covers lock
  // acquisition through executeAssignment + reporting, so two claimed
  // `trigger_sync` actions for one folder run one after another instead of
  // racing the same bisync state dir / mount.
  const runLocked = async (
    assignment: FolderAssignment,
    folder: Folder,
    effectiveFolder: Folder,
    hostConfig: HostConfig,
    opts: { dryRun?: boolean; triggerOrigin?: TriggerOrigin; bisync?: BisyncRunControl } | undefined,
    attachOrigin: (report: OperationReport) => OperationReport,
  ): Promise<OperationReport | null> => {
    // LAMA-327: live progress for this run. Created before lock acquisition so
    // the "queued → lock" lifecycle is visible, and finished (terminal) on
    // every exit path — including lock deferral and executor throws — so the
    // server registry never keeps a stale entry.
    const progress = usesLiveProgress(folder, assignment)
      ? createSyncProgressReporter({
          client,
          hostId,
          hostname: hostConfig.host.hostname ?? null,
          folderId: folder.id,
          folderName: folder.name,
          operation: effectiveFolder.type,
          runId: newRunId(),
          startedAt: Date.now(),
        })
      : null;
    progress?.report({ phase: "queued", detail: "waiting for destination lock" });
    // LAMA-294: the lock identity is the canonical destination/repository
    // key (host-scoped for ordinary backups), so distinct hosts with the
    // same folder no longer contend unless they intentionally share a
    // prefix. Acquisition retries with bounded exponential backoff + jitter
    // so a simultaneous schedule isn't skipped until the next cron interval.
    const lockResult = await acquireLockWithRetry(
      client,
      assignment.folderId,
      hostId,
      canonicalDestinationKey(folder, assignment),
    );
    if (!lockResult.ok) {
      const skipReport = buildDeferredReport(
        lockResult,
        hostId,
        folder.id,
        effectiveFolder.type,
        Date.now(),
      );
      console.warn(`[run] folder=${folder.name} ${skipReport.summary}`);
      // Contention / control-plane outage is a first-class deferral, not a
      // failed backup: no transfer was started, so it must not surface as a
      // permanent failure (LAMA-294 goal 4-5).
      await reportOperation(attachOrigin(skipReport));
      progress?.finish("failed", skipReport.summary ?? "deferred — lock unavailable");
      return attachOrigin(skipReport);
    }
    const lock = lockResult.handle!;
    progress?.report({ phase: "lock", detail: "destination lock acquired" });

    const abortController = new AbortController();
    // LAMA-345: expose the live run so the `cancel` intervention can abort
    // exactly this assignment's run with a distinct reason.
    activeRuns.set(folder.id, abortController);
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
        folder: effectiveFolder,
        hostConfig,
        client,
        hostId,
        configPath,
        signal: abortController.signal,
        dryRun: opts?.dryRun === true,
        // LAMA-345: a reviewed intervention rides the SAME locked, mutex'd
        // path as a scheduled run — it must not race a run on the same
        // workdir or bypass the destination lock.
        ...(opts?.bisync ? { bisync: opts.bisync } : {}),
        progress: progress ?? undefined,
      });
      console.log(
        `[run] folder=${folder.name} type=${effectiveFolder.type} status=${report.status} summary=${report.summary ?? ""}`,
      );
      await releaseLock(
        client,
        folder.id,
        hostId,
        report.status,
        report.summary ?? undefined,
        lock,
      );
      // LAMA-327: terminal live progress. `conflict` / `recovery` are
      // completed runs (the sync ran to a conclusion); `success` and
      // `recovery` map to success, `conflict` reports success with the
      // summary as detail — the immutable operation_log row stays the
      // authoritative verdict.
      if (progress) {
        progress.finish(
          report.status === "failed" ? "failed" : "success",
          report.summary ?? (report.status === "failed" ? "sync failed" : "sync completed"),
        );
      }
      const originReport = attachOrigin(report);
      await reportOperation(originReport);
      return originReport;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[run] executor threw: ${msg}`);
      progress?.finish("failed", `executor threw: ${msg}`);
      await releaseLock(client, folder.id, hostId, "failed", msg, lock);
      const errReport: OperationReport = {
        hostId,
        folderId: folder.id,
        operation: effectiveFolder.type,
        status: "failed",
        summary: `executor threw: ${msg}`,
        durationMs: 0,
      };
      await reportOperation(attachOrigin(errReport));
      return attachOrigin(errReport);
    } finally {
      clearInterval(heartbeatTimer);
      cleanup();
      if (activeRuns.get(folder.id) === abortController) {
        activeRuns.delete(folder.id);
      }
    }
  };

  const runOnce = async (
    assignment: FolderAssignment,
    opts?: { dryRun?: boolean; triggerOrigin?: TriggerOrigin; bisync?: BisyncRunControl },
  ): Promise<OperationReport | null> => {
    // LAMA-302: attach the trigger origin to every report so the operations
    // view can distinguish watch / schedule / manual runs.
    const attachOrigin = (report: OperationReport): OperationReport =>
      opts?.triggerOrigin ? { ...report, trigger: opts.triggerOrigin } : report;
    if (!hostConfig) {
      console.warn(`[run] no hostConfig cached; skipping folder=${assignment.folderId}`);
      return null;
    }
    const folder: Folder | undefined = hostConfig.folders.find(
      (f) => f.id === assignment.folderId,
    );
    if (!folder) {
      console.warn(`[run] folder=${assignment.folderId} not in cache; refreshing`);
      await refreshConfig();
      return null;
    }
    // LAMA-239: per-host mount/sync override. Clone the folder with the
    // effective type so every downstream branch (filter mode, disk-space
    // pre-flight, retry loop, operation_log) reflects what THIS host will
    // actually do, without mutating the cached folder (which is shared
    // across all host assignments).
    const effectiveFolder: Folder = {
      ...folder,
      type: effectiveFolderType(folder, assignment),
    };

    // LAMA-308: serialize runs for the same folder in-process so N claimed
    // trigger_sync actions for one folder run one after another instead of
    // racing. Acquisition happens inside the lock so the second caller waits
    // for the first to release its server lock before it runs.
    // Capture the (now-narrowed) host config: TS won't preserve the null-out
    // narrowing across the closure, and `hostConfig` is a mutable `let`.
    const config = hostConfig;
    const result = await runMutex.run(assignment.folderId, () =>
      runLocked(assignment, folder, effectiveFolder, config, opts, attachOrigin),
    );
    // LAMA-345: remember the latest outcome for this assignment and refresh
    // its health report (deep measurement included, since a run just touched
    // the tree). Fire-and-forget: health must never delay the next run.
    // A dry run is not an outcome — it must not overwrite the last real run.
    if (result && opts?.dryRun !== true) {
      lastRunByFolder.set(assignment.folderId, {
        status: result.status,
        summary: result.summary ?? null,
        at: Date.now(),
      });
      void requestHealthReport?.({
        folderIds: [assignment.folderId],
        readCounts: true,
        measure: true,
      });
    }
    return result;
  };

  /** Run one explicit application protection without a legacy folder bridge. */
  const runAppOnce = async (
    app: AppCaptureAssignment,
    opts?: { triggerOrigin?: TriggerOrigin },
  ): Promise<OperationReport | null> => {
    const attachOrigin = (report: OperationReport): OperationReport =>
      opts?.triggerOrigin ? { ...report, trigger: opts.triggerOrigin } : report;
    const config = hostConfig;
    if (!config) {
      console.warn(`[app] no hostConfig cached; skipping protection=${app.protectionId}`);
      return null;
    }
    if (isPauseActive(config.pause)) {
      const report: OperationReport = {
        hostId,
        folderId: null,
        operation: "app-capture",
        status: "failed",
        summary: `app capture skipped: paused until ${config.pause!.until}`,
        durationMs: 0,
      };
      await reportOperation(attachOrigin(report));
      return attachOrigin(report);
    }
    return await runMutex.run(`app:${app.protectionId}`, async () => {
      try {
        const report = await captureAppSnapshot({ app, hostId, client });
        console.log(
          `[app] protection=${app.protectionId} status=${report.status} summary=${report.summary ?? ""}`,
        );
        const originReport = attachOrigin(report);
        await reportOperation(originReport);
        return originReport;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const report: OperationReport = {
          hostId,
          folderId: null,
          operation: "app-capture",
          status: "failed",
          summary: `app capture threw: ${msg}`,
          durationMs: 0,
        };
        await reportOperation(attachOrigin(report));
        return attachOrigin(report);
      }
    });
  };

  // LAMA-198: config-revision tracking. The server bumps `config_revision`
  // on every change that could affect a host's effective config (folders,
  // assignments, dotfile manifests, LAN peers, /register). The daemon
  // records the revision of the config it most recently cached and compares
  // it against the server's value on every heartbeat; a higher server value
  // triggers an out-of-band refresh. The 5-min refresh timer stays as a
  // backstop for missed heartbeats / silent config-side failures.
  let lastSeenRevision: number | null = null;
  const recordRevision = (cfg: HostConfig | null): void => {
    if (!cfg) return;
    lastSeenRevision = cfg.host.configRevision ?? 0;
  };

  // LAMA-241 / LAMA-309: a local path that doesn't exist yet is a normal
  // pre-first-use state — the directory is created lazily on the first
  // sync/mount run (see executor.ts ensureLocalDirectory). Log a single
  // info-level line per refresh so operators can spot a genuinely wrong
  // path without per-refresh spam.
  const warnMissingLocalPaths = (): void => {
    const assignments = hostConfig?.assignments ?? [];
    const missing = missingAssignmentPaths(assignments, (folderId) =>
      hostConfig?.folders.find((f) => f.id === folderId)?.name ?? null,
    );
    if (missing.length > 0) {
      console.info(
        `[config] ${missing.length} local path(s) missing, will be created on first run: ${missing
          .map((m) => `${m.folderName}:${m.localPath}`)
          .join(", ")}`,
      );
    }
  };

  // LAMA-198: the daemon's view of an action's final outcome. The
  // dispatcher delegates to `actions.ts` helpers so the wording and
  // status-mapping rules are testable without a network/server.
  const summarizeReport = (
    report: OperationReport | null,
    fallback: string,
  ): { status: "done" | "failed"; result: string } => {
    if (!report) return { status: "done", result: fallback };
    return summarizeReportForAction(report.status, report.summary ?? null, fallback);
  };

  /**
   * LAMA-345 follow-up: action ids this process is executing right now.
   * Serves two purposes: the single-flight guard below, and the set of leases
   * the renewal timer must keep alive while an action is long-running.
   */
  const inFlightActions = new Set<string>();

  /**
   * Execute a queued action exactly once. A duplicate claim (the poll timer
   * overlapping a long run, or a boot reclaim racing a poll) is a logged
   * no-op rather than a second real run — the release-blocking cachy incident
   * began with a reclaimed in-flight intervention.
   */
  async function executeAction(action: QueuedAction): Promise<void> {
    const decision = actionClaimDecision(action, inFlightActions);
    if (!decision.run) {
      console.warn(`[action] ignoring ${action.id}: ${decision.reason}`);
      return;
    }
    inFlightActions.add(action.id);
    try {
      await executeActionBody(action);
    } finally {
      inFlightActions.delete(action.id);
    }
  }

  /**
   * Execute a single queued action and ack it back to the server. Errors
   * are caught and surfaced via `status: "failed"` so one bad action never
   * takes down the poll loop.
   */
  async function executeActionBody(action: QueuedAction): Promise<void> {
    // LAMA-311: the return value matters to callers that must not take an
    // irreversible local step (the `update_daemon` restart) before the
    // completion is durably recorded. Callers that don't care ignore it.
    const ack = async (
      status: QueuedActionStatus,
      result: string | null,
    ): Promise<boolean> => {
      try {
        await client.completeAction(action.id, {
          status: status === "done" ? "done" : "failed",
          result,
        });
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[action] failed to ack ${action.id}: ${msg}`);
        return false;
      }
    };

    const payload = action.payload ?? {};
    try {
      switch (action.type) {
        case "trigger_sync": {
          // LAMA-311: a claimed action can be resolved against a cache the
          // server has already superseded (the poller and the heartbeat
          // revision check share a tick). Refresh once and re-select before
          // declaring a named folder unassigned.
          const selection = await selectActionTargets(payload, {
            backupOnly: false,
            assignments: () => hostConfig?.assignments ?? [],
            folderTypes: folderTypesFor,
            refreshConfig,
          });
          if (selection.refreshed && !selection.refreshFailed) {
            recordRevision(hostConfig);
          }
          const dryRun = isDryRunRequested(payload);
          const folderId = typeof payload["folderId"] === "string" ? payload["folderId"] : null;
          if (folderId && selection.targets.length === 0) {
            const outcome = unassignedFolderCompletion(folderId, hostId, {
              refreshFailed: selection.refreshFailed,
            });
            await ack(outcome.status, outcome.result);
            return;
          }
          if (selection.targets.length === 0) {
            await ack("done", "no assignments configured");
            return;
          }
          // One action = one completion: aggregate per-assignment outcomes
          // (each assignment also writes its own operation_log via runOnce).
          const outcomes: { status: "done" | "failed"; result: string }[] = [];
          for (const assignment of selection.targets) {
            const report = await runOnce(assignment, { dryRun, triggerOrigin: "manual" });
            outcomes.push(
              summarizeReport(report, `synced folder=${assignment.folderId}`),
            );
          }
          const summary = summarizeBatchSync(outcomes, {
            verb: "synced",
            dryRun,
          });
          await ack(summary.status, summary.result);
          return;
        }
        case "trigger_backup": {
          // LAMA-311: same refresh-once re-selection as `trigger_sync`; the
          // `backupOnly` filter is applied against the fresh folder types.
          const selection = await selectActionTargets(payload, {
            backupOnly: true,
            assignments: () => hostConfig?.assignments ?? [],
            folderTypes: folderTypesFor,
            refreshConfig,
          });
          if (selection.refreshed && !selection.refreshFailed) {
            recordRevision(hostConfig);
          }
          const folderId = typeof payload["folderId"] === "string" ? payload["folderId"] : null;
          // App protections are first-class backups, not dotfile folder
          // assignments. A host-wide backup trigger includes every enabled
          // protection; a folder-scoped trigger deliberately does not guess
          // which application the caller meant.
          const appTargets = folderId === null ? (hostConfig?.apps ?? []) : [];
          if (folderId && selection.targets.length === 0) {
            const outcome = unassignedFolderCompletion(folderId, hostId, {
              refreshFailed: selection.refreshFailed,
            });
            await ack(outcome.status, outcome.result);
            return;
          }
          if (selection.targets.length === 0 && appTargets.length === 0) {
            await ack("done", "no backup assignments configured");
            return;
          }
          const outcomes: { status: "done" | "failed"; result: string }[] = [];
          for (const assignment of selection.targets) {
            const report = await runOnce(assignment, { triggerOrigin: "manual" });
            outcomes.push(
              summarizeReport(report, `backed up folder=${assignment.folderId}`),
            );
          }
          for (const app of appTargets) {
            const report = await runAppOnce(app, { triggerOrigin: "manual" });
            outcomes.push(
              summarizeReport(report, `captured app=${app.appName}`),
            );
          }
          const summary = summarizeBatchSync(outcomes, { verb: "backed up" });
          await ack(summary.status, summary.result);
          return;
        }
        case "check_update": {
          const latest = await client.getLatestRelease();
          if (!latest) {
            await ack("failed", "could not reach the release proxy");
            return;
          }
          const outcome = summarizeUpdateCheck(VERSION, latest.version);
          await ack(outcome.status, outcome.result);
          return;
        }
        case "refresh_config": {
          const ok = await refreshConfig();
          if (ok) {
            recordRevision(hostConfig);
            const count = hostConfig?.assignments.length ?? 0;
            const outcome = summarizeConfigRefresh(count);
            await ack(outcome.status, outcome.result);
          } else {
            await ack("failed", "refresh failed (server unreachable)");
          }
          return;
        }
        case "update_daemon": {
          // LAMA-299: remotely initiated update. No payload is honored —
          // the helper targets the latest release via the release proxy
          // and selects only this daemon's own asset. Never honors
          // LAMASYNC_UPDATE_ASSET (that override is CLI-only).
          const outcome = await performDaemonUpdate({
            config: {
              serverUrl: clientConfig.serverUrl,
              apiKey: clientConfig.apiKey,
            },
            getLatestRelease: () => client.getLatestRelease(),
            checkAuth: async () => {
              try {
                await client.getAuthMe();
                return true;
              } catch {
                return false;
              }
            },
            checkRestartAvailable: isSystemdAvailable,
            reconcileUnit: () => reconcileDaemonServiceUnit(),
            downloadAndReplace,
          });
          // LAMA-311: decide the single terminal ack (and whether a restart
          // must follow it) with a pure planner, then delegate the ordering
          // — ack first, restart only after a durable ack — to the testable
          // `runDaemonUpdateAction` helper. The server's completion endpoint
          // is a blind UPDATE plus an `operation_log` insert, so the previous
          // "ack done, restart, ack failed on restart error" sequence wrote
          // two contradictory outcomes for one action.
          await runDaemonUpdateAction(outcome, {
            ack: (status, result) => ack(status, result),
            systemdAvailable: isSystemdAvailable,
            restart: restartDaemonService,
            log: (message) => console.log(message),
            logError: (message) => console.error(message),
            scrub: (message) => scrubForOutcome(message),
          });
          return;
        }
        case "diagnose_folder": {
          // LAMA-345: read-only. Never runs rclone; refreshes the cached deep
          // measurement and reports the richer diagnosis as the ack result.
          const parsed = parseFolderDiagnosePayload(payload);
          if (!parsed.ok) {
            await ack("failed", parsed.error);
            return;
          }
          const target = resolveInterventionTarget(parsed.folderId);
          if (!target.ok) {
            await ack("failed", target.error);
            return;
          }
          const localPath = expandHomePath(target.assignment.localPath);
          const measurement =
            effectiveFolderType(target.folder, target.assignment) === "sync" &&
            existsSync(localPath)
              ? measureLocalTree(localPath)
              : null;
          if (measurement) measurementByFolder.set(parsed.folderId, measurement);
          const diagnosis = diagnoseFolder(
            probeInputsFor(target.assignment, target.folder, true),
          );
          await requestHealthReport?.({ folderIds: [parsed.folderId], readCounts: true });
          const headline = diagnosis.reasons[0];
          await ack(
            "done",
            `${diagnosis.state}: ${headline?.message ?? "no issues found"}${
              headline?.remediation ? ` — ${headline.remediation}` : ""
            }`,
          );
          return;
        }
        case "plan_folder": {
          // LAMA-345: read-only dry run against the real workdir. The plan is
          // stored server-side and its id is the only way to execute the
          // matching intervention. It runs through runOnce so it shares the
          // in-process mutex and the destination lock with a real sync — a dry
          // run must never race a run on the same workdir.
          const parsed = parseFolderPlanRequestPayload(payload);
          if (!parsed.ok) {
            await ack("failed", parsed.error);
            return;
          }
          const target = resolveInterventionTarget(parsed.payload.folderId);
          if (!target.ok) {
            await ack("failed", target.error);
            return;
          }
          const config = hostConfig;
          if (!config) {
            await ack("failed", "no host config cached");
            return;
          }
          const effectiveType = effectiveFolderType(target.folder, target.assignment);
          if (effectiveType !== "sync") {
            await ack("failed", "only sync assignments have a bisync baseline to plan");
            return;
          }
          try {
            const plan = await buildSyncPlan({
              assignment: target.assignment,
              folder: target.folder,
              effectiveType,
              hostConfig: config,
              hostId,
              intervention: parsed.payload.intervention,
              authority: parsed.payload.authority,
              ...(parsed.payload.maxDeletePercent !== undefined
                ? { maxDeletePercent: parsed.payload.maxDeletePercent }
                : {}),
              runDryRun: (runControl) =>
                runOnce(target.assignment, {
                  dryRun: true,
                  bisync: runControl,
                  triggerOrigin: "manual",
                }),
            });
            await client.reportFolderPlan(plan);
            await ack("done", `plan=${plan.id} ${plan.summary}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await ack("failed", `planning failed: ${msg}`);
          }
          return;
        }
        case "folder_intervention": {
          // LAMA-345 stage 3: the only mutating folder action, and the only
          // way to reach it is a reviewed plan plus an explicit authority.
          const parsed = parseFolderInterventionPayload(payload);
          if (!parsed.ok) {
            await ack("failed", parsed.error);
            return;
          }
          const instruction = parsed.payload;
          const target = resolveInterventionTarget(instruction.folderId);
          if (!target.ok) {
            await ack("failed", target.error);
            return;
          }
          if (instruction.intervention === "cancel") {
            const active = activeRuns.get(instruction.folderId);
            if (!active) {
              await ack("done", `nothing to cancel for folder=${instruction.folderId}`);
              return;
            }
            active.abort("cancelled");
            console.log(`[intervention] folder=${instruction.folderId} cancel requested`);
            await ack("done", `cancel requested for folder=${instruction.folderId}`);
            return;
          }
          if (effectiveFolderType(target.folder, target.assignment) !== "sync") {
            await ack("failed", "only sync assignments support baseline interventions");
            return;
          }

          const config = hostConfig;
          if (!config) {
            await ack("failed", "no host config cached");
            return;
          }

          // LAMA-345: guarded interventions must be backed by a plan the
          // operator actually reviewed, and execution is driven by the PLAN's
          // own reviewed semantics — never by the request, which can only be
          // refused. A plan reviewed as "seed from this host at 10%" cannot
          // authorize a remote-authority resync or a 90% threshold.
          let control: BisyncRunControl;
          if (instruction.planId) {
            const stored = await client.getFolderPlan(instruction.planId);
            const plan = stored?.plan ?? null;
            if (!plan) {
              await ack("failed", "the reviewed plan no longer exists — plan again");
              return;
            }
            const stateDir = bisyncStateDir(instruction.folderId);
            const filter = liveFilterFingerprint(
              target.assignment,
              effectiveFolderType(target.folder, target.assignment),
            );
            const verdict = verifyPlanAgainstLive(
              plan,
              {
                assignmentId: target.assignment.id,
                hostId,
                folderId: instruction.folderId,
                configRevision: config.host.configRevision ?? 0,
                filterFingerprint: filter.fingerprint,
                baselineFingerprint: baselineFingerprint(
                  inspectBisyncBaseline(stateDir),
                ),
              },
              {
                intervention: instruction.intervention,
                ...(instruction.authority ? { authority: instruction.authority } : {}),
                ...(instruction.maxDeletePercent !== undefined
                  ? { maxDeletePercent: instruction.maxDeletePercent }
                  : {}),
              },
            );
            if (!verdict.ok || verdict.execution === null) {
              console.warn(
                `[intervention] folder=${instruction.folderId} refused plan=${plan.id}: ${verdict.message}`,
              );
              await ack("failed", `plan refused — ${verdict.message}`);
              return;
            }
            control = runControlFromExecution(verdict.execution);
            // LAMA-345 follow-up (release-blocking): the reviewed plan is the
            // contract, and the invariant is "no unreviewed content
            // mutation" — not "never rebuild a baseline". A plan whose own
            // dry run reported no copies, deletes or directory creation is a
            // legitimate BASELINE-ONLY RECOVERY (the listing pair is missing
            // or unsafe but both sides already agree), so it may run, but
            // ONLY after a fresh dry run with the plan's own reviewed control
            // still proves there is nothing to move. The cachy incident
            // executed 349 transfers from a plan that reported "0 changes";
            // that state change is now caught here. The reviewed authority and
            // deletion threshold are untouched, and a plan with content is
            // still executed exactly as reviewed.
            if (!planHasContentChanges(plan)) {
              const recheck = await runOnce(target.assignment, {
                dryRun: true,
                bisync: control,
                triggerOrigin: "manual",
              });
              const proof = recheckZeroContentExecution(recheck);
              if (!proof.ok) {
                console.warn(
                  `[intervention] folder=${instruction.folderId} refused plan=${plan.id} baseline-only recovery: ${proof.message}`,
                );
                await ack(
                  "failed",
                  proof.reason === "changed"
                    ? `plan refused — the folder changed since the review (${proof.changes?.files ?? 0} file(s) would transfer); plan again for a content run.`
                    : `plan refused — baseline-only recovery could not be re-validated: ${proof.message}`,
                );
                return;
              }
              console.log(
                `[intervention] folder=${instruction.folderId} approved plan=${plan.id} baseline-only recovery (fresh dry run: 0 changes) authority=${control.authority ?? "(none)"} maxDeletePercent=${control.maxDeletePercent ?? "default"}`,
              );
            } else {
              console.log(
                `[intervention] folder=${instruction.folderId} approved plan=${plan.id} intervention=${control.mode} authority=${control.authority ?? "(none)"} maxDeletePercent=${control.maxDeletePercent ?? "default"}`,
              );
            }
          } else {
            // `resume` is the only mutating intervention without a plan: it
            // continues a stopped run and discards no listings.
            control = runControlFor(instruction.intervention, {});
          }
          // LAMA-345: run through runOnce so the intervention takes the same
          // destination lock and in-process mutex as any other run, reports
          // its own operation_log row, and refreshes the assignment health.
          const report = await runOnce(target.assignment, {
            bisync: control,
            triggerOrigin: "manual",
          });
          const outcome = summarizeReportForAction(
            report?.status ?? "failed",
            report?.summary ?? null,
            report
              ? `intervention ${instruction.intervention} finished`
              : "intervention did not run",
          );
          await ack(outcome.status, outcome.result);
          return;
        }
        case "seed_job": {
          // LAMA-346 Stage 2d: run ONE side of an initial seed. This is the
          // shipped daemon's seed path, and it is inert unless the doubly-gated
          // seam is fully open.
          //
          // The runner is imported DYNAMICALLY, after the seam check, so a
          // build that never opens the seam does not even load the relay
          // transport or the S3 store — that reachability is what
          // `seed-transport-bounded.test.ts` asserts from this module graph.
          const parsedSeed = parseSeedJobActionPayload(payload);
          if (!parsedSeed.ok) {
            await ack("failed", parsedSeed.error);
            return;
          }
          if (!seedDaemonE2eEnabled()) {
            await ack(
              "failed",
              "seed execution is not available on this build (the seed seam is off)",
            );
            return;
          }
          const { runSeedAction } = await import("./seed-runner.ts");
          const seedOutcome = await runSeedAction({
            client,
            hostId,
            jobId: parsedSeed.payload.jobId,
            payloadRole: parsedSeed.payload.role,
            getHostConfig: () => hostConfig,
            refreshConfig,
            dataDir: clientConfig.dataDir,
            log: (message) => console.log(message),
          });
          await ack(seedOutcome.status, seedOutcome.result);
          return;
        }
        default: {
          await ack("failed", `unknown action type: ${String(action.type)}`);
          return;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[action] ${action.type} (${action.id}) threw: ${msg}`);
      await ack("failed", msg);
    }
  }

  /**
   * LAMA-345 follow-up: the 30 s action timer must not stack polls. A long
   * plan/intervention keeps the previous poll awaiting; without this guard a
   * re-entrant poll claimed the same reclaimed row and ran it a second time.
   */
  let pollingActions = false;
  async function pollActions(): Promise<void> {
    if (pollingActions) return;
    pollingActions = true;
    try {
      let pending: QueuedAction[];
      try {
        pending = await client.listPendingActions(hostId, 10);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[action] poll failed: ${msg}`);
        return;
      }
      if (pending.length === 0) return;
      console.log(`[action] claimed ${pending.length} action(s)`);
      for (const action of pending) {
        await executeAction(action);
      }
    } finally {
      pollingActions = false;
    }
  }

  const scheduler = new Scheduler({
    onTick: (assignment) => {
      // Fire-and-forget the actual sync; the scheduler contract is void.
      void runOnce(assignment, { triggerOrigin: "schedule" });
    },
    getAssignments: () => hostConfig?.assignments ?? [],
    getFolders: () => hostConfig?.folders ?? [],
    getApps: () => hostConfig?.apps ?? [],
    onAppTick: (app) => {
      void runAppOnce(app, { triggerOrigin: "schedule" });
    },
    // LAMA-273: scheduler skips scheduled runs while the effective pause
    // window is active (host row if present, else global row). Resolved
    // server-side; the daemon just reads the cached `hostConfig.pause`.
    getEffectivePause: () => hostConfig?.pause ?? null,
  });

  // LAMA-302: event-triggered sync watch coordinator. Linux-first (inotify
  // via `fs.watch`); on other platforms a no-op factory keeps reconcile()
  // uniform and the feature inert (watches are default-off regardless).
  const watchFactory =
    process.platform === "linux"
      ? createLinuxInotifyFactory()
      : { start: () => ({ close() {} }) };
  const watchCoordinator = new WatchCoordinator({
    factory: watchFactory,
    getAssignments: () => hostConfig?.assignments ?? [],
    getFolders: () => hostConfig?.folders ?? [],
    runOnce: async (assignment) => {
      // The daemon's runOnce returns a report (or null); the watch controller
      // only needs to know when it settles.
      await runOnce(assignment, { triggerOrigin: "watch" });
    },
    log: (msg) => console.log(msg),
  });

  // LAMA-345: the health reporter. Lightweight by default (the heartbeat
  // path); `readCounts` and `measure` are opt-in and only used after a run or
  // for an explicit diagnose. Failures are logged at most once per call and
  // never block the run that triggered them.
  const watcherFactsFor = (assignment: FolderAssignment) => ({
    enabled: assignment.watchEnabled === true,
    running: watchCoordinator.isRunning(assignment.id),
    quietSec: resolveWatchQuietSec(assignment.watchQuietSec ?? null),
  });

  const probeInputsFor = (
    assignment: FolderAssignment,
    folder: Folder,
    readCounts: boolean,
    rcloneAvailable: boolean = Bun.which("rclone") !== null,
  ) => ({
    assignment,
    effectiveType: effectiveFolderType(folder, assignment),
    enabled: assignment.enabled !== false,
    paused: isPauseActive(hostConfig?.pause ?? null),
    runInProgress: activeRuns.has(assignment.folderId),
    activePhase: null,
    rcloneAvailable,
    pendingConflicts: 0,
    watcher: watcherFactsFor(assignment),
    lastRun: lastRunByFolder.get(assignment.folderId) ?? null,
    measurement: measurementByFolder.get(assignment.folderId) ?? null,
    readCounts,
  });

  /** Resolve one folder id to this host's assignment, or explain the failure. */
  const resolveInterventionTarget = (
    folderId: string,
  ):
    | { ok: true; assignment: FolderAssignment; folder: Folder }
    | { ok: false; error: string } => {
    const assignment = (hostConfig?.assignments ?? []).find(
      (a) => a.folderId === folderId,
    );
    if (!assignment) {
      return { ok: false, error: `folderId=${folderId} is not assigned to this host` };
    }
    const folder = (hostConfig?.folders ?? []).find((f) => f.id === folderId);
    if (!folder) {
      return { ok: false, error: `folderId=${folderId} is unknown to this host` };
    }
    return { ok: true, assignment, folder };
  };

  requestHealthReport = async (opts) => {
    const assignments = hostConfig?.assignments ?? [];
    const folders = hostConfig?.folders ?? [];
    const folderFilter = opts?.folderIds ? new Set(opts.folderIds) : null;
    // Resolved once per report pass, not once per assignment.
    const rcloneAvailable = Bun.which("rclone") !== null;
    for (const assignment of assignments) {
      if (folderFilter !== null && !folderFilter.has(assignment.folderId)) continue;
      const folder = folders.find((f) => f.id === assignment.folderId);
      if (!folder) continue;
      const effectiveType = effectiveFolderType(folder, assignment);
      const localPath = expandHomePath(assignment.localPath);
      if (opts?.measure === true && effectiveType === "sync" && existsSync(localPath)) {
        try {
          measurementByFolder.set(assignment.folderId, measureLocalTree(localPath));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[health] folder=${assignment.folderId} measurement failed: ${msg}`);
        }
      }
      const probe = probeFolderHealth(
        probeInputsFor(assignment, folder, opts?.readCounts === true, rcloneAvailable),
      );
      try {
        await client.reportFolderHealth(probe.report);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[health] folder=${assignment.folderId} report failed: ${msg}`);
      }
    }
  };

  setSwitchContext({
    // LAMA-239: thread the daemon's hostId into the switch context so the
    // switches can flip THIS host's mode via the per-host API instead of
    // touching the global folder.type.
    hostId,
    acquireLock: (folderId) => acquireLock(client, folderId, hostId),
    releaseLock: (folderId, status, summary) => releaseLock(client, folderId, hostId, status, summary),
    runOnce: async (assignment) => {
      // Switch context doesn't care about the return value either.
      await runOnce(assignment);
    },
    getHostConfig: () => hostConfig,
    getRemoteName,
    startMount: systemdAwareStartMount,
    stopMount: systemdAwareStopMount,
    // LAMA-239: replace updateFolderType with the per-host mode setter.
    updateAssignmentMode: (folderId, hostId, mode) =>
      client.updateAssignment(folderId, hostId, { mode }),
  });

  try {
    const tailnetIp = await detectTailnetIp();
    await client.registerHost({
      id: hostId,
      hostname: hostId,
      tailnetIp,
    });
    const lanIp = getLocalLanIp();
    await client.reportHealth({
      hostId,
      timestamp: Date.now(),
      status: "online",
      lanIp,
      tailnetIp: tailnetTracker.value(tailnetIp, Date.now()),
      version: VERSION,
      os: osLabel(),
      storageUsedBytes: storageUsedBytes(clientConfig.dataDir),
      hostClass: detectHostClass(readHostClassFacts()),
    });
    lastHeartbeatAt = Date.now();
    await reportQueue.flush();
    console.log(`[boot] registered and reported online host=${hostId} lanIp=${lanIp ?? "(none)"} tailnetIp=${tailnetIp ?? "(none)"}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[boot] initial registration failed: ${msg}`);
  }

  await releaseStaleLocks(client, hostId);

  if (!hostConfig) {
    await refreshConfig();
    recordRevision(hostConfig);
  } else {
    recordRevision(hostConfig);
    // LAMA-241: surface missing local paths right after boot even when the
    // config came from the cache (no refresh has happened yet).
    warnMissingLocalPaths();
    scheduler.start();
  }
  // LAMA-302: bring up watch controllers for eligible assignments at boot.
  watchCoordinator.reconcile();
  // LAMA-239: reconcile mounts against the effective type on boot too, so
  // a daemon restart picks up a web-UI-set override without needing a
  // 5-min refresh. (refreshConfig() above already triggers one for the
  // fresh-boot path; this covers the cached-config path.)
  void reconcileMountsOnRefresh(() => hostConfig);
  // LAMA-345: one health report at boot so the Folders page has assignment
  // state immediately instead of waiting for the first 30 s heartbeat.
  void requestHealthReport?.({ readCounts: true });

  // LAMA-345 follow-up: keep the leases of in-flight actions alive. A
  // Projects-scale plan/intervention can run far longer than the 10-minute
  // lease, and the server's reaper would otherwise flip the row back to
  // 'pending' mid-run so another poll could re-execute it. This timer shares
  // the event loop with the awaited rclone child, so it fires during the run.
  // It is started BEFORE the boot reclaim below, so an intervention reclaimed
  // at boot is covered too.
  const actionLeaseTimer = setInterval(() => {
    for (const id of inFlightActions) {
      void (async () => {
        try {
          await client.renewActionLease(id);
        } catch (err) {
          // A 409 means the lease was already lost (reclaimed or completed);
          // the run itself is left alone, but the operator can see why.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[action] lease renewal failed for ${id}: ${msg}`);
        }
      })();
    }
  }, ACTION_LEASE_RENEW_INTERVAL_MS);
  actionLeaseTimer.unref?.();

  // LAMA-232: actions the previous daemon incarnation claimed but never
  // acked are stuck in 'taken'. A freshly booted daemon has no in-flight
  // work, so reclaiming and re-executing them is safe. The server's
  // periodic reaper (inside GET /actions/pending) covers the case where a
  // running daemon's execution silently died.
  try {
    const orphaned = await client.listTakenActions(hostId);
    if (orphaned.length > 0) {
      console.log(
        `[action] reclaiming ${orphaned.length} orphaned taken action(s) at boot`,
      );
      for (const action of orphaned) {
        await executeAction(action);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[action] boot reclaim failed: ${msg}`);
  }
  // LAMA-232: drain the queue immediately instead of waiting for the first
  // 30 s poll tick.
  void pollActions();
  // One-shot update check on startup. Never throws — just logs. Routed
  // through the server's cached release proxy (LAMA-243) and gated by the
  // persisted cooldown so a crash loop can't re-fire it every restart.
  try {
    const now = Date.now();
    if (!withinUpdateCooldown(now)) {
      markUpdateCheckAttempted(now);
      const latest = await client.getLatestRelease();
      if (latest && isNewer(VERSION, latest.version)) {
        console.log(
          `[update] newer release available: ${latest.tag} (current: v${VERSION})`,
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[update] startup check failed: ${msg}`);
  }

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    void (async () => {
      try {
        const tailnetIp = await detectTailnetIp();
        await client.reportHealth({
          hostId,
          timestamp: now,
          status: "online",
          lanIp: getLocalLanIp(),
          tailnetIp: tailnetTracker.value(tailnetIp, now),
          version: VERSION,
          os: osLabel(),
          storageUsedBytes: storageUsedBytes(clientConfig.dataDir),
          hostClass: detectHostClass(readHostClassFacts()),
        });
        lastHeartbeatAt = now;
        await reportQueue.flush();

        // LAMA-345: lightweight assignment health rides the heartbeat. It is
        // stat/readdir only — never a tree walk (the deep measurement is
        // refreshed after a run or on an explicit diagnose).
        await requestHealthReport?.();

        // LAMA-198: config-revision check on every heartbeat. If the
        // server's revision has moved past what we last cached, pull a
        // fresh /config/:hostId without waiting for the 5-min timer.
        try {
          const serverHost = await client.getHost(hostId);
          const serverRev = serverHost.configRevision ?? 0;
          if (lastSeenRevision === null || serverRev > lastSeenRevision) {
            console.log(
              `[config] revision drift (cached=${lastSeenRevision ?? "(none)"} server=${serverRev}); refreshing`,
            );
            await refreshConfig();
            recordRevision(hostConfig);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[config] revision check failed: ${msg}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[heartbeat] failed: ${msg}`);
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // LAMA-198: action poller. Aligned with the heartbeat cadence so a single
  // out-of-band refresh covers both heartbeats and action queue draining.
  const actionTimer = setInterval(() => {
    void pollActions();
  }, HEARTBEAT_INTERVAL_MS);
  actionTimer.unref?.();

  const refreshTimer = setInterval(() => {
    void refreshConfig();
    recordRevision(hostConfig);
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
          // LAMA-241: report failure back to the socket client instead of
          // silently succeeding — `{"cmd":"sync","folder":"..."}` used to
          // return started:true with a log-only error.
          console.warn(`[socket] sync requested for unknown folder=${folderId} after refresh`);
          return false;
        }
      }
      void runOnce(assignment, { triggerOrigin: "manual" });
      return true;
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
        void runOnce(assignment, { triggerOrigin: "manual" });
      }
    },
   });
  console.log(`[socket] listening at ${socketPath}`);

  startMountHealthChecks();

  const shutdown = (signal: string): void => {
    console.log(`lamasyncd received ${signal}, shutting down`);
    scheduler.stop();
    // LAMA-302: stop every watch controller (closes watcher handles + timers).
    watchCoordinator.shutdown();
    socketServer.close();
    void stopAllMounts();
    clearInterval(heartbeatTimer);
    clearInterval(actionTimer);
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
  // LAMA-309: expand assignment local paths so the mount point (used
  // directly by startMount below) is absolute.
  hostConfig = expandConfigPaths(hostConfig);

  const folder = hostConfig.folders.find((f) => f.id === folderId);
  const assignment = hostConfig.assignments.find((a) => a.folderId === folderId);
  if (!folder || !assignment) {
    console.error(`[mount-cmd] folder=${folderId} not configured on this host`);
    process.exit(1);
  }

  const { configPath, cleanup } = writeRcloneConfig(hostConfig.rcloneConfig);
  const remotePath = `${getRemoteName(assignment.remoteName, folderId)}:${resolveDestination(folder, assignment)}`;
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
      // LAMA-345: the persistent mount unit runs `lamasyncd --mount <id>`, so
      // this is where the reviewed cache mode actually reaches the mount.
      cacheMode: assignment.mountCacheMode ?? null,
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
// LAMA-242: --help / -h print, --version print, and unknown-flag guard.
// Comes before the operational dispatch (--check-update / --update /
// --update skill / --mount) so a typo never silently boots the daemon.
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(daemonUsage());
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-V")) {
    console.log(`lamasyncd ${VERSION}`);
    process.exit(0);
  }

  // Unknown-flag guard: reject any `-`-prefixed token that isn't a known
  // flag. `--mount=<id>` is a token-shaped flag with an inline value; let it
  // through the prefix exception so `--mount=foo` doesn't trip the guard.
  // Bare positionals (the `skill` after `--update`, the `<folderId>` after
  // `--mount`) don't start with `-` so they're not flagged here either.
  if (
    args.some(
      (a) =>
        a.startsWith("-") &&
        !a.startsWith("--mount=") &&
        !DAEMON_KNOWN_FLAGS.has(a),
    )
  ) {
    console.error(daemonUsage());
    process.exit(2);
  }

  // --check-update flag: print latest release vs current, exit. Routed
  // through the server's cached release proxy (LAMA-243) and gated by the
  // persisted cooldown so a crash loop can't re-fire it every restart.
  if (process.argv.includes("--check-update")) {
    (async () => {
      const config = loadConfig();
      const client = new LamaSyncApiClient(config.serverUrl, config.apiKey);
      const now = Date.now();
      if (withinUpdateCooldown(now)) {
        console.log(
          `lamasyncd --check-update: skipped (cooldown, last check < ${Math.round(UPDATE_CHECK_COOLDOWN_MS / 60000)}m ago)`,
        );
        process.exit(0);
      }
      markUpdateCheckAttempted(now);
      const latest = await client.getLatestRelease();
      if (!latest) {
        console.error("lamasyncd --check-update: unable to reach the release proxy");
        process.exit(1);
      }
      const skillVersion = readInstalledSkillVersion();
      console.log(
        `agent skill: ${skillVersion ? `v${skillVersion}` : "not installed"} (${SKILL_DIR})`,
      );
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
  } else if (process.argv.includes("--update") && process.argv.includes("skill")) {
    // --update skill flag (LAMA-230): refresh ~/.agents/skills/lamasync/ from
    // the GitHub release whose version matches the local binary. Cross-version
    // drift is rejected on purpose — the skill ships lockstep with the binary.
    (async () => {
      const located = await locateSkillAsset();
      if (!located) {
        console.error(
          `lamasyncd --update skill: no lamasync-skill-${VERSION}.tar.gz in release v${VERSION}`,
        );
        process.exit(1);
      }
      const asset = located.release.assets.find((a) => a.name === located.assetName);
      if (!asset) {
        console.error(`lamasyncd --update skill: release missing ${located.assetName}`);
        process.exit(1);
      }
      const ok = await downloadSkillBundle(asset.downloadUrl);
      if (!ok) {
        console.error("lamasyncd --update skill: download/extract failed");
        process.exit(1);
      }
      console.log(
        `lamasyncd --update skill: refreshed ${SKILL_DIR} to ${located.assetName} (release ${located.release.tag})`,
      );
      process.exit(0);
    })().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`lamasyncd --update skill failed: ${msg}`);
      process.exit(1);
    });
  } else if (process.argv.includes("--update")) {
    // --update flag (refactored for LAMA-299): the same injected helper the
    // remote `update_daemon` action uses, but operator-initiated — so the
    // LAMASYNC_UPDATE_ASSET override and a systemd-free environment are
    // allowed here, and no restart is requested.
    (async () => {
      // LAMA-311: the local unit migration must not depend on a readable
      // client.toml. Without a config there is nothing to update server-side,
      // but the unit can still be reconciled — and on a client whose old unit
      // sandbox is effective, `lamasyncd --update` from a shell is the only
      // path that can do it. So reconcile first, report it, then exit non-zero
      // for the missing config.
      let config: ReturnType<typeof loadConfig> | null = null;
      let configError: string | null = null;
      try {
        config = loadConfig();
      } catch (err) {
        configError = err instanceof Error ? err.message : String(err);
      }
      if (!config) {
        const note = summarizeUnitReconcile(reconcileDaemonServiceUnit());
        console.error(`lamasyncd --update failed: ${configError}`);
        if (note) console.error(`lamasyncd --update: ${note}`);
        process.exit(1);
      }
      const client = new LamaSyncApiClient(config.serverUrl, config.apiKey);
      const outcome = await performDaemonUpdate({
        config: { serverUrl: config.serverUrl, apiKey: config.apiKey },
        getLatestRelease: () => client.getLatestRelease(),
        checkAuth: async () => {
          try {
            await client.getAuthMe();
            return true;
          } catch {
            return false;
          }
        },
        // The CLI does not restart the service — the operator does.
        checkRestartAvailable: () => true,
        // LAMA-311: reconcile a stale systemd user unit even when the binary
        // is already current. This path runs outside the daemon's sandbox, so
        // it is the one that can rewrite a unit whose explicit
        // ProtectHome=read-only makes ~/.config/systemd/user read-only for the
        // running daemon.
        reconcileUnit: () => reconcileDaemonServiceUnit(),
        downloadAndReplace,
        envAssetName: process.env.LAMASYNC_UPDATE_ASSET,
      });
      // The operator restarts the service, so do not claim a restart here.
      const unitNote = summarizeUnitReconcile(outcome.unit);
      if (!outcome.ok) {
        console.error(`lamasyncd --update: ${outcome.phase}: ${outcome.summary}`);
        if (unitNote) console.error(`lamasyncd --update: ${unitNote}`);
        process.exit(1);
      }
      if (!outcome.changed) {
        console.log(`lamasyncd --update: already at latest (v${outcome.currentVersion})`);
        if (unitNote) console.log(`lamasyncd --update: ${unitNote}`);
        // A unit that could not be reconciled (sandboxed daemon, unwritable
        // unit path) leaves the client unreconciled: non-zero so scripts and
        // agents notice, with the exact manual command already printed.
        process.exit(outcome.unit?.status === "failed" ? 1 : 0);
      }
      console.log(
        `lamasyncd --update: replaced ${resolveSelfBinaryPath()} with ${outcome.asset} ` +
          `(now v${outcome.latestVersion}; restart the service to pick it up)`,
      );
      if (unitNote) console.log(`lamasyncd --update: ${unitNote}`);
      process.exit(outcome.unit?.status === "failed" ? 1 : 0);
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
