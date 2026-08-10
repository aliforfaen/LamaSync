// Cron sanity checker for the Folders assign form. Mirrors the TUI's
// `packages/tui/src/app/cron.ts` (web-ui cannot import from the tui package).
// Plain string → error-string function: five whitespace-separated fields,
// numeric ranges per field, `*` / steps / ranges / lists, plus the standard
// @-keywords offered by the schedule presets.

const AT_KEYWORDS: ReadonlySet<string> = new Set([
  "@reboot",
  "@login",
  "@hourly",
  "@daily",
  "@midnight",
  "@weekly",
  "@monthly",
  "@yearly",
  "@annually",
  "@noon",
]);

const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export function validateCronExpression(expr: string): string | null {
  const trimmed = expr.trim();
  if (trimmed === "") return "cron expression is required";
  if (AT_KEYWORDS.has(trimmed.toLowerCase())) return null;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return "cron must be 5 fields, e.g. 0 * * * * = hourly";
  }
  for (let i = 0; i < fields.length; i++) {
    const err = validateCronField(fields[i]!, FIELD_RANGES[i]![0], FIELD_RANGES[i]![1]);
    if (err) return err;
  }
  return null;
}

function validateCronField(field: string, min: number, max: number): string | null {
  const parts = field.split(",");
  for (const part of parts) {
    const rangeMatch = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part);
    if (rangeMatch) {
      const lo = Number.parseInt(rangeMatch[1]!, 10);
      const hi = Number.parseInt(rangeMatch[2]!, 10);
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
      const step = Number.parseInt(stepMatch[2]!, 10);
      if (step < 1) return `'${part}' step must be >= 1`;
      const base = stepMatch[1]!;
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
