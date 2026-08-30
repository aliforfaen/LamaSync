import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
import { buildLegacyRootPlans } from "./legacy-root.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const m of MIGRATIONS) {
    try {
      db.exec(m);
    } catch {
      // idempotent
    }
  }
  db.exec(`
    INSERT INTO backends (id, name, kind, local_path, created_at) VALUES
      ('be-s3', 's3-b', 's3', NULL, 0),
      ('be-local', 'local-b', 'local', '/mnt/backups', 0);

    INSERT INTO folders (id, name, type, backend, backend_id, s3_bucket) VALUES
      ('fb-s3',   'photos',      'backup', 's3',    'be-s3',    'mybucket'),
      ('fb-local', 'appdata',     'backup', 'local', 'be-local', NULL),
      ('fb-nfs',   'media',       'backup', 'nfs',   'be-local', NULL),
      ('fb-restic','repo',        'backup', 'restic', NULL,      NULL),
      ('fb-sftp',  'legacy-ftp',  'backup', 'sftp',  NULL,       NULL),
      ('fsync',    'syncdir',     'sync',   's3',    'be-s3',    'mybucket');

    INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path, enabled) VALUES
      ('a1', 'fb-s3',    'host-a', 'both', '/photos',  1),
      ('a2', 'fb-s3',    'host-b', 'both', '/photos-b', 1),
      ('a3', 'fb-local', 'host-a', 'both', '/appdata', 1),
      ('a4', 'fb-nfs',   'host-a', 'both', '/media',   1),
      ('a5', 'fb-restic','host-a', 'both', '/repo',    1),
      ('a6', 'fb-sftp',  'host-a', 'both', '/ftp',     1),
      ('a7', 'fsync',    'host-a', 'both', '/syncdir', 1);
  `);
  return db;
}

describe("buildLegacyRootPlans (LAMA-294)", () => {
  test("plans S3, local and nfs backup folders with host prefixes", () => {
    const plans = buildLegacyRootPlans(makeDb());
    const byFolder = new Map(plans.map((p) => [p.folderId, p]));

    const s3 = byFolder.get("fb-s3");
    expect(s3).toMatchObject({
      backendKind: "s3",
      remotePath: "mybucket/photos",
      sectionName: "legacy-fb-s3",
    });
    expect(s3?.hostPrefixes.sort()).toEqual(["host-a", "host-b"]);

    const local = byFolder.get("fb-local");
    expect(local).toMatchObject({
      backendKind: "local",
      remotePath: "/mnt/backups/appdata",
      sectionName: "legacy-fb-local",
    });
    expect(local?.hostPrefixes).toEqual(["host-a"]);

    // nfs uses the local rclone section but its own folder path.
    const nfs = byFolder.get("fb-nfs");
    expect(nfs).toMatchObject({
      backendKind: "local",
      remotePath: "/mnt/backups/media",
      sectionName: "legacy-fb-nfs",
    });
  });

  test("skips restic, sftp and non-backup folders", () => {
    const plans = buildLegacyRootPlans(makeDb());
    const ids = plans.map((p) => p.folderId);
    expect(ids).not.toContain("fb-restic");
    expect(ids).not.toContain("fb-sftp");
    expect(ids).not.toContain("fsync");
  });

  test("skips folders without assignments", () => {
    const db = makeDb();
    db.run("DELETE FROM folder_assignments WHERE folder_id = 'fb-s3'");
    const plans = buildLegacyRootPlans(db);
    expect(plans.map((p) => p.folderId)).not.toContain("fb-s3");
  });

  test("skips an S3 folder without a bucket", () => {
    const db = makeDb();
    db.run("UPDATE folders SET s3_bucket = NULL WHERE id = 'fb-s3'");
    const plans = buildLegacyRootPlans(db);
    expect(plans.map((p) => p.folderId)).not.toContain("fb-s3");
  });
});
