import { Elysia } from "elysia";
import { statSync } from "node:fs";
import {
  VERSION,
  isNewer,
  type Host,
  type HostStatus,
} from "@lamasync/core";
import { db, dbFilePath } from "../db.ts";
import { getCachedLatestVersion } from "../release-cache.ts";

interface HostRow {
  id: string;
  hostname: string;
  tailnet_ip: string | null;
  last_seen: number | null;
  status: string | null;
  lan_ip: string | null;
  version: string | null;
}

function rowToHost(row: HostRow, latestVersion: string | null): Host {
  const version = row.version;
  const updateAvailable =
    typeof version === "string" && version.length > 0 && latestVersion !== null
      ? isNewer(version, latestVersion)
      : false;
  return {
    id: row.id,
    hostname: row.hostname,
    tailnetIp: row.tailnet_ip,
    lanIp: row.lan_ip,
    lastSeen: row.last_seen,
    status: (row.status ?? "unknown") as HostStatus,
    version,
    updateAvailable,
  };
}

export const healthRoutes = new Elysia({ prefix: "/api/v1" }).get(
  "/health",
  async () => {
    const rows = db
      .query<HostRow, []>(
        "SELECT id, hostname, tailnet_ip, last_seen, status, lan_ip, version FROM hosts",
      )
      .all();
    // Resolve the cached latest release once so the comparison is
    // consistent across all hosts in this response (mirrors hosts.ts).
    const latestVersion = await getCachedLatestVersion();
    const hosts = rows.map((row) => rowToHost(row, latestVersion));
    const onlineCount = hosts.filter((h) => h.status === "online").length;
    // UX workstream 4: server self-description for the Admin page. The DB
    // size stat is best-effort (in-memory test DBs have no backing file).
    let dbSizeBytes: number | null = null;
    try {
      dbSizeBytes = statSync(dbFilePath()).size;
    } catch {
      dbSizeBytes = null;
    }
    return {
      status: "ok" as const,
      hostCount: hosts.length,
      onlineCount,
      hosts,
      serverVersion: VERSION,
      dbSizeBytes,
    };
  },
  {
    detail: {
      summary: "Fleet health summary",
      tags: ["Health"],
      responses: {
        200: { description: "Fleet status with host list" },
        401: { description: "Unauthorized" },
      },
    },
  },
);
