import { describe, expect, test } from "bun:test";
import { fuzzyScore } from "./fuzzy.ts";

describe("fuzzyScore", () => {
  test("empty query matches everything with score 0", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("   ", "anything")).toBe(0);
  });

  test("returns null when the query cannot be matched", () => {
    expect(fuzzyScore("xyzzy", "Dashboard")).toBeNull();
    expect(fuzzyScore("storage", "Devices")).toBeNull();
    expect(fuzzyScore("a very long query", "short")).toBeNull();
  });

  test("substring hits beat subsequence hits", () => {
    const sub = fuzzyScore("storage", "Storage");
    const subseq = fuzzyScore("storag", "Go to Storage");
    expect(sub).not.toBeNull();
    expect(subseq).not.toBeNull();
    expect(sub ?? 0).toBeGreaterThan(subseq ?? 0);
  });

  test("earlier matches rank higher than later ones", () => {
    const first = fuzzyScore("storage", "Storage");
    const later = fuzzyScore("storage", "Go to Storage");
    expect(first).not.toBeNull();
    expect(later).not.toBeNull();
    expect(first ?? 0).toBeGreaterThan(later ?? 0);
  });

  test("word-boundary starts score higher than mid-word starts", () => {
    const boundary = fuzzyScore("data", "Data browser");
    const midWord = fuzzyScore("data", "Metadata");
    expect(boundary).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect(boundary ?? 0).toBeGreaterThan(midWord ?? 0);
  });

  test("subsequence matching tolerates typos (syncd flder → Add synced folder)", () => {
    const score = fuzzyScore("syncd flder", "Add synced folder");
    expect(score).not.toBeNull();
    expect(score ?? 0).toBeGreaterThan(0);
  });

  test("jumbled multi-word queries still match in order", () => {
    const score = fuzzyScore("strg dst", "Add a storage destination");
    expect(score).not.toBeNull();
    expect(score ?? 0).toBeGreaterThan(0);
  });
});