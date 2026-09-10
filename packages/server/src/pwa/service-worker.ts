/**
 * LAMA-329 phase 7: the asset-only service worker, served from `GET /sw.js`.
 *
 * Scope of the promise, deliberately narrow:
 *   - it makes the APP SHELL boot offline;
 *   - it does NOT make the app work offline.
 *
 * That distinction is the whole design. Fleet data comes from the API, and the
 * plan's acceptance gate is "authenticated API data is not cached" — so this
 * worker never touches `/api/` in either direction. Offline, the shell loads
 * and then the UI has to say honestly that it cannot reach the server, which is
 * what the web UI's connectivity banner does.
 *
 * It is exported as a source string rather than a real `.js` file so the route
 * handler, the tests and the reviewable definition are the same artifact, and
 * so a test can assert the never-cache rule against exactly what ships.
 */

/** Bump to invalidate every client's cache after a shell change. */
export const SERVICE_WORKER_CACHE_NAME = "lamasync-shell-v1";

/** Paths precached on install. Root paths only — this is the shell. */
export const SERVICE_WORKER_SHELL_PATHS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
] as const;

export const SERVICE_WORKER_SOURCE = `// LamaSync service worker (LAMA-329 phase 7). Generated from
// packages/server/src/pwa/service-worker.ts — do not edit the served copy.
//
// Caches the application shell ONLY. Never caches or serves API responses: the
// fleet data behind /api/ is authenticated and must not be replayed from a
// cache after sign-out or a permission change.

const CACHE = ${JSON.stringify(SERVICE_WORKER_CACHE_NAME)};
const SHELL = ${JSON.stringify(SERVICE_WORKER_SHELL_PATHS)};

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // One failure must not leave the app uninstalled: addAll is atomic, so
      // fetch each entry and skip the ones that are unavailable.
      await Promise.all(
        SHELL.map(async (path) => {
          try {
            const response = await fetch(path, { cache: "reload" });
            if (response.ok) await cache.put(path, response);
          } catch {
            // Offline during install: the shell is cached on a later visit.
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/** True for the authenticated API and the Swagger surface: never touched. */
function isNeverCached(url) {
  return url.pathname.startsWith("/api/") || url.pathname.startsWith("/swagger");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isNeverCached(url)) return;

  if (request.mode === "navigate") {
    // Network first so a deployed update is picked up immediately; the cached
    // shell is the offline fallback, not the default.
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(CACHE);
            await cache.put("/", response.clone());
          }
          return response;
        } catch {
          const cached = await caches.match("/");
          if (cached) return cached;
          return new Response("LamaSync is unreachable. Reconnect and reload.", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      })(),
    );
    return;
  }

  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(url.pathname);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(url.pathname, response.clone());
        }
        return response;
      })(),
    );
  }
});
`;
