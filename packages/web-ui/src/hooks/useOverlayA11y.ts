// Polish run P-A (2026-08-26): shared focus/keyboard contract for every
// overlay in the web UI. Every overlay must:
//   1. trap Tab within itself,
//   2. close on Escape,
//   3. return focus to the element that opened it on close,
//   4. carry role="dialog" + aria-modal="true" + a label (the component
//      owns those attributes; this hook owns the behaviour).
//
// The hook is mount-agnostic: it works both for overlays that unmount when
// closed (`{open && <Modal/>}`) and for ones that stay mounted and render
// `null` (the DryRunDrawer). Focus capture runs when `open` becomes true;
// focus is restored on every close path — the open-effect cleanup runs both
// on unmount (modal) and on the `open` → false transition (drawer), and the
// restore/focus RAFs are scheduled in an order that leaves focus on the
// overlay's first element in dev StrictMode double-mounts.

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Elements inside `container` that can receive keyboard focus today. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0 && el.getAttribute("aria-hidden") !== "true",
  );
}

export interface UseOverlayA11yOptions {
  open: boolean;
  onClose: () => void;
}

/**
 * Focus trap + Escape-to-close + focus return for one overlay. Attach the
 * returned ref to the overlay's root element (the backdrop); the overlay
 * itself must render role/aria-modal/aria-label on its panel.
 */
export function useOverlayA11y<T extends HTMLElement>({
  open,
  onClose,
}: UseOverlayA11yOptions): RefObject<T> {
  const containerRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const invokerRef = useRef<HTMLElement | null>(null);
  // The element the user was interacting with when the overlay opened. Kept
  // at pointerdown/keydown time (NOT at effect time): an overlay can disable
  // its own trigger button while opening (e.g. the dry-run drawer), which
  // drops focus to <body> before the open-effect runs — capturing on the
  // event keeps the real invoker for the focus-return.
  const lastInteractRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function onInteractStart(event: Event) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const focusable = target.closest(
        "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      lastInteractRef.current = focusable instanceof HTMLElement ? focusable : target;
    }
    document.addEventListener("pointerdown", onInteractStart, true);
    document.addEventListener("keydown", onInteractStart, true);
    return () => {
      document.removeEventListener("pointerdown", onInteractStart, true);
      document.removeEventListener("keydown", onInteractStart, true);
    };
  }, []);

  // Capture the invoker and move focus to the first focusable element when
  // the overlay opens. The cleanup restores focus on every close path.
  useEffect(() => {
    if (!open) return;
    const active =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null;
    invokerRef.current = active ?? lastInteractRef.current;
    const container = containerRef.current;
    const raf = requestAnimationFrame(() => {
      if (!container) return;
      const focusable = getFocusableElements(container);
      (focusable[0] ?? container).focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      const invoker = invokerRef.current;
      invokerRef.current = null;
      if (invoker && document.contains(invoker)) {
        requestAnimationFrame(() => invoker.focus());
      }
    };
  }, [open]);

  // Escape closes; Tab cycles within the overlay. Document-level capture so
  // the trap holds even when focus would otherwise leave the container.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      const container = containerRef.current;
      if (!container) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(container);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && container.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  return containerRef;
}