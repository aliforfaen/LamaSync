// LAMA-346 Stage 2f — the operator's SEED PILOT.
//
// The archive transport is implemented and proven in the disposable E2E
// (Stages 2c–2e), but it has never run between two real machines. Rather than a
// build-wide boolean that would open every folder at once, execution is opened
// by an EXPLICIT OPERATOR AUTHORIZATION of exactly ONE folder and ONE
// source/target pair. This module is the single, pure statement of that rule —
// the server, the daemon and the web UI all read the same verdict.
//
// The pilot also names the TEMPORARY SEED SPACE: an existing S3 backend row
// (never a second secret entry) plus the bucket the fleet may use. Where that
// space lives is a product decision, so nothing here defaults it, infers it
// from the folder being seeded, or hardcodes a bucket or a key. The credentials
// stay in the backend row, are decrypted on the SERVER only, and are delivered
// to a device through its own authenticated host config (see
// `HostConfig.seedRelay`) — never in a list DTO, a URL, a log or a summary.
//
// Dependency-free on purpose so the web UI can import it without pulling node
// built-ins into the bundle.

/**
 * The relay space a device is allowed to use, as delivered inside its own
 * authenticated host config.
 *
 * `jobId` and `role` are the AUTHORIZATION ARTIFACT: the server issues this
 * only to a host that is a party to THAT non-terminal seed job of the
 * pilot-authorized folder, so a device holding a space for another job (or for
 * the wrong side of this one) refuses to use it and refreshes instead.
 */
export interface SeedRelaySpace {
  jobId: string;
  role: SeedPilotRole;
  backendId: string;
  endpoint: string;
  bucket: string;
  region: string | null;
  accessKeyId: string;
  secretAccessKey: string;
}

export type SeedPilotRole = "source" | "target";

/** The state of the last readiness probe of the pilot's seed space. */
export type SeedPilotReadinessState = "unknown" | "ready" | "failed";

/**
 * The result of the last probe, stored WITH the pilot so the verdict survives a
 * restart and the UI never has to re-probe to render. Never holds a credential.
 */
export interface SeedPilotReadiness {
  state: SeedPilotReadinessState;
  /** The bucket the probe ran against, so a stale verdict is visible as stale. */
  bucket: string | null;
  checkedAt: number | null;
  /** Bounded, credential-free. `null` while `unknown`. */
  message: string | null;
}

export function unknownSeedPilotReadiness(): SeedPilotReadiness {
  return { state: "unknown", bucket: null, checkedAt: null, message: null };
}

/**
 * The operator's seed pilot, as stored. Every scope field is nullable so an
 * absent/disabled pilot is representable without inventing values, and so a
 * partially written row can only ever FAIL CLOSED in `seedPilotEligibility`.
 */
export interface SeedPilotConfig {
  enabled: boolean;
  folderId: string | null;
  sourceHostId: string | null;
  targetHostId: string | null;
  backendId: string | null;
  bucket: string | null;
  updatedAt: number | null;
  readiness: SeedPilotReadiness;
}

export function emptySeedPilotConfig(): SeedPilotConfig {
  return {
    enabled: false,
    folderId: null,
    sourceHostId: null,
    targetHostId: null,
    backendId: null,
    bucket: null,
    updatedAt: null,
    readiness: unknownSeedPilotReadiness(),
  };
}

/** The exact folder and device pair a caller is asking to seed. */
export interface SeedPilotRequest {
  folderId: string;
  sourceHostId: string;
  targetHostId: string;
}

export interface SeedPilotEligibility {
  eligible: boolean;
  /** Exact operator-facing reason when `eligible` is false. */
  reason: string;
}

/**
 * Whether the operator's pilot authorizes THIS folder and THIS pair.
 *
 * One folder, one source, one target — and the pair is ORDERED: a pilot for
 * (A → B) never authorizes (B → A), because the direction decides which tree
 * wins. Every missing or mismatched field is a refusal with its own sentence,
 * so an operator is never told "not authorized" without being told which of the
 * four choices is wrong. Fail closed: an absent pilot authorizes nothing.
 */
