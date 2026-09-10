// Server tests for the browser-comfort routes (LAMA-329 phase 7): the web app
// manifest, the PWA icons and the service worker.
//
// These are the machine half of the phase-7 acceptance gates: the manifest has
// to pass Chrome's install checks, the icons have to be real PNGs, and the
// service worker must never cache authenticated API data. The last one is the
// only gate here with a security consequence, so it is asserted against the
// exact source that ships rather than against a description of it.

import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { webUiRoutes } from "./routes/web-ui.ts";
import { PWA_ICONS } from "./pwa-icons.generated.ts";
import { webAppManifest, PWA_THEME_COLOR } from "./pwa/manifest.ts";
import {
  SERVICE_WORKER_CACHE_NAME,
  SERVICE_WORKER_CACHE_PREFIX,
  SERVICE_WORKER_SHELL_PATHS,
  SERVICE_WORKER_SOURCE,
} from "./pwa/service-worker.ts";

const app = new Elysia().use(webUiRoutes);

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("GET /manifest.webmanifest", () => {
  test("serves a parseable manifest with the install-critical fields", async () => {
    const res = await app.handle(new Request("http://localhost/manifest.webmanifest"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    // A cached manifest keeps an installed app pointing at removed icons.
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const manifest = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(manifest.name).toBe("LamaSync");
    expect(manifest.short_name).toBe("LamaSync");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toBe(PWA_THEME_COLOR);
    expect(manifest.background_color).toBe(PWA_THEME_COLOR);
  });

  test("advertises at least the 192 and 512 sizes Chrome requires, plus maskable", () => {
    const icons = webAppManifest().icons;
    const sizes = icons.map((icon) => `${icon.sizes}:${icon.purpose}`);
    // Chrome will not offer installation without a 192 and a 512.
    expect(sizes).toContain("192x192:any");
    expect(sizes).toContain("512x512:any");
    // Maskable is separate, not a replacement: it is what stops Android from
    // shrinking the mark inside its circular mask.
    expect(sizes).toContain("512x512:maskable");
    for (const icon of icons) expect(icon.type).toBe("image/png");
  });

  test("every advertised icon is actually served", async () => {
    for (const icon of webAppManifest().icons) {
      const res = await app.handle(new Request(`http://localhost${icon.src}`));
      expect(res.status).toBe(200);
    }
  });
});

describe("GET /icons/:file", () => {
  test("returns real PNG bytes with a long cache", async () => {
    for (const icon of PWA_ICONS) {
      const res = await app.handle(new Request(`http://localhost${icon.path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toContain("max-age=86400");

      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes.length).toBe(icon.bytes);
      expect([...bytes.slice(0, 8)]).toEqual(PNG_MAGIC);
    }
  });

  test("404s an unknown name instead of reaching the filesystem", async () => {
    const res = await app.handle(new Request("http://localhost/icons/../../etc/passwd"));
    expect(res.status).toBe(404);
  });
});

describe("GET /sw.js", () => {
  test("serves JavaScript scoped to the origin root", async () => {
    const res = await app.handle(new Request("http://localhost/sw.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("service-worker-allowed")).toBe("/");
  });

  test("never caches or intercepts the authenticated API", async () => {
    // The gate: "authenticated API data is not cached". Asserted against the
    // shipped source, because the risk is replayed fleet data after sign-out.
    expect(SERVICE_WORKER_SOURCE).toContain('url.pathname.startsWith("/api/")');
    expect(SERVICE_WORKER_SOURCE).toContain('url.pathname.startsWith("/swagger")');
    // Every precached path must be shell furniture, never an API path.
    for (const path of SERVICE_WORKER_SHELL_PATHS) {
      expect(path.startsWith("/api/")).toBe(false);
    }
    // And the cache name is what invalidates old clients on a shell change.
    expect(SERVICE_WORKER_SOURCE).toContain(SERVICE_WORKER_CACHE_NAME);
  });

  test("precaches the shell so the app can boot offline, and nothing more", () => {
    expect([...SERVICE_WORKER_SHELL_PATHS]).toContain("/");
    expect(SERVICE_WORKER_SHELL_PATHS.length).toBeLessThanOrEqual(6);
  });

  test("activation prunes only its own shell caches, not the whole origin", async () => {
    // Cache Storage is origin-wide. A worker that deletes every name but its
    // own would erase caches owned by another app or another worker on the
    // same origin, which is unrelated data loss. Run the shipped source against
    // a controlled Cache Storage stub rather than asserting on its text, so the
    // filter is exercised as written.
    const deleted: string[] = [];
    type WorkerEvent = { waitUntil: (work: Promise<unknown>) => void };
    type WorkerListener = (event: WorkerEvent) => void;
    const listeners = new Map<string, WorkerListener>();
    const selfStub = {
      addEventListener: (type: string, listener: WorkerListener) => {
        listeners.set(type, listener);
      },
      skipWaiting: async () => undefined,
      clients: { claim: async () => undefined },
      location: { origin: "http://localhost" },
    };
    const cachesStub = {
      keys: async () => [
        SERVICE_WORKER_CACHE_NAME,
        `${SERVICE_WORKER_CACHE_PREFIX}v0`,
        "some-other-app-cache",
        "workbox-precache-v2",
      ],
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
      open: async () => ({ put: async () => undefined }),
      match: async () => undefined,
    };
    const run = new Function(
      "self",
      "caches",
      "fetch",
      "Response",
      "URL",
      SERVICE_WORKER_SOURCE,
    );
    run(
      selfStub,
      cachesStub,
      async () => new Response("", { status: 200 }),
      Response,
      URL,
    );

    let activation: Promise<unknown> | null = null;
    listeners.get("activate")?.({ waitUntil: (work) => { activation = work; } });
    expect(activation).not.toBeNull();
    await activation;

    // The superseded shell cache goes; every foreign name survives.
    expect(deleted).toEqual([`${SERVICE_WORKER_CACHE_PREFIX}v0`]);
  });

  test("degrades honestly when a navigation is uncached and the network is down", () => {
    // An empty response would leave a blank page with no explanation.
    expect(SERVICE_WORKER_SOURCE).toContain("LamaSync is unreachable");
  });
});

describe("generated icon module", () => {
  test("matches the source PNGs", async () => {
    // Guards the one direction a hand-edit could take silently: someone bumps
    // a PNG in packages/web-ui/src/assets/pwa without re-running the
    // generator, leaving the server serving the old art.
    const { renderModule } = await import("../../../scripts/gen-pwa-assets.ts");
    const committed = await Bun.file(
      new URL("./pwa-icons.generated.ts", import.meta.url),
    ).text();
    expect(committed).toBe(renderModule());
  });
});
