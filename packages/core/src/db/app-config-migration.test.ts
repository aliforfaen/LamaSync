import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SERVER_SCHEMA, MIGRATIONS } from "./schema.ts";
import { convertLegacyAppConfig } from "./app-config-migration.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch {
      /* idempotent */
    }
  }
  return db;
}

function seedLegacy(db: Database): void {
  const now = Date.now();
  db.run(`INSERT INTO hosts (id, hostname, os) VALUES ('host-a', 'alpha', 'linux'), ('host-b', 'beta', 'macos')`);
  // One reusable profile.
  db.run(
    `INSERT INTO app_profiles (id, name, paths, created_at, updated_at)
     VALUES ('prof-vscode', 'VS Code', ?, ?, ?)`,
    [
      JSON.stringify({
        linux: ["~/.config/Code/User"],
        macos: ["~/Library/Application Support/Code/User"],
      }),
      now,
      now,
    ],
  );
  // Host-specific manifest referencing the profile (host A).
  db.run(
    `INSERT INTO dotfile_manifests (id, host_id, app_name, paths, excludes, schedule, instructions, profile_id)
     VALUES ('man-vscode', 'host-a', 'vscode', ?, '["cache"]', '0 3 * * *', 'restore manually', 'prof-vscode')`,
    [JSON.stringify(["~/.config/Code/User/settings.json"])],
  );
  // Host-specific manifest WITHOUT a profile (host A) — must become a custom
  // template named after the app.
  db.run(
    `INSERT INTO dotfile_manifests (id, host_id, app_name, paths)
     VALUES ('man-nvim-host', 'host-a', 'nvim', ?)`,
    [JSON.stringify(["~/.config/nvim"])],
  );
  // Global manifest for nvim that host B inherits (host B has no host-specific
  // nvim); host A DOES have a host-specific nvim so it must NOT inherit this.
  db.run(
    `INSERT INTO dotfile_manifests (id, host_id, app_name, paths, schedule, instructions)
     VALUES ('man-nvim-global', '_global', 'nvim', ?, '@reboot', 'restore via nvim')`,
    [JSON.stringify(["~/.config/nvim"])],
  );
}

function counts(db: Database) {
  const t = db.query(`SELECT count(*) AS n FROM application_templates`).get() as { n: number };
  const p = db.query(`SELECT count(*) AS n FROM application_protections`).get() as { n: number };
  const s = db.query(`SELECT count(*) AS n FROM application_snapshots`).get() as { n: number };
  return { templates: t.n, protections: p.n, snapshots: s.n };
}

describe("convertLegacyAppConfig (LAMA-316)", () => {
  test("profile becomes a template with the same id and classified paths", () => {
    const db = makeDb();
    seedLegacy(db);
    convertLegacyAppConfig(db);
    const t = db
      .query<{ id: string; origin: string; paths: string; revision: number }, []>(
        `SELECT id, origin, paths, revision FROM application_templates WHERE id = 'prof-vscode'`,
      )
      .get()!;
    expect(t.origin).toBe("custom");
    expect(t.revision).toBe(1);
    const paths = JSON.parse(t.paths) as {
      paths: { linux: { path: string; classification: string }[] };
    };
    expect(paths.paths.linux).toEqual([
      { path: "~/.config/Code/User", classification: "unknown" },
    ]);
  });

  test("profile-linked host manifest creates a protection copying its own paths", () => {
    const db = makeDb();
    seedLegacy(db);
    convertLegacyAppConfig(db);
    const p = db
      .query<{ template_id: string; template_revision: number; enabled: number; schedule: string; capture_spec: string }, []>(
        `SELECT template_id, template_revision, enabled, schedule, capture_spec
         FROM application_protections WHERE host_id = 'host-a' AND name = 'VS Code'`,
      )
      .get()!;
    expect(p.template_id).toBe("prof-vscode");
    expect(p.template_revision).toBe(1);
    expect(p.enabled).toBe(1);
    expect(p.schedule).toBe("0 3 * * *");
    const spec = JSON.parse(p.capture_spec) as {
      paths: { linux: { path: string; classification: string }[] };
      excludes: string[];
      notes: string | null;
    };
    expect(spec.paths.linux).toEqual([
      { path: "~/.config/Code/User/settings.json", classification: "unknown" },
    ]);
    expect(spec.excludes).toEqual(["cache"]);
    expect(spec.notes).toBe("restore manually");
  });

  test("global manifest yields per-host protections; hosts with a host-specific manifest are skipped", () => {
    const db = makeDb();
    seedLegacy(db);
    convertLegacyAppConfig(db);
    // host-b inherits the nvim global protection as a custom 'nvim' template.
    const nvimB = db
      .query<{ name: string; capture_spec: string }, []>(
        `SELECT name, capture_spec FROM application_protections WHERE host_id = 'host-b'`,
      )
      .get()!;
    expect(nvimB.name).toBe("nvim");
    const specB = JSON.parse(nvimB.capture_spec) as { paths: { macos: unknown } };
    expect(Array.isArray(specB.paths.macos)).toBe(true);
    // host-a has a host-specific nvim → exactly one nvim protection, and NOT
    // the global one (global would have a different template id).
    const nvimA = db
      .query<{ id: string }, []>(
        `SELECT id FROM application_protections WHERE host_id = 'host-a' AND name = 'nvim'`,
      )
      .all();
    expect(nvimA.length).toBe(1);
  });

  test("idempotent: running twice yields identical row counts", () => {
    const db = makeDb();
    seedLegacy(db);
    convertLegacyAppConfig(db);
    const first = counts(db);
    expect(first.snapshots).toBe(0);
    convertLegacyAppConfig(db);
    const second = counts(db);
    expect(second).toEqual(first);
  });

  test("never fabricates snapshots from legacy versions", () => {
    const db = makeDb();
    seedLegacy(db);
    db.run(
      `INSERT INTO dotfile_versions (id, manifest_id, timestamp, tarball_path)
       VALUES ('ver-1', 'man-vscode', 1, 'dotfiles/vscode/1.tar.gz')`,
      [],
    );
    convertLegacyAppConfig(db);
    expect(counts(db).snapshots).toBe(0);
  });
});
