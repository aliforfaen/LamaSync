import { Box, TabSelect, Text, instantiate } from "@opentui/core";
import type {
  BoxRenderable,
  CliRenderer,
  KeyEvent,
  Renderable,
  TabSelectRenderable,
  TextRenderable,
} from "@opentui/core";

import { matchHotkey, type Hotkey } from "./keymap.ts";
import type { ViewContext, ViewId, ViewSpec } from "./view-manager.ts";
import { ViewManager } from "./view-manager.ts";
import { wizardRegistry } from "./wizard.ts";

export interface ShellDeps {
  readonly renderer: CliRenderer;
  readonly ctxByView: ViewContext;
  /** Late-binding view iterator so slice J can supply concrete views. */
  readonly views: () => Iterable<ViewSpec>;
  readonly startView: ViewId;
}

/**
 * Stable id assigned to the root layout Box. OpenTUI's `Renderable.remove`
 * is id-based, so the Shell needs this to detach the layout from
 * `renderer.root` during teardown.
 */
export const SHELL_LAYOUT_ID = "__lamasync_shell_layout__";

/**
 * Top-level TUI shell. Owns the layout (tab bar, content pane, status bar),
 * the global keypress handler, and the ViewManager that dispatches keys to
 * the active view.
 *
 * Dispatch order for the global keypress handler (see `dispatchKey`):
 *   1. Numeric `1`..`N` shortcuts — switch to the view at that index.
 *   2. `leftbracket` / `rightbracket` — cycle to the previous / next view.
 *   3. `escape` — close the active wizard if one is mounted (skeleton: pass
 *      through; slice I wires the cancel hook).
 *   4. `q` (when no Input/Textarea has focus) — call `destroy()`.
 *   5. Active view's `handleKey`, falling back to `matchHotkey(activeHotkeys,
 *      name, char)`.
 *
 * `Enter` is intentionally NEVER handled globally — focused renderables
 * (Select, Input, Textarea) own it.
 */
export class Shell {
  private readonly renderer: CliRenderer;
  private readonly ctxByView: ViewContext;
  private readonly viewsFn: () => Iterable<ViewSpec>;
  private readonly startView: ViewId;
  private readonly manager: ViewManager = new ViewManager();
  private readonly tabBar: TabSelectRenderable;
  private readonly statusText: TextRenderable;
  private readonly layout: BoxRenderable;
  private readonly rootContainer: BoxRenderable;
  private mounted = false;
  private destroyed = false;

  constructor(deps: ShellDeps) {
    this.renderer = deps.renderer;
    this.ctxByView = deps.ctxByView;
    this.viewsFn = deps.views;
    this.startView = deps.startView;

    // Every node the Shell mutates after mount is instantiated into a real
    // renderable up front (LAMA-181): the tab bar gets setOptions /
    // setSelectedIndex calls on every view switch, the status text is
    // rewritten by setStatus, and the layout receives wizard modals via
    // getLayout().add(). VNode proxies would silently drop all of those.
    this.statusText = instantiate(this.renderer, Text({ content: "" })) as TextRenderable;
    this.rootContainer = instantiate(
      this.renderer,
      Box({ flexDirection: "column", flexGrow: 1 }),
    ) as BoxRenderable;
    this.tabBar = instantiate(
      this.renderer,
      TabSelect({
        options: [{ name: " ", description: "" }],
        flexShrink: 0,
      }),
    ) as TabSelectRenderable;

    this.layout = instantiate(
      this.renderer,
      Box(
        { id: SHELL_LAYOUT_ID, flexDirection: "column", flexGrow: 1 },
        this.tabBar,
        this.rootContainer,
        this.statusText,
      ),
    ) as BoxRenderable;
  }

