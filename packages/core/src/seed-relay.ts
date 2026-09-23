// LAMA-346 Stage 1b — the temporary object-storage relay contract for a seed
// archive.
//
// A seed archive is TRANSPORT, not data. It lives in a dedicated, temporary
// namespace (`lamasync/seed/<jobId>/…`) that is deliberately separate from the
// managed-folder namespace, so it can never be mistaken for a synced file and
// so deleting the whole namespace can never touch user data.
//
// This module is the contract only: key building and validation, the immutable
// archive metadata record, the store interface the source uploads through and
// the target downloads through, and the cleanup/retention state machine. It is
// dependency-free (no node built-ins) so the server, the daemon and the web UI
// can all import it unchanged, and it carries NO credentials — a store is
// constructed by whoever owns the configuration, and nothing here accepts,
// stores, returns or logs one.
//
// `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` stays `false` in `folder-seed.ts`: this
// module makes the transport *contract* real and testable against a local
// object-store fixture, and it deliberately does NOT wire a configured S3
// backend, an rclone remote or any live host.

import {
  SEED_OBJECT_KEY_PREFIX,
  SEED_PATH_MAX_LENGTH,
  SEED_SHA256_RE,
  isSeedRelayCleanupComplete,
  seedArchiveObjectKey,
  type SeedArchiveFormat,
  type SeedRelayCleanup,
} from "./folder-seed.ts";

export type { SeedRelayCleanup, SeedRelayCleanupState } from "./folder-seed.ts";

// ---------------------------------------------------------------------------
// Namespace and keys
// ---------------------------------------------------------------------------

/**
 * How long an object may sit in the seed namespace once nothing will ever use
 * it again: a job that is gone, or that is still non-terminal but whose owner
 * stopped reporting. A seed archive has no value after its job ends — the
 * published tree does — so the window is short and deliberate.
 */
export const SEED_RELAY_ABANDONED_RETENTION_MS = 24 * 60 * 60_000;

/** Bound on how many objects one cleanup pass will consider. */
export const SEED_RELAY_SWEEP_LIMIT = 1_000;

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** True when `jobId` is safe to use as a single key segment. */
export function isValidSeedRelayJobId(jobId: string): boolean {
  return JOB_ID_RE.test(jobId);
}

/** The dedicated namespace of one job: `lamasync/seed/<jobId>/`. */
export function seedRelayNamespace(jobId: string): string {
  return `${SEED_OBJECT_KEY_PREFIX}/${jobId}/`;
}

/** The object key of one job's archive. Same key the job row carries. */
export function seedRelayArchiveKey(jobId: string, format: SeedArchiveFormat): string {
  return seedArchiveObjectKey(jobId, format);
}

export interface SeedRelayKeyVerdict {
  ok: boolean;
  /** Why the key is unusable, or null when it is fine. */
  error: string | null;
  /** The job the key belongs to, when it could be extracted. */
  jobId: string | null;
  /** True when the key is inside the seed namespace at all. */
  inNamespace: boolean;
}

/**
 * Validate an object key before ANY store call.
 *
 * The rules exist so a key can never escape the seed namespace: no absolute
 * path, no traversal, no backslash, no control character, no empty segment, and
 * exactly `lamasync/seed/<jobId>/<name>`. Every key the transport touches is
 * validated here first — including keys being DELETED, because "delete the key
 * the job reports" must not be a way to delete something else.
 */
export function validateSeedRelayObjectKey(
  key: string,
  expectedJobId?: string,
): SeedRelayKeyVerdict {
  const reject = (error: string, jobId: string | null = null, inNamespace = false): SeedRelayKeyVerdict => ({
    ok: false,
    error,
    jobId,
    inNamespace,
  });
  if (typeof key !== "string" || key.length === 0) return reject("the object key is empty");
  if (key.length > SEED_PATH_MAX_LENGTH) return reject("the object key is too long");
  if (key.startsWith("/") || key.startsWith("\\")) return reject("the object key is absolute");
  if (/^[A-Za-z]:/.test(key)) return reject("the object key is a Windows path");
  if (key.includes("\\")) return reject("the object key contains a backslash");
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return reject("the object key contains a control character");
  }
  const segments = key.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return reject("the object key has an empty path segment");
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return reject("the object key contains a traversal segment");
  }
  const inNamespace = key.startsWith(`${SEED_OBJECT_KEY_PREFIX}/`);
  if (!inNamespace) {
    return reject(`the object key is not inside the ${SEED_OBJECT_KEY_PREFIX}/ namespace`);
  }
  const prefixSegments = SEED_OBJECT_KEY_PREFIX.split("/");
  if (segments.length !== prefixSegments.length + 2) {
    return reject(
      `the object key must be exactly ${SEED_OBJECT_KEY_PREFIX}/<jobId>/<name>`,
      null,
      true,
    );
  }
  const jobId = segments[prefixSegments.length]!;
  if (!isValidSeedRelayJobId(jobId)) {
    return reject("the object key's job id is not a usable key segment", null, true);
  }
  if (expectedJobId !== undefined && jobId !== expectedJobId) {
    return reject(
      `the object key belongs to job ${jobId}, not ${expectedJobId}`,
      jobId,
      true,
    );
  }
  return { ok: true, error: null, jobId, inNamespace: true };
}

