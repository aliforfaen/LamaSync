import { Box, Text, instantiate } from "@opentui/core";
import type { CliRenderer, Renderable, VNode } from "@opentui/core";

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
// Real renderable helpers (LAMA-181)
// ---------------------------------------------------------------------------

/**
 * Instantiate a VNode into a real renderable against `renderer`. Views call
 * this for every node they mutate after mount: OpenTUI's `Box()`/`Text()`/
 * `Select()` factories return VNode proxies whose post-instantiation
 * mutations are silently dead, so interactive nodes must be real instances.
 *
 * Test harnesses construct views without a renderer; in that case the VNode
 * proxy is returned as-is (post-mount mutations stay dead, but pure
 * state-machine tests never render).
 */
export function realize<T extends Renderable>(
  renderer: CliRenderer | null | undefined,
  vnode: VNode,
): T {
  const node = renderer ? instantiate(renderer, vnode) : vnode;
  return node as unknown as T;
}

/**
 * Replace `box`'s children with `next`. Works on real renderables (live
 * remove + add; `add` instantiates VNode children). On an uninstantiated
 * VNode proxy (renderer-less test harness) the removal pass is skipped —
 * proxy `getChildren()` does not return a real child array — and the adds
 * are queued by the proxy exactly like the pre-LAMA-181 tracker did.
 */
export function swapChildren(
  box: Renderable,
  next: ReadonlyArray<VNode | Renderable>,
): void {
  for (const child of mountedChildren(box)) {
    box.remove(child.id);
  }
  for (const child of next) {
    box.add(child);
  }
}

/**
 * Child list of a mounted renderable. Returns `[]` for VNode proxies, whose
 * `getChildren()` either throws or returns the proxy itself instead of an
 * array (verified OpenTUI 0.1.107 behavior — do not iterate that result).
 */
function mountedChildren(box: Renderable): Renderable[] {
  try {
    const children = box.getChildren();
    return Array.isArray(children) ? children : [];
  } catch {
    return [];
  }
}
