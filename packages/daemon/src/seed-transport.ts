// LAMA-346 Stage 1b — the seed archive transport: upload, download, cleanup.
//
// This is the orchestration the job state machine's transport phases will call.
// It is bounded on purpose: it moves ONE archive between ONE source and ONE
// target through a `SeedRelayStore`, verifies it at every hop, and deletes what
// it no longer needs. It does not decide whether a seed may run (the plan and
// the job do), it does not touch rclone, and it holds no credentials.
//
// The phases it owns, from `SEED_JOB_PHASES` (see `folder-seed.ts`):
//
//   uploading_archive  → `uploadSeedArchive`
//   downloading_archive / verifying_archive → `downloadSeedArchive`
//   (after any terminal phase) → `cleanupSeedRelayObjects`
//
// The invariants, all fail-closed:
//
//   * the archive is hashed BEFORE it is uploaded, and the digest the store
//     reports afterwards must match. A mismatch deletes the object and fails —
//     a wrong archive must never be handed to a target;
//   * the downloaded bytes are hashed AGAIN by this module, not trusted from the
//     store, and compared with the job's immutable metadata before the caller is
//     allowed to extract anything. A mismatch deletes the file;
//   * every key is validated for namespace containment before any store call,
//     including the keys being deleted;
//   * cleanup is idempotent: deleting an absent object is a success, a second
//     pass is a no-op, and a failure leaves a retryable `failed` state rather
//     than throwing;
//   * a failure path always tries to remove what it created (the uploaded
//     object, the downloaded file), and never reports success if that cleanup
//     itself failed silently.
//
// Production calls are reached only through the operator-authorized seed pilot
// and the job's role-scoped lease. This module itself has no policy authority:
// it receives an already-authorized relay store and never loads credentials.

import { existsSync, readFileSync, rmSync, statSync } from "fs";
import {
  SEED_EMPTY_FILTER_FINGERPRINT,
  SEED_SHA256_RE,
  canTransitionSeedPhase,
  describeSeedRelayFailure,
  emptySeedJobArchiveFacts,
  initialSeedRelayCleanup,
  isSeedRelayCleanupComplete,
  isTerminalSeedPhase,
  parseSeedManifestDocument,
  seedArchiveMatchesMetadata,
  seedArchiveMetadataProblem,
  seedManifestContentDigestInput,
  seedManifestDocumentProblem,
  seedManifestMetadataProblem,
  seedRelayArchiveKey,
  seedRelayManifestKey,
  validateSeedRelayObjectKey,
  type SeedArchiveFormat,
  type SeedArchiveMetadata,
  type SeedJobArchiveFacts,
  type SeedJobPhase,
  type SeedJobPhaseOrTerminal,
  type SeedManifestDocument,
  type SeedManifestMetadata,
  type SeedRelayCleanup,
  type SeedRelayProgress,
  type SeedRelayStore,
} from "@lamasync/core";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import type { SeedManifest } from "./seed-archive.ts";

export interface SeedTransportProgress {
  bytesDone: number;
  bytesTotal: number | null;
}

/** The three transport steps, and the job phase each one owns. */
export type SeedTransportStep = "upload" | "download" | "verify";

const STEP_PHASE: Record<SeedTransportStep, SeedJobPhase> = {
  upload: "uploading_archive",
  download: "downloading_archive",
  verify: "verifying_archive",
};

/**
 * May this step run now, and which phase does the caller record?
 *
 * The transport does not invent progress states: it names the phase it belongs
 * to and defers to the job state machine's own `canTransitionSeedPhase`. A
 * step that would SKIP a phase (an upload straight out of `preflight`) or run on
 * a job that already ended is refused, so the caller cannot drive the job into
 * a state the state machine would never have produced.
 */
export function seedTransportPhaseAllowed(
  current: SeedJobPhaseOrTerminal,
  step: SeedTransportStep,
): { ok: boolean; phase: SeedJobPhase; error: string | null } {
  const phase = STEP_PHASE[step];
  if (isTerminalSeedPhase(current)) {
    return { ok: false, phase, error: `this seed job has already ended (${current}), so ${step} cannot run` };
  }
  if (!canTransitionSeedPhase(current, phase)) {
    return {
      ok: false,
      phase,
      error: `the job is in phase ${current}, so ${step} (${phase}) would skip a phase of the seed state machine`,
    };
  }
  return { ok: true, phase, error: null };
}

