import { Elysia } from "elysia";
import webUiHtml from "@lamasync/web-ui/dist/index.html";

const FALLBACK_HTML =
  "<!doctype html><html><body>Web UI not built. Run <code>bun run build:web-ui</code> from the repo root, then restart the server.</body></html>";

const cachedHtml =
  typeof webUiHtml === "string" && webUiHtml.length > 0 ? webUiHtml : FALLBACK_HTML;

export const webUiRoutes = new Elysia().get("/", ({ set }) => {
  set.headers["content-type"] = "text/html; charset=utf-8";
  set.headers["cache-control"] = "no-cache";
  return cachedHtml;
});