export function seedPilotEligibility(
  config: SeedPilotConfig | null,
  request: SeedPilotRequest,
): SeedPilotEligibility {
  if (config === null || !config.enabled) {
    return { eligible: false, reason: SEED_PILOT_NOT_CONFIGURED_REASON };
  }
  if (config.folderId === null || config.folderId !== request.folderId) {
    return {
      eligible: false,
      reason:
        "The seed pilot authorizes one folder at a time, and this is not that folder. " +
        "Change the pilot in Settings → Seed pilot, or prepare the seed for the authorized folder.",
    };
  }
  if (config.sourceHostId === null || config.sourceHostId !== request.sourceHostId) {
    return {
      eligible: false,
      reason:
        `The seed pilot authorizes ${config.sourceHostId ?? "no device"} as the source of truth, not ` +
        `${request.sourceHostId}. The source is an explicit operator choice; change the pilot rather than ` +
        "the plan.",
    };
  }
  if (config.targetHostId === null || config.targetHostId !== request.targetHostId) {
    return {
      eligible: false,
      reason:
        `The seed pilot authorizes ${config.targetHostId ?? "no device"} as the target, not ` +
        `${request.targetHostId}. Change the pilot in Settings → Seed pilot to seed another device.`,
    };
  }
  if (config.backendId === null || config.bucket === null) {
    return {
      eligible: false,
      reason:
        "The seed pilot is enabled but does not name a storage backend and bucket for the temporary seed " +
        "space, so there is nowhere for an archive to travel. Complete it in Settings → Seed pilot.",
    };
  }
  return { eligible: true, reason: SEED_PILOT_AUTHORIZED_REASON };
}

export const SEED_PILOT_NOT_CONFIGURED_REASON =
  "Seed execution is switched off for every folder. LamaSync runs a seed only inside the operator's seed " +
  "pilot, which authorizes ONE folder and ONE source/target pair at a time — the transport has never run " +
  "between two real machines, so nothing is opened fleet-wide. Preparing a plan is safe and read-only.";

export const SEED_PILOT_AUTHORIZED_REASON =
  "Seed execution is authorized by the seed pilot for this folder and this device pair.";

/**
 * Whether this exact folder+pair is the one the pilot authorized.
 *
 * The same rule as `seedPilotEligibility`, stated as a boolean for the server's
 * delivery and enqueue decisions.
 */
export function seedPilotMatches(config: SeedPilotConfig | null, request: SeedPilotRequest): boolean {
  return seedPilotEligibility(config, request).eligible;
}

/**
 * A bucket name S3 will accept: 3–63 characters, lowercase letters, digits,
 * dots and hyphens, starting and ending alphanumeric. Rejecting a malformed
 * name at the boundary is cheaper than a failed probe, and it keeps a value
 * that reaches a URL from carrying anything else.
 */
export function isSeedRelayBucketName(value: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value);
}

export interface SeedPilotUpdatePayload {
  enabled: boolean;
  folderId: string | null;
  sourceHostId: string | null;
  targetHostId: string | null;
  backendId: string | null;
  bucket: string | null;
  confirm: true;
}