/** True when `key` is a valid object inside `jobId`'s namespace. */
export function seedRelayKeyBelongsToJob(key: string, jobId: string): boolean {
  return validateSeedRelayObjectKey(key, jobId).ok;
}

/**
 * Validate a LIST prefix before a store walks anything with it.
 *
 * A prefix is not a key: it may be the bare namespace (`lamasync/seed/`) or a
 * job's namespace (`lamasync/seed/<jobId>/`), so it is allowed to end in `/`
 * and to have fewer segments than a key. Everything else is the same rule — it
 * must be INSIDE the seed namespace, with no traversal, backslash, control
 * character, absolute start or empty interior segment — because a sweep must
 * never be able to walk (and therefore delete) outside it.
 */
export function validateSeedRelayPrefix(prefix: string): { ok: boolean; error: string | null } {
  if (typeof prefix !== "string" || prefix.length === 0) {
    return { ok: false, error: "the list prefix is empty" };
  }
  if (prefix.length > SEED_PATH_MAX_LENGTH) {
    return { ok: false, error: "the list prefix is too long" };
  }
  if (prefix.startsWith("/") || prefix.startsWith("\\") || /^[A-Za-z]:/.test(prefix)) {
    return { ok: false, error: "the list prefix is absolute" };
  }
  if (prefix.includes("\\")) return { ok: false, error: "the list prefix contains a backslash" };
  for (let i = 0; i < prefix.length; i += 1) {
    const code = prefix.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return { ok: false, error: "the list prefix contains a control character" };
    }
  }
  if (!prefix.startsWith(`${SEED_OBJECT_KEY_PREFIX}/`)) {
    return { ok: false, error: `the list prefix is not inside the ${SEED_OBJECT_KEY_PREFIX}/ namespace` };
  }
  const interior = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const segments = interior.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return { ok: false, error: "the list prefix has an empty path segment" };
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, error: "the list prefix contains a traversal segment" };
  }
  return { ok: true, error: null };
}

// ---------------------------------------------------------------------------
// Immutable archive metadata
// ---------------------------------------------------------------------------

/**
 * Everything the transport must agree on before a single byte is extracted.
 *
 * Immutable by construction: it is produced once, by the source, from the
 * archive it just wrote, and every later step COMPARES against it instead of
 * amending it. The target never trusts the store's own report — it re-hashes
 * the downloaded file and compares with these values.
 */
export interface SeedArchiveMetadata {
  jobId: string;
  objectKey: string;
  format: SeedArchiveFormat;
  /** Exact byte count of the archive. */
  bytes: number;
  /** SHA-256 of the archive, lowercase hex. */
  sha256: string;
  /** Content fingerprint of the manifest the archive was built from. */
  manifestFingerprint: string;
  /** Members the manifest required; the archive was proven to equal it. */
  memberCount: number;
  createdAt: number;
}

