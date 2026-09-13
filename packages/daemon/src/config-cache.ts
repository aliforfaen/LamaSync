import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { HostConfig } from "@lamasync/core";
import { expandConfigPaths } from "./config.ts";
import { PRIVATE_FILE_MODE, writeFileAtomic } from "./atomic-file.ts";

/**
 * Cache of the last host config fetched from the server. Lets the daemon keep
 * scheduling assignments across server restarts and lets the local CLI inspect state
 * without round-tripping to the API.
 */
export const CACHE_PATH = join(
  homedir(),
  ".config",
  "lamasync",
  "config-cache.json",
);

/**
 * Read the cached host config. Returns null when no cache exists yet — the
 * daemon simply skips the local-only behaviour in that case and pulls from the
 * server. `cachePath` is injectable for tests.
 */
export function loadCache(cachePath: string = CACHE_PATH): HostConfig | null {
  if (!existsSync(cachePath)) return null;
  try {
    const text = readFileSync(cachePath, "utf8");
    // LAMA-309: expand `~` assignment local paths on read too, so a cache
    // written by a pre-fix daemon still yields absolute paths for every
    // consumer. Idempotent for paths that are already absolute.
    return expandConfigPaths(JSON.parse(text) as HostConfig);
  } catch (err) {
    console.warn(
      `[config-cache] failed to parse ${cachePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Persist the host config atomically (LAMA-336). This file is the daemon's
 * only offline scheduling source, and it is read back on the next start — a
 * truncated write would silently drop every cached assignment, so the write
 * goes through the shared atomic writer instead of straight to disk.
 */
export function saveCache(config: HostConfig, cachePath: string = CACHE_PATH): void {
  const dir = dirname(cachePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileAtomic(cachePath, JSON.stringify(config, null, 2), PRIVATE_FILE_MODE);
}
