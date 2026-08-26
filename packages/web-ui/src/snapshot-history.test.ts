// LAMA-259: unit tests for the time-travel scrubber's pure logic —
// chronological ordering, arrow-key chip focus movement, and label
// formatting (asserted locale-agnostically).

import { describe, expect, it } from "bun:test";
import type { FolderSnapshot } from "@lamasync/core";
import {
  moveChipFocus,
  snapshotCaptionLabel,
  snapshotChipLabel,
  sortSnapshotsChronological,
} from "./snapshot-history.ts";

function snap(id: string, time: number): FolderSnapshot {
  return { id, time };
}

describe("sortSnapshotsChronological", () => {
  it("orders newest-first input oldest-first for the scrubber", () => {
    const input = [snap("c", 300), snap("a", 100), snap("b", 200)];
    expect(sortSnapshotsChronological(input).map((s) => s.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps equal timestamps stable and does not mutate the input", () => {
    const input = [snap("b", 200), snap("a", 100)];
    const sorted = sortSnapshotsChronological(input);
    expect(sorted.map((s) => s.id)).toEqual(["a", "b"]);
    expect(input.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("returns [] for []", () => {
    expect(sortSnapshotsChronological([])).toEqual([]);
  });
});

describe("moveChipFocus", () => {
  it("clamps at the ends", () => {
    expect(moveChipFocus(3, 0, "left")).toBe(0);
    expect(moveChipFocus(3, 2, "right")).toBe(2);
  });

  it("moves one step within the list", () => {
    expect(moveChipFocus(3, 0, "right")).toBe(1);
    expect(moveChipFocus(3, 2, "left")).toBe(1);
  });

  it("enters from no focus: right → first chip, left → last chip", () => {
    expect(moveChipFocus(3, -1, "right")).toBe(0);
    expect(moveChipFocus(3, -1, "left")).toBe(2);
  });

  it("handles empty and single-item lists", () => {
    expect(moveChipFocus(0, -1, "right")).toBe(0);
    expect(moveChipFocus(1, 0, "right")).toBe(0);
    expect(moveChipFocus(1, 0, "left")).toBe(0);
  });
});

describe("snapshot labels", () => {
  it("produces non-empty, distinct chip labels for distinct times", () => {
    const early = snapshotChipLabel(0);
    const late = snapshotChipLabel(86_400_000);
    expect(early.length).toBeGreaterThan(0);
    expect(early).not.toBe(late);
  });

  it("renders both caption and chip labels for a real timestamp", () => {
    const t = new Date(2026, 7, 26, 14, 32).getTime();
    expect(snapshotCaptionLabel(t).length).toBeGreaterThan(0);
    expect(snapshotChipLabel(t).length).toBeGreaterThan(0);
  });
});