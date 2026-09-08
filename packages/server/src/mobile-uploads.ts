// LAMA-296 stage 1: persistence + filesystem orchestration for scoped mobile
// upload destinations and the resumable upload protocol. See
// docs/spec-296-stage-1-manual-uploads.md for the state machine and contract.
//
// Security invariants:
//   * A destination grants exactly ONE registration the right to publish
//     under a server-computed `Mobile/<hostId>/<slug>` path. Request bodies
//     reference destination ids only; file names are validated single
//     segments; the final path is contained under the landing root and
//     re-validated (realpath) at the write boundary before rename.
//   * Every operation re-checks the current native principal, the live
//     registration, destination ownership + liveness, and upload ownership.
//     Publication re-checks everything again, so central revocation or
//     destination revocation prevents an in-flight transfer from publishing.
//   * Staging sits OUTSIDE the browse tree (default `<tmp>/lamasync-mobile-
//     staging`), keyed by server-issued upload ids — a client can never
//     express a path. Bounded chunk size, per-upload cap, staging quota,
//     abandoned-staging reconcile, and serialized per-upload writes.
//   * The final file is the durability point. `final_rel_path` + verified
//     `sha256` are recorded BEFORE the rename so a crash between the
//     filesystem rename and the DB completion record is recovered by a
//     finalize retry without a duplicate file or history row.

import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { db as defaultDb } from "./db.ts";
import type {
  MobileUpload,
  MobileUploadBrowseRef,
  MobileUploadDestination,
  MobileUploadReceipt,
  MobileUploadStatus,
} from "@lamasync/core";
import { findRegistrationByHostId, isRowRevoked } from "./mobile-store.ts";

// ---------------------------------------------------------------------------
// Configuration (env-driven; documented in docs/development.md + api.md)
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Server-local landing root for completed mobile uploads. Defaults to
 *  `<LAMASYNC_BACKUP_DIR>/Mobile` so published files appear in the existing
 *  local Data Browser surface. */
export function mobileLandingRoot(): string {
  const explicit = process.env.LAMASYNC_MOBILE_LANDING_DIR?.trim();
  if (explicit && explicit.length > 0) return explicit;
  return join(process.env.LAMASYNC_BACKUP_DIR?.trim() || "/backups", "Mobile");
}

/** Staging root — deliberately OUTSIDE the browse tree. */
export function mobileStagingRoot(): string {
  const explicit = process.env.LAMASYNC_MOBILE_STAGING_DIR?.trim();
  if (explicit && explicit.length > 0) return explicit;
  return join(tmpdir(), "lamasync-mobile-staging");
}

/** Negotiated maximum bytes per chunk request (default 4 MiB). */
export function mobileChunkSizeBytes(): number {
  return envInt("LAMASYNC_MOBILE_CHUNK_BYTES", 4 * 1024 * 1024);
}

/** Server-enforced maximum total upload size (default 2 GiB). */
export function mobileMaxUploadBytes(): number {
  return envInt("LAMASYNC_MOBILE_MAX_UPLOAD_BYTES", 2 * 1024 * 1024 * 1024);
}

/** Max client idempotency-key length. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
/** Max destination label length. */
export const MAX_DEST_LABEL_LENGTH = 64;
/** Max slug/file-name segment length (Unix NAME_MAX is 255). */
export const MAX_SEGMENT_LENGTH = 200;

/** Inactivity TTL for abandoned staging (default 7 days). */
const ABANDONED_TTL_MS = () => envInt("LAMASYNC_MOBILE_ABANDON_TTL_MS", 7 * 24 * 60 * 60 * 1000);

/** Rough cap on total staged bytes across all uploads (default 8 GiB). */
export function mobileStagingQuotaBytes(): number {
  return envInt("LAMASYNC_MOBILE_STAGING_QUOTA_BYTES", 8 * 1024 * 1024 * 1024);
}

// ---------------------------------------------------------------------------
// Active-db seam (matches mobile-store.ts conventions)
// ---------------------------------------------------------------------------

let activeDb: Database | null = null;

function currentDb(): Database {
  return activeDb ?? defaultDb;
}

export function __setMobileUploadsDb(next: Database): void {
  activeDb = next;
}

export function __resetMobileUploadsDb(): void {
  activeDb = null;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** True when `value` is a safe single path segment: no separators, no `.` /
 *  `..`, no null/control bytes, trimmed, bounded. Used for destination slugs
 *  AND upload file names. */
export function isSafeSegment(value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SEGMENT_LENGTH) return false;
  if (trimmed !== value) return false;
  if (/[\\/\0]/.test(trimmed)) return false;
  if (trimmed === "." || trimmed === "..") return false;
  for (const ch of trimmed) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** Normalize a label into a slug (single segment) or null when unusable. */
export function slugFromLabel(label: string): string | null {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SEGMENT_LENGTH) return null;
  const slug = trimmed
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "");
  if (slug.length === 0 || !isSafeSegment(slug)) return null;
  return slug;
}

/** True when a hex sha256 digest (64 chars) — used to bound the declared
 *  checksum before storing it. */
