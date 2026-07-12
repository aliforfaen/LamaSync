// Server-side WebSocket plugin and in-memory pub/sub for live events.
//
// Subscribers are plain functions, so they can be called from any code path
// (e.g., report.ts after a successful insert). The WebSocket route in
// `wsRoutes` connects a subscription to each new ws connection.

import { Elysia } from "elysia";
import type { ElysiaWS } from "elysia/ws";
import type { WSEvent } from "@lamasync/core";

type Subscriber = (event: WSEvent) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(handler: Subscriber): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}

export function broadcast(event: WSEvent): void {
  for (const handler of subscribers) {
    try {
      handler(event);
    } catch (err) {
      // Never let a misbehaving subscriber break the broadcast loop.
      // eslint-disable-next-line no-console
      console.error("[ws] subscriber threw:", err);
    }
  }
}

function isApiKeyValid(provided: string | undefined): boolean {
  const expected = process.env.LAMASYNC_API_KEY;
  if (!expected) return false;
  return provided === expected;
}

// Per-connection state stored on `ws.data` via a module-level Map keyed by
// the connection id (which is a real ElysiaWS field). This avoids
// `ws.data = ...` assignment that would require a typed Context at the
// route level, and avoids any inline `as` casts.
const connections = new Map<string, () => void>();

function extractApiKey(ws: ElysiaWS): string | undefined {
  // Bun's ServerWebSocket exposes the upgrade request on `raw.request`.
  // Narrow with a runtime guard so the access is actually checked.
  const raw = ws.raw as unknown;
  if (raw && typeof raw === "object" && "request" in raw) {
    const request = (raw as { request?: unknown }).request;
    if (request && typeof request === "object" && "url" in request) {
      const url = (request as { url?: unknown }).url;
      if (typeof url === "string") {
        try {
          return new URL(url, "ws://localhost").searchParams.get("apiKey") ?? undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export const wsRoutes = new Elysia({ prefix: "/api/v1" }).ws("/ws", {
  open(ws) {
    const apiKey = extractApiKey(ws);
    if (!isApiKeyValid(apiKey)) {
      ws.send(JSON.stringify({ kind: "error", error: "unauthorized" }));
      ws.close();
      return;
    }
    const id = ws.id; // `id` is a typed getter on ElysiaWS.
    const unsubscribe = subscribe((event) => {
      try {
        ws.send(JSON.stringify(event));
      } catch {
        // Connection probably closed; let the close handler clean up.
      }
    });
    connections.set(id, unsubscribe);
    ws.send(JSON.stringify({ kind: "hello", ts: Date.now() }));
  },
  close(ws) {
    const unsubscribe = connections.get(ws.id);
    if (unsubscribe) {
      unsubscribe();
      connections.delete(ws.id);
    }
  },
});
