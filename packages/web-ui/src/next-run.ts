// Human "next run" sentence for a schedule expression (LAMA-267).
//
// Uses the exact same computation as the daemon's Scheduler (`cron-parser`'s
// `CronExpressionParser.parse(expr, { currentDate }).next().toDate()`), so
// the sentence matches what the daemon will actually do — no new endpoint,
// purely client-side. `@reboot` / `@login` have no fixed next fire and get a
// friendly phrase instead of a timestamp; everything that cron-parser can't
// schedule (invalid, never-firing, unknown @-keywords) yields null so callers
// show nothing.

import { CronExpressionParser } from "cron-parser";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * "Next: …" sentence for a schedule expression, or null when there is
 * nothing schedulable to say (empty, invalid, or never-firing).
 */
export function nextRunSentence(expr: string | null | undefined, now = new Date()): string | null {
  if (!expr) return null;
  const trimmed = expr.trim();
  if (trimmed === "") return null;
  if (trimmed === "@reboot") return "Next: on boot";
  if (trimmed === "@login") return "Next: on login";
  let next: Date;
  try {
    next = CronExpressionParser.parse(trimmed, { currentDate: now }).next().toDate();
  } catch {
    // cron-parser mirrors the daemon's allowlist: invalid expressions and
    // non-firing dates (e.g. "0 0 31 2 *") throw — nothing to show.
    return null;
  }
  return `Next: ${nextRunPhrase(next, now)}`;
}

function nextRunPhrase(next: Date, now: Date): string {
  const diffMs = next.getTime() - now.getTime();
  if (diffMs < MINUTE_MS) return "in under a minute";
  if (diffMs < HOUR_MS) return `in ${Math.max(1, Math.round(diffMs / MINUTE_MS))}m`;

  const hour = next.getHours();
  // Within ~12h, "tonight at 02:00" beats "in 6h" for the coming
  // evening/night — the canonical example from LAMA-267.
  if (diffMs < 12 * HOUR_MS && (hour < 6 || hour >= 17)) {
    return `tonight at ${hhmm(next)}`;
  }
  if (sameDay(next, now)) return `today at ${hhmm(next)}`;
  if (isTomorrow(next, now)) return `tomorrow at ${hhmm(next)}`;
  if (diffMs < 7 * DAY_MS) return `on ${WEEKDAYS[next.getDay()]} at ${hhmm(next)}`;
  return `on ${MONTHS[next.getMonth()]} ${next.getDate()} at ${hhmm(next)}`;
}

function hhmm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isTomorrow(a: Date, b: Date): boolean {
  const t = new Date(b);
  t.setDate(t.getDate() + 1);
  return sameDay(a, t);
}