// LAMA-299: remote daemon update capability contract.
//
// `update_daemon` is a queued action the daemon only understands from the
// release that ships its dispatcher case. An older daemon marks it as an
// unknown action and acks a failure, so the web UI must never offer the
// button to hosts reporting a version below this one. This constant is the
// single source of truth shared by the server, the web UI (via the
// "./remote-update" subpath export — never the barrel, which pulls
// bun:sqlite into the Vite bundle), and tests.
//
// Bump this together with the root package.json version that first ships
// the `update_daemon` dispatcher case.

/**
 * First daemon version that understands the `update_daemon` queued action.
 */
export const REMOTE_DAEMON_UPDATE_MIN_VERSION = "0.3.6";

/**
 * True when a daemon reporting `version` supports the `update_daemon`
 * queued action. Numeric triple comparison (same semantics as
 * ./version-compare.ts): unparseable/missing versions return false —
 * an unversioned host must see the manual-upgrade instruction, never a
 * job that cannot succeed.
 */
export function daemonSupportsRemoteUpdate(
  version: string | null | undefined,
): boolean {
  if (typeof version !== "string" || version.length === 0) return false;
  const cur = parseSemver(version);
  const min = parseSemver(REMOTE_DAEMON_UPDATE_MIN_VERSION);
  if (!cur || !min) return false;
  for (let i = 0; i < 3; i++) {
    if (cur[i]! < min[i]!) return false;
    if (cur[i]! > min[i]!) return true;
  }
  return true;
}

function parseSemver(v: string): [number, number, number] | null {
  const stripped = v.trim().replace(/^[vV]/, "");
  const m = stripped.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map((s) => Number.parseInt(s!, 10));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return nums as [number, number, number];
}
