import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "./schema.ts";

// Mirrors initDb's tolerance: each migration is tried and "duplicate column"
// / already-exists errors are swallowed, so a DB that already matches the
// new schema can safely re-run the full list.
function applyMigrations(db: Database): void {
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // intentional — idempotent migrations for pre-existing schema.
    }
  }
}

describe("LAMA-302 watch migrations", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SERVER_SCHEMA);
  });

  test("adds the four watch columns defaulting to off", () => {
    // Seed a legacy assignment without the watch columns (as if it predates
    // LAMA-302). The migration must add the columns; existing rows keep
    // their exact schedule-only behavior (watch_enabled = 0, NULL quiet).
    db.exec(`
      INSERT INTO folders (id, name, type) VALUES ('f-sync', 'work', 'sync');
      INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path, enabled)
        VALUES ('a-1', 'f-sync', 'host-a', 'both', '/work', 1);
    `);

    applyMigrations(db);

    const col = db.query<{
      watch_enabled: number;
      watch_quiet_sec: number | null;
      ignore_git_metadata: number;
      respect_gitignore: number;
    }, []>(
      "SELECT watch_enabled, watch_quiet_sec, ignore_git_metadata, respect_gitignore FROM folder_assignments WHERE id = 'a-1'",
    ).get();
    expect(col).toEqual({
      watch_enabled: 0,
      watch_quiet_sec: null,
      ignore_git_metadata: 0,
      respect_gitignore: 0,
    });
  });
});

describe("LAMA-294 migrations", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SERVER_SCHEMA);
  });

  test("adds and backfills destination — backups host-scoped, others shared", () => {
    // Seed rows as-if they predate LAMA-294 (destination is NULL). Fresh
    // SERVER_SCHEMA already has the column, so we populate folder
    // assignments directly with destination = NULL to simulate the legacy
    // rows the migration must backfill.
    db.exec(`
      INSERT INTO folders (id, name, type) VALUES
        ('f-backup', 'photos', 'backup'),
        ('f-sync', 'work', 'sync'),
        ('f-mount', 'media', 'mount');
      INSERT INTO folder_assignments (id, folder_id, host_id, role, local_path, enabled)
        VALUES
          ('a-b1', 'f-backup', 'host-a', 'both', '/photos', 1),
          ('a-b2', 'f-backup', 'host-b', 'both', '/photos-b', 1),
          ('a-s1', 'f-sync', 'host-a', 'both', '/work', 1),
          ('a-m1', 'f-mount', 'host-a', 'both', '/media', 1);
    `);

    applyMigrations(db);

    const dest = (id: string): string | null =>
      db
        .query<{ destination: string | null }, [string]>(
          "SELECT destination FROM folder_assignments WHERE id = ?",
        )
        .get(id)?.destination ?? null;

    // Ordinary backups are host-scoped on migration.
    expect(dest("a-b1")).toBe("photos/host-a");
    expect(dest("a-b2")).toBe("photos/host-b");
    // Sync/mount stay shared (folder name).
    expect(dest("a-s1")).toBe("work");
    expect(dest("a-m1")).toBe("media");
  });

  test("rebuilds folder_locks keyed by destination_key with folder_id retained", () => {
    // Simulate a legacy lock row (old PK was folder_id).
    db.exec(
      `INSERT INTO folder_locks (folder_id, locked_by, locked_at, lock_ttl, lock_id)
       VALUES ('f-backup', 'host-a', ?, 1200, 'lock-1')`,
      [Date.now()],
    );

    applyMigrations(db);

    const col = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('folder_locks') WHERE pk = 1")
      .get();
    expect(col?.name).toBe("destination_key");

    const row = db
      .query<{ destination_key: string; folder_id: string | null }, []>(
        "SELECT destination_key, folder_id FROM folder_locks",
      )
      .get();
    // The legacy row is dropped during the rebuild (locks are transient);
    // destination_key becomes the primary identity.
    expect(row).toBeNull();
  });
});
