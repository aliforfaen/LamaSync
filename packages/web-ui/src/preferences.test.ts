// LAMA-329 phase 5: the preference-ownership table is a contract, so it gets
// the invariants of one. The failure this guards against is a preference being
// written to two layers, which shows up as a setting that "does not stick" on
// one device.

import { describe, expect, it } from "bun:test";
import { PREFERENCES, browserEditablePreferences, preferencesByScope } from "./preferences.ts";

describe("preference ownership", () => {
  it("has a unique id per preference", () => {
    const ids = PREFERENCES.map((preference) => preference.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names exactly one store and one place to change it", () => {
    for (const preference of PREFERENCES) {
      expect(preference.owner.trim().length).toBeGreaterThan(0);
      expect(preference.editedIn.trim().length).toBeGreaterThan(0);
      // The notes are where the reason lives; a row without one is a row
      // nobody can act on.
      expect(preference.notes.trim().length).toBeGreaterThan(0);
    }
  });

  it("separates the web and native appearance settings on purpose", () => {
    // The single most likely confusion: two appearance settings that are not
    // the same setting.
    const web = PREFERENCES.find((preference) => preference.id === "web-theme");
    const native = PREFERENCES.find((preference) => preference.id === "native-appearance");
    expect(web?.scope).toBe("web");
    expect(native?.scope).toBe("native");
    expect(web?.owner).not.toBe(native?.owner);
  });

  it("keeps the two transfer policies distinct", () => {
    const upload = PREFERENCES.find((preference) => preference.id === "upload-policy");
    const camera = PREFERENCES.find((preference) => preference.id === "camera-policy");
    expect(upload?.owner).not.toBe(camera?.owner);
  });

  it("documents the shell cache as shell-only", () => {
    const cache = PREFERENCES.find((preference) => preference.id === "shell-cache");
    expect(cache?.scope).toBe("web");
    expect(cache?.notes.toLowerCase()).toContain("never cached");
  });

  it("partitions by scope without losing rows", () => {
    const total =
      preferencesByScope("web").length +
      preferencesByScope("native").length +
      preferencesByScope("server").length;
    expect(total).toBe(PREFERENCES.length);
    // The browser can only change its own layer.
    for (const preference of browserEditablePreferences()) {
      expect(preference.scope).toBe("web");
    }
  });
});
