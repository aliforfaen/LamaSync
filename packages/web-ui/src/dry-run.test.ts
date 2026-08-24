import { describe, expect, it } from "bun:test";
import type { OperationLog } from "@lamasync/core";
import {
  capList,
  findDryRunOperation,
  isDryRunOperation,
  parseDryRunDetails,
} from "./dry-run.ts";

const DETAILS = JSON.stringify({
  wouldCopy: ["docs/a.md", "docs/b.md"],
  wouldDelete: ["old/tmp.bin"],
  wouldMkdir: ["photos/2026"],
  rclone: { transfers: 3 },
});

describe("parseDryRunDetails", () => {
  it("extracts the three file lists from valid JSON", () => {
    expect(parseDryRunDetails(DETAILS)).toEqual({
      wouldCopy: ["docs/a.md", "docs/b.md"],
      wouldDelete: ["old/tmp.bin"],
      wouldMkdir: ["photos/2026"],
    });
  });

  it("returns empty lists for null / undefined / malformed JSON", () => {
    expect(parseDryRunDetails(null)).toEqual({ wouldCopy: [], wouldDelete: [], wouldMkdir: [] });
    expect(parseDryRunDetails(undefined)).toEqual({ wouldCopy: [], wouldDelete: [], wouldMkdir: [] });
    expect(parseDryRunDetails("not json")).toEqual({ wouldCopy: [], wouldDelete: [], wouldMkdir: [] });
    expect(parseDryRunDetails("42")).toEqual({ wouldCopy: [], wouldDelete: [], wouldMkdir: [] });
  });

  it("drops non-string entries from the arrays", () => {
    const mixed = JSON.stringify({ wouldCopy: ["a", 1, null, "b"] });
    expect(parseDryRunDetails(mixed).wouldCopy).toEqual(["a", "b"]);
  });
});

describe("isDryRunOperation / findDryRunOperation", () => {
  const dry: OperationLog = {
    id: 1, timestamp: 1000, hostId: "h", folderId: "f1",
    operation: "sync", status: "success", summary: "dry-run: 2 would-copy",
  };
  const real: OperationLog = {
    id: 2, timestamp: 900, hostId: "h", folderId: "f1",
    operation: "sync", status: "success", summary: "sync ok: 3 transfers",
  };

  it("tags dry-run rows via the summary prefix", () => {
    expect(isDryRunOperation(dry)).toBe(true);
    expect(isDryRunOperation(real)).toBe(false);
  });

  it("picks the newest dry-run op for the folder (newest-first input)", () => {
    const older: OperationLog = {
      id: 3, timestamp: 500, hostId: "h", folderId: "f1",
      operation: "sync", status: "success", summary: "dry-run: 0 changes",
    };
    expect(findDryRunOperation([dry, real, older], "f1")?.id).toBe(1);
    expect(findDryRunOperation([real], "f1")).toBeNull();
  });
});

describe("capList", () => {
  it("caps at N and reports the true total", () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ kind: "copy", path: `f${i}` }));
    const { items, total } = capList(all, 200);
    expect(items).toHaveLength(200);
    expect(total).toBe(250);
    expect(items[0]).toEqual({ kind: "copy", path: "f0" });
  });
});