function report(
  onProgress: ((progress: SeedTransportProgress) => void) | undefined,
  progress: SeedRelayProgress,
): void {
  onProgress?.({ bytesDone: progress.bytesDone, bytesTotal: progress.bytesTotal });
}

/**
 * Hash a file the way the transport does: from the bytes on disk, never from a
 * caller's claim and never from a store's report.
 */
export async function seedRelayFileDigest(path: string): Promise<{ bytes: number; sha256: string }> {
  const stat = statSync(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { bytes: stat.size, sha256: hash.digest("hex") };
}

/**
 * Remove a local file, never throwing.
 *
 * These calls run on the FAILURE path, where a throw would replace the real
 * error with a confusing one. A caller-provided path can also be in a state
 * where `rm` itself fails (a parent that is a file yields EFAULT on some
 * platforms), and that must not mask why the download was refused.
 */
function bestEffortRm(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // The caller is already reporting the real failure.
  }
}

// ---------------------------------------------------------------------------
// Source side: upload
// ---------------------------------------------------------------------------

export interface UploadSeedArchiveInput {
  store: SeedRelayStore;
  jobId: string;
  format: SeedArchiveFormat;
  /** Local path of the archive `createSeedArchive` just produced. */
  archivePath: string;
  /** Content fingerprint of the manifest the archive was proven to equal. */
  manifestFingerprint: string;
  memberCount: number;
  now: number;
  onProgress?: (progress: SeedTransportProgress) => void;
  signal?: AbortSignal;
}

export interface UploadSeedArchiveResult {
  ok: boolean;
  /** The archive facts to record on the job. Never contains a credential. */
  archive: SeedJobArchiveFacts;
  /** The immutable metadata the target will verify against, when the upload succeeded. */
  metadata: SeedArchiveMetadata | null;
  error: string | null;
}

/**
 * Hash the archive, store it, and prove the store holds what we sent.
 *
 * The digest is computed from the file on disk — never taken from the caller —
 * so a truncated or swapped archive cannot be described correctly by accident.
 * On any failure the object is deleted, so a failed upload never leaves a
 * partial archive for a target to find.
 */
