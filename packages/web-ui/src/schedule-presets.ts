// Schedule presets shared by every web-ui surface that picks a schedule
// (assignment editor, folder setup form, app settings manifest form).
// Labels are the single source of truth for the web — the TUI keeps an
// identical copy in `packages/tui/src/app/schedule-presets.ts`, so the two
// must stay in lock-step (LAMA-267).

export interface SchedulePreset {
  readonly label: string;
  readonly value: string;
  readonly cron: string;
}

export const SCHEDULE_PRESETS: ReadonlyArray<SchedulePreset> = [
  { label: "Custom", value: "custom", cron: "" },
  { label: "Every hour", value: "hourly", cron: "0 * * * *" },
  { label: "Every 6 hours", value: "6h", cron: "0 */6 * * *" },
  { label: "Daily", value: "daily", cron: "0 0 * * *" },
  { label: "Weekly", value: "weekly", cron: "0 0 * * 0" },
  { label: "Monthly", value: "monthly", cron: "0 0 1 * *" },
  { label: "On boot", value: "@reboot", cron: "@reboot" },
  { label: "On login", value: "@login", cron: "@login" },
];

/**
 * Return the preset `value` matching the supplied cron expression, or
 * `"custom"` when no preset matches (or when `cron` is nullish/empty).
 */
export function schedulePresetForCron(cron: string | null | undefined): string {
  if (!cron) return "custom";
  const preset = SCHEDULE_PRESETS.find((p) => p.cron === cron);
  return preset ? preset.value : "custom";
}