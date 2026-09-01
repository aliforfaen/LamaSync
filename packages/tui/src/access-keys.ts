// Pure presentation helpers for the Access keys view (LAMA-234 TUI
// completion). Renderer-free and side-effect-free: this module classifies
// the current credential, formats masked key metadata, derives the action
// surface for a row, and formats countdown/status text. It deliberately
// never touches, stores, or returns secret material — the view owns the
// secret panel and this module only shapes what may be displayed safely.

import type { ApiKeySummary, AuthMeResponse } from "@lamasync/core";

// ---------------------------------------------------------------------------
// Principal classification
// ---------------------------------------------------------------------------

/** True when the current credential may manage managed keys (master or a
 *  managed `admin` key). Device credentials are read-only identities. */
export function canManageAccessKeys(me: AuthMeResponse): boolean {
  return me.kind === "master" || me.kind === "admin";
}

/** Short label for the credential that is currently driving the view. */
export function principalLabel(me: AuthMeResponse): string {
  switch (me.kind) {
    case "master":
      return "LAMASYNC_API_KEY (master / break-glass)";
    case "admin":
      return me.name ? `admin key "${me.name}"` : "admin key";
    case "device":
      return me.name ? `device key "${me.name}"` : "device key";
    case "deploy":
      return me.name ? `deploy key "${me.name}"` : "deploy key";
  }
}

/** Explanation shown on the device-principal screen. */
export const DEVICE_EXPLANATION =
  "Device keys identify this host to the fleet but cannot manage fleet " +
  "access. Ask an administrator to re-pair or revoke this credential.";

// ---------------------------------------------------------------------------
// Row model (masked metadata only — never secrets)
// ---------------------------------------------------------------------------

export type AccessKeyStatus = "active" | "revoked";

export interface AccessKeyRowDisplay {
  id: string;
  name: string;
  kind: "admin" | "device" | "deploy";
  hostId: string | null;
  /** Human bound-host label: the host id for device keys, "—" for admin. */
  boundHostLabel: string;
  createdAtLabel: string;
  lastUsedLabel: string;
  statusLabel: AccessKeyStatus;
  fingerprint: string;
  /** Reveal/revoke only make sense for rows that are still active. */
  canReveal: boolean;
  canRevoke: boolean;
  /** One-line masked summary used as the Select row description. */
  summary: string;
}

export function keyStatus(key: ApiKeySummary): AccessKeyStatus {
  return key.revokedAt === null ? "active" : "revoked";
}

/**
 * Deterministic UTC timestamp label. `toISOString()` renders in UTC so the
 * label is identical on every machine/timezone; we only keep the minute
 * precision that fits an 80-column table row.
 */
export function formatKeyTimestamp(ts: number | null): string {
  if (ts === null) return "never";
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return "?";
  const iso = date.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) {
    return "?";
  }
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** `599` → "9:59" — clamped at zero so a stale tick never shows negative. */
export function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Whole seconds between `nowMs` and an ISO expiry, clamped at 0. */
export function secondsUntil(expiresAt: string | null, nowMs: number): number {
  if (expiresAt === null || expiresAt === "") return 0;
  const expiryMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryMs)) return 0;
  return Math.max(0, Math.ceil((expiryMs - nowMs) / 1000));
}

/** Build the table display model from masked summaries. */
export function toAccessKeyRows(
  keys: ReadonlyArray<ApiKeySummary>,
): AccessKeyRowDisplay[] {
  return keys.map((key) => {
    const status = keyStatus(key);
    const active = status === "active";
    const boundHostLabel =
      key.kind === "device" ? (key.hostId ?? "?") : "—";
    const lastUsedLabel =
      key.lastUsedAt === null ? "never" : formatKeyTimestamp(key.lastUsedAt);
    return {
      id: key.id,
      name: key.name,
      kind: key.kind,
      hostId: key.hostId,
      boundHostLabel,
      createdAtLabel: formatKeyTimestamp(key.createdAt),
      lastUsedLabel,
      statusLabel: status,
      fingerprint: key.fingerprint,
      canReveal: active,
      canRevoke: active,
      summary:
        `${key.name} · ${key.kind} · host ${boundHostLabel} · ${status}` +
        ` · fp ${key.fingerprint} · created ${formatKeyTimestamp(key.createdAt)}` +
        ` · last ${lastUsedLabel}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Wizard copy helpers
// ---------------------------------------------------------------------------

/** Destructive-confirmation line for the revoke wizard. */
export function revokeConfirmLine(key: ApiKeySummary): string {
  const hostPart =
    key.kind === "device" && key.hostId !== null
      ? ` bound to host ${key.hostId}`
      : "";
  return `Revoke key "${key.name}" (${key.kind}${hostPart})? This cannot be undone.`;
}

/** Warning shown before reveal/create exposes a raw secret on screen. */
export const SECRET_SCROLLBACK_WARNING =
  "The secret will be visible here and in terminal scrollback or " +
  "recordings. Save it somewhere safe, then acknowledge to close.";