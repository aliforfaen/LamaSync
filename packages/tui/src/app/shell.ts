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
import { PALETTE_BG, SELECTION } from "./palette.ts";
import { friendlyError } from "../friendly-error.ts";
import type { ViewContext, ViewId, ViewSpec } from "./view-manager.ts";
import { ViewManager } from "./view-manager.ts";
import { wizardRegistry } from "./wizard.ts";
import { formatMarkdownTables } from "../markdown.ts";

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
 *   1. `[` / `]` — cycle to the previous / next view.
 *   2. `escape` — close the active wizard if one is mounted (skeleton: pass
 *      through; slice I wires the cancel hook).
 *   3. `q` (when no Input/Textarea has focus) — call `destroy()`.
 *   4. Active view's `handleKey`, falling back to `matchHotkey(activeHotkeys,
 *      name, char)`.
 *   5. Numeric `1`..`N` shortcuts — switch to the view at that index. Runs
 *      LAST so a view's own digit hotkeys (e.g. Local's `1`/`2`/`3`) win over
 *      tab switching while that view is active.
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
  // Chrome reduction (LAMA-276): the persistent key-hint line is gone — the
  // bottom status line doubles as the hint bar: it shows the default hints
  // until a view/flow calls setStatus, which temporarily replaces them.
  private static readonly DEFAULT_HINT =
    "[?] help   [ / ] views   [q] quit";
  // WS3 (TUI foundations): the `?` help overlay (real renderable, added /
  // removed from the layout). Sized at open time from the renderer dims.
  private readonly helpOverlay: BoxRenderable;
  private readonly helpText: TextRenderable;
  private helpOpen = false;
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
    // Chrome reduction (LAMA-276): one status/hint line instead of the
    // separate hint row — the status text starts as the default hint.
    this.statusText = instantiate(this.renderer, Text({ content: Shell.DEFAULT_HINT })) as TextRenderable;
    this.rootContainer = instantiate(
      this.renderer,
      Box({ flexDirection: "column", flexGrow: 1 }),
    ) as BoxRenderable;
    this.tabBar = instantiate(
      this.renderer,
      TabSelect({
        options: [{ name: " ", description: "" }],
        // Six task-oriented tabs must fit 80 cols with no scroll-arrow
        // truncation (owner relook 2026-08-23): names are <= 12 chars.
        tabWidth: 13,
        flexShrink: 0,
        selectedBackgroundColor: PALETTE_BG.accent,
        selectedTextColor: SELECTION.fg,
      }),
    ) as TabSelectRenderable;

    // WS3: the `?` help overlay is sized/positioned at open time (adaptive
    // help, LAMA-276); the placeholder dims are replaced before it is shown.
    this.helpText = instantiate(
      this.renderer,
      Text({ content: "" }),
    ) as TextRenderable;
    this.helpOverlay = instantiate(
      this.renderer,
      Box(
        {
          flexDirection: "column",
          padding: 1,
          border: true,
          position: "absolute",
          width: 64,
          height: 18,
          backgroundColor: "black",
        },
        Text({ content: "Help — ? or Esc to close" }),
        this.helpText,
      ),
    ) as BoxRenderable;

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

    // LAMA-276/D4: the tab bar only lists visible tabs (drill-in views like
    // GitHub are hidden and opened from the More menu). Views are still all
    // registered, so indexOf/manager.show work for hidden ids too.
    const visible = this.visibleSpecs();
    const tabOptions = visible.map((spec) => ({
      // Relook (owner, 2026-08-23): the tab bar uses the short label when
      // given so all six tabs fit at 80 columns without the '›' truncation.
      name: spec.tabLabel ?? spec.title,
      description: "",
    }));
    this.tabBar.setOptions(tabOptions);
    const startVisibleIndex = visible.findIndex(
      (s) => s.id === this.startView,
    );
    this.tabBar.setSelectedIndex(startVisibleIndex >= 0 ? startVisibleIndex : 0);
    this.tabBar.on("itemSelected", (index: number) => {
      const spec = visible[index];
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

    // Step 1 (WS3): the `?` help overlay is modal — while open, only `?` /
    // Esc act; everything else is swallowed (and prevented, so a focused
    // widget behind the overlay does not receive the key either).
    if (this.helpOpen) {
      if (char === "?" || name === "escape") {
        this.closeHelp();
      }
      e.preventDefault();
      return true;
    }

    // Step 2: active wizard owns input. When a wizard is mounted, the runner
    // receives the key first via Wizard.handleKey — ESC, q, and any
    // step-level onKey handlers run there. ESC cancels through onCancel as a
    // fallback when the runner's handleKey declines the event. A declined
    // key falls through to the focused widget inside the wizard (e.g. typing
    // into an Input) — never to views or global nav behind the modal.
    if (wizardRegistry.size > 0) {
      const last = [...wizardRegistry.values()].at(-1);
      if (last?.handleKey?.(e) === true) {
        e.preventDefault();
        return true;
      }
      if (name === "escape") {
        last?.onCancel?.();
        e.preventDefault();
        return true;
      }
      return false;
    }

    // Step 3: Escape from a drill-in view (hidden from the tab bar, e.g.
    // GitHub under More) returns to its home tab. Visible views never hit
    // this branch — their own handleKey owns Escape.
    if (name === "escape") {
      const active = this.manager.active();
      if (active.hiddenFromTabBar && active.homeTab) {
        this.showView(active.homeTab);
        e.preventDefault();
        return true;
      }
    }

    // Step 4: cycle keys. OpenTUI does not emit "leftbracket"/"rightbracket"
    // key names — brackets arrive as printable chars — so match both. While
    // a text Input owns focus the brackets are literal text, not navigation.
    if (!this.hasInputFocus()) {
      if (name === "leftbracket" || char === "[") {
        this.cycleBy(-1);
        e.preventDefault();
        return true;
      }
      if (name === "rightbracket" || char === "]") {
        this.cycleBy(1);
        e.preventDefault();
        return true;
      }
    }

    // Step 5 (WS3): open the `?` help overlay (only with no wizard mounted
    // and no text Input focused — otherwise `?` is literal input text).
    if ((char === "?" || name === "questionmark") && !this.hasInputFocus()) {
      this.openHelp();
      e.preventDefault();
      return true;
    }

    // Step 6: quit.
    if ((char === "q" || char === "Q") && !this.hasInputFocus()) {
      this.destroy();
      return true;
    }

    // Step 7: view-local dispatch.
    const active = this.manager.active();
    if (active.handleKey?.(e) === true) return true;
    const matched: Hotkey | undefined = matchHotkey(
      active.hotkeys,
      name,
      char,
    );
    if (matched) {
      void Promise.resolve(matched.run()).catch((err: unknown) => {
        this.setStatus(friendlyError(err), "error");
      });
      return true;
    }

    // Step 8: numeric tab shortcuts (visible tabs only). Runs after
    // view-local dispatch so a view's own digit hotkeys (Local's 1/2/3) take
    // precedence while active. Digits are literal text while a text Input
    // owns focus.
    if (
      !this.hasInputFocus() &&
      char.length === 1 &&
      char >= "1" &&
      char <= "9"
    ) {
      const index = Number.parseInt(char, 10) - 1;
      const specs = this.visibleSpecs();
      if (index >= 0 && index < specs.length) {
        this.cycleToIndex(index);
        return true;
      }
    }

    return false;
  }

  setStatus(text: string, kind: "info" | "error" | "success"): void {
    const prefix =
      kind === "error" ? "[!] " : kind === "success" ? "[ok] " : "[i] ";
    this.statusText.content = `${prefix}${text}`;
  }

  /** Restore the default hint text in the status/hint bar. */
  clearStatus(): void {
    this.statusText.content = Shell.DEFAULT_HINT;
  }

  /**
   * Tab-bar-visible specs only (drill-in/hidden views excluded).
   */
  private visibleSpecs(): ViewSpec[] {
    return this.manager.all().filter((s) => s.hiddenFromTabBar !== true);
  }

  /**
   * Show any registered view by id. Visible views also select their tab;
   * hidden views (GitHub under More) show without touching the tab bar.
   */
  showView(id: ViewId): void {
    const visible = this.visibleSpecs();
    const tabIndex = visible.findIndex((s) => s.id === id);
    if (tabIndex !== -1) {
      this.tabBar.setSelectedIndex(tabIndex);
    }
    this.manager.show(id);
  }

  private openHelp(): void {
    const active = this.manager.active();
    const viewLines = (active?.hotkeys ?? [])
      .map((h) => `[${h.key}] ${h.label}`)
      .join("\n");
    // Adaptive help (LAMA-276): clamp the overlay to the live renderer
    // dimensions instead of a hard-coded 64×18 box, so 60×20 terminals
    // still get a readable dialog without overlapping the status line.
    const rw = this.renderer.width ?? 80;
    const rh = this.renderer.height ?? 24;
    const width = Math.max(40, Math.min(64, rw - 4));
    const height = Math.max(12, Math.min(18, rh - 4));
    // OpenTUI Renderable exposes these as property setters on the live
    // instance (no `options` passthrough on BoxRenderable).
    this.helpOverlay.width = width;
    this.helpOverlay.height = height;
    this.helpOverlay.left = Math.max(0, Math.floor((rw - width) / 2));
    this.helpOverlay.top = Math.max(0, Math.floor((rh - height) / 2));
    const lines = [
      "Global keys",
      "[ / ]  cycle views",
      "1-6    jump to tab",
      "?      toggle help",
      "q      quit",
      "Esc    cancel wizard / close help",
      "",
      `Active view — ${active?.title ?? "?"}`,
      viewLines.length > 0 ? viewLines : "(no view hotkeys)",
    ].join("\n");
    this.helpText.content = formatMarkdownTables(lines, width);
    this.layout.add(this.helpOverlay);
    this.helpOpen = true;
  }

  private closeHelp(): void {
    this.layout.remove(this.helpOverlay.id);
    this.helpOpen = false;
  }

  private cycleBy(delta: number): void {
    const specs = this.visibleSpecs();
    if (specs.length === 0) return;
    const current = specs.findIndex((s) => s.id === this.manager.activeId());
    const base = current === -1 ? 0 : current;
    const next = (base + delta + specs.length) % specs.length;
    this.cycleToIndex(next);
  }

  private cycleToIndex(index: number): void {
    // If a drill-in (hidden) view is active, cycle from its home tab.
    const specs = this.visibleSpecs();
    const spec = specs[index];
    if (!spec) return;
    this.tabBar.setSelectedIndex(index);
    this.manager.show(spec.id);
  }

  /**
   * Heuristic: if a focused OpenTUI Input or Textarea is on the active path,
   * suppress `q` so the user can type it. The manager does not own the
   * focused renderable; the shell asks the renderer for its focused node
   * (`currentFocusedRenderable` — OpenTUI 0.1.107).
   */
  private hasInputFocus(): boolean {
    const focused = (this.renderer as { currentFocusedRenderable?: unknown })
      .currentFocusedRenderable;
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
