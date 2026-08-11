/**
 * `lamasync conflicts list|resolve <id>` (LAMA-231).
 */

import type { Conflict } from "@lamasync/core";

import { CliUsageError, flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";

export async function runList(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const host = flagString(flags, "host");
  const folder = flagString(flags, "folder");
  const status = flagString(flags, "status");
  let conflicts: Conflict[];
  try {
    conflicts = await client.client.listConflicts({
      ...(host ? { hostId: host } : {}),
      ...(folder ? { folderId: folder } : {}),
      ...(status ? { status } : {}),
    });
  } catch (err) {
    throw wrapApiError(err, "conflicts list");
  }
  if (json) {
    printJson(conflicts);
    return;
  }
  printTable(
    [
      { header: "PATH", key: "path" },
      { header: "STATUS", key: "status" },
      { header: "RESOLUTION", key: "resolution" },
      { header: "HOST", key: "hostId" },
      { header: "FOLDER", key: "folderId" },
      { header: "CREATED", key: "createdLabel" },
      { header: "ID", key: "id" },
    ],
    conflicts.map((c: Conflict) => ({
      path: c.path,
      status: c.status,
      resolution: c.resolution ?? "",
      hostId: c.hostId,
      folderId: c.folderId,
      createdLabel: new Date(c.createdAt).toISOString(),
      id: c.id,
    })),
  );
}

const RESOLUTION_MAP: Record<string, "local" | "remote" | "both"> = {
  local: "local",
  remote: "remote",
  both: "both",
  "keep-local": "local",
  "keep-remote": "remote",
  "keep-both": "both",
};

export async function runResolve(ctx: CliContext): Promise<void> {
  const { client, json, flags, parsed } = ctx;
  const id = parsed.rest[0];
  if (!id) throw new CliUsageError("conflicts resolve <id> requires an id");
  const keepRaw = flagString(flags, "keep");
  if (!keepRaw) {
    throw new CliUsageError(
      "conflicts resolve requires --keep local|remote|both",
    );
  }
  const resolution = RESOLUTION_MAP[keepRaw.toLowerCase()];
  if (!resolution) {
    throw new CliUsageError(
      `invalid --keep '${keepRaw}'; expected local | remote | both`,
    );
  }
  let conflict: Conflict;
  try {
    conflict = await client.client.resolveConflict(id, resolution);
  } catch (err) {
    throw wrapApiError(err, "conflicts resolve");
  }
  if (json) {
    printJson(conflict);
    return;
  }
  console.log(`resolved ${id} (kept ${resolution})`);
}
