// LAMA-234 + LAMA-296: authentication resolves each request ONCE into a
// typed `AuthPrincipal` (master / admin / device / deploy / mobile /
// web-session) and makes it available to route handlers through
// `principalOf(request)`.
//
// Request-local identity: Elysia's `store` object is a shared singleton
// across every request (verified empirically: concurrent requests blead
// `store.principal` writes into each other). Principals are therefore kept
// in a module-level WeakMap keyed by the Request object — GC'd with the
// request, never shared, safe under concurrency.
//
// Credential sources, in order of precedence:
//   1. master — the environment `LAMASYNC_API_KEY` (super-admin, matches
//      all existing master-key clients; constant-time compare).
//   2. managed `admin` / `device` / `deploy` — looked up via the api_keys
//      table by the token's embedded key id, hash-compared constant-time.
//      Revoked rows resolve to null → 401. UNKNOWN api-key kinds fail
//      closed (never default to admin).
//   3. mobile NATIVE token — looked up via mobile_registrations by its
//      SHA-256 hash. Confined to /api/v1/mobile/me + check-in.
//   4. mobile WEB session — the `__Host-lamasync-mobile` cookie. Accepted
//      ONLY when no Authorization header is present; an invalid bearer
//      NEVER falls back to the cookie. Cookie mutations additionally
//      require an exact trusted Origin + the session CSRF token.
//
// Pre-auth exemption is exact method+path only (pairing exchange, mobile
// enrollment exchange, mobile web-session bootstrap) — never a broad
// /mobile bypass.
//
// The WebSocket upgrade flow is NOT bearer-authenticated here (ws.ts
// handles its own upgrade auth and reuses `resolvePrincipal` + the live
// session lookup).

import { Elysia } from "elysia";
import { timingSafeEqual } from "node:crypto";
import { findApiKeyByToken, isApiKeyRowRevoked, touchApiKeyLastUsed } from "./api-keys.ts";
import {
  MOBILE_SESSION_COOKIE,
  canonicalOrigin,
  deriveCsrfToken,
  readCookieHeader,
  resolveLiveSession,
  resolveNativeHost,
} from "./mobile-store.ts";
import type { AuthPrincipal } from "@lamasync/core";

/** Constant-time string comparison (length-mismatch safe). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  if (bufA.length === 0) return a === b;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Pre-auth exemptions (exact method + path; `*` = one segment)
// ---------------------------------------------------------------------------

/**
 * Routes under /api/ that are intentionally NOT protected by the bearer /
 * cookie check. Each entry is an exact method+path pattern where `*`
 * matches exactly one path segment. Entries exist only when (a) the caller
 * cannot yet hold the bearer/session (the pairing exchange and the mobile
 * enrollment exchange prove intent with a short single-use secret; the
 * mobile web-session bootstrap proves intent with the web grant in the
 * body), and (b) the route itself re-checks state and rejects invalid
 * calls.
 */
export const AUTH_EXEMPT_ROUTES: ReadonlyArray<{ method: string; pattern: string }> = [
  // Legacy CLI pairing (LAMA-262): device exchanges a short code for a key.
  { method: "POST", pattern: "/api/v1/pairing/*/exchange" },
  // Mobile enrollment exchange (LAMA-296): app exchanges QR id+secret.
  { method: "POST", pattern: "/api/v1/mobile/enrollments/*/exchange" },
  // Mobile web-session bootstrap (LAMA-296): app exchanges web grant for a
  // session cookie. Never a native bearer (native token here → 403 in the
  // route) and never a broad /mobile bypass.
  { method: "POST", pattern: "/api/v1/mobile/web-session" },
];

/** Segment-exact wildcard match shared by the exemption + allowlists. */
function pathMatchesPattern(pathSegments: string[], pattern: string): boolean {
  const patSegments = pattern.split("/").filter((s) => s.length > 0);
  if (patSegments.length !== pathSegments.length) return false;
  for (let i = 0; i < patSegments.length; i++) {
    if (patSegments[i] !== "*" && patSegments[i] !== pathSegments[i]) return false;
  }
  return true;
}

