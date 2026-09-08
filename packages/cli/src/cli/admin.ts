/**
 * `lamasync shares|admin` (LAMA-231).
 *
 *   shares list      GET /api/v1/shares
 *   admin prune [--older-than <ms>]
 *
 * `prune` is DESTRUCTIVE (safety rule 5). `--older-than` accepts a raw
 * millisecond age (`86400000` = 1 day) OR a short human form via the
 * daemon's existing pruner (`1d`, `7d`, `30d`); the CLI keeps the ms
 * contract to match the server's `olderThanMs` query parameter.
 */

import type { Share } from "@lamasync/core";

import { CliUsageError, flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";
import { confirmDestructive } from "./safety.ts";

export async function runSharesList(ctx: CliContext): Promise<void> {
  const { client, json } = ctx;
  let shares: Share[];
  try {
    shares = await client.client.listShares();
  } catch (err) {
    throw wrapApiError(err, "shares list");
  }
  if (json) {
    printJson(shares);
    return;
  }
  printTable(
    [
      { header: "NAME", key: "name" },
      { header: "TYPE", key: "type" },
      { header: "SERVER", key: "server" },
      { header: "PATH", key: "path" },
      { header: "OPTIONS", key: "options" },
      { header: "ID", key: "id" },
    ],
    shares.map((s: Share) => ({
      name: s.name,
      type: s.type,
      server: s.server,
      path: s.path,
      options: s.options,
      id: s.id,
    })),
  );
}

export async function runAdminPrune(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const raw = flagString(flags, "older-than");
  const ms = parseOlderThan(raw);
  if (ms === null) {
    throw new CliUsageError(
      "--older-than requires a positive duration (e.g. 86400000, 1d, 7d)",
    );
  }
  await confirmDestructive(ctx, {
    promptMessage: `prune operation_log rows older than ${ms} ms (irreversible)`,
    flagNameYes: "yes",
  });
  let result: { deleted: number; olderThanMs: number };
  try {
    result = await client.client.pruneOperations(ms);
  } catch (err) {
    throw wrapApiError(err, "admin prune");
  }
  if (json) {
    printJson(result);
    return;
  }
  console.log(`pruned ${result.deleted} operation_log rows`);
}

/** Accepts a `<n>d | <n>h | <n>m` shorthand as well as raw milliseconds.
 *  Returns null on invalid input; the caller then surfaces a usage error. */
export function parseOlderThan(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const m = /^(\d+)([dhm])$/.exec(trimmed);
  if (m) {
    const n = Number.parseInt(m[1] ?? "", 10);
    const unit = m[2];
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms =
      unit === "d" ? n * 86_400_000 :
      unit === "h" ? n * 3_600_000 :
      n * 60_000;
    return ms;
  }
  return null;
}
