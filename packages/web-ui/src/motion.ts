// LAMA-329 phase 5: the browser reduced-motion preference, as an override.
//
// The plan asks for a "reduced-motion override (default system)". The default
// is the OS/browser setting; the override exists because a person can want
// motion reduced (or restored) on one site for reasons the OS preference does
// not capture — an operator on a calm desktop still wants the console quiet,
// and someone whose OS reduces motion may still want the llama boot state to
// breathe.
//
// Two consumers must agree on the resolved answer, or the UI would animate in
// CSS while a JS component rendered its static fallback:
//   1. `prefersReducedMotion()` below — the runtime gate used by Confetti and
//      anything else that picks a render path in JS.
//   2. `<html data-motion>` — mirrored here and read by the two-spelling CSS
//      gates in index.css (system media query + explicit attribute).

export type MotionChoice = "system" | "reduce" | "full";

const MOTION_KEY = "lamasync-motion";
const VALID_CHOICES: MotionChoice[] = ["system", "reduce", "full"];

export function loadMotionChoice(): MotionChoice {
  if (typeof localStorage === "undefined") {
    return "system";
  }
  const stored = localStorage.getItem(MOTION_KEY);
  if (stored && (VALID_CHOICES as readonly string[]).includes(stored)) {
    return stored as MotionChoice;
  }
  return "system";
}

export function saveMotionChoice(choice: MotionChoice): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(MOTION_KEY, choice);
  }
}

/** The choice currently applied to `<html>`, or `system` when unset. */
export function currentMotionChoice(): MotionChoice {
  if (typeof document === "undefined") {
    return "system";
  }
  const value = document.documentElement.dataset.motion;
  if (value && (VALID_CHOICES as readonly string[]).includes(value)) {
    return value as MotionChoice;
  }
  return "system";
}

/**
 * Mirror the choice onto `<html data-motion>`. `system` still writes the
 * attribute so the CSS `:not([data-motion="reduce"])` gate stays meaningful.
 */
export function applyMotion(choice: MotionChoice): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.motion = choice;
  }
}

// Polish run P-A (2026-08-26): the single, grep-able reduced-motion gate for
// JS-driven animation in the web UI. CSS animations are gated by the
// two-spelling rules in index.css — this helper is for components that must
// make a rendering decision at runtime (e.g. render a static fallback instead
// of CSS particles).
//
// Conservative motion gate: without a browser to honour it, no animation.

/** True when motion should be suppressed — system preference plus override. */
export function prefersReducedMotion(): boolean {
  const choice = currentMotionChoice();
  if (choice === "reduce") return true;
  if (choice === "full") return false;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
