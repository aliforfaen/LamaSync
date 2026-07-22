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
      s3Provider: "exoscale",
      s3Endpoint: "sos-at-vie-1.exo.io",
      s3Bucket: "lamasync-vault",
      s3AccessKeyId: "EXO_KEY",
      s3SecretAccessKey: "EXO_SECRET",
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(201);
    expect(body.backend).toBe("s3");
    expect(body.s3Provider).toBe("exoscale");
    expect(body.s3Endpoint).toBe("sos-at-vie-1.exo.io");
    expect(body.s3Bucket).toBe("lamasync-vault");
    expect(body.s3AccessKeyId).toBe("EXO_KEY");
    // LAMA-178: the secret is write-only — redacted in the response but
    // persisted server-side for the daemon config endpoint.
    expect(body.s3SecretAccessKey).toBeNull();
    expect(body.s3Region).toBe("other-v2-signature");
    const stored = db
      .query<{ s3_secret_access_key: string | null }, [string]>(
        "SELECT s3_secret_access_key FROM folders WHERE id = ?",
      )
      .get(body.id as string);
    expect(stored?.s3_secret_access_key).toBe("EXO_SECRET");
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

  test("rejects an Exoscale endpoint that does not match sos-ZONE.exo.io", async () => {
    const res = await postJson("/api/v1/folders", {
      name: "bad-exoscale",
      type: "sync",
      backend: "s3",
      s3Provider: "exoscale",
      s3Endpoint: "s3.example.com",
      s3Bucket: "bucket",
      s3AccessKeyId: "KEY",
      s3SecretAccessKey: "SECRET",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("sos-ZONE.exo.io");
  });

  test("defaults s3Provider to other when not specified", async () => {
    const res = await postJson("/api/v1/folders", {
      name: "generic-s3",
      type: "backup",
      backend: "s3",
      s3Endpoint: "s3.example.com",
      s3Bucket: "bucket",
      s3AccessKeyId: "KEY",
      s3SecretAccessKey: "SECRET",
      s3Region: "us-east-1",
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(201);
    expect(body.s3Provider).toBe("other");
    expect(body.s3Region).toBe("us-east-1");
  });

  test("accepts Exoscale endpoints across all known zones", async () => {
    const endpoints = [
      "sos-at-vie-1.exo.io",
      "sos-de-muc-1.exo.io",
      "sos-ch-gva-2.exo.io",
      "sos-bg-sof-1.exo.io",
      "sos-de-fra-1.exo.io",
    ];
    for (const endpoint of endpoints) {
      const res = await postJson("/api/v1/folders", {
        name: `exoscale-${endpoint.replace(/\./g, "-")}`,
        type: "sync",
        backend: "s3",
        s3Provider: "exoscale",
        s3Endpoint: endpoint,
        s3Bucket: "lamasync-vault",
        s3AccessKeyId: "EXO_KEY",
        s3SecretAccessKey: "EXO_SECRET",
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(201);
      expect(body.s3Endpoint).toBe(endpoint);
      expect(body.s3Region).toBe("other-v2-signature");
    }
  });

  test("AWS S3 provider requires s3Region", async () => {
    const res = await postJson("/api/v1/folders", {
      name: "aws-vault",
      type: "sync",
      backend: "s3",
      s3Provider: "aws",
      s3Endpoint: "s3.amazonaws.com",
      s3Bucket: "lamasync-vault",
      s3AccessKeyId: "AWS_KEY",
      s3SecretAccessKey: "AWS_SECRET",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("s3Region");
  });

  test("Exoscale provider overrides any supplied region to other-v2-signature", async () => {
    const res = await postJson("/api/v1/folders", {
      name: "exoscale-region-override",
      type: "sync",
      backend: "s3",
      s3Provider: "exoscale",
      s3Endpoint: "sos-at-vie-1.exo.io",
      s3Bucket: "lamasync-vault",
      s3AccessKeyId: "EXO_KEY",
      s3SecretAccessKey: "EXO_SECRET",
      s3Region: "us-east-1",
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(201);
    expect(body.s3Region).toBe("other-v2-signature");
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
    // Redacted in the response (LAMA-178); the new value must be persisted.
    expect(body.s3SecretAccessKey).toBeNull();
    expect(body.backend).toBe("s3");
    const stored = db
      .query<{ s3_secret_access_key: string | null }, [string]>(
        "SELECT s3_secret_access_key FROM folders WHERE id = ?",
      )
      .get(id);
    expect(stored?.s3_secret_access_key).toBe("NEW_SECRET");
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

describe("GET /api/v1/folders — s3SecretAccessKey redaction (LAMA-178)", () => {
  async function createS3Folder(): Promise<string> {
    const res = await postJson("/api/v1/folders", {
      name: "redact-me",
      type: "sync",
      backend: "s3",
      s3Endpoint: "s3.example.com",
      s3Bucket: "bucket",
      s3AccessKeyId: "KEY",
      s3SecretAccessKey: "TOP_SECRET",
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    return id;
  }

  test("GET /folders never returns the plaintext secret", async () => {
    await createS3Folder();
    const res = await app.handle(request("/api/v1/folders"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body.length).toBe(1);
    expect(body[0]?.s3AccessKeyId).toBe("KEY");
    expect(body[0]?.s3SecretAccessKey).toBeNull();
    expect(JSON.stringify(body)).not.toContain("TOP_SECRET");
  });

  test("GET /folders/:id never returns the plaintext secret", async () => {
    const id = await createS3Folder();
    const res = await app.handle(request(`/api/v1/folders/${id}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.s3AccessKeyId).toBe("KEY");
    expect(body.s3SecretAccessKey).toBeNull();
    expect(JSON.stringify(body)).not.toContain("TOP_SECRET");
  });

  test("PUT without s3SecretAccessKey keeps the stored secret", async () => {
    const id = await createS3Folder();
    const res = await putJson(`/api/v1/folders/${id}`, { name: "renamed" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.s3SecretAccessKey).toBeNull();
    const stored = db
      .query<{ s3_secret_access_key: string | null }, [string]>(
        "SELECT s3_secret_access_key FROM folders WHERE id = ?",
      )
      .get(id);
    expect(stored?.s3_secret_access_key).toBe("TOP_SECRET");
  });
});
