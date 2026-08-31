// Device-side facts reported to the server for the device cards (LAMA-282).
// Pure + trivially testable: `osLabel` from node:os, `storageUsedBytes`
// from node:fs statfs.

import { existsSync, readdirSync, statfsSync } from "node:fs";
import { homedir, release, type } from "node:os";
import { dirname, join } from "node:path";
import type { HostClass } from "@lamasync/core";

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

// LAMA-298: host-class detection. The daemon seeds the server's
// `host_class` column on first heartbeat so the web-ui can render a
// per-class icon and the server can route offline notifications / fleet
// status by class. This is a best-effort heuristic; the operator can always
// override it in the web-ui.

/** Facts the detector reasons over. Injectable so tests stay deterministic. */
export interface HostClassFacts {
  /** True when the device reports a battery (laptop/phone/tablet). */
  hasBattery: boolean;
  /** True when the device is a phone/tablet form factor. */
  isMobile: boolean;
  /** True when the device is a server/VM (headless, containerized). */
  isServerLike: boolean;
}

/** Pure classifier: map facts -> class. `unknown` when nothing is certain. */
export function detectHostClass(facts: HostClassFacts): HostClass {
  if (facts.isMobile) return facts.hasBattery ? "phone" : "tablet";
  if (facts.hasBattery) return "laptop";
  if (facts.isServerLike) return "server";
  return "desktop";
}

function hasBattery(): boolean {
  // Linux exposes power supplies under /sys/class/power_supply; a `BAT*`
  // entry means there's a battery (i.e. a laptop/phone, not a server).
  try {
    return readdirSync("/sys/class/power_supply").some((entry) =>
      entry.startsWith("BAT"),
    );
  } catch {
    // macOS / other: no /sys tree, so no battery signal from here. Servers
    // and desktops are the common non-Linux homelab targets; a MacBook
    // would need the manual override (or a future platform check).
    return false;
  }
}

function isServerLike(): boolean {
  // Containers and systemd VMs are almost always always-on servers.
  if (existsSync("/.dockerenv")) return true;
  if (existsSync("/run/.containerenv")) return true;
  if (existsSync("/run/systemd/container")) return true;
  return false;
}

function isMobileFormFactor(): boolean {
  // No reliable cross-platform marker for phones/tablets. Default false so
  // a battery device maps to "laptop"; the web-ui override covers real
  // phones. Kept as a function so the fact set is symmetric and testable.
  return false;
}

/** Convenience wrapper reading the real system facts. */
export function readHostClassFacts(): HostClassFacts {
  return {
    hasBattery: hasBattery(),
    isMobile: isMobileFormFactor(),
    isServerLike: isServerLike(),
  };
}
