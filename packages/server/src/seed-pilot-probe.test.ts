// LAMA-346 Stage 2f review — the readiness probe and its binding, proven.
//
// The review found four ways a `ready` verdict could authorize something it did
// not prove:
//
//   1. the probe proved only write+delete, while a seed needs HEAD and GET too;
//   2. it could not tell whether the key supports MULTIPART, which a 14.86 GB
//      archive needs;
//   3. it recorded its verdict against whatever configuration happened to be
//      current when it FINISHED, so a concurrent reconfigure could inherit it;
//   4. a rotated backend (endpoint, region, key or secret) kept the old verdict.
//
// Each of those is pinned here. The probe's own network behaviour is exercised
// against a disposable MinIO when `LAMASYNC_TEST_S3_*` is set, and its
// FAILURE paths — the ones that must produce a verdict rather than a 500 — run
// everywhere.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
import { encryptSecret } from "./crypto.ts";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "seed-probe-master-key-123";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "seed-probe-secret-key-123";

const {
  getSeedPilotConfig,
  getSeedPilotRevision,
  liveSeedRelayTargetFingerprint,
  probeAndRecordSeedRelayReadiness,
  probeSeedRelayBucket,
  recordSeedPilotReadiness,
  resolveSeedRelayProbeTarget,
  seedPilotEligibilityForFolderPair,
  seedRelaySpaceForHost,
  seedRelayTargetFingerprint,
  setSeedPilotConfig,
} = await import("./seed-pilot.ts");

const S3_ENDPOINT = process.env["LAMASYNC_TEST_S3_ENDPOINT"] ?? "";
const S3_BUCKET = process.env["LAMASYNC_TEST_S3_BUCKET"] ?? "";
const S3_ACCESS_KEY = process.env["LAMASYNC_TEST_S3_ACCESS_KEY"] ?? "";
const S3_SECRET_KEY = process.env["LAMASYNC_TEST_S3_SECRET_KEY"] ?? "";
const MINIO = S3_ENDPOINT.length > 0 && S3_ACCESS_KEY.length > 0 && S3_SECRET_KEY.length > 0;

const REQUEST = { folderId: "f1", sourceHostId: "h-source", targetHostId: "h-target" };

let db: Database;

function configureBackend(over: Partial<{ endpoint: string; region: string; accessKeyId: string; secret: string; kind: string }> = {}): void {
  db.run("DELETE FROM backends");
  db.run(
    `INSERT INTO backends (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, created_at)
     VALUES ('b1', 'b2 tmp', ?, 'b2', ?, ?, ?, ?, 1)`,
    [
      over.kind ?? "s3",
      over.endpoint ?? "http://127.0.0.1:9",
      over.region ?? "us-east-005",
      over.accessKeyId ?? "keyid-1",
      encryptSecret(over.secret ?? "probe-secret"),
    ],
  );
}

function enablePilot(): void {
  setSeedPilotConfig(db, {
    enabled: true,
    folderId: REQUEST.folderId,
    sourceHostId: REQUEST.sourceHostId,
    targetHostId: REQUEST.targetHostId,
    backendId: "b1",
    bucket: "lamasync-tmp",
  });
}

/** Record a passing verdict exactly as the probe would, for the CURRENT target. */
function recordReady(): void {
  const config = getSeedPilotConfig(db);
  if (config === null) throw new Error("no pilot configured");
  recordSeedPilotReadiness(db, {
    configRevision: getSeedPilotRevision(db) ?? 0,
    backendId: config.backendId,
    bucket: config.bucket,
    verdictBucket: config.bucket,
    targetFingerprint: liveSeedRelayTargetFingerprint(db),
    outcome: { ok: true, detail: "probe passed" },
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // idempotent
    }
  }
  db.exec(`
    INSERT INTO hosts (id, hostname, config_revision) VALUES ('h-source', 'source', 1);
    INSERT INTO hosts (id, hostname, config_revision) VALUES ('h-target', 'target', 1);
    INSERT INTO folders (id, name, type) VALUES ('f1', 'Projects', 'sync');
  `);
  configureBackend();
  enablePilot();
});

afterEach(() => {
  db.close();
});

