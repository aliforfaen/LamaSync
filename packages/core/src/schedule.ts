// LAMA-336: one schedule grammar for every surface that accepts one.
//
// The daemon's Scheduler is the authority on what can actually fire: it
// special-cases `@reboot` and `@login`, and hands everything else to
// `cron-parser`. Web forms and the REST API previously each carried their own
// idea of validity, so an expression the server stored could be one the daemon
// logged as invalid and never fired — an enabled protection with no snapshots
// and no error anywhere. Validation now runs through the same parser the
// daemon schedules with, so "accepted" and "will fire" are the same set.

import { CronExpressionParser } from "cron-parser";

/** Cron keywords `cron-parser` expands to a fixed expression. It matches these
 *  case-sensitively, exactly as the daemon relies on. */
const CRON_KEYWORDS: ReadonlySet<string> = new Set([
  "@hourly",
  "@daily",
  "@weekly",
  "@monthly",
  "@yearly",
  "@annually",
]);

/** Keywords the daemon's Scheduler handles itself, without a cron field. */
export const SCHEDULE_SPECIAL_KEYWORDS: ReadonlySet<string> = new Set(["@reboot", "@login"]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Validate a cron expression or special token the way the daemon schedules it.
 * `@reboot` and `@login` are matched exactly (the Scheduler compares strings).
 *
 * Returns null when the expression is schedulable, otherwise a message safe to
 * return to an operator. A blank expression is an error: "no schedule" is
 * expressed as a null schedule, not as an empty string, and `cron-parser`
 * would otherwise read `""` as `* * * * *` (every minute).
 *
 * The invariant is one-directional: everything accepted here the daemon can
 * schedule. The converse is deliberately not offered — `cron-parser` pads a
 * 4-field expression into a 6-field one (seconds!), so `* * * *` would mean
 * "every second". An app capture is a full archive upload, so the accepted
 * form is the 5-field minute-granularity expression the forms offer.
 */
export function validateScheduleExpression(expr: string): string | null {
  const trimmed = expr.trim();
  if (trimmed === "") {
    return "schedule is empty; leave it unset to keep the protection manual-only";
  }
  if (SCHEDULE_SPECIAL_KEYWORDS.has(trimmed)) return null;
  if (trimmed.startsWith("@") && !CRON_KEYWORDS.has(trimmed)) {
    return `unknown schedule keyword '${trimmed}' (supported: @reboot, @login, @hourly, @daily, @weekly, @monthly, @yearly, @annually)`;
  }
  if (!CRON_KEYWORDS.has(trimmed) && trimmed.split(/\s+/).length !== 5) {
    return "cron must have 5 fields (minute hour day-of-month month day-of-week), e.g. `0 */6 * * *`";
  }
  try {
    CronExpressionParser.parse(trimmed, { currentDate: new Date() });
    return null;
  } catch (err) {
    return `invalid cron expression: ${errorMessage(err)}`;
  }
}
