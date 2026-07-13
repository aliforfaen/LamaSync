
import { Elysia } from "elysia";
const app = new Elysia().ws("/ws", {
  open(ws) {
    const raw = ws.raw;
    let keys: string[] = [];
    if (raw && typeof raw === "object") keys = Object.keys(raw);
    let reqKeys: string[] = [];
    let hasHeaders = false;
    let proto: string | null = null;
    let upgrade: string | null = null;
    if (raw && typeof raw === "object" && "request" in raw) {
      const req = raw.request;
      if (req && typeof req === "object") {
        reqKeys = Object.keys(req);
        if ("headers" in req) {
          hasHeaders = true;
          const h = req.headers;
          if (h instanceof Headers) {
            proto = h.get("sec-websocket-protocol");
            upgrade = h.get("upgrade");
          }
        }
      }
    }
    console.log("raw keys:", JSON.stringify(keys));
    console.log("req keys:", JSON.stringify(reqKeys));
    console.log("hasHeaders:", hasHeaders, "proto:", proto, "upgrade:", upgrade);
    ws.close();
  },
});
const server = await app.listen({ port: 0, hostname: "127.0.0.1" });
const port = server.server!.port;
const token = Buffer.from("mykey").toString("base64").replace(/=+$/, "");
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["lamasync-auth", token]);
ws.onopen = () => ws.close();
ws.onerror = () => {};
await new Promise((r) => setTimeout(r, 700));
server.stop();
