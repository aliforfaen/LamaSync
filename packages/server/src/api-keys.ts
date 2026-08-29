// LAMA-234: managed API-key helpers.
//
// Credential model:
//   - `LAMASYNC_API_KEY` (env) is the `master` credential — never stored in
//     SQLite, resolved only from process env by auth.ts.
//   - Managed keys (`admin` / `device`) live in the `api_keys` table.
//     Authentication compares a SHA-256 of the presented secret against
//     `token_hash` (constant-time); `token_enc` is an AES-256-GCM copy used
//     ONLY by the explicit, audited admin reveal route. New managed keys
//     deliberately fail closed when the secret key is unavailable — the
//     crypto module's legacy plaintext fallback is never used here, because
//     promises the reveal capability that plaintext storage would break.
//
// Token format: `lmsk.<keyId>.<secret>` — the public `keyId` is embedded so
// lookup is a single indexed SELECT by the api_keys.id column instead of a
// scan over every hash. `keyId` is 12 chars from an unambiguous alphabet;
// `secret` is base64url of 32 random bytes (256 bits of entropy). The dot
// separator is safe: neither the keyId alphabet nor base64url contains a
// dot, so a single split always yields exactly three parts.
//
// Never log raw tokens, hashes, or ciphertext from this module.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "./db.ts";
import { encryptSecret, isEncryptedSecret } from "./crypto.ts";
import type { ApiKeyKind, ApiKeySummary } from "@lamasync/core";

const TOKEN_PREFIX = "lmsk";
// Unambiguous alphabet — drops 0/O/1/I/l so a human reading a token from a
// screen can't fat-finger it. 56 chars.
const KEY_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const KEY_ID_LENGTH = 12;
const SECRET_BYTES = 32; // 256 bits of entropy

/** Rate-limit window for last_used_at writes (avoid a SQLite write per heartbeat). */
export const LAST_USED_WRITE_WINDOW_MS = 5 * 60 * 1000;

// ---------- test seam ----------------------------------------------------

let activeDb: Database = defaultDb;

/** Test seam: point this module's DB functions at an in-memory DB. */
export function __setApiKeysDb(next: Database): void {
  activeDb = next;
}

/** Reset to the default singleton; useful after a test run. */
export function __resetApiKeysDb(): void {
  activeDb = defaultDb;
}

// ---------- token generation ---------------------------------------------

/** Random key id: 12 unambiguous chars, used as the row PK and token prefix. */
export function generateKeyId(): string {
  let out = "";
  for (let i = 0; i < KEY_ID_LENGTH; i++) {
    // 5 random bits per char via 1 byte → 6 useful bits; modulo bias is fine
    // for a non-secret identifier read by humans.
    const idx = randomBytes(1)[0]! % KEY_ID_ALPHABET.length;
    out += KEY_ID_ALPHABET.charAt(idx);
  }
  return out;
}

/**
 * Mint a fresh managed-key token. Returns the full token, its embedded key
 * id, and the raw secret (store token_enc for reveal; authenticating uses
 * only the hash of `secret`).
 */
export function generateApiKeyToken(): {
  token: string;
  keyId: string;
  secret: string;
} {
  const keyId = generateKeyId();
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return { token: `${TOKEN_PREFIX}.${keyId}.${secret}`, keyId, secret };
}

/** SHA-256 of a token secret, hex-encoded. The only thing used for auth. */
export function hashTokenSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Short display fingerprint, derived from the token hash (not a secret). */
export function fingerprintFromHash(hash: string): string {
  return hash.slice(0, 10);
}

/** Constant-time comparison of two hex hashes. */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) {
    // Timing-safe even for length mismatch: always compare something.
    return bufA.length === bufB.length && bufA.length > 0 && timingSafeEqual(bufA, bufB);
  }
  return timingSafeEqual(bufA, bufB);
}

