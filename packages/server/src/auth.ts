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

// LAMA-234: device-key route allowlist. A device principal may ONLY reach
// the daemon's own control-plane calls (config, self-registration, heartbeat
// + operation reports, its own action queue/completions, its own dotfile
// uploads, conflicts, restic snapshots + restore jobs, release checks).
// Everything else — fleet lists, backends/secrets, key management, admin
// operations — gets 403 at the auth boundary before any route logic runs.
// `*` matches exactly one path segment. The per-route handlers still enforce
// host-ownership on top of this (deviceMayAccessHost / requireAdmin).
const DEVICE_ALLOWED_ROUTES: Array<{ method: string; pattern: string }> = [
  // self-registration + own host detail
  { method: "POST", pattern: "/api/v1/register" },
  { method: "GET", pattern: "/api/v1/hosts/*" },
  // own action queue + work-ack
  { method: "POST", pattern: "/api/v1/hosts/*/actions" },
  { method: "GET", pattern: "/api/v1/hosts/*/actions" },
  { method: "GET", pattern: "/api/v1/actions/pending" },
  { method: "GET", pattern: "/api/v1/actions/taken" },
  { method: "POST", pattern: "/api/v1/actions/*/complete" },
  // heartbeat + operation reports
  { method: "POST", pattern: "/api/v1/report/health" },
  { method: "POST", pattern: "/api/v1/report" },
  // its own config (embeds assignments, pause state, dotfile manifests)
  { method: "GET", pattern: "/api/v1/config/*" },
  // folder operation locks (own host only — enforced in the route)
  { method: "POST", pattern: "/api/v1/operations/acquire" },
  { method: "POST", pattern: "/api/v1/operations/heartbeat" },
  { method: "POST", pattern: "/api/v1/operations/release" },
  { method: "GET", pattern: "/api/v1/operations/locks" },
  // own conflicts
  { method: "GET", pattern: "/api/v1/conflicts" },
  { method: "POST", pattern: "/api/v1/conflicts" },
  { method: "POST", pattern: "/api/v1/conflicts/*/resolve" },
  // restic snapshots + restore jobs scoped to the device's host
  { method: "GET", pattern: "/api/v1/restic/snapshots" },
  { method: "POST", pattern: "/api/v1/restic/snapshots" },
  { method: "GET", pattern: "/api/v1/restic/restore" },
  { method: "POST", pattern: "/api/v1/restic/restore" },
  { method: "POST", pattern: "/api/v1/restic/restore/*/status" },
  // own dotfile uploads + manifest view (upload handler gates host_id)
  { method: "GET", pattern: "/api/v1/dotfiles" },
  { method: "GET", pattern: "/api/v1/dotfiles/manifests" },
  { method: "POST", pattern: "/api/v1/dotfiles/*" },
  // self-update release checks via the server proxy
  { method: "GET", pattern: "/api/v1/release/latest" },
  // health
  { method: "GET", pattern: "/api/v1/health" },
  // LAMA-234: identify the active credential (also lets a device-key-holding
  // browser degrade gracefully instead of 401ing on every admin call).
  { method: "GET", pattern: "/api/v1/auth/me" },
  // LAN-peer assignment mode toggles (mount ⇄ sync, LAMA-238 era)
  { method: "PATCH", pattern: "/api/v1/folders/*/assign/*" },
];

/** Segment-exact wildcard match for the device route allowlist. */
function pathMatchesDevicePattern(pathSegments: string[], pattern: string): boolean {
  const patSegments = pattern.split("/").filter((s) => s.length > 0);
  if (patSegments.length !== pathSegments.length) return false;
  for (let i = 0; i < patSegments.length; i++) {
    if (patSegments[i] !== "*" && patSegments[i] !== pathSegments[i]) return false;
  }
  return true;
}

/** True when a device principal is allowed to reach this route at all. */
export function deviceMayCallRoute(pathname: string, method: string): boolean {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  return DEVICE_ALLOWED_ROUTES.some(
    (r) => r.method === method && pathMatchesDevicePattern(segments, r.pattern),
  );
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
      // LAMA-234: device keys are confined to their own control-plane calls
      // at the auth boundary — everything else is 403 before route logic.
      if (principal.kind === "device" && !deviceMayCallRoute(url.pathname, request.method)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      store.principal = principal;
    });
}

/**
 * Narrow a request store (possibly untyped in route plugins composed via
 * `.use()`) to the auth principal. The single inline cast lives here; route
 * handlers only ever call this and the gates below.
 */
export function principalOf(store: unknown): AuthPrincipal | null {
  if (store === null || typeof store !== "object") return null;
  const raw = (store as { principal?: unknown }).principal;
  if (raw === null || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.kind === "master") return { kind: "master", keyId: null, hostId: null };
  if (rec.kind === "admin" && typeof rec.keyId === "string") {
    return { kind: "admin", keyId: rec.keyId, hostId: null };
  }
  if (rec.kind === "device" && typeof rec.keyId === "string" && typeof rec.hostId === "string") {
    return { kind: "device", keyId: rec.keyId, hostId: rec.hostId };
  }
  return null;
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