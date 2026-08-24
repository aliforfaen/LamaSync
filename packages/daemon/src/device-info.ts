// Device-side facts reported to the server for the device cards (LAMA-282).
// Pure + trivially testable: `osLabel` from node:os, `storageUsedBytes`
// from node:fs statfs.

import { statfsSync } from "node:fs";
import { release, type } from "node:os";

/**
 * Human-readable OS label, e.g. "Linux 6.8.0" or "Darwin 23.4.0". Shown on
 * the device card so the fleet overview reads as real machines, not ids.
 */
export function osLabel(): string {
  return `${type()} ${release()}`;
}

/**
 * Bytes used on the filesystem backing `path`: (total blocks - free
 * blocks) * block size. Used for the device card's storage-used figure.
 */
export function storageUsedBytes(path: string): number {
  const fs = statfsSync(path);
  return (fs.blocks - fs.bfree) * fs.bsize;
}
