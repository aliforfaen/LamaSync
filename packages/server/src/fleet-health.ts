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
  type FleetHealthFolderInput,
  type FleetHealthHostInput,
  type FleetHealthSummary,
  type Host,
  type HostClass,
  type HostStatus,
  type UpdateStatus,
} from "@lamasync/core";
import { loadDerivedFolderHealth } from "./folder-health.ts";

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

/**
 * Coerce a stored `hosts.host_class` into the wire union.
 *
 * An explicit switch, not a membership check plus a cast: the switch narrows
 * the string to the literal union for the compiler, so an unknown value cannot
 * slip through and no `as` is needed (AGENTS.md forbids both `any` and inline
 * casts).
 */
export function hostClassFromRow(value: string | null | undefined): HostClass {
  switch (value) {
    case "server":
    case "desktop":
    case "laptop":
    case "nas":
    case "phone":
    case "tablet":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

/** Same shape for `hosts.status`; anything unrecognised reads as `unknown`. */
export function hostStatusFromRow(value: string | null | undefined): HostStatus {
  switch (value) {
    case "online":
    case "offline":
    case "degraded":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
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

/**
 * Read everything the summary needs: the hosts, the folder names, and the
 * shared derived health records (stale decided by the shared staleness budget,
 * never by the daemon's own opinion).
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

  // ONE read path: the same normalized/re-derived records the folder detail page
  // and the plans routes use. Reading the stored `state` column here instead
  // made the dashboard and the folder card disagree about the same folder.
  const healthRecords = loadDerivedFolderHealth(database, now);

  const folderNames = new Map<string, string>();
  for (const row of database
    .query<{ id: string; name: string }, []>("SELECT id, name FROM folders")
    .all()) {
    folderNames.set(row.id, row.name);
  }
  const hostRowsById = new Map(hostRows.map((row) => [row.id, row]));

  const folders: FleetHealthFolderInput[] = healthRecords.map((record) => {
    const hostRow = hostRowsById.get(record.hostId);
    return {
      folderId: record.folderId,
      folderName: folderNames.get(record.folderId) ?? record.folderId,
      hostId: record.hostId,
      hostName: hostRow?.hostname ?? record.hostId,
      hostClass: hostClassFromRow(hostRow?.host_class),
      hostStatus: hostStatusFromRow(hostRow?.status),
      hostLastSeen: hostRow?.last_seen ?? null,
      state: record.state,
      reasons: record.reasons,
      stale: record.stale,
    };
  });

  return deriveFleetHealth({ hosts, folders, now });
}
