// LAMA-346 Stage 2f — the seed-pilot surface: authorization, scope validation,
// credential NON-disclosure, and the host-scoped delivery rule.
//
// The three things this file exists to prove, because each of them is a way a
// real transfer could go wrong quietly:
//
//   1. NO SECRET ever leaves the pilot API. The options block carries a
//      backend's name, kind, endpoint, region and access key ID plus a
//      `hasSecret` boolean — the stored secret appears in no response, ever.
//   2. The relay space is issued to EXACTLY the two parties of a NON-TERMINAL
//      seed job of the pilot's folder, and to nobody else: not a stranger, not
//      an idle host, not after the job is terminal.
//   3. A write that cannot be fully authorized is refused with the specific
//      reason (missing folder, unassigned device, same device, non-S3 backend,
//      missing secret, malformed bucket).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import {
  MIGRATIONS,
  SERVER_SCHEMA,
  emptySeedJobArchiveFacts,
  type SeedJob,
} from "@lamasync/core";
import { encryptSecret } from "./crypto.ts";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "seed-pilot-master-key-123";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "seed-pilot-secret-key-123";
delete process.env.LAMASYNC_SEED_E2E;
delete process.env.LAMASYNC_TEST;

const { getAuthPlugin } = await import("./auth.ts");
const { insertManagedApiKey, __setApiKeysDb, __resetApiKeysDb } = await import("./api-keys.ts");
const { seedPilotRoutes, __setDb: __setPilotRouteDb } = await import("./routes/seed-pilot.ts");
const { createSeedJob } = await import("./seed-jobs.ts");
const {
  getSeedPilotConfig,
  getSeedPilotRevision,
  liveSeedRelayTargetFingerprint,
  recordSeedPilotReadiness,
  seedRelaySpaceForHost,
} = await import("./seed-pilot.ts");

/**
 * Record a PASSING verdict for the current configuration, exactly as the probe
 * would: against the revision it read and the live target fingerprint. The
 * delivery rule requires a current verdict, so a test that wants an issued space
 * must have one.
 */
function recordReadyProbe(): void {
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

const SOURCE = "pilot-source";
const TARGET = "pilot-target";
const STRANGER = "pilot-stranger";
const BACKEND = "b2-tmp";
const SECRET = "super-secret-b2-application-key";
const BUCKET = "lamasync-tmp";

let db: Database;
let app: { handle(request: Request): Promise<Response> };
let adminToken: string;
let deviceToken: string;

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, { ...init, headers: new Headers(init.headers) });
}

