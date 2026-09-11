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

// LAMA-334 item 5: the dashboard's pause control was a button whose label was
// always "Pause…", whether or not a pause was already in effect — so the one
// control that changes the state never said what the state was.
//
// This derivation is the contract: the icon AND the action always describe the
// LIVE state (pause when syncing runs, resume when a window is up), a request
// in flight says so instead of looking inert, and an unavailable control says
// why rather than failing silently on tap.

export type PauseControlAction = "pause" | "resume";

export interface PauseControlInput {
  /** The active window for this scope, or null when syncing is running. */
  state: PauseState | null;
  /** A request for this control is in flight. */
  busy: boolean;
  /** Why the control cannot act right now (offline, unreachable), else null. */
  unavailableReason?: string | null;
}

export interface PauseControlState {
  action: PauseControlAction;
  label: string;
  ariaLabel: string;
  title: string;
  /** A window is in effect (pause OR slow mode). */
  active: boolean;
  /** The active window is slow mode rather than a full pause. */
  slow: boolean;
  disabled: boolean;
  disabledReason: string | null;
}

export function pauseControlState(input: PauseControlInput): PauseControlState {
  const { state, busy, unavailableReason = null } = input;
  const active = state !== null;
  const slow = state?.mode === "slow";
  const action: PauseControlAction = active ? "resume" : "pause";

  // The label names the transition while one is running, so the control is
  // never a dead grey button with no explanation.
  const label = busy
    ? active
      ? "Resuming…"
      : "Pausing…"
    : active
      ? "Resume"
      : "Pause";

  const ariaLabel = active
    ? slow
      ? "Resume full speed — slow mode is active"
      : "Resume syncing"
    : "Pause syncing";

  // The title carries the state's own sentence, so hovering (or a screen
  // reader reading the description) gets the countdown, not a guess.
  const title =
    unavailableReason ??
    (state !== null ? pauseBannerText(state) : "Pause syncing for a chosen window");

  const disabled = busy || unavailableReason !== null;

  return {
    action,
    label,
    ariaLabel,
    title,
    active,
    slow,
    disabled,
    disabledReason: unavailableReason,
  };
}
