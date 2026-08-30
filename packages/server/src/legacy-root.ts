// LAMA-294: handling for orphaned legacy shared backup data.
//
// Before LAMA-294 ordinary backups wrote directly under the folder's
// destination root, e.g. `bucket/<folder-name>/…`. After it, backups are
// host-scoped to `bucket/<folder-name>/<host-id>/…`. The old shared contents
// therefore sit as *top-level* children of `<folder-name>/` that are NOT a
// known host prefix. This module reports those orphaned entries (dry-run by
// default) and can prune them on explicit demand — but it NEVER deletes a
// host-scoped prefix or the legacy root itself, so new per-host backups are
// always protected.
//
// Only `backup` folders with an S3 or local/nfs backend are handled. Restic
// repositories are already per-host-tagged snapshots (not a directory tree),
// and sync/mount destinations are shared by design (unchanged), so neither is
// affected.

import type { Database } from "bun:sqlite";
import { normalizeDestination } from "@lamasync/core";
import type { Folder } from "@lamasync/core";
import { buildRcloneConfig } from "./browse-rclone.ts";
import { withTempRcloneConfig } from "./temp-rclone-config.ts";
import { resolveFolderLocalConfig, resolveFolderS3Config } from "./backends.ts";

export interface LegacyRootPlan {
  folderId: string;
  folderName: string;
  backendKind: "s3" | "local";
  /** rclone section name in the generated config (no secrets). */
  sectionName: string;
  /** Path under the section remote for the legacy root. */
  remotePath: string;
  /** Top-level child names that are live host-scoped prefixes (kept). */
  hostPrefixes: string[];
  /** Top-level children used by an explicit destination (also kept). */
  protectedChildren: string[];
  /** True when an assignment writes directly to the legacy root. */
  protectAllChildren: boolean;
}

