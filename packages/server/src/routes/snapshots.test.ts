// LAMA-259: unit tests for the time-travel browser data surface:
//   - GET /api/v1/folders/:folderId/snapshots
//   - GET /api/v1/folders/:folderId/snapshots/:snapshotId/files
//
// Coverage:
//   - non-existent folder → 404
//   - non-restic folder → empty list (per spec, NOT a 409)
//   - restic folder with no recorded snapshots → empty list
//   - restic folder with recorded snapshots → JSON with the documented
//     shape (id/time/host/paths), newest-first
//   - /files: missing folder → 404
//   - /files: non-restic folder → 409 with the canonical wording
//   - /files: unknown (folder, snapshot) tuple → 404 (not 502 with raw
//     restic stderr)
//   - /files: restic failure → 502 with scrubbed summary (LAMA-226 + 259)
//   - /files: happy path → BrowseResponse with the restic-snapshot
//     discriminator + BrowseEntry children one level deep (defensive vs
//     restic's subtree emission)
//   - /files: limit param caps entries; default is 500
//   - parseLsJsonRich: mtime preservation + ISO/object-form handling
//   - rowToFolderSnapshot: malformed paths JSON → paths omitted (NOT bogus)
//   - 401 unauthenticated (auth plugin wired)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
import { encryptSecret } from "../crypto.ts";
import {
  __setDb,
  __setResticRunnerForTests,
  type ResticSpawnFn,
  type ResticSpawnInput,
  type ResticSpawnResult,
} from "./snapshots.ts";
import {
  folderSnapshotsRoutes,
  resticLsResponse,
  rowToFolderSnapshot,
} from "./snapshots.ts";
import { parseLsJsonRich } from "../health-drill.ts";

process.env.LAMASYNC_API_KEY =
  process.env.LAMASYNC_API_KEY ?? "snapshots-test-key";
process.env.LAMASYNC_DATA_DIR =
  process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-snapshots-test-data";
process.env.LAMASYNC_SECRET_KEY =
  process.env.LAMASYNC_SECRET_KEY ?? "snapshots-secret-key-0123456789";

const { getAuthPlugin } = await import("../auth.ts");

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (!isRecord(parsed)) throw new Error("expected an object response");
  return parsed;
}

/** Insert a folder whose backing Backend row is `kind = "restic"` with an
 *  encrypted password — mirrors the LAMA-232 path real backends go through.
 *  Returns the folder id (and backend id for tests that want to delete /
 *  rebuild the row). */
function insertResticFolder(
  id: string,
  name: string,
  repository: string,
  password: string,
): { folderId: string; backendId: string } {
  const backendId = `be-${id}`;
  db.run(
    `INSERT INTO backends
       (id, name, kind, restic_repository, restic_password_enc, created_at)
     VALUES (?, ?, 'restic', ?, ?, ?)`,
    [backendId, `${name}-backend`, repository, encryptSecret(password), Date.now()],
  );
  db.run(
    `INSERT INTO folders (id, name, type, backend, backend_id) VALUES (?, ?, ?, ?, ?)`,
    [id, name, "backup", "restic", backendId],
  );
  return { folderId: id, backendId };
}

/** Insert one restic_snapshots row — the daemon-side seed the
 *  /api/v1/folders/:id/snapshots endpoint reads from. */
