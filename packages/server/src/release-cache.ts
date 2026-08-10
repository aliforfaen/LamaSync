// Server-side release-info cache. Proxies api.github.com so daemons behind
// firewalls don't need direct access; caches the response for ~1 hour so the
// per-request fan-out is bounded. Failure modes:
//
//   - First call, upstream fails          → returns `null` (no stale fallback yet)
//   - Later call within TTL, upstream OK  → returns cached value (refreshed)
//   - Later call past TTL, upstream fails → returns the stale cached value
//   - Concurrent callers while fetching  → share one inflight promise
//
// Never throws into request handlers: every code path returns a value or
// `null`.

import { VERSION } from "@lamasync/core";
import type { ReleaseAssetView, ReleaseInfo } from "@lamasync/core";

const GITHUB_API =
  "https://api.github.com/repos/aliforfaen/LamaSync/releases/latest";
const TTL_MS = 60 * 60 * 1000; // ~1 hour

interface GithubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GithubRelease {
  tag_name: string;
  published_at: string;
  assets: GithubAsset[];
}

interface CacheEntry {
  release: ReleaseInfo;
  fetchedAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry | null> | null = null;

async function fetchOnce(): Promise<CacheEntry | null> {
  let upstream: Response;
  try {
    upstream = await fetch(GITHUB_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `lamasync-server/${VERSION}`,
      },
      // Don't let a hung upstream stall request handlers on a cold cache.
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return null;
  }
  if (!upstream.ok) return null;

  let json: Partial<GithubRelease>;
  try {
    json = (await upstream.json()) as Partial<GithubRelease>;
  } catch {
    return null;
  }
  if (
    typeof json.tag_name !== "string" ||
    typeof json.published_at !== "string" ||
    !Array.isArray(json.assets)
  ) {
    return null;
  }

  const tag = json.tag_name;
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  const assets: ReleaseAssetView[] = json.assets
    .filter(
      (a): a is GithubAsset =>
        typeof a?.name === "string" &&
        typeof a?.browser_download_url === "string" &&
        typeof a?.size === "number",
    )
    .map((a) => ({
      name: a.name,
      downloadUrl: a.browser_download_url,
      size: a.size,
    }));

  return {
    release: { tag, version, publishedAt: json.published_at, assets },
    fetchedAt: Date.now(),
  };
}

/**
 * Return the cached latest release. Refreshes on cache miss / TTL expiry;
 * falls back to the stale value on fetch failure so a transient GitHub
 * outage doesn't break host update-status derivation.
 */
export async function getCachedLatestRelease(): Promise<ReleaseInfo | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) {
    return cache.release;
  }
  if (inflight) {
    const result = await inflight;
    return result?.release ?? cache?.release ?? null;
  }
  inflight = fetchOnce();
  try {
    const result = await inflight;
    if (result) {
      cache = result;
      return result.release;
    }
    return cache?.release ?? null;
  } finally {
    inflight = null;
  }
}

/**
 * Convenience: latest release's `version` field (the tag with leading "v"
 * stripped) or `null`. Used by host serialization to compute
 * `updateAvailable` without re-reading the full release payload.
 */
export async function getCachedLatestVersion(): Promise<string | null> {
  const release = await getCachedLatestRelease();
  return release?.version ?? null;
}

/** Test seam: drop the cached value so unit tests can simulate fresh fetches. */
export function __resetCachedLatestReleaseForTests(): void {
  cache = null;
  inflight = null;
}

/**
 * Test seam: inject a synthetic cached release so unit tests can exercise
 * `updateAvailable` derivation without a real network fetch. Pass `null` to
 * clear the cache (equivalent to `__resetCachedLatestReleaseForTests`).
 */
export function __setCachedLatestVersionForTests(version: string | null): void {
  if (version === null) {
    __resetCachedLatestReleaseForTests();
    return;
  }
  cache = {
    release: {
      tag: `v${version}`,
      version,
      publishedAt: new Date().toISOString(),
      assets: [],
    },
    fetchedAt: Date.now(),
  };
  inflight = null;
}
