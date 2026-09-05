// LAMA-234: device-key authorization boundary tests.
//
// A device key is bound to one host: it must reach its own control-plane
// calls, get 403 for any other host's rows (including resource-ID-addressed
// rows like actions, conflicts, restore jobs), see only its own locks, and
// never reach fleet/admin routes. Master keys and admin keys keep the full
// surface.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "boundary-master-key-123456";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "boundary-secret-key-123456";
// Keep the dotfiles route on the same writable test path as dotfiles.test.ts
// when Bun runs route suites in one process.
process.env.LAMASYNC_BACKUP_DIR = process.env.LAMASYNC_BACKUP_DIR ?? "/tmp/lamasync-dotfiles-test";

const { getAuthPlugin } = await import("./auth.ts");
const { insertManagedApiKey, __setApiKeysDb, __resetApiKeysDb } = await import("./api-keys.ts");
const { __setDb: __setHostsDb, hostsRoutes } = await import("./routes/hosts.ts");
const { __setDb: __setConfigDb, configRoutes } = await import("./routes/config.ts");
const { __setDb: __setReportDb, reportRoutes } = await import("./routes/report.ts");
const { __setDb: __setActionsDb, actionsRoutes } = await import("./routes/actions.ts");
const { __setDb: __setOpsDb, operationsRoutes } = await import("./routes/operations.ts");
const { __setDb: __setConflictsDb, conflictsRoutes } = await import("./routes/conflicts.ts");
const { __setDb: __setResticDb, resticRoutes } = await import("./routes/restic.ts");
const { __setDb: __setFoldersDb, foldersRoutes } = await import("./routes/folders.ts");
const { __setDb: __setAppsDb, appsRoutes } = await import("./routes/apps.ts");
const { __setDb: __setConfigRevisionDb } = await import("./config-revision.ts");
const { __setCachedLatestVersionForTests } = await import("./release-cache.ts");
const { __resetNotificationStateForTests } = await import("./notifications.ts");

let db: Database;
let app: { handle(request: Request): Promise<Response> };
let deviceA: string; // token bound to host-a
let deployToken: string;
let adminToken: string;

