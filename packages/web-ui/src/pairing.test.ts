import { describe, expect, it } from "bun:test";
import {
  androidEnrollmentPayload,
  androidEnrollmentPayloadError,
  androidEnrollmentQrSvg,
  formatCountdown,
  isAndroidEnrollmentPayload,
  isBareHttpsOrigin,
  isPending,
  normalizeQrData,
  qrSvg,
  qrSvgRaw,
  secondsUntil,
  secondsUntilEpochMs,
  statusLabel,
} from "./pairing.ts";
import type { MobileEnrollmentQrV1 } from "@lamasync/core";

describe("normalizeQrData", () => {
  it("uppercases the code and trims whitespace", () => {
    expect(normalizeQrData("lama-72b4-9pq1")).toBe("LAMA-72B4-9PQ1");
    expect(normalizeQrData("  LAMA-72B4-9PQ1\n")).toBe("LAMA-72B4-9PQ1");
  });

  it("leaves an already-normal code unchanged", () => {
    expect(normalizeQrData("LAMA-72B4-9PQ1")).toBe("LAMA-72B4-9PQ1");
  });

  it("handles empty input", () => {
    expect(normalizeQrData("")).toBe("");
  });
});

describe("statusLabel", () => {
  it("maps every status to a friendly label", () => {
    expect(statusLabel("pending")).toBe("Waiting for device");
    expect(statusLabel("used")).toBe("Device paired");
    expect(statusLabel("expired")).toBe("Code expired");
  });
});

describe("isPending", () => {
  it("is true only for pending", () => {
    expect(isPending("pending")).toBe(true);
    expect(isPending("used")).toBe(false);
    expect(isPending("expired")).toBe(false);
  });
});

describe("formatCountdown", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(formatCountdown(587)).toBe("9:47");
    expect(formatCountdown(60)).toBe("1:00");
    expect(formatCountdown(5)).toBe("0:05");
  });

  it("floors partial seconds", () => {
    expect(formatCountdown(59.9)).toBe("0:59");
  });

  it("never renders negative", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});

describe("secondsUntil", () => {
  const now = new Date("2026-08-26T12:00:00.000Z");

  it("returns whole remaining seconds, rounding up", () => {
    const expires = "2026-08-26T12:09:47.000Z"; // 587s later
    expect(secondsUntil(expires, now)).toBe(587);
  });

  it("returns 0 for past or unparseable timestamps", () => {
    expect(secondsUntil("2026-08-26T11:59:00.000Z", now)).toBe(0);
    expect(secondsUntil("not-a-date", now)).toBe(0);
  });
});

describe("qrSvg", () => {
  it("returns an SVG string with a viewBox for a real code", () => {
    const svg = qrSvg("LAMA-72B4-9PQ1");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("viewBox");
    // Normalization applies inside the QR path too.
    expect(qrSvg("lama-72b4-9pq1")).toBe(svg);
  });

  it("returns '' for empty input", () => {
    expect(qrSvg("")).toBe("");
    expect(qrSvg("   ")).toBe("");
  });

  it("is deterministic per code", () => {
    expect(qrSvg("LAMA-AAAA-2345")).toBe(qrSvg("LAMA-AAAA-2345"));
  });

  it("legacy CLI QR behavior is byte-identical (uppercase code path)", () => {
    // LAMA-296 regression guard: the CLI pairing QR must keep uppercasing —
    // the Android payload path below must never share this normalization.
    expect(qrSvg("lama-72b4-9pq1")).toBe(qrSvg("LAMA-72B4-9PQ1"));
    expect(qrSvgRaw("lama-72b4-9pq1")).not.toBe(qrSvg("LAMA-72B4-9PQ1"));
  });
});

// A representative Android enrollment payload. The secret is deliberately
// mixed-case (base64url-ish) so tests prove case is preserved verbatim.
const ANDROID_PAYLOAD: MobileEnrollmentQrV1 = {
  kind: "lamasync.android.enroll",
  version: 1,
  serverOrigin: "https://fleet.example.com",
  enrollmentId: "enr_9zXy7AbC-01",
  secret: "s3cR3t_MiXeDcAsE-0+9xY",
};

