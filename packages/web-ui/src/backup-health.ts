// LAMA-266: pure helpers for the backup-health UI ("Prove it", fire drills,
// and the Dashboard "Verified" badge). Kept free of React so the visibility
// and copy rules are unit-testable. All copy is glossary-consistent
// ("storage destination", "backups are working").

import type { BackendKind } from "@lamasync/core";

/** A storage destination is provable only when it is a restic repository. */
export function isRestic(kind: BackendKind): boolean {
  return kind === "restic";
}

/**
 * Dashboard badge rule: show "✓ Verified <t> ago" when any destination has a
 * recent (within `windowMs`, default 30 days) last prove that succeeded.
 * Pass `now` for deterministic tests. `lastProveAt` is epoch ms.
 */
export function showVerifiedBadge(
  lastProveAt: number | null | undefined,
  lastProveOk: boolean | null | undefined,
  now: number,
  windowMs: number = 30 * 24 * 3600 * 1000,
): boolean {
  if (!lastProveOk) return false;
  if (!lastProveAt) return false;
  return now - lastProveAt <= windowMs;
}

/** Build the human-readable inline result line shown under a Prove/drill row. */
export function proveResultText(opts: {
  kind: "prove" | "drill";
  ok: boolean;
  file?: string | null;
  durationMs?: number | null;
  detail?: string | null;
}): string {
  const seconds =
    opts.durationMs != null && opts.durationMs > 0
      ? `${(opts.durationMs / 1000).toFixed(1)}s`
      : null;
  const kindLabel = opts.kind === "drill" ? "Fire drill" : "Prove";
  if (!opts.ok) {
    const detail = opts.detail && opts.detail.length > 0 ? opts.detail : "failed";
    return `✗ ${kindLabel} failed: ${detail}`;
  }
  const file = opts.file && opts.file.length > 0 ? opts.file : "a backup";
  const timing = seconds ? ` · ${seconds}` : "";
  return `✓ Restored ${file}${timing} — backups are working`;
}

/**
 * Non-restic destinations can't be proven. Returns the caption shown on the
 * disabled button so the state is carried by text, never color alone.
 */
export const PROVE_NEEDS_RESTIC = "needs a restic snapshot";