/** Normalize a path: strip leading/trailing slashes, collapse doubles. */
function cleanPath(path: string): string {
  return path.replace(/\/+/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Compute the legacy-root plan for every remote-backed backup folder. Pure
 * (DB reads + path math only) — no secrets, no rclone. Skip folders without a
 * resolvable remote or without assignments.
 */
export function buildLegacyRootPlans(db: Database): LegacyRootPlan[] {
  const folders = db
    .query<{ id: string; name: string; type: string; backend: string | null; backend_id: string | null; s3_bucket: string | null }, []>(
      `SELECT id, name, type, backend, backend_id, s3_bucket
       FROM folders WHERE type = 'backup'`,
    )
    .all();

  const plans: LegacyRootPlan[] = [];
  for (const f of folders) {
    const backendKind = f.backend ?? "sftp";
    const sectionName = `legacy-${f.id}`;

    let remotePath: string;
    if (backendKind === "s3") {
      const bucket = (f.s3_bucket ?? "").trim();
      if (!bucket) continue;
      remotePath = cleanPath(`${bucket}/${f.name}`);
    } else if (backendKind === "local" || backendKind === "nfs") {
      if (!f.backend_id) continue;
      const backend = db
        .query<{ local_path: string | null }, [string]>(
          "SELECT local_path FROM backends WHERE id = ?",
        )
        .get(f.backend_id);
      const localPath = (backend?.local_path ?? "").trim();
      if (!localPath) continue;
      remotePath = `${localPath.replace(/\/+$/, "")}/${f.name}`;
    } else {
      // sftp / unknown: not handled (no lightweight directory browse).
      continue;
    }

    const assignments = db
      .query<{ host_id: string; destination: string | null }, [string]>(
        "SELECT host_id, destination FROM folder_assignments WHERE folder_id = ?",
      )
      .all(f.id);
    const hostPrefixes = assignments.map((a) => a.host_id).filter(Boolean);
    if (hostPrefixes.length === 0) continue;

    const normalizedFolderName = normalizeDestination(f.name);
    const protectedChildren = new Set<string>();
    let protectAllChildren = false;
    for (const assignment of assignments) {
      const destination = normalizeDestination(
        assignment.destination ?? `${f.name}/${assignment.host_id}`,
      );
      // If an existing row contains a malformed destination, the safe choice
      // is to skip deletion for this root rather than guess which data is live.
      if (destination === null || normalizedFolderName === null) {
        protectAllChildren = true;
        continue;
      }
      if (destination === normalizedFolderName) {
        protectAllChildren = true;
        continue;
      }
      const prefix = `${normalizedFolderName}/`;
      if (destination.startsWith(prefix)) {
        const child = destination.slice(prefix.length).split("/")[0];
        if (child) protectedChildren.add(child);
      }
    }

    plans.push({
      folderId: f.id,
      folderName: f.name,
      // nfs uses the same local rclone section as `local`.
      backendKind: backendKind === "s3" ? "s3" : "local",
      sectionName,
      remotePath,
      hostPrefixes,
      protectedChildren: Array.from(protectedChildren),
      protectAllChildren,
    });
  }
  return plans;
}

/** Build the per-plan rclone config body (loads secrets) or null when the
 *  backend can't be fully resolved. Never logged. */
function configBodyForPlan(plan: LegacyRootPlan, db: Database, folder: Folder): string | null {
  if (plan.backendKind === "s3") {
    const s3 = resolveFolderS3Config(db, folder);
    if (!s3) return null;
    return buildRcloneConfig({
      src: {
        name: plan.sectionName,
        folder,
        endpoint: s3.endpoint,
        provider: s3.provider === "aws" ? "aws" : "other",
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
        region: s3.region,
        bucket: s3.bucket,
      },
      dst: null,
    });
  }
  // local / nfs
  return buildRcloneConfig({ src: { name: plan.sectionName }, dst: null });
}

function loadFolder(db: Database, folderId: string): Folder | null {
  const r = db
    .query<{ id: string; name: string; type: string; backend: string | null; backend_id: string | null; s3_bucket: string | null }, [string]>(
      "SELECT id, name, type, backend, backend_id, s3_bucket FROM folders WHERE id = ?",
    )
    .get(folderId);
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    type: r.type as Folder["type"],
    backend: (r.backend ?? "sftp") as Folder["backend"],
    backendId: r.backend_id,
    s3Bucket: r.s3_bucket,
  };
}

async function runRclone(argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/** Convert one `rclone lsf` entry into a child name without its dir marker. */
export function normalizeLegacyChildName(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** List the immediate children (names) of a remote path; null when the path
 *  doesn't exist. */
async function listChildren(plan: LegacyRootPlan, configPath: string): Promise<string[] | null> {
  // `lsf` is non-recursive: it lists the immediate children of the path.
  const lsf = ["rclone", "lsf", `${plan.sectionName}:${plan.remotePath}`, "--config", configPath];
  const { stdout, code } = await runRclone(lsf);
  if (code !== 0) return null; // DirNotFound or other: no legacy root
  // `rclone lsf` marks directories with a trailing slash. Remove that marker
  // before comparing against host IDs or constructing a purge target; without
  // this, every live host prefix looks orphaned to the cleanup command.
  return stdout
    .split(/\r?\n/)
    .map(normalizeLegacyChildName)
    .filter(Boolean);
}

/** `rclone size --json` on a single path; returns null when missing. */
async function remoteSize(plan: LegacyRootPlan, subPath: string, configPath: string): Promise<{ count: number; bytes: number } | null> {
  const target = subPath ? `${plan.remotePath}/${subPath}` : plan.remotePath;
  const argv = ["rclone", "size", "--json", `${plan.sectionName}:${target}`, "--config", configPath];
  const { stdout, code } = await runRclone(argv);
  if (code !== 0) return null;
  try {
    const j = JSON.parse(stdout) as { count?: unknown; bytes?: unknown };
    return {
      count: typeof j.count === "number" ? j.count : 0,
      bytes: typeof j.bytes === "number" ? j.bytes : 0,
    };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

export interface OrphanEntry {
  folderId: string;
  folderName: string;
  remotePath: string;
  name: string;
  sizeBytes: number;
  itemCount: number;
  isHostPrefix: boolean;
  isProtected: boolean;
}

export interface LegacyRootReport {
  folderId: string;
  folderName: string;
  remotePath: string;
  orphaned: OrphanEntry[];
  orphanedBytes: number;
}

/**
 * Report orphaned top-level legacy children. Never mutates remote state.
 * Children that are a known host-scoped prefix are reported as kept but never
 * deleted; everything else under the legacy root is flagged orphaned.
 */
export async function reportLegacyRoots(db: Database): Promise<LegacyRootReport[]> {
  const reports: LegacyRootReport[] = [];
  for (const plan of buildLegacyRootPlans(db)) {
    const folder = loadFolder(db, plan.folderId);
    if (!folder) continue;
    const body = configBodyForPlan(plan, db, folder);
    if (!body) continue;

    await withTempRcloneConfig(body, async (configPath) => {
      const children = await listChildren(plan, configPath);
      if (!children) return; // no legacy root → nothing orphaned
      const hostSet = new Set(plan.hostPrefixes);
      const protectedSet = new Set(plan.protectedChildren);
      const orphaned: OrphanEntry[] = [];
      for (const name of children) {
        const isHostPrefix = hostSet.has(name);
        const isProtected = plan.protectAllChildren || isHostPrefix || protectedSet.has(name);
        const size = await remoteSize(plan, name, configPath);
        orphaned.push({
          folderId: plan.folderId,
          folderName: plan.folderName,
          remotePath: plan.remotePath,
          name,
          sizeBytes: size?.bytes ?? 0,
          itemCount: size?.count ?? 0,
          isHostPrefix,
          isProtected,
        });
      }
      const orphanedBytes = orphaned.reduce((sum, e) => sum + (e.isProtected ? 0 : e.sizeBytes), 0);
      reports.push({
        folderId: plan.folderId,
        folderName: plan.folderName,
        remotePath: plan.remotePath,
        orphaned,
        orphanedBytes,
      });
    });
  }
  return reports;
}

export interface PruneResult {
  folderId: string;
  folderName: string;
  remotePath: string;
  pruned: string[];
  skippedHostPrefixes: string[];
  errors: string[];
}

/**
 * Prune orphaned top-level legacy children. Safety invariants:
 *   - only children NOT in the folder's known host-prefix set are deleted;
 *   - the legacy root and host-scoped prefixes are never touched;
 *   - the orphan set is recomputed fresh (not from a stale report) at prune
 *     time so we can't prune a prefix that became live after a report.
 */
export async function pruneLegacyRoots(db: Database): Promise<PruneResult[]> {
  const results: PruneResult[] = [];
  for (const plan of buildLegacyRootPlans(db)) {
    const folder = loadFolder(db, plan.folderId);
    if (!folder) { continue; }
    const body = configBodyForPlan(plan, db, folder);
    if (!body) { continue; }

    await withTempRcloneConfig(body, async (configPath) => {
      const children = await listChildren(plan, configPath);
      const hostSet = new Set(plan.hostPrefixes);
      const protectedSet = new Set(plan.protectedChildren);
      const pruned: string[] = [];
      const skippedHostPrefixes: string[] = [];
      const errors: string[] = [];
      if (children) {
        for (const name of children) {
          if (plan.protectAllChildren || hostSet.has(name) || protectedSet.has(name)) {
            skippedHostPrefixes.push(name);
            continue;
          }
          const argv = ["rclone", "purge", `${plan.sectionName}:${plan.remotePath}/${name}`, "--config", configPath];
          const { code, stderr } = await runRclone(argv);
          if (code === 0) {
            pruned.push(name);
          } else {
            errors.push(`${name}: ${stderr.trim().slice(-200)}`);
          }
        }
      }
      results.push({
        folderId: plan.folderId,
        folderName: plan.folderName,
        remotePath: plan.remotePath,
        pruned,
        skippedHostPrefixes,
        errors,
      });
    });
  }
  return results;
}
