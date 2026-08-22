/**
 * Terminal-safe semantic palette (LAMA-275 design contract).
 *
 * Roles map to the web UI's CSS status tokens so both surfaces share meaning:
 *   accent   → --accent-primary / --accent-info
 *   success  → --accent-ok
 *   warning  → --accent-warn
 *   critical → --accent-critical
 *   muted    → --text-muted
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
  accent: "#4f7cff",
  success: "#3fb950",
  warning: "#d29922",
  critical: "#f85149",
  muted: "#7f8799",
};

/** Tinted backgrounds for selection/raised rows, keyed by role. */
export const PALETTE_BG: Record<PaletteRole, string> = {
  accent: "#1c2a4a",
  success: "#12261a",
  warning: "#2a2210",
  critical: "#2d1414",
  muted: "#1a1f29",
};

/**
 * Selection treatment for list/table rows: raised background + accent text.
 * Views should use this pair instead of inventing per-view selection colors.
 */
export const SELECTION = {
  bg: PALETTE_BG.accent,
  fg: "#e5e8ee",
} as const;
