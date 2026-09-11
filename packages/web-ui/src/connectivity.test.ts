// LAMA-329 phase 7: the connectivity states, and specifically what they refuse
// to claim. The risk this guards is a banner that says "offline" when only the
// event stream dropped, or that implies data is current when a write failed.

import { describe, expect, it } from "bun:test";
import { connectivityFrom, shouldShowConnectivityBanner } from "./connectivity.ts";

const base = { browserOnline: true, socket: "open" as const, requestFailed: false };

describe("connectivityFrom", () => {
  it("is silent when the socket is open", () => {
    const state = connectivityFrom(base);
    expect(state.level).toBe("online");
    expect(state.dataMayBeStale).toBe(false);
    expect(shouldShowConnectivityBanner(state)).toBe(false);
  });

  it("calls a device with no network offline and warns about the data", () => {
    const state = connectivityFrom({ ...base, browserOnline: false, socket: "closed" });
    expect(state.level).toBe("offline");
    expect(state.dataMayBeStale).toBe(true);
    expect(state.detail.toLowerCase()).toContain("cannot be read or changed");
  });

  it("distinguishes 'server unreachable' from 'device offline'", () => {
    const state = connectivityFrom({
      browserOnline: true,
      socket: "closed",
      requestFailed: true,
    });
    expect(state.level).toBe("offline");
    expect(state.label).toBe("Server unreachable");
    expect(state.dataMayBeStale).toBe(true);
    // It must not promise that changes were saved.
    expect(state.detail.toLowerCase()).toContain("will not be saved");
  });

  it("does not claim offline when only the event stream dropped", () => {
    // A tailnet phone can have a working HTTP path and a dead WebSocket; saying
    // "offline" there would be false and would train the user to ignore it.
    for (const socket of ["connecting", "closed"] as const) {
      const state = connectivityFrom({ ...base, socket });
      expect(state.level).toBe("reconnecting");
      expect(state.label).toBe("Live updates paused");
      expect(state.dataMayBeStale).toBe(false);
      expect(shouldShowConnectivityBanner(state)).toBe(true);
    }
  });

  it("never sets dataMayBeStale without knowing something actually failed", () => {
    const stale = [
      connectivityFrom({ ...base, socket: "closed" }),
      connectivityFrom({ browserOnline: false, socket: "closed", requestFailed: false }),
      connectivityFrom({ browserOnline: false, socket: "closed", requestFailed: true }),
    ];
    expect(stale.filter((state) => state.dataMayBeStale).length).toBe(2);
  });
});
