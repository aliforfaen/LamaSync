// Unit tests for the /api/v1/folders routes — focused on the S3 backend
// validation/persistence added for LAMA-105. SFTP behavior is exercised by
// the e2e smoke checks, not here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "folders-test-key";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-folders-test-data";

// `db.ts` reads LAMASYNC_DATA_DIR on first import. The env vars above must
// be set before that happens, so use dynamic import for the auth + route
// modules (matching the pattern used by operations/dotfiles/report tests).
const { getAuthPlugin } = await import("../auth.ts");
const { __setDb, foldersRoutes } = (await import("./folders.ts")) as unknown as {
  __setDb: (db: Database) => void;
  foldersRoutes: Elysia;
};

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

describe("POST /api/v1/folders — backend validation (LAMA-105)", () => {
  test("rejects s3 backend without required credentials", async () => {
    const res = await postJson("/api/v1/folders", {
      name: "exoscale-vault",
      type: "sync",
      backend: "s3",
      s3Endpoint: "sos-at-vie-1.exo.io",
      s3Bucket: "lamasync-vault",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("s3AccessKeyId");
    expect(body.error).toContain("s3SecretAccessKey");
  });

  test("creates an s3-backed folder with all required credentials", async () => {
    const res = await postJson("/api/v1/folders", {
      name: "exoscale-vault",
      type: "sync",
      backend: "s3",
      s3Endpoint: "sos-at-vie-1.exo.io",
      s3Bucket: "lamasync-vault",
      s3AccessKeyId: "EXO_KEY",
      s3SecretAccessKey: "EXO_SECRET",
      s3Region: "vie-1",
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(201);
    expect(body.s3Endpoint).toBe("sos-at-vie-1.exo.io");
    expect(body.s3Bucket).toBe("lamasync-vault");
    expect(body.s3AccessKeyId).toBe("EXO_KEY");
    expect(body.s3SecretAccessKey).toBe("EXO_SECRET");
    expect(body.s3Region).toBe("vie-1");
  });

  test("default backend is sftp when not provided", async () => {
    const res = await postJson("/api/v1/folders", {
      name: "legacy",
      type: "sync",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.backend).toBe("sftp");
  });

  test("normalizes uppercase backend string to lowercase", async () => {
    const res = await postJson("/api/v1/folders", {
      name: "upper-s3",
      type: "sync",
      backend: "S3",
      s3Endpoint: "s3.example.com",
      s3Bucket: "bucket",
      s3AccessKeyId: "K",
      s3SecretAccessKey: "S",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.backend).toBe("s3");
  });
});

describe("PUT /api/v1/folders/:id — backend updates (LAMA-105)", () => {
  test("switching to s3 requires all credentials", async () => {
    const created = await postJson("/api/v1/folders", {
      name: "flip",
      type: "sync",
    });
    const { id } = (await created.json()) as { id: string };

    const res = await putJson(`/api/v1/folders/${id}`, {
      backend: "s3",
      s3Endpoint: "s3.example.com",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("s3Bucket");
  });

  test("updating s3 credentials persists them", async () => {
    const created = await postJson("/api/v1/folders", {
      name: "rotate",
      type: "sync",
      backend: "s3",
      s3Endpoint: "s3.example.com",
      s3Bucket: "bucket",
      s3AccessKeyId: "OLD",
      s3SecretAccessKey: "OLD_SECRET",
    });
    const { id } = (await created.json()) as { id: string };

    const res = await putJson(`/api/v1/folders/${id}`, {
      s3AccessKeyId: "NEW",
      s3SecretAccessKey: "NEW_SECRET",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.s3AccessKeyId).toBe("NEW");
    expect(body.s3SecretAccessKey).toBe("NEW_SECRET");
    expect(body.backend).toBe("s3");
  });

  test("switching off s3 clears s3 credential fields", async () => {
    const created = await postJson("/api/v1/folders", {
      name: "flip-back",
      type: "sync",
      backend: "s3",
      s3Endpoint: "s3.example.com",
      s3Bucket: "bucket",
      s3AccessKeyId: "K",
      s3SecretAccessKey: "S",
    });
    const { id } = (await created.json()) as { id: string };

    const res = await putJson(`/api/v1/folders/${id}`, {
      backend: "sftp",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.backend).toBe("sftp");
    expect(body.s3Endpoint).toBeNull();
    expect(body.s3Bucket).toBeNull();
    expect(body.s3AccessKeyId).toBeNull();
    expect(body.s3SecretAccessKey).toBeNull();
  });
});
