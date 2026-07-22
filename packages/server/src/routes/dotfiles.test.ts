import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "dotfiles-test-key";
process.env.LAMASYNC_BACKUP_DIR = process.env.LAMASYNC_BACKUP_DIR ?? "/tmp/lamasync-dotfiles-test";

const { getAuthPlugin } = await import("../auth.ts");
const { __setDb, dotfilesRoutes } = (await import("./dotfiles.ts")) as typeof import("./dotfiles.ts");

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
  db.exec(`INSERT INTO hosts (id, hostname) VALUES ('host-a', 'host-a');`);
  __setDb(db);
  app = new Elysia().use(getAuthPlugin()).use(dotfilesRoutes);
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

async function get(path: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, { headers: authHeaders() }),
  );
}

describe("dotfile manifests", () => {
  test("creates a global manifest by default and lists it for any host", async () => {
    const create = await postJson("/api/v1/dotfiles/manifests", {
      appName: "opencode",
      paths: ["~/.config/opencode"],
      instructions: "Restart OpenCode after restore.",
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { appName: string; hostId: string; instructions: string };
    expect(created.appName).toBe("opencode");
    expect(created.hostId).toBe("_global");
    expect(created.instructions).toBe("Restart OpenCode after restore.");

    const list = await get("/api/v1/dotfiles/manifests?hostId=host-a");
    expect(list.status).toBe(200);
    const manifests = (await list.json()) as Array<{ appName: string }>;
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.appName).toBe("opencode");
  });

  test("creates a host-specific manifest with excludes", async () => {
    const create = await postJson("/api/v1/dotfiles/manifests", {
      appName: "nvim",
      hostId: "host-a",
      paths: ["~/.config/nvim"],
      excludes: ["~/.config/nvim/undo"],
      schedule: "0 */6 * * *",
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { appName: string; hostId: string; paths: string[]; excludes: string[] };
    expect(created.hostId).toBe("host-a");
    expect(created.excludes).toEqual(["~/.config/nvim/undo"]);
  });

  test("updates excludes on a manifest", async () => {
    const create = await postJson("/api/v1/dotfiles/manifests", {
      appName: "nvim",
      paths: ["~/.config/nvim"],
    });
    const { id } = (await create.json()) as { id: string };
    const update = await putJson(`/api/v1/dotfiles/manifests/${id}`, {
      excludes: ["*.log", "cache/"],
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as { excludes: string[] };
    expect(updated.excludes).toEqual(["*.log", "cache/"]);
  });

  test("upload tracks deployment metadata on the manifest", async () => {
    await postJson("/api/v1/dotfiles/manifests", {
      appName: "opencode",
      paths: ["~/.config/opencode"],
    });

    const form = new FormData();
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    form.append("tarball", new Blob([bytes]), "opencode.tar.gz");
    form.append("uploaderHostId", "host-a");
    const upload = await app.handle(
      new Request("http://localhost/api/v1/dotfiles/opencode", {
        method: "POST",
        headers: authHeaders(),
        body: form,
      }),
    );
    expect(upload.status).toBe(201);

    const list = await get("/api/v1/dotfiles/manifests");
    const manifests = (await list.json()) as Array<{
      appName: string;
      lastSyncAt: number | null;
      lastSyncDirection: string | null;
      originalUploaderHostId: string | null;
    }>;
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.lastSyncAt).not.toBeNull();
    expect(manifests[0]?.lastSyncDirection).toBe("upload");
    expect(manifests[0]?.originalUploaderHostId).toBe("host-a");
  });

  test("host manifest overrides global manifest for the same app", async () => {
    await postJson("/api/v1/dotfiles/manifests", {
      appName: "opencode",
      paths: ["~/.config/opencode"],
      instructions: "global",
    });
    await postJson("/api/v1/dotfiles/manifests", {
      appName: "opencode",
      hostId: "host-a",
      paths: ["~/.config/opencode/agents"],
      instructions: "host-specific",
    });

    const list = await get("/api/v1/dotfiles/manifests?hostId=host-a");
    const manifests = (await list.json()) as Array<{ appName: string; instructions: string; paths: string[] }>;
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.instructions).toBe("host-specific");
    expect(manifests[0]?.paths).toEqual(["~/.config/opencode/agents"]);
  });

  test("updates a manifest", async () => {
    const create = await postJson("/api/v1/dotfiles/manifests", {
      appName: "opencode",
      paths: ["~/.config/opencode"],
    });
    const { id } = (await create.json()) as { id: string };
    const update = await putJson(`/api/v1/dotfiles/manifests/${id}`, {
      instructions: "new instructions",
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as { instructions: string };
    expect(updated.instructions).toBe("new instructions");
  });

  test("updates hostId on a manifest (LAMA-168)", async () => {
    const create = await postJson("/api/v1/dotfiles/manifests", {
      appName: "opencode",
      paths: ["~/.config/opencode"],
    });
    const { id } = (await create.json()) as { id: string };
    const update = await putJson(`/api/v1/dotfiles/manifests/${id}`, {
      hostId: "host-a",
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as { hostId: string };
    expect(updated.hostId).toBe("host-a");
  });

  test("returns 409 when hostId update collides with an existing manifest", async () => {
    await postJson("/api/v1/dotfiles/manifests", {
      appName: "opencode",
      hostId: "host-a",
      paths: ["~/.config/opencode"],
    });
    const create = await postJson("/api/v1/dotfiles/manifests", {
      appName: "opencode",
      paths: ["~/.config/opencode/global"],
    });
    const { id } = (await create.json()) as { id: string };
    const update = await putJson(`/api/v1/dotfiles/manifests/${id}`, {
      hostId: "host-a",
    });
    expect(update.status).toBe(409);
  });

  test("deletes a manifest and its versions", async () => {
    const create = await postJson("/api/v1/dotfiles/manifests", {
      appName: "opencode",
      paths: ["~/.config/opencode"],
    });
    const { id } = (await create.json()) as { id: string };

    const del = await app.handle(
      new Request(`http://localhost/api/v1/dotfiles/manifests/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    );
    expect(del.status).toBe(204);

    const list = await get("/api/v1/dotfiles/manifests?hostId=host-a");
    const manifests = (await list.json()) as unknown[];
    expect(manifests).toHaveLength(0);
  });
});

describe("dotfile uploads", () => {
  test("records checksum and size on upload", async () => {
    await postJson("/api/v1/dotfiles/manifests", {
      appName: "opencode",
      paths: ["~/.config/opencode"],
    });

    const form = new FormData();
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    form.append("tarball", new Blob([bytes]), "opencode.tar.gz");
    const upload = await app.handle(
      new Request("http://localhost/api/v1/dotfiles/opencode", {
        method: "POST",
        headers: authHeaders(),
        body: form,
      }),
    );
    expect(upload.status).toBe(201);
    const version = (await upload.json()) as {
      sizeBytes: number;
      checksum: string;
      description: string | null;
    };
    expect(version.sizeBytes).toBe(bytes.length);
    expect(version.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(version.description).toBeNull();
  });
});
