
import { Elysia } from "elysia";
const app = new Elysia().ws("/ws", {
  open(ws, ctx) {
    console.log("ctx keys:", Object.keys(ctx ?? {}));
    console.log("ws keys:", Object.keys(ws));
    // Try ws.data, ws.context, ctx.request, ctx.headers
    console.log("ws.data:", JSON.stringify(ws.data));
    console.log("ctx.request headers proto:", ctx?.request?.headers?.get?.("sec-websocket-protocol"));
    console.log("ctx.headers proto:", ctx?.headers?.get?.("sec-websocket-protocol"));
    if (ctx?.request) console.log("ctx.request keys:", Object.keys(ctx.request));
    if (ctx?.headers) console.log("ctx.headers type:", ctx.headers.constructor?.name);
    if (ws.data && typeof ws.data === "object") console.log("ws.data keys:", Object.keys(ws.data));
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
