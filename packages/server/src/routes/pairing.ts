// LAMA-262: pairing-session endpoints for the no-copy-paste registration
// flow. Three routes, all under /api/v1:
//
//   POST   /pairing               (admin)    create a session, get { code, expiresInSeconds }
//   GET    /pairing/:code         (admin)    poll status { status, expiresAt }
//   POST   /pairing/:code/exchange (no auth) exchange a pending+unexpired code
//                                            for the API key. Single-use.
//
// The exchange endpoint is intentionally auth-exempt (see auth.ts
// AUTH_EXEMPT_PATHS) because the device doesn't yet have the API key it
// is asking for — that's the whole point of the flow. The code itself
// is the proof of intent: it's short (lama-XXXX-XXXX), single-use, and
// time-limited. Without the right code the exchange endpoint refuses
// with 404 / 409 / 410 depending on the row state.
//
// Key issuance model (LAMA-234): the exchange now mints a managed `device`
// key bound to the host identity the device submits — it NEVER returns the
// server's `LAMASYNC_API_KEY`. Each paired device gets a unique, revocable
// credential contained to that host. The wire shape (`{ apiKey }`) is
// unchanged so registration clients keep working.

import { Elysia, t } from "elysia";
import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import { insertManagedApiKeyInto } from "../api-keys.ts";
import type {
  PairingSessionCreateResponse,
  PairingSessionExchangeResponse,
  PairingSessionStatusResponse,
  PairingSessionStatus,
} from "@lamasync/core";

const DEFAULT_TTL_SECONDS = 600; // 10 minutes
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 60 * 60; // 1 hour

/** Unambiguous alphabet — drops 0, O, 1, I, L so a human typing from a
 *  screen can't fat-finger a wrong code. 31 chars × 31 chars × 2 = ~30k
 *  combinations before the dash, plenty for a 10-minute window. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

// ---------- test seam ----------------------------------------------------

let activeDb: Database = defaultDb;

/** Test seam: lets unit tests point this module at an in-memory DB. */
export function __setDb(next: Database): void {
  activeDb = next;
}

/** Reset to the default singleton; useful after a test run. */
export function __resetDb(): void {
  activeDb = defaultDb;
}

// ---------- code generation ---------------------------------------------

/** Generate a fresh `lama-XXXX-XXXX` code from the unambiguous alphabet.
 *  Returns null on the astronomically-unlikely case the chosen code is
 *  already taken (the route catches null and retries). */
export function generatePairingCode(): string {
  let body = "";
  for (let i = 0; i < 8; i++) {
    // 5 random bits per char via 1 byte → 6 useful bits; bias is fine
    // because the alphabet excludes only visually-ambiguous chars.
    const idx = randomBytes(1)[0]! % CODE_ALPHABET.length;
    body += CODE_ALPHABET.charAt(idx);
  }
  return `lama-${body.slice(0, 4)}-${body.slice(4, 8)}`;
}

/** Resolve the API key returned by a successful exchange. Today this is
 *  always the server's `LAMASYNC_API_KEY` env value (pre-shared). A
 *  future per-device rotation swaps the implementation here. */
export function issuedDeviceKeyName(hostname: string, hostId: string): string {
  const name = typeof hostname === "string" ? hostname.trim() : "";
  return name.length > 0 ? name : hostId;
}

// ---------- DB row helpers ----------------------------------------------

interface PairingRow {
  id: string;
  code: string;
  status: string;
  expires_at: number;
  created_at: number;
}

function nowMs(): number {
  return Date.now();
}

/** Insert a new pending session row. Returns the row id (uuid-ish) on
 *  success, or null when the generated code collides with an existing
 *  row (the route retries on null — vanishingly rare with 30k codes
 *  per window). The code is normalized to UPPER-case on insert so the
 *  lookup path's `normalizeCode()`-uppercased input always matches a
 *  stored row, regardless of whether the operator types
 *  `lama-XXXX-XXXX` or `LAMA-XXXX-XXXX`. */
export function createSessionRow(
  ttlSeconds: number,
): { id: string; code: string; expiresAt: number } | null {
  const now = nowMs();
  const expiresAt = now + ttlSeconds * 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generatePairingCode().toUpperCase();
    const id = `${code}-${now}-${attempt}`;
    try {
      activeDb.run(
        `INSERT INTO pairing_sessions (id, code, status, expires_at, created_at)
         VALUES (?, ?, 'pending', ?, ?)`,
        [id, code, expiresAt, now],
      );
      return { id, code, expiresAt };
    } catch {
      // UNIQUE collision on `code` — retry.
      continue;
    }
  }
  return null;
}

/** Look up a session by code. Prunes expired pending rows on every read
 *  so the caller observes a current view (a future expiry is invisible
 *  until the next read or the periodic sweep). */
