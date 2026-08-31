/**
 * Terminal-safe semantic palette (LAMA-275 design contract).
 *
 * Roles map to the web UI's warm CSS status tokens so both surfaces share
 * meaning:
 *   accent   → teal / --accent-info (direct interaction and selection)
 *   success  → moss / --accent-ok
 *   warning  → clay / --accent-warn
 *   critical → rust / --accent-critical
 *   muted    → warm graphite / --text-muted
 *
 * Values are OpenTUI color strings. They are chosen from the xterm-256 palette
 * so they degrade acceptably on 256-color terminals, and every status cue MUST
 * also carry a text prefix ([ok] / [!] / [i]) or label so color is never the
 * only signal (matches the web rule and basic-terminal degradation).
 */

export type PaletteRole =
  | "accent"
  | "success"
  | "warning"
  | "critical"
  | "muted";

export const PALETTE: Record<PaletteRole, string> = {
  accent: "#75c3b1",
  success: "#9abb70",
  warning: "#d6a55b",
  critical: "#d87952",
  muted: "#8d8777",
};

/** Tinted backgrounds for selection/raised rows, keyed by role. */
export const PALETTE_BG: Record<PaletteRole, string> = {
  accent: "#22352f",
  success: "#283523",
  warning: "#3a2c1b",
  critical: "#3d241c",
  muted: "#25261f",
};

/**
 * Selection treatment for list/table rows: raised background + accent text.
 * Views should use this pair instead of inventing per-view selection colors.
 */
export const SELECTION = {
  bg: PALETTE_BG.accent,
  fg: "#f2eedf",
} as const;