export function isHexSha256(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface MobileUploadDestinationRow {
  id: string;
  registration_id: string;
  label: string;
  rel_path: string;
  created_at: number;
  revoked_at: number | null;
}

export interface MobileUploadRow {
  id: string;
  registration_id: string;
  destination_id: string;
  idempotency_key: string;
  file_name: string;
  final_rel_path: string;
  size_bytes: number | null;
  bytes_received: number;
  sha256: string | null;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  finalized_at: number | null;
}

export function isUploadStatus(value: string): value is MobileUploadStatus {
  switch (value) {
    case "created":
    case "uploading":
    case "ready":
    case "verifying":
    case "publishing":
    case "finalized":
    case "failed":
    case "cancelled":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers (containment at the write boundary)
// ---------------------------------------------------------------------------

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Realpath containment check: the TARGET's PARENT must resolve INSIDE the
 *  landing root (the target file itself may not exist yet). Mirrors
 *  browse-paths.resolveBrowsePath semantics — a symlink escape is rejected
 *  before any rename happens. The root itself is created if missing so
 *  first publication works on a fresh server. */
export function assertInsideRoot(root: string, target: string): void {
  ensureDir(root);
  const rootReal = realpathSync(root);
  const rootWithSep = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
  ensureDir(dirname(target));
  const parentReal = realpathSync(dirname(target));
  if (parentReal !== rootReal && !parentReal.startsWith(rootWithSep)) {
    throw new UploadPathEscapeError();
  }
}

/** Final absolute path for an upload. The wire rel path follows the browse
 *  convention (`Mobile/<hostId>/<slug>/<file>` — what the Data Browser and
 *  receipts use), while the landing root ALREADY ends in `Mobile`, so the
 *  `Mobile/` prefix is stripped before joining. */
export function finalAbsolutePath(relPath: string): string {
  const relative = relPath.startsWith("Mobile/") ? relPath.slice("Mobile/".length) : relPath;
  return join(mobileLandingRoot(), relative);
}

/** Staging absolute path for an upload id. */
export function stagingAbsolutePath(uploadId: string): string {
  return join(mobileStagingRoot(), `${uploadId}.part`);
}

export class UploadPathEscapeError extends Error {
  constructor() {
    super("path escapes the mobile landing root");
    this.name = "UploadPathEscapeError";
  }
}

function mapFsError(err: unknown, label: string): void {
  console.error(`[mobile-uploads] ${label}: ${err instanceof Error ? err.message : String(err)}`);
}

// ---------------------------------------------------------------------------
// Staging usage accounting (bounded staging space)
// ---------------------------------------------------------------------------

let stagedUsageBytes = 0;
let stagedUsageSeeded = false;

/** Seed the in-memory staging usage counter from disk (boot reconcile). */
export function seedStagingUsage(): number {
  let total = 0;
  try {
    const root = mobileStagingRoot();
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        try {
          total += statSync(join(root, name)).size;
        } catch {
          // vanished between readdir and stat — skip
        }
      }
    }
  } catch (err) {
    mapFsError(err, "staging usage seed failed");
  }
  stagedUsageBytes = total;
  stagedUsageSeeded = true;
  return total;
}

/** Test seam: force the counter without touching disk. */
export function __setStagedUsageForTests(bytes: number, seeded = true): void {
  stagedUsageBytes = bytes;
  stagedUsageSeeded = seeded;
}

function currentStagedUsage(): number {
  if (!stagedUsageSeeded) {
    stagedUsageBytes = seedStagingUsage();
  }
  return stagedUsageBytes;
}

function recordStagedBytes(delta: number): void {
  stagedUsageBytes = Math.max(0, currentStagedUsage() + delta);
}

// ---------------------------------------------------------------------------
// Destination lifecycle
// ---------------------------------------------------------------------------

function rowToDestination(row: MobileUploadDestinationRow): MobileUploadDestination {
  return {
    id: row.id,
    registrationId: row.registration_id,
    label: row.label,
    relPath: row.rel_path,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export function findDestinationById(id: string): MobileUploadDestinationRow | null {
  const row = currentDb()
    .query<MobileUploadDestinationRow, [string]>(
      "SELECT * FROM mobile_upload_destinations WHERE id = ?",
    )
    .get(id);
  return row ?? null;
}

/** A registration's destinations (active only, or all when `includeRevoked`). */
export function listDestinationsForRegistration(
  registrationId: string,
  includeRevoked = true,
): MobileUploadDestination[] {
  const rows = includeRevoked
    ? currentDb()
        .query<MobileUploadDestinationRow, [string]>(
          "SELECT * FROM mobile_upload_destinations WHERE registration_id = ? ORDER BY created_at DESC",
        )
        .all(registrationId)
    : currentDb()
        .query<MobileUploadDestinationRow, [string]>(
          "SELECT * FROM mobile_upload_destinations WHERE registration_id = ? AND revoked_at IS NULL ORDER BY created_at DESC",
        )
        .all(registrationId);
  return rows.map(rowToDestination);
}

export type CreateDestinationOutcome =
  | { kind: "ok"; destination: MobileUploadDestination }
  | { kind: "invalid_label" }
  | { kind: "invalid_slug" }
  | { kind: "duplicate" }
  | { kind: "unknown_registration" };

/** Admin creates one destination for a registration. The rel path is always
 *  `Mobile/<hostId>/<slug>` — the client can never choose a root, another
 *  host's inbox, or a nested path. */
export function createMobileUploadDestination(opts: {
  registrationId: string;
  label: string;
  slug?: string | null;
  nowMs?: number;
}): CreateDestinationOutcome {
  const now = opts.nowMs ?? Date.now();
  const trimmedLabel = opts.label.trim();
  if (trimmedLabel.length === 0 || trimmedLabel.length > MAX_DEST_LABEL_LENGTH) {
    return { kind: "invalid_label" };
  }
  // Control chars in the label are rejected, not silently stripped.
  for (const ch of trimmedLabel) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return { kind: "invalid_label" };
  }
  const slug =
    opts.slug !== undefined && opts.slug !== null
      ? isSafeSegment(opts.slug) ? opts.slug : null
      : slugFromLabel(trimmedLabel);
  if (slug === null) return { kind: "invalid_slug" };
  // registration id comes from the route path but is validated as a segment
  // and must resolve to a live mobile registration row.
  if (!isSafeSegment(opts.registrationId)) return { kind: "unknown_registration" };
  const registration = findRegistrationByHostId(opts.registrationId);
  if (!registration) return { kind: "unknown_registration" };
  const relPath = `Mobile/${opts.registrationId}/${slug}`;
  const d = currentDb();
  const existing = d
    .query<MobileUploadDestinationRow, [string, string]>(
      "SELECT * FROM mobile_upload_destinations WHERE registration_id = ? AND rel_path = ?",
    )
    .get(opts.registrationId, relPath);
  if (existing) return { kind: "duplicate" };
  const id = `mdst-${randomBytes(10).toString("base64url")}`;
  d.run(
    `INSERT INTO mobile_upload_destinations (id, registration_id, label, rel_path, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, opts.registrationId, trimmedLabel, relPath, now],
  );
  const row = findDestinationById(id);
  return { kind: "ok", destination: rowToDestination(row!) };
}

export type RevokeDestinationOutcome =
  | { kind: "ok"; id: string; revokedAt: number }
  | { kind: "not_found" };

/** Admin revoke of a destination. Idempotent; re-validated at finalize so an
 *  in-flight upload cannot publish after revocation. Correction R8: a
 *  destination belongs to EXACTLY ONE registration, so the nested URL's
 *  parent hostId must match — a stale/mismatched row (device A's inbox
 *  addressed through device B's URL) must never revoke another device's
 *  destination. An unknown id and a mismatched parent both map to
 *  not_found (no existence leak across hosts). */
export function revokeMobileUploadDestination(
  registrationId: string,
  id: string,
  nowMs?: number,
): RevokeDestinationOutcome {
  const now = nowMs ?? Date.now();
  const row = findDestinationById(id);
  if (!row || row.registration_id !== registrationId) return { kind: "not_found" };
  if (row.revoked_at !== null && row.revoked_at > 0) {
    return { kind: "ok", id, revokedAt: row.revoked_at };
  }
  currentDb().run(
    `UPDATE mobile_upload_destinations SET revoked_at = ? WHERE id = ?`,
    [now, id],
  );
  return { kind: "ok", id, revokedAt: now };
}

// ---------------------------------------------------------------------------
// Upload create / state helpers
// ---------------------------------------------------------------------------

export type CreateUploadOutcome =
  | { kind: "ok"; upload: MobileUpload }
  | { kind: "unauthorized" }
  | { kind: "destination_not_found" }
  | { kind: "destination_revoked" }
  | { kind: "unsafe_file_name" }
  | { kind: "collision" }
  | { kind: "size_over_cap" };

function computeFinalRelPath(destination: MobileUploadDestinationRow, fileName: string): string {
  return `${destination.rel_path}/${fileName}`;
}

/** Wire projection of an upload row (filled with negotiated limits). */
export function rowToUpload(row: MobileUploadRow): MobileUpload {
  const destination = findDestinationById(row.destination_id);
  const status = isUploadStatus(row.status) ? row.status : "failed";
  return {
    id: row.id,
    destinationId: row.destination_id,
    destinationLabel: destination?.label ?? row.final_rel_path,
    fileName: row.file_name,
    finalRelPath: row.final_rel_path,
    sizeBytes: row.size_bytes,
    bytesReceived: row.bytes_received,
    sha256: row.sha256,
    status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finalizedAt: row.finalized_at,
    receipt: receiptOf(row),
    chunkSizeBytes: mobileChunkSizeBytes(),
    maxSizeBytes: mobileMaxUploadBytes(),
  };
}

function receiptOf(row: MobileUploadRow): MobileUploadReceipt | null {
  if (row.finalized_at === null || row.sha256 === null) return null;
  const browseRef: MobileUploadBrowseRef = { kind: "local", path: row.final_rel_path };
  return {
    uploadId: row.id,
    fileName: row.file_name,
    finalRelPath: row.final_rel_path,
    browseRef,
    sizeBytes: row.bytes_received,
    sha256: row.sha256,
    finalizedAt: row.finalized_at,
  };
}

export function findUploadById(id: string): MobileUploadRow | null {
  const row = currentDb()
    .query<MobileUploadRow, [string]>("SELECT * FROM mobile_uploads WHERE id = ?")
    .get(id);
  return row ?? null;
}

export function findUploadByIdempotency(
  registrationId: string,
  idempotencyKey: string,
): MobileUploadRow | null {
  const row = currentDb()
    .query<MobileUploadRow, [string, string]>(
      "SELECT * FROM mobile_uploads WHERE registration_id = ? AND idempotency_key = ?",
    )
    .get(registrationId, idempotencyKey);
  return row ?? null;
}

export function listUploadsForRegistration(registrationId: string): MobileUpload[] {
  const rows = currentDb()
    .query<MobileUploadRow, [string]>(
      "SELECT * FROM mobile_uploads WHERE registration_id = ? ORDER BY created_at DESC",
    )
    .all(registrationId);
  return rows.map(rowToUpload);
}

/** True when the reserved final path already exists on the landing root. */
function finalExists(relPath: string): boolean {
  try {
    return existsSync(finalAbsolutePath(relPath));
  } catch {
    return false;
  }
}

/**
 * Create (or re-fetch, idempotency) one upload intent. Authorization is the
 * caller's job (the route re-checks the native principal + registration):
 * here we validate destination ownership/liveness, the file name, the size
 * cap and final-name collision. A lost create response is recovered by
 * retrying with the same idempotency key — the SAME upload row is returned
 * and the reserved final name is reused, so retries never mint duplicates.
 */
export function createMobileUpload(opts: {
  registrationId: string;
  destinationId: string;
  fileName: string;
  sizeBytes: number | null;
  sha256: string | null;
  idempotencyKey: string;
  nowMs?: number;
}): CreateUploadOutcome {
  const now = opts.nowMs ?? Date.now();
  // Idempotency retry wins BEFORE validation: the same intent must return
  // the same upload even if the first response was lost and the world
  // changed meanwhile.
  const prior = findUploadByIdempotency(opts.registrationId, opts.idempotencyKey);
  if (prior) return { kind: "ok", upload: rowToUpload(prior) };

  const destination = findDestinationById(opts.destinationId);
  if (!destination || destination.registration_id !== opts.registrationId) {
    return { kind: "destination_not_found" };
  }
  if (destination.revoked_at !== null && destination.revoked_at > 0) {
    return { kind: "destination_revoked" };
  }
  if (!isSafeSegment(opts.fileName)) return { kind: "unsafe_file_name" };
  if (
    opts.sizeBytes !== null &&
    opts.sizeBytes !== undefined &&
    opts.sizeBytes > mobileMaxUploadBytes()
  ) {
    return { kind: "size_over_cap" };
  }
  const finalRelPath = computeFinalRelPath(destination, opts.fileName);

  // Collision: the reserved final name must not silently overwrite an
  // existing file. Identical filenames are not proof of duplicate content,
  // so a same-name intent fails explicitly (the caller renames or cancels).
  const existing = currentDb()
    .query<MobileUploadRow, [string, string]>(
      "SELECT * FROM mobile_uploads WHERE registration_id = ? AND final_rel_path = ?",
    )
    .get(opts.registrationId, finalRelPath);
  if (existing) return { kind: "collision" };
  if (finalExists(finalRelPath)) {
    return { kind: "collision" };
  }

  const id = `mup-${randomBytes(12).toString("base64url")}`;
  try {
    currentDb().run(
      `INSERT INTO mobile_uploads
         (id, registration_id, destination_id, idempotency_key, file_name,
          final_rel_path, size_bytes, bytes_received, sha256, status,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'created', ?, ?)`,
      [
        id,
        opts.registrationId,
        destination.id,
        opts.idempotencyKey,
        opts.fileName,
        finalRelPath,
        opts.sizeBytes,
        // Declared checksum is persisted so finalize can verify against it
        // even across a process restart (verified digest replaces it).
        opts.sha256,
        now,
        now,
      ],
    );
  } catch (err) {
    // UNIQUE(registration_id, idempotency_key) race: another create with
    // the same key won between our read and insert — return that upload.
    const raced = findUploadByIdempotency(opts.registrationId, opts.idempotencyKey);
    if (raced) return { kind: "ok", upload: rowToUpload(raced) };
    throw err;
  }
  const inserted = findUploadById(id);
  return { kind: "ok", upload: rowToUpload(inserted!) };
}

// ---------------------------------------------------------------------------
// Chunk writes (serialized per upload, durable offsets)
// ---------------------------------------------------------------------------

/** In-memory per-upload single-flight guard. The DB row is the source of
 *  truth for offsets/status; this just serializes writes+finalize so two
 *  concurrent requests cannot interleave file writes against the same
 *  staging file. */
const uploadLocks = new Set<string>();

function withUploadLock<T>(uploadId: string, fn: () => T): T {
  if (uploadLocks.has(uploadId)) {
    throw new UploadBusyError();
  }
  uploadLocks.add(uploadId);
  try {
    return fn();
  } finally {
    uploadLocks.delete(uploadId);
  }
}

/** Test seam. */
export function __resetUploadLocksForTests(): void {
  uploadLocks.clear();
}

/** Test seam: make the next staging open fail (disk-full simulation). */
let stagingWriteErrorForTests: Error | null = null;
export function __setStagingWriteErrorForTests(error: Error | null): void {
  stagingWriteErrorForTests = error;
}

export class UploadBusyError extends Error {
  constructor() {
    super("another request is writing this upload");
    this.name = "UploadBusyError";
  }
}

/** Open the staging file for an offset write: create on first chunk. */
function openStagingForWrite(path: string): number {
  if (stagingWriteErrorForTests !== null) {
    const err = stagingWriteErrorForTests;
    stagingWriteErrorForTests = null;
    throw err;
  }
  return openSync(path, existsSync(path) ? "r+" : "w", 0o600);
}

export type ChunkOutcome =
  | { kind: "ok"; upload: MobileUpload }
  | { kind: "not_found" }
  | { kind: "unauthorized" }
  | { kind: "bad_offset" }
  | { kind: "stale_state" }
  | { kind: "too_large" }
  | { kind: "exceeds_declared_size" }
  | { kind: "staging_full" }
  | { kind: "disk_error" };

/** Write one bounded chunk at the durable offset. The caller (route) has
 *  already bounded the raw body to `mobileChunkSizeBytes()`; here we enforce
 *  offset exactness, declared-size and quota bounds, and serialize with any
 *  concurrent chunk/finalize on the same upload. */
export function appendMobileUploadChunk(opts: {
  registrationId: string;
  uploadId: string;
  offset: number;
  data: Uint8Array;
  nowMs?: number;
}): ChunkOutcome {
  const now = opts.nowMs ?? Date.now();
  const d = currentDb();
  try {
    return withUploadLock(opts.uploadId, () => {
      const row = findUploadById(opts.uploadId);
      if (!row) return { kind: "not_found" };
      if (row.registration_id !== opts.registrationId) return { kind: "unauthorized" };
      if (row.status !== "created" && row.status !== "uploading") {
        return { kind: "stale_state" };
      }
      if (opts.data.length === 0) return { kind: "bad_offset" };
      if (opts.offset !== row.bytes_received) return { kind: "bad_offset" };
      if (opts.data.length > mobileChunkSizeBytes()) return { kind: "too_large" };
      const next = row.bytes_received + opts.data.length;
      if (next > mobileMaxUploadBytes()) return { kind: "too_large" };
      if (row.size_bytes !== null && next > row.size_bytes) {
        return { kind: "exceeds_declared_size" };
      }
      // Staging quota: reject BEFORE touching disk so a full staging area
      // fails explicitly instead of corrupting an unrelated upload.
      // Correction R3: currentStagedUsage() ALREADY includes this upload's
      // earlier chunks (recordStagedBytes charges each accepted chunk), so
      // adding `next` again double-counts this upload and could reject an
      // upload that exactly fills the quota. Charge only the incoming
      // delta against the remaining global quota.
      const accountedElsewhere = Math.max(0, currentStagedUsage() - row.bytes_received);
      if (accountedElsewhere + next > mobileStagingQuotaBytes()) {
        return { kind: "staging_full" };
      }

      const stagingPath = stagingAbsolutePath(opts.uploadId);
      let fd: number | null = null;
      try {
        ensureDir(mobileStagingRoot());
        fd = openStagingForWrite(stagingPath);
        const written = writeSync(fd, opts.data, 0, opts.data.length, row.bytes_received);
        if (written !== opts.data.length) return { kind: "disk_error" };
      } catch (err) {
        mapFsError(err, `staging write failed for ${opts.uploadId}`);
        return { kind: "disk_error" };
      } finally {
        if (fd !== null) {
          try {
            closeSync(fd);
          } catch {
            // best-effort close
          }
        }
      }

      recordStagedBytes(opts.data.length);
      d.run(
        `UPDATE mobile_uploads SET bytes_received = ?, status = 'uploading', updated_at = ? WHERE id = ?`,
        [next, now, opts.uploadId],
      );
      const fresh = findUploadById(opts.uploadId);
      return { kind: "ok", upload: rowToUpload(fresh!) };
    });
  } catch (err) {
    if (err instanceof UploadBusyError) throw err;
    mapFsError(err, `chunk write failed for ${opts.uploadId}`);
    return { kind: "disk_error" };
  }
}

// ---------------------------------------------------------------------------
// Finalize (verify → re-authorize → publish → receipt) and cancel
// ---------------------------------------------------------------------------

export type FinalizeOutcome =
  | { kind: "ok"; upload: MobileUpload; receipt: MobileUploadReceipt }
  | { kind: "not_found" }
  | { kind: "unauthorized" }
  | { kind: "not_complete" }
  | { kind: "checksum_mismatch" }
  | { kind: "collision" }
  | { kind: "destination_revoked" }
  | { kind: "registration_revoked" }
  | { kind: "verification_error" }
  | { kind: "stale_state" };

/** SHA-256 of a file in bounded 1 MiB reads — never the whole file in memory. */
export function sha256OfFile(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(1 * 1024 * 1024);
    let position = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, position);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      position += n;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function stagedSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function removeStaging(uploadId: string): void {
  const path = stagingAbsolutePath(uploadId);
  try {
    if (existsSync(path)) {
      const size = statSync(path).size;
      rmSync(path, { force: true });
      recordStagedBytes(-size);
    }
  } catch (err) {
    mapFsError(err, `staging cleanup failed for ${uploadId}`);
  }
}

/** Idempotency key for ONE mobile_upload history row per upload intent.
 *  The partial unique index on operation_log(dedupe_key) makes exactly-once
 *  a DB-level guarantee (correction R4). */
export function uploadHistoryDedupeKey(uploadId: string): string {
  return `mobile_upload:${uploadId}`;
}

/** Raw history insert, used INSIDE a completing transaction so a failure
 *  aborts the caller's tx (finalized/flags and history commit together).
 *  Uses the actual mobile registration host id — never a synthetic
 *  "server" actor. Throws on failure (caller decides handling). */
function insertOperationLogRow(
  d: Database,
  row: MobileUploadRow,
  status: "success" | "failed",
  nowMs: number,
): void {
  if (operationLogInsertErrorForTests !== null) {
    const err = operationLogInsertErrorForTests;
    operationLogInsertErrorForTests = null;
    throw err;
  }
  const details: Record<string, string | number> = {
    uploadId: row.id,
    finalRelPath: row.final_rel_path,
    sizeBytes: row.bytes_received,
  };
  if (row.sha256) details.sha256 = row.sha256;
  const summary =
    status === "success"
      ? `upload ${row.file_name} → ${row.final_rel_path}`
      : `upload ${row.file_name} failed: ${row.error ?? "unknown error"}`;
  d.run(
    `INSERT INTO operation_log (timestamp, host_id, folder_id, operation, status, summary, details, trigger, dedupe_key)
     VALUES (?, ?, NULL, 'mobile_upload', ?, ?, ?, 'manual', ?)`,
    [nowMs, row.registration_id, status, summary, JSON.stringify(details), uploadHistoryDedupeKey(row.id)],
  );
}

/** True when the upload's exactly-one history row already exists. */
export function uploadHistoryExists(uploadId: string): boolean {
  const row = currentDb()
    .query<{ id: number }, [string]>(
      "SELECT id FROM operation_log WHERE dedupe_key = ?",
    )
    .get(uploadHistoryDedupeKey(uploadId));
  return row !== null;
}

/** Standalone append (retry/reconcile paths): failure-tolerant and
 *  dedupe-tolerant (a row that already recorded this upload is a no-op). */
export function appendUploadOperationLog(
  row: MobileUploadRow,
  status: "success" | "failed",
  nowMs?: number,
): void {
  try {
    if (uploadHistoryExists(row.id)) return;
    insertOperationLogRow(currentDb(), row, status, nowMs ?? Date.now());
  } catch (err) {
    mapFsError(err, "operation_log append failed");
  }
}

/** Test seam: make the NEXT history insert fail (drain-once), so hermetic
 *  tests can prove finalize rolls back instead of losing history. */
let operationLogInsertErrorForTests: Error | null = null;
export function __setOperationLogInsertErrorForTests(error: Error | null): void {
  operationLogInsertErrorForTests = error;
}

/** Correction R4: reconcile finalized rows whose idempotency-keyed history
 *  row is missing (pre-fix data, or a hypothetical partial write). Runs on
 *  boot/sweep and is also exercised by the finalized fast path. Returns the
 *  number of history rows appended. */
export function reconcileUploadHistory(): number {
  const d = currentDb();
  const rows = d
    .query<MobileUploadRow, []>(
      "SELECT * FROM mobile_uploads WHERE status = 'finalized'",
    )
    .all();
  let appended = 0;
  for (const row of rows) {
    if (uploadHistoryExists(row.id)) continue;
    try {
      insertOperationLogRow(d, row, "success", Date.now());
      appended += 1;
    } catch (err) {
      mapFsError(err, `history reconcile failed for ${row.id}`);
    }
  }
  return appended;
}

/**
 * Verify + publish one upload. Retry-safe:
 *   - `finalized` rows return the stored receipt with no new history.
 *   - `publishing` rows whose final file already exists AND matches the
 *     recorded sha256 complete in place (the crash between filesystem
 *     rename and DB completion record).
 *   - a final path that exists with DIFFERENT content fails with an explicit
 *     collision — never a silent overwrite.
 * Authorization (registration live, destination active + owned, upload owned)
 * is re-checked here, immediately before publication, so a revocation that
 * happened mid-transfer prevents publication.
 */
export function finalizeMobileUpload(opts: {
  registrationId: string;
  uploadId: string;
  nowMs?: number;
}): FinalizeOutcome {
  const now = opts.nowMs ?? Date.now();
  const d = currentDb();
  try {
    return withUploadLock(opts.uploadId, () => {
      const row = findUploadById(opts.uploadId);
      if (!row) return { kind: "not_found" };
      if (row.registration_id !== opts.registrationId) return { kind: "unauthorized" };

      if (row.status === "finalized") {
        // Correction R4: exactly-one history is guaranteed by dedupe_key, but
        // a finalized row finalized BEFORE the atomic-completion fix (or any
        // hypothetical partial write) may be missing its row — reconcile it
        // before returning the receipt. The dedupe index makes this a no-op
        // when history already exists.
        if (!uploadHistoryExists(row.id)) {
          appendUploadOperationLog(row, "success", now);
        }
        const receipt = receiptOf(row);
        if (!receipt) return { kind: "verification_error" };
        return { kind: "ok", upload: rowToUpload(row), receipt };
      }
      if (row.status === "failed" || row.status === "cancelled") {
        return { kind: "stale_state" };
      }

      // Re-authorize BEFORE any verification/publish work: a registration
      // or destination revoked since the transfer started must stop it now.
      const registration = findRegistrationByHostId(row.registration_id);
      if (!registration || isRowRevoked(registration)) {
        return { kind: "registration_revoked" };
      }
      const destination = findDestinationById(row.destination_id);
      if (!destination || destination.registration_id !== row.registration_id) {
        return { kind: "unauthorized" };
      }
      if (destination.revoked_at !== null && destination.revoked_at > 0) {
        return { kind: "destination_revoked" };
      }

      // Crash-window recovery: the rename already happened but the DB row
      // never reached 'finalized'. Complete in place when the on-disk file
      // matches the recorded digest; otherwise fail explicitly.
      if (row.status === "publishing") {
        if (existsSync(finalAbsolutePath(row.final_rel_path))) {
          if (
            row.sha256 !== null &&
            sha256OfFile(finalAbsolutePath(row.final_rel_path)) !== row.sha256.toLowerCase()
          ) {
            return collisionOutcome(row);
          }
          return completePublication(row, now);
        }
        if (stagedSize(stagingAbsolutePath(row.id)) === null) {
          // Neither staged nor final — data vanished mid-crash; fail loudly.
          failUpload(row, "transfer data lost during publication", now);
          return { kind: "verification_error" };
        }
        // Staged still present → fall through to the normal publish path.
      }
      if (row.status !== "verifying" && row.status !== "publishing") {
        // created/uploading/ready: size gate first.
        if (row.size_bytes !== null && row.bytes_received < row.size_bytes) {
          return { kind: "not_complete" };
        }
        d.run(`UPDATE mobile_uploads SET status = 'verifying', updated_at = ? WHERE id = ?`, [now, row.id]);
      }

      const stagingPath = stagingAbsolutePath(row.id);
      if (stagedSize(stagingPath) === null) {
        return { kind: "verification_error" };
      }
      let digest: string;
      try {
        digest = sha256OfFile(stagingPath);
      } catch (err) {
        mapFsError(err, `checksum failed for ${row.id}`);
        return { kind: "verification_error" };
      }
      if (row.sha256 !== null && row.sha256.toLowerCase() !== digest) {
        failUpload(row, "checksum mismatch — the received content does not match the declared checksum", now);
        return { kind: "checksum_mismatch" };
      }

      // Atomic publication: containment re-check at the write boundary, then
      // rename. Recorded sha256 + final_rel_path already exist on the row, so
      // a crash between rename and DB update is recoverable by a retry.
      d.run(`UPDATE mobile_uploads SET status = 'publishing', sha256 = ?, updated_at = ? WHERE id = ?`, [
        digest,
        now,
        row.id,
      ]);
      const finalPath = finalAbsolutePath(row.final_rel_path);
      try {
        assertInsideRoot(mobileLandingRoot(), finalPath);
        if (existsSync(finalPath)) {
          // The reserved name is occupied by something else — explicit
          // collision, never a silent overwrite.
          removeStaging(row.id);
          return collisionOutcome(row);
        }
        ensureDir(dirname(finalPath));
        renameSync(stagingPath, finalPath);
        recordStagedBytes(-(row.bytes_received));
      } catch (err) {
        if (err instanceof UploadPathEscapeError) throw err;
        mapFsError(err, `publication failed for ${row.id}`);
        failUpload(row, "publication failed", now);
        return { kind: "verification_error" };
      }

      return completePublication(row, now);
    });
  } catch (err) {
    if (err instanceof UploadPathEscapeError) {
      const row = findUploadById(opts.uploadId);
      if (row) {
        failUpload(row, "path escaped the landing root", Date.now());
      }
      return { kind: "verification_error" };
    }
    if (err instanceof UploadBusyError) throw err;
    mapFsError(err, `finalize failed for ${opts.uploadId}`);
    return { kind: "verification_error" };
  }
}

/** Helper: fail one upload + record one terminal operation_log row + remove
 *  staging. Only reaches non-terminal rows (callers gate on status), so each
 *  upload produces exactly one failure history row. Correction R4: the
 *  failed flag and its history row COMMIT IN ONE TRANSACTION — a crash or a
 *  DB error between them can no longer leave a failed row without its
 *  audit record (and a retried fail can never duplicate it). */
function failUpload(row: MobileUploadRow, error: string, now: number): void {
  const d = currentDb();
  const fail = d.transaction(() => {
    d.run(
      `UPDATE mobile_uploads SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      [error, now, row.id],
    );
    insertOperationLogRow(
      d,
      { ...row, status: "failed", error, updated_at: now },
      "failed",
      now,
    );
  });
  try {
    fail();
  } catch (err) {
    // The whole marker rolled back; surface the failure so a later sweep/
    // retry re-attempts (never a partial flag-without-history row).
    mapFsError(err, `fail/record failed for ${row.id}`);
  }
  removeStaging(row.id);
}

