// LAMA-264 — Demo mode.
//
// Lets a new user "see a demo fleet" without adding real folders: seeds 3
// fake devices, a timeline of realistic activity, and a browsable restic
// snapshot + file-viewer seed. A single confirmed DELETE wipes every seeded
// row. Demo rows are flagged (demo = 1) so they never touch a real rclone
// backend and a real daemon never acts on them (demo hosts have no
// heartbeat; a daemon only pulls its own host id).

import { Elysia, t } from "elysia";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { db as defaultDb } from "../db.ts";
import type { Database } from "bun:sqlite";
import type { DemoSeedSummary, DemoState } from "@lamasync/core";

let db: Database = defaultDb;
export function __setDb(next: Database): void {
  db = next;
}

const BACKUP_DIR = process.env.LAMASYNC_BACKUP_DIR || "/backups";
const DEMO_DIR_NAME = "demo";

/** Absolute server-side directory holding the seeded demo files. */
export function demoSeedDir(): string {
  return join(BACKUP_DIR, DEMO_DIR_NAME);
}

interface CountRow {
  c: number;
}

function countWhere(table: string): number {
  const row = db
    .query<CountRow, []>(`SELECT COUNT(*) AS c FROM ${table} WHERE demo = 1`)
    .get();
  return row?.c ?? 0;
}

export function getDemoState(): DemoState {
  const counts = {
    hosts: countWhere("hosts"),
    folders: countWhere("folders"),
    assignments: countWhere("folder_assignments"),
    backends: countWhere("backends"),
    operations: countWhere("operation_log"),
    snapshots: countWhere("restic_snapshots"),
    manifests: countWhere("dotfile_manifests"),
    templates: countWhere("application_templates"),
    protections: countWhere("application_protections"),
    appSnapshots: countWhere("application_snapshots"),
  };
  const total =
    counts.hosts +
    counts.folders +
    counts.assignments +
    counts.backends +
    counts.operations +
    counts.snapshots +
    counts.manifests +
    counts.templates +
    counts.protections +
    counts.appSnapshots;
  return { hasDemo: total > 0, counts };
}

const SEED_FILES: Record<string, string> = {
  "README.txt":
    "This is seeded demo data. It is flagged as demo and is wiped by\n'Delete demo data' — it never touches a real rclone backend.\n",
  "settings.json":
    '{\n  "theme": "dim",\n  "fontSize": 14,\n  "telemetry": false\n}\n',
  "notes.md":
    "# Demo notes\n\n- Poke the empty states\n- Open the Data browser\n- Try a restore\n",
};

// 3 fake devices with varied status so the Devices page looks alive.
const DEMO_HOSTS: Array<{
  hostname: string;
  status: "online" | "offline" | "degraded";
  tailnetIp: string;
  lanIp: string;
  lastSeenOffsetMs: number;
}> = [
  { hostname: "atlas-laptop", status: "online", tailnetIp: "100.64.0.11", lanIp: "192.168.1.21", lastSeenOffsetMs: 2 * 60_000 },
  { hostname: "orion-desktop", status: "degraded", tailnetIp: "100.64.0.42", lanIp: "192.168.1.42", lastSeenOffsetMs: 34 * 60_000 },
  { hostname: "nova-pi", status: "offline", tailnetIp: "100.64.0.99", lanIp: "192.168.1.99", lastSeenOffsetMs: 3 * 24 * 60 * 60_000 },
];

const DEMO_FOLDERS: Array<{ name: string; type: string; localPath: string }> = [
  { name: "Demo: VS Code settings", type: "dotfile", localPath: "~/.config/Code/User" },
  { name: "Demo: Photos", type: "sync", localPath: "~/Pictures" },
  { name: "Demo: Documents", type: "backup", localPath: "~/Documents" },
];

