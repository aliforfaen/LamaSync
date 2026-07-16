import { Elysia } from "elysia";

export function getAuthPlugin() {
  const API_KEY = process.env.LAMASYNC_API_KEY;
  if (!API_KEY || API_KEY.length === 0) {
    console.error("FATAL: LAMASYNC_API_KEY environment variable is required");
    process.exit(1);
  }
  return new Elysia({ name: "lamasync-auth" }).onRequest(
    ({ request, set }) => {
      // WebSocket upgrades authenticate via Sec-WebSocket-Protocol inside the
      // ws route's `open` handler; skip the bearer-token check for upgrades so
      // the protocol header is the sole source of truth for the WS path.
      const upgrade = request.headers.get("upgrade") ?? "";
      if (upgrade.toLowerCase() === "websocket") {
        return;
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