function collisionOutcome(row: MobileUploadRow): FinalizeOutcome {
  failUpload(row, "filename collision — the reserved final name is already taken", Date.now());
  return { kind: "collision" };
}

function completePublication(row: MobileUploadRow, now: number): FinalizeOutcome {
  const d = currentDb();
  const finalPath = finalAbsolutePath(row.final_rel_path);
  const digest = sha256OfFile(finalPath);
  const size = statSync(finalPath).size;
  // Correction R4: the finalized flag and the idempotency-keyed history row
  // COMMIT IN ONE TRANSACTION after publication. The crash window is now
  // only "rename happened, transaction not started" — a retry re-runs
  // completePublication in place (row still 'publishing'), and the
  // transaction itself can never commit finalized-without-history. A DB
  // error inside the transaction rolls everything back and the retry
  // re-attempts.
  const complete = d.transaction(() => {
    d.run(
      `UPDATE mobile_uploads SET status = 'finalized', sha256 = ?, bytes_received = ?, finalized_at = ?, updated_at = ? WHERE id = ?`,
      [digest, size, now, now, row.id],
    );
    insertOperationLogRow(
      d,
      { ...row, sha256: digest, bytes_received: size, updated_at: now, finalized_at: now },
      "success",
      now,
    );
  });
  complete();
  const fresh = findUploadById(row.id);
  const out = fresh!;
  const receipt = receiptOf(out);
  if (!receipt) return { kind: "verification_error" };
  return { kind: "ok", upload: rowToUpload(out), receipt };
}

