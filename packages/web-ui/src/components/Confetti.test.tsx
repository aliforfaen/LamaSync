import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Confetti,
  milestoneAlreadyFired,
  milestoneKey,
  prefersReducedMotion,
  tryFireMilestone,
} from "./Confetti.tsx";
import { Llama } from "./Llama.tsx";

/** Minimal Storage stand-in backed by a Map (bun has no localStorage). */
function mockStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

const originalWindow = globalThis.window;
const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = mockStorage();
});

afterEach(() => {
  if (originalLocalStorage === undefined) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  } else {
    (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
  }
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

describe("tryFireMilestone — localStorage gating", () => {
  it("fires on the first call and marks the flag", () => {
    expect(tryFireMilestone("first-backup-seen")).toBe(true);
    expect(milestoneAlreadyFired("first-backup-seen")).toBe(true);
    expect(localStorage.getItem(milestoneKey("first-backup-seen"))).toBe("1");
  });

  it("does NOT fire on the second call (once per milestone, reload-safe)", () => {
    expect(tryFireMilestone("first-backup-seen")).toBe(true);
    expect(tryFireMilestone("first-backup-seen")).toBe(false);
  });

  it("keeps different milestones independent", () => {
    expect(tryFireMilestone("first-backup-seen")).toBe(true);
    expect(tryFireMilestone("first-preset-backup")).toBe(true);
    expect(milestoneAlreadyFired("first-backup-seen")).toBe(true);
    expect(milestoneAlreadyFired("first-preset-backup")).toBe(true);
  });

  it("never fires without localStorage (no way to remember → no repeat risk)", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(tryFireMilestone("first-backup-seen")).toBe(false);
    expect(milestoneAlreadyFired("first-backup-seen")).toBe(false);
  });

  it("never fires when the flag was already persisted (a reloaded session)", () => {
    localStorage.setItem(milestoneKey("first-backup-seen"), "1");
    expect(tryFireMilestone("first-backup-seen")).toBe(false);
  });
});

describe("prefersReducedMotion", () => {
  it("defaults to reduced when matchMedia is unavailable", () => {
    expect(prefersReducedMotion()).toBe(true);
  });

  it("honours the OS reduce setting", () => {
    (globalThis as { window?: unknown }).window = {
      matchMedia: (query: string) => ({ matches: query.includes("reduce") }),
    } as unknown as Window;
    expect(prefersReducedMotion()).toBe(true);
  });

  it("allows motion when the OS has none requested", () => {
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: false }),
    } as unknown as Window;
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("Confetti render paths (SSR static markup)", () => {
  it("renders the static fallback line instead of particles when reduced", () => {
    const html = renderToStaticMarkup(
      <Confetti reduced fallback={<span>✓ nice work</span>} />,
    );
    expect(html).toContain("confetti-static");
    expect(html).toContain("✓ nice work");
    expect(html).not.toContain("confetti-bit");
  });

  it("renders nothing when reduced and no fallback is given", () => {
    const html = renderToStaticMarkup(<Confetti reduced />);
    expect(html).toBe("");
  });

  it("renders transform-driven particles when motion is allowed", () => {
    const html = renderToStaticMarkup(<Confetti reduced={false} />);
    expect(html).toContain("confetti-bit");
    expect(html).toContain("--dx");
    expect(html).toContain("--delay");
  });
});

describe("Llama glyph", () => {
  it("honours the size prop and stays decorative", () => {
    const html = renderToStaticMarkup(<Llama size={40} />);
    expect(html).toContain('width="40"');
    expect(html).toContain('height="40"');
    expect(html).toContain("aria-hidden=\"true\"");
  });

  it("defaults to the 32px hop scale", () => {
    const html = renderToStaticMarkup(<Llama />);
    expect(html).toContain('width="32"');
  });
});