import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  initDb,
  parseClientConfig,
  parseServerConfig,
  SERVER_SCHEMA,
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
