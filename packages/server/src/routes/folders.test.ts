// Unit tests for the /api/v1/folders routes — focused on the S3 backend
// validation/persistence added for LAMA-105. SFTP behavior is exercised by
// the e2e smoke checks, not here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "folders-test-key";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-folders-test-data";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "folders-test-secret-key-0123456789abcdef";

// `db.ts` reads LAMASYNC_DATA_DIR on first import. The env vars above must
// be set before that happens, so use dynamic import for the auth + route
// modules (matching the pattern used by operations/dotfiles/report tests).
const { getAuthPlugin } = await import("../auth.ts");
const { __setDb, foldersRoutes } = (await import("./folders.ts")) as unknown as {
  __setDb: (db: Database) => void;
  foldersRoutes: Elysia;
};
const { __setDb: __setConfigRevisionDb } = (await import("../config-revision.ts")) as unknown as {
  __setDb: (db: Database) => void;
};
const { __setDb: __setConfigDb } = (await import("./config.ts")) as unknown as {
  __setDb: (db: Database) => void;
};
const { encryptSecret } = await import("../crypto.ts");

// LAMA-222: folders reference a reusable Backend row; tests insert one
// directly (the backends routes have their own test file).
function insertBackend(opts: {
  name: string;
  kind?: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  localPath?: string;
}): { id: string; name: string; kind: string } {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO backends
       (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, local_path, created_at)
     VALUES (?, ?, ?, 'other', ?, NULL, ?, ?, ?, ?)`,
    [
      id,
      opts.name,
      opts.kind ?? "s3",
      opts.s3Endpoint ?? null,
      opts.s3AccessKeyId ?? null,
      opts.s3SecretAccessKey ? encryptSecret(opts.s3SecretAccessKey) : null,
      opts.localPath ?? null,
      Date.now(),
    ],
  );
  return { id, name: opts.name, kind: opts.kind ?? "s3" };
}

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // Migrations are intentionally idempotent for pre-existing schemas.
    }
  }
  __setDb(db);
  // config-revision.ts holds its own activeDb; point it at the test DB
  // so folder create/update/delete bumps land in the same in-memory store.
  __setConfigRevisionDb(db);
  // config.ts holds its own activeDb too — wire it so the LAMA-239
  // config SELECT test reads the same in-memory DB the assignments
  // were just inserted into.
  __setConfigDb(db);
  // LAMA-241: bare folder creates default to the first existing backend;
  // seed one so the legacy tests that omit `backend` keep working (and the
  // defaulting path is exercised implicitly). Tests that need a specific
  // "first" backend (or none at all) clear the table first.
  insertBackend({ name: "__seed__", kind: "local", localPath: "/srv/seed" });
  app = new Elysia().use(getAuthPlugin()).use(foldersRoutes);
});

afterEach(() => {
  db.close();
});

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${process.env.LAMASYNC_API_KEY}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(request(path, { method: "POST", body: JSON.stringify(body) }));
}

async function putJson(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(request(path, { method: "PUT", body: JSON.stringify(body) }));
}

// LAMA-222: an s3 folder references a reusable Backend (credentials live
// there); only the bucket name stays on the folder. These tests exercise the
// new validation and the redaction story that moved to the Backend entity.
describe("POST /api/v1/folders — backend validation (LAMA-105, LAMA-222)", () => {
  test("rejects s3 backend without a backend reference", async () => {
    const res = await postJson("/api/v1/folders", {
      name: "exoscale-vault",
      type: "sync",
      backend: "s3",
      s3Bucket: "lamasync-vault",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("backendId");
  });

  test("rejects s3 backend referencing a non-existent backend", async () => {
    const res = await postJson("/api/v1/folders", {
      name: "ghost-vault",
      type: "sync",
      backend: "s3",
      backendId: "no-such-backend",
      s3Bucket: "bucket",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not found");
  });

  test("creates an s3-backed folder from a backend + bucket", async () => {
    const backend = await insertBackend({
      name: "test-r2",
      s3Endpoint: "sos-at-vie-1.exo.io",
      s3Bucket: "unused",
      s3AccessKeyId: "EXO_KEY",
      s3SecretAccessKey: "EXO_SECRET",
    });
    const res = await postJson("/api/v1/folders", {
      name: "exoscale-vault",
      type: "sync",
      backend: "s3",
      backendId: backend.id,
      s3Bucket: "lamasync-vault",
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(201);
    expect(body.backend).toBe("s3");
    expect(body.backendId).toBe(backend.id);
    expect(body.s3Bucket).toBe("lamasync-vault");
    // Secrets never appear on the folder — they live on the Backend row.
    expect(body.s3SecretAccessKey).toBeUndefined();
    expect(body.s3AccessKeyId).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("EXO_SECRET");
  });

  test("defaults to the first existing backend when backend is omitted (LAMA-241)", async () => {
    // The seeded local backend is cleared so this test's backend is first.
    db.run("DELETE FROM backends");
    const backend = insertBackend({
      name: "first-backend",
      kind: "local",
      localPath: "/srv/data",
    });
    const res = await postJson("/api/v1/folders", {
      name: "legacy",
      type: "sync",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.backend).toBe("local");
    expect(body.backendId).toBe(backend.id);
  });

  test("s3 bucket is required", async () => {
    const backend = await insertBackend({
      name: "no-bucket-r2",
      s3Endpoint: "s3.example.com",
      s3Bucket: "unused",
      s3AccessKeyId: "KEY",
      s3SecretAccessKey: "SECRET",
    });
    const res = await postJson("/api/v1/folders", {
      name: "no-bucket",
      type: "sync",
      backend: "s3",
      backendId: backend.id,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("s3Bucket");
  });

  test("a non-s3 backend cannot be referenced by an s3 folder", async () => {
    const backend = await insertBackend({
      name: "not-s3",
      kind: "nfs",
      s3Endpoint: "s3.example.com",
      s3Bucket: "unused",
      s3AccessKeyId: "KEY",
      s3SecretAccessKey: "SECRET",
    });
    const res = await postJson("/api/v1/folders", {
      name: "wrong-kind",
      type: "sync",
      backend: "s3",
      backendId: backend.id,
      s3Bucket: "bucket",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not an S3 backend");
  });
});

describe("PUT /api/v1/folders/:id — backend updates (LAMA-105, LAMA-222)", () => {
  test("switching to s3 requires a backend reference + bucket", async () => {
    const created = await postJson("/api/v1/folders", {
      name: "flip",
      type: "sync",
      // explicit sftp keeps backend_id NULL so the s3 switch can't reuse
      // an unrelated backend reference (LAMA-241 defaulting changed bare
      // creates to pick the first existing backend).
      backend: "sftp",
    });
    const { id } = (await created.json()) as { id: string };

    const res = await putJson(`/api/v1/folders/${id}`, {
      backend: "s3",
      s3Bucket: "bucket",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("backendId");
  });

  test("switching to s3 with a valid backend persists backendId", async () => {
    const backend = await insertBackend({
      name: "flip-backend",
      s3Endpoint: "s3.example.com",
      s3Bucket: "unused",
      s3AccessKeyId: "K",
      s3SecretAccessKey: "S",
    });
    const created = await postJson("/api/v1/folders", {
      name: "flip2",
      type: "sync",
    });
    const { id } = (await created.json()) as { id: string };

    const res = await putJson(`/api/v1/folders/${id}`, {
      backend: "s3",
      backendId: backend.id,
      s3Bucket: "bucket",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.backend).toBe("s3");
    expect(body.backendId).toBe(backend.id);
    expect(body.s3Bucket).toBe("bucket");
  });

  test("switching off s3 clears the backend reference", async () => {
    const backend = await insertBackend({
      name: "flip-backend-off",
      s3Endpoint: "s3.example.com",
      s3Bucket: "unused",
      s3AccessKeyId: "K",
      s3SecretAccessKey: "S",
    });
    const created = await postJson("/api/v1/folders", {
      name: "flip-back",
      type: "sync",
      backend: "s3",
      backendId: backend.id,
      s3Bucket: "bucket",
    });
    const { id } = (await created.json()) as { id: string };

    const res = await putJson(`/api/v1/folders/${id}`, {
      backend: "sftp",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.backend).toBe("sftp");
    expect(body.backendId).toBeNull();
    expect(body.s3Bucket).toBeNull();
  });
});

describe("GET /api/v1/folders — s3 credentials stay off the folder (LAMA-178, LAMA-222)", () => {
  async function createS3Folder(): Promise<string> {
    const backend = await insertBackend({
      name: "redact-me-backend",
      s3Endpoint: "s3.example.com",
      s3Bucket: "unused",
      s3AccessKeyId: "KEY",
      s3SecretAccessKey: "TOP_SECRET",
    });
    const res = await postJson("/api/v1/folders", {
      name: "redact-me",
      type: "sync",
      backend: "s3",
      backendId: backend.id,
      s3Bucket: "bucket",
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    return id;
  }

  test("GET /folders never leaks backend credentials", async () => {
    await createS3Folder();
    const res = await app.handle(request("/api/v1/folders"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body.length).toBe(1);
    expect(body[0]?.s3Bucket).toBe("bucket");
    expect(JSON.stringify(body)).not.toContain("TOP_SECRET");
    expect(JSON.stringify(body)).not.toContain("KEY");
  });

  test("GET /folders/:id returns the backend reference, not credentials", async () => {
    const id = await createS3Folder();
    const res = await app.handle(request(`/api/v1/folders/${id}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.backendId).toBeTruthy();
    expect(body.s3Bucket).toBe("bucket");
    expect(JSON.stringify(body)).not.toContain("TOP_SECRET");
  });
});

