// Compact "time ago" label for activity rows, triage cards, and the
// operations feed (LAMA-258). Pure + testable: pass `now` to get a
// deterministic result. Mirrors the prior Dashboard/Hosts helper but lives
// in one place so the activity sentence and every consumer stay consistent.
//
// Renders a relative label for the last week, then falls back to a date so
// old entries never read as "1234d ago".

export function formatTimeAgo(
  ts: number | null | undefined,
  now: Date = new Date(),
): string {
  if (!ts) return "—";
  const diffMs = now.getTime() - ts;
  if (diffMs < 0) return "just now";
  if (diffMs < 60_000) return "just now";
  const min = Math.floor(diffMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}
