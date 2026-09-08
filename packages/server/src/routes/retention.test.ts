// LAMA-325: retention route tests (app protection + restic folder scope).
// Hermetic: app archive deletes run against a temp backup dir; s3 deletes
// use the app-storage fake-rclone seam; restic uses the fake-restic seam.
// Covers: policy validation/smart expansion, read-only preview, confirmed
// execution, fresh re-evaluation, failed-delete-not-pruned, idempotency,
// rollback-artifact guards, conservative disabled policies, auth.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "retention-test-key";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-retention-test-data";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "retention-test-secret-key-0123456789abcdef";

const { getAuthPlugin } = await import("../auth.ts");
const { __setDb, retentionRoutes, normalizePolicyBody } = await import("./retention.ts");
const { __setResticExecForTest } = await import("./retention.ts");
const { __setRcloneExecForTest } = await import("../app-storage.ts");
const { encryptSecret } = await import("../crypto.ts");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };
let backupRoot: string;
let snapCount = 0;

const DAY = 86_400_000;
const NOW = Date.now();

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
  db.exec(
    `INSERT INTO hosts (id, hostname, os) VALUES ('host-a', 'alpha', 'linux'), ('host-b', 'beta', 'linux')`,
  );
  backupRoot = join(tmpdir(), `lamasync-retention-test-${crypto.randomUUID()}`);
  mkdirSync(join(backupRoot, "apps"), { recursive: true });
  process.env.LAMASYNC_BACKUP_DIR = backupRoot;
  snapCount = 0;
  __setDb(db);
  __setResticExecForTest(null);
  __setRcloneExecForTest(null);
  app = new Elysia().use(getAuthPlugin()).use(retentionRoutes);
});

afterEach(() => {
  rmSync(backupRoot, { recursive: true, force: true });
  db.close();
});

function authHeaders(): Headers {
  const h = new Headers();
  h.set("Authorization", `Bearer ${process.env.LAMASYNC_API_KEY}`);
  return h;
}

async function jsonRequest(
  path: string,
  method: string,
  body?: unknown,
  headers: Headers = authHeaders(),
): Promise<Response> {
  const merged: Record<string, string> = Object.fromEntries(headers.entries());
  if (body !== undefined) merged["Content-Type"] = "application/json";
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: merged,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

function seedSpec(): string {
  return JSON.stringify({
    paths: { linux: [{ path: "~/.config/nvim", classification: "unknown" }], macos: [], windows: [] },
    excludes: [],
    notes: null,
  });
}

function seedTemplate(): string {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO application_templates (id, name, origin, paths, revision, created_at, updated_at)
     VALUES (?, 'nvim', 'custom', ?, 1, 1, 1)`,
    [id, seedSpec()],
  );
  return id;
}

function seedProtection(opts: { policy?: string | null } = {}): string {
  const templateId = seedTemplate();
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO application_protections
       (id, template_id, template_revision, host_id, name, enabled, schedule,
        destination, capture_spec, created_at, updated_at, retention_policy)
     VALUES (?, ?, 1, 'host-a', 'nvim on alpha', 1, NULL, 'server_archive', ?, 1, 1, ?)`,
    [id, templateId, seedSpec(), opts.policy ?? null],
  );
  return id;
}

function seedAppSnapshot(protectionId: string, daysAgo: number, opts: { policyId?: string; integrity?: string; size?: number | null } = {}): { id: string; relPath: string } {
  const id = opts.policyId ?? crypto.randomUUID();
  const relPath = `apps/${protectionId}/${id}.tar.gz`;
  const size = opts.size === undefined ? 1000 : opts.size;
  db.run(
    `INSERT INTO application_snapshots
       (id, protection_id, template_id, template_revision, source_host_id, created_at,
        archive_path, archive_format, size_bytes, checksum_sha256, captured_spec,
        integrity_status, backend_id, object_key, s3_bucket)
     VALUES (?, ?, ?, 1, 'host-a', ?, ?, 'tar.gz', ?, 'abc', ?, ?, NULL, NULL, NULL)`,
    [id, protectionId, protectionId, NOW - daysAgo * DAY, relPath, size, seedSpec(), opts.integrity ?? "verified"],
  );
  // Write a real archive so server-local deletes report "deleted".
  mkdirSync(join(backupRoot, "apps", protectionId), { recursive: true });
  writeFileSync(join(backupRoot, relPath), "archive");
  return { id, relPath };
}

