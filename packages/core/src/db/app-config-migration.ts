import type { Database } from "bun:sqlite";

// LAMA-316: deterministic, idempotent in-place migration from the legacy
// dotfile/profile/_global model to the application templates/protections/
// snapshots contract. Called at the end of initDb() for fresh AND existing
// databases (no-op when there is nothing legacy to convert). Legacy rows are
// left untouched; nothing here ever reads dotfile_versions (they do not carry
// captured paths and must NOT become canonical snapshots).

type LegacyProfileRow = {
  id: string;
  name: string;
  description: string | null;
  emoji: string | null;
  color: string | null;
  paths: string; // JSON { linux?: string[]; macos?: string[]; windows?: string[] }
  install_url: string | null;
  install_instructions: string | null;
  restore_instructions: string | null;
  created_at: number;
  updated_at: number;
};

type LegacyManifestRow = {
  id: string;
  host_id: string;
  app_name: string;
  paths: string; // JSON string[]
  excludes: string | null;
  schedule: string | null;
  instructions: string | null;
  profile_id: string | null;
};

type HostOsRow = { id: string; os: string | null };

export function convertLegacyAppConfig(db: Database): void {
  convertProfilesToTemplates(db);
  convertHostManifests(db);
  convertGlobalManifests(db);
}

type OsKey = "linux" | "macos" | "windows";

function osKeyFor(os: string | null | undefined): OsKey {
  switch ((os ?? "").toLowerCase()) {
    case "macos":
    case "darwin":
    case "mac":
    case "osx":
      return "macos";
    case "windows":
    case "win32":
    case "win64":
    case "win":
      return "windows";
    default:
      return "linux";
  }
}

function flatToSpecPath(paths: string[]): { path: string; classification: "unknown" }[] {
  return paths.map((path) => ({ path, classification: "unknown" as const }));
}

function now(): number {
  return Date.now();
}

/** Profile → template, keeping the SAME id so profile_id links stay valid. */
function convertProfilesToTemplates(db: Database): void {
  const rows = db.query<LegacyProfileRow, []>(`SELECT * FROM app_profiles`).all();
  const insertT = db.query(
    `INSERT INTO application_templates
       (id, name, origin, description, emoji, color, paths, install_url,
        install_instructions, restore_instructions, revision, created_at, updated_at)
     VALUES (?, ?, 'custom', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING`,
  );
  for (const p of rows) {
    let parsed: { linux?: string[]; macos?: string[]; windows?: string[] };
    try {
      parsed = JSON.parse(p.paths);
    } catch {
      parsed = {};
    }
    const spec = {
      paths: {
        linux: flatToSpecPath(parsed.linux ?? []),
        macos: flatToSpecPath(parsed.macos ?? []),
        windows: flatToSpecPath(parsed.windows ?? []),
      },
      excludes: [],
      notes: null,
    };
    insertT.run(
      p.id,
      p.name,
      p.description,
      p.emoji,
      p.color,
      JSON.stringify(spec),
      p.install_url,
      p.install_instructions,
      p.restore_instructions,
      p.created_at,
      p.updated_at,
    );
  }
}

