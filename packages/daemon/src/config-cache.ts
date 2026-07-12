import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { HostConfig } from "@lamasync/core";

/**
 * Cache of the last host config fetched from the server. Lets the daemon keep
 * scheduling assignments across server restarts and lets the TUI inspect state
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
 * server.
 */
export function loadCache(): HostConfig | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const text = readFileSync(CACHE_PATH, "utf8");
    return JSON.parse(text) as HostConfig;
  } catch (err) {
    console.warn(
      `[config-cache] failed to parse ${CACHE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Persist the host config atomically (write-then-rename would be nicer, but
 * Bun's `writeFileSync` is good enough for a single-writer cache).
 */
export function saveCache(config: HostConfig): void {
  const dir = dirname(CACHE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(config, null, 2));
}