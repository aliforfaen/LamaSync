// LAMA-296: Android-companion mobile routes (phase 1). Nine routes live
// under /api/v1/mobile and each carries Swagger detail. The mobile native
// identity (bearer token) is confined at the auth boundary to /mobile/me +
// /mobile/check-in; cookie web sessions flow through the shared auth plugin
// (which enforces CSRF + exact Origin on their mutations and denies
// non-admin sessions centrally); the enrollment exchange and the web-session
// bootstrap are exact pre-auth exemptions.
//
// Status-code map (pinned in the LAMA-296 spec):
//   400 invalid shape/origin · 401 absent/invalid/revoked authority ·
//   403 valid authority without the required permission · 404 unknown ·
//   409 consumed/revoked enrollment · 410 expired enrollment ·
//   429 throttled · 503 server not configured for the mobile flow.

import { Elysia, t } from "elysia";
import { principalOf, requireAdmin } from "../auth.ts";
import {
  MOBILE_SESSION_COOKIE,
  SESSION_TTL_MS,
  bootstrapMobileWebSession,
  canonicalOrigin,
  createMobileEnrollment,
  exchangeMobileEnrollment,
  findRegistrationByHostId,
  listMobileRegistrations,
  mobileCheckIn,
  mobileEnrollmentStatus,
  mobileMeResponse,
  mobileSessionCookieValue,
  readCookieHeader,
  revokeMobileRegistration,
  revokeMobileWebSession,
  trustedClientAddress,
  mobileExchangeAllowed,
} from "../mobile-store.ts";
import { disconnectMobileRegistration, disconnectWebSession } from "../ws.ts";
import { revokeRegistrationUploads } from "../mobile-uploads.ts";
import type { AuthPrincipal } from "@lamasync/core";

// ---- payload bounds ------------------------------------------------------

const MAX_SECRET_LENGTH = 128; // QR secret / grant / session secret
const MAX_DISPLAY_NAME = 64;
const MAX_APP_VERSION = 32;
const MAX_REASON_LENGTH = 200;

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function isCanonicalHttpsOrigin(): boolean {
  return canonicalOrigin() !== null;
}

/** Resolve a web-session principal's session secret from its own cookie. */
function sessionSecretFromCookie(request: Request): string | null {
  const raw = readCookieHeader(request.headers.get("cookie"), MOBILE_SESSION_COOKIE);
  return raw;
}

function noStore(set: { headers: { "cache-control"?: string } }): void {
  set.headers["cache-control"] = "no-store";
}

