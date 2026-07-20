import {
  Box,
  BoxRenderable,
  Select,
  SelectRenderable,
  Text,
} from "@opentui/core";
import type {
  KeyEvent,
  ProxiedVNode,
  Renderable,
  VNode,
} from "@opentui/core";

import type {
  Conflict,
  ConflictResolution,
  LamaSyncApiClient,
} from "@lamasync/core";

import { matchHotkey, type Hotkey } from "../app/keymap.ts";
import type { View, ViewContext, ViewId } from "../app/view-manager.ts";

/**
 * Legacy action surface preserved for backward compatibility with the
 * pre-unification router. The `conflicts` controller previously emitted
 * `"menu"` / `"quit"` actions from `index.ts`; new callers should bind a
 * `ConflictsView` and use the `View.onHide` / `View.destroy` hooks instead.
 */
export type ConflictsAction = "menu" | "quit";

export interface RenderConflictsOpts {
  api: LamaSyncApiClient;
  currentHostId: string;
  onAction: (action: ConflictsAction) => void;
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

type BoxVNode = ProxiedVNode<typeof BoxRenderable>;
type SelectVNode = ProxiedVNode<typeof SelectRenderable>;

/**
 * Pending-conflicts view. Implements the foundation `View` contract.
 *
 * Behavior notes:
 * - `l`/`r`/`b` resolve the conflict under the Select's cursor (NOT the
 *   first non-resolving conflict — that was the pre-unification bug at
 *   conflicts.ts:86 in the old file).
 * - Pressing a resolution key enters an "awaiting confirm" state. A
 *   second press of the same key commits via `api.resolveConflict`;
 *   pressing any other key cancels the confirm.
 * - The Select VNode proxy is held by reference so the view can read
 *   `getSelectedIndex()` / `getSelectedOption()` post-mount.
 */
export class ConflictsView implements View {
  static readonly id: ViewId = "conflicts";
  static readonly title = "Conflicts";

  readonly id: ViewId = ConflictsView.id;
  readonly title: string = ConflictsView.title;

  private readonly selectNode: SelectVNode;
  private readonly contentBox: BoxVNode;

  private state: {
    conflicts: Conflict[];
    loading: boolean;
    error: string | null;
    resolving: Set<string>;
    confirming: { id: string; resolution: ConflictResolution } | null;
    loadId: number;
  } = {
    conflicts: [],
    loading: true,
    error: null,
    resolving: new Set(),
    confirming: null,
    loadId: 0,
  };

  private ctx: ViewContext | null = null;

  readonly container: Renderable;

  constructor() {
    this.selectNode = Select({
      options: [],
      flexGrow: 1,
      showDescription: true,
    });
    this.contentBox = Box({ flexDirection: "column", flexGrow: 1 });
    this.container = Box(
      { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
      Text({ content: "Conflicts" }),
      Text({ content: "Loading pending conflicts…" }),
      Text({ content: "Press Esc or q to return to menu." }),
    ) as unknown as Renderable;
  }

  hotkeys(): ReadonlyArray<Hotkey> {
    return [
      { key: "l", label: "keep local", run: () => this.resolve("local") },
      { key: "r", label: "keep remote", run: () => this.resolve("remote") },
      { key: "b", label: "keep both", run: () => this.resolve("both") },
      { key: "x", label: "cancel", run: () => this.cancel() },
    ];
  }

  onShow(ctx: ViewContext): void {
    this.ctx = ctx;
    void this.load();
  }

  onHide(): void {
    this.state.loadId += 1;
    this.state.confirming = null;
  }

  handleKey(e: KeyEvent): boolean {
    const name = typeof e.name === "string" ? e.name.toLowerCase() : "";
    const raw = typeof e.raw === "string" ? e.raw : "";
    const char = raw.length === 1 ? raw.toLowerCase() : "";

    if (name === "escape") {
      this.cancel();
      return true;
    }
    if (char === "q") {
      // Mirror the pre-unification "return to menu" key. Shell handles
      // navigation, so just bail out of focus here.
      return true;
    }

    const match = matchHotkey(this.hotkeys(), name, char);
    if (!match) {
      // Any non-matching key while confirming cancels the confirm step.
      if (this.state.confirming) this.state.confirming = null;
      return false;
    }
    void Promise.resolve(match.run());
    return true;
  }

  destroy(): void {
    this.state.loadId += 1;
    this.ctx = null;
  }

  /** Pre-unification factory retained for callers that haven't migrated. */
  state$(): ConflictsState {
    return {
      conflicts: this.state.conflicts,
      loading: this.state.loading,
      error: this.state.error,
      resolving: this.state.resolving,
    };
  }

  private async load(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    this.state.loadId += 1;
    const myLoad = this.state.loadId;
    this.state.loading = true;
    this.state.error = null;
    this.renderContent();
    try {
      const conflicts = await ctx.api.listConflicts({
        hostId: ctx.hostname,
        status: "pending",
      });
      if (this.state.loadId !== myLoad) return;
      this.state.conflicts = conflicts;
      this.state.loading = false;
    } catch (err) {
      if (this.state.loadId !== myLoad) return;
      this.state.loading = false;
      this.state.error = err instanceof Error ? err.message : String(err);
    }
    this.renderContent();
  }

  private resolve(resolution: ConflictResolution): void {
    const selectedId = this.selectedConflictId();
    if (selectedId === null) {
      this.ctx?.setStatus("no conflict selected", "error");
      return;
    }
    const confirming = this.state.confirming;
    if (confirming && confirming.id === selectedId && confirming.resolution === resolution) {
      this.state.confirming = null;
      void this.commit(selectedId, resolution);
      return;
    }
    this.state.confirming = { id: selectedId, resolution };
    this.ctx?.setStatus(
      `press ${resolution} again to confirm (any other key cancels)`,
      "info",
    );
  }

  private cancel(): void {
    if (this.state.confirming) {
      this.state.confirming = null;
      this.ctx?.setStatus("resolution cancelled", "info");
    }
  }

  private async commit(id: string, resolution: ConflictResolution): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    this.state.resolving.add(id);
    this.renderContent();
    try {
      await ctx.api.resolveConflict(id, resolution);
      this.state.conflicts = this.state.conflicts.filter((c) => c.id !== id);
      ctx.setStatus(`conflict ${id} resolved (${resolution})`, "success");
    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err);
      ctx.setStatus(`resolve failed: ${this.state.error}`, "error");
    } finally {
      this.state.resolving.delete(id);
    }
    this.renderContent();
  }

