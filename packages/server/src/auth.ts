import { Elysia } from "elysia";

/**
 * Paths under /api/ that are intentionally NOT protected by the
 * pre-shared-API-key bearer check. Each entry is matched as a literal
 * prefix, so order matters only for ties. Today the only exempt path is
 * the pairing-code exchange endpoint — see the comment next to the
 * constant for the design rationale.
 *
 * Add to this list only when (a) the endpoint can be exercised by a
 * caller that does not yet have the bearer key, AND (b) the endpoint
 * proves caller intent another way (the pairing exchange proves intent
 * by knowing the short, single-use code; the WS endpoint proves it via
 * the Sec-WebSocket-Protocol token).
 */
const AUTH_EXEMPT_PATHS: string[] = [
  "/api/v1/pairing/",
];

export function getAuthPlugin() {
  const API_KEY = process.env.LAMASYNC_API_KEY;
  if (!API_KEY || API_KEY.length === 0) {
    console.error("FATAL: LAMASYNC_API_KEY environment variable is required");
    process.exit(1);
  }
  return new Elysia({ name: "lamasync-auth" }).onRequest(
    ({ request, set }) => {
      // Only enforce the Bearer token on the versioned API surface. WebSocket
      // upgrades authenticate via Sec-WebSocket-Protocol inside the ws route's
      // `open` handler; skip both the bearer check and any pre-flight for
      // the WebSocket upgrade header.
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/")) {
        return;
      }
      const upgrade = request.headers.get("upgrade") ?? "";
      if (upgrade.toLowerCase() === "websocket") {
        return;
      }
      // LAMA-262: the pairing-code exchange endpoint is auth-exempt by
      // design. The device has no API key yet — that's the whole point of
      // the pairing flow — so requiring a Bearer would be a chicken/egg.
      // The single-use short code IS the proof of intent; without the
      // code the exchange endpoint returns 404 / 409 / 410 anyway.
      // The companion endpoints (`POST /pairing` to create a session and
      // `GET /pairing/:code` to poll its status) DO require the bearer —
      // only the unauthenticated exchange is exempt.
      for (const exempt of AUTH_EXEMPT_PATHS) {
        if (url.pathname.startsWith(`${exempt}`) && url.pathname.endsWith("/exchange")) {
          return;
        }
      }
      const header = request.headers.get("authorization") ?? "";
      const match = /^Bearer\s+(.+)$/.exec(header);
      if (!match || match[1] !== API_KEY) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
    },
  );
}
