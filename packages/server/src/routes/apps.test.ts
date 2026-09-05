import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "apps-test-key";
process.env.LAMASYNC_BACKUP_DIR = process.env.LAMASYNC_BACKUP_DIR ?? "/tmp/lamasync-apps-test";

const { getAuthPlugin } = await import("../auth.ts");
const { __setDb, appsRoutes } = (await import("./apps.ts")) as typeof import("./apps.ts");
const { __setDb: __setConfigRevisionDb } = (await import("../config-revision.ts")) as typeof import("../config-revision.ts");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };

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
  db.exec(`INSERT INTO hosts (id, hostname, os) VALUES ('host-a', 'alpha', 'linux'), ('host-b', 'beta', 'macos')`);
  __setDb(db);
  __setConfigRevisionDb(db);
  app = new Elysia().use(getAuthPlugin()).use(appsRoutes);
});

afterEach(() => {
  db.close();
});

function authHeaders(): Headers {
  const h = new Headers();
  h.set("Authorization", `Bearer ${process.env.LAMASYNC_API_KEY}`);
  return h;
}

function jsonHeaders(): Headers {
  const h = authHeaders();
  h.set("Content-Type", "application/json");
  return h;
}

async function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    }),
  );
}

async function putJson(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    }),
  );
}

function spec(linux: string[]): object {
  return {
    paths: {
      linux: linux.map((p) => ({ path: p, classification: "unknown" })),
      macos: [],
      windows: [],
    },
    excludes: [],
    notes: null,
  };
}

let templateId: string;

