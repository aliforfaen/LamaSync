// Renderer-free unit tests for the Access keys presentation helpers
// (LAMA-234 TUI completion). These pin principal classification, masked
// row formatting (including revoked rows and device bindings), and the
// date/countdown boundary behavior. No renderer, no secrets.

import { describe, expect, test } from "bun:test";

import type { ApiKeySummary, AuthMeResponse } from "@lamasync/core";

import {
  canManageAccessKeys,
  DEVICE_EXPLANATION,
  formatCountdown,
  formatKeyTimestamp,
  principalLabel,
  revokeConfirmLine,
  secondsUntil,
  SECRET_SCROLLBACK_WARNING,
  toAccessKeyRows,
} from "./access-keys.ts";

function summary(overrides: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id: "key_1",
    name: "cachy daemon",
    kind: "device",
    hostId: "host-a",
    createdAt: 1_600_000_000_000,
    lastUsedAt: null,
    revealedAt: null,
    revokedAt: null,
    revokedReason: null,
    fingerprint: "a3f2b9c01d",
    ...overrides,
  };
}

describe("principal classification", () => {
  test("master and admin may manage access keys", () => {
    const master: AuthMeResponse = { kind: "master", keyId: null, name: null, hostId: null };
    const admin: AuthMeResponse = { kind: "admin", keyId: "key_2", name: "ops", hostId: null };
    expect(canManageAccessKeys(master)).toBe(true);
    expect(canManageAccessKeys(admin)).toBe(true);
  });

  test("device credentials cannot manage access keys", () => {
    const device: AuthMeResponse = { kind: "device", keyId: "key_3", name: "cachy", hostId: "host-a" };
    expect(canManageAccessKeys(device)).toBe(false);
  });

  test("principalLabel names each kind", () => {
    expect(
      principalLabel({ kind: "master", keyId: null, name: null, hostId: null }),
    ).toContain("master");
    expect(
      principalLabel({ kind: "admin", keyId: "key_2", name: "ops", hostId: null }),
    ).toBe('admin key "ops"');
    expect(
      principalLabel({ kind: "device", keyId: "key_3", name: "cachy", hostId: "host-a" }),
    ).toBe('device key "cachy"');
  });

  test("device explanation is present and mentions an administrator", () => {
    expect(DEVICE_EXPLANATION).toContain("administrator");
  });
});

describe("masked row formatting", () => {
  test("active admin key: dash bound host, reveal/revoke available", () => {
    const rows = toAccessKeyRows([summary({ kind: "admin", name: "Admin laptop", hostId: null })]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.boundHostLabel).toBe("—");
    expect(row.statusLabel).toBe("active");
    expect(row.canReveal).toBe(true);
    expect(row.canRevoke).toBe(true);
    expect(row.lastUsedLabel).toBe("never");
  });

  test("device key keeps its bound host id as the label", () => {
    const rows = toAccessKeyRows([summary({ kind: "device", hostId: "host-a" })]);
    expect(rows[0]!.boundHostLabel).toBe("host-a");
    expect(rows[0]!.kind).toBe("device");
  });

  test("revoked row loses reveal/revoke and reads revoked", () => {
    const rows = toAccessKeyRows([
      summary({ revokedAt: 1_600_000_100_000, revokedReason: "replaced" }),
    ]);
    const row = rows[0]!;
    expect(row.statusLabel).toBe("revoked");
    expect(row.canReveal).toBe(false);
    expect(row.canRevoke).toBe(false);
    expect(row.summary).toContain("revoked");
  });

  test("display models contain no secret field", () => {
    const rows = toAccessKeyRows([summary()]);
    expect(JSON.stringify(rows)).not.toContain("secret");
    expect(JSON.stringify(rows)).not.toContain("token");
  });

  test("revokeConfirmLine names the key and bound host for device keys", () => {
    const line = revokeConfirmLine(summary({ kind: "device", hostId: "host-a" }));
    expect(line).toContain("cachy daemon");
    expect(line).toContain("host-a");
    expect(line).toContain("cannot be undone");
  });

  test("revokeConfirmLine omits host for admin keys", () => {
    const line = revokeConfirmLine(summary({ kind: "admin", hostId: null }));
    expect(line).not.toContain("bound to host");
    expect(line).toContain("admin");
  });

  test("scrollback warning copy is present", () => {
    expect(SECRET_SCROLLBACK_WARNING).toContain("scrollback");
  });
});

describe("timestamp formatting", () => {
  test("null reads 'never'", () => {
    expect(formatKeyTimestamp(null)).toBe("never");
  });

  test("renders UTC to minute precision", () => {
    // 2026-08-29T15:51:57Z — deterministic across machines in UTC.
    expect(formatKeyTimestamp(Date.UTC(2026, 7, 29, 15, 51, 57))).toBe(
      "2026-08-29 15:51",
    );
  });

  test("invalid timestamps read '?'", () => {
    expect(formatKeyTimestamp(Number.NaN)).toBe("?");
  });
});

describe("countdown formatting boundaries", () => {
  test("zero and negative clamp to 0:00", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-42)).toBe("0:00");
  });

  test("minute/second edges", () => {
    expect(formatCountdown(59)).toBe("0:59");
    expect(formatCountdown(60)).toBe("1:00");
    expect(formatCountdown(599)).toBe("9:59");
    expect(formatCountdown(600)).toBe("10:00");
    expect(formatCountdown(3600)).toBe("60:00");
  });

  test("non-integer input floors", () => {
    expect(formatCountdown(9.9)).toBe("0:09");
  });
});

describe("secondsUntil", () => {
  const now = 1_700_000_000_000;

  test("future expiry returns whole seconds (ceiling)", () => {
    expect(secondsUntil(new Date(now + 9_500).toISOString(), now)).toBe(10);
  });

  test("expired or boundary returns 0", () => {
    expect(secondsUntil(new Date(now - 1).toISOString(), now)).toBe(0);
    expect(secondsUntil(new Date(now).toISOString(), now)).toBe(0);
  });

  test("null/empty/invalid expiry returns 0", () => {
    expect(secondsUntil(null, now)).toBe(0);
    expect(secondsUntil("", now)).toBe(0);
    expect(secondsUntil("not-a-date", now)).toBe(0);
  });
});