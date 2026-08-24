// Dry-run preview helpers (LAMA-257). The daemon already runs
// `rclone --dry-run` when a `trigger_sync` action carries `{dryRun:true}`,
// and reports the would-change file lists inside the operation row's JSON
// `details` (`wouldCopy` / `wouldDelete` / `wouldMkdir`), with the summary
// tagged `dry-run: …` so the row is never mistaken for a real transfer.
// These pure helpers parse that payload so the web drawer can render
// counts + a capped file list.

import type { OperationLog } from "@lamasync/core";

export interface DryRunDetails {
  wouldCopy: string[];
  wouldDelete: string[];
  wouldMkdir: string[];
}

const EMPTY: DryRunDetails = { wouldCopy: [], wouldDelete: [], wouldMkdir: [] };

function pickStrings(raw: Record<string, unknown>, key: string): string[] {
  const value = raw[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Parse the operation row's `details` JSON into the dry-run file lists.
 * Any malformed/absent shape falls back to empty lists — the drawer then
 * renders an honest "no details" rather than crashing.
 */
export function parseDryRunDetails(
  details: string | null | undefined,
): DryRunDetails {
  if (!details) return EMPTY;
  let raw: unknown;
  try {
    raw = JSON.parse(details);
  } catch {
    return EMPTY;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return EMPTY;
  const obj = raw as Record<string, unknown>;
  return {
    wouldCopy: pickStrings(obj, "wouldCopy"),
    wouldDelete: pickStrings(obj, "wouldDelete"),
    wouldMkdir: pickStrings(obj, "wouldMkdir"),
  };
}

/** True when the operation row is a dry-run report (tagged summary). */
export function isDryRunOperation(op: OperationLog): boolean {
  return typeof op.summary === "string" && op.summary.startsWith("dry-run:");
}

/**
 * The most recent dry-run operation for a folder. The API returns the log
 * newest-first, so the first match is the latest report.
 */
export function findDryRunOperation(
  ops: readonly OperationLog[],
  folderId: string,
): OperationLog | null {
  return (
    ops.find((op) => op.folderId === folderId && isDryRunOperation(op)) ?? null
  );
}

/** Cap a list at N entries; returns the trimmed list + the original length. */
export function capList(
  items: Array<{ kind: string; path: string }>,
  max = 200,
): { items: Array<{ kind: string; path: string }>; total: number } {
  return { items: items.slice(0, max), total: items.length };
}
