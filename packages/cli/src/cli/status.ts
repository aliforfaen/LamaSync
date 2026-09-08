/**
 * `lamasync status` — fleet health + per-host status via `GET /health`.
 *
 * Default output is a 3-line summary + per-host table:
 *
 *   lamasync — fleet status
 *   server: 100.113.52.108:8080  version: 0.3.1  hosts: 3 (2 online)
 *
 *   HOSTNAME       ID                  STATUS     LAST SEEN       VERSION
 *   cachy          cachy               online     2m ago          0.3.1
 *   CachyTop       cachytop            degraded   18h ago         0.2.3
 *
 * `--json` emits the raw HealthResponse from the API (serverVersion,
 * dbSizeBytes, hosts[]).
 */

import type { HealthResponse, Host } from "@lamasync/core";

import { CliUsageError } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";

export const help = {
  summary: "Fleet health + per-device status.",
  usage:
    `Usage: lamasync status [--json]\n\n` +
    `  Default output is a brief summary + per-device table.\n` +
    `  --json emits the raw HealthResponse (serverVersion, dbSizeBytes, hosts).`,
};

export async function run(ctx: CliContext): Promise<void> {
  const { client, json } = ctx;
  let health: HealthResponse;
  try {
    health = await client.client.getHealth();
  } catch (err) {
    throw wrapApiError(err, "status");
  }

  if (json) {
    printJson(health);
    return;
  }

  const onlineCount = health.onlineCount;
  console.log(`lamasync — fleet status`);
  console.log(
    `server: ${client.serverUrl}  version: ${health.serverVersion}  hosts: ` +
      `${health.hostCount} (${onlineCount} online)` +
      (typeof health.dbSizeBytes === "number"
        ? `  db: ${formatBytes(health.dbSizeBytes)}`
        : ""),
  );
  if (health.hosts.length === 0) {
    console.log("\n(no hosts registered)");
    return;
  }
  console.log("");
  printTable(
    [
      { header: "HOSTNAME", key: "hostname" },
      { header: "ID", key: "id" },
      { header: "STATUS", key: "status" },
      { header: "LAST SEEN", key: "lastSeenLabel" },
      { header: "VERSION", key: "version" },
    ],
    health.hosts.map((h: Host) => ({
      hostname: h.hostname,
      id: h.id,
      status: h.status,
      lastSeenLabel: formatLastSeen(h.lastSeen ?? null),
      version: h.version ?? "—",
    })),
  );
}

function formatLastSeen(ts: number | null): string {
  if (ts === null) return "(never)";
  const ageMs = Date.now() - ts;
  if (ageMs < 0) return "just now";
  if (ageMs < 60_000) return `${Math.max(1, Math.round(ageMs / 1000))}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// Suppress unused-warnings if CliUsageError ever falls out of the call
// chain during refactors; the symbol is used as a typing reference.
export const _usageError = CliUsageError;
