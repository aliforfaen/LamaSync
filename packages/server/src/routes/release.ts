// Release-info proxy: shields daemons behind firewalls from having to
// reach api.github.com directly. The server fans out to GitHub on their
// behalf and returns the same shape the daemon's self-update module
// expects. The fetch is cached in release-cache.ts (~1h TTL) so per-
// request fan-out is bounded.
import { Elysia } from "elysia";
import { getCachedLatestRelease, type ReleaseInfo } from "../release-cache.ts";

export const releaseRoutes = new Elysia({ prefix: "/api/v1" }).get(
  "/release/latest",
  async ({ set }) => {
    const release: ReleaseInfo | null = await getCachedLatestRelease();
    if (!release) {
      set.status = 502;
      return { error: "upstream_unreachable" as const };
    }
    return release;
  },
  {
    detail: {
      summary: "Latest GitHub release info (proxied, cached)",
      tags: ["Release"],
      responses: {
        200: { description: "Latest release info" },
        502: { description: "GitHub API unreachable" },
      },
    },
  },
);