function insertSnapshotRow(row: {
  id: string;
  folderId: string;
  snapshotId: string;
  timestamp: number;
  hostId: string;
  paths: string[];
}): void {
  db.run(
    `INSERT INTO restic_snapshots
       (id, folder_id, host_id, snapshot_id, timestamp, paths, tags)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    [
      row.id,
      row.folderId,
      row.hostId,
      row.snapshotId,
      row.timestamp,
      JSON.stringify(row.paths),
    ],
  );
}

/** Real restic 0.17 ls --json shape: a one-line header + per-node records.
 *  Mirrors the fixture in health-drill.test.ts so the parser exercises the
 *  same wire format the production code does. */
function resticLsJson(
  nodes: Array<{
    name: string;
    path: string;
    type: "file" | "dir";
    size?: number;
    mtime?: string;
  }>,
): string {
  const header = JSON.stringify({
    message_type: "snapshot",
    struct_type: "snapshot",
    time: "2026-08-25T13:26:28.328521227Z",
    tree: "1bb0eeb4deadbeefcafebabe1234567890abcdef1234567890abcdef12345678",
    paths: ["/backups"],
    hostname: "test-host",
    username: "root",
    uid: 0,
    gid: 0,
    excludes: [],
    tags: null,
    id: "1bb0eeb4deadbeef",
    short_id: "1bb0eeb4",
  });
  const lines = [header];
  for (const n of nodes) {
    const obj: Record<string, unknown> = {
      name: n.name,
      type: n.type,
      path: n.path,
      uid: 0,
      gid: 0,
      mode: n.type === "dir" ? 2147484141 : 33184,
      permissions: n.type === "dir" ? "drwxr-xr-x" : "-rw-r--r--",
      mtime: n.mtime ?? "2026-08-25T13:26:21Z",
      atime: n.mtime ?? "2026-08-25T13:26:21Z",
      ctime: n.mtime ?? "2026-08-25T13:26:21Z",
      message_type: "node",
      struct_type: "node",
    };
    if (n.type === "file" && typeof n.size === "number") obj["size"] = n.size;
    lines.push(JSON.stringify(obj));
  }
  return `${lines.join("\n")}\n`;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // idempotent — pre-existing tables/columns are expected here
    }
  }
  __setDb(db);
  __setResticRunnerForTests(null); // reset to default Bun.spawn
  app = new Elysia().use(getAuthPlugin()).use(folderSnapshotsRoutes);
});

afterEach(() => {
  __setResticRunnerForTests(null); // safety reset
  db.close();
});

// ---------- pure helpers --------------------------------------------------

describe("rowToFolderSnapshot", () => {
  test("maps a complete row to the wire shape", () => {
    const row = {
      snapshot_id: "snap-1",
      timestamp: 1_700_000_000_000,
      host_id: "host-a",
      paths: JSON.stringify(["/data"]),
    };
    expect(rowToFolderSnapshot(row)).toEqual({
      id: "snap-1",
      time: 1_700_000_000_000,
      host: "host-a",
      paths: ["/data"],
    });
  });
  test("omits paths when the column holds garbage (defensive)", () => {
    const row = {
      snapshot_id: "snap-x",
      timestamp: 42,
      host_id: "host-z",
      paths: "not-json",
    };
    const out = rowToFolderSnapshot(row);
    expect(out).toEqual({
      id: "snap-x",
      time: 42,
      host: "host-z",
      paths: undefined,
    });
  });
  test("omits paths when the JSON isn't a string[]", () => {
    const row = {
      snapshot_id: "snap-y",
      timestamp: 1,
      host_id: "h",
      paths: JSON.stringify({ nested: "wrong" }),
    };
    expect(rowToFolderSnapshot(row).paths).toBeUndefined();
  });
});

describe("parseLsJsonRich (LAMA-259 mtime preservation)", () => {
  test("captures ISO mtime as epoch ms", () => {
    const out = parseLsJsonRich(
      resticLsJson([
        {
          name: "a.txt",
          path: "/a.txt",
          type: "file",
          size: 12,
          mtime: "2026-01-15T12:00:00Z",
        },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.mtime).toBe(Date.parse("2026-01-15T12:00:00Z"));
  });
  test("accepts the alternate mtime object form (older restic builds)", () => {
    const header = JSON.stringify({
      message_type: "snapshot",
      id: "snap",
    });
    const node = JSON.stringify({
      name: "b.txt",
      type: "file",
      path: "/b.txt",
      size: 1,
      mtime: { sec: 1_700_000_000, nsec: 250_000_000 },
      message_type: "node",
      struct_type: "node",
    });
    const out = parseLsJsonRich(`${header}\n${node}\n`);
    expect(out[0]?.mtime).toBe(
      Math.floor(1_700_000_000 * 1000 + 250_000_000 / 1_000_000),
    );
  });
  test("returns null mtime when the node omits the field", () => {
    const header = JSON.stringify({ message_type: "snapshot", id: "snap" });
    const node = JSON.stringify({
      name: "c.txt",
      type: "file",
      path: "/c.txt",
      size: 1,
      message_type: "node",
      struct_type: "node",
    });
    expect(parseLsJsonRich(`${header}\n${node}\n`)[0]?.mtime).toBeNull();
  });
  test("drops non-node lines + malformed JSON (same classify rules as parseLsJson)", () => {
    const out = parseLsJsonRich(
      [
        "not json",
        JSON.stringify("just a string"),
        JSON.stringify({ message_type: "summary" }),
      ].join("\n"),
    );
    expect(out).toEqual([]);
  });
});

describe("resticLsResponse (LAMA-259 response builder)", () => {
  test("maps restic's subtree emission to one-level-deep children + BrowseEntry shape", () => {
    // restic emits /a, /a/b, /a/b/c — the slider only wants /a and /x
    // (the immediate children of "/"). Filtering to one level keeps the
    // DataBrowser usable without a follow-up round-trip per directory.
    const stdout = resticLsJson([
      { name: "a", path: "/a", type: "dir" },
      { name: "b", path: "/a/b", type: "dir" },
      { name: "c", path: "/a/b/c", type: "file", size: 5 },
      { name: "x", path: "/x", type: "file", size: 10 },
    ]);
    const res = resticLsResponse(stdout, "/", "snap", "folder-1", 500);
    expect(res.backend).toBe("restic-snapshot");
    expect(res.path).toBe("/");
    expect(res.snapshotId).toBe("snap");
    expect(res.folderId).toBe("folder-1");
    expect(res.entries).toEqual([
      {
        name: "a",
        type: "dir",
        size: 0,
        mtime: expect.any(Number),
        folderId: "folder-1",
      },
      {
        name: "x",
        type: "file",
        size: 10,
        mtime: expect.any(Number),
        folderId: "folder-1",
      },
    ]);
  });
  test("returns empty entries when the listing prefix doesn't match any node", () => {
    const stdout = resticLsJson([
      { name: "a", path: "/a", type: "file", size: 1 },
    ]);
    const res = resticLsResponse(stdout, "/missing", "snap", "f", 500);
    expect(res.entries).toEqual([]);
    expect(res.backend).toBe("restic-snapshot");
    expect(res.path).toBe("/missing");
  });
  test("caps the response at the limit and keeps stable alphabetical order", () => {
    const stdout = resticLsJson([
      { name: "z", path: "/z", type: "file", size: 1 },
      { name: "a", path: "/a", type: "file", size: 1 },
      { name: "m", path: "/m", type: "file", size: 1 },
    ]);
    const res = resticLsResponse(stdout, "/", "snap", "f", 2);
    expect(res.entries.map((e) => e.name)).toEqual(["a", "m"]);
  });
  test("uses 0 mtime when the source node omits mtime (BrowseEntry contract)", () => {
    const header = JSON.stringify({ message_type: "snapshot", id: "s" });
    const node = JSON.stringify({
      name: "legacy",
      type: "file",
      path: "/legacy",
      size: 1,
      message_type: "node",
      struct_type: "node",
    });
    const res = resticLsResponse(`${header}\n${node}\n`, "/", "s", "f", 500);
    expect(res.entries[0]?.mtime).toBe(0);
  });
});

// ---------- /folders/:folderId/snapshots --------------------------------

describe("GET /api/v1/folders/:folderId/snapshots", () => {
  test("returns 404 for an unknown folder", async () => {
    const res = await app.handle(
      request("/api/v1/folders/does-not-exist/snapshots"),
    );
    expect(res.status).toBe(404);
    const body = await responseObject(res);
    expect(String(body["error"])).toBe("Folder not found");
  });

  test("returns { snapshots: [] } for a non-restic folder (spec: empty, not error)", async () => {
    db.run(
      `INSERT INTO folders (id, name, type, backend) VALUES ('f1', 'photos', 'backup', 'sftp')`,
    );
    const res = await app.handle(request("/api/v1/folders/f1/snapshots"));
    expect(res.status).toBe(200);
    const body = await responseObject(res);
    expect(body["snapshots"]).toEqual([]);
  });

  test("returns { snapshots: [] } when the restic folder has no recorded snapshots", async () => {
    insertResticFolder("f1", "docs", "s3:restic/folder", "pw");
    const res = await app.handle(request("/api/v1/folders/f1/snapshots"));
    expect(res.status).toBe(200);
    const body = await responseObject(res);
    expect(body["snapshots"]).toEqual([]);
  });

  test("returns FolderSnapshot[] newest-first for a restic folder with rows", async () => {
    insertResticFolder("f1", "docs", "s3:restic/folder", "pw");
    db.run(
      "INSERT INTO hosts (id, hostname, status, last_seen) VALUES ('h1', 'alpha', 'online', 1)",
    );
    insertSnapshotRow({
      id: "row-old",
      folderId: "f1",
      snapshotId: "older",
      timestamp: 1_700_000_000_000,
      hostId: "h1",
      paths: ["/data/docs"],
    });
    insertSnapshotRow({
      id: "row-new",
      folderId: "f1",
      snapshotId: "newer",
      timestamp: 1_700_000_500_000,
      hostId: "h1",
      paths: ["/data/docs", "/data/docs/extra"],
    });
    const res = await app.handle(request("/api/v1/folders/f1/snapshots"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      snapshots: Array<{
        id: string;
        time: number;
        host: string | null;
        paths?: string[];
      }>;
    };
    expect(body.snapshots).toHaveLength(2);
    expect(body.snapshots[0]).toEqual({
      id: "newer",
      time: 1_700_000_500_000,
      host: "h1",
      paths: ["/data/docs", "/data/docs/extra"],
    });
    expect(body.snapshots[1]?.id).toBe("older");
  });

  test("ignores snapshots from other folders (the slider is per-folder)", async () => {
    insertResticFolder("f1", "docs", "s3:restic/a", "pw");
    insertResticFolder("f2", "photos", "s3:restic/b", "pw");
    insertSnapshotRow({
      id: "row-a",
      folderId: "f1",
      snapshotId: "snap-A",
      timestamp: 100,
      hostId: "h",
      paths: ["/data/docs"],
    });
    insertSnapshotRow({
      id: "row-b",
      folderId: "f2",
      snapshotId: "snap-B",
      timestamp: 200,
      hostId: "h",
      paths: ["/data/photos"],
    });
    const res = await app.handle(request("/api/v1/folders/f1/snapshots"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshots: Array<{ id: string }> };
    expect(body.snapshots.map((s) => s.id)).toEqual(["snap-A"]);
  });

  test("requires auth (401 without bearer)", async () => {
    insertResticFolder("f1", "docs", "s3:restic/a", "pw");
    const noAuth = new Request(
      "http://localhost/api/v1/folders/f1/snapshots",
    );
    const res = await app.handle(noAuth);
    expect(res.status).toBe(401);
  });
});

// ---------- /folders/:folderId/snapshots/:snapshotId/files ---------------

describe("GET /api/v1/folders/:folderId/snapshots/:snapshotId/files", () => {
  test("returns 404 for an unknown folder", async () => {
    const res = await app.handle(
      request(
        "/api/v1/folders/no-folder/snapshots/snap-1/files?path=/",
      ),
    );
    expect(res.status).toBe(404);
    const body = await responseObject(res);
    expect(String(body["error"])).toBe("Folder not found");
  });

  test("returns 409 for a non-restic folder (with the canonical wording)", async () => {
    db.run(
      "INSERT INTO folders (id, name, type, backend) VALUES ('f1', 'x', 'backup', 'sftp')",
    );
    const res = await app.handle(
      request("/api/v1/folders/f1/snapshots/snap-1/files?path=/"),
    );
    expect(res.status).toBe(409);
    const body = await responseObject(res);
    expect(String(body["error"])).toBe(
      "folder is not a restic folder (missing repository or password)",
    );
  });

  test("returns 404 for a known restic folder whose snapshot tuple isn't recorded", async () => {
    // We never want to forward an arbitrary snapshot id to a real restic
    // process — the (folder, snapshot) tuple in the table is the only
    // access boundary a UI should reach via this route.
    insertResticFolder("f1", "docs", "s3:restic/folder", "pw");
    const res = await app.handle(
      request("/api/v1/folders/f1/snapshots/unknown/files?path=/"),
    );
    expect(res.status).toBe(404);
    const body = await responseObject(res);
    expect(String(body["error"])).toBe(
      "Snapshot not found for this folder",
    );
  });

  test("happy path: passes RESTIC_PASSWORD via env and returns BrowseResponse", async () => {
    const { folderId } = insertResticFolder(
      "f1",
      "docs",
      "s3:restic/folder",
      "super-secret-pw",
    );
    db.run(
      "INSERT INTO hosts (id, hostname, status, last_seen) VALUES ('h1', 'alpha', 'online', 1)",
    );
    insertSnapshotRow({
      id: "row-1",
      folderId: "f1",
      snapshotId: "snap-1",
      timestamp: 1_700_000_000_000,
      hostId: "h1",
      paths: ["/data/docs"],
    });
    const captured: ResticSpawnInput[] = [];
    const runner: ResticSpawnFn = async (input) => {
      captured.push(input);
      // Real restic 0.17 ls --json: a snapshot header + one file.
      return {
        code: 0,
        stdout: resticLsJson([
          { name: "notes.txt", path: "/notes.txt", type: "file", size: 61 },
        ]),
        stderr: "",
      };
    };
    __setResticRunnerForTests(runner);

    const res = await app.handle(
      request("/api/v1/folders/f1/snapshots/snap-1/files?path=/"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      backend: string;
      path: string;
      snapshotId: string;
      folderId: string;
      entries: Array<{ name: string; type: string; size: number; folderId?: string }>;
    };
    expect(body.backend).toBe("restic-snapshot");
    expect(body.path).toBe("/");
    expect(body.snapshotId).toBe("snap-1");
    expect(body.folderId).toBe("f1");
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      name: "notes.txt",
      type: "file",
      size: 61,
      folderId: "f1",
    });

    // Defense-in-depth #1: the password reaches env, NOT argv. argv is
    // what ends up in `ps` — leaking it there would be a CVE.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.args).toEqual([
      "ls",
      "--json",
      "snap-1",
      "-r",
      "s3:restic/folder",
    ]);
    expect(captured[0]?.env?.["RESTIC_PASSWORD"]).toBe("super-secret-pw");
    expect(captured[0]?.args.join(" ")).not.toContain("super-secret-pw");
  });

  test("scrubs restic stderr on failure (LAMA-226 contract)", async () => {
    const { folderId } = insertResticFolder(
      "f1",
      "docs",
      "s3:restic/folder",
      "pw",
    );
    db.run(
      "INSERT INTO hosts (id, hostname, status, last_seen) VALUES ('h1', 'alpha', 'online', 1)",
    );
    insertSnapshotRow({
      id: "row-1",
      folderId: "f1",
      snapshotId: "snap-1",
      timestamp: 1_700_000_000_000,
      hostId: "h1",
      paths: ["/data"],
    });
    // The runner mints an unmistakable stderr — we assert NONE of it
    // makes it into the wire (LAMA-226 hard rule).
    const runner: ResticSpawnFn = async () => ({
      code: 11,
      stdout: "",
      stderr:
        "Fatal: unable to open repository at s3://super-secret-bucket/prod\n  at line two\n",
    });
    __setResticRunnerForTests(runner);
    const res = await app.handle(
      request("/api/v1/folders/f1/snapshots/snap-1/files?path=/"),
    );
    expect(res.status).toBe(502);
    const body = await responseObject(res);
    const errorText = String(body["error"] ?? "");
    expect(errorText).toContain("restic ls failed with exit code 11");
    expect(errorText).not.toContain("Fatal");
    expect(errorText).not.toContain("super-secret-bucket");
    expect(errorText).not.toContain("s3://");
    expect(errorText).not.toContain("prod");
  });

  test("passes the path filter as `<snap>:<path>` to restic (non-root listing)", async () => {
    const { folderId } = insertResticFolder(
      "f1",
      "docs",
      "s3:restic/folder",
      "pw",
    );
    db.run(
      "INSERT INTO hosts (id, hostname, status, last_seen) VALUES ('h1', 'alpha', 'online', 1)",
    );
    insertSnapshotRow({
      id: "row-1",
      folderId: "f1",
      snapshotId: "snap-1",
      timestamp: 1_700_000_000_000,
      hostId: "h1",
      paths: ["/data"],
    });
    const captured: ResticSpawnInput[] = [];
    const runner: ResticSpawnFn = async (input) => {
      captured.push(input);
      return {
        code: 0,
        stdout: resticLsJson([
          { name: "inside.txt", path: "/data/inside.txt", type: "file", size: 1 },
        ]),
        stderr: "",
      };
    };
    __setResticRunnerForTests(runner);
    const res = await app.handle(
      request("/api/v1/folders/f1/snapshots/snap-1/files?path=/data"),
    );
    expect(res.status).toBe(200);
    expect(captured[0]?.args).toEqual([
      "ls",
      "--json",
      "snap-1:/data",
      "-r",
      "s3:restic/folder",
    ]);
  });

  test("limit query param caps the entry count (default 500)", async () => {
    const { folderId } = insertResticFolder(
      "f1",
      "docs",
      "s3:restic/folder",
      "pw",
    );
    db.run(
      "INSERT INTO hosts (id, hostname, status, last_seen) VALUES ('h1', 'alpha', 'online', 1)",
    );
    insertSnapshotRow({
      id: "row-1",
      folderId: "f1",
      snapshotId: "snap-1",
      timestamp: 1_700_000_000_000,
      hostId: "h1",
      paths: ["/data"],
    });
    // Build 600 file nodes — one more than the default limit.
    const nodes = Array.from({ length: 600 }, (_, i) => ({
      name: `f-${String(i).padStart(4, "0")}.bin`,
      path: `/f-${String(i).padStart(4, "0")}.bin`,
      type: "file" as const,
      size: 1,
    }));
    __setResticRunnerForTests(async () => ({
      code: 0,
      stdout: resticLsJson(nodes),
      stderr: "",
    }));

    // Default cap (500)
    const defaultRes = await app.handle(
      request("/api/v1/folders/f1/snapshots/snap-1/files?path=/"),
    );
    expect(defaultRes.status).toBe(200);
    const defaultBody = (await defaultRes.json()) as { entries: unknown[] };
    expect(defaultBody.entries).toHaveLength(500);

    // Custom cap honored
    const explicitRes = await app.handle(
      request("/api/v1/folders/f1/snapshots/snap-1/files?path=/&limit=42"),
    );
    expect(explicitRes.status).toBe(200);
    const explicitBody = (await explicitRes.json()) as { entries: unknown[] };
    expect(explicitBody.entries).toHaveLength(42);

    // Garbage limit falls back to default (don't drop the request)
    const garbageRes = await app.handle(
      request("/api/v1/folders/f1/snapshots/snap-1/files?path=/&limit=banana"),
    );
    expect(garbageRes.status).toBe(200);
    const garbageBody = (await garbageRes.json()) as { entries: unknown[] };
    expect(garbageBody.entries).toHaveLength(500);
  });

  test("requires auth (401 without bearer)", async () => {
    insertResticFolder("f1", "docs", "s3:restic/a", "pw");
    const noAuth = new Request(
      "http://localhost/api/v1/folders/f1/snapshots/snap/files?path=/",
    );
    const res = await app.handle(noAuth);
    expect(res.status).toBe(401);
  });
});

// Belt-and-braces: prove the custom runner seam really substitutes. A future
// refactor that drops the runner return shape will surface here.
const _typeProbe: ResticSpawnInput = { args: ["snapshots"] };
const _typeProbeResult: ResticSpawnResult = {
  stdout: "x",
  stderr: "",
  code: 0,
};
void _typeProbe;
void _typeProbeResult;