  private selectedConflictId(): string | null {
    const conflicts = this.state.conflicts;
    if (conflicts.length === 0) return null;
    // The ProxiedVNode wrapper widens these return types to itself;
    // the underlying Renderable returns number / SelectOption | null.
    const idx = (this.selectNode.getSelectedIndex() as unknown as number);
    if (idx < 0 || idx >= conflicts.length) return null;
    const opt = this.selectNode.getSelectedOption() as unknown as
      | { value?: string }
      | null;
    if (!opt) return null;
    return opt.value ?? null;
  }

  private renderContent(): void {
    const { loading, error, conflicts, confirming } = this.state;
    if (loading && conflicts.length === 0) {
      this.replaceRoot([
        Text({ content: "Conflicts" }),
        Text({ content: "Loading pending conflicts…" }),
        Text({ content: "Press Esc or q to return to menu." }),
      ]);
      return;
    }
    if (error && conflicts.length === 0) {
      this.replaceRoot([
        Text({ content: "Conflicts" }),
        Text({ content: `[!] ${error}` }),
        Text({ content: "Press Esc or q to return." }),
      ]);
      return;
    }
    if (conflicts.length === 0) {
      this.replaceRoot([
        Text({ content: "Conflicts" }),
        Text({ content: "No pending conflicts." }),
        Text({ content: "Press Esc or q to return." }),
      ]);
      return;
    }
    const rows: ConflictRow[] = conflicts.map((c) => ({
      name: c.path,
      description: describeConflict(c),
      value: c.id,
    }));
    this.selectNode.options = rows;
    const confirmLine = confirming
      ? `confirm: press ${confirming.resolution} again to apply to ${confirming.id}`
      : "press l/r/b to resolve the highlighted conflict";
    this.replaceRoot([
      Text({ content: "Conflicts" }),
      Text({ content: `${conflicts.length} pending conflict(s). Use ↑/↓ to move.` }),
      Text({ content: "[l] keep local  [r] keep remote  [b] keep both  [x] cancel" }),
      Text({ content: confirmLine }),
      Text({ content: "" }),
      this.selectNode,
    ]);
  }

  private replaceRoot(children: ReadonlyArray<VNode>): void {
    // Replace children of the outer container — the Box is the only
    // renderable ViewManager holds a reference to via `container`. We
    // mutate its children directly to avoid rebuilding the whole tree.
    const outer = this.container as unknown as BoxVNode;
    const existing = outer.getChildren() as unknown as ReadonlyArray<Renderable>;
    for (const child of existing) {
      outer.remove(child.id);
    }
    for (const node of children) {
      outer.add(node);
    }
  }
}

/**
 * Pre-unification factory kept so callers still importing `renderConflicts`
 * compile. The returned object carries a fresh `ConflictsView` plus the
 * legacy `{ view, handleKey, state }` shape.
 */
export interface ConflictsController {
  view: VNode;
  handleKey: (e: KeyEvent) => void;
  state: ConflictsState;
}

export function renderConflicts(opts: RenderConflictsOpts): ConflictsController {
  const view = new ConflictsView();
  view.onShow({
    api: opts.api,
    hostname: opts.currentHostId,
    socketPath: "",
    setStatus: () => undefined,
    openWizard: () => undefined,
  });
  const state: ConflictsState = {
    conflicts: [],
    loading: true,
    error: null,
    resolving: new Set(),
  };
  const handleKey = (e: KeyEvent): void => {
    view.handleKey?.(e);
    const snap = view.state$();
    state.conflicts = snap.conflicts;
    state.loading = snap.loading;
    state.error = snap.error;
    state.resolving = snap.resolving;
  };
  return {
    view: view.container as unknown as VNode,
    handleKey,
    state,
  };
}

function describeConflict(c: Conflict): string {
  const local = c.localMtime ? new Date(c.localMtime).toISOString() : "unknown";
  const remote = c.remoteMtime ? new Date(c.remoteMtime).toISOString() : "unknown";
  return `local ${local} · remote ${remote}`;
}

