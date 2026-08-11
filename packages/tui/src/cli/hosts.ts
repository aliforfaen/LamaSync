/**
 * `lamasync hosts list|rename|register` (LAMA-231).
 *
 * `register` is the agent fallback for the install script's web UI flow.
 * `rename` is patch-only (id stays stable; the daemon re-keys when it
 * next heartbeats under the new name).
 */

import type { Host } from "@lamasync/core";

import { CliUsageError, flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";
import { confirmDestructive } from "./safety.ts";

export async function runList(ctx: CliContext): Promise<void> {
  const { client, json } = ctx;
  let hosts: Host[];
  try {
    hosts = await client.client.listHosts();
  } catch (err) {
    throw wrapApiError(err, "hosts list");
  }
  if (json) {
    printJson(hosts);
    return;
  }
  printTable(
    [
      { header: "HOSTNAME", key: "hostname" },
      { header: "ID", key: "id" },
      { header: "STATUS", key: "status" },
      { header: "VERSION", key: "version" },
      { header: "UPDATE", key: "updateAvailable" },
      { header: "TAILNET", key: "tailnetIp" },
      { header: "LAST SEEN", key: "lastSeenLabel" },
    ],
    hosts.map((h: Host) => ({
      hostname: h.hostname,
      id: h.id,
      status: h.status,
      version: h.version ?? "—",
      updateAvailable: h.updateAvailable ? "yes" : "no",
      tailnetIp: h.tailnetIp ?? "",
      lastSeenLabel: formatLastSeen(h.lastSeen ?? null),
    })),
  );
}

export async function runRename(ctx: CliContext): Promise<void> {
  const { client, json, flags, parsed } = ctx;
  const id = parsed.rest[0];
  if (!id) throw new CliUsageError("hosts rename <hostId> requires an id");
  const hostname = flagString(flags, "hostname");
  if (!hostname) throw new CliUsageError("hosts rename requires --hostname <new>");
  await confirmDestructive(ctx, {
    promptMessage: `rename host ${id} → ${hostname}`,
    detailsUrl: "(see safety rule 5; the id re-keys on the daemon's next registration)",
    flagNameYes: "yes",
  });
  let host: Host;
  try {
    host = await client.client.renameHost(id, hostname);
  } catch (err) {
    throw wrapApiError(err, "hosts rename");
  }
  if (json) {
    printJson(host);
    return;
  }
  console.log(`renamed ${id} → ${hostname}`);
}

export async function runRegister(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const id = flagString(flags, "hostname");
  if (!id) throw new CliUsageError("register requires --hostname <name>");
  const tailnetIp = flagString(flags, "tailnet-ip") ?? null;
  let host: Host;
  try {
    host = await client.client.registerHost({
      id,
      hostname: id,
      ...(tailnetIp ? { tailnetIp } : {}),
    });
  } catch (err) {
    throw wrapApiError(err, "register");
  }
  if (json) {
    printJson(host);
    return;
  }
  console.log(`registered ${host.hostname} (id=${host.id})`);
}

function formatLastSeen(ts: number | null): string {
  if (ts === null) return "(never)";
  const ageMs = Date.now() - ts;
  if (ageMs < 60_000) return `${Math.max(1, Math.round(ageMs / 1000))}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}
