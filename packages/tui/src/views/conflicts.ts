import { Box, Select, Text } from "@opentui/core";
import type { KeyEvent, VNode } from "@opentui/core";

import type { Conflict, ConflictResolution, LamaSyncApiClient } from "@lamasync/core";

export type ConflictsAction = "menu" | "quit";

export interface RenderConflictsOpts {
  api: LamaSyncApiClient;
  currentHostId: string;
  onAction: (action: ConflictsAction) => void;
}

export interface ConflictsController {
  view: VNode;
  handleKey: (e: KeyEvent) => void;
  state: ConflictsState;
}

export interface ConflictsState {
  conflicts: Conflict[];
  loading: boolean;
  error: string | null;
  resolving: Set<string>;
}

interface ConflictRow {
  name: string;
  description: string;
  value: string;
}

export function renderConflicts(opts: RenderConflictsOpts): ConflictsController {
  const state: ConflictsState = {
    conflicts: [],
    loading: true,
    error: null,
    resolving: new Set(),
  };

  const controller: ConflictsController = {
    view: renderView(state),
    handleKey: () => undefined,
    state,
  };

  controller.handleKey = (e: KeyEvent) => handleKey(e, state, controller, opts);

  void loadConflicts(controller, opts);
  return controller;
}

async function loadConflicts(
  controller: ConflictsController,
  opts: RenderConflictsOpts,
): Promise<void> {
  try {
    controller.state.conflicts = await opts.api.listConflicts({
      hostId: opts.currentHostId,
      status: "pending",
    });
    controller.state.error = null;
  } catch (err) {
    controller.state.error = err instanceof Error ? err.message : String(err);
  } finally {
    controller.state.loading = false;
  }
  controller.view = renderView(controller.state);
}

function handleKey(
  e: KeyEvent,
  state: ConflictsState,
  controller: ConflictsController,
  opts: RenderConflictsOpts,
): void {
  const name = (e.name ?? "").toLowerCase();
  const raw = typeof e.raw === "string" ? e.raw : "";
  const char = raw.length === 1 ? raw.toLowerCase() : "";

  if (name === "escape" || char === "q") {
    opts.onAction("menu");
    return;
  }

  const selected = state.conflicts.find((c) => !state.resolving.has(c.id));
  if (!selected) return;

  let resolution: ConflictResolution | null = null;
  if (char === "l") resolution = "local";
  if (char === "r") resolution = "remote";
  if (char === "b") resolution = "both";

  if (resolution) {
    state.resolving.add(selected.id);
    controller.view = renderView(state);
    void resolveConflict(controller, opts, selected.id, resolution);
  }
}

async function resolveConflict(
  controller: ConflictsController,
  opts: RenderConflictsOpts,
  id: string,
  resolution: ConflictResolution,
): Promise<void> {
  try {
    await opts.api.resolveConflict(id, resolution);
    controller.state.conflicts = controller.state.conflicts.filter((c) => c.id !== id);
  } catch (err) {
    controller.state.error = err instanceof Error ? err.message : String(err);
  } finally {
    controller.state.resolving.delete(id);
  }
  controller.view = renderView(controller.state);
}

function describeConflict(c: Conflict): string {
  const local = c.localMtime ? new Date(c.localMtime).toISOString() : "unknown";
  const remote = c.remoteMtime ? new Date(c.remoteMtime).toISOString() : "unknown";
  return `local ${local} · remote ${remote}`;
}

function renderView(state: ConflictsState): VNode {
  const header = Text({ content: "Conflicts" });

  if (state.loading) {
    return Box(
      { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
      header,
      Text({ content: "Loading pending conflicts…" }),
      Text({ content: "Press Esc or q to return to menu." }),
    );
  }

  if (state.error) {
    return Box(
      { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
      header,
      Text({ content: `Error: ${state.error}` }),
      Text({ content: "Press Esc or q to return." }),
    );
  }

  if (state.conflicts.length === 0) {
    return Box(
      { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
      header,
      Text({ content: "No pending conflicts." }),
      Text({ content: "Press Esc or q to return." }),
    );
  }

  const rows: ConflictRow[] = state.conflicts.map((c) => ({
    name: c.path,
    description: describeConflict(c),
    value: c.id,
  }));
  const select = Select({ options: rows, flexGrow: 1 });

  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    header,
    Text({ content: `${state.conflicts.length} pending conflict(s). Use ↑/↓ to move.` }),
    Text({ content: "[l] keep local  [r] keep remote  [b] keep both  [q] menu" }),
    Text({ content: "" }),
    select,
  );
}