describe("config_revision bumps (LAMA-198)", () => {
  function getRev(hostId: string): number {
    db.run(`INSERT OR IGNORE INTO hosts (id, hostname) VALUES (?, ?)`, [hostId, hostId]);
    const row = db
      .query<{ config_revision: number | null }, [string]>(
        "SELECT config_revision FROM hosts WHERE id = ?",
      )
      .get(hostId);
    return row?.config_revision ?? 0;
  }

  test("POST /folders bumps every host's revision", async () => {
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('a','a'), ('b','b')`);
    const beforeA = getRev("a");
    const beforeB = getRev("b");

    const res = await postJson("/api/v1/folders", { name: "fresh", type: "sync" });
    expect(res.status).toBe(201);

    expect(getRev("a")).toBe(beforeA + 1);
    expect(getRev("b")).toBe(beforeB + 1);
  });

  test("PUT /folders/:id bumps only assigned hosts", async () => {
    const created = await postJson("/api/v1/folders", { name: "x", type: "sync" });
    const folderId = ((await created.json()) as { id: string }).id;

    db.run(`INSERT INTO hosts (id, hostname) VALUES ('a','a'), ('b','b'), ('c','c')`);
    db.run(
      `INSERT INTO folder_assignments
         (id, folder_id, host_id, role, local_path, enabled)
       VALUES ('as-b', ?, 'b', 'both', '/tmp/b', 1)`,
      [folderId],
    );
    const beforeA = getRev("a");
    const beforeB = getRev("b");
    const beforeC = getRev("c");

    await putJson(`/api/v1/folders/${folderId}`, { name: "x-renamed" });

    expect(getRev("a")).toBe(beforeA);
    expect(getRev("b")).toBe(beforeB + 1);
    expect(getRev("c")).toBe(beforeC);
  });

  test("assign / unassign / patch bump the affected host", async () => {
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('a','a'), ('b','b')`);
    const folder = (await (await postJson("/api/v1/folders", { name: "x", type: "sync" })).json()) as { id: string };

    const beforeA = getRev("a");
    const beforeB = getRev("b");

    await postJson(`/api/v1/folders/${folder.id}/assign`, {
      hostId: "a",
      role: "both",
      localPath: "/tmp/a",
    });
    expect(getRev("a")).toBe(beforeA + 1);
    expect(getRev("b")).toBe(beforeB);

    const beforeA2 = getRev("a");
    const beforeB2 = getRev("b");
    await app.handle(
      request(`/api/v1/folders/${folder.id}/assign/a`, { method: "DELETE" }),
    );
    expect(getRev("a")).toBe(beforeA2 + 1);
    expect(getRev("b")).toBe(beforeB2);

    // Re-assign to b for the patch test.
    await postJson(`/api/v1/folders/${folder.id}/assign`, {
      hostId: "b",
      role: "both",
      localPath: "/tmp/b",
    });
    const beforeB3 = getRev("b");
    await app.handle(
      new Request(`http://localhost/api/v1/folders/${folder.id}/assign/b`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.LAMASYNC_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(getRev("b")).toBe(beforeB3 + 1);
  });

  test("PATCH assignment accepts role / localPath / bandwidthSchedule", async () => {
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('a','a')`);
    const folder = (await (await postJson("/api/v1/folders", { name: "x", type: "sync" })).json()) as { id: string };
    const created = (await (await postJson(`/api/v1/folders/${folder.id}/assign`, {
      hostId: "a",
      role: "both",
      localPath: "/tmp/a",
    })).json()) as { folderId: string; hostId: string; role: string; localPath: string };

    const res = await app.handle(
      new Request(`http://localhost/api/v1/folders/${folder.id}/assign/a`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.LAMASYNC_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          role: "source",
          localPath: "/mnt/data/new",
          bandwidthSchedule: "08:00,512K 12:00,10M",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const patched = (await res.json()) as {
      role: string;
      localPath: string;
      bandwidthSchedule: string | null;
    };
    expect(patched.role).toBe("source");
    expect(patched.localPath).toBe("/mnt/data/new");
    expect(patched.bandwidthSchedule).toBe("08:00,512K 12:00,10M");
    expect(created.folderId).toBe(folder.id);
  });
});

describe("POST /api/v1/folders/:id/assign — host existence (LAMA-215)", () => {
  test("unknown hostId returns 404 and does not insert", async () => {
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('real-host','real-host')`);
    const folder = (await (await postJson("/api/v1/folders", { name: "x", type: "sync" })).json()) as { id: string };

    const res = await postJson(`/api/v1/folders/${folder.id}/assign`, {
      hostId: "no-such-host",
      role: "both",
      localPath: "/tmp/nope",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Host not found");

    const rows = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM folder_assignments")
      .get() as { count: number };
    expect(rows.count).toBe(0);
  });

  test("known hostId returns 201", async () => {
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('real-host','real-host')`);
    const folder = (await (await postJson("/api/v1/folders", { name: "y", type: "sync" })).json()) as { id: string };

    const res = await postJson(`/api/v1/folders/${folder.id}/assign`, {
      hostId: "real-host",
      role: "both",
      localPath: "/tmp/yes",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { hostId: string };
    expect(body.hostId).toBe("real-host");
  });
});

describe("POST /api/v1/folders — default backend (LAMA-241)", () => {
  test("defaults an s3 first backend and still requires the bucket", async () => {
    db.run("DELETE FROM backends");
    insertBackend({
      name: "only-s3",
      s3Endpoint: "sos-at-vie-1.exo.io",
      s3Bucket: "unused",
      s3AccessKeyId: "EXO_KEY",
      s3SecretAccessKey: "EXO_SECRET",
    });
    // No bucket given → the defaulted s3 backend still needs one.
    const res = await postJson("/api/v1/folders", {
      name: "defaulted-s3-no-bucket",
      type: "sync",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("s3Bucket");
  });

  test("400 when no backend exists to default to", async () => {
    db.run("DELETE FROM backends");
    const res = await postJson("/api/v1/folders", {
      name: "no-backend-folder",
      type: "sync",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("no backends configured");
  });

  test("explicit sftp backend is still honored (legacy inline backend)", async () => {
    const res = await postJson("/api/v1/folders", {
      name: "legacy-sftp",
      type: "sync",
      backend: "sftp",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { backend?: string | null };
    expect(body.backend).toBe("sftp");
  });
});

describe("PUT/PATCH/DELETE /api/v1/assignments/:id — 405 guidance (LAMA-241)", () => {
  for (const method of ["PUT", "PATCH", "DELETE"] as const) {
    test(`${method} returns 405 pointing at the folder+host route`, async () => {
      const res = await app.handle(
        request(`/api/v1/assignments/any-id`, { method, body: JSON.stringify({}) }),
      );
      expect(res.status).toBe(405);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("/folders/:folderId/assign/:hostId");
    });
  }
});

// LAMA-239: per-host sync/mount override (mode column on folder_assignments).
describe("per-host mount/sync override (LAMA-239)", () => {
  async function setupSyncFolder(): Promise<string> {
    const res = await postJson("/api/v1/folders", { name: "v", type: "sync" });
    return ((await res.json()) as { id: string }).id;
  }

  test("POST /assign defaults mode to inherit", async () => {
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('h','h')`);
    const folderId = await setupSyncFolder();
    const res = await postJson(`/api/v1/folders/${folderId}/assign`, {
      hostId: "h",
      role: "both",
      localPath: "/tmp/v",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mode?: string };
    expect(body.mode).toBe("inherit");
  });

  test("POST /assign accepts mode: mount", async () => {
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('h','h')`);
    const folderId = await setupSyncFolder();
    const res = await postJson(`/api/v1/folders/${folderId}/assign`, {
      hostId: "h",
      role: "both",
      localPath: "/tmp/v",
      mode: "mount",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mode?: string };
    expect(body.mode).toBe("mount");
  });

  test("POST /assign rejects invalid mode values", async () => {
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('h','h')`);
    const folderId = await setupSyncFolder();
    const res = await postJson(`/api/v1/folders/${folderId}/assign`, {
      hostId: "h",
      role: "both",
      localPath: "/tmp/v",
      mode: "bogus",
    });
    expect(res.status).toBe(422);
  });

  test("PATCH /assign/:hostId persists mode", async () => {
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('h','h')`);
    const folderId = await setupSyncFolder();
    await postJson(`/api/v1/folders/${folderId}/assign`, {
      hostId: "h",
      role: "both",
      localPath: "/tmp/v",
    });

    const patchRes = await app.handle(
      new Request(`http://localhost/api/v1/folders/${folderId}/assign/h`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.LAMASYNC_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: "mount" }),
      }),
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { mode?: string };
    expect(patched.mode).toBe("mount");

    // GET /assignments returns the same mode.
    const listRes = await app.handle(
      request(`/api/v1/folders/${folderId}/assignments`),
    );
    const list = (await listRes.json()) as Array<{ mode?: string }>;
    expect(list[0]?.mode).toBe("mount");
  });

  test("PATCH mode: null resets to inherit", async () => {
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('h','h')`);
    const folderId = await setupSyncFolder();
    await postJson(`/api/v1/folders/${folderId}/assign`, {
      hostId: "h",
      role: "both",
      localPath: "/tmp/v",
      mode: "mount",
    });

    const patchRes = await app.handle(
      new Request(`http://localhost/api/v1/folders/${folderId}/assign/h`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${process.env.LAMASYNC_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: null }),
      }),
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { mode?: string };
    expect(patched.mode).toBe("inherit");
  });

  test("config SELECT returns mode for assignments (LAMA-239)", async () => {
    // Folder + host + assignment, with a mount override. Hit /config/:hostId
    // and confirm the assignment row carries mode = "mount" (the daemon
    // uses this to start the mount unit on reconcile).
    db.run(`INSERT INTO hosts (id, hostname) VALUES ('h','h')`);
    const folderId = await setupSyncFolder();
    await postJson(`/api/v1/folders/${folderId}/assign`, {
      hostId: "h",
      role: "both",
      localPath: "/tmp/v",
      mode: "mount",
    });

    process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "folders-test-key";
    const { Elysia } = await import("elysia");
    const { getAuthPlugin } = await import("../auth.ts");
    const { configRoutes } = await import("./config.ts");
    const cfgApp = new Elysia().use(getAuthPlugin()).use(configRoutes);
    const res = await cfgApp.handle(
      new Request("http://localhost/api/v1/config/h", {
        headers: { Authorization: `Bearer ${process.env.LAMASYNC_API_KEY}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      assignments: Array<{ folderId: string; mode?: string }>;
    };
    const a = body.assignments.find((x) => x.folderId === folderId);
    expect(a?.mode).toBe("mount");
  });
});
