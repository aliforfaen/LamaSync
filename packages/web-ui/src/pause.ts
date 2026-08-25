// LAMA-273: pause / slow mode — pure formatting + validation helpers shared by
// the countdown banner and the pause control modal. Kept free of React so the
// logic is unit-testable (mirrors relative-time.ts / format-bytes.ts).

import type { PauseState } from "@lamasync/core";

/** Single-segment rclone size: e.g. "1M", "512K", "2.5G". Mirrors the
 *  server-side validation in routes/pause.ts. */
export const BWLIMIT_RE = /^\d+(?:\.\d+)?[KMGT]?$/i;

/** One-year window used for the "Until I resume" preset — the server requires
 *  a future `until`, and resume is an explicit DELETE, so a far-future value
 *  is the correct encoding of "indefinitely until I say otherwise". */
export const UNTIL_RESUME_MS = 365 * 24 * 3600 * 1000;

/** True when `value` is a valid flat bandwidth cap (or empty = no cap). */
export function validateBwlimit(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || BWLIMIT_RE.test(trimmed);
}

/** ISO timestamp `durationMs` from `now`. Deterministic for tests. */
export function presetUntil(durationMs: number, now: Date = new Date()): string {
  return new Date(now.getTime() + durationMs).toISOString();
}

/** Compact "time left" label, e.g. "39m", "2h", "2h 05m". */
export function formatRemaining(
  until: string,
  now: Date = new Date(),
): string {
  const diffMs = new Date(until).getTime() - now.getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "0m";
  const totalMin = Math.ceil(diffMs / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (mins === 0) return `${hrs}h`;
  return `${hrs}h ${mins.toString().padStart(2, "0")}m`;
}

/** Local clock time the window ends at, e.g. "18:00". */
export function formatUntilClock(until: string): string {
  return new Date(until).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Full banner copy for an active pause state. Slow mode shows the cap and
 *  end clock; plain pause shows the countdown until resume. Never color-alone
 *  — the text label always carries the state. */
export function pauseBannerText(
  state: PauseState,
  now: Date = new Date(),
): string {
  if (state.mode === "slow") {
    const cap = state.bwlimit?.trim();
    return `Slow mode${cap ? ` · ${cap}` : ""} until ${formatUntilClock(state.until)}`;
  }
  return `Syncs paused · resumes in ${formatRemaining(state.until, now)}`;
}