function protectionExists(db: Database, hostId: string, templateId: string): boolean {
  return (
    db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM application_protections WHERE host_id = ? AND template_id = ?`,
      )
      .get(hostId, templateId) !== null
  );
}

/** Resolve the template for a manifest: the referenced profile if one exists,
 *  else a custom template named after the app (find-or-create). Idempotent —
 *  both branches resolve to a stable template id across re-runs. */
function templateForManifest(
  db: Database,
  manifest: LegacyManifestRow,
): { id: string; revision: number; name: string } {
  if (manifest.profile_id) {
    const byProfile = db
      .query<{ id: string; revision: number; name: string }, [string]>(
        `SELECT id, revision, name FROM application_templates WHERE id = ?`,
      )
      .get(manifest.profile_id);
    if (byProfile) return byProfile;
  }
  const existing = db
    .query<{ id: string; revision: number; name: string }, [string]>(
      `SELECT id, revision, name FROM application_templates WHERE name = ? AND origin = 'custom'`,
    )
    .get(manifest.app_name);
  if (existing) return existing;

  const flat = parseFlatPaths(manifest.paths);
  const spec = {
    paths: {
      linux: flatToSpecPath(flat),
      macos: flatToSpecPath(flat),
      windows: flatToSpecPath(flat),
    },
    excludes: parseExcludes(manifest.excludes),
    notes: manifest.instructions ?? null,
  };
  const id = crypto.randomUUID();
  const ts = now();
  db.run(
    `INSERT INTO application_templates
       (id, name, origin, description, emoji, color, paths, install_url,
        install_instructions, restore_instructions, revision, created_at, updated_at)
     VALUES (?, ?, 'custom', NULL, NULL, NULL, ?, NULL, NULL, NULL, 1, ?, ?)`,
    [id, manifest.app_name, JSON.stringify(spec), ts, ts],
  );
  return { id, revision: 1, name: manifest.app_name };
}

/** Build the protection capture spec from the legacy manifest's OWN flat
 *  paths placed in the host's OS bucket — preserves the effective config. */
function captureSpecForManifest(manifest: LegacyManifestRow, os: OsKey) {
  const flat = parseFlatPaths(manifest.paths);
  return {
    paths: { [os]: flatToSpecPath(flat) },
    excludes: parseExcludes(manifest.excludes),
    notes: manifest.instructions ?? null,
  };
}

function insertProtection(
  db: Database,
  templateId: string,
  templateRevision: number,
  hostId: string,
  name: string,
  schedule: string | null,
  captureSpec: unknown,
): void {
  const id = crypto.randomUUID();
  const ts = now();
  db.run(
    `INSERT INTO application_protections
       (id, template_id, template_revision, host_id, name, enabled, schedule,
        destination, capture_spec, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, 'server_archive', ?, ?, ?)`,
    [id, templateId, templateRevision, hostId, name, schedule, JSON.stringify(captureSpec), ts, ts],
  );
}

/** Host-specific manifests → explicit protections. */
function convertHostManifests(db: Database): void {
  const manifests = db
    .query<LegacyManifestRow, []>(
      `SELECT * FROM dotfile_manifests WHERE host_id != '_global' ORDER BY rowid`,
    )
    .all();
  for (const m of manifests) {
    const host = db
      .query<HostOsRow, [string]>(`SELECT id, os FROM hosts WHERE id = ?`)
      .get(m.host_id);
    if (!host) continue; // orphaned manifest for a deleted host — do not invent data
    const os = osKeyFor(host.os);
    const template = templateForManifest(db, m);
    if (protectionExists(db, m.host_id, template.id)) continue;
    insertProtection(
      db,
      template.id,
      template.revision,
      m.host_id,
      template.name,
      m.schedule,
      captureSpecForManifest(m, os),
    );
  }
}

/** Global manifests → one explicit protection per known host that would have
 *  inherited it, except where that host already has a host-specific manifest
 *  for the same app. */
function convertGlobalManifests(db: Database): void {
  const globals = db
    .query<LegacyManifestRow, []>(
      `SELECT * FROM dotfile_manifests WHERE host_id = '_global' ORDER BY rowid`,
    )
    .all();
  const hosts = db.query<HostOsRow, []>(`SELECT id, os FROM hosts ORDER BY rowid`).all();
  for (const g of globals) {
    for (const host of hosts) {
      const alreadyHostSpecific = db
        .query<{ id: string }, [string, string]>(
          `SELECT id FROM dotfile_manifests WHERE host_id = ? AND app_name = ? AND host_id != '_global'`,
        )
        .get(host.id, g.app_name);
      if (alreadyHostSpecific) continue;
      const os = osKeyFor(host.os);
      const template = templateForManifest(db, g);
      if (protectionExists(db, host.id, template.id)) continue;
      insertProtection(
        db,
        template.id,
        template.revision,
        host.id,
        template.name,
        g.schedule,
        captureSpecForManifest(g, os),
      );
    }
  }
}

function parseFlatPaths(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseExcludes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