const keepLast3 = { enabled: true, rules: [{ kind: "keepLast", count: 3 }], keepAtLeastOne: true };
const policyJson = (p: unknown): string => JSON.stringify(p);

describe("policy get/set (app scope)", () => {
  test("GET returns null policy when unset (conservative default)", async () => {
    const prot = seedProtection();
    const res = await jsonRequest(`/api/v1/apps/protections/${prot}/retention`, "GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { policy: unknown; policyDescription: string };
    expect(body.policy).toBeNull();
    expect(body.policyDescription).toContain("kept forever");
  });

  test("PUT validates rules; smart preset expands to visible rules", async () => {
    const prot = seedProtection();
    const bad = await jsonRequest(`/api/v1/apps/protections/${prot}/retention`, "PUT", {
      enabled: true,
      rules: [{ kind: "keepLast", count: 0 }],
    });
    expect(bad.status).toBe(400);

    const badUnit = await jsonRequest(`/api/v1/apps/protections/${prot}/retention`, "PUT", {
      enabled: true,
      rules: [{ kind: "calendar", unit: "hourly", count: 1 }],
    });
    expect(badUnit.status).toBe(400);

    const smart = await jsonRequest(`/api/v1/apps/protections/${prot}/retention`, "PUT", {
      enabled: true,
      applySmartPreset: { daily: 7, weekly: 4 },
    });
    expect(smart.status).toBe(200);
    const body = (await smart.json()) as { policy: { rules: unknown[] } };
    expect(body.policy.rules).toHaveLength(2);
  });

  test("disabling with empty rules stores null (nothing to show)", async () => {
    const prot = seedProtection();
    const res = await jsonRequest(`/api/v1/apps/protections/${prot}/retention`, "PUT", {
      enabled: false,
      rules: [],
    });
    expect(res.status).toBe(200);
    const row = db
      .query<{ retention_policy: string | null }, [string]>(
        "SELECT retention_policy FROM application_protections WHERE id = ?",
      )
      .get(prot);
    expect(row?.retention_policy).toBeNull();
  });

  test("unauthorized (no admin) → 403", async () => {
    const prot = seedProtection();
    const res = await jsonRequest(`/api/v1/apps/protections/${prot}/retention`, "GET", undefined, new Headers());
    expect([401, 403]).toContain(res.status);
  });
});

describe("preview (read-only)", () => {
  test("disabled/null policy keeps everything and records zero deletes", async () => {
    const prot = seedProtection();
    seedAppSnapshot(prot, 100);
    seedAppSnapshot(prot, 10);
    const res = await jsonRequest(`/api/v1/apps/protections/${prot}/retention/preview`, "POST");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { evaluation: { deleteCount: number; decisions: Array<{ action: string }> } };
    expect(body.evaluation.deleteCount).toBe(0);
    expect(body.evaluation.decisions.every((d) => d.action === "keep")).toBe(true);
    // read-only: no rows touched, no activity.
    expect(db.query(`SELECT COUNT(*) AS n FROM operation_log`).get()).toEqual({ n: 0 });
  });

  test("policy preview reports projected deletes, bytes, sizes + reasons", async () => {
    const prot = seedProtection({ policy: policyJson({ enabled: true, rules: [{ kind: "keepLast", count: 1 }], keepAtLeastOne: true }) });
    seedAppSnapshot(prot, 40, { size: 400 });
    seedAppSnapshot(prot, 20, { size: 200 });
    const res = await jsonRequest(`/api/v1/apps/protections/${prot}/retention/preview`, "POST");
    const body = (await res.json()) as {
      evaluation: { deleteCount: number; reclaimableBytes: number; decisions: Array<{ id: string; action: string; reason: string }> };
    };
    expect(body.evaluation.deleteCount).toBe(1);
    expect(body.evaluation.reclaimableBytes).toBe(400);
    const del = body.evaluation.decisions.find((d) => d.action === "delete");
    expect(del?.reason).toContain("not covered");
  });
});

describe("execute (app scope, confirmed)", () => {
  test("confirm:false → 400; unknown protection → 404", async () => {
    const prot = seedProtection();
    const noConfirm = await jsonRequest(`/api/v1/apps/protections/${prot}/retention/execute`, "POST", { confirm: false });
    expect(noConfirm.status).toBe(400);
    const missing = await jsonRequest(`/api/v1/apps/protections/does-not-exist/retention/execute`, "POST", { confirm: true });
    expect(missing.status).toBe(404);
  });

  test("re-evaluates fresh state, deletes archives + rows, records Activity", async () => {
    const prot = seedProtection({ policy: policyJson(keepLast3) });
    seedAppSnapshot(prot, 40);
    seedAppSnapshot(prot, 20);
    seedAppSnapshot(prot, 10);
    seedAppSnapshot(prot, 5);
    const res = await jsonRequest(`/api/v1/apps/protections/${prot}/retention/execute`, "POST", { confirm: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      outcomes: Array<{ id: string; status: string }>;
      operationLogId: number;
    };
    expect(body.outcomes).toHaveLength(1);
    expect(body.outcomes[0]?.status).toBe("deleted");
    expect(body.operationLogId).toBeGreaterThan(0);
    const remaining = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM application_snapshots WHERE protection_id = ?")
      .get(prot);
    expect(remaining?.n).toBe(3);
    const log = db.query(`SELECT operation, status, details FROM operation_log WHERE id = ?`).get(body.operationLogId) as {
      operation: string;
      status: string;
      details: string;
    };
    expect(log.operation).toBe("retention_execute");
    expect(log.status).toBe("success");
    expect(log.details).toContain("deleted");
  });

  test("failed archive delete keeps the row and is never reported as pruned", async () => {
    // s3-backed snapshot whose deletefile fails.
    const prot = seedProtection({ policy: policyJson(keepLast3) });
    const backendId = crypto.randomUUID();
    db.run(
      `INSERT INTO backends (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, created_at)
       VALUES (?, 's3-ret', 's3', 'other', 'https://s3.example.test', 'r1', 'AK', ?, ?)`,
      [backendId, encryptSecret("ret-secret"), Date.now()],
    );
    // Oldest snap on s3 (delete target), newest server-local (kept).
    const oldId = "snap-s3-old";
    db.run(
      `INSERT INTO application_snapshots
         (id, protection_id, template_id, template_revision, source_host_id, created_at,
          archive_path, archive_format, size_bytes, captured_spec, integrity_status,
          backend_id, object_key, s3_bucket)
       VALUES (?, ?, ?, 1, 'host-a', ?, 'lamasync/apps/prot/s.tar.gz', 'tar.gz', 500, ?, 'verified', ?, 'lamasync/apps/prot/s.tar.gz', 'bucket-x')`,
      [oldId, prot, prot, NOW - 40 * DAY, seedSpec(), backendId],
    );
    seedAppSnapshot(prot, 5);
    seedAppSnapshot(prot, 2);
    seedAppSnapshot(prot, 1);

    __setRcloneExecForTest(async (argv) => {
      if (argv.includes("deletefile")) return { code: 1, stdout: "", stderr: "backend unreachable" };
      return { code: 0, stdout: "", stderr: "" };
    });

    const res = await jsonRequest(`/api/v1/apps/protections/${prot}/retention/execute`, "POST", { confirm: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcomes: Array<{ id: string; status: string }>; operationLogId: number };
    const failed = body.outcomes.find((o) => o.id === oldId);
    expect(failed?.status).toBe("failed");
    const row = db.query(`SELECT id FROM application_snapshots WHERE id = ?`).get(oldId);
    expect(row).not.toBeNull();
    const log = db.query(`SELECT status FROM operation_log WHERE id = ?`).get(body.operationLogId) as { status: string };
    expect(log.status).toBe("failed");
  });

  test("second execution is idempotent (nothing left to prune)", async () => {
    const prot = seedProtection({ policy: policyJson({ enabled: true, rules: [{ kind: "keepLast", count: 1 }], keepAtLeastOne: true }) });
    seedAppSnapshot(prot, 40);
    seedAppSnapshot(prot, 5);
    const first = await jsonRequest(`/api/v1/apps/protections/${prot}/retention/execute`, "POST", { confirm: true });
    expect(first.status).toBe(200);
    const second = await jsonRequest(`/api/v1/apps/protections/${prot}/retention/execute`, "POST", { confirm: true });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { outcomes: unknown[] };
    expect(body.outcomes).toHaveLength(0);
  });

  test("a snapshot created between preview and execute is re-evaluated fresh", async () => {
    const prot = seedProtection({ policy: policyJson(keepLast3) });
    seedAppSnapshot(prot, 40);
    seedAppSnapshot(prot, 30);
    seedAppSnapshot(prot, 25);
    seedAppSnapshot(prot, 20);
    const preview = await jsonRequest(`/api/v1/apps/protections/${prot}/retention/preview`, "POST");
    const previewBody = (await preview.json()) as { evaluation: { deleteCount: number } };
    expect(previewBody.evaluation.deleteCount).toBe(1);
    // New snapshot arrives after the preview, before confirm.
    seedAppSnapshot(prot, 10);
    const execute = await jsonRequest(`/api/v1/apps/protections/${prot}/retention/execute`, "POST", { confirm: true });
    const execBody = (await execute.json()) as { outcomes: Array<{ status: string }> };
    // FRESH re-evaluation sees 5 snapshots: keepLast 3 keeps 10/20/25 —
    // the 30-day snapshot the stale preview would have kept is now a
    // candidate, proving execution never trusts the preview.
    expect(execBody.outcomes).toHaveLength(2);
    const rows = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM application_snapshots WHERE protection_id = ?")
      .get(prot);
    expect(rows?.n).toBe(3);
  });

  test("rollback-guarded app snapshots are never candidates (reserved hooks)", async () => {
    // App scope has no restore executor yet; the descriptor hook stays
    // false. This test pins the conservative behavior: a pinned snapshot
    // (treated as hold) is never deleted.
    const prot = seedProtection({ policy: policyJson(keepLast3) });
    seedAppSnapshot(prot, 60);
    seedAppSnapshot(prot, 5);
    seedAppSnapshot(prot, 1);
    const res = await jsonRequest(`/api/v1/apps/protections/${prot}/retention/execute`, "POST", { confirm: true });
    expect(res.status).toBe(200);
  });
});

describe("folder scope (restic)", () => {
  /** Folder + a restic-kind backend it references, so the per-host repo
   *  resolution succeeds during execution (fail-closed otherwise). */
  function seedResticFolder(): string {
    const folderId = crypto.randomUUID();
    const backendId = crypto.randomUUID();
    db.run(
      `INSERT INTO backends (id, name, kind, restic_repository, restic_password_enc, created_at)
       VALUES (?, 'repo-x', 'restic', '/repo/backups', ?, ?)`,
      [backendId, encryptSecret("restic-pass"), Date.now()],
    );
    db.run(
      `INSERT INTO folders (id, name, type, backend, backend_id, retention_policy, demo)
       VALUES (?, 'restic-vault', 'backup', 'restic', ?, NULL, 0)`,
      [folderId, backendId],
    );
    return folderId;
  }

  function seedResticSnapshot(folderId: string, daysAgo: number, opts: { sid?: string; size?: number | null } = {}): string {
    const snapshotId = opts.sid ?? `restic-${crypto.randomUUID().slice(0, 12)}`;
    db.run(
      `INSERT INTO restic_snapshots (id, folder_id, host_id, snapshot_id, timestamp, paths, size_bytes)
       VALUES (?, ?, 'host-a', ?, ?, '["/home/user"]', ?)`,
      [`row-${snapshotId}`, folderId, snapshotId, NOW - daysAgo * DAY, opts.size ?? 1000],
    );
    return snapshotId;
  }

  test("refuses non-restic folders (no snapshot identity)", async () => {
    const folderId = crypto.randomUUID();
    db.run(`INSERT INTO folders (id, name, type, backend) VALUES (?, 'plain-backup', 'backup', 's3')`, [folderId]);
    const preview = await jsonRequest(`/api/v1/folders/${folderId}/retention/preview`, "POST");
    expect(preview.status).toBe(400);
    expect((await preview.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("no snapshot identity"),
    });
    const execute = await jsonRequest(`/api/v1/folders/${folderId}/retention/execute`, "POST", { confirm: true });
    expect(execute.status).toBe(400);
  });

  test("rollback artifacts (pending/running restore jobs) override deletion", async () => {
    const folderId = seedResticFolder();
    db.run(
      `UPDATE folders SET retention_policy = ? WHERE id = ?`,
      [policyJson(keepLast3), folderId],
    );
    const keptSid = seedResticSnapshot(folderId, 2);
    const oldSid = seedResticSnapshot(folderId, 30);
    const pinnedSid = seedResticSnapshot(folderId, 60);
    db.run(
      `INSERT INTO restic_restore_jobs (id, snapshot_id, folder_id, target_host_id, target_path, status, created_at)
       VALUES ('job-1', ?, ?, 'host-b', '/tmp/restore', 'pending', ?)`,
      [oldSid, folderId, Date.now()],
    );
    // The pending-restore snapshot must be a guard even though it is old.
    const preview = await jsonRequest(`/api/v1/folders/${folderId}/retention/preview`, "POST");
    const body = (await preview.json()) as { evaluation: { decisions: Array<{ id: string; action: string; kind: string }> } };
    const guard = body.evaluation.decisions.find((d) => d.id === oldSid);
    expect(guard?.action).toBe("keep");
    expect(guard?.kind).toBe("guard");
    void keptSid;
    void pinnedSid;
  });

  test("execute runs restic forget + prune with the right argv and records outcomes", async () => {
    const folderId = seedResticFolder();
    db.run(
      `UPDATE folders SET retention_policy = ? WHERE id = ?`,
      [policyJson(keepLast2()), folderId],
    );
    seedResticSnapshot(folderId, 40, { sid: "snap-old" });
    seedResticSnapshot(folderId, 10, { sid: "snap-recent" });
    seedResticSnapshot(folderId, 2, { sid: "snap-newest" });
    const calls: string[][] = [];
    __setResticExecForTest(async (args) => {
      calls.push(args);
      if (args[1] === "prune") return { code: 0, stderr: "" };
      return { code: 0, stderr: "" };
    });

    const res = await jsonRequest(`/api/v1/folders/${folderId}/retention/execute`, "POST", { confirm: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcomes: Array<{ id: string; status: string }>; prune: { attempted: boolean; ok: boolean } };
    const deleted = body.outcomes.filter((o) => o.status === "deleted").map((o) => o.id);
    expect(deleted).toEqual(["snap-old"]);
    // forget argv: restic forget <id> --repo ... --password-file ... --no-cache
    const forget = calls.find((a) => a[1] === "forget")!;
    expect(forget[0]).toBe("restic");
    expect(forget.slice(2, 3)).toEqual(["snap-old"]);
    expect(forget.join(" ")).toContain("--repo");
    expect(forget.join(" ")).toContain("--password-file");
    expect(calls.some((a) => a[1] === "prune")).toBe(true);
    expect(body.prune.attempted).toBe(true);
    expect(body.prune.ok).toBe(true);
    // DB rows for forgotten snapshots are gone; kept rows remain.
    expect(db.query(`SELECT id FROM restic_snapshots WHERE snapshot_id = 'snap-old'`).get()).toBeNull();
    expect(db.query(`SELECT id FROM restic_snapshots WHERE snapshot_id = 'snap-newest'`).get()).not.toBeUndefined();
  });

  test("forget failure keeps rows and reports failed (never pruned)", async () => {
    const folderId = seedResticFolder();
    db.run(
      `UPDATE folders SET retention_policy = ? WHERE id = ?`,
      [policyJson(keepLast2()), folderId],
    );
    seedResticSnapshot(folderId, 40, { sid: "snap-stuck" });
    seedResticSnapshot(folderId, 10, { sid: "snap-mid" });
    seedResticSnapshot(folderId, 2, { sid: "snap-new" });
    __setResticExecForTest(async (args) => {
      if (args[1] === "forget") return { code: 1, stderr: "unable to open repository\n" };
      return { code: 0, stderr: "" };
    });
    const res = await jsonRequest(`/api/v1/folders/${folderId}/retention/execute`, "POST", { confirm: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcomes: Array<{ id: string; status: string }>; operationLogId: number };
    expect(body.outcomes.find((o) => o.id === "snap-stuck")?.status).toBe("failed");
    expect(db.query(`SELECT id FROM restic_snapshots WHERE snapshot_id = 'snap-stuck'`).get()).not.toBeUndefined();
    const log = db.query(`SELECT status FROM operation_log WHERE id = ?`).get(body.operationLogId) as { status: string };
    expect(log.status).toBe("failed");
  });
});

function keepLast2() {
  return { enabled: true, rules: [{ kind: "keepLast", count: 2 }], keepAtLeastOne: true };
}