// LAMA-346 Stage 2f — the seed pilot's server-side storage, host-scoped
// delivery and readiness probe.
//
// Three responsibilities, deliberately in one module because they are one
// contract:
//
//   1. STORAGE. One row (`id = 'default'`) holds the operator's authorization:
//      one folder, one source/target pair, one EXISTING S3 backend row, one
//      bucket. No credential is stored here — the backend row already owns it.
//   2. DELIVERY. `seedRelaySpaceForHost` resolves and DECRYPTS the backend's
//      secret for exactly the hosts that may use it: the two parties of a
//      NON-TERMINAL seed job of the pilot-authorized folder. It is returned
//      inside the device's own authenticated host config and nowhere else.
//   3. READINESS. `probeSeedRelayBucket` proves the configured backend can
//      actually WRITE and DELETE inside the bucket. That matters because an
//      existing backend's key may be scoped to a different bucket: the probe is
//      bucket-scoped on purpose (`rclone lsd test:` from the generic backend
//      test would need listBuckets, which such a key does not have), and its
//      verdict is stored so an unprobed space can never be authorized.

import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  seedPilotReadinessVerdict,
  type SeedPilotConfig,
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
  updated_at: number;
}

const SEED_PILOT_SELECT = `SELECT enabled, folder_id, source_host_id, target_host_id, backend_id, bucket,
       readiness_state, readiness_bucket, readiness_checked_at, readiness_message, updated_at
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
    },
  };
}

/** The stored pilot, or null when the operator has never configured one. */
export function getSeedPilotConfig(database: Database): SeedPilotConfig | null {
  const row = database.query<SeedPilotRow, []>(SEED_PILOT_SELECT).get();
  return row ? rowToSeedPilotConfig(row) : null;
}

/**
 * Write the pilot. Enabling it RESETS the readiness verdict, because a verdict
 * about a different bucket (or a different backend) must never authorize the
 * new one — the operator re-probes.
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
  const keepVerdict =
    !input.enabled &&
    input.backendId !== null &&
    input.bucket !== null;
  const existing = getSeedPilotConfig(database);
  const sameTarget =
    existing !== null &&
    existing.backendId === input.backendId &&
    existing.bucket === input.bucket;
  database.run(
    `INSERT INTO seed_pilot_config
       (id, enabled, folder_id, source_host_id, target_host_id, backend_id, bucket,
        readiness_state, readiness_bucket, readiness_checked_at, readiness_message, updated_at)
     VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       updated_at = excluded.updated_at`,
    [
      input.enabled ? 1 : 0,
      input.folderId,
      input.sourceHostId,
      input.targetHostId,
      input.backendId,
      input.bucket,
      // A verdict survives only when it was about the SAME backend+bucket and
      // the pilot is being disabled (a disable is not a reconfiguration).
      keepVerdict && sameTarget && existing !== null ? existing.readiness.state : "unknown",
      keepVerdict && sameTarget && existing !== null ? existing.readiness.bucket : null,
      keepVerdict && sameTarget && existing !== null ? existing.readiness.checkedAt : null,
      keepVerdict && sameTarget && existing !== null ? existing.readiness.message : null,
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

/** Record the outcome of a readiness probe without touching the scope. */
export function recordSeedPilotReadiness(
  database: Database,
  outcome: SeedPilotProbeOutcome,
  now: number = Date.now(),
): SeedPilotConfig {
  const config = getSeedPilotConfig(database);
  if (config === null) throw new Error("the seed pilot has not been configured");
  const verdict = seedPilotReadinessVerdict(config.bucket, outcome, now);
  database.run(
    `UPDATE seed_pilot_config
        SET readiness_state = ?, readiness_bucket = ?, readiness_checked_at = ?, readiness_message = ?,
            updated_at = ?
      WHERE id = 'default'`,
    [verdict.state, verdict.bucket, verdict.checkedAt, verdict.message, now],
  );
  const stored = getSeedPilotConfig(database);
  if (stored === null) throw new Error("the seed pilot could not be read back after the probe");
  return stored;
}

interface PartyJobRow {
  id: string;
  host_id: string;
  source_host_id: string | null;
}

/**
 * The temporary seed space a HOST may use, or null.
 *
 * The rule, in one place: the pilot must be enabled and must name a folder, a
 * pair and a backend; the host must be one of the two parties of a
 * NON-TERMINAL seed job of that exact folder whose pair is the authorized one;
 * and the referenced backend must resolve to a complete S3 configuration. Every
 * condition failing closed means a device that is not currently running a seed
 * never receives a relay credential at all — not on boot, not while idle, not
 * after the job is terminal.
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

  const backend = database
    .query<
      { s3_provider: string | null; s3_endpoint: string | null; s3_region: string | null; s3_access_key_id: string | null; s3_secret_key_enc: string | null },
      [string]
    >("SELECT s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc FROM backends WHERE id = ?")
    .get(pilot.backendId);
  if (!backend) return null;
  const endpoint = (backend.s3_endpoint ?? "").trim();
  const accessKeyId = (backend.s3_access_key_id ?? "").trim();
  const secretAccessKey = decryptSecret(backend.s3_secret_key_enc) ?? "";
  if (endpoint.length === 0 || accessKeyId.length === 0 || secretAccessKey.length === 0) return null;
  return {
    jobId: job.id,
    role,
    backendId: pilot.backendId,
    endpoint,
    bucket: pilot.bucket,
    region: (backend.s3_region ?? "").trim() || null,
    accessKeyId,
    secretAccessKey,
  };
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
  const row = database
    .query<
      { kind: string; s3_provider: string | null; s3_endpoint: string | null; s3_region: string | null; s3_access_key_id: string | null; s3_secret_key_enc: string | null },
      [string]
    >("SELECT kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc FROM backends WHERE id = ?")
    .get(pilot.backendId);
  if (!row) {
    return { ok: false, error: `The seed pilot references a storage backend that no longer exists (${pilot.backendId}).` };
  }
  if (row.kind !== "s3") {
    return { ok: false, error: "The seed pilot's storage backend is not an S3 backend, so it cannot hold the temporary seed space." };
  }
  const endpoint = (row.s3_endpoint ?? "").trim();
  const accessKeyId = (row.s3_access_key_id ?? "").trim();
  const secretAccessKey = decryptSecret(row.s3_secret_key_enc) ?? "";
  if (endpoint.length === 0) return { ok: false, error: "The seed pilot's storage backend has no S3 endpoint configured." };
  if (accessKeyId.length === 0 || secretAccessKey.length === 0) {
    return { ok: false, error: "The seed pilot's storage backend has no stored S3 access key." };
  }
  return {
    ok: true,
    target: {
      provider: isS3Provider(row.s3_provider) ? row.s3_provider : "other",
      endpoint,
      region: (row.s3_region ?? "").trim() || null,
      accessKeyId,
      secretAccessKey,
      bucket: pilot.bucket,
    },
  };
}

/** The remote name the probe's temporary rclone config uses. Never persisted. */
const PROBE_REMOTE = "seedspace";

function probeRcloneConfig(target: SeedRelayProbeTarget): string {
  const lines = [`[${PROBE_REMOTE}]`, "type = s3", `provider = ${target.provider}`, `access_key_id = ${target.accessKeyId}`];
  lines.push(`secret_access_key = ${target.secretAccessKey}`);
  lines.push(`endpoint = ${target.endpoint}`);
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

/** Bound and de-credential a probe's stderr before it is ever stored or shown. */
export function boundedProbeDetail(stderr: string, fallback: string): string {
  const line = stderr.trim().split("\n").map((l) => l.trim()).filter((l) => l.length > 0).pop() ?? "";
  if (line.length === 0) return fallback;
  // rclone's own errors never contain the secret, but they DO contain the
  // endpoint; the endpoint is not a credential, and it is genuinely useful for
  // "the bucket does not exist" vs "access denied", so it is kept. Only the
  // access key id is stripped, defensively.
  return line.replace(/[A-Za-z0-9]{10,}:[A-Za-z0-9+/=]{10,}/g, "[redacted]").slice(0, 300);
}

/**
 * How long ONE probe command may take, and how many times it may retry.
 *
 * A readiness probe runs inside an admin request, so it must ANSWER: a wrong
 * endpoint (or a bucket that hangs) has to produce a verdict rather than an
 * indefinitely pending request. The retry counts are pinned to 1 so rclone's
 * default backoff cannot stretch a failure into minutes.
 */
const PROBE_COMMAND_TIMEOUT_MS = 20_000;
const PROBE_RETRY_FLAGS = ["--retries", "1", "--low-level-retries", "1", "--contimeout", "5s", "--timeout", "15s"];

/** Run one probe command, killed if it overruns. Never throws. */
async function runProbeCommand(
  args: string[],
  configPath: string,
): Promise<{ ok: boolean; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn(["rclone", ...args, "--config", configPath, ...PROBE_RETRY_FLAGS], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // already gone
    }
  }, PROBE_COMMAND_TIMEOUT_MS);
  try {
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { ok: exitCode === 0, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prove the configured backend can WRITE and DELETE inside the pilot's bucket.
 *
 * Deliberately bucket-scoped. `rclone lsd test:` (the generic backend test)
 * lists every bucket in the account, so a key that is scoped to one bucket
 * fails it while working perfectly for the seed space — that is exactly the
 * "existing backend credentials may be bucket-scoped" case. This probe touches
 * one object under the seed namespace and removes it again, so a passing verdict
 * means "the archive can be uploaded here and cleaned up here".
 *
 * A probe object left behind by a crash is harmless: it lives under the same
 * namespace and the bucket's own lifecycle removes it.
 */
export async function probeSeedRelayBucket(target: SeedRelayProbeTarget): Promise<SeedPilotProbeOutcome> {
  const key = `lamasync/seed/.readiness-${crypto.randomUUID()}`;
  return withProbeConfig(target, async (configPath) => {
    const write = await runProbeCommand(["touch", `${PROBE_REMOTE}:${target.bucket}/${key}`], configPath);
    if (!write.ok) {
      return {
        ok: false,
        detail: write.timedOut
          ? `The bucket did not answer within ${PROBE_COMMAND_TIMEOUT_MS / 1000} seconds, so the temporary seed space could not be proven usable.`
          : `Could not write to the bucket: ${boundedProbeDetail(write.stderr, "the write failed")}`,
      };
    }
    const remove = await runProbeCommand(["deletefile", `${PROBE_REMOTE}:${target.bucket}/${key}`], configPath);
    if (!remove.ok) {
      return {
        ok: false,
        detail: remove.timedOut
          ? "The bucket accepted a write but did not answer the delete in time, so the temporary seed space could not be cleaned up."
          : "The bucket accepted a write but refused the delete, so the temporary seed space could not be cleaned up. " +
            `Grant delete on this bucket: ${boundedProbeDetail(remove.stderr, "the delete failed")}`,
      };
    }
    return { ok: true, detail: "The configured backend can write to and delete from this bucket." };
  });
}

/** Probe and persist the verdict in one step (the admin route's whole job). */
export async function probeAndRecordSeedRelayReadiness(
  database: Database,
  now: number = Date.now(),
): Promise<{ ok: true; config: SeedPilotConfig } | { ok: false; error: string; config: SeedPilotConfig | null }> {
  const resolved = resolveSeedRelayProbeTarget(database);
  if (!resolved.ok) {
    const config = getSeedPilotConfig(database);
    // A scope problem is recorded as a FAILED verdict too, so an enabled pilot
    // whose backend disappeared cannot keep a stale "ready".
    if (config !== null) recordSeedPilotReadiness(database, { ok: false, detail: resolved.error }, now);
    return { ok: false, error: resolved.error, config: getSeedPilotConfig(database) };
  }
  const outcome = await probeSeedRelayBucket(resolved.target);
  const config = recordSeedPilotReadiness(database, outcome, now);
  return outcome.ok ? { ok: true, config } : { ok: false, error: outcome.detail, config };
}