describe("the verdict is bound to the EXACT probe target", () => {
  test("rotating the SECRET invalidates a passing verdict", () => {
    recordReady();
    expect(seedPilotEligibilityForFolderPair(db, REQUEST).eligible).toBe(true);
    const before = liveSeedRelayTargetFingerprint(db);

    // The key is rotated on the backend row; the PILOT is untouched.
    configureBackend({ secret: "rotated-secret" });
    const after = liveSeedRelayTargetFingerprint(db);
    expect(after).not.toBe(before);

    const verdict = seedPilotEligibilityForFolderPair(db, REQUEST);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toContain("STALE");
  });

  test("moving the ENDPOINT, the REGION or the ACCESS KEY ID invalidates it too", () => {
    recordReady();
    const baseline = liveSeedRelayTargetFingerprint(db);
    for (const change of [
      { endpoint: "http://127.0.0.1:10" },
      { region: "us-west-004" },
      { accessKeyId: "keyid-2" },
    ]) {
      configureBackend(change);
      expect(liveSeedRelayTargetFingerprint(db)).not.toBe(baseline);
      expect(seedPilotEligibilityForFolderPair(db, REQUEST).eligible).toBe(false);
    }
  });

  test("the fingerprint is one-way and bucket-scoped", () => {
    const resolved = resolveSeedRelayProbeTarget(db);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const fingerprint = seedRelayTargetFingerprint(resolved.target);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The secret itself is never in the fingerprint, and a different bucket is a
    // different target.
    expect(fingerprint).not.toContain("probe-secret");
    expect(seedRelayTargetFingerprint({ ...resolved.target, bucket: "other-bucket" })).not.toBe(fingerprint);
  });

  test("a backend that cannot be resolved authorizes nothing", () => {
    recordReady();
    expect(seedPilotEligibilityForFolderPair(db, REQUEST).eligible).toBe(true);
    // A non-S3 kind, a missing row, and a missing secret are all "unresolvable",
    // and `null` never matches a stored fingerprint.
    configureBackend({ kind: "local" });
    expect(liveSeedRelayTargetFingerprint(db)).toBeNull();
    expect(seedPilotEligibilityForFolderPair(db, REQUEST).eligible).toBe(false);
    configureBackend();
    db.run("UPDATE backends SET s3_secret_key_enc = '' WHERE id = 'b1'");
    expect(liveSeedRelayTargetFingerprint(db)).toBeNull();
    expect(seedPilotEligibilityForFolderPair(db, REQUEST).eligible).toBe(false);
  });
});

