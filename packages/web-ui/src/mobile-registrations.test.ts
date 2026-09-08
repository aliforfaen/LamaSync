// LAMA-296 finding 6: Admin "Android devices" panel logic (DOM-free).
//
// Regression intent this file pins at the UI-logic level (browser
// walkthrough belongs to the integration wave): a phone was paired through
// the enrollment modal, the modal was closed, and the desktop page was
// reloaded — the persistent panel then re-reads the admin-only projection
// (GET /api/v1/mobile/registrations), locates the same phone by its row, and
// revokes it with only that row's hostId. No enrollment id, no QR state, no
// secrets are involved anywhere on this path.

import { describe, expect, it } from "bun:test";
import type { MobileRegistrationSummary, MobileUploadDestination } from "@lamasync/core";
import {
  createDestinationAndReload,
  DEVICE_REVOKE_REASON,
  loadDestinationsForDevice,
  loadMobileRegistrations,
  mobileRegistrationBadgeClass,
  mobileRegistrationLabel,
  mobileRegistrationStatus,
  revokeDestinationAndReload,
  revokeDeviceAndReload,
  type MobileDevicesServices,
} from "./mobile-registrations.ts";

/** Projection row fixture (the exact wire shape the server ships). */
function reg(over: Partial<MobileRegistrationSummary> = {}): MobileRegistrationSummary {
  return {
    hostId: "host-pixel-9",
    displayName: "Pixel 9",
    clientType: "android",
    appVersion: "1.2.0",
    createdAt: 1_783_999_300_000,
    lastSeenAt: 1_784_000_000_000,
    revokedAt: null,
    revokedReason: null,
    ...over,
  };
}

/** Scripted services: records calls, serves a mutable list the test drives. */
function scriptedServices(initial: MobileRegistrationSummary[]) {
  const revokeCalls: Array<{ hostId: string; reason: string }> = [];
  const listCalls: number[] = [];
  let store = [...initial];
  let listError: Error | null = null;
  let revokeError: Error | null = null;
  const services: MobileDevicesServices = {
    async list() {
      listCalls.push(store.length);
      if (listError) throw listError;
      return [...store];
    },
    async revoke(hostId: string, reason: string) {
      revokeCalls.push({ hostId, reason });
      if (revokeError) throw revokeError;
      store = store.map((row) =>
        row.hostId === hostId
          ? { ...row, revokedAt: 1_784_000_100_000, revokedReason: reason }
          : row,
      );
    },
    // Stage 1 destination methods are unused by the registration-flow tests;
    // wire trivial stubs so the interface stays honest.
    async listDestinations() {
      return [];
    },
    async createDestination() {
      throw new Error("not used in this test");
    },
    async revokeDestination() {
      throw new Error("not used in this test");
    },
  };
  return {
    services,
    get revokeCalls() {
      return revokeCalls;
    },
    get listCalls() {
      return listCalls;
    },
    failNextList(err: Error) {
      listError = err;
    },
    failNextRevoke(err: Error) {
      revokeError = err;
    },
  };
}

describe("mobileRegistrationStatus / badge / label", () => {
  it("treats a null or zero revokedAt as active", () => {
    expect(mobileRegistrationStatus({ revokedAt: null })).toBe("active");
    expect(mobileRegistrationStatus({ revokedAt: 0 })).toBe("active");
  });

  it("treats a stamped revokedAt as revoked", () => {
    expect(mobileRegistrationStatus({ revokedAt: 1_784_000_100_000 })).toBe("revoked");
  });

  it("maps status to the panel's badge class and label", () => {
    expect(mobileRegistrationBadgeClass("active")).toBe("badge-success");
    expect(mobileRegistrationBadgeClass("revoked")).toBe("badge-failed");
    expect(mobileRegistrationLabel("active")).toBe("active");
    expect(mobileRegistrationLabel("revoked")).toBe("revoked");
  });
});

