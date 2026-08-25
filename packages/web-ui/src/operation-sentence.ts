// Human "activity sentence" for an operation row (LAMA-258).
//
// Turns a raw `OperationLog` row into a glossary sentence such as
// "Backed up **Dev configs** from **cachy** to **Exoscale** · 2h ago · ok".
// Pure + testable (mirrors the LAMA-267 `next-run.ts` pattern): it takes the
// row plus already-resolved display names and returns structured parts so the
// UI can bold the subject/device/destination while the `text` field stays a
// plain string for tooltips and unit tests.
//
// Wiring notes for callers:
//  - `folderName` comes from the folder row; `hostName` from the device
//    (host) row; `backendName` from the folder's storage destination.
//  - The raw `op.summary` is NOT consumed here — keep it available behind a
//    tooltip/title so no information is lost (the UI owns that affordance).

import type { OperationLog, OperationStatus } from "@lamasync/core";
import { formatTimeAgo } from "./relative-time.ts";

export interface OperationSentenceContext {
  /** Subject name (folder / app settings backup), bolded in the UI. */
  folderName?: string | null;
  /** Source device name ("from …"). */
  hostName?: string | null;
  /** Destination storage name ("to …"). */
  backendName?: string | null;
  /** Override "now" for deterministic output in tests. */
  now?: Date;
}

export interface OperationSentence {
  /** Leading action phrase, e.g. "Backed up" or "Backup failed". */
  verb: string;
  /** Bolded subject name, if known. */
  folder?: string;
  /** Source device name, if known. */
  from?: string;
  /** Destination storage name, if known. */
  to?: string;
  /** Relative time, e.g. "2h ago". */
  timeAgo: string;
  /** Status word — never conveyed by colour alone. */
  statusWord: string;
  /** Full plain-text sentence (tooltips / tests). */
  text: string;
}

// Past-tense verb for success-family statuses.
const VERB_PAST: Record<string, string> = {
  sync: "Synced",
  bisync: "Synced",
  backup: "Backed up",
  restore: "Restored",
  mount: "Mounted",
  copy: "Copied",
  browse_copy: "Copied",
  browse_move: "Moved",
  browse_delete: "Deleted",
  browse_rename: "Renamed",
  browse_mkdir: "Created folder",
  browse_upload: "Uploaded",
  browse_cat: "Read",
  browse_purge: "Purged",
  browse_size: "Measured",
  copyto: "Copied",
  moveto: "Moved",
  delete: "Deleted",
  rename: "Renamed",
  mkdir: "Created folder",
  upload: "Uploaded",
  cat: "Read",
  purge: "Purged",
  size: "Measured",
  prune: "Pruned",
  check: "Checked",
  enqueue: "Enqueued",
  dry_run: "Previewed",
  preview: "Previewed",
};

// Noun form used as the prefix for failures ("Backup failed …").
const VERB_NOUN: Record<string, string> = {
  sync: "Sync",
  bisync: "Sync",
  backup: "Backup",
  restore: "Restore",
  mount: "Mount",
  copy: "Copy",
  browse_copy: "Copy",
  browse_move: "Move",
  browse_delete: "Delete",
  browse_rename: "Rename",
  browse_mkdir: "Create folder",
  browse_upload: "Upload",
  browse_cat: "Read",
  browse_purge: "Purge",
  browse_size: "Measure",
  copyto: "Copy",
  moveto: "Move",
  delete: "Delete",
  rename: "Rename",
  mkdir: "Create folder",
  upload: "Upload",
  cat: "Read",
  purge: "Purge",
  size: "Measure",
  prune: "Prune",
  check: "Check",
  enqueue: "Enqueue",
  dry_run: "Dry run",
  preview: "Preview",
};

// Status word — a text label so status is never colour-only.
const STATUS_WORD: Record<OperationStatus, string> = {
  started: "started",
  success: "ok",
  failed: "failed",
  conflict: "conflict",
  recovery: "recovered",
  retry: "retrying",
};

function titleCase(s: string): string {
  return s.length === 0 ? s : `${s[0]!.toUpperCase()}${s.slice(1)}`;
}

/**
 * Build the activity sentence for an operation row. Returns structured parts
 * (for rich rendering) plus a plain `text` for tooltips and tests.
 */
export function operationSentence(
  op: OperationLog,
  ctx: OperationSentenceContext = {},
): OperationSentence {
  const now = ctx.now ?? new Date();
  const timeAgo = formatTimeAgo(op.timestamp, now);
  const statusWord = STATUS_WORD[op.status] ?? op.status;
  const failed = op.status === "failed";
  const verb = failed
    ? `${VERB_NOUN[op.operation] ?? titleCase(op.operation)} failed`
    : VERB_PAST[op.operation] ?? `${titleCase(op.operation)}d`;

  const subjectParts: string[] = [];
  if (ctx.folderName) subjectParts.push(ctx.folderName);
  if (ctx.hostName) subjectParts.push(`from ${ctx.hostName}`);
  if (ctx.backendName) subjectParts.push(`to ${ctx.backendName}`);
  const subject = subjectParts.length > 0 ? ` ${subjectParts.join(" ")}` : "";

  // On failure the status is already embedded in the verb, so don't repeat
  // it at the tail — the plain `text` still carries an unambiguous status.
  const text = failed
    ? `${verb}${subject} · ${timeAgo}`
    : `${verb}${subject} · ${timeAgo} · ${statusWord}`;

  return {
    verb,
    folder: ctx.folderName ?? undefined,
    from: ctx.hostName ?? undefined,
    to: ctx.backendName ?? undefined,
    timeAgo,
    statusWord,
    text,
  };
}
