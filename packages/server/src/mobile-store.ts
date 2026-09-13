// LAMA-296: persistence + credential helpers for the Android-companion
// mobile flow. All secrets (QR secret, native token, web grant, session
// secret) are cryptographically random, returned to the caller exactly
// once, and persisted ONLY as SHA-256 hex hashes — nothing in this module
// ever stores or logs a plaintext secret, and there is no reveal path.
//
// Tables live in core (SERVER_SCHEMA + MIGRATIONS — see
// packages/core/src/db/schema.ts). All reads/writes go through the module's
// active database (production singleton, or the in-memory test seam via
// __setMobileStoreDb), so unit/integration tests and the auth plugin see
// one consistent handle.
//
// Trust anchor: the configured canonical origin (env `LAMASYNC_ORIGIN`,
// e.g. `https://fleet.example.com`). It is NEVER derived from Host or
// forwarding headers. The mobile flow requires HTTPS; the origin parser
// rejects non-HTTPS and any origin carrying a path/query/fragment.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "./db.ts";
import type {
  MobileCheckInResponse,
  MobileClientType,
  MobileEnrollmentCreateResponse,
  MobileEnrollmentExchangeResponse,
  MobileEnrollmentKind,
  MobileEnrollmentStatusResponse,
  MobileMeResponse,
  MobileRegistrationSummary,
  MobileWebSessionBootstrapResponse,
} from "@lamasync/core";

// ---------------------------------------------------------------------------
// Secrets + hashing
// ---------------------------------------------------------------------------

const SECRET_BYTES = 32; // 256 bits of entropy per secret

/** SHA-256 hex digest of a secret — the ONLY thing stored server-side. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time compare of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Fresh opaque secret (base64url, 43 chars for 32 bytes). */
export function generateOpaqueSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

/** Public random id for enrollments/sessions/grants (unambiguous alphabet). */
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const ID_LENGTH = 12;

export function generatePublicId(): string {
  let out = "";
  for (let i = 0; i < ID_LENGTH; i++) {
    const idx = randomBytes(1)[0]! % ID_ALPHABET.length;
    out += ID_ALPHABET.charAt(idx);
  }
  return out;
}

/** Host id for a mobile registration. Chosen by the SERVER (never the
 *  client); `mob-` prefix keeps mobile hosts identifiable in audit rows. */
export function generateMobileHostId(): string {
  return `mob-${generatePublicId().toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Canonical origin (trust anchor)
// ---------------------------------------------------------------------------

/** Normalize + validate the configured canonical origin, or null when
 *  unset/invalid. Must be bare `https://host[:port]` — no path/query/fragment. */
export function canonicalOrigin(): string | null {
  const raw = process.env.LAMASYNC_ORIGIN?.trim() ?? "";
  if (raw.length === 0) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    if (url.search !== "" || url.hash !== "") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Server-origin string reported to mobile clients (enrollment create +
 *  exchange + /mobile/me). Throws when the origin is not configured — the
 *  caller maps that to a clean 503. */
export function requiredServerOrigin(): string {
  const origin = canonicalOrigin();
  if (origin === null) {
    throw new Error("LAMASYNC_ORIGIN is not configured (https://… required for the mobile flow)");
  }
  return origin;
}

// ---------------------------------------------------------------------------
// Rate limiting (exchange abuse protection)
// ---------------------------------------------------------------------------

/** 10 exchange attempts/min per trusted client address. */
export const EXCHANGE_ADDRESS_LIMIT = 10;
/** 5 exchange attempts/min per enrollment id. */
export const EXCHANGE_ENROLLMENT_LIMIT = 5;
const EXCHANGE_WINDOW_MS = 60_000;

/**
 * Expired-entry sweep cadence: every N limit checks, untouched buckets
 * whose window elapsed are dropped from BOTH maps. This bounds memory
 * without a timer or an O(n) pass per request — and, unlike the old
 * same-key-reuse reset, prunes arbitrary historical enrollment ids that
 * are never seen again.
 */
export const RATE_LIMIT_PRUNE_EVERY = 64;
/** Hard cardinality cap per map: oldest-window buckets are evicted past
 *  this, so even a flood of distinct addresses/enrollment ids can never
 *  grow the maps without bound. */
export const RATE_LIMIT_MAX_ENTRIES = 512;

interface RateBucket {
  windowStart: number;
  count: number;
}

let limiterNow: () => number = () => Date.now();
const addressBuckets = new Map<string, RateBucket>();
const enrollmentBuckets = new Map<string, RateBucket>();
let pruneCounter = 0;

/** Test seam: inject a clock so limit expiry is testable without sleeping. */
export function __setMobileRateLimitClock(fn: () => number): void {
  limiterNow = fn;
}

/** Test seam: drop all buckets (between tests). */
export function __resetMobileRateLimits(): void {
  addressBuckets.clear();
  enrollmentBuckets.clear();
  pruneCounter = 0;
}

/** Test seam: current bucket cardinality (bounded-eviction assertions). */
export function __mobileRateLimitSize(): { address: number; enrollment: number } {
  return { address: addressBuckets.size, enrollment: enrollmentBuckets.size };
}

/** Drop buckets whose window has fully elapsed (never reused keys). */
function dropExpired(buckets: Map<string, RateBucket>, now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= EXCHANGE_WINDOW_MS) buckets.delete(key);
  }
}

