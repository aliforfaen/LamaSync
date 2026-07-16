// Release-info proxy: shields daemons behind firewalls from having to
// reach api.github.com directly. The server fans out to GitHub on their
// behalf and returns the same shape the daemon's self-update module
// expects.
import { Elysia } from "elysia";
import { VERSION } from "@lamasync/core";

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

interface ReleaseAssetView {
  name: string;
  downloadUrl: string;
  size: number;
}

interface ReleaseView {
  tag: string;
  version: string;
  publishedAt: string;
  assets: ReleaseAssetView[];
}

export const releaseRoutes = new Elysia({ prefix: "/api/v1" }).get(
  "/release/latest",
  async ({ set }) => {
    let upstream: Response;
    try {
      upstream = await fetch(GITHUB_API, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `lamasync-server/${VERSION}`,
        },
      });
    } catch {
      set.status = 502;
      return { error: "upstream_unreachable" as const };
    }
    if (!upstream.ok) {
      set.status = 502;
      return { error: "upstream_unreachable" as const };
    }

    const json = (await upstream.json()) as Partial<GithubRelease>;
    if (
      typeof json.tag_name !== "string" ||
      typeof json.published_at !== "string" ||
      !Array.isArray(json.assets)
    ) {
      set.status = 502;
      return { error: "upstream_unreachable" as const };
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

    const release: ReleaseView = {
      tag,
      version,
      publishedAt: json.published_at,
      assets,
    };
    return release;
  },
  {
    detail: {
      summary: "Latest GitHub release info (proxied)",
      tags: ["Release"],
      responses: {
        200: { description: "Latest release info" },
        502: { description: "GitHub API unreachable" },
      },
    },
  },
);