// Templates for the timeline. spreadDays distributes entries over ~3 weeks.
const DEMO_OPERATIONS: Array<{
  operation: string;
  status: "success" | "failed" | "conflict";
  summary: string;
  daysAgo: number;
  durationMs: number;
}> = [
  { operation: "sync", status: "success", summary: "Synced 1,284 files (42 MB)", daysAgo: 0, durationMs: 18_400 },
  { operation: "backup", status: "success", summary: "Backed up 312 objects", daysAgo: 1, durationMs: 62_100 },
  { operation: "restore", status: "success", summary: "Restored notes.md", daysAgo: 2, durationMs: 4_200 },
  { operation: "sync", status: "conflict", summary: "Conflict in settings.json — kept both", daysAgo: 3, durationMs: 9_800 },
  { operation: "prune", status: "success", summary: "Pruned 14 old snapshots", daysAgo: 5, durationMs: 31_500 },
  { operation: "sync", status: "failed", summary: "Connection refused to nova-pi", daysAgo: 6, durationMs: 2_100 },
  { operation: "backup", status: "success", summary: "Backed up 298 objects", daysAgo: 8, durationMs: 58_900 },
  { operation: "sync", status: "success", summary: "Synced 1,091 files (38 MB)", daysAgo: 10, durationMs: 21_300 },
  { operation: "restore", status: "success", summary: "Restored settings.json", daysAgo: 12, durationMs: 3_700 },
  { operation: "sync", status: "success", summary: "Synced 1,402 files (51 MB)", daysAgo: 14, durationMs: 24_800 },
  { operation: "backup", status: "success", summary: "Backed up 305 objects", daysAgo: 17, durationMs: 60_200 },
  { operation: "prune", status: "success", summary: "Pruned 9 old snapshots", daysAgo: 19, durationMs: 29_400 },
  { operation: "sync", status: "success", summary: "Synced 1,177 files (40 MB)", daysAgo: 21, durationMs: 19_900 },
];

export function seedDemo(): DemoSeedSummary {
  const now = Date.now();
  const seedDir = demoSeedDir();
  mkdirSync(seedDir, { recursive: true });
  for (const [name, content] of Object.entries(SEED_FILES)) {
    writeFileSync(join(seedDir, name), content, "utf8");
  }

  // --- hosts ---
  const hostIds: string[] = [];
  for (const h of DEMO_HOSTS) {
    const id = `demo-${crypto.randomUUID()}`;
    hostIds.push(id);
    db.run(
      "INSERT INTO hosts (id, hostname, tailnet_ip, lan_ip, last_seen, status, version, config_revision, demo) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)",
      [id, h.hostname, h.tailnetIp, h.lanIp, now - h.lastSeenOffsetMs, h.status, "0.3.2"],
    );
  }

  // --- local demo backend (file viewer seed) ---
  const backendId = `demo-${crypto.randomUUID()}`;
  db.run(
    "INSERT INTO backends (id, name, kind, local_path, created_at, demo) VALUES (?, ?, 'local', ?, ?, 1)",
    [backendId, "Demo backups (local)", seedDir, now],
  );

  // --- folders + assignments to demo hosts ---
  const folderIds: string[] = [];
  DEMO_FOLDERS.forEach((f, i) => {
    const id = `demo-${crypto.randomUUID()}`;
    folderIds.push(id);
    db.run(
      "INSERT INTO folders (id, name, type, created_at, backend, backend_id, demo) VALUES (?, ?, ?, ?, 'local', ?, 1)",
      [id, f.name, f.type, now - (DEMO_OPERATIONS.length - i) * 86_400_000, backendId],
    );
    // Assign to the first two demo hosts so the fleet looks populated.
    for (const hostId of hostIds.slice(0, 2)) {
      db.run(
        "INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path, remote_name, sync_expr, enabled, mode, demo) VALUES (?, ?, ?, 'both', ?, NULL, NULL, 1, 'inherit', 1)",
        [`demo-${crypto.randomUUID()}`, id, hostId, f.localPath],
      );
    }
  });

  // --- an app template + protection on the first demo host (app-settings backup) ---
  const templateId = `demo-${crypto.randomUUID()}`;
  const tsNow = Date.now();
  const demoSpec = {
    paths: {
      linux: [{ path: "~/.config/Code/User/settings.json", classification: "unknown" }],
      macos: [],
      windows: [],
    },
    excludes: [],
    notes: null,
  };
  db.run(
    "INSERT INTO application_templates (id, name, origin, paths, created_at, updated_at, demo) VALUES (?, 'VS Code', 'custom', ?, ?, ?, 1)",
    [templateId, JSON.stringify(demoSpec), tsNow, tsNow],
  );
  const protectionId = `demo-${crypto.randomUUID()}`;
  db.run(
    "INSERT INTO application_protections (id, template_id, template_revision, host_id, name, enabled, schedule, destination, capture_spec, created_at, updated_at, demo) VALUES (?, ?, 1, ?, 'VS Code', 1, NULL, 'server_archive', ?, ?, ?, 1)",
    [protectionId, templateId, hostIds[0], JSON.stringify(demoSpec), tsNow, tsNow],
  );

  // --- a browsable restic snapshot referencing the first demo folder ---
  db.run(
    "INSERT INTO restic_snapshots (id, folder_id, host_id, snapshot_id, timestamp, paths, size_bytes, tags, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
    [
      `demo-${crypto.randomUUID()}`,
      folderIds[0],
      hostIds[0],
      `demo-snap-${crypto.randomUUID().slice(0, 8)}`,
      now - 2 * 86_400_000,
      JSON.stringify([seedDir]),
      12_345_678,
      JSON.stringify(["demo", "auto"]),
    ],
  );

  // --- timeline of operations across demo hosts/folders ---
  for (const op of DEMO_OPERATIONS) {
    const hostId = hostIds[op.daysAgo % hostIds.length];
    const folderId = folderIds[op.daysAgo % folderIds.length];
    db.run(
      "INSERT INTO operation_log (timestamp, host_id, folder_id, operation, status, summary, details, duration_ms, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
      [
        now - op.daysAgo * 86_400_000 - (op.daysAgo % 5) * 3_600_000,
        hostId,
        folderId,
        op.operation,
        op.status,
        op.summary,
        null,
        op.durationMs,
      ],
    );
  }

  // --- a couple of pending conflicts on the first demo folder (LAMA-268) ---
  // Real conflicts arrive from the daemon via POST /conflicts; the demo
  // seed writes the same shape so the side-by-side cards can be explored.
  const DEMO_CONFLICTS: Array<{
    path: string;
    localMtime: number;
    remoteMtime: number;
    localSizeBytes: number;
    remoteSizeBytes: number;
  }> = [
    {
      path: "notes.md",
      localMtime: now - 1_200_000,
      remoteMtime: now - 3_600_000,
      localSizeBytes: 1_842,
      remoteSizeBytes: 2_011,
    },
    {
      path: "settings.json",
      localMtime: now - 2_400_000,
      remoteMtime: now - 86_400_000,
      localSizeBytes: 4_096,
      remoteSizeBytes: 3_512,
    },
  ];
  for (const c of DEMO_CONFLICTS) {
    db.run(
      "INSERT INTO conflicts (id, host_id, folder_id, path, local_mtime, remote_mtime, local_size, remote_size, status, created_at, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1)",
      [
        `demo-${crypto.randomUUID()}`,
        hostIds[0],
        folderIds[0],
        c.path,
        c.localMtime,
        c.remoteMtime,
        c.localSizeBytes,
        c.remoteSizeBytes,
        now,
      ],
    );
  }

  return {
    hosts: DEMO_HOSTS.length,
    folders: DEMO_FOLDERS.length,
    assignments: DEMO_FOLDERS.length * 2,
    backends: 1,
    operations: DEMO_OPERATIONS.length,
    snapshots: 1,
    manifests: 0,
    templates: 1,
    protections: 1,
    appSnapshots: 0,
    conflicts: DEMO_CONFLICTS.length,
    seedDir,
  };
}