function seedRow(sql: string, args: (string | number | null)[]): void {
  db.run(sql, args);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const m of MIGRATIONS) {
    try {
      db.exec(m);
    } catch {
      // idempotent
    }
  }
  __setApiKeysDb(db);
  __setHostsDb(db);
  __setConfigDb(db);
  __setReportDb(db);
  __setActionsDb(db);
  __setOpsDb(db);
  __setConflictsDb(db);
  __setResticDb(db);
  __setFoldersDb(db);
  __setAppsDb(db);
  // Register/heartbeat bump config revisions; point that seam at this db
  // too so it never touches the default path or another file's closed db.
  __setConfigRevisionDb(db);
  // Avoid real api.github.com fetches on every /hosts and /register call.
  __setCachedLatestVersionForTests("test-9.9.9");
  __resetNotificationStateForTests();

  // Two hosts; device-a is bound to host-a only.
  seedRow("INSERT INTO hosts (id, hostname) VALUES ('host-a', 'host-a')", []);
  seedRow("INSERT INTO hosts (id, hostname) VALUES ('host-b', 'host-b')", []);
  seedRow("INSERT INTO folders (id, name, type) VALUES ('f1', 'folder1', 'sync')", []);
  seedRow(
    "INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path, enabled, pre_sync_cmd, post_sync_cmd, restic_repository, restic_password) VALUES ('a1', 'f1', 'host-a', 'both', '/tmp/a', 1, 'before-safe', 'after-safe', 'restic://safe', 'safe-password')",
    [],
  );
  seedRow(
    "INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path, enabled) VALUES ('a2', 'f1', 'host-b', 'both', '/tmp/b', 1)",
    [],
  );
  seedRow(
    `INSERT INTO application_templates (id, name, origin, paths, created_at, updated_at) VALUES ('tpl-a', 'shared-app', 'custom', '{"paths":{"linux":[{"path":"~/.config/app","classification":"unknown"}],"macos":[],"windows":[]},"excludes":[],"notes":null}', 1, 1)`,
    [],
  );
  seedRow(
    `INSERT INTO application_protections (id, template_id, template_revision, host_id, name, enabled, destination, capture_spec, created_at, updated_at) VALUES ('prot-a', 'tpl-a', 1, 'host-a', 'shared-app', 1, 'server_archive', '{"paths":{"linux":[{"path":"~/.config/app","classification":"unknown"}],"macos":[],"windows":[]},"excludes":[],"notes":null}', 1, 1)`,
    [],
  );
  seedRow(
    `INSERT INTO application_protections (id, template_id, template_revision, host_id, name, enabled, destination, capture_spec, created_at, updated_at) VALUES ('prot-b', 'tpl-a', 1, 'host-b', 'shared-app', 1, 'server_archive', '{"paths":{"linux":[{"path":"~/.config/app","classification":"unknown"}],"macos":[],"windows":[]},"excludes":[],"notes":null}', 1, 1)`,
    [],
  );
  seedRow(
    `INSERT INTO application_snapshots (id, protection_id, template_id, template_revision, source_host_id, created_at, archive_path, archive_format, size_bytes, checksum_sha256, captured_spec, integrity_status, demo) VALUES ('snap-a', 'prot-a', 'tpl-a', 1, 'host-a', 1, 'apps/prot-a/1.tar.gz', 'tar.gz', 10, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '{"paths":{"linux":[{"path":"~/.config/app","classification":"unknown"}],"macos":[],"windows":[]},"excludes":[],"notes":null}', 'verified', 0)`,
    [],
  );
  seedRow(
    `INSERT INTO application_snapshots (id, protection_id, template_id, template_revision, source_host_id, created_at, archive_path, archive_format, size_bytes, checksum_sha256, captured_spec, integrity_status, demo) VALUES ('snap-b', 'prot-b', 'tpl-a', 1, 'host-b', 2, 'apps/prot-b/2.tar.gz', 'tar.gz', 20, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '{"paths":{"linux":[{"path":"~/.config/app","classification":"unknown"}],"macos":[],"windows":[]},"excludes":[],"notes":null}', 'verified', 0)`,
    [],
  );
  const a = insertManagedApiKey({ name: "device-a", kind: "device", hostId: "host-a" });
  deviceA = a.token;
  // host-b's own device key (should behave identically for host-b)
  insertManagedApiKey({ name: "device-b", kind: "device", hostId: "host-b" });
  adminToken = insertManagedApiKey({ name: "ops key", kind: "admin", hostId: null }).token;
  deployToken = insertManagedApiKey({ name: "deploy agent", kind: "deploy", hostId: null }).token;

  // Rows owned by host-b that device-a must never touch.
  seedRow(
    "INSERT INTO queued_actions (id, host_id, type, status, created_at) VALUES ('act-b', 'host-b', 'trigger_sync', 'pending', 1)",
    [],
  );
  seedRow(
    "INSERT INTO conflicts (id, host_id, folder_id, path, status, created_at) VALUES ('conf-b', 'host-b', 'f1', '/b', 'pending', 1)",
    [],
  );
  seedRow(
    "INSERT INTO restic_restore_jobs (id, snapshot_id, folder_id, target_host_id, target_path, status, created_at) VALUES ('job-b', 'snap1', 'f1', 'host-b', '/restore-b', 'pending', 1)",
    [],
  );
  // A row owned by host-a that device-a should be able to touch.
  seedRow(
    "INSERT INTO queued_actions (id, host_id, type, status, created_at) VALUES ('act-a', 'host-a', 'trigger_sync', 'pending', 1)",
    [],
  );

  app = new Elysia()
    .use(getAuthPlugin())
    .use(hostsRoutes)
    .use(configRoutes)
    .use(reportRoutes)
    .use(actionsRoutes)
    .use(operationsRoutes)
    .use(conflictsRoutes)
    .use(resticRoutes)
    .use(foldersRoutes)
    .use(appsRoutes);
});

afterEach(() => {
  __resetApiKeysDb();
  __setCachedLatestVersionForTests(null);
  db.close();
});

