// Pure-part tests for the first-run setup helpers (WS3 / TUI foundations).
// The TOML writer and the needsSetup detector are pure functions; the only
// I/O tested here writes to a temp dir, never the real home directory.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseClientConfig } from "@lamasync/core";

import {
  clientConfigToml,
  clientNeedsSetup,
  writeClientConfig,
} from "./api.ts";

describe("clientConfigToml", () => {
  test("round-trips through parseClientConfig", () => {
    const config = {
      serverUrl: "http://100.64.0.1:8080",
      apiKey: "a-long-random-key",
      hostname: "my-laptop",
    };
    const parsed = parseClientConfig(clientConfigToml(config));
    expect(parsed.serverUrl).toBe(config.serverUrl);
    expect(parsed.apiKey).toBe(config.apiKey);
    expect(parsed.hostname).toBe(config.hostname);
  });

  test("escapes double quotes and backslashes in values", () => {
    const config = {
      serverUrl: 'http://host"quoted\\path:8080',
      apiKey: 'key"with"quotes\\and\\slashes',
      hostname: "laptop\\two\"three",
    };
    const parsed = parseClientConfig(clientConfigToml(config));
    expect(parsed.serverUrl).toBe(config.serverUrl);
    expect(parsed.apiKey).toBe(config.apiKey);
    expect(parsed.hostname).toBe(config.hostname);
  });
});

describe("writeClientConfig", () => {
  test("creates the directory and writes a parseable file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-setup-test-"));
    try {
      const path = join(dir, "nested", "client.toml");
      writeClientConfig(
        { serverUrl: "http://127.0.0.1:8080", apiKey: "k", hostname: "h" },
        path,
      );
      const parsed = parseClientConfig(readFileSync(path, "utf8"));
      expect(parsed.serverUrl).toBe("http://127.0.0.1:8080");
      expect(parsed.apiKey).toBe("k");
      expect(parsed.hostname).toBe("h");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("clientNeedsSetup", () => {
  test("false when both env vars are present", () => {
    expect(
      clientNeedsSetup({
        envUrl: "http://server:8080",
        envKey: "k",
        hasConfigFile: false,
      }),
    ).toBe(false);
  });

  test("false when a config file parsed cleanly", () => {
    expect(
      clientNeedsSetup({ hasConfigFile: true, configError: undefined }),
    ).toBe(false);
  });

  test("true when neither env vars nor a config file exist", () => {
    expect(clientNeedsSetup({ hasConfigFile: false })).toBe(true);
  });

  test("true when only one env var is present", () => {
    expect(clientNeedsSetup({ envUrl: "http://x:8080", hasConfigFile: false })).toBe(
      true,
    );
    expect(clientNeedsSetup({ envKey: "k", hasConfigFile: false })).toBe(true);
  });

  test("true when the config file failed to parse (setup overwrites it)", () => {
    expect(
      clientNeedsSetup({ hasConfigFile: true, configError: "bad toml" }),
    ).toBe(true);
  });
});