export function findSessionByCode(code: string): PairingRow | null {
  pruneExpiredPending();
  const row = activeDb
    .query<PairingRow, [string]>(
      "SELECT id, code, status, expires_at, created_at FROM pairing_sessions WHERE code = ?",
    )
    .get(code);
  return row ?? null;
}

/** Atomically claim a session: flip pending → used only if the row is
 *  currently pending AND unexpired. SQLite serializes writes inside a
 *  single statement, so two concurrent exchanges can never both flip
 *  the same row — the second returns false. Returns true on success,
 *  false on collision. */
export function claimSessionForExchange(code: string, now: number): boolean {
  const result = activeDb.run(
    `UPDATE pairing_sessions
     SET status = 'used'
     WHERE code = ?
       AND status = 'pending'
       AND expires_at > ?`,
    [code, now],
  );
  return result.changes === 1;
}

/** Resolve the status a caller should see. The DB row may carry
 *  `pending` even after expiry (we never eagerly rewrite — keep the
 *  audit intact) so we project the expiry onto the wire here. */
export function effectiveStatus(row: PairingRow, now: number): PairingSessionStatus {
  if (row.status === "used") return "used";
  if (row.status === "expired") return "expired";
  // pending + past expiry → still `pending` on disk, `expired` on the wire.
  return row.expires_at > now ? "pending" : "expired";
}

/** Belt-and-braces: flip any pending row whose expiry has elapsed to
 *  `expired`. Cheap, idempotent; called on every read so even if the
 *  periodic sweep is skipped (test runs, env override) the table stays
 *  tidy. */
export function pruneExpiredPending(): number {
  const now = nowMs();
  const result = activeDb.run(
    `UPDATE pairing_sessions
     SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= ?`,
    [now],
  );
  return Number(result.changes);
}

/** Lighter periodic sweep: drop expired rows older than the audit
 *  window so the table doesn't grow without bound. Returns the deleted
 *  count for the boot log. */
export function sweepExpiredPairingSessions(
  auditWindowMs: number = 24 * 60 * 60 * 1000,
): number {
  const cutoff = nowMs() - auditWindowMs;
  const result = activeDb.run(
    "DELETE FROM pairing_sessions WHERE status = 'expired' AND expires_at <= ?",
    [cutoff],
  );
  return Number(result.changes);
}

// ---------- validation helpers ------------------------------------------

/** Match the `lama-XXXX-XXXX` shape. Case-insensitive on input — we
 *  uppercase before lookup so a device that types `LAMA-72B4-9PQ1` (or
 *  `lama-72b4-9pq1`) still resolves. The regex uses a case-insensitive
 *  flag so the prefix matches either way. */
