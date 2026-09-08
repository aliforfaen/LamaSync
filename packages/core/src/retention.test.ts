// LAMA-325: acceptance tests for the pure retention evaluator. Covers the
// contract in the issue comment: rule boundaries, mixed-calendar overlap,
// same-bucket tie-break, future/bad timestamps, zero snapshots, mandatory
// final snapshot, pins/holds/rollback override, unknown sizes, and the
// conservative disabled-policy migration.

import { describe, expect, test } from "bun:test";
import {
  describePolicy,
  evaluateRetention,
  smartRetentionPolicy,
  smartRetentionRules,
  type RetentionPolicy,
  type RetentionRule,
  type RetentionSnapshotDescriptor,
} from "./retention.ts";

// Fixed "now" so every test is deterministic: 2026-09-08T12:00:00Z.
const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
const DAY = 86_400_000;

function snap(
  id: string,
  daysAgo: number,
  opts: Partial<RetentionSnapshotDescriptor> = {},
): RetentionSnapshotDescriptor {
  return { id, timestamp: NOW - daysAgo * DAY, successful: true, ...opts };
}

function run(
  snapshots: RetentionSnapshotDescriptor[],
  rules: RetentionRule[],
  opts: { enabled?: boolean } = {},
) {
  const policy: RetentionPolicy = {
    enabled: opts.enabled ?? true,
    rules,
    keepAtLeastOne: true,
  };
  return evaluateRetention({ snapshots, policy, now: NOW });
}

function decisionsOf(res: ReturnType<typeof evaluateRetention>): Record<string, string> {
  return Object.fromEntries(res.decisions.map((d) => [d.id, d.action]));
}

describe("keepLast bounds", () => {
  test("keeps exactly the N newest successful snapshots", () => {
    const snaps = [snap("a", 9), snap("b", 5), snap("c", 3), snap("d", 1)];
    const res = run(snaps, [{ kind: "keepLast", count: 2 }]);
    expect(decisionsOf(res)).toEqual({ a: "delete", b: "delete", c: "keep", d: "keep" });
  });

  test("keeps the newest when fewer snapshots than N", () => {
    const res = run([snap("a", 9), snap("b", 5)], [{ kind: "keepLast", count: 5 }]);
    expect(decisionsOf(res)).toEqual({ a: "keep", b: "keep" });
  });

  test("failed captures do not satisfy keepLast (but the latest successful stays)", () => {
    const snaps = [snap("good-old", 10), { ...snap("failed-new", 1), successful: false }, snap("good-latest", 2)];
    const res = run(snaps, [{ kind: "keepLast", count: 1 }]);
    expect(decisionsOf(res)).toEqual({ "good-old": "delete", "failed-new": "delete", "good-latest": "keep" });
    expect(res.keptByGuarantee).toBe(0);
  });
});

describe("keepAge boundaries", () => {
  test("keeps snapshots younger than the window, deletes older ones", () => {
    const snaps = [snap("old", 40), snap("border", 30), snap("recent", 1)];
    const res = run(snaps, [{ kind: "keepAge", maxAgeMs: 30 * DAY }]);
    // border is exactly 30 days old → kept (>= cutoff).
    expect(decisionsOf(res)).toEqual({ old: "delete", border: "keep", recent: "keep" });
  });
});

describe("calendar buckets (UTC)", () => {
  test("daily: newest successful snapshot per day for the last N days", () => {
    const snaps = [
      snap("d-1-old", 8), // 2026-08-31 — outside 7-day window
      snap("d-1-new", 7.2), // 2026-09-01
      snap("d-2", 2.2), // 2026-09-06
      snap("d-2-late", 2.0), // 2026-09-06 later? smaller daysAgo = later
      snap("d-3", 0.5), // 2026-09-08
    ];
    const res = run(snaps, [{ kind: "calendar", unit: "daily", count: 7 }]);
    // 7 daily buckets from 2026-09-08: 09-08..09-02. d-1-new (09-01) is
    // outside the window like d-1-old.
    expect(decisionsOf(res)).toEqual({
      "d-1-old": "delete",
      "d-1-new": "delete",
      "d-2-late": "keep",
      "d-2": "delete",
      "d-3": "keep",
    });
    expect(
      res.decisions.find((d) => d.id === "d-2-late")?.reason,
    ).toContain("newest successful snapshot of daily bucket");
  });

  test("same-day same-millisecond tie-breaks deterministically by id", () => {
    const a = snap("aaaa", 1);
    const b = snap("bbbb", 1);
    const res = run([b, a], [{ kind: "calendar", unit: "daily", count: 1 }]);
    // Identical timestamps; ascending id order picks the later in the loop,
    // which replaces on >= so the LAST one processed (lexicographically
    // larger id) wins.
    expect(decisionsOf(res)).toEqual({ aaaa: "delete", bbbb: "keep" });
  });

  test("mixed daily + weekly + monthly overlap keeps union, deletes the rest", () => {
    const snaps = [
      snap("old-monthly", 200), // far outside windows
      snap("m-keep", 32), // 1 month-ish ago
      snap("w-keep", 8), // last week
      snap("d-keep", 1), // yesterday
      snap("d-dup", 0.5), // today — same day as d-keep? daysAgo<1
    ];
    const res = run(snaps, [
      { kind: "calendar", unit: "daily", count: 7 },
      { kind: "calendar", unit: "weekly", count: 4 },
      { kind: "calendar", unit: "monthly", count: 3 },
    ]);
    // Per-bucket representatives: daily 09-07 (d-keep) + 09-08 (d-dup),
    // weekly 2026-W35 (w-keep). The August monthly representative is the
    // NEWEST successful snapshot in August — w-keep (already kept) — so
    // the older m-keep in the same month is not a representative.
    expect(decisionsOf(res)).toEqual({
      "old-monthly": "delete",
      "m-keep": "delete",
      "w-keep": "keep",
      "d-keep": "keep",
      "d-dup": "keep",
    });
  });

  test("the smart preset expands to visible daily/weekly/monthly/yearly rules", () => {
    const rules = smartRetentionRules({ daily: 7, weekly: 4, monthly: 12, yearly: 2 });
    expect(rules).toEqual([
      { kind: "calendar", unit: "daily", count: 7 },
      { kind: "calendar", unit: "weekly", count: 4 },
      { kind: "calendar", unit: "monthly", count: 12 },
      { kind: "calendar", unit: "yearly", count: 2 },
    ]);
    const policy = smartRetentionPolicy();
    expect(policy.enabled).toBe(true);
    expect(describePolicy(policy)).toContain("daily");
  });
});

