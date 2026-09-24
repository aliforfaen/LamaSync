// LAMA-346 Stage 2f — the seed pilot's server-side storage, host-scoped
// delivery and readiness probe.
//
// Three responsibilities, deliberately in one module because they are one
// contract:
//
//   1. STORAGE. One row (`id = 'default'`) holds the operator's authorization:
//      one folder, one source/target pair, one EXISTING S3 backend row, one
//      bucket. No credential is stored here — the backend row already owns it.
//      Every write bumps a monotonic `config_revision`, which is what lets a
//      probe's verdict be recorded with a COMPARE-AND-SET instead of landing on
//      whatever configuration happens to be current when the probe finishes.
//   2. DELIVERY. `seedRelaySpaceForHost` resolves and DECRYPTS the backend's
//      secret for exactly the hosts that may use it: the two parties of a
//      NON-TERMINAL seed job of the pilot-authorized folder, and only while the
//      readiness verdict is CURRENT for the exact backend+bucket. It is returned
//      inside the device's own authenticated host config and nowhere else.
//   3. READINESS. `probeSeedRelayBucket` proves the configured backend can
//      actually UPLOAD (including MULTIPART, which a 14.86 GB archive needs),
//      READ BACK the exact bytes, and DELETE. Its verdict is bound to a
//      fingerprint of the probed target, so rotating a key, moving an endpoint
//      or repointing the pilot invalidates it — a stale `ready` authorizes
//      nothing.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  seedPilotExecutionEligibility,
  seedPilotReadinessVerdict,
  type SeedPilotConfig,
  type SeedPilotEligibility,
  type SeedPilotProbeOutcome,
  type SeedPilotReadinessState,
  type SeedRelaySpace,
  type SeedPilotRole,
} from "@lamasync/core";
import { decryptSecret } from "./crypto.ts";
import { isS3Provider } from "./backends.ts";

interface SeedPilotRow {
  enabled: number;
  folder_id: string | null;
  source_host_id: string | null;
  target_host_id: string | null;
  backend_id: string | null;
  bucket: string | null;
  readiness_state: string;
  readiness_bucket: string | null;
  readiness_checked_at: number | null;
  readiness_message: string | null;
  readiness_target_fingerprint: string | null;
  config_revision: number;
  updated_at: number;
}

const SEED_PILOT_SELECT = `SELECT enabled, folder_id, source_host_id, target_host_id, backend_id, bucket,
       readiness_state, readiness_bucket, readiness_checked_at, readiness_message,
       readiness_target_fingerprint, config_revision, updated_at
  FROM seed_pilot_config WHERE id = 'default'`;

function readinessState(value: string): SeedPilotReadinessState {
  return value === "ready" || value === "failed" ? value : "unknown";
}

function rowToSeedPilotConfig(row: SeedPilotRow): SeedPilotConfig {
  return {
    enabled: row.enabled === 1,
    folderId: row.folder_id,
    sourceHostId: row.source_host_id,
    targetHostId: row.target_host_id,
    backendId: row.backend_id,
    bucket: row.bucket,
    updatedAt: row.updated_at,
    readiness: {
      state: readinessState(row.readiness_state),
      bucket: row.readiness_bucket,
      checkedAt: row.readiness_checked_at,
      message: row.readiness_message,
      targetFingerprint: row.readiness_target_fingerprint,
    },
  };
}

/** The stored pilot, or null when the operator has never configured one. */
export function getSeedPilotConfig(database: Database): SeedPilotConfig | null {
  const row = database.query<SeedPilotRow, []>(SEED_PILOT_SELECT).get();
  return row ? rowToSeedPilotConfig(row) : null;
}

/** The stored pilot's revision, or null. Read before a probe, compared after. */
export function getSeedPilotRevision(database: Database): number | null {
  const row = database
    .query<{ config_revision: number }, []>("SELECT config_revision FROM seed_pilot_config WHERE id = 'default'")
    .get();
  return row?.config_revision ?? null;
}

