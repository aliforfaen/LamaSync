// `lamasync backup legacy` (LAMA-294): report / prune orphaned legacy shared
// backup data under backup folder roots.
//
// Report is a safe dry-run by default. `--prune` requires `--yes` (the server
// additionally requires `confirm: true`), and the server never touches
// host-scoped prefixes — only orphaned top-level children of the legacy root.

import type { LegacyRootPruneResult, LegacyRootReport } from "@lamasync/core";
import { CliUsageError, flagBool } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export async function runLegacy(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  if (flagBool(flags, "prune")) {
    return runLegacyPrune(ctx);
  }
  return runLegacyReport(ctx);
}

async function runLegacyReport(ctx: CliContext): Promise<void> {
  const { client, json } = ctx;
  let reports: LegacyRootReport[];
  try {
    reports = await client.client.reportLegacyRoot();
  } catch (err) {
    throw wrapApiError(err, "backup legacy report");
  }
  const orphanTotal = reports.reduce((sum, r) => sum + r.orphanedBytes, 0);

  if (json) {
    printJson(reports);
    return;
  }

  const rows = reports.flatMap((r) =>
    r.orphaned.map((e) => ({
      folder: r.folderName,
      path: `${r.remotePath}/${e.name}`,
      kind: e.isHostPrefix ? "host-prefix (kept)" : "legacy (orphaned)",
      size: formatBytes(e.sizeBytes),
      items: e.itemCount,
    })),
  );

  if (rows.length === 0) {
    console.log("No orphaned legacy shared backup data found.");
    return;
  }

  printTable(
    [
      { header: "FOLDER", key: "folder" },
      { header: "PATH", key: "path" },
      { header: "KIND", key: "kind" },
      { header: "SIZE", key: "size" },
      { header: "ITEMS", key: "items" },
    ],
    rows,
  );
  console.log(
    `\nOrphaned legacy backup data: ${formatBytes(orphanTotal)}. Use \`lamasync backup legacy --prune --yes\` to delete it.`,
  );
}

async function runLegacyPrune(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  if (!flagBool(flags, "yes")) {
    throw new CliUsageError("pruning deletes backup data — pass --yes to confirm");
  }
  let results: LegacyRootPruneResult[];
  try {
    results = await client.client.pruneLegacyRoot(true);
  } catch (err) {
    throw wrapApiError(err, "backup legacy prune");
  }

  if (json) {
    printJson(results);
    return;
  }

  const prunedTotal = results.reduce((sum, r) => sum + r.pruned.length, 0);
  printTable(
    [
      { header: "FOLDER", key: "folder" },
      { header: "PRUNED", key: "pruned" },
      { header: "KEPT PREFIXES", key: "kept" },
      { header: "ERRORS", key: "errors" },
    ],
    results.map((r) => ({
      folder: r.folderName,
      pruned: r.pruned.join(", ") || "—",
      kept: r.skippedHostPrefixes.join(", ") || "—",
      errors: r.errors.length > 0 ? `${r.errors.length} error(s)` : "—",
    })),
  );
  console.log(
    `\nPruned ${prunedTotal} orphaned legacy entr${prunedTotal === 1 ? "y" : "ies"}.`,
  );
}
