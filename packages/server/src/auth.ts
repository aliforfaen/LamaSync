// LAMA-234: authentication resolves each Bearer token ONCE into a typed
// `AuthPrincipal` (master / admin / device) and attaches it to the Elysia
// request store; route helpers gate on it (see `requireAdmin` /
// `deviceMayAccessHost` below).
//
// Credential sources, in order:
//   1. master — the environment `LAMASYNC_API_KEY` (super-admin, matches all
//      existing master-key clients; constant-time compare, never deleted).
//   2. managed `admin` or `device` — looked up via the api_keys table by the
//      token's embedded key id, hash-compared constant-time. Revoked rows
//      resolve to null, so future requests get 401 exactly like a bad key.
//
// The WebSocket upgrade flow is NOT bearer-authenticated here (it uses the
// Sec-WebSocket-Protocol header inside ws.ts, which reuses `resolvePrincipal`).

import { Elysia } from "elysia";
import { timingSafeEqual } from "node:crypto";
import { findApiKeyByToken, isApiKeyRowRevoked, touchApiKeyLastUsed } from "./api-keys.ts";
import type { AuthPrincipal } from "@lamasync/core";

/**
 * Paths under /api/ that are intentionally NOT protected by the bearer
 * check. Each entry is matched as a literal prefix, so order matters only
 * for ties. Today the only exempt path is the pairing-code exchange
 * endpoint — see the comment next to the constant for the design rationale.
 *
 * Add to this list only when (a) the endpoint can be exercised by a caller
 * that does not yet have the bearer key, AND (b) the endpoint proves caller
 * intent another way (the pairing exchange proves intent by knowing the
 * short, single-use code; the WS endpoint proves it via the
 * Sec-WebSocket-Protocol token).
 */
export const AUTH_EXEMPT_PATHS: string[] = [
  "/api/v1/pairing/",
];

/** Constant-time string comparison (length-mismatch safe). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  if (bufA.length === 0) return a === b;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Resolve a raw Bearer token to a typed principal, or null when the token
 * is invalid, unknown, or belongs to a revoked managed key. Revoked keys
 * intentionally collapse to null (→ 401) so callers can't distinguish
 * "bad key" from "revoked key".
 */
export function resolvePrincipal(token: string | null | undefined): AuthPrincipal | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const masterKey = process.env.LAMASYNC_API_KEY ?? "";
  if (masterKey.length > 0 && safeEqual(token, masterKey)) {
    return { kind: "master", keyId: null, hostId: null };
  }
  const row = findApiKeyByToken(token);
  if (!row || isApiKeyRowRevoked(row)) return null;
  if (row.kind === "device") {
    if (typeof row.host_id !== "string" || row.host_id.length === 0) return null;
    touchApiKeyLastUsed(row.id);
    return { kind: "device", keyId: row.id, hostId: row.host_id };
  }
  touchApiKeyLastUsed(row.id);
  return { kind: "admin", keyId: row.id, hostId: null };
}

/** Shape of the principal-carrying store the auth plugin provides. */
export interface AuthStore {
  principal: AuthPrincipal | null;
}

export function getAuthPlugin() {
  const API_KEY = process.env.LAMASYNC_API_KEY;
  if (!API_KEY || API_KEY.length === 0) {
    console.error("FATAL: LAMASYNC_API_KEY environment variable is required");
    process.exit(1);
  }
  return new Elysia({ name: "lamasync-auth" })
    .state("principal", null as AuthPrincipal | null)
    .onRequest(({ request, set, store }) => {
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
      const principal = resolvePrincipal(match?.[1]);
      if (!principal) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      store.principal = principal;
    });
}

/** Current request principal (null only on auth-exempt routes). */
export function currentPrincipal(store: AuthStore): AuthPrincipal | null {
  return store.principal;
}

/**
 * Gate for admin-only routes: non-null when the caller is master or a
 * managed admin key. Route handlers return 403 when this is null (they
 * should never see it null for bearer'd requests; a 401 would have fired).
 */
export function requireAdmin(store: AuthStore): AuthPrincipal | null {
  const p = store.principal;
  if (p && (p.kind === "master" || p.kind === "admin")) return p;
  return null;
}

/**
 * Host-ownership gate for daemon-facing routes. Master and admin keys may
 * act on any host (admin = full management surface). A device key may only
 * act on the host it is bound to. Device keys with a mismatched host are
 * rejected — never trust a client-supplied hostId alone.
 */
export function deviceMayAccessHost(
  principal: AuthPrincipal | null,
  hostId: string | null | undefined,
): boolean {
  if (!principal) return false;
  if (principal.kind === "master" || principal.kind === "admin") return true;
  if (principal.kind === "device" && typeof hostId === "string") {
    return principal.hostId === hostId;
  }
  return false;
}