/** Why this metadata is not usable, or null when it is. */
export function seedArchiveMetadataProblem(metadata: SeedArchiveMetadata): string | null {
  const key = validateSeedRelayObjectKey(metadata.objectKey, metadata.jobId);
  if (!key.ok) return key.error;
  const expectedKey = seedRelayArchiveKey(metadata.jobId, metadata.format);
  if (metadata.objectKey !== expectedKey) {
    return `the object key ${metadata.objectKey} is not the archive key for this job (${expectedKey})`;
  }
  if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0) {
    return "the archive byte count is not a positive integer";
  }
  if (!SEED_SHA256_RE.test(metadata.sha256)) return "the archive SHA-256 is not a 64-character hex digest";
  if (!SEED_SHA256_RE.test(metadata.manifestFingerprint)) {
    return "the manifest fingerprint is not a 64-character hex digest";
  }
  if (!Number.isSafeInteger(metadata.memberCount) || metadata.memberCount <= 0) {
    return "the archive member count is not a positive integer";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manifest handoff — the source universe travels WITH the archive
// ---------------------------------------------------------------------------
//
// Stage 2b recorded a real gap rather than hiding it: the archive carries the
// member set and the digest, but the target never received the SOURCE MANIFEST
// itself, so a production target could not independently know what universe it
// was supposed to publish. In the Stage 2a/2b proofs both sides shared the
// manifest inside one test process.
//
// This is the fix at the contract level: the source uploads a canonical,
// immutable manifest document to `lamasync/seed/<jobId>/manifest.json` in the
// SAME temporary namespace as the archive, records its byte count and SHA-256
// alongside the archive facts, and the target downloads it, verifies the
// transit digest, RE-DERIVES the content fingerprint from the entries it
// received, and only then may extract. Nothing is trusted from the source: the
// target recomputes.
//
// The document is transport, not authority: the authority stays the archive
// facts the source recorded once. A manifest whose re-derived fingerprint does
// not equal the recorded `manifestFingerprint` is refused, exactly like a
// mismatched archive digest.

/** Object name of one job's manifest inside its seed namespace. */
export const SEED_RELAY_MANIFEST_NAME = "manifest.json";

/** The object key of one job's manifest: `lamasync/seed/<jobId>/manifest.json`. */
export function seedRelayManifestKey(jobId: string): string {
  return `${SEED_OBJECT_KEY_PREFIX}/${jobId}/${SEED_RELAY_MANIFEST_NAME}`;
}

/** One member of the transported manifest. Structurally the daemon's entry. */
export interface SeedManifestEntryDocument {
  /** Path relative to the source root, POSIX separators. */
  path: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  /** SHA-256 for regular files; null for directories. */
  sha256: string | null;
}

/**
 * The canonical manifest document that travels through the relay.
 *
 * `fingerprint` is the content identity the source computed (path + kind +
 * size + hash). The target must NOT trust it: it re-derives it from `entries`
 * with the same algorithm and refuses a mismatch, which is what makes the
 * handoff evidence rather than a claim.
 */
export interface SeedManifestDocument {
  version: 1;
  /** Content fingerprint, re-derived by the target from `entries`. */
  fingerprint: string;
  /** Effective filter universe the manifest was built from. */
  filterFingerprint: string;
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  entries: SeedManifestEntryDocument[];
}

/** Bound on how many members a transported manifest may carry. */
export const SEED_MANIFEST_ENTRY_LIMIT = 2_000_000;

/**
 * The exact, deterministic bytes of the content-identity input.
 *
 * This is the SAME string the daemon's `buildSeedManifest` hashes, kept here so
 * the algorithm has one description: `path\0kind\0size\0sha256-or-dash\n` per
 * entry, in manifest order. The daemon hashes it with SHA-256; core cannot
 * (it is dependency-free), so it exposes the input and the daemon owns the
 * digest.
 */
export function seedManifestContentDigestInput(
  entries: readonly SeedManifestEntryDocument[],
): string {
  let out = "";
  for (const entry of entries) {
    out += `${entry.path}\0${entry.kind}\0${entry.size}\0${entry.sha256 ?? "-"}\n`;
  }
  return out;
}

/**
 * Why this document is not a usable manifest, or null when it is.
 *
 * Fail closed on every field: an unknown version, a non-hex fingerprint, a
 * negative count, a member with a non-`file`/`dir` kind, a directory that
 * claims a hash, a file that has none, an absolute or traversal path, or an
 * entry count that disagrees with `entries` are all refusals. A target must
 * never extract against a document it cannot fully describe.
 */
export function seedManifestDocumentProblem(document: SeedManifestDocument): string | null {
  if (document.version !== 1) return "the transported manifest has an unknown version";
  if (!SEED_SHA256_RE.test(document.fingerprint)) {
    return "the transported manifest content fingerprint is not a 64-character hex digest";
  }
  if (!SEED_SHA256_RE.test(document.filterFingerprint)) {
    return "the transported manifest filter fingerprint is not a 64-character hex digest";
  }
  for (const [label, value] of [
    ["fileCount", document.fileCount],
    ["dirCount", document.dirCount],
    ["totalBytes", document.totalBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return `the transported manifest ${label} is not a non-negative integer`;
    }
  }
  if (!Array.isArray(document.entries)) return "the transported manifest has no member list";
  if (document.entries.length > SEED_MANIFEST_ENTRY_LIMIT) {
    return "the transported manifest has more members than a seed can describe";
  }
  if (document.entries.length !== document.fileCount + document.dirCount) {
    return "the transported manifest's member count does not match its file and directory counts";
  }
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  for (const entry of document.entries) {
    if (typeof entry !== "object" || entry === null) return "the transported manifest has a malformed member";
    if (entry.kind !== "file" && entry.kind !== "dir") {
      return "a transported manifest member is neither a file nor a directory";
    }
    if (typeof entry.path !== "string" || entry.path.length === 0 || entry.path.length > SEED_PATH_MAX_LENGTH) {
      return "a transported manifest member has an unusable path";
    }
    if (entry.path.startsWith("/") || entry.path.includes("\\") || entry.path.split("/").some((s) => s === "" || s === "." || s === "..")) {
      return `a transported manifest member path is not a safe relative path: ${entry.path.slice(0, 120)}`;
    }
    for (let i = 0; i < entry.path.length; i += 1) {
      const code = entry.path.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return "a transported manifest member path contains a control character";
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      return `a transported manifest member has an unusable size: ${entry.path.slice(0, 120)}`;
    }
    if (typeof entry.mtimeMs !== "number" || !Number.isFinite(entry.mtimeMs)) {
      return `a transported manifest member has an unusable modification time: ${entry.path.slice(0, 120)}`;
    }
    if (entry.kind === "file") {
      if (entry.sha256 === null || !SEED_SHA256_RE.test(entry.sha256)) {
        return `a transported manifest file member has no usable checksum: ${entry.path.slice(0, 120)}`;
      }
      files += 1;
      bytes += entry.size;
    } else {
      if (entry.sha256 !== null) {
        return `a transported manifest directory member carries a checksum: ${entry.path.slice(0, 120)}`;
      }
      dirs += 1;
    }
  }
  if (files !== document.fileCount || dirs !== document.dirCount) {
    return "the transported manifest's member kinds do not match its declared counts";
  }
  if (bytes !== document.totalBytes) {
    return "the transported manifest's total byte count does not match its members";
  }
  return null;
}

/**
 * Parse an untrusted manifest document, or return null.
 *
 * Never casts: an unknown shape becomes null and the caller fails closed. The
 * returned object is structurally validated by `seedManifestDocumentProblem`
 * so a caller can rely on every field.
 */
export function parseSeedManifestDocument(value: unknown): SeedManifestDocument | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1) return null;
  const fingerprint = record["fingerprint"];
  const filterFingerprint = record["filterFingerprint"];
  const fileCount = record["fileCount"];
  const dirCount = record["dirCount"];
  const totalBytes = record["totalBytes"];
  const rawEntries = record["entries"];
  if (typeof fingerprint !== "string" || typeof filterFingerprint !== "string") return null;
  if (typeof fileCount !== "number" || typeof dirCount !== "number" || typeof totalBytes !== "number") {
    return null;
  }
  if (!Array.isArray(rawEntries)) return null;
  const entries: SeedManifestEntryDocument[] = [];
  for (const raw of rawEntries) {
    if (typeof raw !== "object" || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    const path = entry["path"];
    const kind = entry["kind"];
    const size = entry["size"];
    const mtimeMs = entry["mtimeMs"];
    const sha256 = entry["sha256"];
    if (typeof path !== "string" || (kind !== "file" && kind !== "dir")) return null;
    if (typeof size !== "number" || typeof mtimeMs !== "number") return null;
    if (sha256 !== null && typeof sha256 !== "string") return null;
    entries.push({ path, kind, size, mtimeMs, sha256: sha256 ?? null });
  }
  const document: SeedManifestDocument = {
    version: 1,
    fingerprint,
    filterFingerprint,
    fileCount,
    dirCount,
    totalBytes,
    entries,
  };
  return seedManifestDocumentProblem(document) === null ? document : null;
}

/**
 * The immutable transport metadata of one job's manifest object.
 *
 * Written ONCE by the source from the document it just serialized. The target
 * downloads against these values; it never amends them.
 */
export interface SeedManifestMetadata {
  jobId: string;
  objectKey: string;
  /** Exact byte count of the serialized document. */
  bytes: number;
  /** SHA-256 of the serialized document, lowercase hex. */
  sha256: string;
  /** Content fingerprint carried inside the document. */
  contentFingerprint: string;
}

/** Why this manifest metadata is not usable, or null when it is. */
export function seedManifestMetadataProblem(metadata: SeedManifestMetadata): string | null {
  const key = validateSeedRelayObjectKey(metadata.objectKey, metadata.jobId);
  if (!key.ok) return key.error;
  if (metadata.objectKey !== seedRelayManifestKey(metadata.jobId)) {
    return `the object key ${metadata.objectKey} is not the manifest key for this job (${seedRelayManifestKey(metadata.jobId)})`;
  }
  if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0) {
    return "the manifest byte count is not a positive integer";
  }
  if (!SEED_SHA256_RE.test(metadata.sha256)) return "the manifest SHA-256 is not a 64-character hex digest";
  if (!SEED_SHA256_RE.test(metadata.contentFingerprint)) {
    return "the manifest content fingerprint is not a 64-character hex digest";
  }
  return null;
}

