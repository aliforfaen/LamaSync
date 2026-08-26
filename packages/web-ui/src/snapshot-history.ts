// LAMA-259: pure helpers for the Data Browser's time-travel scrubber.
// Framework-free so they're unit-testable without a DOM (snapshot-history
// selection state + label formatting live here; the component in
// DataBrowser.tsx just wires them to the API).

import type { FolderSnapshot } from "@lamasync/core";

/**
 * Oldest-first ordering for the horizontal time scrubber. The server
 * returns snapshots newest-first; the scrubber reads left→right =
 * old→new like a timeline. Non-mutating.
 */
export function sortSnapshotsChronological(
  snapshots: readonly FolderSnapshot[],
): FolderSnapshot[] {
  return [...snapshots].sort((a, b) => a.time - b.time);
}

/**
 * Next chip index for arrow-key navigation, clamped at the ends.
 * `current` is the focused chip index, or -1 when nothing is focused yet
 * (ArrowRight then enters at the first chip, ArrowLeft at the last).
 * A count of 0 yields 0 — callers don't render chips in that case.
 */
export function moveChipFocus(
  count: number,
  current: number,
  direction: "left" | "right",
): number {
  if (count <= 0) return 0;
  const base = current < 0 ? (direction === "right" ? -1 : count) : current;
  const next = base + (direction === "right" ? 1 : -1);
  return Math.min(count - 1, Math.max(0, next));
}

/** Compact label for a scrubber chip: "Aug 26, 2:32 PM". */
export function snapshotChipLabel(time: number): string {
  return new Date(time).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Full label for the "Viewing … snapshot" caption: "Aug 26, 2026, 2:32 PM". */
export function snapshotCaptionLabel(time: number): string {
  return new Date(time).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}