describe("loadMobileRegistrations — GET /mobile/registrations projection", () => {
  it("returns the projection rows (active + revoked are both rendered)", async () => {
    const { services } = scriptedServices([
      reg(), // active, most recent
      reg({
        hostId: "host-old-phone",
        displayName: "Old phone",
        appVersion: "1.0.0",
        createdAt: 1_783_000_000_000,
        lastSeenAt: null,
        revokedAt: 1_783_800_000_000,
        revokedReason: "Lost device",
      }),
    ]);

    const result = await loadMobileRegistrations(services);

    expect(result.error).toBeNull();
    expect(result.rows?.map((r) => r.hostId)).toEqual([
      "host-pixel-9",
      "host-old-phone",
    ]);
    expect(result.rows?.[1]?.revokedReason).toBe("Lost device");
  });

  it("returns an empty list as success (the panel shows its empty state)", async () => {
    const { services } = scriptedServices([]);
    const result = await loadMobileRegistrations(services);
    expect(result).toEqual({ rows: [], error: null });
  });

  it("returns the error text when the projection cannot be read", async () => {
    const script = scriptedServices([]);
    script.failNextList(new Error("Failed to fetch"));
    const result = await loadMobileRegistrations(script.services);
    expect(result.rows).toBeNull();
    expect(result.error).toBe("Failed to fetch");
  });
});

describe("revokeDeviceAndReload — revoke then refresh the projection", () => {
  it("revokes by hostId and swaps in the refreshed list (row flips to revoked)", async () => {
    const script = scriptedServices([reg()]);
    const { services, revokeCalls, listCalls } = script;

    const result = await revokeDeviceAndReload(
      services,
      "host-pixel-9",
      DEVICE_REVOKE_REASON,
    );

    expect(result.error).toBeNull();
    // Exactly one revoke of that host with the panel's audit reason…
    expect(revokeCalls).toEqual([
      { hostId: "host-pixel-9", reason: DEVICE_REVOKE_REASON },
    ]);
    // …then exactly one reload of the projection (the fresh list is what
    // the panel renders — no manual refresh needed after revoking).
    expect(listCalls).toEqual([1]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows?.[0]?.revokedAt).toBe(1_784_000_100_000);
    expect(result.rows?.[0]?.revokedReason).toBe(DEVICE_REVOKE_REASON);
  });

  it("keeps revoked rows in the refreshed list (revoked included)", async () => {
    const script = scriptedServices([
      reg(),
      reg({
        hostId: "host-old-phone",
        displayName: "Old phone",
        revokedAt: 1_783_800_000_000,
        revokedReason: "Lost device",
      }),
    ]);
    const result = await revokeDeviceAndReload(
      script.services,
      "host-pixel-9",
      DEVICE_REVOKE_REASON,
    );
    expect(result.rows?.map((r) => r.hostId).sort()).toEqual([
      "host-old-phone",
      "host-pixel-9",
    ]);
  });

  it("does NOT reload when the revoke call itself fails (error surfaces, rows untouched)", async () => {
    const script = scriptedServices([reg()]);
    script.failNextRevoke(new Error("403 admin required"));
    const result = await revokeDeviceAndReload(
      script.services,
      "host-pixel-9",
      DEVICE_REVOKE_REASON,
    );
    expect(result.rows).toBeNull();
    expect(result.error).toBe("403 admin required");
    // Revoke failed → the list must not be re-read (nothing changed).
    expect(script.listCalls).toEqual([]);
  });

  it("regression: pair → close modal → reload → locate same phone → revoke", async () => {
    // After the modal closes and the desktop reloads, the panel starts from
    // a fresh projection read and must find the previously paired phone by
    // its row alone — then revoke cuts it. This is the review's core
    // complaint: no enrollment modal state survives, but the hostId does.
    const script = scriptedServices([
      reg({
        hostId: "host-pixel-9",
        displayName: "Pixel 9",
        createdAt: 1_783_999_300_000, // paired earlier, still active
      }),
    ]);
    // Fresh mount/reload: read the projection once to "locate the phone".
    const located = await loadMobileRegistrations(script.services);
    expect(located.rows?.[0]?.hostId).toBe("host-pixel-9");
    expect(located.rows?.[0]?.revokedAt).toBeNull();

    // Admin clicks Revoke on that row (hostId only — no enrollment id).
    const after = await revokeDeviceAndReload(
      script.services,
      located.rows?.[0]?.hostId as string,
      DEVICE_REVOKE_REASON,
    );
    expect(script.revokeCalls).toHaveLength(1);
    expect(script.revokeCalls[0]?.hostId).toBe("host-pixel-9");
    expect(after.rows?.[0]?.revokedAt).not.toBeNull();
    expect(after.error).toBeNull();
  });
});

