// LAMA-329 phase 5: the reduced-motion override.
//
// The plan requires the default to be the system preference and the override to
// be explicit. Two consumers have to agree on the resolved answer — the CSS
// gates read `<html data-motion>` and JS components call `prefersReducedMotion`
// — so the tests exercise both directions of the override through the same
// module.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  applyMotion,
  currentMotionChoice,
  loadMotionChoice,
  prefersReducedMotion,
  saveMotionChoice,
} from "./motion.ts";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => {
      const keys = [...map.keys()];
      return index >= 0 && index < keys.length ? (keys[index] as string) : null;
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  };
}

interface FakeDocument {
  documentElement: { dataset: Record<string, string> };
}

let originalDocument: unknown;
let originalWindow: unknown;
let hadDocument = false;
let hadWindow = false;
let systemPrefersReduce = false;

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
  hadDocument = "document" in globalThis;
  hadWindow = "window" in globalThis;
  originalDocument = (globalThis as { document?: unknown }).document;
  originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { document?: unknown }).document = {
    documentElement: { dataset: {} },
  } satisfies FakeDocument;
  (globalThis as { window?: unknown }).window = {
    matchMedia: (query: string) => ({
      matches: query.includes("reduce") ? systemPrefersReduce : false,
    }),
  };
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  if (hadDocument) {
    (globalThis as { document?: unknown }).document = originalDocument;
  } else {
    delete (globalThis as { document?: unknown }).document;
  }
  if (hadWindow) {
    (globalThis as { window?: unknown }).window = originalWindow;
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
});

function dataset(): Record<string, string> {
  return (globalThis as unknown as { document: FakeDocument }).document.documentElement.dataset;
}

describe("motion preference", () => {
  it("defaults to the system setting, and follows it both ways", () => {
    expect(loadMotionChoice()).toBe("system");
    systemPrefersReduce = true;
    expect(prefersReducedMotion()).toBe(true);
    systemPrefersReduce = false;
    expect(prefersReducedMotion()).toBe(false);
  });

  it("forces reduce even when the system allows motion", () => {
    systemPrefersReduce = false;
    applyMotion("reduce");
    expect(prefersReducedMotion()).toBe(true);
    // The attribute is what the CSS gates read, so it must be written too.
    expect(dataset().motion).toBe("reduce");
  });

  it("forces motion even when the system prefers reduced motion", () => {
    systemPrefersReduce = true;
    applyMotion("full");
    expect(prefersReducedMotion()).toBe(false);
    expect(dataset().motion).toBe("full");
  });

  it("keeps the choice in its own key and ignores malformed values", () => {
    saveMotionChoice("full");
    expect(globalThis.localStorage.getItem("lamasync-motion")).toBe("full");
    globalThis.localStorage.setItem("lamasync-motion", "sometimes");
    expect(loadMotionChoice()).toBe("system");
  });

  it("writes the attribute for `system` so the CSS negation stays meaningful", () => {
    applyMotion("system");
    expect(dataset().motion).toBe("system");
    expect(currentMotionChoice()).toBe("system");
  });

  it("reports `system` when nothing has been applied yet", () => {
    // The pre-hydration / no-JS case: the media query is the gate.
    expect(currentMotionChoice()).toBe("system");
    systemPrefersReduce = true;
    expect(prefersReducedMotion()).toBe(true);
  });
});
