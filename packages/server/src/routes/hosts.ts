import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { isNewer, type Host, type HostStatus } from "@lamasync/core";
import { db as defaultDb } from "../db.ts";
import { broadcast } from "../ws.ts";
import { getCachedLatestVersion } from "../release-cache.ts";
import {
  bumpConfigRevision,
  bumpConfigRevisionForPeers,
} from "../config-revision.ts";
import {
  __setDb as __setNotificationDb,
  emitNotification,
} from "../notifications.ts";

// Test seam: mirrors the pattern used by every other route file in this
// directory so unit tests can substitute the production DB.
let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
  __setNotificationDb(next);
}

interface HostRow {
  id: string;
  hostname: string;
  tailnet_ip: string | null;
  last_seen: number | null;
  status: string | null;
  lan_ip: string | null;
  version: string | null;
  config_revision: number | null;
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
    configRevision: row.config_revision ?? 0,
  };
}

const HOST_SELECT = "SELECT id, hostname, tailnet_ip, last_seen, status, lan_ip, version, config_revision FROM hosts";

/**
 * LAMA-225: DNS-safe hostname for rename — lowercase a-z0-9 plus internal
 * hyphens, 1..63 chars, no leading/trailing hyphen. Input is normalized
 * (trim + lowercase) before this runs.
 */
function isDnsSafeHostname(value: string): boolean {
  if (value.length < 1 || value.length > 63) return false;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) return false;
  return true;
}

/**
 * LAMA-225: re-key a host id across every table that references it. Called
 * inside a transaction when a renamed host re-registers under its new name
 * (the daemon restarted with an updated client.toml, so id == hostname ==
 * the new name). SQLite does not cascade id updates here, so the UPDATE is
 * explicit per table. History (operation_log, notification_events) follows
 * the host instead of being orphaned.
 */
function cascadeHostId(database: Database, oldId: string, newId: string): void {
  database.run(
    "UPDATE folder_assignments SET host_id = ? WHERE host_id = ?",
    [newId, oldId],
  );
  database.run(
    "UPDATE dotfile_manifests SET host_id = ? WHERE host_id = ?",
    [newId, oldId],
  );
  database.run(
    "UPDATE queued_actions SET host_id = ? WHERE host_id = ?",
    [newId, oldId],
  );
  database.run("UPDATE conflicts SET host_id = ? WHERE host_id = ?", [newId, oldId]);
  database.run(
    "UPDATE operation_log SET host_id = ? WHERE host_id = ?",
    [newId, oldId],
  );
  database.run(
    "UPDATE restic_snapshots SET host_id = ? WHERE host_id = ?",
    [newId, oldId],
  );
  database.run(
    "UPDATE restic_restore_jobs SET target_host_id = ? WHERE target_host_id = ?",
    [newId, oldId],
  );
  database.run(
    "UPDATE notification_events SET host_id = ? WHERE host_id = ?",
    [newId, oldId],
  );
  // Lock ownership keys on host ids too, so a re-keyed host can still
  // release its stale locks.
  database.run("UPDATE folder_locks SET locked_by = ? WHERE locked_by = ?", [newId, oldId]);
  database.run("UPDATE schedule_state SET locked_by = ? WHERE locked_by = ?", [newId, oldId]);
}

