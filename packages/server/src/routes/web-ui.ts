import { Elysia } from "elysia";
import webUiHtml from "@lamasync/web-ui/dist/index.html";
import { PWA_ICONS } from "../pwa-icons.generated.ts";
import { webAppManifest } from "../pwa/manifest.ts";
import { SERVICE_WORKER_SOURCE } from "../pwa/service-worker.ts";

const FALLBACK_HTML =
  "<!doctype html><html><body>Web UI not built. Run <code>bun run build:web-ui</code> from the repo root, then restart the server.</body></html>";

const cachedHtml =
  typeof webUiHtml === "string" && webUiHtml.length > 0 ? webUiHtml : FALLBACK_HTML;

/**
 * Root browser routes: the SPA shell plus the assets of the installable web
 * app (LAMA-329 phase 7).
 *
 * All three of the PWA routes live at the ORIGIN ROOT rather than under
 * `/api/v1`. A service worker can only control paths at or below its own
 * directory, and a manifest's `scope`/`start_url` resolve against the document,
 * so both must sit where the SPA does. They carry no bearer auth and no fleet
 * data: the shell they belong to is already public, and the service worker
 * never touches `/api/`.
 *
 * They hang off this plugin instead of a separate one on purpose — adding
 * another `.use()` to the server's plugin chain pushes TypeScript's type
 * instantiation over its depth limit (`TS2589` in `app.ts`), and these are the
 * same "browser plumbing at the root" concern as the shell itself.
 *
 * `scripts/check-skill-drift.ts` strips the `/api/v1` prefix when comparing, so
 * the rows in `packages/agent-skill/reference/api.md` document these under
 * their real root paths.
 */

/**
 * Shared swagger detail for the PWA asset routes.
 *
 * One object reused rather than a literal per route: three distinct `detail`
 * literals pushed the composed app's inferred type past TypeScript's
 * instantiation depth (`TS2589` in `app.ts`), and these routes share the same
 * tag and response shape anyway.
 */
const pwaAssetDetail = {
  tags: ["Web app"],
  responses: { 200: { description: "PWA asset" } },
} as const;

export const webUiRoutes = new Elysia()
  .get("/", ({ set }) => {
    set.headers["content-type"] = "text/html; charset=utf-8";
    set.headers["cache-control"] = "no-cache";
    return cachedHtml;
  })
  .get(
    "/manifest.webmanifest",
    ({ set }) => {
      set.headers["content-type"] = "application/manifest+json; charset=utf-8";
      // A stale manifest would keep an installed app pointing at removed icons.
      set.headers["cache-control"] = "no-cache";
      return JSON.stringify(webAppManifest(), null, 2);
    },
    {
      detail: {
        summary: "Web app manifest (install identity, icons, theme colours)",
        tags: ["Web app"],
        responses: {
          200: { description: "Web app manifest" },
        },
      },
    },
  )
  .get(
    "/sw.js",
    ({ set }) => {
      set.headers["content-type"] = "text/javascript; charset=utf-8";
      // A cached service worker stalls the next deploy's update check.
      set.headers["cache-control"] = "no-cache";
      // Defensive: the script already sits at the root, so its scope is "/",
      // but this keeps that true if it is ever served from a subdirectory.
      set.headers["service-worker-allowed"] = "/";
      return SERVICE_WORKER_SOURCE;
    },
    {
      detail: {
        summary: "Service worker (app-shell cache only; never caches API data)",
        tags: ["Web app"],
        responses: {
          200: { description: "Service worker script" },
        },
      },
    },
  )
  .get(
    "/icons/:file",
    ({ params, set, status }) => {
      // Look the name up in the generated icon set instead of touching the
      // filesystem, so an unknown name 404s rather than resolving to a path.
      const icon = PWA_ICONS.find((candidate) => candidate.path === `/icons/${params.file}`);
      if (!icon) return status(404, { error: "unknown icon" });
      set.headers["content-type"] = "image/png";
      set.headers["cache-control"] = "public, max-age=86400";
      return Buffer.from(icon.base64, "base64");
    },
    {
      detail: {
        summary: "PWA icon by file name (192/512/maskable-512)",
        tags: ["Web app"],
        responses: {
          200: { description: "PNG icon" },
          404: { description: "Unknown icon name" },
        },
      },
    },
  );