export async function uploadSeedArchive(input: UploadSeedArchiveInput): Promise<UploadSeedArchiveResult> {
  const archive: SeedJobArchiveFacts = {
    ...emptySeedJobArchiveFacts(input.format),
    memberCount: input.memberCount,
    manifestFingerprint: input.manifestFingerprint,
  };
  const objectKey = seedRelayArchiveKey(input.jobId, input.format);
  const keyVerdict = validateSeedRelayObjectKey(objectKey, input.jobId);
  if (!keyVerdict.ok) {
    return { ok: false, archive, metadata: null, error: keyVerdict.error ?? "the archive key is not usable" };
  }
  if (!existsSync(input.archivePath)) {
    return { ok: false, archive, metadata: null, error: "the archive to upload does not exist" };
  }
  if (!SEED_SHA256_RE.test(input.manifestFingerprint)) {
    return {
      ok: false,
      archive,
      metadata: null,
      error: "the manifest fingerprint is not a 64-character hex digest, so the archive cannot be attributed to a manifest",
    };
  }

  let digest: { bytes: number; sha256: string };
  try {
    digest = await seedRelayFileDigest(input.archivePath);
  } catch (err) {
    return {
      ok: false,
      archive,
      metadata: null,
      error: describeSeedRelayFailure(input.store.kind, `the archive could not be read: ${err instanceof Error ? err.message : String(err)}`),
    };
  }
  if (digest.bytes <= 0) {
    return { ok: false, archive, metadata: null, error: "the archive is empty" };
  }

  const put = await input.store.put({
    key: objectKey,
    source: { kind: "file", path: input.archivePath },
    expected: digest,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onProgress ? { onProgress: (progress) => report(input.onProgress, progress) } : {}),
  });
  if (!put.ok) {
    await bestEffortDelete(input.store, objectKey);
    return {
      ok: false,
      archive,
      metadata: null,
      error: describeSeedRelayFailure(input.store.kind, put.error),
    };
  }

  // Read back what the store says it holds. A store that reports a different
  // size or digest is not a store this transport will hand to a target.
  const head = await input.store.head(objectKey);
  if (!head.ok) {
    await bestEffortDelete(input.store, objectKey);
    return {
      ok: false,
      archive,
      metadata: null,
      error: describeSeedRelayFailure(input.store.kind, head.error),
    };
  }
  const observed = { bytes: head.value.bytes, sha256: head.value.sha256 };
  const match = seedArchiveMatchesMetadata(digest, observed);
  if (!match.ok) {
    await bestEffortDelete(input.store, objectKey);
    return {
      ok: false,
      archive,
      metadata: null,
      error: describeSeedRelayFailure(
        input.store.kind,
        `${match.error ?? "the stored object does not match the archive"}; the object was removed`,
      ),
    };
  }

  const metadata: SeedArchiveMetadata = {
    jobId: input.jobId,
    objectKey,
    format: input.format,
    bytes: digest.bytes,
    sha256: digest.sha256,
    manifestFingerprint: input.manifestFingerprint,
    memberCount: input.memberCount,
    createdAt: input.now,
  };
  const problem = seedArchiveMetadataProblem(metadata);
  if (problem !== null) {
    await bestEffortDelete(input.store, objectKey);
    return { ok: false, archive, metadata: null, error: problem };
  }
  return {
    ok: true,
    archive: {
      ...archive,
      bytes: metadata.bytes,
      sha256: metadata.sha256,
      objectKey: metadata.objectKey,
      uploadedAt: input.now,
      cleanup: initialSeedRelayCleanup(),
    },
    metadata,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Target side: download
// ---------------------------------------------------------------------------

export interface DownloadSeedArchiveInput {
  store: SeedRelayStore;
  /** The job's IMMUTABLE archive facts, as recorded by the source. */
  archive: SeedJobArchiveFacts;
  jobId: string;
  /** Where to write the archive. Must be inside the target's staging area. */
  destPath: string;
  now: number;
  onProgress?: (progress: SeedTransportProgress) => void;
  signal?: AbortSignal;
}

export interface DownloadSeedArchiveResult {
  ok: boolean;
  bytes: number;
  sha256: string | null;
  /** The archive facts to record (with `verifiedAt` set) on success. */
  archive: SeedJobArchiveFacts;
  error: string | null;
}

/**
 * Download the archive and verify it against the job's recorded metadata.
 *
 * The caller MUST NOT extract anything until this returns `ok: true`: the file
 * at `destPath` is only trustworthy after the digest this module computed from
 * the bytes on disk matches the digest recorded when the archive was built. A
 * failure deletes the file, so a partial or wrong download cannot be mistaken
 * for an archive.
 */
export async function downloadSeedArchive(
  input: DownloadSeedArchiveInput,
): Promise<DownloadSeedArchiveResult> {
  const fail = (error: string): DownloadSeedArchiveResult => ({
    ok: false,
    bytes: 0,
    sha256: null,
    archive: input.archive,
    error: describeSeedRelayFailure(input.store.kind, error),
  });
  const { archive } = input;
  if (archive.bytes === null || archive.sha256 === null || archive.objectKey === null) {
    return fail("this job has no recorded archive metadata, so nothing can be verified");
  }
  if (!Number.isSafeInteger(archive.bytes) || archive.bytes <= 0) {
    return fail("the recorded archive byte count is not a positive integer");
  }
  if (!SEED_SHA256_RE.test(archive.sha256)) {
    return fail("the recorded archive SHA-256 is not a 64-character hex digest");
  }
  const keyVerdict = validateSeedRelayObjectKey(archive.objectKey, input.jobId);
  if (!keyVerdict.ok) return fail(keyVerdict.error ?? "the recorded archive key is not usable");
  const expectedKey = seedRelayArchiveKey(input.jobId, archive.format);
  if (archive.objectKey !== expectedKey) {
    return fail(`the recorded object key is not this job's archive key (${expectedKey})`);
  }

  const expected = { bytes: archive.bytes, sha256: archive.sha256 };
  const get = await input.store.get({
    key: archive.objectKey,
    destPath: input.destPath,
    expected,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onProgress ? { onProgress: (progress) => report(input.onProgress, progress) } : {}),
  });
  if (!get.ok) {
    bestEffortRm(input.destPath);
    return fail(get.error);
  }

  // Re-hash the bytes ON DISK. The store's own report is not evidence.
  let observed: { bytes: number; sha256: string };
  try {
    observed = await seedRelayFileDigest(input.destPath);
  } catch (err) {
    bestEffortRm(input.destPath);
    return fail(`the downloaded archive could not be read back: ${err instanceof Error ? err.message : String(err)}`);
  }
  const match = seedArchiveMatchesMetadata(expected, observed);
  if (!match.ok) {
    bestEffortRm(input.destPath);
    return fail(`${match.error ?? "the downloaded archive does not match"}; the download was removed`);
  }

  return {
    ok: true,
    bytes: observed.bytes,
    sha256: observed.sha256,
    archive: { ...archive, verifiedAt: input.now },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Source side: the manifest handoff
// ---------------------------------------------------------------------------

/**
 * Re-derive the content fingerprint of a member list.
 *
 * This MUST stay byte-for-byte identical to the daemon's `buildSeedManifest`:
 * `path\0kind\0size\0sha256-or-dash\n` per entry, in order. The target uses it
 * to check the manifest it received against the fingerprint the source
 * recorded, so a transport that mangled or reordered members is caught here
 * rather than by the following bisync. A dedicated test pins it against a real
 * `buildSeedManifest` result.
 */
export function seedManifestContentFingerprint(
  entries: SeedManifestDocument["entries"],
): string {
  return createHash("sha256").update(seedManifestContentDigestInput(entries)).digest("hex");
}

/** Project the daemon's in-memory manifest into the transported document. */
export function seedManifestToDocument(manifest: SeedManifest): SeedManifestDocument {
  return {
    version: 1,
    fingerprint: manifest.fingerprint,
    filterFingerprint:
      manifest.filter.fingerprint === SEED_EMPTY_FILTER_FINGERPRINT
        ? null
        : manifest.filter.fingerprint,
    fileCount: manifest.fileCount,
    dirCount: manifest.dirCount,
    totalBytes: manifest.totalBytes,
    entries: manifest.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      sha256: entry.sha256,
    })),
  };
}

