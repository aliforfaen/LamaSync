import { Box, Text } from "@opentui/core";
import type { VNode } from "@opentui/core";

import type { LamaSyncApiClient, OperationLog } from "@lamasync/core";

export type LogsAction = "refresh" | "next" | "prev" | "filter" | "quit";

export type LogsStatus = "all" | "success" | "failed" | "conflict";

export interface LogsState {
  entries: OperationLog[];
  status: LogsStatus;
  hostId: string | null;
  page: number;
}

export interface RenderLogsOpts {
  api: LamaSyncApiClient;
  state: LogsState;
  onAction: (action: LogsAction) => void;
}

const PAGE_SIZE = 50;
const STATUS_CYCLE: LogsStatus[] = ["all", "success", "failed", "conflict"];

const HOTKEYS: Array<{ key: string; label: string; action: LogsAction }> = [
  { key: "r", label: "refresh", action: "refresh" },
  { key: "n", label: "next", action: "next" },
  { key: "p", label: "prev", action: "prev" },
  { key: "f", label: "filter", action: "filter" },
  { key: "q", label: "quit", action: "quit" },
];

function statusLine(entry: OperationLog): string {
  const time = new Date(entry.timestamp).toISOString();
  const summary = entry.summary ?? "";
  return `${time}  [${entry.status.padEnd(8)}]  ${entry.hostId}  ${entry.operation}  ${summary}`.trim();
}

/**
 * Builds the operations-log view: a list of recent operations with status,
 * host, operation, and summary columns. Pagination is informational only —
 * the API exposes a `limit` parameter, not an offset, so `next`/`prev` are
 * stubs for now.
 */
export function renderLogs(opts: RenderLogsOpts): VNode {
  const header = Text({ content: "Operations" });
  const filterLabel = Text({ content: `Filter: ${opts.state.status}` });
  const hostLabel = opts.state.hostId
    ? Text({ content: `Host: ${opts.state.hostId}` })
    : Text({ content: "Host: (any)" });
  const body = renderEntries(opts.state.entries);

  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    header,
    filterLabel,
    hostLabel,
    Text({ content: `Page ${opts.state.page + 1} (${opts.state.entries.length} entries shown)` }),
    Text({ content: "" }),
    body,
    Text({ content: "" }),
    hotkeyFooter(),
  );
}

function renderEntries(entries: OperationLog[]): VNode {
  if (entries.length === 0) {
    return Box(
      { flexDirection: "column" },
      Text({ content: "(no entries)" }),
      Text({ content: "Press r to refresh or f to change filter." }),
    );
  }
  const cells: VNode[] = entries.map((entry) =>
    Text({ content: statusLine(entry) }),
  );
  return Box({ flexDirection: "column", flexGrow: 1 }, ...cells);
}

function hotkeyFooter(): VNode {
  const cells: VNode[] = [];
  for (const hk of HOTKEYS) {
    cells.push(Text({ content: `[${hk.key}] ${hk.label}` }));
  }
  return Box({ flexDirection: "row", gap: 1 }, ...cells);
}

/**
 * Loads the latest operations log entries from the server, applying the
 * current filter and host selection. Server-side `limit` is the page size
 * the UI advertises; the API does not currently support offset-based
 * pagination, so `state.page` is treated as informational.
 */
export async function fetchLogPage(
  api: LamaSyncApiClient,
  state: LogsState,
): Promise<OperationLog[]> {
  const opts: Parameters<LamaSyncApiClient["listOperations"]>[0] = {
    limit: PAGE_SIZE,
  };
  if (state.hostId) opts.hostId = state.hostId;
  if (state.status !== "all") opts.status = state.status;
  return api.listOperations(opts);
}

/**
 * Cycles to the next status filter (all → success → failed → conflict → all).
 */
export function nextStatusFilter(current: LogsStatus): LogsStatus {
  const idx = STATUS_CYCLE.indexOf(current);
  return STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
}