export const hostsRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/hosts",
    async () => {
      const rows = activeDb
        .query<HostRow, []>(`${HOST_SELECT} ORDER BY hostname ASC`)
        .all();
      const latestVersion = await getCachedLatestVersion();
      return rows.map((row) => rowToHost(row, latestVersion));
    },
    {
      detail: {
        summary: "List all registered hosts",
        tags: ["Hosts"],
        responses: {
          200: { description: "Host list" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/hosts/:hostId",
    async ({ params, set }) => {
      const row = activeDb
        .query<HostRow, [string]>(`${HOST_SELECT} WHERE id = ?`)
        .get(params.hostId);
      if (!row) {
        set.status = 404;
        return { error: "Host not found" };
      }
      const latestVersion = await getCachedLatestVersion();
      return rowToHost(row, latestVersion);
    },
    {
      params: t.Object({ hostId: t.String() }),
      detail: {
        summary: "Get a single host by id",
        tags: ["Hosts"],
        responses: {
          200: { description: "Host record" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .patch(
    "/hosts/:hostId",
    async ({ params, body, set }) => {
      const row = activeDb
        .query<HostRow, [string]>(`${HOST_SELECT} WHERE id = ?`)
        .get(params.hostId);
      if (!row) {
        set.status = 404;
        return { error: "Host not found" };
      }
      const newHostname = (body.hostname ?? "").trim().toLowerCase();
      if (!isDnsSafeHostname(newHostname)) {
        set.status = 400;
        return { error: "invalid hostname" };
      }
      // LAMA-225: the display label must not collide with another host's
      // id or hostname (case-insensitive). A host may rename to its own
      // current id/hostname (no-op), so the self row is excluded.
      const collision = activeDb
        .query<{ id: string }, [string, string, string]>(
          "SELECT id FROM hosts WHERE (id = ? OR lower(hostname) = lower(?)) AND id != ?",
        )
        .all(newHostname, newHostname, params.hostId);
      if (collision.length > 0) {
        set.status = 409;
        return { error: `hostname '${newHostname}' already in use` };
      }

      // Design decision (LAMA-225): PATCH changes the display label only.
      // hosts.id is the STABLE registration key — the daemon keys every
      // heartbeat/config/action call on it — so renaming must not break a
      // running daemon. The id is re-keyed later, at re-registration, when
      // the operator updates client.toml and the daemon restarts under the
      // new name (see POST /register).
      const now = Date.now();
      const rename = activeDb.transaction(() => {
        activeDb.run("UPDATE hosts SET hostname = ? WHERE id = ?", [newHostname, params.hostId]);
        activeDb.run(
          `INSERT INTO operation_log
             (timestamp, host_id, folder_id, operation, status, summary)
           VALUES (?, ?, NULL, 'host_rename', 'success', ?)`,
          [now, params.hostId, `${row.hostname} → ${newHostname}`],
        );
      });
      rename();

      const updated = activeDb
        .query<HostRow, [string]>(`${HOST_SELECT} WHERE id = ?`)
        .get(params.hostId);
      if (!updated) {
        set.status = 500;
        return { error: "Failed to load host after rename" };
      }
      const latestVersion = await getCachedLatestVersion();
      const host = rowToHost(updated, latestVersion);
      broadcast({
        kind: "host_renamed",
        oldId: params.hostId,
        newId: params.hostId,
        hostname: newHostname,
      });
      broadcast({ kind: "host", host });
      // Bump the renamed host's own revision so its daemon pulls a fresh
      // /config/:hostId on the next heartbeat and logs the rename.
      bumpConfigRevision([params.hostId]);
      return host;
    },
    {
      params: t.Object({ hostId: t.String() }),
      body: t.Object({ hostname: t.String() }),
      detail: {
        summary: "Rename a host's display label (id stays stable)",
        tags: ["Hosts"],
        responses: {
          200: { description: "Host record with updated hostname" },
          400: { description: "Invalid hostname" },
          404: { description: "Not found" },
          409: { description: "Hostname already in use" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/register",
    async ({ body, set }) => {
      const { id, hostname, tailnetIp } = body as {
        id: string;
        hostname: string;
        tailnetIp?: string | null;
      };
      const previous = activeDb
        .query<{ id: string; status: string | null }, [string]>(
          "SELECT id, status FROM hosts WHERE id = ?",
        )
        .get(id);

      // LAMA-225: re-key a renamed host on re-registration. The operator
      // renamed the display label via PATCH /hosts/:id, then updated
      // client.toml and restarted the daemon under the new name — so the
      // incoming id == hostname == the new name. A DIFFERENT row already
      // carries that hostname (the renamed row): re-key it to the incoming
      // id inside a transaction, cascading every host_id reference so the
      // operation history follows the host instead of spawning a duplicate.
      const renamedRow = activeDb
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM hosts WHERE lower(hostname) = lower(?) AND id != ?",
        )
        .get(hostname, id);
      const idTaken = activeDb
        .query<{ id: string }, [string]>("SELECT id FROM hosts WHERE id = ?")
        .get(id);
      if (renamedRow && !idTaken) {
        const oldId = renamedRow.id;
        const rekey = activeDb.transaction(() => {
          activeDb.run("UPDATE hosts SET id = ? WHERE id = ?", [id, oldId]);
          cascadeHostId(activeDb, oldId, id);
        });
        rekey();
        console.log(
          `[register] host renamed on re-registration: ${oldId} → ${id}; re-keyed host_id references`,
        );
      } else if (renamedRow && idTaken) {
        console.warn(
          `[register] re-key skipped: both id '${id}' and hostname '${id}' already exist as separate hosts`,
        );
      }

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
      if (previous?.status === "offline" || previous?.status === "unknown") {
        emitNotification({
          type: "host_online",
          hostId: id,
          message: `Host ${row.hostname} is online`,
        });
      }
      // LAMA-198: register may bring a previously-unknown host into a fleet
      // where peers exist; bump every host's revision so other daemons
      // re-pull their config (LAN-peer discovery lives in /config/:hostId).
      bumpConfigRevisionForPeers(id);
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
      const { hostId, timestamp, status, lanIp, tailnetIp, version } = body as {
        hostId: string;
        timestamp: number;
        status: HostStatus;
        lanIp?: string | null;
        tailnetIp?: string | null;
        version?: string | null;
      };
      const previous = activeDb
        .query<{ status: string | null }, [string]>(
          "SELECT status FROM hosts WHERE id = ?",
        )
        .get(hostId);
      // Follow the existing `lanIp` pattern: only overwrite the column when
      // the heartbeat actually carries a truthy value. A heartbeat without
      // `version` (older daemons, transient blanks) preserves whatever the
      // daemon reported last so the dashboard's Version column doesn't
      // flicker. The same rule keeps tailnet_ip stable when a daemon's
      // tailscale interface is down (it sends `tailnetIp: null`).
      const sets: string[] = ["last_seen = ?", "status = ?"];
      const params: (string | number | null)[] = [timestamp, status];
      if (lanIp) {
        sets.push("lan_ip = ?");
        params.push(lanIp);
      }
      if (tailnetIp) {
        sets.push("tailnet_ip = ?");
        params.push(tailnetIp);
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
        const host = rowToHost(row, latestVersion);
        broadcast({ kind: "host", host });
        if (
          status === "online" &&
          (previous?.status === "offline" ||
            previous?.status === "unknown" ||
            previous?.status === null)
        ) {
          emitNotification({
            type: "host_online",
            hostId,
            message: `Host ${row.hostname} is online`,
          });
        }
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
        tailnetIp: t.Optional(t.Union([t.String(), t.Null()])),
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
