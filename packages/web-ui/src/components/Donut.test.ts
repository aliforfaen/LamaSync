import { describe, expect, it } from "bun:test";
import { donutSlices } from "./Donut.tsx";

const SIZE = 64;
const THICK = 10;
const RADIUS = (SIZE - THICK) / 2;
const CIRC = 2 * Math.PI * RADIUS;

describe("donutSlices", () => {
  it("returns [] when nothing is positive (unmeasured)", () => {
    expect(donutSlices([{ label: "a", value: 0 }], SIZE, THICK)).toEqual([]);
    expect(donutSlices([], SIZE, THICK)).toEqual([]);
  });

  it("produces a single full arc for one positive slice", () => {
    const slices = donutSlices([{ label: "a", value: 10 }], SIZE, THICK);
    expect(slices).toHaveLength(1);
    expect(slices[0]!.fraction).toBe(1);
    expect(slices[0]!.offset).toBe(0);
    // dash length + gap == circumference (one full ring).
    expect(slices[0]!.dash).toBe(`${CIRC.toFixed(2)} 0.00`);
  });

  it("splits two equal slices into halves with sequential offsets", () => {
    const slices = donutSlices(
      [
        { label: "a", value: 10 },
        { label: "b", value: 10 },
      ],
      SIZE,
      THICK,
    );
    expect(slices.map((s) => s.fraction)).toEqual([0.5, 0.5]);
    expect(slices[0]!.offset).toBe(0);
    expect(slices[1]!.offset).toBeCloseTo(-CIRC / 2, 1);
    for (const s of slices) {
      const [len, gap] = s.dash.split(" ").map(Number);
      expect(len + gap).toBeCloseTo(CIRC, 1);
    }
  });

  it("weights slices by value and skips zero/negative", () => {
    const slices = donutSlices(
      [
        { label: "a", value: 30 },
        { label: "b", value: 10 },
        { label: "c", value: 0 },
        { label: "d", value: -5 },
      ],
      SIZE,
      THICK,
    );
    expect(slices.map((s) => s.label)).toEqual(["a", "b"]);
    expect(slices[0]!.fraction).toBeCloseTo(0.75, 5);
    expect(slices[1]!.fraction).toBeCloseTo(0.25, 5);
  });

  it("cycles the colour palette", () => {
    const slices = donutSlices(
      [
        { label: "a", value: 1 },
        { label: "b", value: 1 },
      ],
      SIZE,
      THICK,
    );
    expect(slices[0]!.color).not.toBe(slices[1]!.color);
  });
});