/**
 * Write the pilot. Every write bumps `config_revision`.
 *
 * Enabling it (or changing its scope) RESETS the readiness verdict, because a
 * verdict about a different bucket — or a different backend, or the same backend
 * before a key rotation — must never authorize the new one. The verdict survives
 * only when the pilot is being DISABLED with the same backend and bucket, which
 * is a state change rather than a reconfiguration.
 */
export function setSeedPilotConfig(
  database: Database,
  input: {
    enabled: boolean;
    folderId: string | null;
    sourceHostId: string | null;
    targetHostId: string | null;
    backendId: string | null;
    bucket: string | null;
    now?: number;
  },
): SeedPilotConfig {
  const now = input.now ?? Date.now();
  const existing = getSeedPilotConfig(database);
  const sameTarget =
    existing !== null && existing.backendId === input.backendId && existing.bucket === input.bucket;
  const keepVerdict = !input.enabled && sameTarget && existing !== null;
  database.run(
    `INSERT INTO seed_pilot_config
       (id, enabled, folder_id, source_host_id, target_host_id, backend_id, bucket,
        readiness_state, readiness_bucket, readiness_checked_at, readiness_message,
        readiness_target_fingerprint, config_revision, updated_at)
     VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       folder_id = excluded.folder_id,
       source_host_id = excluded.source_host_id,
       target_host_id = excluded.target_host_id,
       backend_id = excluded.backend_id,
       bucket = excluded.bucket,
       readiness_state = excluded.readiness_state,
       readiness_bucket = excluded.readiness_bucket,
       readiness_checked_at = excluded.readiness_checked_at,
       readiness_message = excluded.readiness_message,
       readiness_target_fingerprint = excluded.readiness_target_fingerprint,
       config_revision = seed_pilot_config.config_revision + 1,
       updated_at = excluded.updated_at`,
    [
      input.enabled ? 1 : 0,
      input.folderId,
      input.sourceHostId,
      input.targetHostId,
      input.backendId,
      input.bucket,
      keepVerdict ? existing.readiness.state : "unknown",
      keepVerdict ? existing.readiness.bucket : null,
      keepVerdict ? existing.readiness.checkedAt : null,
      keepVerdict ? existing.readiness.message : null,
      keepVerdict ? existing.readiness.targetFingerprint : null,
      now,
    ],
  );
  const stored = getSeedPilotConfig(database);
  if (stored === null) throw new Error("the seed pilot could not be read back after writing it");
  return stored;
}

/** Turn the pilot off and clear its scope. The row is kept so `updatedAt` survives. */
export function clearSeedPilotConfig(database: Database, now: number = Date.now()): SeedPilotConfig {
  return setSeedPilotConfig(database, {
    enabled: false,
    folderId: null,
    sourceHostId: null,
    targetHostId: null,
    backendId: null,
    bucket: null,
    now,
  });
}

/**
 * Record a probe's verdict against the EXACT configuration it was run for.
 *
 * The compare-and-set is the whole point: a probe awaits a network round trip,
 * and an operator can reconfigure the pilot (or rotate the backend) while it is
 * in flight. Without this, pilot A's outcome could be stored as pilot B's
 * readiness — a false `ready` for a bucket nobody probed. When any part of the
 * identity moved, the result is DISCARDED and the current row keeps its own
 * (reset) verdict, which authorizes nothing.
 */
export type SeedPilotReadinessRecordResult =
  | { ok: true; config: SeedPilotConfig }
  | { ok: false; reason: string; config: SeedPilotConfig | null };