export type CancelOutcome =
  | { kind: "ok"; upload: MobileUpload }
  | { kind: "not_found" }
  | { kind: "unauthorized" }
  | { kind: "finalized" };

/** Cancel a non-finalized upload: removes staging and marks cancelled. A
 *  finalized upload's final file is NEVER touched — cancel becomes a
 *  no-op returning the stored receipt state. */
export function cancelMobileUpload(opts: {
  registrationId: string;
  uploadId: string;
  nowMs?: number;
}): CancelOutcome {
  const now = opts.nowMs ?? Date.now();
  const d = currentDb();
  try {
    return withUploadLock(opts.uploadId, () => {
      const row = findUploadById(opts.uploadId);
      if (!row) return { kind: "not_found" };
      if (row.registration_id !== opts.registrationId) return { kind: "unauthorized" };
      if (row.status === "finalized") return { kind: "finalized" };
      if (row.status === "failed") {
        // Already terminal with staging removed; report the row.
        return { kind: "ok", upload: rowToUpload(row) };
      }
      d.run(
        `UPDATE mobile_uploads SET status = 'cancelled', error = NULL, updated_at = ? WHERE id = ?`,
        [now, row.id],
      );
      removeStaging(row.id);
      const fresh = findUploadById(row.id);
      return { kind: "ok", upload: rowToUpload(fresh!) };
    });
  } catch (err) {
    if (err instanceof UploadBusyError) throw err;
    mapFsError(err, `cancel failed for ${opts.uploadId}`);
    return { kind: "not_found" };
  }
}

