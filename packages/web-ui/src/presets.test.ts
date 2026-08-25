import { describe, expect, it } from "bun:test";
import {
  APP_PRESETS,
  detectOs,
  pathsForOs,
  type AppPreset,
} from "./presets.ts";

describe("LAMA-263 presets catalog", () => {
  it("ships the curated set with required fields", () => {
    expect(APP_PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const preset of APP_PRESETS) {
      expect(preset.id).toBeTruthy();
      expect(preset.name).toBeTruthy();
      expect(preset.docsUrl.startsWith("http")).toBe(true);
      expect(preset.paths.linux && preset.paths.linux.length).toBeGreaterThan(0);
    }
  });

  it("keeps ids unique", () => {
    const ids = APP_PRESETS.map((p: AppPreset) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("falls back to linux paths when an OS is missing", () => {
    const vscode = APP_PRESETS.find((p) => p.id === "vscode")!;
    expect(pathsForOs(vscode, "windows").some((p) => p.includes("Code"))).toBe(
      true,
    );
    // A preset without explicit windows paths falls back to linux.
    const git = APP_PRESETS.find((p) => p.id === "git")!;
    expect(pathsForOs(git, "windows")).toEqual(git.paths.linux ?? []);
  });

  it("detects a known OS", () => {
    // Node has no navigator; detectOs defaults to linux without throwing.
    expect(["linux", "macos", "windows"]).toContain(detectOs());
  });
});
