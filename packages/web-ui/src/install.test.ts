// LAMA-329 phase 7: when an install affordance may be offered.
//
// Chrome only fires `beforeinstallprompt` when the manifest, the icons and the
// service worker all satisfy it, so the prompt's presence is the real signal.
// The cases below are the ones that would otherwise produce a button that does
// nothing, which is worse than no button.

import { describe, expect, it } from "bun:test";
import { INSTALL_COPY, installStateFrom } from "./install.ts";

const base = {
  standalone: false,
  embeddedShell: false,
  promptAvailable: true,
  secureContext: true,
};

describe("installStateFrom", () => {
  it("reports an installed app rather than offering it again", () => {
    expect(installStateFrom({ ...base, standalone: true })).toBe("installed");
  });

  it("does not offer an install from inside the Android companion", () => {
    // The companion IS the installed app; a second copy in Chrome is not a
    // thing the user wants from inside it.
    expect(installStateFrom({ ...base, embeddedShell: true })).toBe("unavailable");
  });

  it("does not offer an install on an insecure origin", () => {
    // Plain HTTP on a tailnet address: the service worker cannot register, so
    // the prompt would never fire.
    expect(installStateFrom({ ...base, secureContext: false })).toBe("unavailable");
  });

  it("offers the install only when the browser has actually offered it", () => {
    expect(installStateFrom(base)).toBe("installable");
    expect(installStateFrom({ ...base, promptAvailable: false })).toBe("unavailable");
  });

  it("gives every state copy with a next step, not just a status", () => {
    for (const state of ["installed", "installable", "unavailable"] as const) {
      const copy = INSTALL_COPY[state];
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.detail.length).toBeGreaterThan(20);
    }
    // The unavailable case must tell the user what to do instead.
    expect(INSTALL_COPY.unavailable.detail).toContain("Add to Home screen");
  });
});
