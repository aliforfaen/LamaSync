// LAMA-345 follow-up — Dashboard fleet-health presentation.
//
// Pure helpers so the summary's wording, ordering, links and "technical
// details" are unit-testable without a DOM. The derivation itself lives in
// `@lamasync/core/fleet-health`; this file only decides how to show it.

import {
  FLEET_HEALTH_BUCKET_COPY,
  type FleetHealthBucket,
  type FleetHealthBucketKey,
  type FleetHealthItem,
  type FleetHealthSummary,
} from "@lamasync/core/fleet-health";

export type SummaryTone = "danger" | "warning" | "ok" | "info";

/** Tone per bucket. Red is reserved for the bucket the derivation marks red. */
export function bucketTone(key: FleetHealthBucketKey): SummaryTone {
  switch (key) {
    case "needsIntervention":
      return "danger";
    case "checkWhenOnline":
      return "warning";
    case "healthy":
      return "ok";
    case "unknownOrStale":
      return "info";
  }
}

export function bucketTitle(key: FleetHealthBucketKey): string {
  return FLEET_HEALTH_BUCKET_COPY[key].title;
}

export function bucketPlain(key: FleetHealthBucketKey): string {
  return FLEET_HEALTH_BUCKET_COPY[key].plain;
}

/** Display order: the thing to act on first, then the rest. */
export const SUMMARY_BUCKET_ORDER: readonly FleetHealthBucketKey[] = [
  "needsIntervention",
  "checkWhenOnline",
  "unknownOrStale",
];

/**
 * Buckets worth rendering as a list. `healthy` is rendered as a single calm
 * line instead — listing healthy folders would be the noisy duplicate count
 * the dashboard already shows elsewhere.
 */
export function visibleBuckets(summary: FleetHealthSummary): FleetHealthBucketKey[] {
  return SUMMARY_BUCKET_ORDER.filter((key) => summary.buckets[key].total > 0);
}

export function bucketIsEmpty(bucket: FleetHealthBucket): boolean {
  return bucket.total === 0;
}

/** The calm green sentence, or null when there is nothing healthy yet. */
export function healthySentence(summary: FleetHealthSummary): string | null {
  const { folders, hosts } = summary.healthy;
  if (folders === 0 && hosts === 0) return null;
  const parts: string[] = [];
  if (folders > 0) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
  if (hosts > 0) parts.push(`${hosts} device${hosts === 1 ? "" : "s"}`);
  return `${parts.join(" and ")} healthy`;
}

/**
 * Update wording for one device, in plain language. Never "update available"
 * when the evidence does not support it — that case reads as "not evaluated"
 * with the reason.
 */
export function updateBadgeCopy(
  status: { kind: string; label: string } | null | undefined,
): { text: string; tone: SummaryTone; title: string } | null {
  if (!status) return null;
  switch (status.kind) {
    case "available":
      return { text: "Update available", tone: "warning", title: status.label };
    case "not_evaluated":
      return { text: "Update not checked", tone: "info", title: status.label };
    case "unknown":
      return { text: "Update unknown", tone: "info", title: status.label };
    default:
      return null;
  }
}

/** Item kind → a small label so a list of mixed items stays readable. */
export function itemKindLabel(item: FleetHealthItem): string {
  switch (item.kind) {
    case "folder":
      return "Folder";
    case "host":
      return "Device";
    case "update":
      return "Update";
  }
}

/** Extra context behind the technical-details disclosure. */
export function itemTechnicalDetail(item: FleetHealthItem): string[] {
  const lines: string[] = [];
  if (item.kind === "folder") {
    lines.push(
      "Managed-folder health comes from this device's own report (sync record, ignore set, local folder, watching).",
    );
    if (item.action) lines.push(`Suggested action in the health card: ${item.action}.`);
  } else if (item.kind === "host") {
    lines.push(
      "Device state comes from its heartbeat. Always-on machines (server, NAS) are the only class whose absence is urgent.",
    );
  } else {
    lines.push(
      "An update is only reported when this device checked in at or after the release was published and still reports an older version.",
    );
  }
  lines.push(`Link: ${item.href}`);
  return lines;
}

/** "X more" caption for a truncated bucket, or null. */
export function truncatedCaption(bucket: FleetHealthBucket): string | null {
  if (bucket.truncated <= 0) return null;
  return `and ${bucket.truncated} more`;
}

/** Screen-reader sentence for the summary region. */
export function summaryAriaLabel(summary: FleetHealthSummary): string {
  const red = summary.buckets.needsIntervention.total;
  const yellow = summary.buckets.checkWhenOnline.total;
  const unknown = summary.buckets.unknownOrStale.total;
  return `Fleet health: ${red} needing attention now, ${yellow} to check when next online, ${unknown} not heard from, ${summary.healthy.folders} folders and ${summary.healthy.hosts} devices healthy.`;
}

/** How long ago the summary was derived, in words. */
export function generatedAgo(generatedAt: number, now: number = Date.now()): string {
  const age = Math.max(0, now - generatedAt);
  const minutes = Math.round(age / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} h ago`;
}
