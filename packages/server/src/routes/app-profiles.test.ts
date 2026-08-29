import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "app-profiles-test-key";

const { getAuthPlugin } = await import("../auth.ts");
const { appProfilesRoutes, __setDb } = await import("./app-profiles.ts");
const { dotfilesRoutes, __setDb: __setDotfilesDb } = await import("./dotfiles.ts");
const { __setDb: __setConfigRevisionDb } = await import("../config-revision.ts");

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

const profileBody = {
  name: "Terminal setup",
  description: "Shell and editor settings",
  emoji: "🛠️",
  color: "#7c6cff",
  paths: { linux: ["~/.config/nvim", "~/.zshrc"], macos: ["~/.config/nvim"] },
  installUrl: "https://example.com/terminal",
  installInstructions: "Install the editor first.",
  restoreInstructions: "Restart the shell after restoring.",
};

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try { db.exec(migration); } catch { /* idempotent migrations */ }
  }
  __setDb(db);
  __setDotfilesDb(db);
  __setConfigRevisionDb(db);
  app = new Elysia().use(getAuthPlugin()).use(appProfilesRoutes).use(dotfilesRoutes);
});

afterEach(() => db.close());

describe("app profile routes (LAMA-291)", () => {
  test("creates and lists a reusable profile", async () => {
    const created = await app.handle(request("/api/v1/app-profiles", { method: "POST", body: JSON.stringify(profileBody) }));
    expect(created.status).toBe(201);
    const profile = await created.json() as Record<string, unknown>;
    expect(profile.name).toBe("Terminal setup");
    expect(profile.emoji).toBe("🛠️");
    expect(profile.paths).toEqual(profileBody.paths);

    const listed = await app.handle(request("/api/v1/app-profiles"));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([profile]);
  });

  test("rejects duplicate names and updates profile metadata", async () => {
    const first = await app.handle(request("/api/v1/app-profiles", { method: "POST", body: JSON.stringify(profileBody) }));
    const profile = await first.json() as { id: string };
    const duplicate = await app.handle(request("/api/v1/app-profiles", { method: "POST", body: JSON.stringify(profileBody) }));
    expect(duplicate.status).toBe(409);

    const updated = await app.handle(request(`/api/v1/app-profiles/${profile.id}`, { method: "PUT", body: JSON.stringify({ name: "Terminal setup v2", color: "#ff8a5b" }) }));
    expect(updated.status).toBe(200);
    const body = await updated.json() as Record<string, unknown>;
    expect(body.name).toBe("Terminal setup v2");
    expect(body.color).toBe("#ff8a5b");
  });

  test("deleting a profile preserves backups and clears their profile link", async () => {
    const created = await app.handle(request("/api/v1/app-profiles", { method: "POST", body: JSON.stringify(profileBody) }));
    const profile = await created.json() as { id: string };
    const manifestId = "manifest-1";
    db.run("INSERT INTO dotfile_manifests (id, host_id, app_name, paths, profile_id) VALUES (?, ?, ?, ?, ?)", [manifestId, "host-1", "Terminal setup", "[]", profile.id]);

    const deleted = await app.handle(request(`/api/v1/app-profiles/${profile.id}`, { method: "DELETE" }));
    expect(deleted.status).toBe(204);
    const manifest = db.query<{ profile_id: string | null }, [string]>("SELECT profile_id FROM dotfile_manifests WHERE id = ?").get(manifestId);
    expect(manifest?.profile_id).toBeNull();
    expect(db.query<{ id: string }, [string]>("SELECT id FROM app_profiles WHERE id = ?").get(profile.id)).toBeNull();
  });

  test("manifests can link to an existing profile but reject dangling links", async () => {
    const created = await app.handle(request("/api/v1/app-profiles", { method: "POST", body: JSON.stringify(profileBody) }));
    const profile = await created.json() as { id: string };
    const linked = await app.handle(request("/api/v1/dotfiles/manifests", {
      method: "POST",
      body: JSON.stringify({ appName: "Terminal setup", hostId: "host-1", paths: ["~/.zshrc"], profileId: profile.id }),
    }));
    expect(linked.status).toBe(201);
    const linkedBody = await linked.json() as { profileId: string | null };
    expect(linkedBody.profileId).toBe(profile.id);

    const dangling = await app.handle(request("/api/v1/dotfiles/manifests", {
      method: "POST",
      body: JSON.stringify({ appName: "Missing profile", hostId: "host-1", paths: ["~/.zshrc"], profileId: "missing" }),
    }));
    expect(dangling.status).toBe(400);
  });
});
