import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { isNewer, type Host, type HostStatus } from "@lamasync/core";
import { db as defaultDb } from "../db.ts";
import { broadcast } from "../ws.ts";
import { getCachedLatestVersion } from "../release-cache.ts";

// Test seam: mirrors the pattern used by every other route file in this
// directory so unit tests can substitute the production DB.
let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

interface HostRow {
  id: string;
  hostname: string;
  tailnet_ip: string | null;
  last_seen: number | null;
  status: string | null;
  lan_ip: string | null;
  version: string | null;
}

/**
 * Map a `hosts` row into the wire/UI `Host` shape. `latestVersion` is the
 * latest GitHub release version (cached); the caller resolves it once per
 * request so the comparison is consistent across all hosts in that response.
 */
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

const HOST_SELECT = "SELECT id, hostname, tailnet_ip, last_seen, status, lan_ip, version FROM hosts";

export const hostsRoutes = new Elysia({ prefix: "/api/v1" })
  .post(
    "/register",
    async ({ body, set }) => {
      const { id, hostname, tailnetIp } = body as {
        id: string;
        hostname: string;
        tailnetIp?: string | null;
      };
      const now = Date.now();
      activeDb.run(
        `INSERT INTO hosts (id, hostname, tailnet_ip, last_seen, status)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           hostname = excluded.hostname,
           tailnet_ip = excluded.tailnet_ip,
           last_seen = excluded.last_seen,
           status = excluded.status`,
        [id, hostname, tailnetIp ?? null, now, "online"],
      );
      const row = activeDb
        .query<HostRow, [string]>(`${HOST_SELECT} WHERE id = ?`)
        .get(id);
      if (!row) {
        set.status = 500;
        return { error: "Failed to load host after insert" };
      }
      const latestVersion = await getCachedLatestVersion();
      const host = rowToHost(row, latestVersion);
      broadcast({ kind: "host", host });
      set.status = 201;
      return host;
    },
    {
      body: t.Object({
        id: t.String(),
        hostname: t.String(),
        tailnetIp: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary: "Register a new host (or update existing)",
        tags: ["Hosts"],
        responses: {
          201: { description: "Host registered" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
.delete(
    "/hosts/:hostId",
    ({ params, set }) => {
      const result = activeDb.run("DELETE FROM hosts WHERE id = ?", [params.hostId]);
      if (result.changes === 0) {
        set.status = 404;
        return { error: "Host not found" };
      }
      activeDb.run("DELETE FROM folder_assignments WHERE host_id = ?", [params.hostId]);
      const manifestIds = activeDb
        .query<{ id: string }, [string]>(
          "SELECT id FROM dotfile_manifests WHERE host_id = ?",
        )
        .all(params.hostId)
        .map((r) => r.id);
      if (manifestIds.length > 0) {
        const placeholders = manifestIds.map(() => "?").join(",");
        activeDb.run(
          `DELETE FROM dotfile_versions WHERE manifest_id IN (${placeholders})`,
          manifestIds,
        );
      }
      activeDb.run("DELETE FROM dotfile_manifests WHERE host_id = ?", [params.hostId]);
      set.status = 204;
      return null;
    },
    {
      params: t.Object({ hostId: t.String() }),
      detail: {
        summary: "Delete a host and cascade its data",
        tags: ["Hosts"],
        responses: {
          204: { description: "Host removed" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/report/health",
    async ({ body, set }) => {
      const { hostId, timestamp, status, lanIp, version } = body as {
        hostId: string;
        timestamp: number;
        status: HostStatus;
        lanIp?: string | null;
        version?: string | null;
      };
      // Follow the existing `lanIp` pattern: only overwrite the column when
      // the heartbeat actually carries a truthy value. A heartbeat without
      // `version` (older daemons, transient blanks) preserves whatever the
      // daemon reported last so the dashboard's Version column doesn't
      // flicker.
      const sets: string[] = ["last_seen = ?", "status = ?"];
      const params: (string | number | null)[] = [timestamp, status];
      if (lanIp) {
        sets.push("lan_ip = ?");
        params.push(lanIp);
      }
      if (typeof version === "string" && version.length > 0) {
        sets.push("version = ?");
        params.push(version);
      }
      params.push(hostId);
      const result = activeDb.run(
        `UPDATE hosts SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );
      if (result.changes === 0) {
        set.status = 404;
        return { error: `Host '${hostId}' not registered` };
      }
      const row = activeDb
        .query<HostRow, [string]>(`${HOST_SELECT} WHERE id = ?`)
        .get(hostId);
      if (row) {
        const latestVersion = await getCachedLatestVersion();
        broadcast({ kind: "host", host: rowToHost(row, latestVersion) });
      }
      set.status = 204;
      return null;
    },
    {
      body: t.Object({
        hostId: t.String(),
        timestamp: t.Number(),
        status: t.Union([
          t.Literal("online"),
          t.Literal("offline"),
          t.Literal("degraded"),
          t.Literal("unknown"),
        ]),
        lanIp: t.Optional(t.Union([t.String(), t.Null()])),
        version: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary: "Update host heartbeat",
        tags: ["Hosts"],
        responses: {
          204: { description: "Health updated" },
          404: { description: "Host not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );
