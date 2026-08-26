import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  initDb,
  parseClientConfig,
  parseServerConfig,
  SERVER_SCHEMA,
  MIGRATIONS,
} from "./index.ts";
import type { Database } from "./index.ts";

describe("initDb", () => {
  test("applies schema and creates expected tables", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lamasync-core-test-"));
    try {
      const db = initDb(join(tmp, "test.db"));
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((r) => r.name);
      expect(tables).toContain("hosts");
      expect(tables).toContain("folders");
      expect(tables).toContain("folder_assignments");
      expect(tables).toContain("dotfile_manifests");
      expect(tables).toContain("dotfile_versions");
      expect(tables).toContain("operation_log");
      expect(tables).toContain("schedule_state");
    } finally {
      // bun:sqlite closes on process exit; tmpdir is OS-managed
    }
  });

  test("schema string is non-empty", () => {
    expect(SERVER_SCHEMA.length).toBeGreaterThan(100);
  });

  test("hosts table declares the version column (LAMA-199)", () => {
    // Fresh-schema path: column is in the CREATE TABLE.
    expect(SERVER_SCHEMA).toMatch(/CREATE TABLE IF NOT EXISTS hosts[\s\S]*version\s+TEXT/);
    // Migration path: existing databases pick the column up via ALTER TABLE.
    expect(MIGRATIONS).toContain("ALTER TABLE hosts ADD COLUMN version TEXT");
  });

  test("initDb applies the new hosts.version column", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lamasync-core-version-"));
    try {
      const db = initDb(join(tmp, "test.db"));
      // Column is reachable on a freshly inserted row.
      db.run(
        `INSERT INTO hosts (id, hostname, status, version) VALUES ('h1', 'h1', 'online', '0.2.3')`,
      );
      const row = db
        .query<{ version: string | null }, [string]>(
          "SELECT version FROM hosts WHERE id = ?",
        )
        .get("h1");
      expect(row?.version).toBe("0.2.3");
    } finally {
      // tmpdir is OS-managed
    }
  });

  test("legacy s3_* drops are gated behind dropLegacyS3Columns (LAMA-222 P0-3)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "lamasync-core-gated-drop-"));
    const path = join(tmp, "test.db");
    const hasLegacyColumn = (db: Database): boolean =>
      (db
        .query<{ c: number }, []>(
          "SELECT COUNT(*) AS c FROM pragma_table_info('folders') WHERE name = 's3_endpoint'",
        )
        .get()?.c ?? 0) > 0;

    // Simulate a pre-LAMA-222 database: the legacy LAMA-124 ADD COLUMN
    // migrations in MIGRATIONS give folders its s3_endpoint column; only
    // the row data distinguishes "legacy" from "fresh".
    const setup = initDb(path);
    setup.run(
      `INSERT INTO folders (id, name, type, s3_endpoint) VALUES ('f1', 'vault', 'backup', 'sos-at-vie-1.exo.io')`,
    );
    setup.close();

    // Default open: the legacy column and its data MUST survive.
    const kept = initDb(path);
    expect(hasLegacyColumn(kept)).toBe(true);
    const row = kept
      .query<{ s3_endpoint: string | null }, [string]>(
        "SELECT s3_endpoint FROM folders WHERE id = ?",
      )
      .get("f1");
    expect(row?.s3_endpoint).toBe("sos-at-vie-1.exo.io");
    kept.close();

    // Gated open: only now may the column be dropped.
    const dropped = initDb(path, { dropLegacyS3Columns: true });
    expect(hasLegacyColumn(dropped)).toBe(false);
    dropped.close();
  });
});

describe("parseServerConfig", () => {
  test("requires apiKey", () => {
    expect(() => parseServerConfig("port = 9000\n")).toThrow(/apiKey/);
  });

  test("applies defaults", () => {
    const cfg = parseServerConfig('apiKey = "k"\n');
    expect(cfg).toEqual({
      apiKey: "k",
      port: 8080,
      dataDir: "/data",
      backupDir: "/backups",
    });
  });

  test("respects overrides", () => {
    const cfg = parseServerConfig(
      'apiKey = "k"\nport = 9090\ndataDir = "/srv/data"\n',
    );
    expect(cfg.port).toBe(9090);
    expect(cfg.dataDir).toBe("/srv/data");
    expect(cfg.backupDir).toBe("/backups");
  });
});

describe("parseClientConfig", () => {
  test("requires serverUrl, apiKey, hostname", () => {
    expect(() => parseClientConfig('apiKey = "k"\nhostname = "h"\n')).toThrow(
      /serverUrl/,
    );
    expect(() => parseClientConfig('serverUrl = "u"\nhostname = "h"\n')).toThrow(
      /apiKey/,
    );
    expect(() => parseClientConfig('serverUrl = "u"\napiKey = "k"\n')).toThrow(
      /hostname/,
    );
  });

  test("applies default dataDir", () => {
    const cfg = parseClientConfig(
      'serverUrl = "u"\napiKey = "k"\nhostname = "h"\n',
    );
    expect(cfg.dataDir).toBe("~/.local/share/lamasync");
  });
});
