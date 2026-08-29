// Device-side facts reported to the server for the device cards (LAMA-282).
// Pure + trivially testable: `osLabel` from node:os, `storageUsedBytes`
// from node:fs statfs.

import { existsSync, statfsSync } from "node:fs";
import { homedir, release, type } from "node:os";
import { dirname, join } from "node:path";

/**
 * Human-readable OS label, e.g. "Linux 6.8.0" or "Darwin 23.4.0". Shown on
 * the device card so the fleet overview reads as real machines, not ids.
 */
export function osLabel(): string {
  return `${type()} ${release()}`;
}

/** Resolve a leading `~`/`~/` in a config-style path to the home dir. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Return the requested path when it exists, otherwise walk upward to the
 * nearest existing directory. A freshly installed daemon may report its
 * default dataDir before that directory has been created; the filesystem
 * backing the nearest ancestor is still the correct storage figure and
 * avoids making an otherwise healthy heartbeat fail with ENOENT.
 */
function nearestExistingPath(path: string): string {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return ".";
    candidate = parent;
  }
  return candidate;
}

/**
 * Bytes used on the filesystem backing `path`: (total blocks - free
 * blocks) * block size. Used for the device card's storage-used figure.
 *
 * `path` may be a config string like `~/.local/share/lamasync` — expand
 * the tilde first so clients with a default dataDir don't hit ENOENT.
 */
export function storageUsedBytes(path: string): number {
  const fs = statfsSync(nearestExistingPath(expandHome(path)));
  return (fs.blocks - fs.bfree) * fs.bsize;
}
