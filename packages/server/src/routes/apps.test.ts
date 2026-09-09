import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
import type { CaptureSpecPath } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "apps-test-key";
process.env.LAMASYNC_BACKUP_DIR = process.env.LAMASYNC_BACKUP_DIR ?? "/tmp/lamasync-apps-test";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-apps-test-data";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "apps-test-secret-key-0123456789abcdef";
process.env.LAMASYNC_APPS_STAGING_DIR = process.env.LAMASYNC_APPS_STAGING_DIR ?? "/tmp/lamasync-apps-test-staging";

const { getAuthPlugin } = await import("../auth.ts");
const { __setDb, appsRoutes, __setMaxBytesForTests } = (await import("./apps.ts")) as typeof import("./apps.ts");
const { __setDb: __setConfigRevisionDb } = (await import("../config-revision.ts")) as typeof import("../config-revision.ts");
const { __setRcloneExecForTest } = await import("../app-storage.ts");
const { encryptSecret } = await import("../crypto.ts");

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
  __setMaxBytesForTests(512 * 1024 * 1024);
  db.close();
  __setRcloneExecForTest(null);
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
      captureSpec: {
        paths: {
          linux: {
            path: string;
            classification: string;
            rationale: string | null;
            classificationSource: string;
            confidence: number | null;
          }[];
        };
      };
    };
    expect(prot.templateRevision).toBe(1);
    // LAMA-315: normalizeCaptureSpec stamps the untouched `default` provenance
    // so the template row (and therefore the enrolled copy) is self-describing.
    expect(prot.captureSpec.paths.linux).toEqual([
      {
        path: "~/.config/nvim",
        classification: "unknown",
        rationale: null,
        classificationSource: "default",
        confidence: null,
      },
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

describe("apps storage destinations (LAMA-324)", () => {
  function insertLocalBackend(path: string): string {
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO backends (id, name, kind, local_path, created_at) VALUES (?, 'local-dest', 'local', ?, ?)`,
      [id, path, Date.now()],
    );
    return id;
  }

  function insertS3Backend(): string {
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO backends (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, created_at)
       VALUES (?, 's3-dest', 's3', 'other', 'https://s3.example.test', 'r1', 'AK', ?, ?)`,
      [id, encryptSecret("route-secret"), Date.now()],
    );
    return id;
  }

  function insertResticBackend(): string {
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO backends (id, name, kind, restic_repository, restic_password_enc, created_at)
       VALUES (?, 'restic-dest', 'restic', 'repo:test', 'enc', ?)`,
      [id, Date.now()],
    );
    return id;
  }

  async function upload(protectionId: string, contents = "route-archive"): Promise<Response> {
    const form = new FormData();
    form.append("tarball", new File([contents], "snap.tar.gz", { type: "application/gzip" }));
    form.append("description", "LAMA-324 test upload");
    return app.handle(
      new Request(`http://localhost/api/v1/apps/protections/${protectionId}/snapshots`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      }),
    );
  }

  test("destination validation: local backend accepted; s3 needs bucket; restic/unknown rejected", async () => {
    const tpl = async (name: string): Promise<string> => {
      const res = await postJson("/api/v1/apps/templates", {
        name,
        origin: "custom",
        paths: spec(["~/.config/nvim"]),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const localBackendId = insertLocalBackend("/tmp/lamasync-apps-test-local");
    const s3BackendId = insertS3Backend();
    const resticBackendId = insertResticBackend();

    const local = await postJson("/api/v1/apps/protections", {
      templateId: await tpl("tpl-local"),
      hostId: "host-a",
      backendId: localBackendId,
    });
    expect(local.status).toBe(201);
    const localBody = (await local.json()) as { backendId: string | null; backendName: string | null; destination: string; s3Bucket: string | null };
    expect(localBody.backendId).toBe(localBackendId);
    expect(localBody.backendName).toBe("local-dest");
    expect(localBody.destination).toBe("local-dest");
    expect(localBody.s3Bucket).toBeNull();

    const s3NoBucket = await postJson("/api/v1/apps/protections", {
      templateId: await tpl("tpl-s3-nobucket"),
      hostId: "host-a",
      backendId: s3BackendId,
    });
    expect(s3NoBucket.status).toBe(400);
    const s3WithBucket = await postJson("/api/v1/apps/protections", {
      templateId: await tpl("tpl-s3-bucket"),
      hostId: "host-a",
      backendId: s3BackendId,
      s3Bucket: "apps-bucket",
    });
    expect(s3WithBucket.status).toBe(201);

    const restic = await postJson("/api/v1/apps/protections", {
      templateId: await tpl("tpl-restic"),
      hostId: "host-a",
      backendId: resticBackendId,
    });
    expect(restic.status).toBe(400);

    const unknown = await postJson("/api/v1/apps/protections", {
      templateId: await tpl("tpl-unknown"),
      hostId: "host-a",
      backendId: "no-such-backend",
    });
    expect(unknown.status).toBe(400);
  });

  test("NULL/default destination stays server archive (backward compatible)", async () => {
    templateId = await createTemplate();
    const enroll = await postJson("/api/v1/apps/protections", { templateId, hostId: "host-a" });
    expect(enroll.status).toBe(201);
    const body = (await enroll.json()) as { backendId: string | null; backendName: string | null; destination: string };
    expect(body.backendId).toBeNull();
    expect(body.backendName).toBeNull();
    expect(body.destination).toBe("server_archive");
    const row = db
      .query<{ backend_id: string | null }, [string]>(
        "SELECT backend_id FROM application_protections WHERE host_id = 'host-a'",
      )
      .get(templateId) as unknown as { backend_id: string | null } | undefined;
    // The first enrollment on host-a may be this one; assert via the response only.
    void row;
  });

  test("change destination → future captures relay; old snapshots keep immutable location", async () => {
    templateId = await createTemplate();
    const enroll = await postJson("/api/v1/apps/protections", { templateId, hostId: "host-a" });
    const prot = (await enroll.json()) as { id: string };

    // Capture 1: server-local default.
    const first = await upload(prot.id, "first-archive");
    expect(first.status).toBe(201);
    const firstSnap = (await first.json()) as {
      id: string;
      backendId: string | null;
      objectKey: string | null;
      s3Bucket: string | null;
    };
    expect(firstSnap.backendId).toBeNull();
    expect(firstSnap.objectKey).toBeNull();

    // Change destination to a local backend.
    const localBackendId = insertLocalBackend("/tmp/lamasync-apps-test-dest-b");
    const changed = await putJson(`/api/v1/apps/protections/${prot.id}`, { backendId: localBackendId });
    expect(changed.status).toBe(200);
    const changedBody = (await changed.json()) as { backendId: string | null; backendName: string | null };
    expect(changedBody.backendId).toBe(localBackendId);
    expect(changedBody.backendName).toBe("local-dest");

    // Capture 2: relayed to the backend under the fixed key.
    const second = await upload(prot.id, "second-archive");
    expect(second.status).toBe(201);
    const secondSnap = (await second.json()) as {
      id: string;
      backendId: string | null;
      objectKey: string;
    };
    expect(secondSnap.backendId).toBe(localBackendId);
    expect(secondSnap.objectKey).toBe(`lamasync/apps/${prot.id}/${secondSnap.id}.tar.gz`);

    // The old snapshot remains downloadable from its ORIGINAL location.
    const dlFirst = await app.handle(
      new Request(`http://localhost/api/v1/apps/snapshots/${firstSnap.id}/download`, {
        headers: authHeaders(),
      }),
    );
    expect(dlFirst.status).toBe(200);
    expect(await dlFirst.text()).toBe("first-archive");

    const dlSecond = await app.handle(
      new Request(`http://localhost/api/v1/apps/snapshots/${secondSnap.id}/download`, {
        headers: authHeaders(),
      }),
    );
    expect(dlSecond.status).toBe(200);
    expect(await dlSecond.text()).toBe("second-archive");

    // List DTO carries backend name (no N+1 needed by the UI).
    const list = await app.handle(
      new Request(`http://localhost/api/v1/apps/protections?hostId=host-a`, { headers: authHeaders() }),
    );
    const rows = (await list.json()) as {
      backendId: string | null;
      backendName: string | null;
    }[];
    expect(rows[0]?.backendId).toBe(localBackendId);
    expect(rows[0]?.backendName).toBe("local-dest");
  });

  test("relay failure leaves no snapshot row (502, nothing orphaned)", async () => {
    templateId = await createTemplate();
    const s3BackendId = insertS3Backend();
    const enroll = await postJson("/api/v1/apps/protections", {
      templateId,
      hostId: "host-a",
      backendId: s3BackendId,
      s3Bucket: "apps-bucket",
    });
    const prot = (await enroll.json()) as { id: string };
    __setRcloneExecForTest(async () => ({ code: 1, stdout: "", stderr: "AccessDenied: denied\n" }));

    const res = await upload(prot.id, "never-lands");
    expect(res.status).toBe(502);
    const n = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM application_snapshots`)
      .get() as { n: number };
    expect(n.n).toBe(0);
  });

  test("successful remote upload/download/delete through the fake rclone boundary", async () => {
    templateId = await createTemplate();
    const s3BackendId = insertS3Backend();
    const enroll = await postJson("/api/v1/apps/protections", {
      templateId,
      hostId: "host-a",
      backendId: s3BackendId,
      s3Bucket: "apps-bucket",
    });
    const prot = (await enroll.json()) as { id: string };
    const calls: string[][] = [];
    __setRcloneExecForTest(async (argv) => {
      calls.push(argv);
      if (argv.includes("cat")) return { code: 0, stdout: "remote-archive", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });

    const up = await upload(prot.id, "remote-archive");
    expect(up.status).toBe(201);
    const snap = (await up.json()) as { id: string; objectKey: string };
    const copyCall = calls.find((a) => a.includes("copyto"))!;
    expect(copyCall.find((a) => a.startsWith("relay:"))).toBe(
      `relay:apps-bucket/lamasync/apps/${prot.id}/${snap.id}.tar.gz`,
    );

    const dl = await app.handle(
      new Request(`http://localhost/api/v1/apps/snapshots/${snap.id}/download`, {
        headers: authHeaders(),
      }),
    );
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe("remote-archive");

    const del = await app.handle(
      new Request(`http://localhost/api/v1/apps/snapshots/${snap.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
    expect(del.status).toBe(204);
    const delCall = calls.find((a) => a.includes("deletefile"))!;
    expect(delCall.find((a) => a.startsWith("relay:"))).toBe(
      `relay:apps-bucket/lamasync/apps/${prot.id}/${snap.id}.tar.gz`,
    );
    const n = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM application_snapshots`)
      .get() as { n: number };
    expect(n.n).toBe(0);
  });

  test("snapshot delete failure keeps the row (failure is not silent)", async () => {
    templateId = await createTemplate();
    const s3BackendId = insertS3Backend();
    const enroll = await postJson("/api/v1/apps/protections", {
      templateId,
      hostId: "host-a",
      backendId: s3BackendId,
      s3Bucket: "apps-bucket",
    });
    const prot = (await enroll.json()) as { id: string };
    __setRcloneExecForTest(async (argv) => {
      if (argv.includes("copyto")) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "backend unreachable" };
    });
    const up = await upload(prot.id, "stuck-archive");
    expect(up.status).toBe(201);
    const snap = (await up.json()) as { id: string };

    const del = await app.handle(
      new Request(`http://localhost/api/v1/apps/snapshots/${snap.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
    expect(del.status).toBe(502);
    const row = db
      .query<{ id: string }, [string]>("SELECT id FROM application_snapshots WHERE id = ?")
      .get(snap.id);
    expect(row).not.toBeNull();
  });
});

describe("apps upload bounding + destination hardening (LAMA-324 review)", () => {
  function insertS3Backend(): string {
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO backends (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, created_at)
       VALUES (?, 's3-dest', 's3', 'other', 'https://s3.example.test', 'r1', 'AK', ?, ?)`,
      [id, encryptSecret("route-secret"), Date.now()],
    );
    return id;
  }

  test("oversized snapshot is rejected with 413 and records no row", async () => {
    templateId = await createTemplate();
    const enroll = await postJson("/api/v1/apps/protections", { templateId, hostId: "host-a" });
    const prot = (await enroll.json()) as { id: string };
    __setMaxBytesForTests(8);
    const form = new FormData();
    form.append("tarball", new File(["way-too-large-body"], "snap.tar.gz", { type: "application/gzip" }));
    const res = await app.handle(
      new Request(`http://localhost/api/v1/apps/protections/${prot.id}/snapshots`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      }),
    );
    expect(res.status).toBe(413);
    const n = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM application_snapshots`)
      .get() as { n: number };
    expect(n.n).toBe(0);
  });

  test("bucket validation: hostile names rejected, valid names accepted", async () => {
    const s3BackendId = insertS3Backend();
    const tpl = async (name: string): Promise<string> => {
      const res = await postJson("/api/v1/apps/templates", {
        name,
        origin: "custom",
        paths: spec(["~/.config/nvim"]),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const badBuckets = [
      "has/forward",
      "has:colon",
      "UPPER",
      "has_underscore",
      "..traversal",
      "script\nvalue",
      "trail-dash-",
      "",
    ];
    for (const bucket of badBuckets) {
      const res = await postJson("/api/v1/apps/protections", {
        templateId: await tpl(`tpl-bad-${badBuckets.indexOf(bucket)}`),
        hostId: "host-a",
        backendId: s3BackendId,
        s3Bucket: bucket,
      });
      expect(res.status, `bucket=${JSON.stringify(bucket)}`).toBe(400);
    }
    const ok = await postJson("/api/v1/apps/protections", {
      templateId: await tpl("tpl-good-bucket"),
      hostId: "host-a",
      backendId: s3BackendId,
      s3Bucket: "lamasync-apps",
    });
    expect(ok.status).toBe(201);
  });

  test("change destination rejects a hostile bucket (future captures stay put)", async () => {
    templateId = await createTemplate();
    const s3BackendId = insertS3Backend();
    const enroll = await postJson("/api/v1/apps/protections", { templateId, hostId: "host-a" });
    const prot = (await enroll.json()) as { id: string };
    const res = await putJson(`/api/v1/apps/protections/${prot.id}`, {
      backendId: s3BackendId,
      s3Bucket: "bad..bucket",
    });
    expect(res.status).toBe(400);
    const row = db
      .query<{ backend_id: string | null }, [string]>(
        "SELECT backend_id FROM application_protections WHERE id = ?",
      )
      .get(prot.id);
    expect(row?.backend_id).toBeNull();
  });
});

describe("LAMA-315 — classification annotations round-trip and validation", () => {
  function pathOf(body: Record<string, unknown>): Record<string, unknown> {
    return {
      paths: body.paths,
      excludes: [],
      notes: null,
    };
  }

  test("create/get/update round-trip classificationSource + confidence", async () => {
    const res = await postJson("/api/v1/apps/templates", {
      name: "classified",
      origin: "custom",
      paths: {
        paths: {
          linux: [
            {
              path: "~/.cache",
              classification: "cache",
              classificationSource: "suggested",
              confidence: 0.9,
              rationale: "Detected as cache: well-known cache directory `~/.cache`.",
            },
          ],
          macos: [],
          windows: [],
        },
        excludes: [],
        notes: "pending recommendation kept",
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      paths: { paths: { linux: CaptureSpecPath[] } };
    };
    expect(created.paths.paths.linux[0]).toEqual({
      path: "~/.cache",
      classification: "cache",
      rationale: "Detected as cache: well-known cache directory `~/.cache`.",
      classificationSource: "suggested",
      confidence: 0.9,
    });

    const got = await app.handle(
      new Request(`http://localhost/api/v1/apps/templates/${created.id}`, { headers: authHeaders() }),
    );
    const read = (await got.json()) as { paths: { paths: { linux: CaptureSpecPath[] } } };
    expect(read.paths.paths.linux[0].classificationSource).toBe("suggested");
    expect(read.paths.paths.linux[0].confidence).toBe(0.9);

    // Operator confirms: manual drops confidence, keeps rationale.
    const upd = await putJson(`/api/v1/apps/templates/${created.id}`, {
      paths: {
        paths: {
          linux: [
            {
              path: "~/.cache",
              classification: "cache",
              classificationSource: "manual",
              rationale: "operator confirmed",
            },
          ],
          macos: [],
          windows: [],
        },
        excludes: [],
        notes: null,
      },
    });
    expect(upd.status).toBe(200);
    const updated = (await upd.json()) as { paths: { paths: { linux: CaptureSpecPath[] } } };
    expect(updated.paths.paths.linux[0]).toEqual({
      path: "~/.cache",
      classification: "cache",
      rationale: "operator confirmed",
      classificationSource: "manual",
      confidence: null,
    });
  });

  test("legacy string[] template normalizes to unknown/default", async () => {
    const res = await postJson("/api/v1/apps/templates", {
      name: "legacy-raw",
      paths: ["~/.config/nvim", "~/.zshrc"],
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; paths: { paths: { linux: CaptureSpecPath[]; macos: CaptureSpecPath[]; windows: CaptureSpecPath[] } } };
    const linux = created.paths.paths.linux ?? [];
    expect(linux).toHaveLength(2);
    for (const entry of linux) {
      expect(entry.classification).toBe("unknown");
      expect(entry.classificationSource).toBe("default");
      expect(entry.confidence).toBeNull();
    }
    expect(created.paths.paths.macos).toEqual([]);
    expect(created.paths.paths.windows).toEqual([]);
  });

  test("rejects invalid provenance: bad source, out-of-range/mismatched confidence", async () => {
    const cases: Array<{ name: string; entry: Record<string, unknown> }> = [
      { name: "unknown-source", entry: { path: "~/.cache", classification: "cache", classificationSource: "auto" } },
      { name: "confidence-too-high", entry: { path: "~/.cache", classification: "cache", classificationSource: "suggested", confidence: 1.5 } },
      { name: "confidence-negative", entry: { path: "~/.cache", classification: "cache", classificationSource: "suggested", confidence: -0.1 } },
      { name: "suggested-without-confidence", entry: { path: "~/.cache", classification: "cache", classificationSource: "suggested" } },
      { name: "confidence-with-manual", entry: { path: "~/.cache", classification: "cache", classificationSource: "manual", confidence: 0.9 } },
      { name: "confidence-with-default", entry: { path: "~/.cache", classification: "cache", classificationSource: "default", confidence: 0.9 } },
      { name: "confidence-string", entry: { path: "~/.cache", classification: "cache", classificationSource: "suggested", confidence: "0.9" } },
    ];
    for (const c of cases) {
      const res = await postJson("/api/v1/apps/templates", {
        name: `bad-${c.name}`,
        paths: pathOf({ paths: { linux: [c.entry], macos: [], windows: [] } }),
      });
      expect(res.status, c.name).toBe(400);
    }
    // Unknown classification is still rejected (existing rule).
    const badClass = await postJson("/api/v1/apps/templates", {
      name: "bad-class",
      paths: pathOf({ paths: { linux: [{ path: "~/.cache", classification: "mystery", classificationSource: "manual" }], macos: [], windows: [] } }),
    });
    expect(badClass.status).toBe(400);
  });

  test("enrollment and snapshot freeze carry the annotations", async () => {
    const res = await postJson("/api/v1/apps/templates", {
      name: "annotated",
      origin: "custom",
      paths: {
        paths: {
          linux: [
            { path: "~/.config/nvim", classification: "portable_config", classificationSource: "manual", rationale: "confirmed" },
            { path: "~/.cache", classification: "cache", classificationSource: "suggested", confidence: 0.9, rationale: "suggested cache" },
          ],
          macos: [],
          windows: [],
        },
        excludes: [],
        notes: null,
      },
    });
    expect(res.status).toBe(201);
    const template = (await res.json()) as { id: string };

    const enroll = await postJson("/api/v1/apps/protections", { templateId: template.id, hostId: "host-a" });
    expect(enroll.status).toBe(201);
    const prot = (await enroll.json()) as { id: string; captureSpec: { paths: { linux: CaptureSpecPath[] } } };
    const frozen = prot.captureSpec.paths.linux;
    expect(frozen.find((p) => p.path === "~/.config/nvim")).toMatchObject({
      classification: "portable_config",
      classificationSource: "manual",
    });
    expect(frozen.find((p) => p.path === "~/.cache")).toMatchObject({
      classification: "cache",
      classificationSource: "suggested",
      confidence: 0.9,
    });

    const file = new File(["annotated-snapshot"], "snap.tar.gz", { type: "application/gzip" });
    const form = new FormData();
    form.append("tarball", file, "snap.tar.gz");
    const upload = await app.handle(
      new Request(`http://localhost/api/v1/apps/protections/${prot.id}/snapshots`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      }),
    );
    expect(upload.status).toBe(201);
    const snap = (await upload.json()) as {
      capturedSpec: { paths: { linux: CaptureSpecPath[] } };
    };
    // Snapshot captured_spec freezes the annotations + archive mapping.
    const captured = snap.capturedSpec.paths.linux;
    expect(captured.find((p) => p.path === "~/.config/nvim")).toMatchObject({
      classification: "portable_config",
      classificationSource: "manual",
      archivePath: "home/.config/nvim",
    });
    expect(captured.find((p) => p.path === "~/.cache")).toMatchObject({
      classification: "cache",
      classificationSource: "suggested",
      confidence: 0.9,
      archivePath: "home/.cache",
    });
  });

  test("snapshot captured_spec normalizes legacy protection specs to default", async () => {
    // A protection whose frozen capture_spec predates LAMA-315 (no source /
    // confidence fields, inserted directly into the DB) freezes a snapshot
    // with the untouched `default` provenance — history is not reinterpreted.
    templateId = await createTemplate();
    const enroll = await postJson("/api/v1/apps/protections", { templateId, hostId: "host-a" });
    const prot = (await enroll.json()) as { id: string };
    db.run(
      `UPDATE application_protections SET capture_spec = ? WHERE id = ?`,
      [
        JSON.stringify({
          paths: { linux: [{ path: "~/.config/nvim", classification: "unknown", rationale: null }], macos: [], windows: [] },
          excludes: [],
          notes: null,
        }),
        prot.id,
      ],
    );
    const file = new File(["legacy-snapshot"], "snap.tar.gz", { type: "application/gzip" });
    const form = new FormData();
    form.append("tarball", file, "snap.tar.gz");
    const upload = await app.handle(
      new Request(`http://localhost/api/v1/apps/protections/${prot.id}/snapshots`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      }),
    );
    expect(upload.status).toBe(201);
    const snap = (await upload.json()) as { capturedSpec: { paths: { linux: CaptureSpecPath[] } } };
    expect(snap.capturedSpec.paths.linux[0]).toMatchObject({
      path: "~/.config/nvim",
      classification: "unknown",
      classificationSource: "default",
      confidence: null,
    });
  });
});