/** Set-Cookie value for the session cookie (host-only, never a Domain). */
function sessionCookieHeader(sessionSecret: string, maxAgeSeconds: number): string {
  const attrs = [
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
  return `${mobileSessionCookieValue(sessionSecret)}; ${attrs}`;
}

/** Expired-cookie value that clears the session cookie on logout. */
function clearSessionCookieHeader(): string {
  return `${MOBILE_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function isMobileNative(principal: AuthPrincipal | null): principal is { kind: "mobile"; hostId: string } {
  return principal !== null && principal.kind === "mobile";
}

// ---- route plugin --------------------------------------------------------

export const mobileRoutes = new Elysia({ prefix: "/api/v1" })
  // -----------------------------------------------------------------------
  // Admin enrollment lifecycle
  // -----------------------------------------------------------------------
  .post(
    "/mobile/enrollments",
    ({ request, body, set }) => {
      const admin = requireAdmin({ principal: principalOf(request) });
      if (!admin) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (!isCanonicalHttpsOrigin()) {
        set.status = 503;
        return {
          error:
            "mobile enrollments unavailable: LAMASYNC_ORIGIN must be set to an https:// origin",
        };
      }
      const clientType = body.clientType ?? "android";
      const created = createMobileEnrollment({
        webAdmin: body.webAdmin,
        clientType,
      });
      noStore(set);
      set.status = 201;
      return created.response;
    },
    {
      body: t.Object({
        webAdmin: t.Boolean(),
        clientType: t.Optional(t.Literal("android")),
      }),
      detail: {
        summary:
          "Create a mobile enrollment (admin). Returns the one-time QR secret + validated canonical HTTPS origin; the QR payload is built client-side and never passes through this API again.",
        tags: ["Mobile"],
        responses: {
          201: { description: "Enrollment created; `secret` is returned exactly once (QR)" },
          400: { description: "Invalid body shape" },
          401: { description: "Unauthorized" },
          403: { description: "Not an admin credential" },
          503: { description: "LAMASYNC_ORIGIN not configured" },
        },
      },
    },
  )
  .get(
    "/mobile/enrollments/:id",
    ({ request, params, set }) => {
      const admin = requireAdmin({ principal: principalOf(request) });
      if (!admin) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const status = mobileEnrollmentStatus(params.id);
      if (!status) {
        set.status = 404;
        return { error: "enrollment not found" };
      }
      return status;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary:
          "Read a mobile enrollment's status (admin). Returns pending/used/expired/revoked plus paired-host metadata — never secrets.",
        tags: ["Mobile"],
        responses: {
          200: { description: "Enrollment status (no secrets)" },
          401: { description: "Unauthorized" },
          403: { description: "Not an admin credential" },
          404: { description: "Unknown enrollment id" },
        },
      },
    },
  )
  .get(
    "/mobile/registrations",
    ({ request, set }) => {
      const admin = requireAdmin({ principal: principalOf(request) });
      if (!admin) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      noStore(set);
      return listMobileRegistrations();
    },
    {
      detail: {
        summary:
          "List mobile registrations (admin). Minimal projection — host id, display name, client type/version, pairing instant, last check-in, revocation metadata. No secret hashes, grants, or host config. Most recently paired first; revoked registrations are included for the desktop device list to filter.",
        tags: ["Mobile"],
        responses: {
          200: { description: "Array of MobileRegistrationSummary, newest first" },
          401: { description: "Unauthorized" },
          403: { description: "Not an admin credential" },
        },
      },
    },
  )
  // -----------------------------------------------------------------------
  // Exchange: exact pre-auth exemption (see auth.ts AUTH_EXEMPT_ROUTES)
  // -----------------------------------------------------------------------
  .post(
    "/mobile/enrollments/:id/exchange",
    ({ params, request, body, set }) => {
      // Bound payload lengths before any expensive work; rate-limit both
      // per trusted client address and per enrollment id.
      if (!isCanonicalHttpsOrigin()) {
        set.status = 503;
        return { error: "mobile enrollment exchange unavailable: LAMASYNC_ORIGIN not configured" };
      }
      const secret = boundedString(body.secret, MAX_SECRET_LENGTH);
      const displayName = boundedString(body.displayName, MAX_DISPLAY_NAME);
      const appVersion = boundedString(body.appVersion, MAX_APP_VERSION);
      if (secret === null || displayName === null || appVersion === null) {
        set.status = 400;
        return { error: "invalid exchange payload" };
      }
      const address = trustedClientAddress(request);
      if (!mobileExchangeAllowed(address, params.id)) {
        set.status = 429;
        return { error: "too many exchange attempts; retry shortly" };
      }
      const outcome = exchangeMobileEnrollment({
        enrollmentId: params.id,
        secret,
        displayName,
        appVersion,
      });
      switch (outcome.kind) {
        case "ok":
          noStore(set);
          return outcome.response;
        case "not_found":
          set.status = 404;
          return { error: "enrollment not found" };
        case "used":
          set.status = 409;
          return { error: "enrollment already used" };
        case "revoked":
          set.status = 409;
          return { error: "enrollment revoked" };
        case "expired":
          set.status = 410;
          return { error: "enrollment expired" };
        case "invalid_secret":
          set.status = 401;
          return { error: "invalid enrollment secret" };
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        secret: t.String(),
        displayName: t.String(),
        appVersion: t.String(),
      }),
      detail: {
        summary:
          "Exchange a pending+unexpired mobile enrollment for one installation (no auth — the id + one-time QR secret prove intent). Server-created host id, native token and separate web grant are returned exactly once; the client can never choose a host id or grant level.",
        tags: ["Mobile"],
        // Deliberately auth-exempt (auth.ts AUTH_EXEMPT_ROUTES) — the id +
        // one-time QR secret prove intent, so no bearer security applies.
        security: [],
        responses: {
          200: { description: "Exchange succeeded; nativeToken + webGrant are returned once" },
          400: { description: "Invalid/malformed payload" },
          401: { description: "Invalid enrollment secret" },
          404: { description: "Unknown enrollment id" },
          409: { description: "Enrollment already used or revoked" },
          410: { description: "Enrollment expired" },
          429: { description: "Rate limited (10/min per address, 5/min per enrollment)" },
          503: { description: "LAMASYNC_ORIGIN not configured" },
        },
      },
    },
  )
  // -----------------------------------------------------------------------
  // Web-session bootstrap: exact pre-auth exemption (grant in the body)
  // -----------------------------------------------------------------------
  .post(
    "/mobile/web-session",
    ({ request, body, set }) => {
      // The bootstrap accepts the web grant ONLY in the body. A native
      // token (or any other bearer) is a valid-but-wrong authority → 403.
      const authorization = request.headers.get("authorization") ?? "";
      if (/^Bearer\s+\S+/.test(authorization)) {
        set.status = 403;
        return { error: "web-session bootstrap accepts the web grant in the body only" };
      }
      // Native requests may omit Origin, but a present Origin must match
      // the configured canonical origin (never Host/forwarding headers).
      const origin = request.headers.get("origin");
      const trusted = canonicalOrigin();
      if (trusted === null) {
        set.status = 503;
        return { error: "web-session bootstrap unavailable: LAMASYNC_ORIGIN not configured" };
      }
      if (origin !== null && origin !== trusted) {
        set.status = 400;
        return { error: "cross-origin request rejected" };
      }
      const grant = boundedString(body.grant, MAX_SECRET_LENGTH);
      if (grant === null) {
        set.status = 400;
        return { error: "invalid grant" };
      }
      const outcome = bootstrapMobileWebSession(grant);
      if (outcome.kind === "non_admin_grant") {
        // The desktop flow always requests full admin; a grant without the
        // admin flag must not bootstrap a half-privileged session (LAMA-296
        // review finding 4 — the REST boundary would deny it anyway).
        set.status = 403;
        return { error: "this web grant carries no admin authority" };
      }
      if (outcome.kind !== "ok") {
        set.status = 401;
        return { error: "invalid or revoked web grant" };
      }
      set.headers["set-cookie"] = sessionCookieHeader(
        outcome.sessionSecret,
        Math.floor(SESSION_TTL_MS / 1000),
      );
      noStore(set);
      return outcome.response;
    },
    {
      body: t.Object({ grant: t.String() }),
      detail: {
        summary:
          "Bootstrap a cookie web session from the web grant (body-only, no auth header). Sets the host-only __Host-lamasync-mobile cookie (Secure, HttpOnly, SameSite=Strict, 12 h) and returns the session CSRF token. Native token alone → 403.",
        tags: ["Mobile"],
        // Deliberately auth-exempt (auth.ts AUTH_EXEMPT_ROUTES) — the body
        // web grant proves intent; no bearer security applies.
        security: [],
        responses: {
          200: { description: "Session cookie set; csrfToken returned once" },
          400: { description: "Invalid grant shape or cross-origin request" },
          401: { description: "Invalid/revoked web grant" },
          403: { description: "Bearer presented instead of a body grant, or the web grant carries no admin authority" },
          503: { description: "LAMASYNC_ORIGIN not configured" },
        },
      },
    },
  )
  // -----------------------------------------------------------------------
  // Native identity (mobile bearer only — auth boundary confines)
  // -----------------------------------------------------------------------
  .get(
    "/mobile/me",
    ({ request, set }) => {
      const principal = principalOf(request);
      if (!isMobileNative(principal)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const registration = findRegistrationByHostId(principal.hostId);
      if (!registration) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      noStore(set);
      return mobileMeResponse(principal.hostId, registration);
    },
    {
      detail: {
        summary:
          "Mobile native identity (bearer). Returns the caller's own registration — host id, display name, client type/version, pairing instant, server origin. Never fleet data, backend config, or secrets.",
        tags: ["Mobile"],
        responses: {
          200: { description: "Own registration metadata" },
          401: { description: "Missing/invalid/revoked native token" },
          403: { description: "Not a mobile native credential" },
        },
      },
    },
  )
  .post(
    "/mobile/check-in",
    ({ request, body, set }) => {
      const principal = principalOf(request);
      if (!isMobileNative(principal)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const appVersion = boundedString(body.appVersion, MAX_APP_VERSION);
      if (appVersion === null) {
        set.status = 400;
        return { error: "invalid appVersion" };
      }
      const registration = findRegistrationByHostId(principal.hostId);
      if (!registration) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      noStore(set);
      return mobileCheckIn(principal.hostId, appVersion);
    },
    {
      body: t.Object({ appVersion: t.String() }),
      detail: {
        summary:
          "Mobile native check-in (bearer). Host identity comes from the principal, never from a submitted hostId; updates the registration's own last-seen + app version.",
        tags: ["Mobile"],
        responses: {
          200: { description: "Check-in recorded" },
          400: { description: "Invalid appVersion" },
          401: { description: "Missing/invalid/revoked native token" },
          403: { description: "Not a mobile native credential" },
        },
      },
    },
  )
  // -----------------------------------------------------------------------
  // Admin revocation (kills native + web grant + all web sessions)
  // -----------------------------------------------------------------------
  .post(
    "/mobile/registrations/:hostId/revoke",
    ({ request, params, body, set }) => {
      const admin = requireAdmin({ principal: principalOf(request) });
      if (!admin) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const reason = (() => {
        if (body == null || body.reason === undefined) return null;
        const trimmed = body.reason.trim();
        if (trimmed.length === 0 || trimmed.length > MAX_REASON_LENGTH) return null;
        return trimmed;
      })();
      if (body != null && body.reason !== undefined && reason === null) {
        set.status = 400;
        return { error: "invalid revocation reason" };
      }
      const result = revokeMobileRegistration(params.hostId, reason);
      if (!result.found) {
        set.status = 404;
        return { error: "mobile registration not found" };
      }
      // Stage 1: kill in-flight uploads + revoke destinations so a transfer
      // cannot publish after central revocation (finalize re-checks anyway).
      revokeRegistrationUploads(params.hostId, reason);
      // Close live WebSockets of that registration in-process (its session
      // rows are already revoked, so reconnects are refused too).
      disconnectMobileRegistration(params.hostId);
      noStore(set);
      return { hostId: params.hostId, revokedAt: result.revokedAt };
    },
    {
      params: t.Object({ hostId: t.String() }),
      body: t.Optional(t.Object({ reason: t.Optional(t.String()) })),
      detail: {
        summary:
          "Revoke a mobile registration (admin). Atomically revokes the native credential, its web grant and every web session, marks the producing enrollment revoked, and disconnects live WebSockets. Idempotent.",
        tags: ["Mobile"],
        responses: {
          200: { description: "Registration revoked" },
          400: { description: "Invalid reason" },
          401: { description: "Unauthorized" },
          403: { description: "Not an admin credential" },
          404: { description: "Unknown host id" },
        },
      },
    },
  )
  // -----------------------------------------------------------------------
  // Web-session logout (cookie session, CSRF-protected at the boundary)
  // -----------------------------------------------------------------------
  .post(
    "/mobile/web-session/logout",
    ({ request, set }) => {
      const principal = principalOf(request);
      if (principal === null || principal.kind !== "web-session") {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const secret = sessionSecretFromCookie(request);
      if (secret === null) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
      revokeMobileWebSession(secret);
      // Stop this session's live WebSockets in-process; the native
      // registration + grant stay valid (logout ≠ revoke).
      disconnectWebSession(principal.sessionId);
      set.headers["set-cookie"] = clearSessionCookieHeader();
      noStore(set);
      return { loggedOut: true } as const;
    },
    {
      detail: {
        summary:
          "Log out the current mobile web session (cookie, CSRF-protected). Invalidates that session + clears the cookie; does NOT revoke the native registration or web grant.",
        tags: ["Mobile"],
        responses: {
          200: { description: "Session invalidated + cookie cleared" },
          400: { description: "Missing/wrong Origin (boundary)" },
          401: { description: "No valid session cookie" },
          403: { description: "Missing/wrong CSRF token or not a session principal" },
        },
      },
    },
  );
