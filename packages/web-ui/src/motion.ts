// Polish run P-A (2026-08-26): the single, grep-able reduced-motion gate for
// JS-driven animation in the web UI. CSS animations are gated individually in
// index.css under `@media (prefers-reduced-motion: reduce|no-preference)` —
// this helper is for components that must make a rendering decision at
// runtime (e.g. render a static fallback instead of CSS particles).

/** Conservative motion gate: without a browser to honour it, no animation. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}