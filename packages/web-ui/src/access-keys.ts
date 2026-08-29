// LAMA-234: pure helpers for the Admin "Access keys" panel. Kept free of
// React so the masking / enrollment heuristics are unit-testable without a
// DOM. The Web UI shows masked fingerprints and statuses only — raw secrets
// exist solely inside the reveal modal's component state and are cleared on
// close.

/** Render a masked fingerprint, e.g. "a3f2b9c01d" → "a3f2b9c0••••". The
 *  server only ever ships the first 10 hex chars of the hash; this adds the
 *  visual masking. Returning the raw input unchanged for non-strings keeps
 *  the table safe even if a future field drifts. */
export function maskFingerprint(fingerprint: string | null | undefined): string {
  if (typeof fingerprint !== "string" || fingerprint.length === 0) return "—";
  if (fingerprint.length > 8) return `${fingerprint.slice(0, 8)}••••`;
  return fingerprint;
}

export type ManagedKeyStatus = "active" | "revoked";

/** Active unless the server says the row was soft-revoked. */
export function apiKeyStatus(key: { revokedAt: number | null }): ManagedKeyStatus {
  return key.revokedAt !== null && key.revokedAt > 0 ? "revoked" : "active";
}

/** Badge class name for a key status row. */
export function apiKeyStatusBadge(status: ManagedKeyStatus): string {
  return status === "revoked" ? "badge-failed" : "badge-success";
}

/**
 * Migration panel heuristic: which registered hosts already carry a managed
 * device-key binding. Hosts without one are shown as "not enrolled yet".
 * This is deliberately a HEURISTIC (LAMA-234) — a host without a binding may
 * still be using the master `LAMASYNC_API_KEY`, which carries no caller
 * identity, so absence is not proof of what it uses.
 */
export function hostEnrollment(
  keys: Array<{ kind: string; hostId: string | null }>,
  hosts: Array<{ id: string }>,
): Map<string, boolean> {
  const bound = new Set(
    keys
      .filter((k) => k.kind === "device" && typeof k.hostId === "string" && k.hostId.length > 0)
      .map((k) => k.hostId as string),
  );
  return new Map(hosts.map((h) => [h.id, bound.has(h.id)]));
}

/** Human label for a key type. */
export function apiKeyKindLabel(kind: string): string {
  return kind === "device" ? "Device" : kind === "admin" ? "Admin" : kind;
}