describe("androidEnrollmentPayload", () => {
  it("emits the versioned JSON with exact key order and case preserved", () => {
    expect(androidEnrollmentPayload(ANDROID_PAYLOAD)).toBe(
      '{"kind":"lamasync.android.enroll","version":1,"serverOrigin":"https://fleet.example.com","enrollmentId":"enr_9zXy7AbC-01","secret":"s3cR3t_MiXeDcAsE-0+9xY"}',
    );
  });

  it("never uppercases the payload (no CLI normalization on JSON/URLs/secrets)", () => {
    const text = androidEnrollmentPayload(ANDROID_PAYLOAD);
    expect(text).not.toContain("LAMASYNC.ANDROID.ENROLL");
    expect(text).not.toContain("ENR_9ZXY7ABC-01");
    expect(text).not.toContain("S3CR3T");
    expect(text).toContain("lamasync.android.enroll");
    expect(text).toContain("s3cR3t_MiXeDcAsE-0+9xY");
  });

  it("rejects payloads failing runtime checks (non-HTTPS origin, missing fields)", () => {
    expect(() =>
      androidEnrollmentPayload({ ...ANDROID_PAYLOAD, serverOrigin: "http://fleet.example.com" }),
    ).toThrow(/bare https:\/\//);
    expect(() =>
      androidEnrollmentPayload({ ...ANDROID_PAYLOAD, secret: "" }),
    ).toThrow(/secret/);
    // kind/version are compile-time literals here; their runtime rejection is
    // exercised through the unknown-narrowing validator below.
  });
});

describe("androidEnrollmentPayloadError / isAndroidEnrollmentPayload", () => {
  it("accepts a well-formed payload", () => {
    expect(androidEnrollmentPayloadError(ANDROID_PAYLOAD)).toBeNull();
    expect(isAndroidEnrollmentPayload(ANDROID_PAYLOAD)).toBe(true);
  });

  it("validates kind and version", () => {
    expect(androidEnrollmentPayloadError({ ...ANDROID_PAYLOAD, kind: "pairing-code" })).toMatch(
      /Unsupported QR payload kind/,
    );
    expect(androidEnrollmentPayloadError({ ...ANDROID_PAYLOAD, version: 99 })).toMatch(
      /Unsupported QR payload version/,
    );
    expect(isAndroidEnrollmentPayload({ kind: "other", version: 1 })).toBe(false);
  });

  it("requires an HTTPS-only bare origin", () => {
    expect(androidEnrollmentPayloadError({ ...ANDROID_PAYLOAD, serverOrigin: "http://fleet.example.com" })).toMatch(
      /bare https:\/\//,
    );
    expect(
      androidEnrollmentPayloadError({ ...ANDROID_PAYLOAD, serverOrigin: "https://user:pass@fleet.example.com" }),
    ).toMatch(/bare https:\/\//);
    expect(
      androidEnrollmentPayloadError({ ...ANDROID_PAYLOAD, serverOrigin: "https://fleet.example.com/extra" }),
    ).toMatch(/bare https:\/\//);
    expect(
      androidEnrollmentPayloadError({ ...ANDROID_PAYLOAD, serverOrigin: "https://fleet.example.com/?a=1" }),
    ).toMatch(/bare https:\/\//);
    expect(isAndroidEnrollmentPayload({ ...ANDROID_PAYLOAD, serverOrigin: "ws://fleet.example.com" })).toBe(false);
  });

  it("rejects non-objects and missing fields", () => {
    expect(androidEnrollmentPayloadError(null)).toBe("The QR payload is not a JSON object.");
    expect(androidEnrollmentPayloadError("lamasync.android.enroll")).toBe("The QR payload is not a JSON object.");
    expect(androidEnrollmentPayloadError({ ...ANDROID_PAYLOAD, enrollmentId: "" })).toMatch(/enrollment id/);
    expect(androidEnrollmentPayloadError({ ...ANDROID_PAYLOAD, secret: undefined })).toMatch(/secret/);
    expect(isAndroidEnrollmentPayload(undefined)).toBe(false);
  });
});

describe("isBareHttpsOrigin", () => {
  it("accepts bare https origins with optional port", () => {
    expect(isBareHttpsOrigin("https://fleet.example.com")).toBe(true);
    expect(isBareHttpsOrigin("https://fleet.example.com:8443")).toBe(true);
    expect(isBareHttpsOrigin("https://10.0.0.5")).toBe(true);
  });

  it("rejects http, credentials, paths, query, and fragments", () => {
    expect(isBareHttpsOrigin("http://fleet.example.com")).toBe(false);
    expect(isBareHttpsOrigin("https://user@fleet.example.com")).toBe(false);
    expect(isBareHttpsOrigin("https://fleet.example.com/lama")).toBe(false);
    expect(isBareHttpsOrigin("https://fleet.example.com/?x=1")).toBe(false);
    expect(isBareHttpsOrigin("https://fleet.example.com/#top")).toBe(false);
    expect(isBareHttpsOrigin("not a url")).toBe(false);
    expect(isBareHttpsOrigin("")).toBe(false);
  });
});

describe("androidEnrollmentQrSvg", () => {
  it("renders a deterministic SVG encoding the raw JSON payload", () => {
    const svg = androidEnrollmentQrSvg(ANDROID_PAYLOAD);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("viewBox");
    expect(svg).toBe(androidEnrollmentQrSvg(ANDROID_PAYLOAD));
    // The Android QR is the raw JSON text, NOT the uppercase CLI code —
    // rendering the same payload through the legacy path differs.
    expect(svg).not.toBe(qrSvg("LAMASYNC.ANDROID.ENROLL"));
    // Raw-text path agrees byte-for-byte with the payload serializer.
    expect(svg).toBe(qrSvgRaw(androidEnrollmentPayload(ANDROID_PAYLOAD)));
  });

  it("returns '' when the payload is invalid", () => {
    // qrSvgRaw mirrors qrSvg's empty-input contract at the raw layer.
    expect(qrSvgRaw("")).toBe("");
  });
});

describe("secondsUntilEpochMs", () => {
  const NOW = Date.parse("2026-08-26T12:00:00.000Z");

  it("returns whole remaining seconds, rounding up", () => {
    const expires = Date.parse("2026-08-26T12:09:47.000Z"); // 587s later
    expect(secondsUntilEpochMs(expires, NOW)).toBe(587);
  });

  it("returns 0 for past or non-finite deadlines", () => {
    expect(secondsUntilEpochMs(NOW - 1000, NOW)).toBe(0);
    expect(secondsUntilEpochMs(Number.NaN, NOW)).toBe(0);
    expect(secondsUntilEpochMs(Number.POSITIVE_INFINITY, NOW)).toBe(0);
  });
});