export function isValidCodeShape(value: unknown): value is string {
  if (typeof value !== "string") return false;
  // The CODE_ALPHABET excludes 0, O, 1, I, L. Reject any input that uses
  // them so a typo'd code can't reach the DB lookup at all (saves a
  // round trip + keeps the lookup index narrow).
  const upper = value.toUpperCase();
  if (!/^LAMA-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(upper)) return false;
  const body = upper.slice(5).replace("-", "");
  for (const ch of body) {
    if (!CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

function normalizeCode(raw: unknown): string {
  return typeof raw === "string" ? raw.toUpperCase() : "";
}

function clampTtl(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_TTL_SECONDS;
  const rounded = Math.floor(raw);
  if (rounded < MIN_TTL_SECONDS) return MIN_TTL_SECONDS;
  if (rounded > MAX_TTL_SECONDS) return MAX_TTL_SECONDS;
  return rounded;
}

// ---------- route plugin -------------------------------------------------

export const pairingRoutes = new Elysia({ prefix: "/api/v1" })
  .post(
    "/pairing",
    ({ body, set }) => {
      const requestedTtl =
        typeof body === "object" && body !== null && "ttlSeconds" in body
          ? (body as { ttlSeconds?: unknown }).ttlSeconds
          : undefined;
      const ttl = clampTtl(requestedTtl);
      const session = createSessionRow(ttl);
      if (!session) {
        set.status = 503;
        return {
          error:
            "failed to allocate a unique pairing code; retry the request",
        };
      }
      const response: PairingSessionCreateResponse = {
        code: session.code,
        expiresInSeconds: ttl,
      };
      set.status = 201;
      return response;
    },
    {
      body: t.Object({
        ttlSeconds: t.Optional(t.Number()),
      }),
      detail: {
        summary:
          "Create a pairing session (admin). Returns a short human code (lama-XXXX-XXXX) for the device to exchange.",
        tags: ["Pairing"],
        responses: {
          201: { description: "Session created; `code` is what the device operator types" },
          400: { description: "Invalid `ttlSeconds` (clamped to 30..3600)" },
          401: { description: "Unauthorized" },
          503: { description: "Code collision — retry" },
        },
      },
    },
  )
  .get(
    "/pairing/:code",
    ({ params, set }) => {
      const code = normalizeCode(params.code);
      if (!isValidCodeShape(code)) {
        set.status = 400;
        return { error: "invalid pairing code shape; expected lama-XXXX-XXXX" };
      }
      const row = findSessionByCode(code);
      if (!row) {
        set.status = 404;
        return { error: "pairing code not found" };
      }
      const status = effectiveStatus(row, nowMs());
      const response: PairingSessionStatusResponse = {
        status,
        expiresAt: new Date(row.expires_at).toISOString(),
      };
      return response;
    },
    {
      params: t.Object({ code: t.String() }),
      detail: {
        summary:
          "Poll a pairing session's status (admin). Reveals only status + expiry — never the API key.",
        tags: ["Pairing"],
        responses: {
          200: { description: "Status + expiry" },
          400: { description: "Invalid code shape" },
          401: { description: "Unauthorized" },
          404: { description: "Code not found" },
        },
      },
    },
  )
  .post(
    "/pairing/:code/exchange",
    ({ params, body: { hostId, hostname }, set }) => {
      const code = normalizeCode(params.code);
      if (!isValidCodeShape(code)) {
        set.status = 400;
        return { error: "invalid pairing code shape; expected lama-XXXX-XXXX" };
      }
      const safeHostId = hostId.trim();
      if (safeHostId.length === 0) {
        set.status = 400;
        return { error: "hostId is required" };
      }
      // Read first so we can return the right error code per state.
      // The actual claim happens via `claimSessionForExchange` which is
      // atomic in SQL — between these two reads another caller could win
      // the race, and the claim returns false. We map the read result to
      // the error message but the claim is the source of truth.
      const row = findSessionByCode(code);
      if (!row) {
        set.status = 404;
        return { error: "pairing code not found" };
      }
      const now = nowMs();
      if (row.status === "used") {
        set.status = 409;
        return { error: "pairing code already used" };
      }
      if (row.expires_at <= now) {
        // Project expiry onto the wire even if the periodic sweep hasn't
        // rewritten the row yet.
        set.status = 410;
        return { error: "pairing code expired" };
      }
      if (row.status !== "pending") {
        // Future-proofing: any other non-pending state.
        set.status = 409;
        return { error: `pairing code unavailable (status=${row.status})` };
      }
      const claimed = claimSessionForExchange(code, now);
      if (!claimed) {
        // Lost the race to another concurrent exchange (or the periodic
        // sweep flipped it to expired). Re-read to pick the right code.
        const after = findSessionByCode(code);
        if (!after) {
          set.status = 404;
          return { error: "pairing code not found" };
        }
        const effective = effectiveStatus(after, now);
        if (effective === "used") {
          set.status = 409;
          return { error: "pairing code already used" };
        }
        if (effective === "expired") {
          set.status = 410;
          return { error: "pairing code expired" };
        }
        set.status = 409;
        return { error: "pairing code unavailable" };
      }
      let apiKey: string;
      try {
        // LAMA-234: mint a managed device key bound to the submitting
        // host — never the master key. The name echoes the device's
        // hostname so the Admin UI shows readable labels.
        const issued = insertManagedApiKeyInto(activeDb, {
          name: issuedDeviceKeyName(hostname, safeHostId),
          kind: "device",
          hostId: safeHostId,
        });
        apiKey = issued.token;
      } catch (err) {
        // The server is misconfigured (secret key unavailable) — refuse
        // cleanly rather than leaving the code claimed and the device
        // stuck. The row stays `used` (single-use contract holds) so a
        // retry won't help until a fresh code is created.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[pairing] exchange refused: ${msg}`);
        set.status = 503;
        return {
          error:
            "pairing exchange unavailable: could not issue a device key " +
            "(check LAMASYNC_SECRET_KEY / data directory)",
        };
      }
      const response: PairingSessionExchangeResponse = { apiKey };
      set.status = 200;
      return response;
    },
    {
      params: t.Object({ code: t.String() }),
      body: t.Object({
        hostId: t.String(),
        hostname: t.String(),
      }),
      detail: {
        summary:
          "Exchange a pending+unexpired pairing code for a host-bound device API key (single-use). No bearer required — the code itself is the proof of intent. LAMA-234: the returned key is a managed device key bound to the submitted hostId, never the master LAMASYNC_API_KEY.",
        tags: ["Pairing"],
        responses: {
          200: { description: "Exchange succeeded; `apiKey` is the device key to write into client.toml" },
          400: { description: "Invalid code shape or missing hostId/hostname" },
          404: { description: "Code not found" },
          409: { description: "Code already used or otherwise unavailable" },
          410: { description: "Code expired" },
          503: { description: "Server misconfigured (could not issue a device key)" },
        },
      },
    },
  );

/** Re-exported for tests so they can drive the helper directly. */
export const __pairingHelpersForTests = {
  generatePairingCode,
  issuedDeviceKeyName,
  createSessionRow,
  findSessionByCode,
  claimSessionForExchange,
  effectiveStatus,
  pruneExpiredPending,
  sweepExpiredPairingSessions,
  isValidCodeShape,
};
