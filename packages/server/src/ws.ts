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
      console.error("[ws] subscriber threw:", err);
    }
  }
}

function isApiKeyValid(provided: string | undefined): boolean {
  const expected = process.env.LAMASYNC_API_KEY;
  if (!expected) return false;
  return provided === expected;
}

/**
 * Read a string field from a nested object via a runtime `in` check. The
 * Elysia WS context is typed loosely; we narrow to a plain record and only
 * return the property when the value is actually a string.
 */
function readStringField(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object") return null;
  if (!(key in value)) return null;
  const field = (value as { [k: string]: unknown })[key];
  return typeof field === "string" ? field : null;
}

/**
 * Extract the API key from the upgrade's `Sec-WebSocket-Protocol` header.
 * Elysia exposes the upgrade context on `ws.data`. The header value is the
 * subprotocol list joined by ", " (RFC 6455). The expected layout is
 * `lamasync-auth, <key>` where `<key>` may be either the raw API key or a
 * base64/base64url encoding. Browsers use unpadded base64url because RFC 6455
 * subprotocol tokens cannot contain the `=` padding used by standard base64.
 */
function extractApiKeyFromProtocol(ws: ElysiaWS): string | null {
  const data = ws.data;
  if (data === null || typeof data !== "object") return null;
  if (!("headers" in data)) return null;
  const headers = (data as { headers: unknown }).headers;
  // Headers may be a `Headers` instance, a plain object, or a record of arrays.
  let raw: string | null = null;
  if (headers instanceof Headers) {
    raw = headers.get("sec-websocket-protocol");
  } else if (headers && typeof headers === "object") {
    raw = readStringField(headers, "sec-websocket-protocol");
    if (raw === null) {
      // Case-insensitive fallback for non-standard headers maps.
      for (const key of Object.keys(headers as Record<string, unknown>)) {
        if (key.toLowerCase() === "sec-websocket-protocol") {
          const v = (headers as Record<string, unknown>)[key];
          if (typeof v === "string") {
            raw = v;
            break;
          }
        }
      }
    }
  }
  if (!raw) return null;
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 2 || parts[0] !== "lamasync-auth" || !parts[1]) {
    return null;
  }
  const provided = parts[1];
  if (isApiKeyValid(provided)) return provided;
  try {
    const normalized = provided.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(normalized + padding, "base64").toString("utf8");
    return isApiKeyValid(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Extract the API key from the query string. Retained as a deprecated
 * fallback; callers should prefer the Sec-WebSocket-Protocol header.
 */
function extractApiKeyFromQuery(ws: ElysiaWS): string | null {
  const data = ws.data;
  if (data === null || typeof data !== "object") return null;
  const url = readStringField(data, "url");
  if (url === null) return null;
  try {
    return new URL(url, "ws://localhost").searchParams.get("apiKey");
  } catch {
    return null;
  }
}

function extractApiKey(ws: ElysiaWS): {
  key: string | null;
  source: "protocol" | "query" | null;
} {
  const fromProtocol = extractApiKeyFromProtocol(ws);
  if (fromProtocol !== null) return { key: fromProtocol, source: "protocol" };
  const fromQuery = extractApiKeyFromQuery(ws);
  return { key: fromQuery, source: fromQuery !== null ? "query" : null };
}

// Per-connection state stored on `ws.data` via a module-level Map keyed by
// the connection id (which is a real ElysiaWS field).
const connections = new Map<string, () => void>();

export const wsRoutes = new Elysia({ prefix: "/api/v1" }).ws("/ws", {
  open(ws) {
    const { key: apiKey, source } = extractApiKey(ws);
    if (source === "query") {
      console.warn(
        "[ws] apiKey from query param is deprecated; pass it in Sec-WebSocket-Protocol",
      );
    }
    if (!isApiKeyValid(apiKey ?? undefined)) {
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
