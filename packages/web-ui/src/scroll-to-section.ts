// LAMA-345 follow-up — in-page navigation to a section.
//
// Two consumers: the Dashboard's "needs attention" row (a plain button that
// scrolls to the Fleet health card, not a link — under HashRouter a `#fragment`
// becomes `/#/#fragment` and never scrolls) and the Folders deep link (which
// brings a folder's health card into view).
//
// The DOM action is typed STRUCTURALLY rather than taking an `HTMLElement`, so
// the behaviour is unit-testable with a plain stub and no inline casts — and so
// the reduced-motion decision stays a pure function of the resolved preference.

import { prefersReducedMotion } from "./motion.ts";

/** The subset of `HTMLElement` this module touches. */
export interface ScrollFocusTarget {
  scrollIntoView(options?: ScrollIntoViewOptions): void;
  focus(options?: FocusOptions): void;
}

export interface ScrollFocusOptions {
  behavior: ScrollBehavior;
  block: ScrollLogicalPosition;
}

/**
 * Scroll options for a resolved reduced-motion answer. Smooth scrolling is
 * motion, so it is skipped when motion is reduced — the section still becomes
 * the viewport target and receives focus either way.
 */
export function scrollFocusOptions(reduceMotion: boolean): ScrollFocusOptions {
  return { behavior: reduceMotion ? "auto" : "smooth", block: "start" };
}

/**
 * Bring `target` into view and move focus to it.
 *
 * `preventScroll` is deliberately false: the scroll is the point on a mouse
 * click. Focus is what makes the jump usable from a keyboard or screen reader —
 * the target must be focusable (a section with `tabindex="-1"`).
 */
export function focusAndScroll(
  target: ScrollFocusTarget,
  reduceMotion: boolean = prefersReducedMotion(),
): void {
  target.scrollIntoView(scrollFocusOptions(reduceMotion));
  target.focus({ preventScroll: true });
}

/**
 * Scroll to (and focus) the element with `id`.
 *
 * Returns false when the element is not on the page, so a caller can fall back
 * to something else instead of appearing to do nothing. `lookup` and
 * `reduceMotion` are injectable so both branches are testable without a DOM.
 */
export function scrollToSection(
  id: string,
  lookup: (id: string) => ScrollFocusTarget | null = defaultLookup,
  reduceMotion: () => boolean = prefersReducedMotion,
): boolean {
  const target = lookup(id);
  if (target === null) return false;
  focusAndScroll(target, reduceMotion());
  return true;
}

/**
 * The section id the Dashboard's urgent row targets. Kept in one place so the
 * button and the Fleet health section cannot drift.
 */
export const FLEET_HEALTH_SECTION_ID = "fleet-health";

function defaultLookup(id: string): ScrollFocusTarget | null {
  if (typeof document === "undefined") return null;
  return document.getElementById(id);
}