function routeAllowed(
  list: ReadonlyArray<{ method: string; pattern: string }>,
  pathname: string,
  method: string,
): boolean {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  return list.some(
    (r) => r.method === method && pathMatchesPattern(segments, r.pattern),
  );
}

// LAMA-234: device-key route allowlist. A device principal may ONLY reach
// the daemon's own control-plane calls (config, self-registration, heartbeat
// + operation reports, its own action queue/completions, its own dotfile
// uploads, conflicts, restic snapshots + restore jobs, release checks).
// Everything else — fleet lists, backends/secrets, key management, admin
// operations — gets 403 at the auth boundary before any route logic runs.
const DEVICE_ALLOWED_ROUTES: Array<{ method: string; pattern: string }> = [
  // self-registration + own host detail
  { method: "POST", pattern: "/api/v1/register" },
  { method: "GET", pattern: "/api/v1/hosts/*" },
  // own action queue + work-ack
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
  // own app protections + snapshot upload/download (handlers gate host). `*`
  // matches exactly one segment, so the two-segment download path needs its
  // own pattern.
  { method: "GET", pattern: "/api/v1/apps/protections" },
  { method: "GET", pattern: "/api/v1/apps/protections/*" },
  { method: "GET", pattern: "/api/v1/apps/protections/*/snapshots" },
  { method: "POST", pattern: "/api/v1/apps/protections/*/snapshots" },
  { method: "GET", pattern: "/api/v1/apps/snapshots/*" },
  { method: "GET", pattern: "/api/v1/apps/snapshots/*/download" },
  // self-update release checks via the server proxy
  { method: "GET", pattern: "/api/v1/release/latest" },
  // health
  { method: "GET", pattern: "/api/v1/health" },
  // LAMA-234: identify the active credential (also lets a device-key-holding
  // browser degrade gracefully instead of 401ing on every admin call).
  { method: "GET", pattern: "/api/v1/auth/me" },
  // LAN-peer assignment mode toggles (mount ⇄ sync, LAMA-238 era). The
  // route admits device keys only for their bound host and a mode-only body.
  { method: "PATCH", pattern: "/api/v1/folders/*/assign/*" },
];

// LAMA-296: a mobile NATIVE principal may only reach its own identity +
// check-in routes. Fleet admin, config, keys, other hosts, the web-session
// bootstrap — everything else is 403 at the boundary. (Cookie web sessions
// are NOT confined here: an admin web session is the SPA's full management
// surface.)
export const MOBILE_ALLOWED_ROUTES: ReadonlyArray<{ method: string; pattern: string }> = [
  { method: "GET", pattern: "/api/v1/mobile/me" },
  { method: "POST", pattern: "/api/v1/mobile/check-in" },
];

/** True when a device principal is allowed to reach this route at all. */
export function deviceMayCallRoute(pathname: string, method: string): boolean {
  return routeAllowed(DEVICE_ALLOWED_ROUTES, pathname, method);
}

/** True when a mobile native principal is allowed to reach this route. */
export function mobileMayCallRoute(pathname: string, method: string): boolean {
  return routeAllowed(MOBILE_ALLOWED_ROUTES, pathname, method);
}

// ---------------------------------------------------------------------------
// Principal resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a raw Bearer token to a typed principal, or null when the token
 * is invalid, unknown, or revoked. Sources: master env key, managed
 * api_keys (admin/device/deploy), then mobile native credentials. Unknown
 * api-key kinds fail CLOSED (return null) — a future credential kind must
 * be taught here before it can act.
 */
