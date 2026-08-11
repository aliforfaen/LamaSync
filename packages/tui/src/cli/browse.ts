/**
 * `lamasync browse local|s3|restic|jobs` (LAMA-231).
 *
 * Read-only by default. Write operations (copy/move/rename/mkdir/upload/
 * delete) intentionally stay in the REST/WS API surface (the skill's
 * `reference/api.md`) until Phase D binds them to TUI confirm + audit
 * flags. The skill stays LAMA-226 compatible either way.
 */

import type { BrowseJob, BrowseResponse, ResticSnapshot } from "@lamasync/core";

import { CliUsageError, flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";

export async function runLocal(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const path = flagString(flags, "path") ?? "";
  let res: BrowseResponse;
  try {
    res = await client.client.browseLocal(path || undefined);
  } catch (err) {
    throw wrapApiError(err, "browse local");
  }
  if (json) {
    printJson(res);
    return;
  }
  printTable(
    [
      { header: "NAME", key: "name" },
      { header: "TYPE", key: "type" },
      { header: "SIZE", key: "sizeLabel" },
      { header: "MTIME", key: "mtimeLabel" },
    ],
    res.entries.map((e) => ({
      name: e.name,
      type: e.type,
      sizeLabel: formatBytes(e.size),
      mtimeLabel: new Date(e.mtime).toISOString(),
    })),
  );
  console.log(`(${res.entries.length} entries under ${res.path || "/"})`);
}

export async function runS3(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const folder = flagString(flags, "folder");
  if (!folder) throw new CliUsageError("browse s3 --folder <folderId> is required");
  const path = flagString(flags, "path") ?? "";
  let res: BrowseResponse;
  try {
    res = await client.client.browseS3(folder, path || undefined);
  } catch (err) {
    throw wrapApiError(err, "browse s3");
  }
  if (json) {
    printJson(res);
    return;
  }
  printTable(
    [
      { header: "NAME", key: "name" },
      { header: "TYPE", key: "type" },
      { header: "SIZE", key: "sizeLabel" },
      { header: "MTIME", key: "mtimeLabel" },
    ],
    res.entries.map((e) => ({
      name: e.name,
      type: e.type,
      sizeLabel: formatBytes(e.size),
      mtimeLabel: new Date(e.mtime).toISOString(),
    })),
  );
}

export async function runRestic(ctx: CliContext): Promise<void> {
  const { client, json } = ctx;
  let snaps: ResticSnapshot[];
  try {
    snaps = await client.client.browseRestic();
  } catch (err) {
    throw wrapApiError(err, "browse restic");
  }
  if (json) {
    printJson(snaps);
    return;
  }
  printTable(
    [
      { header: "SNAPSHOT", key: "snapshotId" },
      { header: "TIMESTAMP", key: "timestampLabel" },
      { header: "FOLDER", key: "folderId" },
      { header: "HOST", key: "hostId" },
    ],
    snaps.map((s: ResticSnapshot) => ({
      snapshotId: s.snapshotId,
      timestampLabel: new Date(s.timestamp).toISOString(),
      folderId: s.folderId,
      hostId: s.hostId,
    })),
  );
}

export async function runJobs(ctx: CliContext): Promise<void> {
  const { client, json } = ctx;
  let jobs: BrowseJob[];
  try {
    jobs = await client.client.browseJobs();
  } catch (err) {
    throw wrapApiError(err, "browse jobs");
  }
  if (json) {
    printJson(jobs);
    return;
  }
  printTable(
    [
      { header: "OP", key: "operation" },
      { header: "STATUS", key: "status" },
      { header: "SRC", key: "source" },
      { header: "DEST", key: "destination" },
      { header: "PROGRESS", key: "progressLabel" },
      { header: "ID", key: "id" },
    ],
    jobs.map((j: BrowseJob) => ({
      operation: j.operation,
      status: j.status,
      source: j.source,
      destination: j.destination,
      progressLabel:
        j.progressBytes === null || j.progressBytes === undefined
          ? "—"
          : `${formatBytes(j.progressBytes)}${j.totalBytes ? ` / ${formatBytes(j.totalBytes)}` : ""}`,
      id: j.id,
    })),
  );
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
