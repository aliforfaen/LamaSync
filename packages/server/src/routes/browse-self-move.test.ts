// LAMA-226 P1-2: same-kind local moves must reject when dst nests under
// src; same-folder S3 moves must allow intra-folder prefix moves. These
// checks run in the route handler before rclone spawns, so we can assert
// them without rclone installed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_SCHEMA, MIGRATIONS } from "@lamasync/core";
process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "browse-self-move-test-key";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "self-move-test-secret-key-0123456789abcdef";

const { getAuthPlugin } = await import("../auth.ts");
const { browseRoutes, __setDb } = (await import("./browse.ts")) as unknown as {
  browseRoutes: Elysia;
  __setDb: (db: Database) => void;
};
const { __resetBrowseJobsForTests } = await import("../browse-jobs.ts");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };
let root: string;

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
  return Promise.resolve(
    app.handle(request(path, { method: "POST", body: JSON.stringify(body) })),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lamasync-self-move-"));
  process.env.LAMASYNC_BACKUP_DIR = root;

  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // idempotent
    }
  }
  __setDb(db);
  __resetBrowseJobsForTests();
  app = new Elysia().use(getAuthPlugin()).use(browseRoutes);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("POST /api/v1/browse/move — self-move rejection (LAMA-226 P1-2)", () => {
  test("rejects local move where dst equals src/<name>", async () => {
    // src.path == dst.path and one of the names would be the dst directory
    // itself — rclone no-ops and `deleteSource` would rm -rf the entry.
    const res = await postJson("/api/v1/browse/move", {
      source: { kind: "local", path: "a" },
      destination: { kind: "local", path: "a" },
      names: ["b"],
    });
    expect(res.status).toBe(400);
    // LAMA-226 P1-9: the route scrubs the underlying error to a generic
    // "move failed" so the audit detail doesn't leak absolute paths.
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("move failed");
  });

  test("accepts local move where dst is a sibling", async () => {
    // The guard only fires for contained moves; sibling destinations are
    // fine. We don't spawn rclone here — the 201 just means the request
    // passed validation.
    const res = await postJson("/api/v1/browse/move", {
      source: { kind: "local", path: "a" },
      destination: { kind: "local", path: "c" },
      names: ["b"],
    });
    expect(res.status).toBe(201);
  });

  test("rejects S3 same-folder move with identical prefix", async () => {
    // Insert a real S3 folder + backend so the route can resolve the ref.
    db.run(
      `INSERT INTO backends (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, created_at)
       VALUES ('bk-1', 'cold', 's3', 'other', 'sos-ch-dk-2.exo.io', 'other-v2-signature', 'AKIA', NULL, 0)`,
    );
    db.run(
      "INSERT INTO folders (id, name, type, backend, backend_id, s3_bucket) VALUES ('f-1', 'vault', 'backup', 's3', 'bk-1', 'bucket-1')",
    );
    const res = await postJson("/api/v1/browse/move", {
      source: { kind: "s3", folderId: "f-1", path: "a" },
      destination: { kind: "s3", folderId: "f-1", path: "a" },
      names: ["k"],
    });
    expect(res.status).toBe(400);
    // LAMA-226 P1-9: same-folder s3 move into the same prefix is rejected
    // before rclone spawns; the route surfaces the generic scrubbed error.
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("move failed");
  });

  test("accepts S3 same-folder move into a sibling prefix", async () => {
    db.run(
      `INSERT INTO backends (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, created_at)
       VALUES ('bk-1', 'cold', 's3', 'other', 'sos-ch-dk-2.exo.io', 'other-v2-signature', 'AKIA', NULL, 0)`,
    );
    db.run(
      "INSERT INTO folders (id, name, type, backend, backend_id, s3_bucket) VALUES ('f-1', 'vault', 'backup', 's3', 'bk-1', 'bucket-1')",
    );
    const res = await postJson("/api/v1/browse/move", {
      source: { kind: "s3", folderId: "f-1", path: "a" },
      destination: { kind: "s3", folderId: "f-1", path: "b" },
      names: ["k"],
    });
    expect(res.status).toBe(201);
  });
});