describe("stage 1 destination flows", () => {
  /** Scripted services with an in-memory destination list per host. */
  function destinationServices(initial: MobileUploadDestination[] = []) {
    const createCalls: Array<{ hostId: string; label: string; slug?: string }> = [];
    const revokeCalls: Array<{ hostId: string; id: string }> = [];
    let store = [...initial];
    let error: Error | null = null;
    const services: MobileDevicesServices = {
      async list() {
        return [];
      },
      async revoke() {
        return {};
      },
      async listDestinations(hostId) {
        if (error) throw error;
        return store.filter((d) => d.registrationId === hostId);
      },
      async createDestination(hostId, label, slug) {
        createCalls.push({ hostId, label, slug });
        if (error) throw error;
        const d: MobileUploadDestination = {
          id: `mdst-${store.length + 1}`,
          registrationId: hostId,
          label,
          relPath: `Mobile/${hostId}/${slug ?? label}`,
          createdAt: Date.now(),
          revokedAt: null,
        };
        store = [...store, d];
        return d;
      },
      async revokeDestination(hostId, id) {
        revokeCalls.push({ hostId, id });
        if (error) throw error;
        store = store.map((d) =>
          d.id === id ? { ...d, revokedAt: Date.now() } : d,
        );
        return {};
      },
    };
    return {
      services,
      calls: { createCalls, revokeCalls },
      fail(next: Error | null) {
        error = next;
      },
      get: () => [...store],
    };
  }

  function dest(
    over: Partial<MobileUploadDestination> = {},
  ): MobileUploadDestination {
    return {
      id: "mdst-1",
      registrationId: "host-pixel-9",
      label: "Inbox",
      relPath: "Mobile/host-pixel-9/Inbox",
      createdAt: 1_783_999_300_000,
      revokedAt: null,
      ...over,
    };
  }

  it("loads a device's destinations (active + revoked)", async () => {
    const script = destinationServices([
      dest(),
      dest({ id: "mdst-2", label: "Camera", relPath: "Mobile/host-pixel-9/Camera" }),
    ]);
    const result = await loadDestinationsForDevice(script.services, "host-pixel-9");
    expect(result.error).toBeNull();
    expect(result.destinations).toHaveLength(2);
  });

  it("assigns a labeled inbox and reloads the fresh list", async () => {
    const script = destinationServices();
    const result = await createDestinationAndReload(
      script.services,
      "host-pixel-9",
      "Shared Files",
    );
    expect(script.calls.createCalls).toEqual([
      { hostId: "host-pixel-9", label: "Shared Files", slug: undefined },
    ]);
    expect(result.error).toBeNull();
    expect(result.destinations?.[0]?.relPath).toBe(
      "Mobile/host-pixel-9/Shared Files",
    );
  });

  it("propagates an assignment failure without reloading the list", async () => {
    const script = destinationServices();
    script.fail(new Error("destination already exists"));
    const result = await createDestinationAndReload(
      script.services,
      "host-pixel-9",
      "Inbox",
    );
    expect(result.destinations).toBeNull();
    expect(result.error).toBe("destination already exists");
  });

  it("revokes a destination idempotently and reloads", async () => {
    const script = destinationServices([dest()]);
    const result = await revokeDestinationAndReload(
      script.services,
      "host-pixel-9",
      "mdst-1",
    );
    expect(script.calls.revokeCalls).toEqual([
      { hostId: "host-pixel-9", id: "mdst-1" },
    ]);
    expect(result.destinations?.[0]?.revokedAt).not.toBeNull();
  });
});