describe("safety overrides", () => {
  test("pinned/hold snapshots are always kept", () => {
    const snaps = [snap("pinned", 99, { pinned: true }), snap("normal", 1)];
    const res = run(snaps, [{ kind: "keepLast", count: 1 }]);
    expect(decisionsOf(res)).toEqual({ pinned: "keep", normal: "keep" });
    expect(res.guardCount).toBe(1);
    expect(res.decisions.find((d) => d.id === "pinned")?.reason).toBe("pinned / on hold");
  });

  test("rollback artifacts are never pruned", () => {
    const snaps = [snap("rb", 99, { rollback: true }), snap("normal", 1)];
    const res = run(snaps, [{ kind: "keepLast", count: 1 }]);
    expect(decisionsOf(res)).toEqual({ rb: "keep", normal: "keep" });
    expect(res.guardCount).toBe(1);
  });

  test("failure snapshots never satisfy the keep-at-least-one guarantee", () => {
    const snaps = [snap("only-failed", 1, { successful: false })];
    const res = run(snaps, [{ kind: "keepLast", count: 1 }]);
    // keep-at-least-one applies to SUCCESSFUL snapshots only; a lone failed
    // capture has no successful one to guarantee and keepLast only counts
    // successful snapshots → it is a delete candidate.
    expect(decisionsOf(res)).toEqual({ "only-failed": "delete" });
  });

  test("future timestamps are kept for safety", () => {
    const snaps = [
      { ...snap("future", -5), timestamp: NOW + 5 * DAY },
      snap("old", 99),
      snap("recent", 1),
    ];
    const res = run(snaps, [{ kind: "keepLast", count: 1 }]);
    expect(decisionsOf(res)).toEqual({ future: "keep", old: "delete", recent: "keep" });
    expect(res.decisions.find((d) => d.id === "future")?.reason).toContain("safety");
  });

  test("NaN timestamps are kept for safety", () => {
    const bad = { ...snap("bad", 1), timestamp: Number.NaN };
    const res = run([bad, snap("good", 2)], [{ kind: "keepLast", count: 1 }]);
    expect(decisionsOf(res)).toEqual({ bad: "keep", good: "keep" });
  });
});

describe("edge cases + accounting", () => {
  test("zero snapshots -> no decisions, no errors", () => {
    const res = run([], [{ kind: "keepLast", count: 5 }]);
    expect(res.decisions).toEqual([]);
    expect(res.keptCount).toBe(0);
    expect(res.deleteCount).toBe(0);
  });

  test("mandatory final snapshot: keeps the newest successful even when no rule matches", () => {
    // Two successful snapshots years old; keepLast=1 keeps newest; ensure
    // the guarantee keeps something even with keepLast=0-equivalent rules.
    const snaps = [snap("older", 700), snap("newer", 600)];
    const res = run(snaps, [{ kind: "calendar", unit: "monthly", count: 1 }]);
    // Neither is in the last month → guarantee keeps the newest one.
    expect(decisionsOf(res)).toEqual({ older: "delete", newer: "keep" });
    expect(res.keptByGuarantee).toBe(1);
    expect(res.decisions.find((d) => d.id === "newer")?.reason).toContain("always keep at least one");
  });

  test("unknown sizes are surfaced, not guessed (reclaim accounting only sums known)", () => {
    const snaps = [
      snap("known", 9, { sizeBytes: 1000 }),
      snap("unknown", 8), // no size
      snap("kept", 1, { sizeBytes: 50 }),
    ];
    const res = run(snaps, [{ kind: "keepLast", count: 1 }]);
    expect(res.deleteCount).toBe(2);
    expect(res.reclaimableBytes).toBe(1000);
    expect(res.unknownSizeCount).toBe(1);
  });

  test("disabled policy is fully conservative (deletes nothing)", () => {
    const snaps = [snap("one", 1000), snap("two", 1)];
    const res = run(snaps, [{ kind: "keepLast", count: 1 }], { enabled: false });
    expect(decisionsOf(res)).toEqual({ one: "keep", two: "keep" });
    expect(res.deleteCount).toBe(0);
    expect(res.decisions.every((d) => d.reason === "retention disabled")).toBe(true);
  });

  test("empty rule list with enabled policy keeps everything (no deletes)", () => {
    const res = run([snap("a", 10)], []);
    expect(res.deleteCount).toBe(0);
  });

  test("describePolicy explains the trade-off in plain language", () => {
    expect(describePolicy({ enabled: true, rules: [{ kind: "keepLast", count: 5 }] })).toContain(
      "Keep the latest 5 snapshots",
    );
    expect(describePolicy({ enabled: false, rules: [] })).toContain("kept forever");
    expect(
      describePolicy({ enabled: true, rules: [{ kind: "keepAge", maxAgeMs: 30 * DAY }] }),
    ).toContain("30 days");
  });
});