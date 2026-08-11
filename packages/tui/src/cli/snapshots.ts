/**
 * `lamasync snapshots list` and `lamasync restore` (LAMA-231).
 *
 * Restore defaults to "interactive" confirmation through
 * `confirmDestructive()` — safety rule 5. Cron-driven callers MUST pass
 * `--yes` because the prompt requires a TTY.
 */

import type {
  ResticRestoreJob,
  ResticSnapshot,
} from "@lamasync/core";

import { CliUsageError, flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";
import { confirmDestructive } from "./safety.ts";

export async function runList(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const folder = flagString(flags, "folder");
  const host = flagString(flags, "host");
  let snapshots: ResticSnapshot[];
  try {
    snapshots = await client.client.listResticSnapshots({
      ...(folder ? { folderId: folder } : {}),
      ...(host ? { hostId: host } : {}),
    });
  } catch (err) {
    throw wrapApiError(err, "snapshots list");
  }
  if (json) {
    printJson(snapshots);
    return;
  }
  printTable(
    [
      { header: "SNAPSHOT", key: "snapshotId" },
      { header: "TIMESTAMP", key: "timestampLabel" },
      { header: "FOLDER", key: "folderId" },
      { header: "HOST", key: "hostId" },
      { header: "PATHS", key: "paths" },
      { header: "SIZE", key: "sizeLabel" },
      { header: "ID", key: "id" },
    ],
    snapshots.map((s: ResticSnapshot) => ({
      snapshotId: s.snapshotId,
      timestampLabel: new Date(s.timestamp).toISOString(),
      folderId: s.folderId,
      hostId: s.hostId,
      paths: (s.paths ?? []).join(" "),
      sizeLabel: s.sizeBytes === null || s.sizeBytes === undefined ? "—" : `${s.sizeBytes} B`,
      id: s.id,
    })),
  );
}

export async function runRestore(ctx: CliContext): Promise<void> {
  const { client, json, flags, parsed } = ctx;
  const snapshotId = flagString(flags, "snapshot") ?? parsed.rest[0];
  if (!snapshotId) {
    throw new CliUsageError(
      "restore requires --snapshot <snapshotId> or a positional <snapshotId>",
    );
  }
  const toHost = flagString(flags, "to");
  if (!toHost) {
    throw new CliUsageError("restore requires --to <hostId>");
  }
  const targetPath = flagString(flags, "path");
  if (!targetPath) {
    throw new CliUsageError("restore requires --path <targetPath>");
  }
  // The folder id is required by the server route. We pull it from
  // the snapshot record first, falling back to --folder.
  let folderId = flagString(flags, "folder") ?? "";
  if (!folderId) {
    try {
      const snap = await findSnapshot(client.client, snapshotId);
      if (!snap) {
        throw new CliUsageError(
          `snapshot ${snapshotId} not found; pass --folder to override`,
        );
      }
      folderId = snap.folderId;
    } catch (err) {
      if (err instanceof CliUsageError) throw err;
      throw wrapApiError(err, "restore");
    }
  }
  const include = flagString(flags, "include");
  await confirmDestructive(ctx, {
    promptMessage: `restore snapshot ${snapshotId} → ${toHost}:${targetPath}${include ? ` (include: ${include})` : ""}`,
    flagNameYes: "yes",
  });
  let job: ResticRestoreJob;
  try {
    job = await client.client.requestResticRestore(
      snapshotId,
      folderId,
      toHost,
      targetPath,
      include ? include.split(",").map((s) => s.trim()) : undefined,
    );
  } catch (err) {
    throw wrapApiError(err, "restore");
  }
  if (json) {
    printJson(job);
    return;
  }
  console.log(`restore job ${job.id} enqueued (status: ${job.status})`);
}

async function findSnapshot(
  client: import("@lamasync/core").LamaSyncApiClient,
  snapshotId: string,
): Promise<ResticSnapshot | undefined> {
  const all = await client.listResticSnapshots({});
  return all.find((s) => s.snapshotId === snapshotId || s.id === snapshotId);
}
