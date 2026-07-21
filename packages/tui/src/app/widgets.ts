import { Box, Text } from "@opentui/core";
import type { VNode } from "@opentui/core";

import { statusPrefix, type StatusKind } from "./theme.ts";

/**
 * Bordered column with a title row and arbitrary content. Mirrors the
 * existing per-view header pattern used in `views/local.ts`, `views/fleet.ts`,
 * `views/logs.ts`, and `views/conflicts.ts`.
 *
 * Return type is `VNode`; views that need a persistent `Renderable` should
 * wrap the returned node through `instantiate(ctx, vnode)` before handing it
 * to the ViewManager.
 */
export function pageShell(title: string, content: VNode): VNode {
  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    Text({ content: title }),
    content,
  );
}

/**
 * Hotkey footer chip row: each entry renders as `[k] label` separated by a
 * single-column gap. Returns a horizontal Box of Text cells.
 */
export function hotkeyFooter(
  items: ReadonlyArray<{ key: string; label: string }>,
): VNode {
  const cells: VNode[] = [];
  for (const item of items) {
    cells.push(Text({ content: `[${item.key}] ${item.label}` }));
  }
  return Box({ flexDirection: "row", gap: 1 }, ...cells);
}

/**
 * Status line text. Returns `null` when there is no message so the caller can
 * skip mounting it entirely.
 */
export function statusBox(
  message: string | null,
  kind: StatusKind,
): VNode | null {
  if (message === null) return null;
  return Text({ content: `${statusPrefix(kind)}${message}` });
}

/**
 * Bordered "Loading…" column.
 */
export function loadingBox(message: string): VNode {
  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    Text({ content: "Loading…" }),
    Text({ content: message }),
  );
}

/**
 * Bordered error column with the `[!]` prefix and a message body. The
 * `[!]` glyph provides the visual cue without bringing in color/border
 * attributes that callers may want to set themselves.
 */
export function errorBox(title: string, message: string): VNode {
  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    Text({ content: `[!] ${title}` }),
    Text({ content: message }),
  );
}

/**
 * Bordered empty-state column. The message is the sole content cell.
 */
export function emptyBox(message: string): VNode {
  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    Text({ content: message }),
  );
}

// ---------------------------------------------------------------------------
// Child replacement tracker
// ---------------------------------------------------------------------------

import type { ProxiedVNode } from "@opentui/core";
import type { BoxRenderable } from "@opentui/core";

/**
 * Caller-owned list of children currently mounted in a box.
 *
 * OpenTUI VNode proxies return THEMSELVES (not the child array) from
 * `getChildren()` until the node is instantiated against a RenderContext,
 * so iterating `getChildren()` throws `TypeError: {} is not iterable`.
 * Tracking the added children locally keeps re-renders safe in every
 * instantiation state (precedent: `wizard.ts` `renderCurrentStep`).
 */
export interface ChildTracker {
  nodes: Array<{ id: string }>;
}

export function createChildTracker(): ChildTracker {
  return { nodes: [] };
}

/**
 * Replace `box`'s children with `next`, using `tracker` to remember what is
 * currently mounted. Safe to call before the box is instantiated: `add` /
 * `remove` calls are queued by the proxy and replayed on instantiation.
 */
export function replaceChildren(
  box: ProxiedVNode<typeof BoxRenderable>,
  tracker: ChildTracker,
  next: ReadonlyArray<VNode>,
): void {
  for (const child of tracker.nodes) {
    box.remove(child.id);
  }
  tracker.nodes = next.map((n) => n as unknown as { id: string });
  for (const child of next) {
    box.add(child);
  }
}
