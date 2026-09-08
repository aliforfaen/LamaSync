// LAMA-262 / LAMA-296: pure, unit-testable helpers for the pairing and
// Android-enrollment displays. Kept free of React / DOM so the countdown
// formatting, status-label mapping, and QR data normalization can be tested
// in isolation (see pairing.test.ts).
//
// Two deliberately separate QR encodings live here:
//   1. The legacy CLI pairing QR (LAMA-262) encodes the code string the
//      operator types. Its normalization uppercases and trims — BYTE
//      IDENTICAL behavior is preserved below (see `qrSvg`).
//   2. The Android enrollment QR (LAMA-296) encodes versioned JSON with the
//      server origin, enrollment id, and one-time secret. JSON keys, the
//      `kind` string, and the secret are case-sensitive and are NEVER run
//      through the CLI uppercase normalization — the mobile app rejects an
//      uppercased payload.

import type { MobileEnrollmentQrV1, PairingSessionStatus } from "@lamasync/core";
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
 * Build the QR SVG markup for an arbitrary string. The payload is encoded
 * verbatim — no trimming/uppercasing (used by the Android enrollment QR,
 * whose JSON payload is case-sensitive). Returns "" for empty input.
 */
export function qrSvgRaw(text: string): string {
  return svgForText(text);
}

/**
 * Build the QR SVG markup for a code. The QR encodes the code string the
 * user types (never a URL — the CLI takes the code). Returns "" for empty
 * input. LAMA-262 legacy path: normalization (trim + uppercase) applies —
 * behavior is byte-identical to the pre-LAMA-296 implementation.
 */
export function qrSvg(code: string): string {
  return svgForText(normalizeQrData(code));
}

/** Shared QR renderer: deterministic SVG for one raw string, "" for empty. */
function svgForText(text: string): string {
  if (text.length === 0) return "";
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 1, scalable: false });
}

// ---------------------------------------------------------------------------
// LAMA-296 — Android enrollment QR payload.
//
// The desktop web UI renders a QR whose payload is versioned JSON:
//   {"kind":"lamasync.android.enroll","version":1,"serverOrigin":"https://…",
//    "enrollmentId":"…","secret":"…"}
// Case is significant and preserved verbatim; the secret is a one-time
// 256-bit QR secret that exists only in this QR and the create response.
// The origin must be a bare HTTPS origin (the server validates it too; this
// guard keeps the UI from rendering a QR the Android app would refuse).
// ---------------------------------------------------------------------------

/** True for a canonical bare HTTPS origin (no path, query, hash, or
 *  credentials; never a non-HTTPS scheme). */
export function isBareHttpsOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.pathname !== "/") return false;
  if (parsed.search !== "" || parsed.hash !== "") return false;
  return parsed.hostname.length > 0;
}

/** Human reason an Android enrollment payload cannot be rendered, or null.
 *  Operates on `unknown` so wire-shaped data (server responses, pasted
 *  payloads) is validated with the same kind/version/HTTPS-origin rules the
 *  Android app enforces when scanning. */
export function androidEnrollmentPayloadError(
  value: unknown,
): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "The QR payload is not a JSON object.";
  }
  const rec = value as Record<string, unknown>;
  if (rec.kind !== "lamasync.android.enroll") {
    return `Unsupported QR payload kind “${String(rec.kind)}”.`;
  }
  if (rec.version !== 1) {
    return `Unsupported QR payload version ${String(rec.version)}.`;
  }
  const serverOrigin = rec.serverOrigin;
  if (typeof serverOrigin !== "string" || !isBareHttpsOrigin(serverOrigin)) {
    return "The server origin must be a bare https:// URL (no path, query, or credentials).";
  }
  const enrollmentId = rec.enrollmentId;
  const secret = rec.secret;
  if (typeof enrollmentId !== "string" || enrollmentId.length === 0) {
    return "The payload is missing its enrollment id.";
  }
  if (typeof secret !== "string" || secret.length === 0) {
    return "The payload is missing its enrollment secret.";
  }
  return null;
}

/** Type guard over the same rules: narrows wire-shaped data to a valid
 *  versioned Android enrollment payload (kind/version/HTTPS-origin). */
export function isAndroidEnrollmentPayload(
  value: unknown,
): value is MobileEnrollmentQrV1 {
  return androidEnrollmentPayloadError(value) === null;
}

/**
 * Serialize an Android enrollment payload to the exact JSON text the QR
 * encodes. Key order is fixed and case is preserved verbatim — this path
 * NEVER uppercases (the CLI pairing normalization does not apply). Throws
 * when the payload fails `androidEnrollmentPayloadError`.
 */
export function androidEnrollmentPayload(payload: MobileEnrollmentQrV1): string {
  const problem = androidEnrollmentPayloadError(payload);
  if (problem !== null) throw new Error(problem);
  return JSON.stringify({
    kind: payload.kind,
    version: payload.version,
    serverOrigin: payload.serverOrigin,
    enrollmentId: payload.enrollmentId,
    secret: payload.secret,
  });
}

/** QR SVG for an Android enrollment payload (case-preserving JSON). */
export function androidEnrollmentQrSvg(payload: MobileEnrollmentQrV1): string {
  return svgForText(androidEnrollmentPayload(payload));
}

/** Remaining whole seconds until an epoch-ms deadline, given the current
 *  epoch ms. Mirrors `secondsUntil` for the epoch-ms wire form the mobile
 *  enrollment endpoints use. */
export function secondsUntilEpochMs(expiresAtMs: number, nowMs = Date.now()): number {
  if (!Number.isFinite(expiresAtMs)) return 0;
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
}
