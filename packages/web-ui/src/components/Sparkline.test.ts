import { describe, expect, it } from "bun:test";
import { sparklinePoints } from "./Sparkline.tsx";

describe("sparklinePoints", () => {
  it("returns [] for empty input", () => {
    expect(sparklinePoints([], 120, 32)).toEqual([]);
  });

  it("centres a single point", () => {
    expect(sparklinePoints([5], 120, 32)).toEqual([[0, 16]]);
  });

  it("centres a flat series (zero span)", () => {
    expect(sparklinePoints([3, 3, 3], 120, 32)).toEqual([
      [0, 16],
      [60, 16],
      [120, 16],
    ]);
  });

  it("maps higher values to smaller y (up on the chart)", () => {
    const pts = sparklinePoints([0, 10, 20], 100, 40);
    expect(pts[0]![1]).toBeGreaterThan(pts[2]![1]); // lowest value = bottom
    expect(pts[0]![0]).toBe(0);
    expect(pts[2]![0]).toBe(100);
  });

  it("respects an explicit min to anchor the baseline at zero", () => {
    const pts = sparklinePoints([5, 10], 100, 40, 0);
    // value 5 of [0..10] sits at 3/4 down (y = 40 - 0.5*40 = 20).
    expect(pts[0]).toEqual([0, 20]);
    expect(pts[1]).toEqual([100, 40 - (10 / 10) * 40]);
  });

  it("scales x evenly across the width", () => {
    const pts = sparklinePoints([1, 2, 3, 4], 90, 30);
    expect(pts.map((p) => p[0])).toEqual([0, 30, 60, 90]);
  });
});
