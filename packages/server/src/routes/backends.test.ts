// Unit tests for the /api/v1/backends routes (LAMA-222) and the legacy
// per-folder s3_* → backends lift migration.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "backends-test-key";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-backends-test-data";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "backends-test-secret-key-0123456789abcdef";

const { getAuthPlugin } = await import("../auth.ts");
const { __setDb, backendsRoutes } = (await import("./backends.ts")) as unknown as {
  __setDb: (db: Database) => void;
  backendsRoutes: Elysia;
};
const { __setDb: __setConfigRevisionDb } = (await import("../config-revision.ts")) as unknown as {
  __setDb: (db: Database) => void;
};
const { decryptSecret } = await import("../crypto.ts");
const { migrateLegacyS3FoldersToBackends } = await import("../backends.ts");
const { SERVER_SCHEMA, MIGRATIONS } = await import("@lamasync/core");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.LAMASYNC_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function postJson(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.handle(request(path, { method: "POST", body: JSON.stringify(body) })));
}

function patchJson(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.handle(request(path, { method: "PATCH", body: JSON.stringify(body) })));
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // idempotent migrations
    }
  }
  __setDb(db);
  __setConfigRevisionDb(db);
  app = new Elysia().use(getAuthPlugin()).use(backendsRoutes);
});

afterEach(() => {
  db.close();
});

