import type { Renderable } from "@opentui/core";

import type { LamaSyncApiClient } from "@lamasync/core";

import type { Hotkey, KeyEvent } from "./keymap.ts";
import type { Wizard } from "./wizard.ts";

/**
 * Stable identifier for every registered top-level view. The Tabs row uses
 * this for ordering and the Shell uses it to look up the active view when
 * dispatching keys.
 *
 * `menu` is deliberately omitted here — slice J retires `views/menu.ts`.
 * `gh` is part of the union so the GhView stays a discoverable tab; slice J
 * owns the rest of the integration (menu retirement, wiring, removal).
 */
export type ViewId = "local" | "fleet" | "dotfiles" | "conflicts" | "logs" | "gh";

/**
 * API client, the local hostname, the daemon socket path, and a status
 * callback the view can use to surface feedback. `openWizard` lets the view
 * push a wizard onto the Shell's stack.
 *
 * OpenTUI's `RenderContext` is intentionally NOT exposed here: the Shell owns
 * the renderer, and the View's container is a `Renderable` (typically a
 * `ProxiedVNode` returned by `Box(...)`) that the View constructs before
 * registration. Views that need raw access to the renderer can take it via
 * their own constructor — the Shell wiring site in slice J will pass it in.
 */
export interface ViewContext {
  readonly api: LamaSyncApiClient;
  readonly hostname: string;
  readonly socketPath: string;
  readonly setStatus: (msg: string, kind?: "info" | "error" | "success") => void;
  readonly openWizard: (wizard: Wizard) => void;
}

/**
 * The pure view contract. `View` instances do not know about the Shell or
 * the ViewManager lifecycle — those concerns live in `ViewSpec`, which the
 * ViewManager constructs from a `View` plus a `ViewContext`.
 *
 * `container` is typed as `Renderable`. OpenTUI's `Box(...)` returns a
 * `ProxiedVNode` that inherits from the underlying Renderable's prototype
 * and forwards property/method calls — including `visible`, `add`, and
 * `remove`. Views may therefore pass the VNode proxy directly; the manager
 * only needs to flip `visible` and the proxy handles the rest.
 */
export interface View {
  readonly id: ViewId;
  readonly title: string;
  readonly container: Renderable;
  readonly hotkeys: () => ReadonlyArray<Hotkey>;
  onShow: (ctx: ViewContext) => void;
  onHide?: () => void;
  handleKey?: (e: KeyEvent) => boolean;
  destroy?: () => void;
}

/**
 * Pre-bound view record the ViewManager stores. Lifecycle hooks are already
 * closed over `ctx` so the manager can dispatch them without re-passing the
 * context on every call.
 */
export interface ViewSpec {
  readonly id: ViewId;
  readonly title: string;
  readonly container: Renderable;
  readonly hotkeys: ReadonlyArray<Hotkey>;
  readonly ctx: ViewContext;
  readonly onShow?: () => void;
  readonly onHide?: () => void;
  readonly handleKey?: (e: KeyEvent) => boolean;
  readonly destroy?: () => void;
}

/**
 * Holds the registered view set and exposes a minimal lifecycle API.
 *
 *   - `register` adds a view; the first registered view becomes the initial
 *     active one when `show` runs.
 *   - `show` toggles container visibility and calls lifecycle hooks.
 *   - `activeId` / `active` / `hotkeysFor` / `all` are read-only inspectors.
 */
export class ViewManager {
  private readonly views: ViewSpec[] = [];
  private activeIndex = -1;

  register(view: ViewSpec): void {
    setContainerVisible(view.container, false);
    this.views.push(view);
  }

  show(id: ViewId): void {
    const nextIndex = this.views.findIndex((v) => v.id === id);
    if (nextIndex === -1) return;
    if (nextIndex === this.activeIndex) {
      setContainerVisible(this.views[nextIndex]!.container, true);
      return;
    }
    if (this.activeIndex !== -1) {
      const previous = this.views[this.activeIndex]!;
      previous.onHide?.();
      setContainerVisible(previous.container, false);
    }
    const next = this.views[nextIndex]!;
    this.activeIndex = nextIndex;
    setContainerVisible(next.container, true);
    next.onShow?.();
  }

  activeId(): ViewId {
    if (this.activeIndex === -1) {
      throw new Error("ViewManager: no view has been shown yet");
    }
    return this.views[this.activeIndex]!.id;
  }

  active(): ViewSpec {
    if (this.activeIndex === -1) {
      throw new Error("ViewManager: no view has been shown yet");
    }
    return this.views[this.activeIndex]!;
  }

  hotkeysFor(id: ViewId): ReadonlyArray<Hotkey> {
    const view = this.views.find((v) => v.id === id);
    return view?.hotkeys ?? [];
  }

  all(): ViewSpec[] {
    return [...this.views];
  }

  /**
   * Index helper used by the Shell's number-key shortcut and TabSelect
   * wiring. Throws if the view is not registered.
   */
  indexOf(id: ViewId): number {
    const index = this.views.findIndex((v) => v.id === id);
    if (index === -1) {
      throw new Error(`ViewManager: unknown view id '${id}'`);
    }
    return index;
  }
}

function setContainerVisible(container: Renderable, visible: boolean): void {
  // The OpenTUI Renderable base class exposes a `visible` setter; assigning
  // through the typed property is enough for both Renderable instances and
  // ProxiedVNode proxies (the proxy forwards the assignment to the underlying
  // Renderable).
  (container as { visible: boolean }).visible = visible;
}