  /**
   * Mount the layout, register the views, show the start view, and install
   * the global keypress handler. After `start()` returns, the shell owns
   * `renderer.keyInput` until `destroy()` is called.
   */
  start(): void {
    if (this.mounted) return;
    const specs = [...this.viewsFn()];
    for (const spec of specs) {
      this.manager.register(spec);
      this.rootContainer.add(spec.container);
    }

    const tabOptions = specs.map((spec) => ({
      name: spec.title,
      description: "",
    }));
    this.tabBar.setOptions(tabOptions);
    const startIndex = this.manager.indexOf(this.startView);
    this.tabBar.setSelectedIndex(startIndex);
    this.tabBar.on("itemSelected", (index: number) => {
      const spec = specs[index];
      if (spec) this.manager.show(spec.id);
    });

    // Attach the layout to the renderer root BEFORE showing the start view.
    // The layout and every view container are real renderables, so this is
    // just a live reparent; the order is kept so first paint happens with
    // the whole tree already rooted.
    this.renderer.root.add(this.layout);
    this.manager.show(this.startView);
    this.renderer.keyInput.on("keypress", (e: KeyEvent) => {
      if (process.env.LAMASYNC_DEBUG_KEYS === "1") {
        try {
          const { writeSync } = require("fs");
          writeSync(2, `[shell-key] name=${e.name} raw=${JSON.stringify(e.raw)} prevented=${e.defaultPrevented} stopped=${e.propagationStopped}\n`);
        } catch { /* ignore */ }
      }
      this.dispatchKey(e);
    });
    this.mounted = true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const spec of this.manager.all()) {
      spec.destroy?.();
    }
    this.renderer.root.remove(SHELL_LAYOUT_ID);
    this.renderer.destroy();
  }

  /**
   * Route a key event through the dispatcher. Returns `true` when the event
   * was consumed so callers (e.g. focused renderables) can skip their own
   * handling.
   */
  dispatchKey(e: KeyEvent): boolean {
    if (this.destroyed) return true;

    const char = (e as { sequence?: string }).sequence ?? "";
    const name = e.name;

    // Step 1: numeric shortcuts.
    if (char.length === 1 && char >= "1" && char <= "9") {
      const index = Number.parseInt(char, 10) - 1;
      const specs = this.manager.all();
      if (index >= 0 && index < specs.length) {
        this.cycleTo(index);
        return true;
      }
    }

    // Step 2: cycle keys.
    if (name === "leftbracket") {
      this.cycleBy(-1);
      return true;
    }
    if (name === "rightbracket") {
      this.cycleBy(1);
      return true;
    }

    // Step 3: active wizard owns input. When a wizard is mounted, the runner
    // receives the key first via Wizard.handleKey — Enter, ESC, q, and any
    // step-level onKey handlers run there. ESC cancels through onCancel as a
    // fallback when the runner's handleKey declines the event.
    if (wizardRegistry.size > 0) {
      const last = [...wizardRegistry.values()].at(-1);
      if (last?.handleKey?.(e) === true) return true;
      if (name === "escape") {
        last?.onCancel?.();
        return true;
      }
    }

    // Step 4: quit.
    if ((char === "q" || char === "Q") && !this.hasInputFocus()) {
      this.destroy();
      return true;
    }

    // Step 5: view-local dispatch.
    const active = this.manager.active();
    if (active.handleKey?.(e) === true) return true;
    const matched: Hotkey | undefined = matchHotkey(
      active.hotkeys,
      name,
      char,
    );
    if (matched) {
      void Promise.resolve(matched.run()).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.setStatus(msg, "error");
      });
      return true;
    }

    return false;
  }

  setStatus(text: string, kind: "info" | "error" | "success"): void {
    const prefix =
      kind === "error" ? "[!] " : kind === "success" ? "[ok] " : "[i] ";
    this.statusText.content = `${prefix}${text}`;
  }

  private cycleBy(delta: number): void {
    const specs = this.manager.all();
    if (specs.length === 0) return;
    const current = this.manager.indexOf(this.manager.activeId());
    const next = (current + delta + specs.length) % specs.length;
    this.cycleTo(next);
  }

  private cycleTo(index: number): void {
    const specs = this.manager.all();
    const spec = specs[index];
    if (!spec) return;
    this.tabBar.setSelectedIndex(index);
    this.manager.show(spec.id);
  }

  /**
   * Heuristic: if a focused OpenTUI Input or Textarea is on the active path,
   * suppress `q` so the user can type it. The manager does not own the
   * focused renderable; the shell asks the renderer for its focused node.
   */
  private hasInputFocus(): boolean {
    const focused = (this.renderer as { focusedRenderable?: unknown })
      .focusedRenderable;
    if (focused === null || focused === undefined) return false;
    const type = (focused as { constructor?: { name?: string } }).constructor
      ?.name;
    return type === "InputRenderable" || type === "TextareaRenderable";
  }

  /** Read-only access to the manager for slice J's wizard wiring. */
  getManager(): ViewManager {
    return this.manager;
  }

  /** Access the top-level layout Box so callers can mount overlay UI. */
  getLayout(): Renderable {
    return this.layout;
  }
}
