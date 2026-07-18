import { Elysia, t } from "elysia";
import { db } from "../db.ts";
import { broadcast } from "../ws.ts";
import type { Host, HostStatus } from "@lamasync/core";

interface HostRow {
  id: string;
  hostname: string;
  tailnet_ip: string | null;
  last_seen: number | null;
  status: string | null;
  lan_ip: string | null;
}

function rowToHost(row: HostRow): Host {
  return {
    id: row.id,
    hostname: row.hostname,
    tailnetIp: row.tailnet_ip,
    lanIp: row.lan_ip,
    lastSeen: row.last_seen,
    status: (row.status ?? "unknown") as HostStatus,
  };
}

export const hostsRoutes = new Elysia({ prefix: "/api/v1" })
  .post(
    "/register",
    ({ body, set }) => {
      const { id, hostname, tailnetIp } = body as {
        id: string;
        hostname: string;
        tailnetIp?: string | null;
      };
      const now = Date.now();
      db.run(
        `INSERT INTO hosts (id, hostname, tailnet_ip, last_seen, status)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           hostname = excluded.hostname,
           tailnet_ip = excluded.tailnet_ip,
           last_seen = excluded.last_seen,
           status = excluded.status`,
        [id, hostname, tailnetIp ?? null, now, "online"],
      );
      const row = db
        .query<HostRow, [string]>(
          "SELECT id, hostname, tailnet_ip, last_seen, status, lan_ip FROM hosts WHERE id = ?",
        )
        .get(id);
      if (!row) {
        set.status = 500;
        return { error: "Failed to load host after insert" };
      }
      const host = rowToHost(row);
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
      const result = db.run("DELETE FROM hosts WHERE id = ?", [params.hostId]);
      if (result.changes === 0) {
        set.status = 404;
        return { error: "Host not found" };
      }
      db.run("DELETE FROM folder_assignments WHERE host_id = ?", [params.hostId]);
      const manifestIds = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM dotfile_manifests WHERE host_id = ?",
        )
        .all(params.hostId)
        .map((r) => r.id);
      if (manifestIds.length > 0) {
        const placeholders = manifestIds.map(() => "?").join(",");
        db.run(
          `DELETE FROM dotfile_versions WHERE manifest_id IN (${placeholders})`,
          manifestIds,
        );
      }
      db.run("DELETE FROM dotfile_manifests WHERE host_id = ?", [params.hostId]);
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
    ({ body, set }) => {
      const { hostId, timestamp, status, lanIp } = body as {
        hostId: string;
        timestamp: number;
        status: HostStatus;
        lanIp?: string | null;
      };
      const result = db.run(
        // Only overwrite lan_ip when the heartbeat actually carries one —
        // heartbeats without a LAN IP keep whatever the last registration
        // or heartbeat stored, so transient blank reports don't blank the
        // subnet we use for peer detection.
        lanIp
          ? `UPDATE hosts SET last_seen = ?, status = ?, lan_ip = ? WHERE id = ?`
          : `UPDATE hosts SET last_seen = ?, status = ? WHERE id = ?`,
        lanIp
          ? [timestamp, status, lanIp, hostId]
          : [timestamp, status, hostId],
      );
      if (result.changes === 0) {
        set.status = 404;
        return { error: `Host '${hostId}' not registered` };
      }
      const row = db
        .query<HostRow, [string]>(
          "SELECT id, hostname, tailnet_ip, last_seen, status, lan_ip FROM hosts WHERE id = ?",
        )
        .get(hostId);
      if (row) broadcast({ kind: "host", host: rowToHost(row) });
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
