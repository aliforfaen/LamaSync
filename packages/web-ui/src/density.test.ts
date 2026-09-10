// LAMA-329 phase 5: the browser density preference.
//
// The invariant that matters is the default and the storage key: two settings
// sharing a store would fight, and a default that is not "comfortable" would
// silently change the appearance of every existing browser profile.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyDensity, loadDensityChoice, saveDensityChoice } from "./density.ts";

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
let hadDocument = false;

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
  hadDocument = "document" in globalThis;
  originalDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    documentElement: { dataset: {} },
  } satisfies FakeDocument;
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  if (hadDocument) {
    (globalThis as { document?: unknown }).document = originalDocument;
  } else {
    delete (globalThis as { document?: unknown }).document;
  }
});

function dataset(): Record<string, string> {
  return (globalThis as unknown as { document: FakeDocument }).document.documentElement.dataset;
}

describe("density preference", () => {
  it("defaults to comfortable, the register the stylesheet encodes", () => {
    expect(loadDensityChoice()).toBe("comfortable");
  });

  it("round-trips an explicit choice through its own key", () => {
    saveDensityChoice("compact");
    expect(globalThis.localStorage.getItem("lamasync-density")).toBe("compact");
    expect(loadDensityChoice()).toBe("compact");
  });

  it("ignores an unrecognised stored value instead of trusting it", () => {
    globalThis.localStorage.setItem("lamasync-density", "tiny");
    expect(loadDensityChoice()).toBe("comfortable");
  });

  it("mirrors the choice onto <html data-density>", () => {
    applyDensity("compact");
    expect(dataset().density).toBe("compact");
    applyDensity("comfortable");
    expect(dataset().density).toBe("comfortable");
  });
});
