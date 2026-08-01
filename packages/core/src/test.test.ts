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
      ntfyUrl: undefined,
    });
  });

  test("respects overrides", () => {
    const cfg = parseServerConfig(
      'apiKey = "k"\nport = 9090\ndataDir = "/srv/data"\nntfyUrl = "https://ntfy.sh/x"\n',
    );
    expect(cfg.port).toBe(9090);
    expect(cfg.dataDir).toBe("/srv/data");
    expect(cfg.ntfyUrl).toBe("https://ntfy.sh/x");
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
