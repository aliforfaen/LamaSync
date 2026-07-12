import { Elysia } from "elysia";

// Resolve API key at module load. Missing key is a hard startup failure.
export const API_KEY = process.env.LAMASYNC_API_KEY;
if (!API_KEY || API_KEY.length === 0) {
  // eslint-disable-next-line no-console
  console.error("FATAL: LAMASYNC_API_KEY environment variable is required");
  process.exit(1);
}

export const authPlugin = new Elysia({ name: "lamasync-auth" }).onRequest(
  ({ request, set }) => {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (!match || match[1] !== API_KEY) {
      set.status = 401;
      return { error: "Unauthorized" };
    }
  },
);
