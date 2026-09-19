import { Elysia } from "elysia";
import { statSync } from "node:fs";
import {
  VERSION,
  isNewer,
  type Host,
  type HostClass,
  type HostStatus,
} from "@lamasync/core";
import { db, dbFilePath } from "../db.ts";
import { getCachedLatestRelease } from "../release-cache.ts";
import {
  hostFromRow,
  readFleetHealth,
  releaseFactsFrom,
  type HostRowLike,
} from "../fleet-health.ts";

/**
 * LAMA-345 follow-up: the host shape (and the update verdict) comes from the
 * shared serialization in ../fleet-health.ts — this route used to carry its own
 * copy of the logic, which is how "update available" drifted from the Hosts
 * page.
 */
type HostRow = HostRowLike;

export const healthRoutes = new Elysia({ prefix: "/api/v1" }).get(
  "/health",
  async () => {
    const rows = db
      .query<HostRow, []>(
        `SELECT id, hostname, tailnet_ip, last_seen, status, lan_ip, version,
                config_revision, os, storage_used_bytes, host_class
           FROM hosts`,
      )
      .all();
    // Resolve the cached latest release ONCE so every host in the response —
    // and the fleet summary below — is judged against the same release facts.
    const release = releaseFactsFrom(await getCachedLatestRelease());
    const now = Date.now();
    const hosts = rows.map((row) => hostFromRow(row, release, now));
    const onlineCount = hosts.filter((h) => h.status === "online").length;
    const fleetHealth = readFleetHealth(db, { release, now });
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
      fleetHealth,
    };
  },
  {
    detail: {
      summary:
        "Fleet health summary: hosts (with the evidence-based update verdict) and the managed-folder/device `fleetHealth` buckets",
      tags: ["Health"],
      responses: {
        200: {
          description:
            "Fleet status with the host list and the derived `fleetHealth` summary (needs intervention / check when online / healthy / not heard from)",
        },
        401: { description: "Unauthorized" },
      },
    },
  },
);