export function recordSeedPilotReadiness(
  database: Database,
  input: {
    /** The revision read BEFORE the probe started. */
    configRevision: number;
    backendId: string | null;
    bucket: string | null;
    /** The bucket the verdict is about (the same value, or null when unknown). */
    verdictBucket: string | null;
    targetFingerprint: string | null;
    outcome: SeedPilotProbeOutcome;
    now?: number;
  },
): SeedPilotReadinessRecordResult {
  const now = input.now ?? Date.now();

  // Second half of the compare-and-set, and the one the revision cannot see: the
  // BACKEND may have been rotated (endpoint, region, key or secret) while the
  // probe ran. A verdict about a target that no longer exists must not be
  // stored, or it would look like a fresh pass for the new one.
  if (input.targetFingerprint !== null) {
    if (liveSeedRelayTargetFingerprint(database) !== input.targetFingerprint) {
      return {
        ok: false,
        reason:
          "The seed pilot changed while the probe was running, so the verdict was discarded. " +
          "Run Test seed space again for the current configuration.",
        config: getSeedPilotConfig(database),
      };
    }
  }

  const verdict = seedPilotReadinessVerdict(
    input.verdictBucket,
    input.targetFingerprint,
    input.outcome,
    now,
  );
  const result = database.run(
    `UPDATE seed_pilot_config
        SET readiness_state = ?, readiness_bucket = ?, readiness_checked_at = ?, readiness_message = ?,
            readiness_target_fingerprint = ?, updated_at = ?
      WHERE id = 'default' AND enabled = 1 AND config_revision = ?
        AND backend_id IS ? AND bucket IS ?`,
    [
      verdict.state,
      verdict.bucket,
      verdict.checkedAt,
      verdict.message,
      verdict.targetFingerprint,
      now,
      input.configRevision,
      input.backendId,
      input.bucket,
    ],
  );
  const stored = getSeedPilotConfig(database);
  if (Number(result.changes ?? 0) === 0) {
    return {
      ok: false,
      reason:
        "The seed pilot changed while the probe was running, so the verdict was discarded. " +
        "Run Test seed space again for the current configuration.",
      config: stored,
    };
  }
  if (stored === null) return { ok: false, reason: "the seed pilot row disappeared during the probe", config: null };
  return { ok: true, config: stored };
}