export type SeedPilotUpdateParseResult =
  | { ok: true; payload: SeedPilotUpdatePayload }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalId(value: unknown, field: string): string | null | { error: string } {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return { error: `${field} must be a string` };
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Validate a pilot write. `confirm: true` is required because enabling the
 * pilot is the act that lets a real transfer happen, and unknown fields are
 * refused rather than ignored so a typo cannot silently drop a scope field and
 * leave a WIDER authorization than the operator intended.
 */
export function parseSeedPilotUpdatePayload(value: unknown): SeedPilotUpdateParseResult {
  if (!isRecord(value)) return { ok: false, error: "payload must be an object" };
  const allowed = new Set([
    "enabled",
    "folderId",
    "sourceHostId",
    "targetHostId",
    "backendId",
    "bucket",
    "confirm",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return { ok: false, error: `unsupported field: ${key}` };
  }
  if (value["confirm"] !== true) {
    return { ok: false, error: "confirm must be true: enabling the seed pilot authorizes a real transfer" };
  }
  if (typeof value["enabled"] !== "boolean") return { ok: false, error: "enabled must be a boolean" };

  const folderId = optionalId(value["folderId"], "folderId");
  if (typeof folderId === "object" && folderId !== null) return { ok: false, error: folderId.error };
  const sourceHostId = optionalId(value["sourceHostId"], "sourceHostId");
  if (typeof sourceHostId === "object" && sourceHostId !== null) return { ok: false, error: sourceHostId.error };
  const targetHostId = optionalId(value["targetHostId"], "targetHostId");
  if (typeof targetHostId === "object" && targetHostId !== null) return { ok: false, error: targetHostId.error };
  const backendId = optionalId(value["backendId"], "backendId");
  if (typeof backendId === "object" && backendId !== null) return { ok: false, error: backendId.error };
  const bucket = optionalId(value["bucket"], "bucket");
  if (typeof bucket === "object" && bucket !== null) return { ok: false, error: bucket.error };

  const enabled = value["enabled"];
  if (enabled) {
    if (folderId === null) return { ok: false, error: "folderId is required to enable the seed pilot" };
    if (sourceHostId === null) return { ok: false, error: "sourceHostId is required to enable the seed pilot" };
    if (targetHostId === null) return { ok: false, error: "targetHostId is required to enable the seed pilot" };
    if (backendId === null) return { ok: false, error: "backendId is required to enable the seed pilot" };
    if (bucket === null) return { ok: false, error: "bucket is required to enable the seed pilot" };
    if (sourceHostId === targetHostId) {
      return { ok: false, error: "the source and target devices must differ: a device cannot seed itself" };
    }
    if (!isSeedRelayBucketName(bucket)) {
      return {
        ok: false,
        error: `bucket must be a valid S3 bucket name (3-63 lowercase letters, digits, dots or hyphens): ${bucket}`,
      };
    }
  }
  return {
    ok: true,
    payload: { enabled, folderId, sourceHostId, targetHostId, backendId, bucket, confirm: true },
  };
}

/** The bounded, credential-free outcome of one readiness probe. */
export interface SeedPilotProbeOutcome {
  ok: boolean;
  /** Bounded reason; never a credential, an endpoint URL or a bucket key. */
  detail: string;
}

/**
 * Turn a probe outcome into the stored readiness verdict.
 *
 * `detail` is passed through only after being trimmed and capped, and the
 * caller is responsible for it containing no credential — the probe's own
 * sentences name the STORE TYPE and the failure class, never the location.
 */
export function seedPilotReadinessVerdict(
  bucket: string | null,
  outcome: SeedPilotProbeOutcome,
  now: number,
): SeedPilotReadiness {
  return {
    state: outcome.ok ? "ready" : "failed",
    bucket,
    checkedAt: now,
    message: outcome.detail.trim().slice(0, 300),
  };
}

/** True when the stored readiness verdict is current AND passing. */
export function seedPilotReadinessIsCurrent(
  config: SeedPilotConfig,
  bucket: string | null,
): boolean {
  return (
    config.readiness.state === "ready" &&
    bucket !== null &&
    config.readiness.bucket === bucket
  );
}

/**
 * The FULL verdict a caller needs before it may run: the pilot authorizes this
 * exact folder and pair, AND its temporary seed space has been probed and
 * works.
 *
 * The readiness half is deliberately part of the same verdict rather than a
 * second gate elsewhere: an existing backend's credentials may be scoped to a
 * different bucket, and discovering that after a 40-minute archive has been
 * built is exactly the failure this closes. Fail closed — an unprobed pilot
 * runs nothing.
 */
export function seedPilotExecutionEligibility(
  config: SeedPilotConfig | null,
  request: SeedPilotRequest,
): SeedPilotEligibility {
  const scope = seedPilotEligibility(config, request);
  if (!scope.eligible || config === null) return scope;
  if (!seedPilotReadinessIsCurrent(config, config.bucket)) {
    return {
      eligible: false,
      reason:
        config.readiness.state === "failed"
          ? `The seed pilot's temporary seed space could not be used: ${config.readiness.message ?? "the probe failed"} ` +
            "Run Test seed space in Settings → Seed pilot after fixing the backend's access to that bucket."
          : "The seed pilot's temporary seed space has not been probed, so LamaSync cannot know whether the " +
            "configured backend can write to that bucket. Run Test seed space in Settings → Seed pilot.",
    };
  }
  return scope;
}

/**
 * The wire shape of the pilot surface, shared by the admin UI so the options it
 * offers and the config it edits cannot drift from the server's.
 *
 * Note what is NOT here: a backend option carries its access key ID (an
 * identifier the backends list already exposes) and a `hasSecret` boolean, never
 * the secret.
 */
export interface SeedPilotBackendOption {
  id: string;
  name: string;
  kind: string;
  provider: string;
  endpoint: string | null;
  region: string | null;
  accessKeyId: string | null;
  hasSecret: boolean;
}

export interface SeedPilotOptions {
  folders: Array<{ id: string; name: string; type: string }>;
  hosts: Array<{ id: string; hostname: string; status: string }>;
  backends: SeedPilotBackendOption[];
}

export interface SeedPilotView {
  config: SeedPilotConfig;
  summary: string;
  options: SeedPilotOptions;
  /** Present on a write: the scope verdict the operator now has. */
  eligibility?: SeedPilotEligibility | null;
  /** Present on a probe: the outcome, whose detail is credential-free. */
  probe?: { ok: boolean; detail: string | null };
}

/** One operator-facing sentence for the pilot's current state. */
export function seedPilotSummary(config: SeedPilotConfig): string {
  if (!config.enabled) return "The seed pilot is off, so no seed can run.";
  const scope = `${config.folderId ?? "no folder"} (${config.sourceHostId ?? "no source"} → ${config.targetHostId ?? "no target"})`;
  const space = config.backendId === null || config.bucket === null
    ? "no temporary seed space configured"
    : `temporary seed space: backend ${config.backendId}, bucket ${config.bucket}`;
  const readiness =
    config.readiness.state === "ready"
      ? "the seed space probe passed"
      : config.readiness.state === "failed"
        ? `the seed space probe failed: ${config.readiness.message ?? "unknown reason"}`
        : "the seed space has not been probed";
  return `The seed pilot authorizes ${scope}; ${space}; ${readiness}.`;
}
