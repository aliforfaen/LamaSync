// LAMA-345 follow-up — fleet-health presentation rules.

import { describe, expect, test } from "bun:test";
import { deriveFleetHealth } from "@lamasync/core/fleet-health";
import type { FleetHealthSummary } from "@lamasync/core/fleet-health";
import {
  SUMMARY_BUCKET_ORDER,
  bucketPlain,
  bucketTitle,
  bucketTone,
  generatedAgo,
  healthySentence,
  itemKindLabel,
  itemTechnicalDetail,
  summaryAriaLabel,
  truncatedCaption,
  updateBadgeCopy,
  visibleBuckets,
} from "./fleet-health.ts";

const NOW = 1_800_000_000_000;

function summary(over: Partial<FleetHealthSummary> = {}): FleetHealthSummary {
  return {
    generatedAt: NOW - 60_000,
    headline: "Everything LamaSync manages looks healthy.",
    buckets: {
      needsIntervention: { total: 0, items: [], truncated: 0 },
      checkWhenOnline: { total: 0, items: [], truncated: 0 },
      healthy: { total: 0, items: [], truncated: 0 },
      unknownOrStale: { total: 0, items: [], truncated: 0 },
    },
    healthy: { folders: 3, hosts: 2 },
    updatesActionable: 0,
    updatesNotEvaluated: 0,
    ...over,
  };
}

describe("bucket presentation", () => {
  test("red is reserved for the bucket the derivation marks urgent", () => {
    expect(bucketTone("needsIntervention")).toBe("danger");
    expect(bucketTone("checkWhenOnline")).toBe("warning");
    expect(bucketTone("unknownOrStale")).toBe("info");
    expect(bucketTone("healthy")).toBe("ok");
  });

  test("healthy is never listed as a bucket row", () => {
    expect(SUMMARY_BUCKET_ORDER).not.toContain("healthy");
    const full = summary({
      buckets: {
        needsIntervention: { total: 1, items: [], truncated: 0 },
        checkWhenOnline: { total: 2, items: [], truncated: 0 },
        healthy: { total: 9, items: [], truncated: 0 },
        unknownOrStale: { total: 1, items: [], truncated: 0 },
      },
    });
    expect(visibleBuckets(full)).toEqual(["needsIntervention", "checkWhenOnline", "unknownOrStale"]);
  });

  test("empty buckets are dropped so the card never shows a hollow list", () => {
    const onlyRed = summary({
      buckets: {
        needsIntervention: { total: 1, items: [], truncated: 0 },
        checkWhenOnline: { total: 0, items: [], truncated: 0 },
        healthy: { total: 2, items: [], truncated: 0 },
        unknownOrStale: { total: 0, items: [], truncated: 0 },
      },
    });
    expect(visibleBuckets(onlyRed)).toEqual(["needsIntervention"]);
  });

  test("every bucket's copy is plain language", () => {
    for (const key of SUMMARY_BUCKET_ORDER) {
      expect(bucketTitle(key).length).toBeGreaterThan(0);
      expect(bucketPlain(key).length).toBeGreaterThan(20);
      expect(bucketPlain(key)).not.toContain("Path 1");
      expect(bucketPlain(key)).not.toContain("rclone");
    }
  });

  test("a truncated bucket says how many more there are", () => {
    expect(truncatedCaption({ total: 9, items: [], truncated: 3 })).toBe("and 3 more");
    expect(truncatedCaption({ total: 3, items: [], truncated: 0 })).toBeNull();
  });
});

describe("healthy sentence", () => {
  test("reads as one calm line and pluralises correctly", () => {
    expect(healthySentence(summary({ healthy: { folders: 1, hosts: 1 } }))).toBe(
      "1 folder and 1 device healthy",
    );
    expect(healthySentence(summary({ healthy: { folders: 4, hosts: 0 } }))).toBe("4 folders healthy");
    expect(healthySentence(summary({ healthy: { folders: 0, hosts: 2 } }))).toBe("2 devices healthy");
    expect(healthySentence(summary({ healthy: { folders: 0, hosts: 0 } }))).toBeNull();
  });
});