export function resolvePrincipal(token: string | null | undefined): AuthPrincipal | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const masterKey = process.env.LAMASYNC_API_KEY ?? "";
  if (masterKey.length > 0 && safeEqual(token, masterKey)) {
    return { kind: "master", keyId: null, hostId: null };
  }
  const row = findApiKeyByToken(token);
  if (!row || isApiKeyRowRevoked(row)) {
    // Not a managed key (or revoked): try the mobile native credential.
    // A revoked native registration resolves to null → 401, identical to a
    // bad token.
    const hostId = resolveNativeHost(token);
    if (hostId !== null) return { kind: "mobile", hostId };
    return null;
  }
  if (row.kind === "device") {
    if (typeof row.host_id !== "string" || row.host_id.length === 0) return null;
    touchApiKeyLastUsed(row.id);
    return { kind: "device", keyId: row.id, hostId: row.host_id };
  }
  // LAMA-301: deploy keys are their own narrowly-scoped principal — they
  // must NOT collapse into the admin branch, or the deploy agent would be
  // a general admin credential.
  if (row.kind === "deploy") {
    touchApiKeyLastUsed(row.id);
    return { kind: "deploy", keyId: row.id, hostId: null };
  }
  if (row.kind === "admin") {
    touchApiKeyLastUsed(row.id);
    return { kind: "admin", keyId: row.id, hostId: null };
  }
  // Unknown api_keys.kind — fail closed. Never default to admin.
  return null;
}

/**
 * Resolve a live mobile web session from its cookie secret, or null.
 * Re-validates revocation/expiry on every request (and after restarts).
 */
export function resolveCookieSession(
  secret: string,
  nowMs: number = Date.now(),
): AuthPrincipal | null {
  const live = resolveLiveSession(secret, nowMs);
  if (!live) return null;
  const { session, registration } = live;
  return {
    kind: "web-session",
    sessionId: session.id,
    hostId: session.registration_id,
    admin: session.admin === 1,
    csrfToken: deriveCsrfToken(secret),
    expiresAt: session.expires_at,
    displayName: registration.display_name,
    clientType: registration.client_type,
  };
}

// ---------------------------------------------------------------------------
// Request-local principal storage
// ---------------------------------------------------------------------------

/** Per-request principals keyed by the Request object (GC-safe, never shared
 *  across concurrent requests — Elysia's shared store is NOT used). */
const principalByRequest = new WeakMap<Request, AuthPrincipal>();

export function attachPrincipal(request: Request, principal: AuthPrincipal | null): void {
  if (principal === null) principalByRequest.delete(request);
  else principalByRequest.set(request, principal);
}

/**
 * Narrow a value to the request-local principal. Accepts a Request, an
 * Elysia per-request context (`{ request }`), or a `{ principal }` object
 * (unit tests / pure helpers). Unknown shapes and unmapped requests
 * resolve to null — never to admin.
 */
export function principalOf(target: unknown): AuthPrincipal | null {
  if (target === null || typeof target !== "object") return null;
  if (target instanceof Request) {
    return principalByRequest.get(target) ?? null;
  }
  const rec = target as Record<string, unknown>;
  if (rec.request instanceof Request) return principalOf(rec.request);
  if ("principal" in rec) return principalOf(rec.principal);
  return null;
}

/** Current request principal (null only on auth-exempt routes). */
export function currentPrincipal(target: Request | { request: Request }): AuthPrincipal | null {
  return principalOf(target);
}

/** Shape of the principal-carrying object the gates below accept. */
export interface AuthStore {
  principal: AuthPrincipal | null;
}

/**
 * Gate for admin-only routes: non-null when the caller is master, a managed
 * admin key, or an admin web session (LAMA-296 mobile cookie session whose
 * grant carried admin). Route handlers return 403 when null.
 */
export function requireAdmin(store: AuthStore): AuthPrincipal | null {
  const p = store.principal;
  if (!p) return null;
  if (p.kind === "master" || p.kind === "admin") return p;
  if (p.kind === "web-session" && p.admin) return p;
  return null;
}

/**
 * Gate for the LAMA-301 deploy-agent routes: non-null only for a `deploy`
 * principal. Strictly narrower than requireAdmin — master and admin keys
 * can request/read deploy jobs, but only the deploy agent may claim,
 * progress, or complete them.
 */
export function requireDeployAgent(store: AuthStore): AuthPrincipal | null {
  const p = store.principal;
  return p && p.kind === "deploy" ? p : null;
}

/**
 * Composing host-ownership gate for /api/v1/apps routes (LAMA-316): returns
 * the principal when it may access `hostId` (master/admin/web-session any
 * host, device only its bound host), else null. Callers 403 on null.
 */