async function call(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; text: string; body: unknown }> {
  const response = await app.handle(
    request(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, text, body: parsed };
}

function enablePilot(over: Record<string, unknown> = {}): Promise<{ status: number; text: string; body: unknown }> {
  return call("PUT", "/api/v1/seed-pilot", adminToken, {
    enabled: true,
    folderId: "f1",
    sourceHostId: SOURCE,
    targetHostId: TARGET,
    backendId: BACKEND,
    bucket: BUCKET,
    confirm: true,
    ...over,
  });
}

function seedJobInPhase(phase: string): SeedJob {
  const now = Date.now();
  return {
    id: "pilot-job-1",
    planId: "plan-1",
    folderId: "f1",
    hostId: TARGET,
    sourceHostId: SOURCE,
    assignmentId: "a2",
    status: "running",
    phase: phase as SeedJob["phase"],
    progress: {
      phase: "preflight",
      phaseIndex: 0,
      phaseCount: 10,
      message: "",
      bytesDone: 0,
      bytesTotal: null,
      entriesDone: 0,
      entriesTotal: null,
      updatedAt: now,
    },
    source: { fileCount: 0, totalBytes: 0, measuredAt: now, measuredOnHostId: SOURCE, manifestFingerprint: null },
    archive: emptySeedJobArchiveFacts("tar.gz"),
    staging: { path: "", targetPath: "/t/Projects", requiredFreeBytes: 0, freeBytesAtPlan: null },
    leaseOwner: null,
    leaseExpiresAt: null,
    error: null,
    summary: null,
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    finishedAt: null,
  };
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
    INSERT INTO hosts (id, hostname, config_revision) VALUES ('${SOURCE}', 'source', 1);
    INSERT INTO hosts (id, hostname, config_revision) VALUES ('${TARGET}', 'target', 1);
    INSERT INTO hosts (id, hostname, config_revision) VALUES ('${STRANGER}', 'stranger', 1);
    INSERT INTO folders (id, name, type) VALUES ('f1', 'Projects', 'sync');
    INSERT INTO folder_assignments (id, folder_id, host_id, local_path, role, enabled) VALUES ('a1', 'f1', '${SOURCE}', '/s/Projects', 'both', 1);
    INSERT INTO folder_assignments (id, folder_id, host_id, local_path, role, enabled) VALUES ('a2', 'f1', '${TARGET}', '/t/Projects', 'both', 1);
    INSERT INTO backends (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, created_at)
      VALUES ('${BACKEND}', 'b2 tmp', 's3', 'b2', 'https://s3.us-east-005.backblazeb2.com', 'us-east-005', 'keyid-1', '${encryptSecret(SECRET)}', 1);
    INSERT INTO backends (id, name, kind, local_path, created_at) VALUES ('local-1', 'local', 'local', '/srv/x', 1);
    INSERT INTO backends (id, name, kind, s3_provider, s3_endpoint, s3_access_key_id, s3_secret_key_enc, created_at)
      VALUES ('nosecret', 'no secret', 's3', 'b2', 'https://s3.us-east-005.backblazeb2.com', 'keyid-2', '', 1);
  `);
  __setApiKeysDb(db);
  adminToken = insertManagedApiKey({ name: "admin", kind: "admin", hostId: null }).token;
  deviceToken = insertManagedApiKey({ name: "device", kind: "device", hostId: SOURCE }).token;
  __setPilotRouteDb(db);
  app = new Elysia().use(getAuthPlugin()).use(seedPilotRoutes);
});

afterEach(() => {
  __resetApiKeysDb();
  db.close();
});

describe("the seed pilot is admin-only", () => {
  test("a device key may read nothing and change nothing", async () => {
    expect((await call("GET", "/api/v1/seed-pilot", deviceToken)).status).toBe(403);
    expect((await enablePilot()).status).toBe(200);
    expect((await call("GET", "/api/v1/seed-pilot", deviceToken)).status).toBe(403);
    expect(
      (await call("PUT", "/api/v1/seed-pilot", deviceToken, { enabled: false, confirm: true })).status,
    ).toBe(403);
    expect((await call("DELETE", "/api/v1/seed-pilot", deviceToken)).status).toBe(403);
    expect((await call("POST", "/api/v1/seed-pilot/probe", deviceToken)).status).toBe(403);
  });

  test("an unauthenticated caller is refused", async () => {
    const response = await app.handle(request("/api/v1/seed-pilot"));
    expect([401, 403]).toContain(response.status);
  });
});

describe("a write that cannot be fully authorized is refused, specifically", () => {
  test("a missing folder, backend or assignment is named", async () => {
    const noFolder = await enablePilot({ folderId: "nope" });
    expect(noFolder.status).toBe(404);
    expect(noFolder.text).toContain("folder");

    const noBackend = await enablePilot({ backendId: "nope" });
    expect(noBackend.status).toBe(404);
    expect(noBackend.text).toContain("backend");

    const unassigned = await enablePilot({ sourceHostId: STRANGER });
    expect(unassigned.status).toBe(409);
    expect(unassigned.text).toContain("not assigned");
  });

  test("the same device cannot be both source and target", async () => {
    const same = await enablePilot({ targetHostId: SOURCE });
    expect(same.status).toBe(400);
    expect(same.text).toContain("cannot seed itself");
  });

  test("the temporary seed space must be an S3 backend WITH a stored secret", async () => {
    const local = await enablePilot({ backendId: "local-1" });
    expect(local.status).toBe(409);
    expect(local.text).toContain("S3 backend");

    const noSecret = await enablePilot({ backendId: "nosecret" });
    expect(noSecret.status).toBe(409);
    expect(noSecret.text).toContain("no stored S3 secret");
  });

  test("a malformed bucket name is refused before anything is stored", async () => {
    const bad = await enablePilot({ bucket: "Not A Bucket" });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("valid S3 bucket name");
    expect(getSeedPilotConfig(db)).toBeNull();
  });
});

describe("no secret ever leaves the pilot API", () => {
  test("the options block names the backend without its secret", async () => {
    const response = await call("GET", "/api/v1/seed-pilot", adminToken);
    expect(response.status).toBe(200);
    expect(response.text).not.toContain(SECRET);
    // The identifier is not a secret, and the UI needs it to show which key is
    // in use — plus `hasSecret` instead of the secret itself.
    expect(response.text).toContain("keyid-1");
    expect(response.text).toContain('"hasSecret":true');
    expect(response.text).toContain('"hasSecret":false');
  });

  test("the pilot write, the clear and the probe responses are secret-free too", async () => {
    const written = await enablePilot();
    expect(written.text).not.toContain(SECRET);
    const probe = await call("POST", "/api/v1/seed-pilot/probe", adminToken);
    expect(probe.text).not.toContain(SECRET);
    const cleared = await call("DELETE", "/api/v1/seed-pilot", adminToken);
    expect(cleared.text).not.toContain(SECRET);
  });

  test("the stored config itself holds no credential", async () => {
    await enablePilot();
    const stored = getSeedPilotConfig(db);
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    // ...and the row has no column that could hold one.
    const columns = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('seed_pilot_config')")
      .all()
      .map((row) => row.name);
    expect(columns.filter((name) => /secret|key|token|password/i.test(name))).toEqual([]);
  });
});

describe("the relay space is delivered to exactly the two parties of a live job", () => {
  test("nobody gets a space before a job exists, or when the pilot is off", () => {
    expect(seedRelaySpaceForHost(db, SOURCE)).toBeNull();
    expect(seedRelaySpaceForHost(db, TARGET)).toBeNull();
    expect(seedRelaySpaceForHost(db, STRANGER)).toBeNull();
  });

  test("the two parties get it, bound to the job and their side, and a stranger never does", async () => {
    await enablePilot();
    recordReadyProbe();
    createSeedJob(db, seedJobInPhase("uploading_archive"));

    const source = seedRelaySpaceForHost(db, SOURCE);
    const target = seedRelaySpaceForHost(db, TARGET);
    expect(source?.jobId).toBe("pilot-job-1");
    expect(source?.role).toBe("source");
    expect(target?.role).toBe("target");
    // The server-side resolver is where the secret is legitimately decrypted:
    // it goes into that device's OWN host config and nowhere else.
    expect(source?.secretAccessKey).toBe(SECRET);
    expect(source?.bucket).toBe(BUCKET);
    expect(seedRelaySpaceForHost(db, STRANGER)).toBeNull();
  });

  test("the space disappears once the job is terminal", async () => {
    await enablePilot();
    recordReadyProbe();
    for (const phase of ["completed", "failed", "cancelled"]) {
      db.run("DELETE FROM folder_seed_jobs");
      createSeedJob(db, seedJobInPhase(phase));
      expect(seedRelaySpaceForHost(db, SOURCE)).toBeNull();
      expect(seedRelaySpaceForHost(db, TARGET)).toBeNull();
    }
  });

  test("a job whose pair is not the pilot's pair issues nothing", async () => {
    await enablePilot();
    recordReadyProbe();
    const foreign = seedJobInPhase("uploading_archive");
    createSeedJob(db, { ...foreign, sourceHostId: STRANGER, hostId: TARGET });
    expect(seedRelaySpaceForHost(db, STRANGER)).toBeNull();
    expect(seedRelaySpaceForHost(db, TARGET)).toBeNull();
  });

  test("switching the pilot off revokes the space immediately", async () => {
    await enablePilot();
    recordReadyProbe();
    createSeedJob(db, seedJobInPhase("uploading_archive"));
    expect(seedRelaySpaceForHost(db, SOURCE)).not.toBeNull();
    await call("DELETE", "/api/v1/seed-pilot", adminToken);
    expect(seedRelaySpaceForHost(db, SOURCE)).toBeNull();
  });
});

describe("the readiness verdict is stored, and a failing probe is reported not thrown", () => {
  test("with no pilot, the probe says so instead of inventing a verdict", async () => {
    const response = await call("POST", "/api/v1/seed-pilot/probe", adminToken);
    expect(response.status).toBe(400);
    expect(response.text).toContain("not configured");
  });

  test("a probe against an unreachable endpoint FAILS the verdict and stores the reason", async () => {
    // Port 9 is the discard port: nothing listens, so the probe cannot succeed.
    // This is the "wrong bucket / no permission" shape without needing a bucket.
    db.run("UPDATE backends SET s3_endpoint = 'http://127.0.0.1:9' WHERE id = ?", [BACKEND]);
    await enablePilot();
    const response = await call("POST", "/api/v1/seed-pilot/probe", adminToken);
    expect(response.status).toBe(200);
    const body = response.body as { probe: { ok: boolean; detail: string }; config: { readiness: { state: string } } };
    expect(body.probe.ok).toBe(false);
    expect(body.config.readiness.state).toBe("failed");
    expect(response.text).not.toContain(SECRET);
    // The verdict is persisted, so a restart cannot turn it back into "unknown"
    // and a later job creation is refused on the stored failure.
    expect(getSeedPilotConfig(db)?.readiness.state).toBe("failed");
  });

  test("reconfiguring the pilot resets the verdict, so a stale pass cannot authorize a new bucket", async () => {
    db.run("UPDATE backends SET s3_endpoint = 'http://127.0.0.1:9' WHERE id = ?", [BACKEND]);
    await enablePilot();
    await call("POST", "/api/v1/seed-pilot/probe", adminToken);
    expect(getSeedPilotConfig(db)?.readiness.state).toBe("failed");
    await enablePilot({ bucket: "another-tmp-bucket" });
    expect(getSeedPilotConfig(db)?.readiness.state).toBe("unknown");
  });
});