describe("a verdict can never be recorded against a configuration it was not run for", () => {
  test("a stale revision is DISCARDED, and the current row stays unknown", () => {
    const revision = getSeedPilotRevision(db) ?? 0;
    // The operator reconfigures while the probe is in flight.
    setSeedPilotConfig(db, {
      enabled: true,
      folderId: REQUEST.folderId,
      sourceHostId: REQUEST.sourceHostId,
      targetHostId: REQUEST.targetHostId,
      backendId: "b1",
      bucket: "another-bucket",
    });
    const result = recordSeedPilotReadiness(db, {
      configRevision: revision,
      backendId: "b1",
      bucket: "lamasync-tmp",
      verdictBucket: "lamasync-tmp",
      targetFingerprint: "a".repeat(64),
      outcome: { ok: true, detail: "probe passed" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("changed while the probe was running");
    // The NEW configuration keeps its own reset verdict — never the old pass.
    expect(getSeedPilotConfig(db)?.readiness.state).toBe("unknown");
    expect(getSeedPilotConfig(db)?.readiness.bucket).toBeNull();
  });

  test("a verdict for the OLD bucket cannot land on the new one", () => {
    const revision = getSeedPilotRevision(db) ?? 0;
    setSeedPilotConfig(db, {
      enabled: true,
      folderId: REQUEST.folderId,
      sourceHostId: REQUEST.sourceHostId,
      targetHostId: REQUEST.targetHostId,
      backendId: "b1",
      bucket: "lamasync-tmp",
    });
    // Same bucket, but the revision moved: still discarded.
    expect(
      recordSeedPilotReadiness(db, {
        configRevision: revision,
        backendId: "b1",
        bucket: "lamasync-tmp",
        verdictBucket: "lamasync-tmp",
        targetFingerprint: "a".repeat(64),
        outcome: { ok: true, detail: "probe passed" },
      }).ok,
    ).toBe(false);
    expect(getSeedPilotConfig(db)?.readiness.state).toBe("unknown");
  });

  test("a REAL probe that is reconfigured mid-flight discards its own verdict", async () => {
    // The exact race the review described, without any timing guesswork: the
    // probe captures its identity synchronously, then yields at its first
    // network await. Reconfiguring in that window is deterministic.
    const pending = probeAndRecordSeedRelayReadiness(db);
    setSeedPilotConfig(db, {
      enabled: true,
      folderId: REQUEST.folderId,
      sourceHostId: REQUEST.sourceHostId,
      targetHostId: REQUEST.targetHostId,
      backendId: "b1",
      bucket: "reconfigured-mid-probe",
    });
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("changed while the probe was running");
    expect(getSeedPilotConfig(db)?.bucket).toBe("reconfigured-mid-probe");
    expect(getSeedPilotConfig(db)?.readiness.state).toBe("unknown");
  });

  test("a backend rotation mid-flight discards the verdict as well", async () => {
    const pending = probeAndRecordSeedRelayReadiness(db);
    configureBackend({ secret: "rotated-while-probing" });
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The rotation changed the target the verdict would be about, so it is
    // DISCARDED — not recorded as a stale pass for the new backend.
    expect(result.error).toContain("changed while the probe was running");
    expect(getSeedPilotConfig(db)?.readiness.state).toBe("unknown");
  });
});

describe("a failing probe is a VERDICT, never an exception", () => {
  test("an unreachable endpoint fails the verdict and stores the reason", async () => {
    const outcome = await probeSeedRelayBucket({
      provider: "other",
      endpoint: "http://127.0.0.1:9",
      region: null,
      accessKeyId: "k",
      secretAccessKey: "s",
      bucket: "lamasync-tmp",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail.length).toBeGreaterThan(0);
    expect(outcome.detail.length).toBeLessThanOrEqual(300);
  });

  test("a missing rclone fails the verdict instead of throwing (and never 500s)", async () => {
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "/nonexistent-for-this-test";
    try {
      const outcome = await probeSeedRelayBucket({
        provider: "other",
        endpoint: "http://127.0.0.1:9",
        region: null,
        accessKeyId: "k",
        secretAccessKey: "s",
        bucket: "lamasync-tmp",
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.detail).toContain("rclone");
      // And the whole probe-and-record path is a verdict too, not a throw.
      const recorded = await probeAndRecordSeedRelayReadiness(db);
      expect(recorded.ok).toBe(false);
      expect(getSeedPilotConfig(db)?.readiness.state).toBe("failed");
    } finally {
      process.env["PATH"] = originalPath;
    }
  });

  test("a probe with no pilot configured answers instead of throwing", async () => {
    setSeedPilotConfig(db, {
      enabled: false,
      folderId: null,
      sourceHostId: null,
      targetHostId: null,
      backendId: null,
      bucket: null,
    });
    const result = await probeAndRecordSeedRelayReadiness(db);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not configured");
  });

  test("a failing probe NEVER puts the secret in its message", async () => {
    configureBackend({ secret: "sup3r-s3cret-application-key" });
    const outcome = await probeSeedRelayBucket({
      provider: "other",
      endpoint: "http://127.0.0.1:9",
      region: null,
      accessKeyId: "sup3r-s3cret-application-key",
      secretAccessKey: "sup3r-s3cret-application-key",
      bucket: "lamasync-tmp",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).not.toContain("sup3r-s3cret-application-key");
  });
});

describe("the delivered space requires a CURRENT verdict", () => {
  function liveJob(): void {
    const now = Date.now();
    db.run(
      `INSERT INTO folder_seed_jobs (id, plan_id, folder_id, host_id, source_host_id, assignment_id, status, phase,
        progress, source, archive, staging, lease_owner, lease_expires_at, error, summary, created_at, started_at, updated_at, finished_at)
       VALUES ('job-1', 'plan-1', 'f1', 'h-target', 'h-source', 'a2', 'running', 'uploading_archive',
        '{}', '{}', '{}', '{}', NULL, NULL, NULL, NULL, ?, NULL, ?, NULL)`,
      [now, now],
    );
  }

  test("no verdict, a failed verdict and a STALE verdict all deliver nothing", () => {
    liveJob();
    // No verdict yet.
    expect(seedRelaySpaceForHost(db, "h-source")).toBeNull();
    // A passing verdict delivers.
    recordReady();
    expect(seedRelaySpaceForHost(db, "h-source")?.jobId).toBe("job-1");
    expect(seedRelaySpaceForHost(db, "h-target")?.role).toBe("target");
    // A backend rotation revokes it without touching the pilot.
    configureBackend({ endpoint: "http://127.0.0.1:10" });
    expect(seedRelaySpaceForHost(db, "h-source")).toBeNull();
    expect(seedRelaySpaceForHost(db, "h-target")).toBeNull();
  });

  test("a non-S3 backend kind delivers nothing even with a passing verdict", () => {
    liveJob();
    recordReady();
    expect(seedRelaySpaceForHost(db, "h-source")).not.toBeNull();
    configureBackend({ kind: "local" });
    expect(seedRelaySpaceForHost(db, "h-source")).toBeNull();
  });
});

describe.skipIf(!MINIO)("the probe against a real object space", () => {
  test("a working bucket passes, including the multipart step", async () => {
    configureBackend({ endpoint: S3_ENDPOINT, region: "us-east-1", accessKeyId: S3_ACCESS_KEY, secret: S3_SECRET_KEY });
    setSeedPilotConfig(db, {
      enabled: true,
      folderId: REQUEST.folderId,
      sourceHostId: REQUEST.sourceHostId,
      targetHostId: REQUEST.targetHostId,
      backendId: "b1",
      bucket: S3_BUCKET,
    });
    const result = await probeAndRecordSeedRelayReadiness(db);
    expect(result.ok).toBe(true);
    expect(getSeedPilotConfig(db)?.readiness.state).toBe("ready");
    // The verdict is bound to this target, and it authorizes the pair.
    expect(getSeedPilotConfig(db)?.readiness.targetFingerprint).toBe(liveSeedRelayTargetFingerprint(db));
    expect(seedPilotEligibilityForFolderPair(db, REQUEST).eligible).toBe(true);
    expect(getSeedPilotConfig(db)?.readiness.message).toContain("multipart");
  });

  test("credentials the object space refuses fail the verdict, and the reason is usable", async () => {
    configureBackend({
      endpoint: S3_ENDPOINT,
      region: "us-east-1",
      accessKeyId: "not-a-known-key",
      secret: "not-a-known-secret",
    });
    setSeedPilotConfig(db, {
      enabled: true,
      folderId: REQUEST.folderId,
      sourceHostId: REQUEST.sourceHostId,
      targetHostId: REQUEST.targetHostId,
      backendId: "b1",
      bucket: S3_BUCKET,
    });
    const result = await probeAndRecordSeedRelayReadiness(db);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(getSeedPilotConfig(db)?.readiness.state).toBe("failed");
    expect(seedPilotEligibilityForFolderPair(db, REQUEST).eligible).toBe(false);
    // A failed verdict must never leak either credential.
    const message = getSeedPilotConfig(db)?.readiness.message ?? "";
    expect(message).not.toContain(S3_SECRET_KEY);
    expect(message).not.toContain("not-a-known-secret");
    // ...and it stays a bounded sentence.
    expect(message.length).toBeLessThanOrEqual(300);
  });

  test("a misspelled bucket fails instead of being created by rclone", async () => {
    configureBackend({ endpoint: S3_ENDPOINT, region: "us-east-1", accessKeyId: S3_ACCESS_KEY, secret: S3_SECRET_KEY });
    const missingBucket = `seed-missing-${crypto.randomUUID()}`;
    setSeedPilotConfig(db, {
      enabled: true,
      folderId: REQUEST.folderId,
      sourceHostId: REQUEST.sourceHostId,
      targetHostId: REQUEST.targetHostId,
      backendId: "b1",
      bucket: missingBucket,
    });
    const result = await probeAndRecordSeedRelayReadiness(db);
    expect(result.ok).toBe(false);
    expect(getSeedPilotConfig(db)?.readiness.state).toBe("failed");
    expect(seedPilotEligibilityForFolderPair(db, REQUEST).eligible).toBe(false);
  });
});