describe("POST /api/v1/backends", () => {
  test("creates an s3 backend with the secret encrypted at rest", async () => {
    const res = await postJson("/api/v1/backends", {
      name: "prod-r2",
      kind: "s3",
      s3Provider: "other",
      s3Endpoint: "s3.r2.example.com",
      s3Region: "auto",
      s3AccessKeyId: "R2_KEY",
      s3SecretAccessKey: "R2_SECRET",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("prod-r2");
    expect(body.hasSecret).toBe(true);
    expect(JSON.stringify(body)).not.toContain("R2_SECRET");

    const row = db
      .query<{ s3_secret_key_enc: string | null }, [string]>(
        "SELECT s3_secret_key_enc FROM backends WHERE id = ?",
      )
      .get(body.id as string);
    expect(row?.s3_secret_key_enc).toBeTruthy();
    expect(decryptSecret(row?.s3_secret_key_enc)).toBe("R2_SECRET");
  });

  test("requires endpoint, access key and secret for s3 backends", async () => {
    const res = await postJson("/api/v1/backends", {
      name: "incomplete",
      kind: "s3",
      s3Endpoint: "s3.example.com",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("s3AccessKeyId");
  });

  test("rejects an Exoscale endpoint that does not match sos-ZONE.exo.io", async () => {
    const res = await postJson("/api/v1/backends", {
      name: "bad-exo",
      kind: "s3",
      s3Provider: "exoscale",
      s3Endpoint: "s3.example.com",
      s3AccessKeyId: "K",
      s3SecretAccessKey: "S",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("sos-ZONE.exo.io");
  });

  test("AWS provider requires a region", async () => {
    const res = await postJson("/api/v1/backends", {
      name: "aws-no-region",
      kind: "s3",
      s3Provider: "aws",
      s3Endpoint: "s3.amazonaws.com",
      s3AccessKeyId: "K",
      s3SecretAccessKey: "S",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("s3Region");
  });

  test("rejects duplicate names (case-insensitive)", async () => {
    await postJson("/api/v1/backends", {
      name: "Prod-R2",
      kind: "s3",
      s3Endpoint: "s3.example.com",
      s3AccessKeyId: "K",
      s3SecretAccessKey: "S",
    });
    const res = await postJson("/api/v1/backends", {
      name: "prod-r2",
      kind: "s3",
      s3Endpoint: "s3.example.com",
      s3AccessKeyId: "K",
      s3SecretAccessKey: "S",
    });
    expect(res.status).toBe(409);
  });
});

describe("PATCH /api/v1/backends/:id", () => {
  async function createBackend(name = "rotate-me"): Promise<string> {
    const res = await postJson("/api/v1/backends", {
      name,
      kind: "s3",
      s3Endpoint: "s3.example.com",
      s3AccessKeyId: "OLD_KEY",
      s3SecretAccessKey: "OLD_SECRET",
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  test("rotates the secret; decrypted round-trip returns the new value", async () => {
    const id = await createBackend();
    const res = await patchJson(`/api/v1/backends/${id}`, {
      s3SecretAccessKey: "NEW_SECRET",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.hasSecret).toBe(true);
    expect(JSON.stringify(body)).not.toContain("NEW_SECRET");

    const row = db
      .query<{ s3_secret_key_enc: string | null }, [string]>(
        "SELECT s3_secret_key_enc FROM backends WHERE id = ?",
      )
      .get(id);
    expect(decryptSecret(row?.s3_secret_key_enc)).toBe("NEW_SECRET");
  });

  test("renames with 409 on collision", async () => {
    const id = await createBackend("first");
    await createBackend("second");
    const res = await patchJson(`/api/v1/backends/${id}`, { name: "second" });
    expect(res.status).toBe(409);
  });

  test("404 for unknown backend", async () => {
    const res = await patchJson("/api/v1/backends/missing", { name: "x" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/v1/backends/:id", () => {
  test("refuses to delete a backend still referenced by folders", async () => {
    const created = await postJson("/api/v1/backends", {
      name: "in-use",
      kind: "s3",
      s3Endpoint: "s3.example.com",
      s3AccessKeyId: "K",
      s3SecretAccessKey: "S",
    });
    const { id } = (await created.json()) as { id: string };
    db.run(
      "INSERT INTO folders (id, name, type, backend, backend_id, s3_bucket) VALUES (?, ?, ?, ?, ?, ?)",
      ["folder-1", "vault", "backup", "s3", id, "bucket"],
    );
    const res = await app.handle(
      request(`/api/v1/backends/${id}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("used by 1 folder");
  });

  test("deletes an unused backend", async () => {
    const created = await postJson("/api/v1/backends", {
      name: "unused",
      kind: "s3",
      s3Endpoint: "s3.example.com",
      s3AccessKeyId: "K",
      s3SecretAccessKey: "S",
    });
    const { id } = (await created.json()) as { id: string };
    const res = await app.handle(
      request(`/api/v1/backends/${id}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(204);
  });
});

describe("GET /api/v1/backends", () => {
  test("never exposes the secret; reports hasSecret + folderCount", async () => {
    const created = await postJson("/api/v1/backends", {
      name: "listed",
      kind: "s3",
      s3Endpoint: "s3.example.com",
      s3AccessKeyId: "K",
      s3SecretAccessKey: "TOP_SECRET",
    });
    const { id } = (await created.json()) as { id: string };
    db.run(
      "INSERT INTO folders (id, name, type, backend, backend_id, s3_bucket) VALUES (?, ?, ?, ?, ?, ?)",
      ["folder-1", "vault", "backup", "s3", id, "bucket"],
    );
    const res = await app.handle(request("/api/v1/backends"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(JSON.stringify(body)).not.toContain("TOP_SECRET");
    const found = body.find((b) => b.id === id) as Record<string, unknown>;
    expect(found.hasSecret).toBe(true);
    expect(found.folderCount).toBe(1);
  });
});

describe("legacy s3_* → backends lift (LAMA-222 migration)", () => {
  test("lifts per-folder s3 values into backends and points backend_id", () => {
    // Simulate a pre-LAMA-222 database: folders table still has the legacy
    // s3_* columns and a backends table does not exist yet.
    db.exec(`
      CREATE TABLE legacy_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        backend TEXT DEFAULT 'sftp',
        s3_provider TEXT DEFAULT 'other',
        s3_endpoint TEXT,
        s3_bucket TEXT,
        s3_access_key_id TEXT,
        s3_secret_access_key TEXT,
        s3_region TEXT
      )
    `);
    db.run(
      `INSERT INTO legacy_folders (id, name, type, backend, s3_provider, s3_endpoint, s3_bucket, s3_access_key_id, s3_secret_access_key, s3_region)
       VALUES (?, ?, ?, 's3', 'exoscale', 'sos-at-vie-1.exo.io', 'vault', 'EXO_KEY', 'EXO_SECRET', 'other-v2-signature')`,
      ["f1", "vault", "backup"],
    );
    // The real migration reads the real `folders` table, so rename the
    // legacy table into place. `backends` already exists via SERVER_SCHEMA
    // (prod db.ts creates it the same way before the lift runs).
    db.exec("DROP TABLE folders");
    db.exec("ALTER TABLE legacy_folders RENAME TO folders");

    migrateLegacyS3FoldersToBackends(db);

    const backend = db
      .query<{ id: string; name: string; s3_endpoint: string; s3_access_key_id: string; s3_secret_key_enc: string }, []>(
        "SELECT id, name, s3_endpoint, s3_access_key_id, s3_secret_key_enc FROM backends",
      )
      .get();
    expect(backend).not.toBeNull();
    expect(backend?.name).toContain("vault");
    expect(backend?.s3_endpoint).toBe("sos-at-vie-1.exo.io");
    expect(backend?.s3_access_key_id).toBe("EXO_KEY");
    expect(decryptSecret(backend?.s3_secret_key_enc)).toBe("EXO_SECRET");

    const folder = db
      .query<{ backend: string; backend_id: string }, [string]>(
        "SELECT backend, backend_id FROM folders WHERE id = ?",
      )
      .get("f1");
    expect(folder?.backend).toBe("s3");
    expect(folder?.backend_id).toBe(backend?.id);
  });

  test("is a no-op when the legacy column is already gone", () => {
    // Fresh schema (no s3_endpoint column) — must not throw or insert.
    migrateLegacyS3FoldersToBackends(db);
    const count = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM backends")
      .get();
    expect(count?.c).toBe(0);
  });
});