/** The subset a stored object can actually be checked against. */
export interface SeedArchiveObservation {
  bytes: number;
  sha256: string | null;
}

/**
 * Compare what we have (a store listing, a downloaded file) with the immutable
 * metadata. A mismatch in either direction is a failure, never a warning.
 */
export function seedArchiveMatchesMetadata(
  metadata: Pick<SeedArchiveMetadata, "bytes" | "sha256">,
  observed: SeedArchiveObservation,
): { ok: boolean; error: string | null } {
  if (observed.bytes !== metadata.bytes) {
    return {
      ok: false,
      error: `the archive is ${observed.bytes} bytes but ${metadata.bytes} were recorded`,
    };
  }
  if (observed.sha256 === null) {
    return { ok: false, error: "the archive's SHA-256 could not be read back" };
  }
  if (observed.sha256 !== metadata.sha256) {
    return { ok: false, error: "the archive's SHA-256 does not match the recorded digest" };
  }
  return { ok: true, error: null };
}

// ---------------------------------------------------------------------------
// The store contract
// ---------------------------------------------------------------------------

/** A stored object as the store reports it. */
export interface SeedRelayObjectHead {
  key: string;
  bytes: number;
  /**
   * SHA-256 the store reports, or null when the store cannot provide one. A
   * null here never counts as verification: the transport re-hashes the bytes
   * it actually moved.
   */
  sha256: string | null;
  storedAt: number;
}

