// WS3 (TUI foundations): a small cron sanity checker for the wizard flows.
// Plain string → error-string function, unit-tested. It is a sanity check,
// not a full cron parser: five whitespace-separated fields, numeric ranges
// per field, `*` / steps / ranges / lists, plus the @-keywords the daemon
// can actually schedule.
//
// LAMA-247 #10: the allowlist mirrors the daemon Scheduler — cron-parser
// 5.x understands @hourly/@daily/@weekly/@monthly/@yearly/@annually, and the
// Scheduler special-cases @reboot/@login. @midnight and @noon are NOT
// schedulable (cron-parser rejects them and the daemon never fires) so they
// are rejected here rather than accepted then silently never running.

const AT_KEYWORDS: ReadonlySet<string> = new Set([
  "@reboot",
  "@login",
  "@hourly",
  "@daily",
  "@weekly",
  "@monthly",
  "@yearly",
  "@annually",
]);

/** Per-field [min, max] for minute, hour, day-of-month, month, day-of-week
 *  (0 and 7 both mean Sunday in day-of-week). */
const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export function validateCronExpression(expr: string): string | null {
  const trimmed = expr.trim();
  if (trimmed === "") {
    return "cron expression is required";
  }
  if (AT_KEYWORDS.has(trimmed.toLowerCase())) {
    return null;
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return "cron must be 5 fields, e.g. 0 * * * * = hourly";
  }
  for (let i = 0; i < fields.length; i++) {
    const err = validateCronField(fields[i], FIELD_RANGES[i][0], FIELD_RANGES[i][1]);
    if (err) return err;
  }
  return null;
}

function validateCronField(field: string, min: number, max: number): string | null {
  const parts = field.split(",");
  for (const part of parts) {
    const rangeMatch = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part);
    if (rangeMatch) {
      const lo = Number.parseInt(rangeMatch[1], 10);
      const hi = Number.parseInt(rangeMatch[2], 10);
      const step = rangeMatch[3] !== undefined ? Number.parseInt(rangeMatch[3], 10) : 1;
      if (!inRange(lo, min, max) || !inRange(hi, min, max)) {
        return `'${part}' out of range (${min}-${max})`;
      }
      if (lo > hi) return `'${part}' range start exceeds its end`;
      if (step < 1) return `'${part}' step must be >= 1`;
      continue;
    }
    const stepMatch = /^(\*|\d+)\/(\d+)$/.exec(part);
    if (stepMatch) {
      const step = Number.parseInt(stepMatch[2], 10);
      if (step < 1) return `'${part}' step must be >= 1`;
      const base = stepMatch[1];
      if (base !== "*" && !inRange(Number.parseInt(base, 10), min, max)) {
        return `'${part}' out of range (${min}-${max})`;
      }
      continue;
    }
    if (part === "*") continue;
    if (/^\d+$/.test(part)) {
      const value = Number.parseInt(part, 10);
      if (!inRange(value, min, max)) {
        return `'${part}' out of range (${min}-${max})`;
      }
      continue;
    }
    return `invalid cron token '${part}'`;
  }
  return null;
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}
