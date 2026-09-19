// LAMA-345 follow-up — server-side fleet-health reads and the ONE host
// serialization.
//
// Three copies of `rowToHost` used to exist (routes/hosts.ts, routes/health.ts,
// notifications.ts) and each computed `updateAvailable` from
// `isNewer(hostVersion, latestVersion)` alone. This module is the single
// definition they now share, so the Dashboard, the Hosts page, HostDetail, the
// `/health` route and the notification sweeps cannot disagree — in particular
// about whether an "update available" claim is supported by evidence.

import type { Database } from "bun:sqlite";
import {
  deriveFleetHealth,
  deriveUpdateStatus,
  FOLDER_HEALTH_STALE_MS,
  type FleetHealthFolderInput,
  type FleetHealthHostInput,
  type FleetHealthSummary,
  type FolderHealthReason,
  type Host,
  type HostClass,
  type HostStatus,
  type UpdateStatus,
} from "@lamasync/core";

/** The `hosts` columns every caller reads. */
export interface HostRowLike {
  id: string;
  hostname: string;
  tailnet_ip: string | null;
  last_seen: number | null;
  status: string | null;
  lan_ip: string | null;
  version: string | null;
  config_revision?: number | null;
  os?: string | null;
  storage_used_bytes?: number | null;
  host_class: string | null;
}

const VALID_HOST_CLASSES: readonly string[] = [
  "server",
  "desktop",
  "laptop",
  "nas",
  "phone",
  "tablet",
  "unknown",
];

const VALID_HOST_STATUSES: readonly string[] = ["online", "offline", "degraded", "unknown"];

export function hostClassFromRow(value: string | null | undefined): HostClass {
  const v = value ?? "";
  return VALID_HOST_CLASSES.includes(v) ? (v as HostClass) : "unknown";
}

export function hostStatusFromRow(value: string | null | undefined): HostStatus {
  const v = value ?? "";
  return VALID_HOST_STATUSES.includes(v) ? (v as HostStatus) : "unknown";
}

/** The release facts needed to evaluate an update, resolved once per request. */
export interface ReleaseFacts {
  version: string;
  publishedAt: string | number | null;
}

/** Build release facts from the cached latest release (or null). */
export function releaseFactsFrom(
  release: { version: string; publishedAt: string | number | null } | null | undefined,
): ReleaseFacts | null {
  if (!release || typeof release.version !== "string" || release.version.length === 0) {
    return null;
  }
  return { version: release.version, publishedAt: release.publishedAt ?? null };
}

/**
 * The single host serialization. `updateStatus` is the evidence-based verdict;
 * `updateAvailable` mirrors it so older clients keep working unchanged.
 */
export function hostFromRow(
  row: HostRowLike,
  release: ReleaseFacts | null,
  now: number = Date.now(),
): Host {
  const updateStatus: UpdateStatus = deriveUpdateStatus({
    currentVersion: row.version,
    lastSeen: row.last_seen,
    releaseVersion: release?.version ?? null,
    releasePublishedAt: release?.publishedAt ?? null,
  });
  return {
    id: row.id,
    hostname: row.hostname,
    tailnetIp: row.tailnet_ip,
    lanIp: row.lan_ip,
    lastSeen: row.last_seen,
    status: hostStatusFromRow(row.status),
    version: row.version,
    updateAvailable: updateStatus.kind === "available",
    updateStatus,
    configRevision: row.config_revision ?? 0,
    os: row.os ?? null,
    storageUsedBytes: row.storage_used_bytes ?? null,
    hostClass: hostClassFromRow(row.host_class),
  };
}

/** Convenience for the notification sweep, which only needs the verdict. */
export function updateStatusForRow(
  row: Pick<HostRowLike, "version" | "last_seen">,
  release: ReleaseFacts | null,
): UpdateStatus {
  return deriveUpdateStatus({
    currentVersion: row.version,
    lastSeen: row.last_seen,
    releaseVersion: release?.version ?? null,
    releasePublishedAt: release?.publishedAt ?? null,
  });
}

// ---------------------------------------------------------------------------
// Fleet summary read
// ---------------------------------------------------------------------------

const HOSTS_SELECT = `SELECT id, hostname, tailnet_ip, last_seen, status, lan_ip, version,
       config_revision, os, storage_used_bytes, host_class
  FROM hosts`;

interface HealthFolderRow {
  folder_id: string;
  host_id: string;
  state: string;
  reasons: string;
  reported_at: number;
  folder_name: string | null;
  host_name: string | null;
  host_status: string | null;
  host_class: string | null;
  host_last_seen: number | null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function reasonCodes(value: unknown): FolderHealthReason[] {
  if (!Array.isArray(value)) return [];
  const out: FolderHealthReason[] = [];
  for (const entry of value.slice(0, 6)) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const code = rec["code"];
    if (typeof code !== "string") continue;
    const action = rec["action"];
    out.push({
      code: code as FleetHealthFolderInput["reasons"][number]["code"],
      message: typeof rec["message"] === "string" ? rec["message"] : code,
      remediation: typeof rec["remediation"] === "string" ? rec["remediation"] : "",
      action: typeof action === "string" ? (action as FleetHealthFolderInput["reasons"][number]["action"]) : null,
    });
  }
  return out;
}

/**
 * Read everything the summary needs in two bounded queries.
 *
 * `stale` is decided by the shared staleness budget (`FOLDER_HEALTH_STALE_MS`)
 * rather than by trusting the daemon's own report, so a device that stopped
 * reporting cannot keep its folders looking current.
 */
export function readFleetHealth(
  database: Database,
  options: { release: ReleaseFacts | null; now?: number } = { release: null },
): FleetHealthSummary {
  const now = options.now ?? Date.now();

  const hostRows = database.query<HostRowLike, []>(HOSTS_SELECT).all();
  const hosts: FleetHealthHostInput[] = hostRows.map((row) => ({
    id: row.id,
    hostname: row.hostname,
    hostClass: hostClassFromRow(row.host_class),
    status: hostStatusFromRow(row.status),
    lastSeen: row.last_seen,
    updateStatus: updateStatusForRow(row, options.release),
  }));

  const folderRows = database
    .query<HealthFolderRow, []>(
      `SELECT h.folder_id, h.host_id, h.state, h.reasons, h.reported_at,
              f.name AS folder_name,
              ho.hostname AS host_name,
              ho.status AS host_status,
              ho.host_class AS host_class,
              ho.last_seen AS host_last_seen
         FROM folder_health h
         LEFT JOIN folders f ON f.id = h.folder_id
         LEFT JOIN hosts ho ON ho.id = h.host_id`,
    )
    .all();

  const folders: FleetHealthFolderInput[] = folderRows.map((row) => ({
    folderId: row.folder_id,
    folderName: row.folder_name ?? row.folder_id,
    hostId: row.host_id,
    hostName: row.host_name ?? row.host_id,
    hostClass: hostClassFromRow(row.host_class),
    hostStatus: hostStatusFromRow(row.host_status),
    hostLastSeen: row.host_last_seen,
    state: row.state as FleetHealthFolderInput["state"],
    reasons: reasonCodes(safeParse(row.reasons)),
    // The shared budget, not the daemon's own opinion: a device that stopped
    // reporting cannot keep its folders looking current.
    stale: now - row.reported_at > FOLDER_HEALTH_STALE_MS,
  }));

  return deriveFleetHealth({ hosts, folders, now });
}