/** The backend settings a probe needs, resolved and decrypted on the server. */
export interface SeedRelayProbeTarget {
  provider: string;
  endpoint: string;
  region: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export type SeedRelayProbeResolveResult =
  | { ok: true; target: SeedRelayProbeTarget }
  | { ok: false; error: string };

interface BackendS3Row {
  kind: string;
  s3_provider: string | null;
  s3_endpoint: string | null;
  s3_region: string | null;
  s3_access_key_id: string | null;
  s3_secret_key_enc: string | null;
}

const BACKEND_S3_SELECT =
  "SELECT kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc FROM backends WHERE id = ?";

function targetFromBackendRow(row: BackendS3Row, bucket: string): SeedRelayProbeTarget | null {
  const endpoint = (row.s3_endpoint ?? "").trim();
  const accessKeyId = (row.s3_access_key_id ?? "").trim();
  const secretAccessKey = decryptSecret(row.s3_secret_key_enc) ?? "";
  if (endpoint.length === 0 || accessKeyId.length === 0 || secretAccessKey.length === 0) return null;
  return {
    provider: isS3Provider(row.s3_provider) ? row.s3_provider : "other",
    endpoint,
    region: (row.s3_region ?? "").trim() || null,
    accessKeyId,
    secretAccessKey,
    bucket,
  };
}

/**
 * A one-way fingerprint of the EXACT probe target.
 *
 * It covers everything that changes what "this seed space" MEANS: the provider,
 * the endpoint, the region, the access key id, the bucket, and a hash of the
 * secret (never the secret itself — a rotated key changes the fingerprint, and
 * the stored value is useless to anyone who reads the database). This is what
 * makes a verdict invalidate itself when a backend is rotated without the pilot
 * being touched.
 */
export function seedRelayTargetFingerprint(target: SeedRelayProbeTarget): string {
  const secretHash = createHash("sha256").update(target.secretAccessKey, "utf8").digest("hex");
  return createHash("sha256")
    .update(
      [
        "seed-relay-target/1",
        target.provider,
        target.endpoint,
        target.region ?? "",
        target.accessKeyId,
        secretHash,
        target.bucket,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
}

/**
 * The fingerprint of the pilot's CURRENT backend+bucket, or null when it cannot
 * be resolved (disabled pilot, missing backend, non-S3 kind, incomplete
 * credentials). `null` never matches a stored fingerprint, so an unresolvable
 * target always fails closed.
 */
export function liveSeedRelayTargetFingerprint(database: Database): string | null {
  const pilot = getSeedPilotConfig(database);
  if (pilot === null || !pilot.enabled || pilot.backendId === null || pilot.bucket === null) return null;
  const row = database.query<BackendS3Row, [string]>(BACKEND_S3_SELECT).get(pilot.backendId);
  if (!row || row.kind !== "s3") return null;
  const target = targetFromBackendRow(row, pilot.bucket);
  return target === null ? null : seedRelayTargetFingerprint(target);
}

/**
 * The full execution verdict for one folder+pair, read from the database.
 *
 * This is the function every gate uses, because the readiness half needs the
 * LIVE backend fingerprint and only the server can resolve that.
 */
export function seedPilotEligibilityForFolderPair(
  database: Database,
  request: { folderId: string; sourceHostId: string; targetHostId: string },
): SeedPilotEligibility {
  return seedPilotExecutionEligibility(
    getSeedPilotConfig(database),
    request,
    liveSeedRelayTargetFingerprint(database),
  );
}

/**
 * Resolve the pilot's backend into probe settings.
 *
 * The refusals are specific on purpose: "the backend is missing", "it is not an
 * S3 backend", "it has no stored secret" and "it has no endpoint" are four
 * different operator mistakes, and collapsing them into one message would send
 * the operator looking in the wrong place.
 */
export function resolveSeedRelayProbeTarget(database: Database): SeedRelayProbeResolveResult {
  const pilot = getSeedPilotConfig(database);
  if (pilot === null || !pilot.enabled) {
    return { ok: false, error: "The seed pilot is not enabled, so there is no seed space to probe." };
  }
  if (pilot.backendId === null || pilot.bucket === null) {
    return { ok: false, error: "The seed pilot does not name a storage backend and bucket." };
  }
  const row = database.query<BackendS3Row, [string]>(BACKEND_S3_SELECT).get(pilot.backendId);
  if (!row) {
    return { ok: false, error: `The seed pilot references a storage backend that no longer exists (${pilot.backendId}).` };
  }
  if (row.kind !== "s3") {
    return { ok: false, error: "The seed pilot's storage backend is not an S3 backend, so it cannot hold the temporary seed space." };
  }
  const endpoint = (row.s3_endpoint ?? "").trim();
  if (endpoint.length === 0) return { ok: false, error: "The seed pilot's storage backend has no S3 endpoint configured." };
  const target = targetFromBackendRow(row, pilot.bucket);
  if (target === null) {
    return { ok: false, error: "The seed pilot's storage backend has no stored S3 access key." };
  }
  return { ok: true, target };
}

/** The remote name the probe's temporary rclone config uses. Never persisted. */
const PROBE_REMOTE = "seedspace";

function probeRcloneConfig(target: SeedRelayProbeTarget): string {
  const lines = [`[${PROBE_REMOTE}]`, "type = s3", `provider = ${target.provider}`, `access_key_id = ${target.accessKeyId}`];
  lines.push(`secret_access_key = ${target.secretAccessKey}`);
  lines.push(`endpoint = ${target.endpoint}`);
  // A typo must not create a new bucket without the temporary bucket's
  // lifecycle rule when the backend key also has bucket-management access.
  lines.push("no_check_bucket = true");
  if (target.region !== null && target.region.length > 0) lines.push(`region = ${target.region}`);
  return `${lines.join("\n")}\n`;
}

async function withProbeConfig<T>(
  target: SeedRelayProbeTarget,
  fn: (configPath: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "lamasync-seedspace-"));
  const configPath = join(dir, "rclone.conf");
  writeFileSync(configPath, probeRcloneConfig(target), { mode: 0o600 });
  try {
    return await fn(configPath);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort: nothing useful to do if a private temp dir will not go away
    }
  }
}

/**
 * Bound and de-credential a probe's stderr before it is ever stored or shown.
 *
 * The redaction is LITERAL, not a pattern: the caller knows the exact access key
 * id and secret it used, so both are replaced by name. A shape-based regex was
 * tried first and mangled ordinary diagnostics ("…StatusCode: 0…" looked like a
 * `key:secret` pair), which makes a failure reason worse than useless.
 *
 * The endpoint and the object key are NOT credentials, and they are exactly what
 * distinguishes "the bucket does not exist" from "access denied", so they are
 * kept.
 */
export function boundedProbeDetail(
  stderr: string,
  fallback: string,
  credentials: { secret?: string; accessKeyId?: string } = {},
): string {
  const line = stderr.trim().split("\n").map((l) => l.trim()).filter((l) => l.length > 0).pop() ?? "";
  if (line.length === 0) return fallback;
  let scrubbed = line;
  for (const value of [credentials.secret, credentials.accessKeyId]) {
    if (value !== undefined && value.length > 0) scrubbed = scrubbed.split(value).join("[redacted]");
  }
  return scrubbed.slice(0, 300);
}

/**
 * How long ONE probe command may take, and how long the WHOLE probe may take.
 *
 * A readiness probe runs inside an admin request, so it must ANSWER: a wrong
 * endpoint (or a bucket that hangs) has to produce a verdict rather than an
 * indefinitely pending request. The retry counts are pinned to 1 so rclone's
 * default backoff cannot stretch a failure into minutes, and the overall budget
 * bounds the sum of the steps below.
 */
const PROBE_COMMAND_TIMEOUT_MS = 20_000;
const PROBE_TOTAL_BUDGET_MS = 90_000;
const PROBE_RETRY_FLAGS = ["--retries", "1", "--low-level-retries", "1", "--contimeout", "5s", "--timeout", "15s"];

/** Force rclone into a MULTIPART upload for the probe object. */
const PROBE_MULTIPART_FLAGS = ["--s3-upload-cutoff", "5M", "--s3-chunk-size", "5M"];
/** Above the 5 MiB cutoff above, so rclone really uses more than one part. */
const PROBE_OBJECT_BYTES = 6 * 1024 * 1024;

interface ProbeCommandResult {
  ok: boolean;
  /**
   * stdout as BYTES, never as a decoded string: `rclone cat` streams raw object
   * bytes, and a lossy UTF-8 decode would make any binary object look corrupt
   * (the first version of this probe compared a decoded digest with the written
   * one and reported a false "not trustworthy"). Text consumers decode it
   * themselves.
   */
  stdoutBytes: Uint8Array;
  stderr: string;
  timedOut: boolean;
  /** True when the command could not even be started (e.g. rclone is absent). */
  spawnFailed: boolean;
}

/** Run one probe command, killed if it overruns. Never throws. */
async function runProbeCommand(args: string[], configPath: string, timeoutMs: number): Promise<ProbeCommandResult> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["rclone", ...args, "--config", configPath, ...PROBE_RETRY_FLAGS], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    // A missing or unexecutable rclone is a FAILED READINESS, never a 500: the
    // operator needs a verdict, and the sentence must not echo a path.
    return { ok: false, stdoutBytes: new Uint8Array(), stderr: "", timedOut: false, spawnFailed: true };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // already gone
    }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: exitCode === 0, stdoutBytes: new Uint8Array(stdout), stderr, timedOut, spawnFailed: false };
  } catch {
    return { ok: false, stdoutBytes: new Uint8Array(), stderr: "", timedOut, spawnFailed: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Decode a probe command's stdout for the commands that produce text. */
function probeStdoutText(result: ProbeCommandResult): string {
  return new TextDecoder().decode(result.stdoutBytes);
}

function sha256HexOf(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic, non-secret probe bytes (no compression, no repetition of use). */
function probeBytes(length: number): Buffer {
  const out = Buffer.alloc(length);
  let x = 0x9e3779b9;
  for (let i = 0; i < length; i += 1) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

/**
 * Prove the configured backend can do everything a seed needs.
 *
 * Deliberately bucket-scoped. `rclone lsd test:` (the generic backend test)
 * lists every bucket in the account, so a key that is scoped to one bucket
 * fails it while working perfectly for the seed space — that is exactly the
 * "existing backend credentials may be bucket-scoped" case.
 *
 * The steps, in order, and what each one proves:
 *
 *   1. UPLOAD a probe object WITH MULTIPART FORCED (`--s3-upload-cutoff 5M`,
 *      `--s3-chunk-size 5M`, a 6 MiB object). A seed archive is routinely larger
 *      than Backblaze's 5 GB single-request ceiling, so a key that can only do
 *      simple PUTs is NOT ready — this step is what fails it.
 *   2. SIZE it back (`rclone size --json`) — the object is readable and its
 *      length is what was written.
 *   3. READ IT BACK (`rclone cat`) and compare the SHA-256 with the bytes
 *      written. A store that cannot GET is not a store a target can download
 *      from, and a store that returns different bytes is worse.
 *   4. DELETE it. A seed must be able to clean up after itself.
 *
 * Every step is bounded, the whole probe is bounded, and this function NEVER
 * throws: any failure — including rclone being missing — becomes a failed
 * verdict with a bounded, credential-free reason.
 */
export async function probeSeedRelayBucket(target: SeedRelayProbeTarget): Promise<SeedPilotProbeOutcome> {
  const deadline = Date.now() + PROBE_TOTAL_BUDGET_MS;
  const remaining = (): number => Math.max(1_000, Math.min(PROBE_COMMAND_TIMEOUT_MS, deadline - Date.now()));
  // Every sentence a probe produces is capped, because this value is stored and
  // rendered by the admin UI.
  const fail = (detail: string): SeedPilotProbeOutcome => ({ ok: false, detail: detail.slice(0, 300) });
  const describe = (step: string, result: ProbeCommandResult, fallback: string): string => {
    if (result.spawnFailed) {
      return `The ${step} could not run: the server has no usable rclone to probe the seed space with.`;
    }
    if (result.timedOut) {
      return `The bucket did not answer the ${step} within ${PROBE_COMMAND_TIMEOUT_MS / 1000} seconds, so the temporary seed space could not be proven usable.`;
    }
    return `${fallback}: ${boundedProbeDetail(result.stderr, "the command failed", targetCredentials)}`;
  };
  const targetCredentials = { secret: target.secretAccessKey, accessKeyId: target.accessKeyId };

  // `Bun.which` CACHES its answer when it is not given an explicit PATH, so a
  // process that started with rclone on PATH would keep reporting it after the
  // environment changed. Passing the current PATH is what makes this check
  // honest. It is also the FIRST step, so a server without rclone produces a
  // verdict rather than a 500 or a confusing fetch failure.
  if (Bun.which("rclone", { PATH: process.env["PATH"] ?? "" }) === null) {
    return fail("The server has no usable rclone, so the temporary seed space cannot be probed.");
  }

  const key = `lamasync/seed/.readiness-${crypto.randomUUID()}`;
  // The probe payload is generated ONCE and written to a private temp file:
  // `rclone copyto -` would read stdin, which this bounded spawn cannot feed,
  // and the digest compared on read-back must be of exactly these bytes.
  const payload = probeBytes(PROBE_OBJECT_BYTES);
  const expectedSha = sha256HexOf(payload);

  try {
    return await withProbePayload(payload, async (payloadPath) => {
      return await withProbeConfig(target, async (configPath) => {
        const object = `${PROBE_REMOTE}:${target.bucket}/${key}`;
        const upload = await runProbeCommand(
          ["copyto", payloadPath, object, ...PROBE_MULTIPART_FLAGS],
          configPath,
          remaining(),
        );
        if (!upload.ok) {
          return fail(
            describe(
              "upload",
              upload,
              "The bucket refused the upload, so the temporary seed space cannot hold an archive",
            ),
          );
        }
        const sized = await runProbeCommand(["size", "--json", object], configPath, remaining());
        if (!sized.ok) {
          return fail(describe("size read-back", sized, "The uploaded object could not be sized"));
        }
        const reportedBytes = (() => {
          try {
            const parsed: unknown = JSON.parse(probeStdoutText(sized).trim());
            if (typeof parsed === "object" && parsed !== null && "bytes" in parsed) {
              const value = (parsed as { bytes?: unknown }).bytes;
              return typeof value === "number" && Number.isFinite(value) ? value : null;
            }
          } catch {
            // fall through to the refusal below
          }
          return null;
        })();
        if (reportedBytes !== PROBE_OBJECT_BYTES) {
          return fail(
            `The uploaded object reads back as ${reportedBytes ?? "an unknown size"} bytes instead of ${PROBE_OBJECT_BYTES}, so the temporary seed space is not trustworthy.`,
          );
        }
        const readBack = await runProbeCommand(["cat", object], configPath, remaining());
        if (!readBack.ok) {
          return fail(describe("read-back", readBack, "The uploaded object could not be read back"));
        }
        if (sha256HexOf(readBack.stdoutBytes) !== expectedSha) {
          return fail(
            "The object read back from the bucket does not match the bytes written, so the temporary seed space is not trustworthy.",
          );
        }
        const removed = await runProbeCommand(["deletefile", object], configPath, remaining());
        if (!removed.ok) {
          return fail(
            describe(
              "delete",
              removed,
              "The bucket accepted a write but refused the delete, so the temporary seed space could not be cleaned up. Grant delete on this bucket",
            ),
          );
        }
        return {
          ok: true,
          detail:
            "The configured backend can upload (including multipart), read back the exact bytes, and delete from this bucket.",
        };
      });
    });
  } catch (err) {
    // Belt and braces: `withProbeConfig` cleans up, but nothing in a readiness
    // probe may escape as an exception and turn into a 500.
    return fail(
      `The temporary seed space could not be probed: ${boundedProbeDetail(
        err instanceof Error ? err.message : String(err),
        "the probe failed",
        targetCredentials,
      )}`,
    );
  }
}

/** Write the probe payload to a private temp file, and remove it afterwards. */
async function withProbePayload<T>(payload: Buffer, fn: (payloadPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "lamasync-seedprobe-"));
  const payloadPath = join(dir, "probe.bin");
  try {
    writeFileSync(payloadPath, payload, { mode: 0o600 });
    return await fn(payloadPath);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

/** Probe and persist the verdict in one step. NEVER throws. */
export async function probeAndRecordSeedRelayReadiness(
  database: Database,
  now: number = Date.now(),
): Promise<{ ok: true; config: SeedPilotConfig } | { ok: false; error: string; config: SeedPilotConfig | null }> {
  try {
    const config = getSeedPilotConfig(database);
    if (config === null || !config.enabled) {
      return {
        ok: false,
        error: "The seed pilot is not configured, so there is no seed space to probe.",
        config: config,
      };
    }
    const revision = getSeedPilotRevision(database);
    if (revision === null) {
      return { ok: false, error: "The seed pilot row disappeared before the probe.", config: config };
    }
    const identity = {
      configRevision: revision,
      backendId: config.backendId,
      bucket: config.bucket,
      verdictBucket: config.bucket,
    };

    const resolved = resolveSeedRelayProbeTarget(database);
    if (!resolved.ok) {
      // A scope problem is recorded as a FAILED verdict too — with the same
      // compare-and-set — so an enabled pilot whose backend disappeared cannot
      // keep a stale "ready".
      const recorded = recordSeedPilotReadiness(database, {
        ...identity,
        targetFingerprint: null,
        outcome: { ok: false, detail: resolved.error },
        now,
      });
      return recorded.ok
        ? { ok: false, error: resolved.error, config: recorded.config }
        : { ok: false, error: recorded.reason, config: recorded.config };
    }

    const targetFingerprint = seedRelayTargetFingerprint(resolved.target);
    const outcome = await probeSeedRelayBucket(resolved.target);
    const recorded = recordSeedPilotReadiness(database, {
      ...identity,
      targetFingerprint,
      outcome,
      now,
    });
    if (!recorded.ok) {
      // The pilot moved while the probe ran: DISCARD, and say so. The current
      // row keeps its own reset verdict, which authorizes nothing.
      return { ok: false, error: recorded.reason, config: recorded.config };
    }
    return outcome.ok
      ? { ok: true, config: recorded.config }
      : { ok: false, error: outcome.detail, config: recorded.config };
  } catch (err) {
    // Nothing a readiness probe does may become a 500: the operator asked for a
    // verdict, and a failure to produce one is a failure.
    const config = getSeedPilotConfig(database);
    return {
      ok: false,
      error: `The readiness probe could not be completed: ${
        err instanceof Error ? err.message.slice(0, 200) : "unknown error"
      }`,
      config,
    };
  }
}

interface PartyJobRow {
  id: string;
  host_id: string;
  source_host_id: string | null;
}

/**
 * The temporary seed space a HOST may use, or null.
 *
 * The rule, in one place, and EVERY condition fails closed:
 *
 *   * the pilot must be enabled and name a folder, a pair, a backend and a bucket;
 *   * its readiness verdict must be CURRENT for this exact backend+bucket (so a
 *     rotated key, a moved endpoint or a repointed backend revokes it);
 *   * the backend must still be an `s3` backend that resolves to a complete
 *     configuration;
 *   * the host must be one of the two parties of a NON-TERMINAL seed job of that
 *     exact folder, whose pair is the authorized one.
 *
 * A device that is not currently running an authorized seed therefore never
 * receives a relay credential at all — not on boot, not while idle, not after
 * the job is terminal, and not while the space is unproven.
 *
 * The returned object carries the decrypted secret and the job id + role it was
 * issued for. Callers must place it ONLY inside that host's own host config.
 */
export function seedRelaySpaceForHost(database: Database, hostId: string): SeedRelaySpace | null {
  const pilot = getSeedPilotConfig(database);
  if (pilot === null || !pilot.enabled) return null;
  if (pilot.folderId === null || pilot.sourceHostId === null || pilot.targetHostId === null) return null;
  if (pilot.backendId === null || pilot.bucket === null) return null;
  if (hostId !== pilot.sourceHostId && hostId !== pilot.targetHostId) return null;
  // The verdict must be about the backend AS IT IS NOW, not as it was probed.
  const liveFingerprint = liveSeedRelayTargetFingerprint(database);
  if (liveFingerprint === null) return null;
  if (
    pilot.readiness.state !== "ready" ||
    pilot.readiness.bucket !== pilot.bucket ||
    pilot.readiness.targetFingerprint !== liveFingerprint
  ) {
    return null;
  }

  // Non-terminal only, filtered in SQL so a stored phase string cannot be
  // mis-read as live.
  const rows = database
    .query<PartyJobRow, [string]>(
      `SELECT id, host_id, source_host_id FROM folder_seed_jobs
        WHERE folder_id = ? AND phase NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY created_at DESC LIMIT 20`,
    )
    .all(pilot.folderId);
  const job =
    rows.find(
      (row) =>
        row.source_host_id === pilot.sourceHostId &&
        row.host_id === pilot.targetHostId &&
        (row.host_id === hostId || row.source_host_id === hostId),
    ) ?? null;
  if (job === null) return null;
  const role: SeedPilotRole = hostId === pilot.sourceHostId ? "source" : "target";

  const backend = database.query<BackendS3Row, [string]>(BACKEND_S3_SELECT).get(pilot.backendId);
  if (!backend || backend.kind !== "s3") return null;
  const target = targetFromBackendRow(backend, pilot.bucket);
  if (target === null) return null;
  return {
    jobId: job.id,
    role,
    backendId: pilot.backendId,
    endpoint: target.endpoint,
    bucket: target.bucket,
    region: target.region,
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
  };
}