/** Evict the oldest-window buckets while a map exceeds the hard cap. */
function enforceBucketCap(buckets: Map<string, RateBucket>): void {
  if (buckets.size <= RATE_LIMIT_MAX_ENTRIES) return;
  const byAge = [...buckets.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
  const overflow = buckets.size - RATE_LIMIT_MAX_ENTRIES;
  for (const [key] of byAge.slice(0, overflow)) buckets.delete(key);
}

function bump(buckets: Map<string, RateBucket>, key: string, limit: number, now: number): boolean {
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart >= EXCHANGE_WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (existing.count >= limit) return false;
  existing.count += 1;
  return true;
}

/**
 * Enforce both exchange limits for one attempt. Returns true when the
 * attempt is allowed; false → the caller must 429. Memory is bounded: on a
 * cadence, untouched expired buckets are swept from both maps, and after
 * every check each map is capped at RATE_LIMIT_MAX_ENTRIES (oldest-window
 * buckets evicted) so arbitrary historical keys can never accumulate
 * without bound.
 */
export function mobileExchangeAllowed(clientAddress: string, enrollmentId: string): boolean {
  const now = limiterNow();
  pruneCounter = (pruneCounter + 1) % RATE_LIMIT_PRUNE_EVERY;
  if (pruneCounter === 0) {
    dropExpired(addressBuckets, now);
    dropExpired(enrollmentBuckets, now);
  }
  const allowed = bump(addressBuckets, `addr:${clientAddress}`, EXCHANGE_ADDRESS_LIMIT, now);
  if (allowed) {
    const enrollmentAllowed = bump(enrollmentBuckets, `enr:${enrollmentId}`, EXCHANGE_ENROLLMENT_LIMIT, now);
    if (!enrollmentAllowed) {
      // The enrollment limit refused; refund the address attempt so a busy
      // shared enrollment id cannot burn unrelated clients' address budgets.
      const bucket = addressBuckets.get(`addr:${clientAddress}`);
      if (bucket) bucket.count = Math.max(0, bucket.count - 1);
    }
    enforceBucketCap(addressBuckets);
    enforceBucketCap(enrollmentBuckets);
    return enrollmentAllowed;
  }
  enforceBucketCap(addressBuckets);
  return false;
}

// ---------------------------------------------------------------------------
// Active-db seam (mirrors api-keys.ts / pairing.ts conventions)
// ---------------------------------------------------------------------------

// Deferred on purpose: reading `defaultDb` at module init can hit a TDZ when
// bun test's shared graph evaluates this module while db.ts is still
// initializing (db.ts eagerly calls getDb() at module scope). Resolve the
// handle lazily on first use instead.
let activeDb: Database | null = null;

function currentDb(): Database {
  return activeDb ?? defaultDb;
}

/** Test seam: point this module's DB functions at an in-memory DB. */
export function __setMobileStoreDb(next: Database): void {
  activeDb = next;
}

/** Reset to the default singleton; useful after a test run. */
export function __resetMobileStoreDb(): void {
  activeDb = null;
}

/** The database handle this module reads/writes (production or seam). */
export function mobileDb(): Database {
  return currentDb();
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface MobileEnrollmentRow {
  id: string;
  secret_hash: string;
  host_id: string;
  kind: MobileEnrollmentKind;
  client_type: MobileClientType;
  web_admin: number;
  status: string;
  expires_at: number;
  created_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
}

export interface MobileRegistrationRow {
  host_id: string;
  client_type: MobileClientType;
  display_name: string;
  app_version: string;
  native_token_hash: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}

export interface WebGrantRow {
  id: string;
  grant_hash: string;
  registration_id: string;
  admin: number;
  created_at: number;
  revoked_at: number | null;
  revoked_reason: string | null;
}

export interface WebSessionRow {
  id: string;
  session_hash: string;
  registration_id: string;
  grant_id: string;
  admin: number;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export function isRowRevoked(row: { revoked_at: number | null }): boolean {
  return row.revoked_at !== null && row.revoked_at > 0;
}

/** Seconds → ms; enrollment TTL. */
export const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
/** Web-session absolute lifetime. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** LAMA-337: audit reason stamped on the web grant a reconnect supersedes. */
export const RECONNECT_ROTATED_REASON = "credentials rotated by reconnect";

// ---------------------------------------------------------------------------
// Enrollment lifecycle
// ---------------------------------------------------------------------------

export interface CreatedEnrollment {
  enrollmentId: string;
  secret: string;
  response: MobileEnrollmentCreateResponse;
}

/**
 * Create one pending enrollment for a BRAND-NEW installation (admin).
 * Atomically revokes every other still-pending new-installation enrollment
 * (QR regeneration semantics — an old unscanned pairing QR dies the moment a
 * new one is shown). Pending RECONNECT QRs are deliberately left alone: they
 * belong to another (possibly offline) device and re-pairing a different
 * phone must not silently void them. Returns the response with the one-time
 * QR secret. Throws when the canonical origin is unconfigured.
 */
export function createMobileEnrollment(opts: {
  webAdmin: boolean;
  clientType: MobileClientType;
  nowMs?: number;
}): CreatedEnrollment {
  const now = opts.nowMs ?? Date.now();
  const origin = requiredServerOrigin();
  const d = currentDb();
  const create = d.transaction(() => {
    const enrollmentId = generatePublicId();
    const hostId = generateMobileHostId();
    const secret = generateOpaqueSecret();
    insertEnrollmentRow(d, {
      id: enrollmentId,
      secretHash: hashSecret(secret),
      hostId,
      kind: "new",
      clientType: opts.clientType,
      webAdmin: opts.webAdmin,
      nowMs: now,
    });
    revokeOtherPendingNewEnrollments(d, enrollmentId, now);
    return { enrollmentId, secret };
  });
  const { enrollmentId, secret } = create();
  const expiresAt = now + ENROLLMENT_TTL_MS;
  return {
    enrollmentId,
    secret,
    response: {
      enrollmentId,
      secret,
      serverOrigin: origin,
      clientType: opts.clientType,
      webAdmin: opts.webAdmin,
      expiresAt,
      expiresInSeconds: Math.floor(ENROLLMENT_TTL_MS / 1000),
    },
  };
}

export type ReconnectCreateOutcome =
  | { kind: "ok"; created: CreatedEnrollment }
  | { kind: "not_found" }
  | { kind: "revoked" }
  /** The registration's web authority cannot be resolved from its stored
   *  grants (none live, or more than one live row). Fail closed: issuing a QR
   *  here would invent an authority, so nothing is created. */
  | { kind: "authority_unresolved"; liveGrants: number };

/**
 * LAMA-337: create a one-time RECONNECT enrollment for an EXISTING live
 * registration (admin). The returned QR uses the unchanged
 * `lamasync.android.enroll` v1 payload, but its exchange rotates credentials
 * for `hostId` instead of creating a host — so the device keeps its identity,
 * upload inboxes and upload history.
 *
 * Nothing about the working device changes here: the native token, web grant
 * and sessions stay valid until a phone actually exchanges the QR, so an
 * abandoned or expired reconnect QR has no effect at all. Only other pending
 * RECONNECT QRs for the SAME host are superseded (the QR-regeneration rule,
 * scoped to the device it belongs to).
 *
 * The fresh web grant preserves the registration's CURRENT LIVE grant
 * authority (see resolveReconnectAuthority): a reconnect restores what the
 * device has, it never mints more. A registration whose live grant cannot be
 * resolved unambiguously is refused rather than guessed at. Throws when the
 * canonical origin is unconfigured.
 *
 * The QR itself is created in one transaction that re-checks both the target's
 * liveness and its authority, so a revoke or a concurrent rotation between the
 * first read and the insert leaves no QR behind.
 */
export function createReconnectEnrollment(opts: {
  hostId: string;
  nowMs?: number;
}): ReconnectCreateOutcome {
  const now = opts.nowMs ?? Date.now();
  const origin = requiredServerOrigin();
  const d = currentDb();
  const registration = findRegistrationByHostId(opts.hostId);
  if (!registration) return { kind: "not_found" };
  if (isRowRevoked(registration)) return { kind: "revoked" };
  const authority = resolveReconnectAuthority(d, opts.hostId);
  if (authority.kind === "unresolved") {
    return { kind: "authority_unresolved", liveGrants: authority.liveGrants };
  }
  const create = d.transaction(() => {
    // Re-check inside the transaction: the admin may have revoked the device —
    // or another rotation may have replaced its grant — between the read above
    // and this insert. Rolling back leaves no QR behind.
    const live = findRegistrationByHostId(opts.hostId);
    if (!live || isRowRevoked(live)) throw new ReconnectTargetLost();
    const current = resolveReconnectAuthority(d, opts.hostId);
    if (current.kind === "unresolved") throw new ReconnectAuthorityLost(current.liveGrants);
    const enrollmentId = generatePublicId();
    const secret = generateOpaqueSecret();
    insertEnrollmentRow(d, {
      id: enrollmentId,
      secretHash: hashSecret(secret),
      hostId: opts.hostId,
      kind: "reconnect",
      clientType: live.client_type,
      webAdmin: current.webAdmin,
      nowMs: now,
    });
    revokeOtherPendingReconnectsForHost(d, opts.hostId, enrollmentId, now);
    return { enrollmentId, secret, webAdmin: current.webAdmin };
  });
  let enrollmentId: string;
  let secret: string;
  let webAdmin: boolean;
  try {
    ({ enrollmentId, secret, webAdmin } = create());
  } catch (err) {
    if (err instanceof ReconnectTargetLost) return { kind: "revoked" };
    if (err instanceof ReconnectAuthorityLost) {
      return { kind: "authority_unresolved", liveGrants: err.liveGrants };
    }
    throw err;
  }
  const expiresAt = now + ENROLLMENT_TTL_MS;
  return {
    kind: "ok",
    created: {
      enrollmentId,
      secret,
      response: {
        enrollmentId,
        secret,
        serverOrigin: origin,
        clientType: registration.client_type,
        webAdmin,
        expiresAt,
        expiresInSeconds: Math.floor(ENROLLMENT_TTL_MS / 1000),
      },
    },
  };
}

type ReconnectAuthority =
  | { kind: "ok"; webAdmin: boolean }
  | { kind: "unresolved"; liveGrants: number };

/**
 * Resolve the authority a reconnect may restore: the registration's single
 * LIVE web grant (`revoked_at IS NULL`; 0 counts as live everywhere else in
 * this module, so it is treated as live here too and lands in the ambiguous
 * branch rather than being silently ignored). Exactly one live grant is the
 * invariant the enrollment exchange maintains and
 * `idx_web_grants_live_registration` enforces; anything else means the stored
 * state is damaged, and the caller must refuse instead of inventing an
 * authority.
 */
function resolveReconnectAuthority(d: Database, hostId: string): ReconnectAuthority {
  const live = d
    .query<{ admin: number }, [string]>(
      `SELECT admin FROM web_grants
        WHERE registration_id = ? AND (revoked_at IS NULL OR revoked_at = 0)
        ORDER BY created_at DESC, id DESC`,
    )
    .all(hostId);
  const only = live.length === 1 ? live[0] : undefined;
  if (!only) return { kind: "unresolved", liveGrants: live.length };
  return { kind: "ok", webAdmin: only.admin === 1 };
}

function insertEnrollmentRow(
  d: Database,
  row: {
    id: string;
    secretHash: string;
    hostId: string;
    kind: MobileEnrollmentKind;
    clientType: MobileClientType;
    webAdmin: boolean;
    nowMs: number;
  },
): void {
  d.run(
    `INSERT INTO mobile_enrollments
       (id, secret_hash, host_id, kind, client_type, web_admin, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      row.id,
      row.secretHash,
      row.hostId,
      row.kind,
      row.clientType,
      row.webAdmin ? 1 : 0,
      row.nowMs + ENROLLMENT_TTL_MS,
      row.nowMs,
    ],
  );
}

/** Flip every OTHER pending new-installation QR to revoked (caller owns tx). */
function revokeOtherPendingNewEnrollments(d: Database, keepId: string, nowMs: number): void {
  d.run(
    `UPDATE mobile_enrollments
        SET status = 'revoked', revoked_at = ?
      WHERE id != ? AND status = 'pending' AND kind = 'new'`,
    [nowMs, keepId],
  );
}

/** Flip every OTHER pending reconnect QR OF THIS HOST to revoked (caller owns
 *  tx). Scoped by host so showing a reconnect QR for one device never voids
 *  a pending QR for another. */
function revokeOtherPendingReconnectsForHost(
  d: Database,
  hostId: string,
  keepId: string,
  nowMs: number,
): void {
  d.run(
    `UPDATE mobile_enrollments
        SET status = 'revoked', revoked_at = ?
      WHERE id != ? AND host_id = ? AND status = 'pending' AND kind = 'reconnect'`,
    [nowMs, keepId, hostId],
  );
}

/** Status with expiry projected onto the wire (never eagerly rewritten). */
export function enrollmentStatusOf(
  row: MobileEnrollmentRow,
  nowMs: number,
): "pending" | "used" | "expired" | "revoked" {
  if (row.status === "pending" && row.expires_at <= nowMs) return "expired";
  return row.status as "pending" | "used" | "expired" | "revoked";
}

/** Admin status read. Returns null for an unknown id. Never reveals secrets. */
export function mobileEnrollmentStatus(
  enrollmentId: string,
  nowMs?: number,
): MobileEnrollmentStatusResponse | null {
  const now = nowMs ?? Date.now();
  const row = currentDb()
    .query<MobileEnrollmentRow, [string]>(
      "SELECT * FROM mobile_enrollments WHERE id = ?",
    )
    .get(enrollmentId);
  if (!row) return null;
  const status = enrollmentStatusOf(row, now);
  let host: MobileEnrollmentStatusResponse["host"] = null;
  if (status !== "pending" && status !== "expired") {
    const registration = findRegistrationByHostId(row.host_id);
    if (registration) {
      host = {
        hostId: registration.host_id,
        displayName: registration.display_name,
        clientType: registration.client_type,
        appVersion: registration.app_version,
        createdAt: registration.created_at,
        lastSeenAt: registration.last_seen_at,
        revokedAt: registration.revoked_at,
      };
    }
  }
  return { enrollmentId: row.id, status, expiresAt: row.expires_at, host };
}

// ---------------------------------------------------------------------------
// Exchange (transactional single-use issuance)
// ---------------------------------------------------------------------------

export type ExchangeOutcome =
  | {
      kind: "ok";
      response: MobileEnrollmentExchangeResponse;
      hostId: string;
      /**
       * True when this exchange ROTATED an existing registration's
       * credentials (a reconnect QR) rather than installing a new device.
       *
       * The route keys its post-commit socket sweep on THIS flag, never on
       * the session list: a rotation invalidates every credential of the
       * registration, and a live socket can outlive its web_sessions row, so
       * inferring "was this a reconnect?" from revokedSessionIds would leave
       * sockets streaming under a rotated credential.
       */
      rotated: boolean;
      /** Web sessions the rotation revoked (empty for a new install, and
       *  legitimately empty for a reconnect whose device never bootstrapped a
       *  cookie session). Used for the per-session close + tests, never to
       *  decide whether the registration must be swept. */
      revokedSessionIds: string[];
    }
  | { kind: "not_found" }
  | { kind: "used" }
  | { kind: "expired" }
  | { kind: "revoked" }
  | { kind: "invalid_secret" }
  /** LAMA-337: a reconnect QR whose target registration is gone or revoked. */
  | { kind: "target_unavailable" };

/**
 * Atomically exchange a pending+unexpired enrollment for one installation:
 * claims the enrollment (single-use), inserts the host row, the mobile
 * registration, and the web grant in ONE transaction, minting the native
 * token + web grant. Concurrent exchanges: at most one wins the claim.
 * Failure inside the transaction rolls back — the enrollment stays pending
 * and a retry is possible. A lost success response leaves the enrollment
 * consumed (fail-safe; the desktop regenerates a fresh QR).
 *
 * LAMA-337: a `reconnect` enrollment takes the other branch — it rotates the
 * credentials of the EXISTING registration named by the row's host_id instead
 * of creating a host, so the device keeps its identity, destinations and
 * upload history. Both branches are one transaction: claim, credential
 * rotation/issuance, and revocation of the superseded authorities commit
 * together or not at all.
 *
 * No plaintext secret is retained: only hashes are persisted and the two
 * fresh secrets are returned exactly once.
 */
export function exchangeMobileEnrollment(opts: {
  enrollmentId: string;
  secret: string;
  displayName: string;
  appVersion: string;
  nowMs?: number;
}): ExchangeOutcome {
  const now = opts.nowMs ?? Date.now();
  const d = currentDb();
  const row = d
    .query<MobileEnrollmentRow, [string]>(
      "SELECT * FROM mobile_enrollments WHERE id = ?",
    )
    .get(opts.enrollmentId);
  if (!row) return { kind: "not_found" };
  const status = enrollmentStatusOf(row, now);
  if (status === "used") return { kind: "used" };
  if (status === "expired") return { kind: "expired" };
  if (status === "revoked") return { kind: "revoked" };
  if (!hashesEqual(hashSecret(opts.secret), row.secret_hash)) {
    return { kind: "invalid_secret" };
  }
  if (row.kind === "reconnect") return exchangeReconnectEnrollment(d, row, now, opts);
  return exchangeNewEnrollment(d, row, now, opts);
}

/** New-installation branch: mint a fresh host + registration + web grant. */
function exchangeNewEnrollment(
  d: Database,
  row: MobileEnrollmentRow,
  now: number,
  opts: { enrollmentId: string; displayName: string; appVersion: string },
): ExchangeOutcome {
  const nativeToken = generateOpaqueSecret();
  const webGrant = generateOpaqueSecret();
  const grantId = generatePublicId();
  const registrationId = row.host_id;
  const origin = requiredServerOrigin();

  const exchange = d.transaction(() => {
    // Single-use gate: flip pending→used only while still pending AND
    // unexpired. The transaction begins before the claim, so a concurrent
    // exchange cannot interleave between the gate and the inserts.
    claimPendingEnrollment(d, opts.enrollmentId, now);
    // Fresh host id was chosen at enrollment creation, so the row insert
    // cannot collide with another host unless the enrollment was tampered
    // with — in which case we roll back.
    d.run(
      `INSERT INTO hosts (id, hostname, last_seen, status, host_class)
       VALUES (?, ?, ?, 'online', 'phone')`,
      [registrationId, opts.displayName, now],
    );
    d.run(
      `INSERT INTO mobile_registrations
         (host_id, client_type, display_name, app_version, native_token_hash, created_at)
       VALUES (?, 'android', ?, ?, ?, ?)`,
      [registrationId, opts.displayName, opts.appVersion, hashSecret(nativeToken), now],
    );
    d.run(
      `INSERT INTO web_grants (id, grant_hash, registration_id, admin, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [grantId, hashSecret(webGrant), registrationId, row.web_admin === 1 ? 1 : 0, now],
    );
  });
  const failed = runExchange(exchange, d, opts.enrollmentId, now);
  if (failed) return failed;
  const response: MobileEnrollmentExchangeResponse = {
    hostId: registrationId,
    nativeToken,
    webGrant,
    serverOrigin: origin,
    displayName: opts.displayName,
    clientType: "android",
  };
  return { kind: "ok", response, hostId: registrationId, rotated: false, revokedSessionIds: [] };
}

/**
 * LAMA-337 reconnect branch: rotate the existing registration's credentials.
 *
 * In ONE transaction: claim the QR (pending→used), rotate native_token_hash,
 * refresh display name/app version/last-seen (+ the host's heartbeat), revoke
 * the previous web grant and every web session of that registration, and
 * issue a fresh web grant. `mobile_registrations.created_at`, the
 * registration row itself, its destinations and its upload history are all
 * untouched — that is the whole point of reconnecting instead of re-pairing.
 *
 * The target registration is re-checked inside the transaction (it can be
 * revoked between the QR being shown and scanned): a dead target rolls the
 * claim back so no credential is ever issued for a revoked device.
 */
function exchangeReconnectEnrollment(
  d: Database,
  row: MobileEnrollmentRow,
  now: number,
  opts: { enrollmentId: string; displayName: string; appVersion: string },
): ExchangeOutcome {
  const registration = findRegistrationByHostId(row.host_id);
  if (!registration || isRowRevoked(registration)) return { kind: "target_unavailable" };

  const nativeToken = generateOpaqueSecret();
  const webGrant = generateOpaqueSecret();
  const grantId = generatePublicId();
  const webAdmin = row.web_admin === 1 ? 1 : 0;
  const origin = requiredServerOrigin();
  const hostId = row.host_id;
  let revokedSessionIds: string[] = [];

  const exchange = d.transaction(() => {
    claimPendingEnrollment(d, opts.enrollmentId, now);
    const rotated = d.run(
      `UPDATE mobile_registrations
          SET native_token_hash = ?, display_name = ?, app_version = ?, last_seen_at = ?
        WHERE host_id = ? AND (revoked_at IS NULL OR revoked_at = 0)`,
      [hashSecret(nativeToken), opts.displayName, opts.appVersion, now, hostId],
    );
    if (Number(rotated.changes) !== 1) throw new ReconnectTargetLost();
    // Sessions are read BEFORE they are revoked: their live WebSockets are
    // closed by the route once this transaction has committed.
    revokedSessionIds = d
      .query<{ id: string }, [string]>(
        "SELECT id FROM web_sessions WHERE registration_id = ? AND revoked_at IS NULL",
      )
      .all(hostId)
      .map((s) => s.id);
    d.run(
      `UPDATE web_grants SET revoked_at = ?, revoked_reason = ?
        WHERE registration_id = ? AND revoked_at IS NULL`,
      [now, RECONNECT_ROTATED_REASON, hostId],
    );
    d.run(
      `UPDATE web_sessions SET revoked_at = ?
        WHERE registration_id = ? AND revoked_at IS NULL`,
      [now, hostId],
    );
    d.run(
      `INSERT INTO web_grants (id, grant_hash, registration_id, admin, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [grantId, hashSecret(webGrant), hostId, webAdmin, now],
    );
    // Establishing the new credentials is also proof of presence: treat the
    // reconnect like a check-in for the host row (heartbeat + status).
    d.run(`UPDATE hosts SET last_seen = ?, status = 'online' WHERE id = ?`, [now, hostId]);
    // hosts.hostname is the pairing-time label; it follows a new app-reported
    // name only while it still equals the previous one (an operator rename is
    // never overwritten by a reconnect).
    d.run(`UPDATE hosts SET hostname = ? WHERE id = ? AND hostname = ?`, [
      opts.displayName,
      hostId,
      registration.display_name,
    ]);
  });
  const failed = runExchange(exchange, d, opts.enrollmentId, now);
  if (failed) return failed;
  const response: MobileEnrollmentExchangeResponse = {
    hostId,
    nativeToken,
    webGrant,
    serverOrigin: origin,
    displayName: opts.displayName,
    clientType: registration.client_type,
  };
  return { kind: "ok", response, hostId, rotated: true, revokedSessionIds };
}

/**
 * Single-use gate: flip pending→used only while still pending AND unexpired.
 * Runs inside the caller's transaction, so a concurrent exchange cannot
 * interleave between the gate and the writes it guards.
 */
function claimPendingEnrollment(d: Database, enrollmentId: string, now: number): void {
  const claimed = d.run(
    `UPDATE mobile_enrollments
        SET status = 'used', consumed_at = ?
      WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    [now, enrollmentId, now],
  );
  if (Number(claimed.changes) !== 1) throw new ExchangeClaimLost();
}

/**
 * Run one exchange transaction, translating its known failure sentinels into
 * outcomes (the transaction has already rolled back). Unexpected errors
 * propagate. Returns null when the transaction committed.
 */
function runExchange(
  exchange: () => void,
  d: Database,
  enrollmentId: string,
  now: number,
): ExchangeOutcome | null {
  try {
    exchange();
    return null;
  } catch (err) {
    if (err instanceof ReconnectTargetLost) return { kind: "target_unavailable" };
    if (!(err instanceof ExchangeClaimLost)) throw err;
    // Another request consumed the enrollment between our read and the
    // claim. Rollback already happened; report the current state.
    const after = d
      .query<MobileEnrollmentRow, [string]>(
        "SELECT * FROM mobile_enrollments WHERE id = ?",
      )
      .get(enrollmentId);
    const postStatus = after ? enrollmentStatusOf(after, now) : null;
    if (postStatus === "used") return { kind: "used" };
    if (postStatus === "expired") return { kind: "expired" };
    if (postStatus === "revoked") return { kind: "revoked" };
    return { kind: "not_found" };
  }
}

class ExchangeClaimLost extends Error {
  constructor() {
    super("enrollment claim lost to a concurrent exchange");
  }
}

/** Thrown when a reconnect QR's target registration is no longer live. */
class ReconnectTargetLost extends Error {
  constructor() {
    super("reconnect target registration is no longer live");
  }
}

/** Thrown when a reconnect QR's authority stopped being resolvable mid-create. */
class ReconnectAuthorityLost extends Error {
  constructor(readonly liveGrants: number) {
    super("reconnect authority is no longer resolvable (expected exactly one live web grant)");
  }
}

// ---------------------------------------------------------------------------
// Registration reads / native identity
// ---------------------------------------------------------------------------

export function findRegistrationByHostId(hostId: string): MobileRegistrationRow | null {
  return (
    currentDb()
      .query<MobileRegistrationRow, [string]>(
        "SELECT * FROM mobile_registrations WHERE host_id = ?",
      )
      .get(hostId) ?? null
  );
}

/**
 * Admin projection of every mobile registration (GET /mobile/registrations).
 * Minimal + revocation-safe: host identity and presence metadata only —
 * never secret hashes, grant/session links, or host config. Most recently
 * paired first (created_at DESC); revoked registrations are INCLUDED — the
 * desktop device list filters them client-side.
 */
export function listMobileRegistrations(): MobileRegistrationSummary[] {
  return currentDb()
    .query<MobileRegistrationRow, []>(
      `SELECT host_id, client_type, display_name, app_version, created_at,
              last_seen_at, revoked_at, revoked_reason
         FROM mobile_registrations
        ORDER BY created_at DESC`,
    )
    .all()
    .map((r) => ({
      hostId: r.host_id,
      displayName: r.display_name,
      clientType: r.client_type,
      appVersion: r.app_version,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      revokedAt: r.revoked_at,
      revokedReason: r.revoked_reason,
    }));
}

/**
 * Resolve a native bearer token to its registration host id, or null when
 * the token is unknown or its registration is revoked (revoked rows
 * collapse to null → 401 exactly like a bad token).
 */
export function resolveNativeHost(token: string): string | null {
  const row = currentDb()
    .query<{ host_id: string; revoked_at: number | null }, [string]>(
      "SELECT host_id, revoked_at FROM mobile_registrations WHERE native_token_hash = ?",
    )
    .get(hashSecret(token));
  if (!row) return null;
  return isRowRevoked(row) ? null : row.host_id;
}

/** GET /mobile/me projection for a live mobile registration. */
export function mobileMeResponse(
  hostId: string,
  registration: MobileRegistrationRow,
): MobileMeResponse {
  return {
    hostId,
    displayName: registration.display_name,
    clientType: registration.client_type,
    appVersion: registration.app_version,
    pairedAt: registration.created_at,
    serverOrigin: requiredServerOrigin(),
  };
}

/** POST /mobile/check-in: bump own last-seen + app version (+ host row). */
export function mobileCheckIn(
  hostId: string,
  appVersion: string,
  nowMs?: number,
): MobileCheckInResponse {
  const now = nowMs ?? Date.now();
  const d = currentDb();
  d.run(
    `UPDATE mobile_registrations SET last_seen_at = ?, app_version = ? WHERE host_id = ?`,
    [now, appVersion, hostId],
  );
  d.run(`UPDATE hosts SET last_seen = ?, status = 'online' WHERE id = ?`, [now, hostId]);
  return { hostId, lastSeenAt: now };
}

// ---------------------------------------------------------------------------
// Web grants + sessions
// ---------------------------------------------------------------------------

export interface LiveMobileSession {
  session: WebSessionRow;
  registration: MobileRegistrationRow;
  grant: WebGrantRow;
}

/**
 * Resolve a session secret to a FULLY LIVE session: row exists, not
 * revoked, not expired, and both registration and grant are unrevoked.
 * Returns null otherwise (→ 401). Every REST/WS auth read goes through
 * here, so revocation and expiry take effect immediately and a restarted
 * server revalidates stored state on the next request.
 */
export function resolveLiveSession(secret: string, nowMs?: number): LiveMobileSession | null {
  const now = nowMs ?? Date.now();
  const session = currentDb()
    .query<WebSessionRow, [string]>(
      "SELECT * FROM web_sessions WHERE session_hash = ?",
    )
    .get(hashSecret(secret));
  if (!session) return null;
  if (isRowRevoked(session) || session.expires_at <= now) return null;
  const registration = findRegistrationByHostId(session.registration_id);
  if (!registration || isRowRevoked(registration)) return null;
  const grant = currentDb()
    .query<WebGrantRow, [string]>("SELECT * FROM web_grants WHERE id = ?")
    .get(session.grant_id);
  if (!grant || isRowRevoked(grant)) return null;
  return { session, registration, grant };
}

export type BootstrapOutcome =
  | { kind: "ok"; response: MobileWebSessionBootstrapResponse; sessionSecret: string; hostId: string }
  | { kind: "invalid_grant" }
  // LAMA-296 review finding 4: a grant WITHOUT the admin flag cannot issue
  // a web session at all. The desktop flow always requests full admin, and
  // issuing half-privileged cookie sessions would contradict the stored
  // grant (the REST boundary denies non-admin sessions centrally anyway).
  | { kind: "non_admin_grant" };

/**
 * Exchange a web grant (body, never a bearer) for a fresh session cookie
 * secret + CSRF token. Rejects revoked/unknown grants, grants whose
 * registration was revoked, and grants that carry no admin flag (403 at the
 * route — no half-privileged session is ever issued). 12-hour absolute
 * lifetime; no refresh rotation. Returns the plaintext session secret
 * exactly once (the caller sets the cookie); only its hash is stored.
 */
export function bootstrapMobileWebSession(
  grant: string,
  nowMs?: number,
): BootstrapOutcome {
  const now = nowMs ?? Date.now();
  const d = currentDb();
  const grantRow = d
    .query<WebGrantRow, [string]>("SELECT * FROM web_grants WHERE grant_hash = ?")
    .get(hashSecret(grant));
  if (!grantRow || isRowRevoked(grantRow)) return { kind: "invalid_grant" };
  const registration = findRegistrationByHostId(grantRow.registration_id);
  if (!registration || isRowRevoked(registration)) return { kind: "invalid_grant" };
  if (grantRow.admin !== 1) return { kind: "non_admin_grant" };

  const sessionSecret = generateOpaqueSecret();
  const sessionId = generatePublicId();
  const expiresAt = now + SESSION_TTL_MS;
  d.run(
    `INSERT INTO web_sessions
       (id, session_hash, registration_id, grant_id, admin, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, hashSecret(sessionSecret), registration.host_id, grantRow.id, grantRow.admin, now, expiresAt],
  );
  const response: MobileWebSessionBootstrapResponse = {
    hostId: registration.host_id,
    displayName: registration.display_name,
    expiresAt,
    csrfToken: deriveCsrfToken(sessionSecret),
  };
  return { kind: "ok", response, sessionSecret, hostId: registration.host_id };
}

/** CSRF token: deterministic per session secret (never stored). */
export function deriveCsrfToken(sessionSecret: string): string {
  const digest = createHash("sha256")
    .update(`lamasync-mobile-csrf-v1\0${sessionSecret}`, "utf8")
    .digest();
  return digest.subarray(0, 24).toString("base64url");
}

/** Read one cookie value out of a raw Cookie header. */
export function readCookieHeader(raw: string | null, name: string): string | null {
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** The mobile session cookie name (host-only). */
export const MOBILE_SESSION_COOKIE = "__Host-lamasync-mobile";

/** Cookie value for the session secret (attributes set by the route). */
export function mobileSessionCookieValue(sessionSecret: string): string {
  return `${MOBILE_SESSION_COOKIE}=${sessionSecret}`;
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

export interface RevokeResult {
  found: boolean;
  revokedAt: number;
  /** Registration row when a mobile registration existed. */
  registration: MobileRegistrationRow | null;
}

/**
 * Admin revoke: atomically revokes the native registration, its web grant,
 * and every web session, and marks the enrollment(s) that produced it
 * revoked — including any pending reconnect QR still waiting for a scan, so a
 * revoked device cannot be revived by a QR shown earlier. Idempotent —
 * revoking an already-revoked registration is a successful no-op (same
 * response). Returns found=false when no such registration.
 */
export function revokeMobileRegistration(
  hostId: string,
  reason: string | null,
  nowMs?: number,
): RevokeResult {
  const now = nowMs ?? Date.now();
  const d = currentDb();
  const registration = findRegistrationByHostId(hostId);
  if (!registration) return { found: false, revokedAt: now, registration: null };
  // Idempotent repeat: an already-revoked registration reports its original
  // revocation instant (same response shape, no error).
  if (isRowRevoked(registration)) {
    return { found: true, revokedAt: registration.revoked_at!, registration };
  }
  const revoke = d.transaction(() => {
    d.run(
      `UPDATE mobile_registrations SET revoked_at = ?, revoked_reason = ? WHERE host_id = ?`,
      [now, reason, hostId],
    );
    d.run(`UPDATE web_grants SET revoked_at = ?, revoked_reason = ? WHERE registration_id = ?`, [
      now,
      reason,
      hostId,
    ]);
    d.run(`UPDATE web_sessions SET revoked_at = ? WHERE registration_id = ? AND revoked_at IS NULL`, [
      now,
      hostId,
    ]);
    d.run(
      `UPDATE mobile_enrollments SET status = 'revoked', revoked_at = ?
        WHERE host_id = ? AND status != 'revoked'`,
      [now, hostId],
    );
  });
  revoke();
  const fresh = findRegistrationByHostId(hostId);
  return { found: true, revokedAt: now, registration: fresh };
}

/** Logout: revoke exactly one web session (by its cookie secret). */
export function revokeMobileWebSession(sessionSecret: string, nowMs?: number): boolean {
  const now = nowMs ?? Date.now();
  const result = currentDb().run(
    `UPDATE web_sessions SET revoked_at = ?
      WHERE session_hash = ? AND revoked_at IS NULL`,
    [now, hashSecret(sessionSecret)],
  );
  return Number(result.changes) === 1;
}

/** The live Bun server (set from index.ts after listen) — provides the TCP
 *  peer address for exchange throttling. Never X-Forwarded-For. */
let peerServer: unknown = null;

/** Test seam / boot hook: point the throttler at the running server. */
export function setPeerServerForRateLimit(srv: unknown): void {
  peerServer = srv;
}

/** Resolve the trusted client address for throttling. Prefers the TCP peer
 *  address (never X-Forwarded-For); falls back to "unknown" when no server
 *  is attached (e.g. app.handle in tests). */
export function trustedClientAddress(request: Request): string {
  try {
    const srv = peerServer as { requestIP?: (r: Request) => { address: string } | null } | null;
    const ip = srv?.requestIP?.(request);
    if (ip && typeof ip.address === "string" && ip.address.length > 0) return ip.address;
  } catch {
    // fall through
  }
  return "unknown";
}