// Delete demo rows in FK-safe order. Every statement matches demo = 1 only,
// so real data is never touched; the operation is idempotent (no-op when
// nothing is flagged).
export function deleteDemo(): DemoSeedSummary {
  db.run("DELETE FROM operation_log WHERE demo = 1");
  db.run("DELETE FROM folder_assignments WHERE demo = 1");
  db.run("DELETE FROM restic_restore_jobs WHERE demo = 1");
  db.run(
    "DELETE FROM restic_snapshots WHERE demo = 1 OR folder_id IN (SELECT id FROM folders WHERE demo = 1)",
  );
  db.run(
    "DELETE FROM dotfile_versions WHERE manifest_id IN (SELECT id FROM dotfile_manifests WHERE demo = 1)",
  );
  db.run("DELETE FROM dotfile_manifests WHERE demo = 1");
  db.run("DELETE FROM application_snapshots WHERE demo = 1");
  db.run("DELETE FROM application_protections WHERE demo = 1");
  db.run("DELETE FROM application_templates WHERE demo = 1");
  db.run("DELETE FROM conflicts WHERE demo = 1");
  db.run("DELETE FROM folders WHERE demo = 1");
  db.run("DELETE FROM backends WHERE demo = 1");
  db.run("DELETE FROM hosts WHERE demo = 1");
  return {
    hosts: 0,
    folders: 0,
    assignments: 0,
    backends: 0,
    operations: 0,
    snapshots: 0,
    manifests: 0,
    templates: 0,
    protections: 0,
    appSnapshots: 0,
    seedDir: demoSeedDir(),
  };
}

export const demoRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/demo",
    () => getDemoState(),
    {
      detail: {
        summary: "Demo-mode state (whether demo data is present)",
        tags: ["Demo"],
        responses: {
          200: { description: "Demo state" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/demo/seed",
    ({ set }) => {
      const summary = seedDemo();
      set.status = 201;
      return summary;
    },
    {
      detail: {
        summary: "Seed a demo fleet (fake devices, timeline, snapshot)",
        tags: ["Demo"],
        responses: {
          201: { description: "Demo data seeded" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .delete(
    "/demo",
    () => deleteDemo(),
    {
      detail: {
        summary: "Delete all demo data (confirmed by the caller)",
        tags: ["Demo"],
        responses: {
          200: { description: "Demo data deleted" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );
