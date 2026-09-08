/**
 * `lamasync ops list` — tail the operation log.
 *
 * Defaults match the server route (limit 50, max 500). Filters: --status,
 * --host, --folder. The trailing rows include the operation summary, which
 * is the field the agent usually wants; --json output preserves the full
 * OperationLog shape (including `details` and `durationMs`).
 */

import type { OperationLog } from "@lamasync/core";

import { CliUsageError, flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";

export async function runList(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const opts: {
    status?: string;
    hostId?: string;
    folderId?: string;
    limit?: number;
  } = {};
  const status = flagString(flags, "status");
  if (status) opts.status = status;
  const host = flagString(flags, "host") ?? flagString(flags, "host-id");
  if (host) opts.hostId = host;
  const folder = flagString(flags, "folder") ?? flagString(flags, "folder-id");
  if (folder) opts.folderId = folder;
  const limit = flagString(flags, "limit");
  if (limit !== undefined) {
    const n = Number.parseInt(limit, 10);
    if (!Number.isFinite(n) || n < 1 || n > 500) {
      throw new CliUsageError(
        `--limit must be a positive integer ≤ 500 (got: '${limit}')`,
      );
    }
    opts.limit = n;
  }

  let logs: OperationLog[];
  try {
    logs = await client.client.listOperations(opts);
  } catch (err) {
    throw wrapApiError(err, "ops list");
  }

  if (json) {
    printJson(logs);
    return;
  }
  printTable(
    [
      { header: "WHEN", key: "whenLabel" },
      { header: "HOST", key: "hostId" },
      { header: "OP", key: "operation" },
      { header: "STATUS", key: "status" },
      { header: "DUR", key: "durationLabel" },
      { header: "SUMMARY", key: "summary" },
      { header: "ID", key: "id" },
    ],
    logs.map((l: OperationLog) => ({
      whenLabel: formatTime(l.timestamp),
      hostId: l.hostId,
      operation: l.operation,
      status: l.status,
      durationLabel: formatDuration(l.durationMs ?? null),
      summary: l.summary ?? "",
      id: String(l.id),
    })),
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
