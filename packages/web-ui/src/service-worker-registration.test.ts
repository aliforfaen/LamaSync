// LAMA-329 phase 7: the service worker gates.
//
// The first case is plan decision 9 and the reason this logic is a pure
// function: inside the Android companion the shell is reloaded constantly, so a
// cached app shell can outlive a server update with no way for the user to
// clear it. Everything the app needs to decide that is passed in.

import { describe, expect, it } from "bun:test";
import { shouldRegisterServiceWorker } from "./service-worker-registration.ts";

const enableable = {
  embeddedShell: false,
  production: true,
  secureContext: true,
  serviceWorkerSupported: true,
};

describe("shouldRegisterServiceWorker", () => {
  it("never registers inside the Android companion", () => {
    expect(shouldRegisterServiceWorker({ ...enableable, embeddedShell: true })).toBe(false);
  });

  it("does not register in dev, where /sw.js is not served", () => {
    expect(shouldRegisterServiceWorker({ ...enableable, production: false })).toBe(false);
  });

  it("does not register outside a secure context", () => {
    expect(shouldRegisterServiceWorker({ ...enableable, secureContext: false })).toBe(false);
  });

  it("does not register where the browser has no support", () => {
    expect(shouldRegisterServiceWorker({ ...enableable, serviceWorkerSupported: false })).toBe(
      false,
    );
  });

  it("registers only when every gate passes", () => {
    expect(shouldRegisterServiceWorker(enableable)).toBe(true);
  });
});