function as(token: string, method: string, path: string, body?: unknown): Request {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function statusOf(token: string, method: string, path: string, body?: unknown): Promise<number> {
  const res = await app.handle(as(token, method, path, body));
  return res.status;
}

const MASTER = process.env.LAMASYNC_API_KEY!;

describe("own-host access works for device keys", () => {
  test("config, host detail, register, heartbeat, report, pending actions", async () => {
    expect(await statusOf(deviceA, "GET", "/api/v1/config/host-a")).toBe(200);
    expect(await statusOf(deviceA, "GET", "/api/v1/hosts/host-a")).toBe(200);
    expect(await statusOf(deviceA, "POST", "/api/v1/register", { id: "host-a", hostname: "host-a" })).toBeLessThan(400);
    expect(await statusOf(deviceA, "POST", "/api/v1/report/health", { hostId: "host-a", timestamp: 1, status: "online" })).toBe(204);
    expect(await statusOf(deviceA, "POST", "/api/v1/report", { hostId: "host-a", operation: "sync", status: "success" })).toBe(204);
    expect(await statusOf(deviceA, "GET", "/api/v1/actions/pending?hostId=host-a")).toBe(200);
  });

  test("own queued action can be acked", async () => {
    expect(await statusOf(deviceA, "POST", "/api/v1/actions/act-a/complete", { status: "done" })).toBe(200);
  });

  test("may change only its own assignment mode", async () => {
    expect(
      await statusOf(deviceA, "PATCH", "/api/v1/folders/f1/assign/host-a", { mode: "mount" }),
    ).toBe(200);
    const row = db.query("SELECT mode FROM folder_assignments WHERE id = 'a1'").get() as { mode: string };
    expect(row.mode).toBe("mount");
  });

  test("own-host restic restore job can be created and updated", async () => {
    const created = await statusOf(deviceA, "POST", "/api/v1/restic/restore", {
      snapshotId: "snap1",
      folderId: "f1",
      targetHostId: "host-a",
      targetPath: "/restore-a",
    });
    expect(created).toBe(201);
    // Find the created job's id (device-a owns it) and update its status.
    const list = await app.handle(as(deviceA, "GET", "/api/v1/restic/restore?targetHostId=host-a"));
    const jobs = (await list.json()) as Array<{ id: string }>;
    expect(jobs.length).toBeGreaterThan(0);
    const jobId = jobs.find((j) => j.id !== "job-b")?.id;
    expect(jobId).toBeDefined();
    expect(
      await statusOf(deviceA, "POST", `/api/v1/restic/restore/${jobId}/status`, { status: "done" }),
    ).toBe(200);
  });

  test("own-host conflicts can be created and resolved", async () => {
    const created = await statusOf(deviceA, "POST", "/api/v1/conflicts", {
      conflicts: [{ hostId: "host-a", folderId: "f1", path: "/mine" }],
    });
    expect(created).toBe(201);
    const list = await app.handle(as(deviceA, "GET", "/api/v1/conflicts?hostId=host-a"));
    const rows = (await list.json()) as Array<{ id: string; hostId: string }>;
    const mine = rows.find((r) => r.hostId === "host-a");
    expect(rows.every((r) => r.hostId === "host-a")).toBe(true);
    expect(mine).toBeDefined();
    expect(
      await statusOf(deviceA, "POST", `/api/v1/conflicts/${mine!.id}/resolve`, { resolution: "local" }),
    ).toBe(200);
  });

  test("releaseStaleLocks path: sees only its own locks", async () => {
    await app.handle(as(deviceA, "POST", "/api/v1/operations/acquire", { folderId: "f1", hostId: "host-a" }));
    await statusOf(deviceA, "POST", "/api/v1/operations/heartbeat", { folderId: "f1", hostId: "host-a", lockId: undefined });
    // host-b's lock exists but device-a must not see it
    await app.handle(as(MASTER, "POST", "/api/v1/operations/acquire", { folderId: "f1", hostId: "host-b" }));
    const res = await app.handle(as(deviceA, "GET", "/api/v1/operations/locks"));
    const locks = (await res.json()) as Array<{ lockedBy: string }>;
    expect(locks.every((l) => l.lockedBy === "host-a")).toBe(true);
  });
});

describe("cross-host access is forbidden for device keys", () => {
  test("config, host detail, register, heartbeat, report for another host", async () => {
    expect(await statusOf(deviceA, "GET", "/api/v1/config/host-b")).toBe(403);
    expect(await statusOf(deviceA, "GET", "/api/v1/hosts/host-b")).toBe(403);
    expect(await statusOf(deviceA, "POST", "/api/v1/register", { id: "host-b", hostname: "host-b" })).toBe(403);
    expect(await statusOf(deviceA, "POST", "/api/v1/report/health", { hostId: "host-b", timestamp: 1, status: "online" })).toBe(403);
    expect(await statusOf(deviceA, "POST", "/api/v1/report", { hostId: "host-b", operation: "sync", status: "success" })).toBe(403);
    expect(await statusOf(deviceA, "GET", "/api/v1/actions/pending?hostId=host-b")).toBe(403);
  });

  test("cannot change another host's assignment mode", async () => {
    expect(
      await statusOf(deviceA, "PATCH", "/api/v1/folders/f1/assign/host-b", { mode: "mount" }),
    ).toBe(403);
  });

  test("cannot use assignment PATCH to change hooks or other settings", async () => {
    const attempts: Array<Record<string, unknown>> = [
      { preSyncCmd: "malicious-before" },
      { postSyncCmd: "malicious-after" },
      { resticRepository: "restic://attacker", resticPassword: "attacker-password" },
      { localPath: "/attacker/path" },
      { enabled: false },
      { cacheProfile: "minimal" },
      { mode: "sync", unknown: "must-not-be-ignored" },
      {},
    ];
    for (const body of attempts) {
      expect(
        await statusOf(deviceA, "PATCH", "/api/v1/folders/f1/assign/host-a", body),
      ).toBe(403);
    }
    const row = db.query(
      "SELECT mode, pre_sync_cmd, post_sync_cmd, restic_repository, restic_password, local_path, enabled, cache_profile FROM folder_assignments WHERE id = 'a1'",
    ).get() as {
      mode: string;
      pre_sync_cmd: string;
      post_sync_cmd: string;
      restic_repository: string;
      restic_password: string;
      local_path: string;
      enabled: number;
      cache_profile: string | null;
    };
    expect(row).toEqual({
      mode: "inherit",
      pre_sync_cmd: "before-safe",
      post_sync_cmd: "after-safe",
      restic_repository: "restic://safe",
      restic_password: "safe-password",
      local_path: "/tmp/a",
      enabled: 1,
      cache_profile: null,
    });
  });

  test("cannot enqueue actions or read action history", async () => {
    expect(
      await statusOf(deviceA, "POST", "/api/v1/hosts/host-a/actions", { type: "trigger_sync" }),
    ).toBe(403);
    expect(await statusOf(deviceA, "GET", "/api/v1/hosts/host-a/actions")).toBe(403);
  });

  test("cannot list another host's app protection or snapshot", async () => {
    expect(await statusOf(deviceA, "GET", "/api/v1/apps/protections/prot-b")).toBe(403);
    expect(await statusOf(deviceA, "GET", "/api/v1/apps/snapshots/snap-b")).toBe(403);
    expect(await statusOf(deviceA, "GET", "/api/v1/apps/snapshots/snap-b/download")).toBe(403);
    // No hostId -> device keys must not leak the fleet list.
    expect(await statusOf(deviceA, "GET", "/api/v1/apps/protections")).toBe(403);

    const scoped = await app.handle(as(deviceA, "GET", "/api/v1/apps/protections?hostId=host-a"));
    expect(scoped.status).toBe(200);
    const rows = (await scoped.json()) as Array<{ id: string; latestSnapshot: { id: string } | null }>;
    expect(rows.map((r) => r.id)).toEqual(["prot-a"]);
    expect(rows[0].latestSnapshot?.id).toBe("snap-a");
  });

  test("device cannot upload a snapshot to another host's protection", async () => {
    const form = new FormData();
    form.append("tarball", new File(["x"], "s.tar.gz", { type: "application/gzip" }), "s.tar.gz");
    const upload = await app.handle(
      new Request("http://localhost/api/v1/apps/protections/prot-b/snapshots", {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceA}` },
        body: form,
      }),
    );
    expect(upload.status).toBe(403);
  });

  test("resource-ID rows owned by another host: action, conflict, restore job", async () => {
    expect(await statusOf(deviceA, "POST", "/api/v1/actions/act-b/complete", { status: "done" })).toBe(403);
    expect(await statusOf(deviceA, "POST", "/api/v1/conflicts/conf-b/resolve", { resolution: "remote" })).toBe(403);
    expect(await statusOf(deviceA, "POST", "/api/v1/restic/restore/job-b/status", { status: "done" })).toBe(403);
    // and the rows are unchanged
    const row = db.query("SELECT status FROM queued_actions WHERE id = 'act-b'").get() as { status: string };
    expect(row.status).toBe("pending");
  });

  test("create restore/conflict for another host", async () => {
    expect(
      await statusOf(deviceA, "POST", "/api/v1/restic/restore", {
        snapshotId: "snap1",
        folderId: "f1",
        targetHostId: "host-b",
        targetPath: "/restore-b2",
      }),
    ).toBe(403);
    expect(
      await statusOf(deviceA, "POST", "/api/v1/conflicts", {
        conflicts: [{ hostId: "host-b", folderId: "f1", path: "/theirs" }],
      }),
    ).toBe(403);
    expect(await statusOf(deviceA, "POST", "/api/v1/operations/acquire", { folderId: "f1", hostId: "host-b" })).toBe(403);
  });

  test("device key must scope list endpoints to its own host", async () => {
    expect(await statusOf(deviceA, "GET", "/api/v1/restic/snapshots")).toBe(403); // no hostId → leak guard
    expect(await statusOf(deviceA, "GET", "/api/v1/conflicts")).toBe(403);
  });
});

describe("fleet/admin surface is off-limits to device keys", () => {
  test("host list, backends, folders, admin, app-profiles all 403", async () => {
    expect(await statusOf(deviceA, "GET", "/api/v1/hosts")).toBe(403);
    expect(await statusOf(deviceA, "GET", "/api/v1/backends")).toBe(403);
    expect(await statusOf(deviceA, "GET", "/api/v1/folders")).toBe(403);
    expect(await statusOf(deviceA, "GET", "/api/v1/admin/export")).toBe(403);
    expect(await statusOf(deviceA, "GET", "/api/v1/apps/templates")).toBe(403);
    expect(await statusOf(deviceA, "DELETE", "/api/v1/hosts/host-a")).toBe(403);
  });
});

describe("app mutations require an administrator", () => {
  test("deploy credentials cannot mutate protections or delete snapshots", async () => {
    expect(await statusOf(deployToken, "PUT", "/api/v1/apps/protections/prot-a", { enabled: false })).toBe(403);
    expect(await statusOf(deployToken, "DELETE", "/api/v1/apps/protections/prot-a")).toBe(403);
    expect(await statusOf(deployToken, "DELETE", "/api/v1/apps/snapshots/snap-a")).toBe(403);
    expect(db.query("SELECT id FROM application_protections WHERE id = 'prot-a'").get()).not.toBeNull();
    expect(db.query("SELECT id FROM application_snapshots WHERE id = 'snap-a'").get()).not.toBeNull();
    expect(await statusOf(deployToken, "DELETE", "/api/v1/hosts/host-a")).toBe(403);
  });

  test("managed admin credentials may update protections", async () => {
    expect(await statusOf(adminToken, "PUT", "/api/v1/apps/protections/prot-a", { enabled: false })).toBe(200);
  });
});

describe("master and admin keys keep the full surface", () => {
  test("master reaches cross-host and admin routes", async () => {
    expect(await statusOf(MASTER, "GET", "/api/v1/config/host-b")).toBe(200);
    expect(await statusOf(MASTER, "GET", "/api/v1/hosts")).toBe(200);
    expect(
      await statusOf(MASTER, "POST", "/api/v1/conflicts", {
        conflicts: [{ hostId: "host-b", folderId: "f1", path: "/admin-made" }],
      }),
    ).toBe(201);
    expect(
      await statusOf(MASTER, "POST", "/api/v1/hosts/host-a/actions", { type: "trigger_sync" }),
    ).toBe(201);
    const protList = await app.handle(as(MASTER, "GET", "/api/v1/apps/protections"));
    expect(protList.status).toBe(200);
    expect((await protList.json()) as unknown[]).toHaveLength(2);
  });

  test("admin managed key also keeps the full surface", async () => {
    const adminRow = db.query("SELECT id FROM api_keys WHERE kind = 'admin'").get() as { id: string };
    const adminToken = db
      .query("SELECT token_enc FROM api_keys WHERE id = ?")
      .get(adminRow.id) as { token_enc: string };
    // admin keys created in insertManagedApiKey store the token encrypted;
    // decrypt via the crypto module to act as this admin key.
    const { decryptSecret } = await import("./crypto.ts");
    const token = decryptSecret(adminToken.token_enc)!;
    expect(await statusOf(token, "GET", "/api/v1/config/host-b")).toBe(200);
    expect(await statusOf(token, "GET", "/api/v1/hosts")).toBe(200);
    expect(await statusOf(token, "POST", "/api/v1/actions/act-b/complete", { status: "done" })).toBe(200);
    expect(
      await statusOf(token, "POST", "/api/v1/hosts/host-a/actions", { type: "trigger_sync" }),
    ).toBe(201);
  });
});
