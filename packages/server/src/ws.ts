// Server-side WebSocket plugin and in-memory pub/sub for live events.
//
// Subscribers are plain functions, so they can be called from any code path
// (e.g., report.ts after a successful insert). The WebSocket route in
// `wsRoutes` connects a subscription to each new ws connection.
//
// Upgrade auth (LAMA-234 + LAMA-296):
//   - Bearer subprotocol (`lamasync-auth, <key>`): master or managed admin
//     keys, unchanged legacy contract. No Origin check (bearer clients are
//     not cookie-bound).
//   - Session cookie (`__Host-lamasync-mobile`): requires an EXACT Origin
//     equal to the configured canonical origin AND a live, unrevoked,
//     unexpired admin web session. Live connections are tracked per
//     registration/session so in-process revocation (POST
//     /mobile/registrations/:hostId/revoke) and logout (web-session/logout)
//     disconnect them immediately, and per-connection expiry timers stop
//     delivery at the 12-hour absolute session expiry. A restarted server
//     revalidates stored session/registration state on each reconnect.

import { Elysia } from "elysia";
import type { ElysiaWS } from "elysia/ws";
import type { WSEvent } from "@lamasync/core";
import { resolvePrincipal } from "./auth.ts";
import {
  MOBILE_SESSION_COOKIE,
  canonicalOrigin,
  readCookieHeader,
  resolveLiveSession,
} from "./mobile-store.ts";

// LAMA-234: WebSocket subscriptions require master or a managed admin key.
// Device keys are rejected in v1 — the fleet stream is control-plane data.
export function isWsSubscriptionAllowed(token: string | null | undefined): boolean {
  const principal = resolvePrincipal(token);
  if (!principal) return false;
  return principal.kind === "master" || principal.kind === "admin";
}

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
  return isWsSubscriptionAllowed(provided);
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

/** Headers of the upgrade request (works across Headers/object maps). */
function upgradeHeaders(ws: ElysiaWS): Headers | null {
  const data = ws.data;
  if (data === null || typeof data !== "object") return null;
  if (!("headers" in data)) return null;
  const headers = (data as { headers: unknown }).headers;
  if (headers instanceof Headers) return headers;
  if (headers && typeof headers === "object") {
    const out = new Headers();
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof v === "string") out.set(k, v);
    }
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session connections (cookie upgrades) + live revocation
// ---------------------------------------------------------------------------

interface SessionConnection {
  sessionId: string;
  registrationId: string;
}

/** connId → session linkage for cookie-authenticated connections. */
const sessionConnections = new Map<string, SessionConnection>();
/** registrationId → connIds (for registration revocation). */
const connectionsByRegistration = new Map<string, Set<string>>();
/** sessionId → connIds (for logout/single-session invalidation). */
const connectionsBySession = new Map<string, Set<string>>();

const DEFAULT_CLOSE_REASON = "session no longer valid";

function closeLiveConnection(connId: string, reason: string): void {
  const close = connections.get(connId)?.closeFn;
  if (close) close(reason);
}

/**
 * Disconnect every live WebSocket belonging to a mobile registration
 * (called after an admin revocation commits). The registration's cookie
 * sessions are revoked server-side, so even a reconnect is refused.
 */
export function disconnectMobileRegistration(hostId: string, reason = "registration revoked"): number {
  const connIds = connectionsByRegistration.get(hostId);
  if (!connIds) return 0;
  let count = 0;
  for (const connId of [...connIds]) {
    closeLiveConnection(connId, reason);
    count += 1;
  }
  return count;
}

/**
 * Disconnect every live WebSocket for one web session (logout). The
 * session row is already revoked by the caller.
 */
export function disconnectWebSession(sessionId: string, reason = "session logged out"): number {
  const connIds = connectionsBySession.get(sessionId);
  if (!connIds) return 0;
  let count = 0;
  for (const connId of [...connIds]) {
    closeLiveConnection(connId, reason);
    count += 1;
  }
  return count;
}

/** Test/audit seam: how many live cookie-session connections exist. */
export function liveSessionConnectionCount(): number {
  return sessionConnections.size;
}

// Per-connection state stored on `ws.data` via a module-level Map keyed by
// the connection id (which is a real ElysiaWS field).
interface ConnectionRecord {
  closeFn: (reason: string) => void;
  unsubscribe: () => void;
}

const connections = new Map<string, ConnectionRecord>();

