import { Elysia, t } from "elysia";
import { mkdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { db as defaultDb } from "../db.ts";
import type { Database } from "bun:sqlite";
import type {
  ApplicationProtection,
  ApplicationProtectionListItem,
  ApplicationSnapshot,
  ApplicationTemplate,
  CaptureSpec,
  CaptureSpecPath,
  PathClassification,
} from "@lamasync/core";
import { bumpConfigRevision } from "../config-revision.ts";
import { deviceMayAccessHost, principalOf, requireAdmin, requireHostAccess } from "../auth.ts";

const BACKUP_DIR = process.env.LAMASYNC_BACKUP_DIR || "/backups";
const MAX_BYTES = Number(process.env.LAMASYNC_APPS_MAX_BYTES || 512 * 1024 * 1024);
const GLOBAL_HOST_ID = "_global";

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

interface TemplateRow {
  id: string;
  name: string;
  origin: string;
  description: string | null;
  emoji: string | null;
  color: string | null;
  paths: string;
  install_url: string | null;
  install_instructions: string | null;
  restore_instructions: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
}

interface ProtectionRow {
  id: string;
  template_id: string;
  template_revision: number;
  host_id: string;
  name: string;
  enabled: number;
  schedule: string | null;
  destination: string;
  capture_spec: string;
  created_at: number;
  updated_at: number;
}

interface ProtectionListRow extends ProtectionRow {
  template_origin: string;
  template_name: string;
  template_emoji: string | null;
  template_color: string | null;
  latest_id: string | null;
  latest_created_at: number | null;
  latest_size_bytes: number | null;
  latest_integrity_status: string | null;
}

interface SnapshotRow {
  id: string;
  protection_id: string;
  template_id: string;
  template_revision: number;
  source_host_id: string;
  created_at: number;
  archive_path: string;
  archive_format: string;
  size_bytes: number | null;
  checksum_sha256: string | null;
  description: string | null;
  captured_spec: string;
  integrity_status: string;
}

function parseCaptureSpec(raw: string | null | undefined): CaptureSpec {
  if (!raw) return { paths: {}, excludes: [], notes: null };
  try {
    const v = JSON.parse(raw) as CaptureSpec;
    return {
      paths: v.paths ?? {},
      excludes: Array.isArray(v.excludes) ? v.excludes : [],
      notes: v.notes ?? null,
    };
  } catch {
    return { paths: {}, excludes: [], notes: null };
  }
}

/** Application capture paths must have a stable, host-independent base.
 * Relative paths would resolve against an implementation detail of the daemon
 * process; root would silently turn one app protection into a whole-host
 * archive. Windows drive paths are allowed for the Windows OS bucket. */
function archivePathForConfiguredPath(path: string): string | null {
  const segments = (raw: string): string[] | null => {
    const result = raw.replaceAll("\\", "/").split("/");
    if (result.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
    return result;
  };
  if (path.startsWith("~/")) {
    const rest = segments(path.slice(2));
    return rest ? `home/${rest.join("/")}` : null;
  }
  if (path.startsWith("/")) {
    const rest = segments(path.slice(1));
    return rest ? `absolute/${rest.join("/")}` : null;
  }
  const windows = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (windows) {
    const rest = segments(windows[2]!);
    return rest ? `windows/${windows[1]!.toLowerCase()}/${rest.join("/")}` : null;
  }
  return null;
}

function isSupportedCapturePath(path: string): boolean {
  return archivePathForConfiguredPath(path) !== null;
}

function normalizeCaptureSpec(input: unknown): CaptureSpec | null {
  // Accept either the CaptureSpec shape or a legacy string[] of raw paths.
  if (Array.isArray(input)) {
    const paths = input.filter((p): p is string => typeof p === "string");
    return {
      paths: {
        linux: paths.map((p) => ({ path: p, classification: "unknown" as const })),
        macos: [],
        windows: [],
      },
      excludes: [],
      notes: null,
    };
  }
  if (typeof input !== "object" || input === null) return null;
  const rec = input as Record<string, unknown>;
  const pathsRaw = rec.paths as Record<string, unknown> | undefined;
  if (pathsRaw === undefined || pathsRaw === null) {
    // A valid CaptureSpec always has a `paths` object (possibly empty).
    if (Object.keys(rec).length === 0) return { paths: {}, excludes: [], notes: null };
    return null;
  }
  const classifications = new Set<PathClassification>([
    "portable_config",
    "machine_state",
    "cache",
    "secrets",
    "custom",
    "unknown",
  ]);
  const bucket = (os: string): CaptureSpecPath[] | null => {
    const arr = pathsRaw[os];
    if (!Array.isArray(arr)) return [];
    const entries: CaptureSpecPath[] = [];
    const archivePaths = new Set<string>();
    for (const e of arr) {
      if (typeof e === "string") {
        const path = e.trim();
        if (!isSupportedCapturePath(path)) return null;
        const archivePath = archivePathForConfiguredPath(path);
        if (archivePath === null || archivePaths.has(archivePath)) return null;
        archivePaths.add(archivePath);
        entries.push({ path, classification: "unknown", rationale: null });
        continue;
      }
      if (typeof e === "object" && e !== null) {
        const o = e as Record<string, unknown>;
        if (typeof o.path !== "string" || !isSupportedCapturePath(o.path.trim())) return null;
        const path = o.path.trim();
        const archivePath = archivePathForConfiguredPath(path);
        if (archivePath === null || archivePaths.has(archivePath)) return null;
        archivePaths.add(archivePath);
        const classification =
          typeof o.classification === "string" ? o.classification : "unknown";
        if (!classifications.has(classification as PathClassification)) return null;
        const rationale = typeof o.rationale === "string" ? o.rationale : null;
        entries.push({ path, classification: classification as PathClassification, rationale });
        continue;
      }
      return null;
    }
    return entries;
  };
  const linux = bucket("linux");
  const macos = bucket("macos");
  const windows = bucket("windows");
  if (linux === null || macos === null || windows === null) return null;
  return {
    paths: { linux, macos, windows },
    excludes: Array.isArray(rec.excludes)
      ? rec.excludes.filter((e): e is string => typeof e === "string")
      : [],
    notes: typeof rec.notes === "string" ? rec.notes : null,
  };
}

type HostOsRow = { os: string | null };
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

/**
 * Freeze the single OS bucket and its archive mapping at upload time. A
 * protection is a cross-platform recipe; a snapshot is evidence of what one
 * host actually captured, so recording every candidate bucket is misleading.
 */
function captureSpecForSnapshot(protection: ProtectionRow): CaptureSpec | null {
  const host = activeDb
    .query<HostOsRow, [string]>(`SELECT os FROM hosts WHERE id = ?`)
    .get(protection.host_id);
  if (!host) return null;
  const spec = parseCaptureSpec(protection.capture_spec);
  const os = osKeyFor(host.os);
  const paths: CaptureSpecPath[] = [];
  for (const entry of spec.paths[os] ?? []) {
    const archivePath = archivePathForConfiguredPath(entry.path);
    if (archivePath === null) return null;
    paths.push({
      path: entry.path,
      classification: entry.classification,
      rationale: entry.rationale ?? null,
      archivePath,
    });
  }
  return { paths: { [os]: paths }, excludes: [...spec.excludes], notes: spec.notes };
}

function rowToTemplate(r: TemplateRow): ApplicationTemplate {
  return {
    id: r.id,
    name: r.name,
    origin: r.origin === "built_in" ? "built_in" : "custom",
    description: r.description,
    emoji: r.emoji,
    color: r.color,
    paths: parseCaptureSpec(r.paths),
    installUrl: r.install_url,
    installInstructions: r.install_instructions,
    restoreInstructions: r.restore_instructions,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToProtection(r: ProtectionRow): ApplicationProtection {
  return {
    id: r.id,
    templateId: r.template_id,
    templateRevision: r.template_revision,
    hostId: r.host_id,
    name: r.name,
    enabled: r.enabled === 1,
    schedule: r.schedule,
    destination: "server_archive",
    captureSpec: parseCaptureSpec(r.capture_spec),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToListItem(r: ProtectionListRow): ApplicationProtectionListItem {
  return {
    ...rowToProtection(r),
    templateOrigin: r.template_origin === "built_in" ? "built_in" : "custom",
    templateName: r.template_name,
    templateEmoji: r.template_emoji,
    templateColor: r.template_color,
    latestSnapshot:
      r.latest_id !== null
        ? {
            id: r.latest_id,
            createdAt: r.latest_created_at ?? 0,
            sizeBytes: r.latest_size_bytes,
            integrityStatus: r.latest_integrity_status ?? "unverified",
          }
        : null,
  };
}

function rowToSnapshot(r: SnapshotRow): ApplicationSnapshot {
  return {
    id: r.id,
    protectionId: r.protection_id,
    templateId: r.template_id,
    templateRevision: r.template_revision,
    sourceHostId: r.source_host_id,
    createdAt: r.created_at,
    archivePath: r.archive_path,
    archiveFormat: "tar.gz",
    sizeBytes: r.size_bytes,
    checksumSha256: r.checksum_sha256,
    description: r.description,
    capturedSpec: parseCaptureSpec(r.captured_spec),
    integrityStatus: r.integrity_status as ApplicationSnapshot["integrityStatus"],
  };
}

async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const templateBody = t.Object({
  name: t.String(),
  origin: t.Optional(t.Union([t.Literal("built_in"), t.Literal("custom")])),
  description: t.Optional(t.Union([t.String(), t.Null()])),
  emoji: t.Optional(t.Union([t.String(), t.Null()])),
  color: t.Optional(t.Union([t.String(), t.Null()])),
  paths: t.Any(),
  installUrl: t.Optional(t.Union([t.String(), t.Null()])),
  installInstructions: t.Optional(t.Union([t.String(), t.Null()])),
  restoreInstructions: t.Optional(t.Union([t.String(), t.Null()])),
});

export const appsRoutes = new Elysia({ prefix: "/api/v1" })
  // ---------------------------------------------------------------------------
  // Templates (operator-owned recipes; admin/control-plane only).
  // ---------------------------------------------------------------------------
  .get(
    "/apps/templates",
    ({ set, store }) => {
      if (!requireAdmin({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const rows = activeDb
        .query<TemplateRow, []>(
          `SELECT id, name, origin, description, emoji, color, paths, install_url,
                  install_instructions, restore_instructions, revision, created_at, updated_at
             FROM application_templates ORDER BY name`,
        )
        .all();
      return rows.map(rowToTemplate);
    },
    { detail: { summary: "List app templates", tags: ["Apps"], responses: { 200: { description: "Template list" } } } },
  )
  .post(
    "/apps/templates",
    ({ body, set, store }) => {
      if (!requireAdmin({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const spec = normalizeCaptureSpec(body.paths);
      if (!spec) {
        set.status = 400;
        return { error: "Invalid paths: expected a capture spec or string[]" };
      }
      const id = crypto.randomUUID();
      const ts = Date.now();
      try {
        activeDb.run(
          `INSERT INTO application_templates
             (id, name, origin, description, emoji, color, paths, install_url,
              install_instructions, restore_instructions, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [
            id,
            body.name,
            body.origin ?? "custom",
            body.description ?? null,
            body.emoji ?? null,
            body.color ?? null,
            JSON.stringify(spec),
            body.installUrl ?? null,
            body.installInstructions ?? null,
            body.restoreInstructions ?? null,
            ts,
            ts,
          ],
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set.status = 409;
        return { error: `Failed to create template: ${message}` };
      }
      const row = activeDb
        .query<TemplateRow, [string]>(
          `SELECT id, name, origin, description, emoji, color, paths, install_url,
                  install_instructions, restore_instructions, revision, created_at, updated_at
             FROM application_templates WHERE id = ?`,
        )
        .get(id);
      set.status = 201;
      return rowToTemplate(row!);
    },
    { body: templateBody, detail: { summary: "Create app template", tags: ["Apps"] } },
  )
  .get(
    "/apps/templates/:id",
    ({ params, set, store }) => {
      if (!requireAdmin({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const row = activeDb
        .query<TemplateRow, [string]>(
          `SELECT id, name, origin, description, emoji, color, paths, install_url,
                  install_instructions, restore_instructions, revision, created_at, updated_at
             FROM application_templates WHERE id = ?`,
        )
        .get(params.id);
      if (!row) {
        set.status = 404;
        return { error: "Template not found" };
      }
      return rowToTemplate(row);
    },
    { detail: { summary: "Get app template", tags: ["Apps"] } },
  )
  .put(
    "/apps/templates/:id",
    ({ body, params, set, store }) => {
      if (!requireAdmin({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const existing = activeDb
        .query<TemplateRow, [string]>(`SELECT * FROM application_templates WHERE id = ?`)
        .get(params.id);
      if (!existing) {
        set.status = 404;
        return { error: "Template not found" };
      }
      const assignments: string[] = [];
      const bindings: (string | number | null)[] = [];
      const push = (col: string, val: string | number | null) => {
        assignments.push(`${col} = ?`);
        bindings.push(val);
      };
      if (typeof body.name === "string") push("name", body.name);
      if (body.origin !== undefined) push("origin", body.origin);
      if (body.description !== undefined) push("description", body.description);
      if (body.emoji !== undefined) push("emoji", body.emoji);
      if (body.color !== undefined) push("color", body.color);
      if (body.paths !== undefined) {
        const spec = normalizeCaptureSpec(body.paths);
        if (!spec) {
          set.status = 400;
          return { error: "Invalid paths: expected a capture spec or string[]" };
        }
        push("paths", JSON.stringify(spec));
      }
      if (body.installUrl !== undefined) push("install_url", body.installUrl);
      if (body.installInstructions !== undefined) push("install_instructions", body.installInstructions);
      if (body.restoreInstructions !== undefined) push("restore_instructions", body.restoreInstructions);
      assignments.push("revision = revision + 1", "updated_at = ?");
      bindings.push(Date.now(), params.id);
      try {
        activeDb.run(
          `UPDATE application_templates SET ${assignments.join(", ")} WHERE id = ?`,
          bindings,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set.status = 409;
        return { error: `Failed to update template: ${message}` };
      }
      const row = activeDb
        .query<TemplateRow, [string]>(
          `SELECT id, name, origin, description, emoji, color, paths, install_url,
                  install_instructions, restore_instructions, revision, created_at, updated_at
             FROM application_templates WHERE id = ?`,
        )
        .get(params.id);
      return rowToTemplate(row!);
    },
    { body: t.Partial(templateBody), detail: { summary: "Update app template", tags: ["Apps"] } },
  )
  .delete(
    "/apps/templates/:id",
    ({ params, set, store }) => {
      if (!requireAdmin({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const existing = activeDb
        .query<TemplateRow, [string]>(`SELECT id FROM application_templates WHERE id = ?`)
        .get(params.id);
      if (!existing) {
        set.status = 404;
        return { error: "Template not found" };
      }
      const protections = activeDb
        .query<{ id: string }, [string]>(
          `SELECT id FROM application_protections WHERE template_id = ?`,
        )
        .get(params.id);
      if (protections) {
        set.status = 409;
        return { error: "Template has active protections; delete those first" };
      }
      activeDb.run(`DELETE FROM application_templates WHERE id = ?`, [params.id]);
      set.status = 204;
      return undefined;
    },
    { detail: { summary: "Delete app template", tags: ["Apps"] } },
  )

  // ---------------------------------------------------------------------------
  // Protections (explicit binding on exactly one host).
  // ---------------------------------------------------------------------------
  .get(
    "/apps/protections",
    ({ query, set, store }) => {
      const principal = requireHostAccess(store, query.hostId);
      if (!principal) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const sql = `
        SELECT p.*, t.origin AS template_origin, t.name AS template_name,
               t.emoji AS template_emoji, t.color AS template_color,
               (SELECT s.id            FROM application_snapshots s WHERE s.protection_id = p.id ORDER BY s.created_at DESC LIMIT 1) AS latest_id,
               (SELECT s.created_at    FROM application_snapshots s WHERE s.protection_id = p.id ORDER BY s.created_at DESC LIMIT 1) AS latest_created_at,
               (SELECT s.size_bytes    FROM application_snapshots s WHERE s.protection_id = p.id ORDER BY s.created_at DESC LIMIT 1) AS latest_size_bytes,
               (SELECT s.integrity_status FROM application_snapshots s WHERE s.protection_id = p.id ORDER BY s.created_at DESC LIMIT 1) AS latest_integrity_status
          FROM application_protections p
          JOIN application_templates t ON t.id = p.template_id
          ${query.hostId ? "WHERE p.host_id = ?" : ""}
          ORDER BY p.created_at ASC`;
      const rows = query.hostId
        ? activeDb.query<ProtectionListRow, [string]>(sql).all(query.hostId)
        : activeDb.query<ProtectionListRow, []>(sql).all();
      return rows.map(rowToListItem);
    },
    {
      query: t.Object({ hostId: t.Optional(t.String()) }),
      detail: { summary: "List app protections", tags: ["Apps"] },
    },
  )
  .post(
    "/apps/protections",
    ({ body, set, store }) => {
      if (!requireAdmin({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (body.hostId === GLOBAL_HOST_ID) {
        set.status = 400;
        return { error: "Protections must be bound to a real host, not _global" };
      }
      const template = activeDb
        .query<TemplateRow, [string]>(`SELECT * FROM application_templates WHERE id = ?`)
        .get(body.templateId);
      if (!template) {
        set.status = 404;
        return { error: "Template not found" };
      }
      const host = activeDb
        .query<{ id: string; os: string | null }, [string]>(`SELECT id, os FROM hosts WHERE id = ?`)
        .get(body.hostId);
      if (!host) {
        set.status = 404;
        return { error: "Host not found" };
      }
      const dup = activeDb
        .query<{ id: string }, [string, string]>(
          `SELECT id FROM application_protections WHERE host_id = ? AND template_id = ?`,
        )
        .get(body.hostId, body.templateId);
      if (dup) {
        set.status = 409;
        return { error: "A protection already exists for this host and template" };
      }
      const id = crypto.randomUUID();
      const ts = Date.now();
      const name = body.name ?? template.name;
      const captureSpec = parseCaptureSpec(template.paths);
      const hostPaths = captureSpec.paths[osKeyFor(host.os)] ?? [];
      if (hostPaths.length === 0) {
        set.status = 409;
        return { error: `Template has no capture paths for this host's ${osKeyFor(host.os)} OS` };
      }
      activeDb.run(
        `INSERT INTO application_protections
           (id, template_id, template_revision, host_id, name, enabled, schedule,
            destination, capture_spec, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, 'server_archive', ?, ?, ?)`,
        [
          id,
          template.id,
          template.revision,
          body.hostId,
          name,
          body.schedule ?? null,
          JSON.stringify(captureSpec),
          ts,
          ts,
        ],
      );
      bumpConfigRevision([body.hostId]);
      const row = activeDb
        .query<ProtectionRow, [string]>(`SELECT * FROM application_protections WHERE id = ?`)
        .get(id);
      set.status = 201;
      return rowToProtection(row!);
    },
    {
      body: t.Object({
        templateId: t.String(),
        hostId: t.String(),
        schedule: t.Optional(t.Union([t.String(), t.Null()])),
        name: t.Optional(t.String()),
      }),
      detail: { summary: "Enroll an app protection", tags: ["Apps"] },
    },
  )
  .get(
    "/apps/protections/:id",
    ({ params, set, store }) => {
      const row = activeDb
        .query<ProtectionRow, [string]>(`SELECT * FROM application_protections WHERE id = ?`)
        .get(params.id);
      if (!row) {
        set.status = 404;
        return { error: "Protection not found" };
      }
      const principal = principalOf(store);
      if (!deviceMayAccessHost(principal, row.host_id)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      return rowToProtection(row);
    },
    { detail: { summary: "Get app protection", tags: ["Apps"] } },
  )
  .put(
    "/apps/protections/:id",
    ({ body, params, set, store }) => {
      if (!requireAdmin({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const existing = activeDb
        .query<ProtectionRow, [string]>(`SELECT * FROM application_protections WHERE id = ?`)
        .get(params.id);
      if (!existing) {
        set.status = 404;
        return { error: "Protection not found" };
      }
      const assignments: string[] = [];
      const bindings: (string | number | null)[] = [];
      const push = (col: string, val: string | number | null) => {
        assignments.push(`${col} = ?`);
        bindings.push(val);
      };
      if (body.name !== undefined) push("name", body.name);
      if (body.enabled !== undefined) push("enabled", body.enabled ? 1 : 0);
      if (body.schedule !== undefined) push("schedule", body.schedule);
      if (body.destination !== undefined) push("destination", body.destination);
      assignments.push("updated_at = ?");
      bindings.push(Date.now(), params.id);
      activeDb.run(
        `UPDATE application_protections SET ${assignments.join(", ")} WHERE id = ?`,
        bindings,
      );
      bumpConfigRevision([existing.host_id]);
      const row = activeDb
        .query<ProtectionRow, [string]>(`SELECT * FROM application_protections WHERE id = ?`)
        .get(params.id);
      return rowToProtection(row!);
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        enabled: t.Optional(t.Boolean()),
        schedule: t.Optional(t.Union([t.String(), t.Null()])),
        destination: t.Optional(t.Literal("server_archive")),
      }),
      detail: { summary: "Update app protection", tags: ["Apps"] },
    },
  )
  .delete(
    "/apps/protections/:id",
    ({ params, set, store }) => {
      if (!requireAdmin({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const existing = activeDb
        .query<ProtectionRow, [string]>(`SELECT * FROM application_protections WHERE id = ?`)
        .get(params.id);
      if (!existing) {
        set.status = 404;
        return { error: "Protection not found" };
      }
      const snapshot = activeDb
        .query<{ id: string }, [string]>(
          `SELECT id FROM application_snapshots WHERE protection_id = ? LIMIT 1`,
        )
        .get(params.id);
      if (snapshot) {
        // Snapshot history is immutable. SQLite foreign-key enforcement is
        // connection-configurable, so the API owns this invariant rather
        // than allowing an environment-dependent orphaned history.
        set.status = 409;
        return { error: "Protection has snapshots; disable it to stop capture and retain its history" };
      }
      // A protection without history may be removed. Disable is the normal
      // lifecycle operation once a capture has succeeded.
      activeDb.run(`DELETE FROM application_protections WHERE id = ?`, [params.id]);
      bumpConfigRevision([existing.host_id]);
      set.status = 204;
      return undefined;
    },
    { detail: { summary: "Delete app protection", tags: ["Apps"] } },
  )

  // ---------------------------------------------------------------------------
  // Snapshots (immutable archive metadata under a protection).
  // ---------------------------------------------------------------------------
  .get(
    "/apps/protections/:id/snapshots",
    ({ params, set, store }) => {
      const protection = activeDb
        .query<ProtectionRow, [string]>(`SELECT * FROM application_protections WHERE id = ?`)
        .get(params.id);
      if (!protection) {
        set.status = 404;
        return { error: "Protection not found" };
      }
      const principal = principalOf(store);
      if (!deviceMayAccessHost(principal, protection.host_id)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const rows = activeDb
        .query<SnapshotRow, [string]>(
          `SELECT * FROM application_snapshots WHERE protection_id = ? ORDER BY created_at DESC`,
        )
        .all(params.id);
      return rows.map(rowToSnapshot);
    },
    { detail: { summary: "List app snapshots", tags: ["Apps"] } },
  )
  .post(
    "/apps/protections/:id/snapshots",
    async ({ params, request, set, store }) => {
      const protection = activeDb
        .query<ProtectionRow, [string]>(`SELECT * FROM application_protections WHERE id = ?`)
        .get(params.id);
      if (!protection) {
        set.status = 404;
        return { error: "Protection not found" };
      }
      const principal = principalOf(store);
      if (!deviceMayAccessHost(principal, protection.host_id)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      if (protection.enabled !== 1) {
        set.status = 409;
        return { error: "Protection is disabled" };
      }
      const capturedSpec = captureSpecForSnapshot(protection);
      if (!capturedSpec) {
        set.status = 409;
        return { error: "Protection capture spec is invalid or its host no longer exists" };
      }
      const form = await request.formData();
      const file = form.get("tarball");
      if (!(file instanceof File)) {
        set.status = 400;
        return { error: "Missing 'tarball' field in multipart body" };
      }
      if (file.size > MAX_BYTES) {
        set.status = 413;
        return { error: `Snapshot too large; limit is ${MAX_BYTES} bytes` };
      }
      const descriptionRaw = form.get("description");
      const description =
        typeof descriptionRaw === "string" && descriptionRaw.length > 0 ? descriptionRaw : null;

      const protectionDir = join(BACKUP_DIR, "apps", protection.id);
      mkdirSync(protectionDir, { recursive: true });
      const timestamp = Date.now();
      // Timestamps are metadata, not a collision-safe archive identity:
      // concurrent retries can share one millisecond. Keep every snapshot in
      // a unique file so one upload cannot silently replace another.
      const filename = `${timestamp}-${crypto.randomUUID()}.tar.gz`;
      const fullPath = join(protectionDir, filename);
      const relPath = join("apps", protection.id, filename);

      const buf = Buffer.from(await file.arrayBuffer());
      await Bun.write(fullPath, buf);
      const checksum = await sha256Hex(file);

      const id = crypto.randomUUID();
      try {
        activeDb.transaction(() => {
          activeDb.run(
            `INSERT INTO application_snapshots
               (id, protection_id, template_id, template_revision, source_host_id, created_at,
                archive_path, archive_format, size_bytes, checksum_sha256, description,
                captured_spec, integrity_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'tar.gz', ?, ?, ?, ?, 'verified')`,
            [
              id,
              protection.id,
              protection.template_id,
              protection.template_revision,
              principal?.kind === "device" ? principal.hostId : protection.host_id,
              timestamp,
              relPath,
              buf.length,
              checksum,
              description,
              JSON.stringify(capturedSpec), // server-side exact capture record
            ],
          );
        })();
      } catch {
        try {
          unlinkSync(fullPath);
        } catch {
          /* best-effort */
        }
        set.status = 500;
        return { error: "Failed to record snapshot" };
      }

      const row = activeDb
        .query<SnapshotRow, [string]>(`SELECT * FROM application_snapshots WHERE id = ?`)
        .get(id);
      set.status = 201;
      return rowToSnapshot(row!);
    },
    { detail: { summary: "Upload an app snapshot", tags: ["Apps"] } },
  )
  .get(
    "/apps/snapshots/:id",
    ({ params, set, store }) => {
      const row = activeDb
        .query<SnapshotRow, [string]>(`SELECT * FROM application_snapshots WHERE id = ?`)
        .get(params.id);
      if (!row) {
        set.status = 404;
        return { error: "Snapshot not found" };
      }
      const principal = principalOf(store);
      if (!deviceMayAccessHost(principal, row.source_host_id)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      return rowToSnapshot(row);
    },
    { detail: { summary: "Get app snapshot", tags: ["Apps"] } },
  )
  .get(
    "/apps/snapshots/:id/download",
    async ({ params, set, store }) => {
      const row = activeDb
        .query<SnapshotRow, [string]>(`SELECT * FROM application_snapshots WHERE id = ?`)
        .get(params.id);
      if (!row) {
        set.status = 404;
        return { error: "Snapshot not found" };
      }
      const principal = principalOf(store);
      if (!deviceMayAccessHost(principal, row.source_host_id)) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const fullPath = join(BACKUP_DIR, row.archive_path);
      if (!existsSync(fullPath)) {
        set.status = 404;
        return { error: "Snapshot archive not found" };
      }
      set.headers["Content-Type"] = "application/gzip";
      const st = Bun.file(fullPath);
      return new Response(st);
    },
    { detail: { summary: "Download app snapshot", tags: ["Apps"] } },
  )
  .delete(
    "/apps/snapshots/:id",
    ({ params, set, store }) => {
      if (!requireAdmin({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const row = activeDb
        .query<SnapshotRow, [string]>(`SELECT * FROM application_snapshots WHERE id = ?`)
        .get(params.id);
      if (!row) {
        set.status = 404;
        return { error: "Snapshot not found" };
      }
      activeDb.run(`DELETE FROM application_snapshots WHERE id = ?`, [params.id]);
      try {
        unlinkSync(join(BACKUP_DIR, row.archive_path));
      } catch {
        /* best-effort */
      }
      set.status = 204;
      return undefined;
    },
    { detail: { summary: "Delete app snapshot", tags: ["Apps"] } },
  );
