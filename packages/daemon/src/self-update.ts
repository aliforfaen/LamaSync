// Self-update: checks GitHub Releases for newer versions, downloads and
// replaces the running binary. Best-effort: never throws — callers can
// surface `false` / `null` to the user without try/catch.
import { chmod, rename, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { VERSION } from "@lamasync/core";

export interface ReleaseAsset {
  name: string;
  downloadUrl: string;
  size: number;
}

export interface ReleaseInfo {
  tag: string;          // e.g. "v0.3.0"
  version: string;      // e.g. "0.3.0" (without leading 'v')
  publishedAt: string;
  assets: ReleaseAsset[];
}

const GITHUB_API =
  "https://api.github.com/repos/alifraen/LamaSync/releases/latest";

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

/**
 * Fetch the latest release from GitHub. Returns `null` on any failure
 * (network error, non-2xx, malformed payload) so callers can treat
 * "no update info" uniformly with "fetch failed".
 */
export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(GITHUB_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `lamasyncd/${VERSION}`,
      },
    });
    if (!res.ok) {
      console.warn(`[update] GitHub responded ${res.status} ${res.statusText}`);
      return null;
    }
    const json = (await res.json()) as Partial<GithubRelease>;
    if (
      typeof json.tag_name !== "string" ||
      typeof json.published_at !== "string" ||
      !Array.isArray(json.assets)
    ) {
      console.warn("[update] GitHub payload missing required fields");
      return null;
    }
    const tag = json.tag_name;
    const version = tag.startsWith("v") ? tag.slice(1) : tag;
    const assets: ReleaseAsset[] = json.assets
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
      tag,
      version,
      publishedAt: json.published_at,
      assets,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[update] fetchLatestRelease failed: ${msg}`);
    return null;
  }
}

/**
 * Return true when `latest` is strictly greater than `current` under
 * numeric semver comparison. Pre-release tags like "0.3.0-rc.1" are
 * compared on the numeric prefix only (e.g. "0.3.0" vs "0.3.0-rc.1"
 * tie at the prefix and return false).
 */
export function isNewer(current: string, latest: string): boolean {
  const cur = parseSemver(current);
  const lat = parseSemver(latest);
  if (!cur || !lat) return false;
  for (let i = 0; i < 3; i++) {
    if (lat[i]! > cur[i]!) return true;
    if (lat[i]! < cur[i]!) return false;
  }
  return false;
}

function parseSemver(v: string): [number, number, number] | null {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map((s) => Number.parseInt(s!, 10));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return nums as [number, number, number];
}

/**
 * Download the asset at `downloadUrl` and atomically replace the file at
 * `binaryName` (interpreted as a path). Writes to a temp file alongside
 * the target, chmods 0755, then renames over the destination. Returns
 * false on any failure.
 *
 * On Linux, `rename(2)` over the running binary is safe — the kernel
 * keeps the old inode alive until the last file descriptor closes, so
 * the running process keeps executing the in-memory image while new
 * spawns pick up the replacement.
 */
export async function downloadAndReplace(
  downloadUrl: string,
  binaryName: string,
): Promise<boolean> {
  try {
    const res = await fetch(downloadUrl, {
      headers: { "User-Agent": `lamasyncd/${VERSION}` },
    });
    if (!res.ok) {
      console.warn(
        `[update] download failed: ${res.status} ${res.statusText} (${downloadUrl})`,
      );
      return false;
    }
    const buf = await res.arrayBuffer();

    const dir = tmpdir();
    const tempPath = join(
      dir,
      `.lamasyncd-update-${process.pid}-${Date.now()}`,
    );

    await Bun.write(tempPath, buf);
    await chmod(tempPath, 0o755);

    try {
      await unlink(binaryName);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT is fine — there's nothing to remove before rename.
      if (code !== "ENOENT") {
        console.warn(
          `[update] could not remove existing binary ${binaryName}: ${code ?? err}`,
        );
      }
    }

    await rename(tempPath, binaryName);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[update] downloadAndReplace failed: ${msg}`);
    return false;
  }
}
