import { describe, expect, it } from "bun:test";
import {
  PROVE_NEEDS_RESTIC,
  isRestic,
  proveResultText,
  showVerifiedBadge,
} from "./backup-health.ts";

const NOW = new Date("2026-08-25T12:00:00Z").getTime();
const DAY = 24 * 3600 * 1000;

describe("isRestic", () => {
  it("is true only for restic destinations", () => {
    expect(isRestic("restic")).toBe(true);
    expect(isRestic("s3")).toBe(false);
    expect(isRestic("local")).toBe(false);
    expect(isRestic("nfs")).toBe(false);
  });
});

describe("showVerifiedBadge", () => {
  it("shows when a destination was proven ok within 30 days", () => {
    expect(showVerifiedBadge(NOW - 2 * 3600 * 1000, true, NOW)).toBe(true);
  });
  it("hides when the prove is older than 30 days", () => {
    expect(showVerifiedBadge(NOW - 31 * DAY, true, NOW)).toBe(false);
  });
  it("hides a recent prove that failed", () => {
    expect(showVerifiedBadge(NOW - 2 * 3600 * 1000, false, NOW)).toBe(false);
  });
  it("hides when there is no prove at all", () => {
    expect(showVerifiedBadge(null, true, NOW)).toBe(false);
    expect(showVerifiedBadge(undefined, null, NOW)).toBe(false);
    expect(showVerifiedBadge(null, null, NOW)).toBe(false);
  });
  it("respects a custom window", () => {
    expect(showVerifiedBadge(NOW - 5 * DAY, true, NOW, 10 * DAY)).toBe(true);
    expect(showVerifiedBadge(NOW - 20 * DAY, true, NOW, 10 * DAY)).toBe(false);
  });
});

describe("proveResultText", () => {
  it("renders a success line with file and duration", () => {
    expect(
      proveResultText({
        kind: "prove",
        ok: true,
        file: "notes.txt",
        durationMs: 500,
      }),
    ).toBe("✓ Restored notes.txt · 0.5s — backups are working");
  });
  it("falls back when no file is reported", () => {
    expect(proveResultText({ kind: "prove", ok: true, file: null })).toBe(
      "✓ Restored a backup — backups are working",
    );
  });
  it("omits timing when duration is unknown", () => {
    expect(
      proveResultText({ kind: "drill", ok: true, file: "a.txt", durationMs: null }),
    ).toBe("✓ Restored a.txt — backups are working");
  });
  it("renders a drill failure with the scrubbed detail", () => {
    expect(
      proveResultText({
        kind: "drill",
        ok: false,
        detail: "restic repository unreachable",
      }),
    ).toBe("✗ Fire drill failed: restic repository unreachable");
  });
  it("renders a prove failure with a fallback detail", () => {
    expect(proveResultText({ kind: "prove", ok: false, detail: null })).toBe(
      "✗ Prove failed: failed",
    );
  });
  it("exports the non-restic caption", () => {
    expect(PROVE_NEEDS_RESTIC).toBe("needs a restic snapshot");
  });
});