export function requireHostAccess(
  target: Request | { request: Request },
  hostId: string | null | undefined,
): AuthPrincipal | null {
  const p = principalOf(target);
  return p !== null && deviceMayAccessHost(p, hostId) ? p : null;
}

/**
 * Host-ownership gate for daemon-facing routes. Master and admin keys (and
 * LAMA-296 admin web sessions) may act on any host; a device key may only
 * act on the host it is bound to. A mobile NATIVE principal is never
 * granted host access here. Mismatched hosts are rejected — never trust a
 * client-supplied hostId alone.
 */
export function deviceMayAccessHost(
  principal: AuthPrincipal | null,
  hostId: string | null | undefined,
): boolean {
  if (!principal) return false;
  if (principal.kind === "master" || principal.kind === "admin") return true;
  if (principal.kind === "web-session") return principal.admin && typeof hostId === "string";
  if (principal.kind === "device" && typeof hostId === "string") {
    return principal.hostId === hostId;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Auth plugin (per-request boundary)
// ---------------------------------------------------------------------------

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

export function getAuthPlugin() {
  const API_KEY = process.env.LAMASYNC_API_KEY;
  if (!API_KEY || API_KEY.length === 0) {
    console.error("FATAL: LAMASYNC_API_KEY environment variable is required");
    process.exit(1);
  }
  return new Elysia({ name: "lamasync-auth" }).onRequest(({ request, set }) => {
    // Only enforce on the versioned API surface. WebSocket upgrades
    // authenticate inside the ws route's `open` handler.
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return;
    const upgrade = request.headers.get("upgrade") ?? "";
    if (upgrade.toLowerCase() === "websocket") return;

    // Exact pre-auth exemptions (pairing exchange, mobile exchange,
    // mobile web-session bootstrap) — see AUTH_EXEMPT_ROUTES.
    if (routeAllowed(AUTH_EXEMPT_ROUTES, url.pathname, request.method)) return;

    // LAMA-296: an Authorization header, when present, is authoritative —
    // an invalid bearer is a 401 and NEVER falls back to the session
    // cookie. Web grants are opaque and resolve to null here → 401 on any
    // normal REST call; only the bootstrap route accepts them (in its
    // body, not as a bearer).
    const header = request.headers.get("authorization") ?? "";
    const bearer = /^Bearer\s+(.+)$/.exec(header)?.[1];
    if (bearer !== undefined && bearer !== null) {
      const principal = resolvePrincipal(bearer);
      if (!principal) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      // Confine device + mobile native principals to their allowlists at
      // the boundary before any route logic runs.
      if (principal.kind === "device" && !deviceMayCallRoute(url.pathname, request.method)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (principal.kind === "mobile" && !mobileMayCallRoute(url.pathname, request.method)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      attachPrincipal(request, principal);
      return;
    }

    // No Authorization header: mobile web-session cookie?
    const cookie = readCookieHeader(request.headers.get("cookie"), MOBILE_SESSION_COOKIE);
    if (cookie !== null) {
      const principal = resolveCookieSession(cookie);
      if (!principal || principal.kind !== "web-session") {
        // Stale/revoked/expired cookie — 401, not anonymous.
        set.status = 401;
        return { error: "Unauthorized" };
      }
      if (!isSafeMethod(request.method)) {
        // Cookie-authenticated mutations require the exact trusted Origin
        // AND the session CSRF token. Origin is the configured canonical
        // origin — never Host/forwarding headers.
        const trusted = canonicalOrigin();
        const origin = request.headers.get("origin");
        if (trusted === null || origin === null || origin !== trusted) {
          set.status = 400;
          return { error: "cross-origin request rejected" };
        }
        const csrf = request.headers.get("x-csrf-token");
        if (csrf === null || !safeEqual(csrf, principal.csrfToken)) {
          set.status = 403;
          return { error: "missing or invalid CSRF token" };
        }
      }
      attachPrincipal(request, principal);
      return;
    }

    // Neither bearer nor cookie: non-exempt API routes require auth.
    set.status = 401;
    return { error: "Unauthorized" };
  });
}