export type SeedRelayPutSource =
  | { kind: "file"; path: string }
  | { kind: "bytes"; data: Uint8Array };

export interface SeedRelayProgress {
  bytesDone: number;
  bytesTotal: number | null;
}

/**
 * The result shape every store call returns.
 *
 * Stores never throw for an expected failure: a transport that has to wrap
 * every call in try/catch ends up guessing, and an exception message is exactly
 * where a credential leaks into a log. `notFound` is separate from a hard
 * failure because "already gone" is a SUCCESS for an idempotent cleanup.
 */
export type SeedRelayResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; notFound: boolean };

export function seedRelayFailure<T>(error: string, notFound = false): SeedRelayResult<T> {
  return { ok: false, error, notFound };
}

export function seedRelaySuccess<T>(value: T): SeedRelayResult<T> {
  return { ok: true, value };
}

/**
 * What the transport needs from an object store. Implemented by the local
 * object store (`seed-relay-local.ts`, also the integration-test fixture). A
 * configured S3 backend is deliberately NOT wired here: this task must not
 * touch real S3, an rclone config or a live host.
 */
export interface SeedRelayStore {
  /** Short, non-secret label for logs and diagnostics, e.g. `local-fs`. */
  readonly kind: string;
  /**
   * Store an object. Must refuse to overwrite an existing object whose content
   * differs (the metadata is immutable), and must verify the source against
   * `expected` while it streams.
   */
  put(input: {
    key: string;
    source: SeedRelayPutSource;
    expected: { bytes: number; sha256: string };
    signal?: AbortSignal;
    onProgress?: (progress: SeedRelayProgress) => void;
  }): Promise<SeedRelayResult<SeedRelayObjectHead>>;
  head(key: string): Promise<SeedRelayResult<SeedRelayObjectHead>>;
  /** Download to `destPath`, verifying against `expected` while it streams. */
  get(input: {
    key: string;
    destPath: string;
    expected: { bytes: number; sha256: string };
    signal?: AbortSignal;
    onProgress?: (progress: SeedRelayProgress) => void;
  }): Promise<SeedRelayResult<{ bytes: number; sha256: string }>>;
  /** Delete an object. Deleting something already absent is a SUCCESS. */
  delete(key: string): Promise<SeedRelayResult<{ deleted: boolean; alreadyAbsent: boolean }>>;
  /**
   * List object keys under a prefix (bounded by the caller).
   *
   * A store must NEVER follow a symbolic link while listing: a link is not an
   * object, so it is not returned as a key, and it is not descended into.
   * Anything it refused to follow is reported in `skippedSymlinks` instead of
   * being dropped silently, so a sweep can surface a planted link as a finding
   * rather than quietly walking past it.
   */
  list(prefix: string): Promise<SeedRelayResult<{ keys: string[]; skippedSymlinks: string[] }>>;
}

