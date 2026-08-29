// LAMA-234: unit tests for the Access-keys panel helpers — masking, key
// status, and the host-enrollment migration heuristic. Mirrors the repo's
// helper-test style (see `pairing.test.ts`) — pure functions, no DOM.

import { describe, expect, it } from "bun:test";
import {
  apiKeyKindLabel,
  apiKeyStatus,
  apiKeyStatusBadge,
  hostEnrollment,
  maskFingerprint,
} from "./access-keys.ts";

describe("maskFingerprint", () => {
  it("masks everything past the first 8 chars", () => {
    expect(maskFingerprint("a3f2b9c01d")).toBe("a3f2b9c0••••");
  });

  it("renders a dash for empty / missing values", () => {
    expect(maskFingerprint(null)).toBe("—");
    expect(maskFingerprint(undefined)).toBe("—");
    expect(maskFingerprint("")).toBe("—");
  });

  it("never widens a short fingerprint", () => {
    expect(maskFingerprint("abcd")).toBe("abcd");
  });

  it("never emits the full fingerprint, only a masked prefix", () => {
    // Real fingerprints are the first 10 hex chars of the token hash.
    const fingerprint = "0a1b2c3d4e";
    const masked = maskFingerprint(fingerprint);
    expect(masked).toBe("0a1b2c3d••••");
    expect(masked).not.toBe(fingerprint);
    expect(masked.endsWith("••••")).toBe(true);
  });
});

describe("apiKeyStatus", () => {
  it("is active until revoked", () => {
    expect(apiKeyStatus({ revokedAt: null })).toBe("active");
    expect(apiKeyStatus({ revokedAt: 0 })).toBe("active");
  });

  it("is revoked once the server stamps a timestamp", () => {
    expect(apiKeyStatus({ revokedAt: Date.now() })).toBe("revoked");
  });

  it("maps statuses to badge classes", () => {
    expect(apiKeyStatusBadge("active")).toBe("badge-success");
    expect(apiKeyStatusBadge("revoked")).toBe("badge-failed");
  });
});

describe("hostEnrollment (migration heuristic)", () => {
  const keys = [
    { kind: "admin", hostId: null },
    { kind: "device", hostId: "host-a" },
    { kind: "device", hostId: "host-b" },
    { kind: "device", hostId: "" },
  ];
  const hosts = [{ id: "host-a" }, { id: "host-b" }, { id: "host-c" }];

  it("flags hosts with a device binding as enrolled", () => {
    const map = hostEnrollment(keys, hosts);
    expect(map.get("host-a")).toBe(true);
    expect(map.get("host-b")).toBe(true);
  });

  it("flags hosts without a binding as not enrolled (heuristic, not proof)", () => {
    const map = hostEnrollment(keys, hosts);
    expect(map.get("host-c")).toBe(false);
  });

  it("ignores admin keys and empty hostIds for the binding set", () => {
    const map = hostEnrollment(keys, hosts);
    expect(map.get("host-a")).toBe(true); // unaffected by admin key
    expect(map.size).toBe(3);
  });

  it("an empty fleet yields an empty map", () => {
    expect(hostEnrollment([], []).size).toBe(0);
  });
});

describe("apiKeyKindLabel", () => {
  it("maps known kinds to friendly labels", () => {
    expect(apiKeyKindLabel("device")).toBe("Device");
    expect(apiKeyKindLabel("admin")).toBe("Admin");
    expect(apiKeyKindLabel("other")).toBe("other");
  });
});