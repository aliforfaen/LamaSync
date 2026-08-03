// LAMA-226 P1-9: the write-op route schemas must reject unknown `kind`
// values with 422, not silently fall through to the local branch. Each
// route is exercised directly through `app.handle` so the Elysia
// validation chain is the only thing under test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_SCHEMA, MIGRATIONS } from "@lamasync/core";
process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "browse-schema-test-key";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "schema-test-secret-key-0123456789abcdef";

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
  root = mkdtempSync(join(tmpdir(), "lamasync-browse-schema-"));
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

describe("write-op schemas reject unknown kind values (LAMA-226 P1-9)", () => {
  test("/browse/copy rejects kind: 'ftp'", async () => {
    const res = await postJson("/api/v1/browse/copy", {
      source: { kind: "ftp", path: "src" },
      destination: { kind: "local", path: "dst" },
      names: ["a"],
    });
    expect(res.status).toBe(422);
  });

  test("/browse/move rejects kind: 'nfs'", async () => {
    const res = await postJson("/api/v1/browse/move", {
      source: { kind: "nfs", path: "src" },
      destination: { kind: "local", path: "dst" },
      names: ["a"],
    });
    expect(res.status).toBe(422);
  });

  test("/browse/rename rejects kind: 'sshfs'", async () => {
    const res = await postJson("/api/v1/browse/rename", {
      ref: { kind: "sshfs", path: "src" },
      from: "a",
      to: "b",
    });
    expect(res.status).toBe(422);
  });

  test("/browse/mkdir rejects kind: 'webdav'", async () => {
    const res = await postJson("/api/v1/browse/mkdir", {
      ref: { kind: "webdav", path: "src" },
      name: "x",
    });
    expect(res.status).toBe(422);
  });

  test("/browse/upload rejects kind: 'azureblob'", async () => {
    const res = await postJson("/api/v1/browse/upload", {
      destination: { kind: "azureblob", path: "dst" },
      name: "x",
      content: Buffer.from("x").toString("base64"),
    });
    expect(res.status).toBe(422);
  });
});