async function createTemplate(): Promise<string> {
  const res = await postJson("/api/v1/apps/templates", {
    name: "nvim",
    origin: "custom",
    description: "Neovim config",
    paths: spec(["~/.config/nvim"]),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

describe("apps templates (LAMA-316)", () => {
  test("create, get, list, update (revision bump), delete", async () => {
    templateId = await createTemplate();

    const get = await app.handle(
      new Request(`http://localhost/api/v1/apps/templates/${templateId}`, { headers: authHeaders() }),
    );
    expect(get.status).toBe(200);
    const got = (await get.json()) as { revision: number; origin: string };
    expect(got.revision).toBe(1);
    expect(got.origin).toBe("custom");

    const list = await app.handle(
      new Request("http://localhost/api/v1/apps/templates", { headers: authHeaders() }),
    );
    expect(list.status).toBe(200);
    expect((await list.json()) as unknown[]).toHaveLength(1);

    const upd = await putJson(`/api/v1/apps/templates/${templateId}`, { description: "updated" });
    expect(upd.status).toBe(200);
    const updated = (await upd.json()) as { revision: number };
    expect(updated.revision).toBe(2);

    const del = await app.handle(
      new Request(`http://localhost/api/v1/apps/templates/${templateId}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
    expect(del.status).toBe(204);
  });

  test("duplicate template name → 409", async () => {
    await createTemplate();
    const res = await postJson("/api/v1/apps/templates", {
      name: "nvim",
      paths: spec(["~/.config/nvim"]),
    });
    expect(res.status).toBe(409);
  });

  test("template with protections cannot be deleted → 409", async () => {
    templateId = await createTemplate();
    const enroll = await postJson("/api/v1/apps/protections", {
      templateId,
      hostId: "host-a",
    });
    expect(enroll.status).toBe(201);
    const del = await app.handle(
      new Request(`http://localhost/api/v1/apps/templates/${templateId}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
    expect(del.status).toBe(409);
  });
});

describe("apps enroll (LAMA-316)", () => {
  test("enroll copies capture spec + template revision; template edit does not mutate it", async () => {
    templateId = await createTemplate();
    const enroll = await postJson("/api/v1/apps/protections", {
      templateId,
      hostId: "host-a",
    });
    expect(enroll.status).toBe(201);
    const prot = (await enroll.json()) as {
      id: string;
      templateRevision: number;
      captureSpec: { paths: { linux: { path: string; classification: string; rationale: string | null }[] } };
    };
    expect(prot.templateRevision).toBe(1);
    expect(prot.captureSpec.paths.linux).toEqual([
      { path: "~/.config/nvim", classification: "unknown", rationale: null },
    ]);

    // Template update bumps revision but the protection must not change.
    const upd = await putJson(`/api/v1/apps/templates/${templateId}`, { description: "new" });
    expect(upd.status).toBe(200);
    const get = await app.handle(
      new Request(`http://localhost/api/v1/apps/protections/${prot.id}`, { headers: authHeaders() }),
    );
    const after = (await get.json()) as { templateRevision: number };
    expect(after.templateRevision).toBe(1);
  });

  test("duplicate (host, template) → 409", async () => {
    templateId = await createTemplate();
    await postJson("/api/v1/apps/protections", { templateId, hostId: "host-a" });
    const dup = await postJson("/api/v1/apps/protections", { templateId, hostId: "host-a" });
    expect(dup.status).toBe(409);
  });

  test("_global host → 400; unknown host → 404", async () => {
    templateId = await createTemplate();
    const global = await postJson("/api/v1/apps/protections", { templateId, hostId: "_global" });
    expect(global.status).toBe(400);
    const missing = await postJson("/api/v1/apps/protections", { templateId, hostId: "nope" });
    expect(missing.status).toBe(404);
  });

  test("template without a capture path for the target host OS → 409", async () => {
    templateId = await createTemplate(); // linux-only template
    const enroll = await postJson("/api/v1/apps/protections", {
      templateId,
      hostId: "host-b", // macOS
    });
    expect(enroll.status).toBe(409);
    expect(db.query("SELECT id FROM application_protections").all()).toHaveLength(0);
  });

  test("list protections joins template identity + latest snapshot", async () => {
    templateId = await createTemplate();
    const enroll = await postJson("/api/v1/apps/protections", { templateId, hostId: "host-a" });
    const prot = (await enroll.json()) as { id: string };
    // Seed a snapshot directly to exercise the join.
    db.run(
      `INSERT INTO application_snapshots
         (id, protection_id, template_id, template_revision, source_host_id, created_at,
          archive_path, archive_format, size_bytes, checksum_sha256, captured_spec, integrity_status, demo)
       VALUES ('s1', ?, ?, 1, 'host-a', 123, 'apps/b/1.tar.gz', 'tar.gz', 99, 'abc', ?, 'verified', 0)`,
      [prot.id, templateId, JSON.stringify(spec(["~/.config/nvim"]))],
    );
    const list = await app.handle(
      new Request("http://localhost/api/v1/apps/protections?hostId=host-a", { headers: authHeaders() }),
    );
    expect(list.status).toBe(200);
    const rows = (await list.json()) as Array<{
      templateName: string;
      templateOrigin: string;
      latestSnapshot: { sizeBytes: number; integrityStatus: string } | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].templateName).toBe("nvim");
    expect(rows[0].templateOrigin).toBe("custom");
    expect(rows[0].latestSnapshot?.sizeBytes).toBe(99);
    expect(rows[0].latestSnapshot?.integrityStatus).toBe("verified");
  });
});

describe("apps snapshots (LAMA-316)", () => {
  test("upload records the host's exact captured spec and checksum, then list + download", async () => {
    templateId = await createTemplate();
    const enroll = await postJson("/api/v1/apps/protections", { templateId, hostId: "host-a" });
    const prot = (await enroll.json()) as { id: string };

    const file = new File(["hello-snapshot"], "snap.tar.gz", { type: "application/gzip" });
    const form = new FormData();
    form.append("tarball", file, "snap.tar.gz");
    form.append("description", "first snapshot");
    const upload = await app.handle(
      new Request(`http://localhost/api/v1/apps/protections/${prot.id}/snapshots`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      }),
    );
    expect(upload.status).toBe(201);
    const snap = (await upload.json()) as {
      id: string;
      sizeBytes: number;
      checksumSha256: string;
      capturedSpec: { paths: { linux: { path: string; archivePath: string }[]; macos?: unknown[] } };
      integrityStatus: string;
    };
    expect(snap.sizeBytes).toBe(14);
    expect(snap.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snap.capturedSpec.paths.linux[0].path).toBe("~/.config/nvim");
    expect(snap.capturedSpec.paths.linux[0].archivePath).toBe("home/.config/nvim");
    expect(snap.capturedSpec.paths.macos).toBeUndefined();
    expect(snap.integrityStatus).toBe("verified");

    const list = await app.handle(
      new Request(`http://localhost/api/v1/apps/protections/${prot.id}/snapshots`, {
        headers: authHeaders(),
      }),
    );
    expect(list.status).toBe(200);
    expect((await list.json()) as unknown[]).toHaveLength(1);

    const dl = await app.handle(
      new Request(`http://localhost/api/v1/apps/snapshots/${snap.id}/download`, {
        headers: authHeaders(),
      }),
    );
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe("hello-snapshot");

    const del = await app.handle(
      new Request(`http://localhost/api/v1/apps/snapshots/${snap.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
    expect(del.status).toBe(204);
  });

  test("disabled protection rejects capture → 409", async () => {
    templateId = await createTemplate();
    const enroll = await postJson("/api/v1/apps/protections", { templateId, hostId: "host-a" });
    const prot = (await enroll.json()) as { id: string };
    const disable = await putJson(`/api/v1/apps/protections/${prot.id}`, { enabled: false });
    expect(disable.status).toBe(200);

    const file = new File(["x"], "snap.tar.gz", { type: "application/gzip" });
    const form = new FormData();
    form.append("tarball", file, "snap.tar.gz");
    const upload = await app.handle(
      new Request(`http://localhost/api/v1/apps/protections/${prot.id}/snapshots`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      }),
    );
    expect(upload.status).toBe(409);
    const n = db.query(`SELECT count(*) AS n FROM application_snapshots`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  test("protection with snapshot history cannot be deleted; disable preserves it", async () => {
    templateId = await createTemplate();
    const enroll = await postJson("/api/v1/apps/protections", { templateId, hostId: "host-a" });
    const prot = (await enroll.json()) as { id: string };
    db.run(
      `INSERT INTO application_snapshots
         (id, protection_id, template_id, template_revision, source_host_id, created_at,
          archive_path, archive_format, captured_spec, integrity_status, demo)
       VALUES ('snapshot-history', ?, ?, 1, 'host-a', 1, 'apps/p/a.tar.gz', 'tar.gz', ?, 'verified', 0)`,
      [prot.id, templateId, JSON.stringify(spec(["~/.config/nvim"]))],
    );
    const del = await app.handle(
      new Request(`http://localhost/api/v1/apps/protections/${prot.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
    expect(del.status).toBe(409);
    expect(db.query(`SELECT id FROM application_protections WHERE id = ?`).get(prot.id)).not.toBeNull();

    const disable = await putJson(`/api/v1/apps/protections/${prot.id}`, { enabled: false });
    expect(disable.status).toBe(200);
    expect(db.query(`SELECT id FROM application_snapshots WHERE id = 'snapshot-history'`).get()).not.toBeNull();
  });

  test("invalid capture path entries and classifications are rejected", async () => {
    const invalidPath = await postJson("/api/v1/apps/templates", {
      name: "invalid-path",
      paths: { paths: { linux: [{ path: "", classification: "unknown" }] }, excludes: [], notes: null },
    });
    expect(invalidPath.status).toBe(400);

    const relativePath = await postJson("/api/v1/apps/templates", {
      name: "relative-path",
      paths: { paths: { linux: [{ path: ".config/x", classification: "unknown" }] }, excludes: [], notes: null },
    });
    expect(relativePath.status).toBe(400);

    const invalidClass = await postJson("/api/v1/apps/templates", {
      name: "invalid-class",
      paths: { paths: { linux: [{ path: "~/.config/x", classification: "not-real" }] }, excludes: [], notes: null },
    });
    expect(invalidClass.status).toBe(400);
  });
});
