import { Elysia } from "elysia";
import { db } from "../db.ts";
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

export const healthRoutes = new Elysia({ prefix: "/api/v1" }).get(
  "/health",
  () => {
    const rows = db
      .query<HostRow, []>("SELECT id, hostname, tailnet_ip, last_seen, status, lan_ip FROM hosts")
      .all();
    const hosts = rows.map(rowToHost);
    const onlineCount = hosts.filter((h) => h.status === "online").length;
    return {
      status: "ok" as const,
      hostCount: hosts.length,
      onlineCount,
      hosts,
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