/** Deterministic bytes for the document, so the digest is reproducible. */
export function serializeSeedManifestDocument(document: SeedManifestDocument): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(document));
}

export interface UploadSeedManifestInput {
  store: SeedRelayStore;
  jobId: string;
  manifest: SeedManifest;
  now: number;
  signal?: AbortSignal;
}

export interface UploadSeedManifestResult {
  ok: boolean;
  metadata: SeedManifestMetadata | null;
  error: string | null;
}

/**
 * Serialize the source manifest, store it in the job's seed namespace, and
 * prove the store holds what we sent.
 *
 * The document is validated BEFORE it is uploaded, so a manifest the target
 * could not trust is never put on the relay. On any failure the object is
 * deleted, exactly like a failed archive upload.
 */
export async function uploadSeedManifest(
  input: UploadSeedManifestInput,
): Promise<UploadSeedManifestResult> {
  const document = seedManifestToDocument(input.manifest);
  const problem = seedManifestDocumentProblem(document);
  if (problem !== null) {
    return { ok: false, metadata: null, error: `the source manifest cannot be transported: ${problem}` };
  }
  const objectKey = seedRelayManifestKey(input.jobId);
  const keyVerdict = validateSeedRelayObjectKey(objectKey, input.jobId);
  if (!keyVerdict.ok) {
    return { ok: false, metadata: null, error: keyVerdict.error ?? "the manifest key is not usable" };
  }
  const bytes = serializeSeedManifestDocument(document);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const expected = { bytes: bytes.byteLength, sha256 };

  const put = await input.store.put({
    key: objectKey,
    source: { kind: "bytes", data: bytes },
    expected,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!put.ok) {
    await bestEffortDelete(input.store, objectKey);
    return { ok: false, metadata: null, error: describeSeedRelayFailure(input.store.kind, put.error) };
  }
  const head = await input.store.head(objectKey);
  if (!head.ok) {
    await bestEffortDelete(input.store, objectKey);
    return { ok: false, metadata: null, error: describeSeedRelayFailure(input.store.kind, head.error) };
  }
  const match = seedArchiveMatchesMetadata(expected, { bytes: head.value.bytes, sha256: head.value.sha256 });
  if (!match.ok) {
    await bestEffortDelete(input.store, objectKey);
    return {
      ok: false,
      metadata: null,
      error: describeSeedRelayFailure(
        input.store.kind,
        `${match.error ?? "the stored manifest does not match"}; the object was removed`,
      ),
    };
  }
  const metadata: SeedManifestMetadata = {
    jobId: input.jobId,
    objectKey,
    bytes: expected.bytes,
    sha256,
    contentFingerprint: document.fingerprint,
  };
  const metadataProblem = seedManifestMetadataProblem(metadata);
  if (metadataProblem !== null) {
    await bestEffortDelete(input.store, objectKey);
    return { ok: false, metadata: null, error: metadataProblem };
  }
  return { ok: true, metadata, error: null };
}

// ---------------------------------------------------------------------------
// Target side: the manifest handoff
// ---------------------------------------------------------------------------

export interface DownloadSeedManifestInput {
  store: SeedRelayStore;
  /** The job's IMMUTABLE archive facts, which carry the manifest metadata. */
  archive: SeedJobArchiveFacts;
  jobId: string;
  /** Where to write the document. Must be inside the target's staging area. */
  destPath: string;
  signal?: AbortSignal;
}

export interface DownloadSeedManifestResult {
  ok: boolean;
  /** The re-verified document, or null. */
  document: SeedManifestDocument | null;
  error: string | null;
}

/**
 * Download the source manifest and RE-DERIVE its content fingerprint.
 *
 * Three independent checks, all fail-closed:
 *   1. the bytes on disk must hash to the digest the source recorded;
 *   2. the document must parse and validate;
 *   3. the fingerprint re-derived from the received entries must equal BOTH the
 *      recorded `manifestFingerprint` AND the fingerprint the document claims.
 *
 * Only then may the caller extract. The source's own report is never evidence:
 * the target recomputes. A failure deletes the download.
 */
export async function downloadSeedManifest(
  input: DownloadSeedManifestInput,
): Promise<DownloadSeedManifestResult> {
  const fail = (error: string): DownloadSeedManifestResult => ({
    ok: false,
    document: null,
    error: describeSeedRelayFailure(input.store.kind, error),
  });
  const { archive } = input;
  if (archive.manifestObjectKey === null || archive.manifestBytes === null || archive.manifestSha256 === null) {
    return fail("this job has no recorded source manifest, so the target cannot know the source universe");
  }
  if (archive.manifestFingerprint === null) {
    return fail("this job recorded no manifest content fingerprint to verify against");
  }
  const expectedKey = seedRelayManifestKey(input.jobId);
  if (archive.manifestObjectKey !== expectedKey) {
    return fail(`the recorded manifest object key is not this job's manifest key (${expectedKey})`);
  }
  const keyVerdict = validateSeedRelayObjectKey(archive.manifestObjectKey, input.jobId);
  if (!keyVerdict.ok) return fail(keyVerdict.error ?? "the recorded manifest key is not usable");

  const expected = { bytes: archive.manifestBytes, sha256: archive.manifestSha256 };
  const get = await input.store.get({
    key: archive.manifestObjectKey,
    destPath: input.destPath,
    expected,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!get.ok) {
    bestEffortRm(input.destPath);
    return fail(get.error);
  }

  let onDisk: { bytes: number; sha256: string };
  let text: string;
  try {
    onDisk = await seedRelayFileDigest(input.destPath);
    text = readFileSync(input.destPath, "utf8");
  } catch (err) {
    bestEffortRm(input.destPath);
    return fail(`the downloaded manifest could not be read back: ${err instanceof Error ? err.message : String(err)}`);
  }
  const match = seedArchiveMatchesMetadata(expected, onDisk);
  if (!match.ok) {
    bestEffortRm(input.destPath);
    return fail(`${match.error ?? "the downloaded manifest does not match"}; the download was removed`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    bestEffortRm(input.destPath);
    return fail("the transported manifest is not valid JSON");
  }
  const document = parseSeedManifestDocument(parsed);
  if (document === null) {
    bestEffortRm(input.destPath);
    return fail("the transported manifest failed validation");
  }
  const derived = seedManifestContentFingerprint(document.entries);
  if (derived !== document.fingerprint) {
    bestEffortRm(input.destPath);
    return fail("the transported manifest's content fingerprint does not match the members it carries");
  }
  if (derived !== archive.manifestFingerprint) {
    bestEffortRm(input.destPath);
    return fail("the transported manifest describes a different universe than the job recorded");
  }
  return { ok: true, document, error: null };
}

// ---------------------------------------------------------------------------
// Cleanup / retention
// ---------------------------------------------------------------------------

export interface CleanupSeedRelayInput {
  store: SeedRelayStore;
  /** Keys to remove. Each must be inside a seed namespace or it is refused. */
  keys: readonly string[];
  /** The job's current cleanup state; the returned state is the new one. */
  cleanup: SeedRelayCleanup;
  now: number;
}

export interface CleanupSeedRelayResult {
  cleanup: SeedRelayCleanup;
  deleted: string[];
  /** True when nothing is left to delete for this job. */
  complete: boolean;
  error: string | null;
}

/**
 * Delete a job's seed objects. Idempotent by construction.
 *
 * * an object that is already gone is a SUCCESS, so re-running after a partial
 *   failure finishes the job instead of reporting a phantom error;
 * * a key outside the seed namespace is refused, not deleted — "delete the key
 *   the job reports" must never be a way to delete something else;
 * * a second pass over an already-`cleaned` job is a no-op;
 * * a failure records a bounded reason and leaves the state retryable, and it
 *   never throws: cleanup runs on the failure path too, where an exception
 *   would mask the original error.
 */
export async function cleanupSeedRelayObjects(
  input: CleanupSeedRelayInput,
): Promise<CleanupSeedRelayResult> {
  const alreadyDeleted = new Set(input.cleanup.deletedKeys);
  if (isSeedRelayCleanupComplete(input.cleanup)) {
    return { cleanup: input.cleanup, deleted: [], complete: true, error: null };
  }

  const deleted = [...input.cleanup.deletedKeys];
  const failures: string[] = [];
  for (const key of input.keys) {
    if (alreadyDeleted.has(key)) continue;
    const verdict = validateSeedRelayObjectKey(key);
    if (!verdict.ok) {
      failures.push(`${key}: ${verdict.error ?? "the key is not usable"}`);
      continue;
    }
    let result: Awaited<ReturnType<SeedRelayStore["delete"]>>;
    try {
      result = await input.store.delete(key);
    } catch (err) {
      // A store that throws must not turn cleanup into an exception: cleanup
      // runs on the failure path too, where a throw would mask the real error.
      failures.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (result.ok) {
      deleted.push(key);
      alreadyDeleted.add(key);
      continue;
    }
    if (result.notFound) {
      // Already gone is success: that is what makes this idempotent.
      deleted.push(key);
      alreadyDeleted.add(key);
      continue;
    }
    failures.push(`${key}: ${result.error}`);
  }

  const attempts = input.cleanup.attempts + 1;
  if (failures.length === 0) {
    return {
      cleanup: {
        state: "cleaned",
        attempts,
        lastAttemptAt: input.now,
        deletedKeys: deleted,
        message: null,
      },
      deleted,
      complete: true,
      error: null,
    };
  }
  const error = describeSeedRelayFailure(input.store.kind, failures[0]!);
  return {
    cleanup: {
      state: "failed",
      attempts,
      lastAttemptAt: input.now,
      deletedKeys: deleted,
      message: error.slice(0, 240),
    },
    deleted,
    complete: false,
    error,
  };
}

/**
 * Delete a job's objects after a failure, without letting a cleanup problem
 * hide the original error. Returns the state to record (or the previous state
 * when there was nothing to do).
 */
export async function cleanupAfterFailure(input: {
  store: SeedRelayStore;
  keys: readonly string[];
  cleanup: SeedRelayCleanup;
  now: number;
}): Promise<SeedRelayCleanup> {
  const result = await cleanupSeedRelayObjects(input);
  return result.cleanup;
}

/** Best-effort single-object delete used on failure paths. Never throws. */
async function bestEffortDelete(store: SeedRelayStore, key: string): Promise<void> {
  const verdict = validateSeedRelayObjectKey(key);
  if (!verdict.ok) return;
  try {
    await store.delete(key);
  } catch {
    // The caller is already reporting a failure; a second one adds nothing and
    // could leak a store detail into the log.
  }
}
