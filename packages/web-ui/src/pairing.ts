// LAMA-262: pure, unit-testable helpers for the pairing display. Kept free
// of React / DOM so the countdown formatting, status-label mapping, and QR
// data normalization can be tested in isolation (see pairing.test.ts).

import type { PairingSessionStatus } from "@lamasync/core";
import qrcode from "qrcode-generator";

/** QR encodes the code string the operator types — never a URL. */
export function normalizeQrData(code: string): string {
  // The server issues UPPER-case codes (lama-XXXX-XXXX) but a user may have
  // hand-edited or the wire may carry a stray lower-case form. The CLI
  // accepts either case, so normalize to UPPER for a consistent, readable
  // scan. Whitespace is stripped so accidental copy-paste with a trailing
  // newline still scans correctly.
  return code.trim().toUpperCase();
}

/** Map a session status to a human, glossary-safe label for the UI. */
export function statusLabel(status: PairingSessionStatus): string {
  switch (status) {
    case "pending":
      return "Waiting for device";
    case "used":
      return "Device paired";
    case "expired":
      return "Code expired";
  }
}

/** True when a session is still open and can be exchanged. */
export function isPending(status: PairingSessionStatus): boolean {
  return status === "pending";
}

/**
 * Format a remaining time in seconds as "M:SS" (e.g. "9:47"). Negative or
 * zero renders as "0:00" so a just-expired card never flashes a negative.
 */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Remaining whole seconds until `expiresAt` (ISO), given the current time. */
export function secondsUntil(expiresAt: string, now: Date = new Date()): number {
  const target = Date.parse(expiresAt);
  if (!Number.isFinite(target)) return 0;
  return Math.max(0, Math.ceil((target - now.getTime()) / 1000));
}

/**
 * Build the QR SVG markup for a code. The QR encodes the code string the
 * user types (never a URL — the CLI takes the code). Returns "" for empty
 * input. Pure + DOM-free so it's unit-testable; rendering is via
 * `qrcode-generator` (the single deliberate dep — no hand-rolled QR math).
 */
export function qrSvg(code: string): string {
  const data = normalizeQrData(code);
  if (data.length === 0) return "";
  const qr = qrcode(0, "L");
  qr.addData(data);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 1, scalable: false });
}
