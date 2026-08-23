// More tab: tools/integrations entry point (LAMA-276 / approved D4). The
// top-level GitHub tab moves under this menu so integrations don't compete
// with core destinations; all GitHub functionality stays reachable one level
// deeper (the `gh` view remains registered but hidden from the tab bar).
//
// Implements the foundation `View` contract — the outer container is built
// once in the constructor; refreshes swap only the body Box's children.
// Enter on a menu row triggers `ctx.navigateTo(id)`, which the Shell wires
// to `showView` so hidden views (gh) open without appearing in the tab bar.

import { Box, Select, Text } from "@opentui/core";
import type {
  BoxRenderable,
  KeyEvent,
  ProxiedVNode,
  Renderable,
  SelectRenderable,
  VNode,
} from "@opentui/core";

import { hotkeyFooter, pageShell, realize, statusBox, swapChildren } from "../app/widgets.ts";
import type { Hotkey } from "../app/keymap.ts";
import { PALETTE_BG, SELECTION } from "../app/palette.ts";
import { matchHotkey } from "../app/keymap.ts";
import type {
  View,
  ViewContext,
  ViewId,
} from "../app/view-manager.ts";

interface MoreRow {
  name: string;
  description: string;
  value: ViewId;
}

const TOOLS: readonly MoreRow[] = [
  {
    name: "GitHub",
    description: "adopt a repository — creates a synced git folder",
    value: "gh",
  },
];

function toRows(): MoreRow[] {
  return TOOLS.map((t) => ({ ...t }));
}

/**
 * More view. Renders a short menu of tools/integrations; selecting an entry
 * navigates to the wrapped view via `ctx.navigateTo`. The menu is static
 * (entry points are known at boot) so there is no per-row data fetch.
 */
export class MoreView implements View {
  static readonly id: ViewId = "more";
  static readonly title = "More";

  readonly id: ViewId = MoreView.id;
  readonly title: string = MoreView.title;

  private readonly bodyBox: BoxRenderable;
  private readonly statusBlock: BoxRenderable;
  // Per-render Select: built fresh on every renderBody() so the live
  // SelectRenderable instance is created at the same time as the parent Box.
  private currentSelect: ProxiedVNode<typeof SelectRenderable> | null = null;

  private ctx: ViewContext | null = null;

  readonly container: Renderable;

  constructor(opts: { ctx: ViewContext }) {
    const renderer = opts.ctx.renderer;
    this.bodyBox = realize<BoxRenderable>(
      renderer,
      Box({ flexDirection: "column", flexGrow: 1 }),
    );
    this.statusBlock = realize<BoxRenderable>(
      renderer,
      Box({ flexDirection: "column" }),
    );
    this.container = realize<Renderable>(
      renderer,
      pageShell(
        "More",
        Box(
          { flexDirection: "column", flexGrow: 1 },
          this.bodyBox,
          this.statusBlock,
        ),
      ),
    );
  }

  hotkeys(): ReadonlyArray<Hotkey> {
    return [
      { key: "g", label: "GitHub", run: () => this.ctx?.navigateTo?.("gh") },
    ];
  }

  onShow(ctx: ViewContext): void {
    this.ctx = ctx;
    // First paint — bodyBox is a real renderable, so mutations render live.
    this.renderBody();
  }

  onHide(): void {
    this.ctx = null;
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
    this.ctx = null;
  }

  private renderBody(): void {
    const rows = toRows();
    const select = Select({
      options: rows,
      flexGrow: 1,
      selectedBackgroundColor: PALETTE_BG.accent,
      selectedTextColor: SELECTION.fg,
    });
    select.on("itemSelected", (_i: number, opt: MoreRow) => {
      const target = TOOLS.find((t) => t.value === opt.value);
      if (!target) return;
      this.ctx?.navigateTo?.(target.value);
    });
    this.currentSelect = select;

    const children: VNode[] = [
      Text({ content: "Tools & integrations. Use ↑/↓ to move, Enter to open." }),
      Text({ content: "" }),
      Box({ flexDirection: "column", flexGrow: 1 }, select),
      Text({ content: "" }),
      hotkeyFooter(this.hotkeys().map((h) => ({ key: h.key, label: h.label }))),
    ];

    swapChildren(this.bodyBox, children);

    const status = statusBox(null, "info");
    swapChildren(this.statusBlock, status === null ? [] : [status]);
  }
}