describe("update badge copy", () => {
  test("only an actionable update says 'available'", () => {
    expect(updateBadgeCopy({ kind: "available", label: "Update to 0.3.11 available (running 0.3.7)." })).toEqual({
      text: "Update available",
      tone: "warning",
      title: "Update to 0.3.11 available (running 0.3.7).",
    });
  });

  test("a not-evaluated device reads as neutral, with the reason in the tooltip", () => {
    const badge = updateBadgeCopy({
      kind: "not_evaluated",
      label: "Update not evaluated — this device has not been heard from since before 0.3.11 was released.",
    });
    expect(badge?.tone).toBe("info");
    expect(badge?.text).toBe("Update not checked");
    expect(badge?.title).toContain("not been heard from since before");
  });

  test("current and absent verdicts render nothing at all", () => {
    expect(updateBadgeCopy({ kind: "current", label: "Up to date." })).toBeNull();
    expect(updateBadgeCopy(undefined)).toBeNull();
    expect(updateBadgeCopy(null)).toBeNull();
  });
});

describe("item presentation", () => {
  test("mixed item kinds are labelled", () => {
    expect(itemKindLabel({ kind: "folder", id: "f", hostId: null, hostName: null, title: "t", detail: "d", tone: "danger", href: "/folders", action: null })).toBe("Folder");
    expect(itemKindLabel({ kind: "host", id: "h", hostId: "h", hostName: "h", title: "t", detail: "d", tone: "danger", href: "/hosts/h", action: null })).toBe("Device");
    expect(itemKindLabel({ kind: "update", id: "h", hostId: "h", hostName: "h", title: "t", detail: "d", tone: "warning", href: "/hosts/h", action: null })).toBe("Update");
  });

  test("technical details explain the source and the link, without jargon everywhere else", () => {
    const lines = itemTechnicalDetail({
      kind: "update",
      id: "dev-vm",
      hostId: "dev-vm",
      hostName: "dev-vm",
      title: "dev-vm",
      detail: "Update to 0.3.11 available (running 0.3.7).",
      tone: "warning",
      href: "/hosts/dev-vm",
      action: null,
    });
    expect(lines.join(" ")).toContain("checked in at or after the release was published");
    expect(lines.join(" ")).toContain("/hosts/dev-vm");
  });
});

describe("accessibility + freshness", () => {
  test("the region announces every count it shows", () => {
    const line = summaryAriaLabel(
      summary({
        buckets: {
          needsIntervention: { total: 2, items: [], truncated: 0 },
          checkWhenOnline: { total: 1, items: [], truncated: 0 },
          healthy: { total: 3, items: [], truncated: 0 },
          unknownOrStale: { total: 4, items: [], truncated: 0 },
        },
        healthy: { folders: 3, hosts: 5 },
      }),
    );
    expect(line).toContain("2 needing attention now");
    expect(line).toContain("1 to check when next online");
    expect(line).toContain("4 not heard from");
    expect(line).toContain("3 folders and 5 devices healthy");
  });

  test("the derived-at caption ages in words", () => {
    expect(generatedAgo(NOW - 5_000, NOW)).toBe("just now");
    expect(generatedAgo(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(generatedAgo(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    // A clock that went backwards must not print a negative age.
    expect(generatedAgo(NOW + 10_000, NOW)).toBe("just now");
  });
});

describe("agreement with the shared derivation", () => {
  test("the UI's bucket keys match what the server derivation produces", () => {
    const derived = deriveFleetHealth({ hosts: [], folders: [], now: NOW });
    for (const key of SUMMARY_BUCKET_ORDER) {
      expect(derived.buckets[key]).toBeDefined();
      expect(bucketTitle(key)).toBeTruthy();
    }
    expect(visibleBuckets(derived)).toEqual([]);
    expect(derived.headline).toBe("Nothing is set up yet.");
  });
});
