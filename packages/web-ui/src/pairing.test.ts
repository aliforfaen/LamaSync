import { describe, expect, it } from "bun:test";
import {
  formatCountdown,
  isPending,
  normalizeQrData,
  qrSvg,
  secondsUntil,
  statusLabel,
} from "./pairing.ts";

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
});