function registerConnection(
  ws: ElysiaWS,
  opts: { session: SessionConnection | null; expiresAt: number | null },
): void {
  const id = ws.id;
  const unsubscribe = subscribe((event) => {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      // Connection probably closed; let the close handler clean up.
    }
  });
  const closeFn = (reason: string): void => {
    try {
      ws.send(JSON.stringify({ kind: "error", error: reason }));
    } catch {
      // already closing
    }
    try {
      ws.close();
    } catch {
      // already closed
    }
  };
  connections.set(id, { closeFn, unsubscribe });
  if (opts.session) {
    sessionConnections.set(id, opts.session);
    let byReg = connectionsByRegistration.get(opts.session.registrationId);
    if (!byReg) {
      byReg = new Set<string>();
      connectionsByRegistration.set(opts.session.registrationId, byReg);
    }
    byReg.add(id);
    let bySess = connectionsBySession.get(opts.session.sessionId);
    if (!bySess) {
      bySess = new Set<string>();
      connectionsBySession.set(opts.session.sessionId, bySess);
    }
    bySess.add(id);
    if (opts.expiresAt !== null && Number.isFinite(opts.expiresAt)) {
      // Stop delivery at the absolute session expiry even if nobody
      // revokes — spec requires expiry to close live connections.
      const delay = Math.max(0, opts.expiresAt - Date.now());
      const timer = setTimeout(() => {
        if (sessionConnections.has(id)) closeFn("session expired");
      }, delay);
      timer.unref?.();
    }
  }
}

function unregisterConnection(ws: ElysiaWS): void {
  const id = ws.id;
  const record = connections.get(id);
  if (record) {
    record.unsubscribe();
    connections.delete(id);
  }
  const session = sessionConnections.get(id);
  if (session) {
    sessionConnections.delete(id);
    const byReg = connectionsByRegistration.get(session.registrationId);
    if (byReg) {
      byReg.delete(id);
      if (byReg.size === 0) connectionsByRegistration.delete(session.registrationId);
    }
    const bySess = connectionsBySession.get(session.sessionId);
    if (bySess) {
      bySess.delete(id);
      if (bySess.size === 0) connectionsBySession.delete(session.sessionId);
    }
  }
}

/** Fail an upgrade cleanly (client-visible close frame before close). */
function rejectUpgrade(ws: ElysiaWS, reason: string): void {
  try {
    ws.send(JSON.stringify({ kind: "error", error: reason }));
    ws.close();
  } catch {
    // already closed
  }
}

export const wsRoutes = new Elysia({ prefix: "/api/v1" }).ws("/ws", {
  open(ws) {
    // 1. Legacy bearer subprotocol (master/admin keys) — unchanged.
    const { key: apiKey, source } = extractApiKey(ws);
    if (source === "query") {
      console.warn(
        "[ws] apiKey from query param is deprecated; pass it in Sec-WebSocket-Protocol",
      );
    }
    if (apiKey !== null) {
      if (!isApiKeyValid(apiKey)) {
        rejectUpgrade(ws, "unauthorized");
        return;
      }
      registerConnection(ws, { session: null, expiresAt: null });
      ws.send(JSON.stringify({ kind: "hello", ts: Date.now() }));
      return;
    }

    // 2. Mobile web-session cookie upgrade: exact Origin + live admin session.
    const headers = upgradeHeaders(ws);
    const cookie = headers ? readCookieHeader(headers.get("cookie"), MOBILE_SESSION_COOKIE) : null;
    if (cookie === null) {
      rejectUpgrade(ws, "unauthorized");
      return;
    }
    const trusted = canonicalOrigin();
    const origin = headers?.get("origin") ?? null;
    if (trusted === null || origin !== trusted) {
      rejectUpgrade(ws, "origin not allowed");
      return;
    }
    const live = resolveLiveSession(cookie);
    if (!live) {
      rejectUpgrade(ws, "unauthorized");
      return;
    }
    if (live.session.admin !== 1) {
      // Non-admin sessions get no fleet stream (there is no phase-1 SPA
      // surface for them).
      rejectUpgrade(ws, "forbidden");
      return;
    }
    registerConnection(ws, {
      session: { sessionId: live.session.id, registrationId: live.session.registration_id },
      expiresAt: live.session.expires_at,
    });
    ws.send(JSON.stringify({ kind: "hello", ts: Date.now() }));
  },
  close(ws) {
    unregisterConnection(ws);
  },
});
