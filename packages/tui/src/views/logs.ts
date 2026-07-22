import {
  Box,
  BoxRenderable,
  ScrollBox,
  ScrollBoxRenderable,
  Text,
} from "@opentui/core";
import type { CliRenderer, Renderable, VNode } from "@opentui/core";

import type { LamaSyncApiClient, OperationLog } from "@lamasync/core";

import { matchHotkey, type Hotkey, type KeyEvent } from "../app/keymap.ts";
import { realize, swapChildren } from "../app/widgets.ts";
import type { View, ViewContext, ViewId } from "../app/view-manager.ts";

/**
 * Legacy action surface preserved for backward compatibility with the
 * pre-unification router (`views/logs.ts` previously dispatched these from
 * `index.ts`). New callers should bind a `LogsView` and use its hotkeys.
 */
export type LogsAction = "refresh" | "next" | "prev" | "filter" | "quit";

export type LogsStatus = "all" | "success" | "failed" | "conflict";

/**
 * Plain-data snapshot of the logs view's filter + pagination state. The
 * `LogsView` holds a richer instance state internally; this type is the
 * shape other slices/tests can still construct to call the legacy
 * `fetchLogPage` helper.
 */
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
 * host, operation, and summary columns. The body is wrapped in a
 * `ScrollBox`; pagination is driven by `state.page` and the API supports
 * offset-based paging, so `next`/`prev` advance/retreat the offset.
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
  return ScrollBox(
    { flexGrow: 1, scrollY: true, viewportCulling: true },
    Box({ flexDirection: "column", flexGrow: 1 }, ...cells),
  );
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
 * current filter and host selection. The API supports both `limit` and
 * `offset`, so `state.page` is a real cursor.
 */
export async function fetchLogPage(
  api: LamaSyncApiClient,
  state: LogsState,
): Promise<OperationLog[]> {
  const opts: Parameters<LamaSyncApiClient["listOperations"]>[0] = {
    limit: PAGE_SIZE,
    offset: state.page * PAGE_SIZE,
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

interface LogsInternalState {
  entries: OperationLog[];
  status: LogsStatus;
  hostId: string | null;
  page: number;
  loading: boolean;
  error: string | null;
  /** Monotonic counter incremented on every load trigger. Async loaders
   * capture the current value and bail out if a newer load has started,
   * discarding stale results from previous fetches. */
  loadId: number;
  /** Known host ids; refreshed on every onShow via `api.getHealth()`. */
  hostIds: ReadonlyArray<string>;
}

/**
 * Operations log view. Implements the foundation `View` contract. The outer
 * container is built once in the constructor; data refreshes only mutate the
 * ScrollBox's inner Box.
 */
export class LogsView implements View {
  static readonly id: ViewId = "logs";
  static readonly title = "Logs";

  readonly id: ViewId = LogsView.id;
  readonly title: string = LogsView.title;

  private readonly bodyBox: BoxRenderable;
  private readonly scrollBox: ScrollBoxRenderable;
  private readonly headerBox: BoxRenderable;

  private state: LogsInternalState = {
    entries: [],
    status: "all",
    hostId: null,
    page: 0,
    loading: false,
    error: null,
    loadId: 0,
    hostIds: [],
  };

  private ctx: ViewContext | null = null;

  readonly container: Renderable;

  constructor(opts?: { renderer?: CliRenderer | null }) {
    const renderer = opts?.renderer ?? null;
    this.bodyBox = realize<BoxRenderable>(
      renderer,
      Box({ flexDirection: "column", flexGrow: 1 }),
    );
    this.scrollBox = realize<ScrollBoxRenderable>(
      renderer,
      ScrollBox(
        { flexGrow: 1, scrollY: true, viewportCulling: true },
        this.bodyBox,
      ),
    );
    this.headerBox = realize<BoxRenderable>(
      renderer,
      Box(
        { flexDirection: "column" },
        Text({ content: "Operations" }),
        Text({ content: "Filter: all" }),
        Text({ content: "Host: (any)" }),
        Text({ content: "Page 1 (0 entries shown)" }),
        Text({ content: "" }),
        this.scrollBox,
        Text({ content: "" }),
        hotkeyFooter(),
      ),
    );
    // The header Box is a real renderable (LAMA-181); the ViewManager flips
    // `visible` on it when switching tabs.
    this.container = this.headerBox;
    // First render deferred to onShow(): the entries come from the API, so
    // there is nothing meaningful to paint before then.
  }

  hotkeys(): ReadonlyArray<Hotkey> {
    return [
      { key: "r", label: "refresh", run: () => this.refresh() },
      { key: "n", label: "next page", run: () => this.advance() },
      { key: "p", label: "prev page", run: () => this.previous() },
      { key: "f", label: "filter", run: () => this.cycleFilter() },
    ];
  }

  onShow(ctx: ViewContext): void {
    this.ctx = ctx;
    // First paint — bodyBox is a real renderable, so mutations render live.
    this.renderBody();
    void this.refresh();
    void this.refreshHostList();
  }

  onHide(): void {
    this.state.loadId += 1;
  }

  handleKey(e: KeyEvent): boolean {
    const name = typeof e.name === "string" ? e.name : "";
    const raw = typeof e.raw === "string" ? e.raw : "";
    const char = raw.length === 1 ? raw.toLowerCase() : "";
    const match = matchHotkey(this.hotkeys(), name, char);
    if (!match) return false;
    void Promise.resolve(match.run());
    return true;
  }

  destroy(): void {
    this.state.loadId += 1;
    this.ctx = null;
  }

  private async refresh(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    this.state.loadId += 1;
    const myLoad = this.state.loadId;
    this.state.loading = true;
    this.state.error = null;
    this.renderBody();
    try {
      const entries = await fetchLogPage(ctx.api, {
        entries: this.state.entries,
        status: this.state.status,
        hostId: this.state.hostId,
        page: this.state.page,
      });
      if (this.state.loadId !== myLoad) return;
      this.state.entries = entries;
      this.state.loading = false;
    } catch (err) {
      if (this.state.loadId !== myLoad) return;
      this.state.loading = false;
      this.state.error = err instanceof Error ? err.message : String(err);
      ctx.setStatus(`logs: ${this.state.error}`, "error");
    }
    this.renderBody();
  }

  private async refreshHostList(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const health = await ctx.api.getHealth();
      this.state.hostIds = health.hosts.map((h) => h.id);
    } catch {
      this.state.hostIds = [];
    }
  }

  private advance(): void {
    this.state.page += 1;
    void this.refresh();
  }

  private previous(): void {
    if (this.state.page === 0) return;
    this.state.page -= 1;
    void this.refresh();
  }

  private cycleFilter(): void {
    this.state.status = nextStatusFilter(this.state.status);
    this.state.page = 0;
    void this.refresh();
  }

  private renderBody(): void {
    const entries = this.state.entries;
    if (this.state.loading && entries.length === 0) {
      swapChildren(this.bodyBox, [Text({ content: "Loading…" })]);
      return;
    }
    if (this.state.error && entries.length === 0) {
      swapChildren(this.bodyBox, [
        Text({ content: `[!] ${this.state.error}` }),
        Text({ content: "Press r to retry." }),
      ]);
      return;
    }
    if (entries.length === 0) {
      swapChildren(this.bodyBox, [
        Text({ content: "(no entries)" }),
        Text({ content: "Press r to refresh or f to change filter." }),
      ]);
      return;
    }
    const cells: VNode[] = entries.map((entry) =>
      Text({ content: statusLine(entry) }),
    );
    swapChildren(this.bodyBox, cells);
  }
}
