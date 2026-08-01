// Semantic version comparison helper used by the server's release cache to
// derive "update available" for each registered host. Mirrors the daemon's
// self-update comparator so the two stay in agreement.
//
// Kept intentionally simple: numeric triple compare on the leading
// "MAJOR.MINOR.PATCH" segment, tolerating a leading "v"/"V" and ignoring any
// pre-release suffix (e.g. "0.3.0-rc.1" compares as "0.3.0"). Pre-release
// ordering is deliberately NOT implemented — that's a future enhancement.

/**
 * Return true when `candidate` is strictly greater than `current` under
 * numeric semver comparison. Equal versions, unparseable strings, and
 * `candidate` ≤ `current` all return false.
 */
export function isNewer(current: string, candidate: string): boolean {
  const cur = parseSemver(current);
  const can = parseSemver(candidate);
  if (!cur || !can) return false;
  for (let i = 0; i < 3; i++) {
    if (can[i]! > cur[i]!) return true;
    if (can[i]! < cur[i]!) return false;
  }
  return false;
}

function parseSemver(v: string): [number, number, number] | null {
  // Tolerate a leading "v"/"V" (the daemon's own --version banner includes it)
  // and any whitespace. Anything beyond the leading numeric triple — e.g. a
  // "-rc.1" suffix — is ignored.
  const stripped = v.trim().replace(/^[vV]/, "");
  const m = stripped.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map((s) => Number.parseInt(s!, 10));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return nums as [number, number, number];
}
