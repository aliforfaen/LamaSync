import { describe, expect, test } from "bun:test";

import { matchHotkey, type Hotkey } from "./keymap.ts";

function hk(key: string, label = key): Hotkey {
  return { key, label, run: () => {} };
}

describe("matchHotkey", () => {
  test("returns undefined for empty hotkey list", () => {
    expect(matchHotkey([], "a", "a")).toBeUndefined();
  });

  test("matches by printable char (lowercase key, lowercase char)", () => {
    const h = hk("r", "refresh");
    expect(matchHotkey([h], "r", "r")).toBe(h);
  });

  test("matches case-insensitively on char", () => {
    const h = hk("r", "refresh");
    expect(matchHotkey([h], "R", "R")).toBe(h);
  });

  test("matches by name (escape)", () => {
    const h = hk("escape", "back");
    expect(matchHotkey([h], "escape", "")).toBe(h);
  });

  test("matches by name case-insensitively", () => {
    const h = hk("escape", "back");
    expect(matchHotkey([h], "Escape", "")).toBe(h);
  });

  test("char matches hit first entry with matching char", () => {
    const first = hk("r", "refresh");
    const second = hk("r", "rename");
    expect(matchHotkey([first, second], "r", "r")).toBe(first);
  });

  test("falls through to name when no char match", () => {
    const byName = hk("escape", "back");
    expect(matchHotkey([byName], "escape", "")).toBe(byName);
  });

  test("returns undefined when no entry matches", () => {
    const h = hk("r", "refresh");
    expect(matchHotkey([h], "x", "x")).toBeUndefined();
  });

  test("first matching entry wins", () => {
    const first = hk("r", "first");
    const second = hk("r", "second");
    expect(matchHotkey([first, second], "r", "r")).toBe(first);
  });

  test("non-printable key like leftbracket matches by name", () => {
    const h = hk("leftbracket", "prev");
    expect(matchHotkey([h], "leftbracket", "[")).toBe(h);
  });
});