describe("LAMA-315 — read-only classify endpoint", () => {
  async function classify(paths: string[]): Promise<Response> {
    return postJson("/api/v1/apps/classify", { paths });
  }

  test("returns deterministic suggestions with explanation + confidence for known paths", async () => {
    const res = await classify(["~/.cache", "~/.ssh", "~/.config/nvim"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{
        path: string;
        classification: string;
        confidence: number | null;
        confidenceLevel: string | null;
        rationale: string | null;
        ruleId: string | null;
      }>;
    };
    const byPath = new Map(body.results.map((r) => [r.path, r]));
    expect(byPath.get("~/.cache")).toMatchObject({
      classification: "cache",
      confidenceLevel: "high",
      confidence: 0.9,
    });
    expect(byPath.get("~/.ssh")?.classification).toBe("secrets");
    expect(byPath.get("~/.config/nvim")?.classification).toBe("portable_config");
    for (const result of body.results) {
      expect(result.rationale).toContain("Detected as");
      expect(result.ruleId).toBeTruthy();
    }
    // Determinism: same input, same output.
    const again = (await (await classify(["~/.cache", "~/.ssh", "~/.config/nvim"])).json()) as {
      results: Array<{ ruleId: string | null }>;
    };
    expect(again.results.map((r) => r.ruleId)).toEqual(body.results.map((r) => r.ruleId));
  });

  test("unknown paths are reported as unknown with null explanation — never guessed", async () => {
    const res = await classify(["~/projects/notes.txt"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{
        path: string;
        classification: string;
        confidence: number | null;
        confidenceLevel: string | null;
        rationale: string | null;
        ruleId: string | null;
      }>;
    };
    expect(body.results[0]).toEqual({
      path: "~/projects/notes.txt",
      classification: "unknown",
      confidence: null,
      confidenceLevel: null,
      rationale: null,
      ruleId: null,
    });
  });

  test("rejects empty path lists, empty strings, and oversized batches", async () => {
    expect((await classify([])).status).toBe(400);
    expect((await classify([""])).status).toBe(400);
    expect((await classify(["/"] )).status).toBe(200); // "/" is a valid configured path
    const huge = Array.from({ length: 501 }, (_, i) => `~/.config/app${i}`);
    expect((await classify(huge)).status).toBe(400);
    expect((await classify(["~/.config/" + "x".repeat(4097)])).status).toBe(400);
  });

  test("requires admin (401 without a valid credential)", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/apps/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: ["~/.cache"] }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