// ---------------------------------------------------------------------------
// Reconciliation / revocation integration
// ---------------------------------------------------------------------------

/**
 * Boot-time + periodic reconcile (mirrors reconcileStuckBrowseJobs): fail
 * uploads stuck in non-terminal states past the inactivity TTL, remove their
 * staging, and sweep orphaned staging files older than the TTL. Also re-seeds
 * the staging usage counter so bounds stay honest across restarts.
 * Returns the number of rows reconciled.
 */
export function reconcileAbandonedMobileUploads(nowMs?: number): number {
  const now = nowMs ?? Date.now();
  const ttl = ABANDONED_TTL_MS();
  const d = currentDb();
  const cutoff = now - ttl;
  const rows = d
    .query<MobileUploadRow, []>(
      `SELECT * FROM mobile_uploads WHERE status IN ('created','uploading','ready','verifying','publishing')`,
    )
    .all();
  let reconciled = 0;
  for (const row of rows) {
    if (row.updated_at >= cutoff) continue;
    failUpload(row, "abandoned — no activity within the staging retention window", now);
    reconciled += 1;
  }
  // Sweep orphaned staging files (no upload row, older than the TTL).
  try {
    const root = mobileStagingRoot();
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        const path = join(root, name);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        const uploadId = name.replace(/\.part$/, "");
        const stillTracked =
          uploadId !== "" &&
          d.query<{ id: string }, [string]>("SELECT id FROM mobile_uploads WHERE id = ?").get(uploadId) !== null;
        if (!stillTracked && mtimeMs < cutoff) {
          try {
            rmSync(path, { force: true });
          } catch {
            // best effort
          }
        }
      }
    }
  } catch (err) {
    mapFsError(err, "staging sweep failed");
  }
  seedStagingUsage();
  // Correction R4: every finalized row must carry its exactly-one history
  // row; repair any missing rows on boot/sweep (idempotent via dedupe_key).
  reconcileUploadHistory();
  return reconciled;
}

/** Called by the registration-revoke path: mark every non-terminal upload of
 *  the registration failed and revoke its destinations, so an in-flight
 *  transfer can never publish after central revocation. Idempotent. */
export function revokeRegistrationUploads(hostId: string, reason: string | null, nowMs?: number): number {
  const now = nowMs ?? Date.now();
  const d = currentDb();
  const rows = d
    .query<MobileUploadRow, [string]>(
      `SELECT * FROM mobile_uploads WHERE registration_id = ? AND status NOT IN ('finalized','failed','cancelled')`,
    )
    .all(hostId);
  let affected = 0;
  for (const row of rows) {
    failUpload(
      row,
      `upload cancelled by registration revocation${reason ? ` (${reason})` : ""}`,
      now,
    );
    affected += 1;
  }
  d.run(
    `UPDATE mobile_upload_destinations SET revoked_at = ? WHERE registration_id = ? AND revoked_at IS NULL`,
    [now, hostId],
  );
  return affected;
}