/**
 * Pause / slow-mode helpers for the TUI (LAMA-273).
 *
 * The server resolves the effective pause for a host as the host row if
 * present, otherwise the global row, otherwise null. The TUI mirrors that
 * resolution locally (a host row wins over global) so the status bar can
 * reflect the effective pause without a second /config/:hostId round-trip
 * on every poll.
 *
 * All helpers here are pure: they take a `now` argument so unit tests don't
 * have to mock the clock, and they have no OpenTUI / DOM dependencies, which
 * keeps them out of the renderer lifecycle.
 */
import type { PauseMode, PauseState } from "@lamasync/core";

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Pause duration presets the dialog exposes. The first three map to fixed
 *  windows; `until-resume` is the indefinite choice (mapped to a long but
 *  finite window so the server's past-`until` validation still accepts it).
 *  The server's resume verb is DELETE, so a long preset is safe — the user
 *  (or a daemon) clears it explicitly. */
export type PauseDurationPreset = "1h" | "4h" | "24h" | "until-resume";

export interface DurationPresetRow {
  name: string;
  description: string;
  value: PauseDurationPreset;
}

export const PAUSE_DURATION_PRESETS: ReadonlyArray<DurationPresetRow> = [
  { name: "1 hour", description: "pause syncs for the next hour", value: "1h" },
  { name: "4 hours", description: "pause syncs for four hours", value: "4h" },
  { name: "24 hours", description: "pause syncs for the next day", value: "24h" },
  {
    name: "Until resumed",
    description: "pause until I clear it manually (Ctrl+P)",
    value: "until-resume",
  },
];

/** Compute the epoch-ms `until` value for a duration preset relative to
 *  `now`. `until-resume` maps to a 30-day window — long enough to count as
 *  indefinite, short enough that a stale row can't survive forever if the
 *  user forgets and never clears it. The server is the source of truth; the
 *  preset is a UX shortcut, not a contract. */
export function computeUntilMs(
  preset: PauseDurationPreset,
  now: number = Date.now(),
): number {
  switch (preset) {
    case "1h":
      return now + 1 * MS_PER_HOUR;
    case "4h":
      return now + 4 * MS_PER_HOUR;
    case "24h":
      return now + 24 * MS_PER_HOUR;
    case "until-resume":
      // 30 days — long enough to be "indefinite" without becoming a zombie.
      return now + 30 * MS_PER_DAY;
  }
}

/** Parse an ISO timestamp into epoch ms. Returns `null` for malformed input
 *  so the caller can decide between "inactive" and "garbage row". */
export function parseUntilMs(until: string): number | null {
  const parsed = Date.parse(until);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True when a PauseState still applies (its `until` is in the future). */
export function isPauseActive(
  pause: PauseState | null,
  now: number = Date.now(),
): boolean {
  if (!pause) return false;
  const until = parseUntilMs(pause.until);
  return until !== null && until > now;
}

/** Format a remaining duration as a short status-bar string.
 *  - < 1 minute  → "<1m" (avoid the misleading "0m")
 *  - < 1 hour    → "Nm"
 *  - < 1 day     → "Nh" (or "Nh Mm" when minutes are non-zero)
 *  - ≥ 1 day     → "Nd"
 *
 *  Returns `"<expired>"` when the pause is already in the past so a stale
 *  indicator can render an obvious caption instead of going silently blank.
 */
export function formatPauseDuration(
  until: string,
  now: number = Date.now(),
): string {
  const untilMs = parseUntilMs(until);
  if (untilMs === null) return "—";
  const remaining = untilMs - now;
  if (remaining <= 0) return "<expired>";
  if (remaining < MS_PER_MINUTE) return "<1m";
  if (remaining < MS_PER_HOUR) {
    const minutes = Math.floor(remaining / MS_PER_MINUTE);
    return `${minutes}m`;
  }
  if (remaining < MS_PER_DAY) {
    const hours = Math.floor(remaining / MS_PER_HOUR);
    const leftoverMinutes = Math.floor((remaining % MS_PER_HOUR) / MS_PER_MINUTE);
    return leftoverMinutes === 0 ? `${hours}h` : `${hours}h ${leftoverMinutes}m`;
  }
  const days = Math.floor(remaining / MS_PER_DAY);
  return `${days}d`;
}

/** Format a bandwidth cap for the status bar / dialog ("1M", "512K", ...).
 *  Returns `null` when the input is missing/empty so callers can skip the
 *  suffix without a separate empty-check. */
export function formatBwlimit(bwlimit: string | null | undefined): string | null {
  if (!bwlimit) return null;
  const trimmed = bwlimit.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** One-line caption for a single PauseState, used in the status bar and
 *  the pause dialog's summary. Emoji are ASCII-fallback-safe (the spec
 *  permits plain ASCII — the wrapper below uses them as a primary form). */
export function formatPauseIndicator(
  pause: PauseState,
  now: number = Date.now(),
): string {
  const duration = formatPauseDuration(pause.until, now);
  if (pause.mode === "pause") {
    return `⏸ paused ${duration}`;
  }
  const bw = formatBwlimit(pause.bwlimit);
  return bw === null
    ? `🐢 slow ${duration}`
    : `🐢 slow ${bw} · ${duration}`;
}

/** ASCII-only variant of `formatPauseIndicator` for terminals that cannot
 *  render the emoji glyphs. Mirrors the same duration math. */
export function formatPauseIndicatorAscii(
  pause: PauseState,
  now: number = Date.now(),
): string {
  const duration = formatPauseDuration(pause.until, now);
  if (pause.mode === "pause") {
    return `[paused ${duration}]`;
  }
  const bw = formatBwlimit(pause.bwlimit);
  return bw === null
    ? `[slow ${duration}]`
    : `[slow ${bw} · ${duration}]`;
}

/** Resolve the effective pause for a given local host id using the latest
 *  `/api/v1/pause` snapshot. Mirrors the server-side rule from `config.ts`
 *  (host row wins over global) so the status bar agrees with what each
 *  daemon observes.
 *
 *  Returns `null` when nothing pauses this host OR when both rows are
 *  inactive past their `until` (the server prunes expired rows on read,
 *  but a stale in-memory snapshot may still carry them). */
export function resolveEffectivePause(
  snapshot: { global: PauseState | null; hosts: PauseState[] },
  localHostId: string,
  now: number = Date.now(),
): PauseState | null {
  const hostRow = snapshot.hosts.find((row) => row.hostId === localHostId) ?? null;
  if (isPauseActive(hostRow, now)) return hostRow;
  if (isPauseActive(snapshot.global, now)) return snapshot.global;
  return null;
}

/** Format the status-bar caption for the effective pause, or `null` when
 *  there is nothing to show. Centralises the choice between emoji and
 *  ASCII so the shell + tests agree on a single source of truth. */
export function formatEffectivePauseCaption(
  snapshot: { global: PauseState | null; hosts: PauseState[] },
  localHostId: string,
  now: number = Date.now(),
  opts: { ascii?: boolean } = {},
): string | null {
  const effective = resolveEffectivePause(snapshot, localHostId, now);
  if (effective === null) return null;
  return opts.ascii
    ? formatPauseIndicatorAscii(effective, now)
    : formatPauseIndicator(effective, now);
}