// ---------------------------------------------------------------------------
// Cleanup / retention state
// ---------------------------------------------------------------------------

/**
 * Should this job's objects be deleted now?
 *
 * A seed archive has no value after its job ends — the published tree does —
 * so cleanup is due the moment the job reaches a terminal phase. A job that is
 * still non-terminal keeps its objects: the target may still be downloading.
 * The abandoned window covers the other direction: a job row that is gone (or
 * that a caller cannot see) leaves objects behind, and they are reaped after
 * `retentionMs` measured from when the object was stored.
 */
export function seedRelayCleanupDue(input: {
  job: Pick<{ status: string; phase: string }, "status" | "phase"> | null;
  cleanup: SeedRelayCleanup;
  /** When the object was stored; only used when the job is unknown. */
  storedAt: number | null;
  now: number;
  retentionMs?: number;
}): { due: boolean; reason: string } {
  if (isSeedRelayCleanupComplete(input.cleanup)) {
    return { due: false, reason: "this job's seed objects are already cleaned up" };
  }
  const terminal = input.job !== null && isTerminalSeedStatus(input.job.status);
  if (terminal) {
    return { due: true, reason: "the job has ended, so its temporary seed objects are no longer needed" };
  }
  if (input.job === null) {
    const retentionMs = input.retentionMs ?? SEED_RELAY_ABANDONED_RETENTION_MS;
    if (input.storedAt === null) {
      return { due: false, reason: "the job is unknown and the object's age is unknown, so it is left alone" };
    }
    const age = input.now - input.storedAt;
    if (age >= retentionMs) {
      return {
        due: true,
        reason: `the job is gone and the object is ${Math.round(age / 3_600_000)} hours old, past the retention window`,
      };
    }
    return { due: false, reason: "the job is gone but the object is still inside the retention window" };
  }
  return { due: false, reason: "the job has not ended, so its objects may still be needed" };
}

function isTerminalSeedStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Keys in the seed namespace that no known job owns.
 *
 * The sweep is deliberately narrow: only keys inside `lamasync/seed/` are ever
 * candidates, an invalid key is reported rather than deleted, and the caller
 * decides what to do with the result. Nothing outside the namespace can be
 * reached through this function.
 *
 * A listing's `skippedSymlinks` is NOT passed here: a symbolic link is not an
 * object, so it is neither an orphan nor deletable. The caller should surface it
 * as a finding — a link inside the seed namespace is either an accident or an
 * attempt to redirect the relay, and in both cases the answer is a human, not a
 * deletion.
 */
export function seedRelayOrphanKeys(input: {
  listedKeys: readonly string[];
  knownJobIds: readonly string[];
  limit?: number;
}): { orphans: string[]; invalid: string[]; truncated: boolean } {
  const known = new Set(input.knownJobIds);
  const limit = input.limit ?? SEED_RELAY_SWEEP_LIMIT;
  const orphans: string[] = [];
  const invalid: string[] = [];
  let truncated = false;
  for (const key of input.listedKeys) {
    const verdict = validateSeedRelayObjectKey(key);
    if (!verdict.ok) {
      invalid.push(key);
      continue;
    }
    if (verdict.jobId === null || known.has(verdict.jobId)) continue;
    if (orphans.length >= limit) {
      truncated = true;
      continue;
    }
    orphans.push(key);
  }
  return { orphans, invalid, truncated };
}

/**
 * The bounded, credential-free sentence a caller may log or store. `kind` is
 * the store's own short label (`local-fs`), never an endpoint, bucket or key
 * material.
 */
export function describeSeedRelayFailure(storeKind: string, error: string): string {
  const bounded = error.replace(/\s+/g, " ").trim().slice(0, 200);
  return `${storeKind} seed relay: ${bounded}`;
}