/** Split a raw token into `{ keyId, secret }`. Returns null for any malformed input. */
export function parseApiKeyToken(token: string): { keyId: string; secret: string } | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [prefix, keyId, secret] = parts;
  if (prefix !== TOKEN_PREFIX) return null;
  if (keyId.length !== KEY_ID_LENGTH) return null;
  for (const ch of keyId) {
    if (!KEY_ID_ALPHABET.includes(ch)) return null;
  }
  if (typeof secret !== "string" || secret.length < 16) return null;
  return { keyId, secret };
}

// ---------- DB rows -------------------------------------------------------

/** Row shape for api_keys (snake_case as returned by bun:sqlite). */
export interface ApiKeyRow {
  id: string;
  name: string;
  kind: ApiKeyKind;
  host_id: string | null;
  token_hash: string;
  token_enc: string;
  created_at: number;
  last_used_at: number | null;
  revealed_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}

/** True when the row is soft-revoked (future requests must 401). */
export function isApiKeyRowRevoked(row: ApiKeyRow): boolean {
  return row.revoked_at !== null && row.revoked_at > 0;
}

/** Project a row into the wire-safe masked summary (never contains a secret). */
export function apiKeyRowToSummary(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    hostId: row.host_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revealedAt: row.revealed_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    fingerprint: fingerprintFromHash(row.token_hash),
  };
}

/**
 * Create a managed key row. Returns the full token (to hand the caller once)
 * plus the stored row. Throws when the secret key is unavailable so the
 * encrypted copy is never silently downgraded to plaintext.
 */
export function insertManagedApiKey(opts: {
  name: string;
  kind: ApiKeyKind;
  hostId: string | null;
  nowMs?: number;
}): { token: string; row: ApiKeyRow } {
  const { token, keyId } = generateApiKeyToken();
  const parsed = parseApiKeyToken(token)!;
  const hash = hashTokenSecret(parsed.secret);
  const enc = encryptSecret(token);
  if (!isEncryptedSecret(enc)) {
    throw new Error(
      "cannot create a managed API key: the encryption key is unavailable " +
        "(set LAMASYNC_SECRET_KEY or make the data directory writable); " +
        "refusing to store the raw token in plaintext",
    );
  }
  const now = opts.nowMs ?? Date.now();
  const hostId = opts.kind === "device" ? opts.hostId : null;
  if (opts.kind === "device" && typeof hostId !== "string") {
    throw new Error("device API keys require a hostId");
  }
  activeDb.run(
    `INSERT INTO api_keys (id, name, kind, host_id, token_hash, token_enc, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [keyId, opts.name, opts.kind, hostId, hash, enc, now],
  );
  const row = activeDb
    .query<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?")
    .get(keyId)!;
  return { token, row };
}

/**
 * Resolve a raw token to its row, or null when the token is malformed,
 * unknown, or the presented secret does not match (constant-time compare).
 * Does NOT check revocation — callers decide whether a revoked row yields
 * 401 themselves.
 */
export function findApiKeyByToken(token: string): ApiKeyRow | null {
  const parsed = parseApiKeyToken(token);
  if (!parsed) return null;
  const row = activeDb
    .query<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?")
    .get(parsed.keyId);
  if (!row) return null;
  const expected = hashTokenSecret(parsed.secret);
  if (!hashesEqual(expected, row.token_hash)) return null;
  return row;
}

/**
 * Best-effort last_used_at bump, rate-limited to one write per
 * LAST_USED_WRITE_WINDOW_MS per key so a heartbeat storm never becomes a
 * write storm. Failures are swallowed (auth must never break on it).
 */
export function touchApiKeyLastUsed(keyId: string, nowMs?: number): void {
  const now = nowMs ?? Date.now();
  try {
    const row = activeDb
      .query<{ last_used_at: number | null }, [string]>(
        "SELECT last_used_at FROM api_keys WHERE id = ?",
      )
      .get(keyId);
    if (!row) return;
    if (row.last_used_at !== null && now - row.last_used_at < LAST_USED_WRITE_WINDOW_MS) {
      return;
    }
    activeDb.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [now, keyId]);
  } catch {
    // never fail auth on bookkeeping
  }
}