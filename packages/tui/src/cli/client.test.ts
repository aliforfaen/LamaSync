// Tests for auth discovery (LAMA-229) — flag > env > config > default.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildCliClient,
  defaultConfigPath,
  exitCodeForError,
} from "./client.ts";
import { maskSecret } from "./output.ts";

function withTempHome<T>(fn: (home: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "lamasync-cli-client-"));
  const prevHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    return fn(dir);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("buildCliClient auth discovery", () => {
  test("flags win over env and config (LAMA-229)", () => {
    process.env.LAMASYNC_SERVER_URL = "http://env:1234";
    process.env.LAMASYNC_API_KEY = "env-key-long-enough";
    try {
      const result = buildCliClient({
        flagServer: "http://flag:5678",
        flagKey: "flag-key-very-long",
      });
      expect(result.source).toBe("flag");
      expect(result.serverUrl).toBe("http://flag:5678");
      expect(result.maskedKey).toBe(maskSecret("flag-key-very-long"));
    } finally {
      delete process.env.LAMASYNC_SERVER_URL;
      delete process.env.LAMASYNC_API_KEY;
    }
  });

  test("env vars are used when no flags are present", () => {
    process.env.LAMASYNC_SERVER_URL = "http://env:1234";
    process.env.LAMASYNC_API_KEY = "env-key-long-enough";
    try {
      const result = buildCliClient({});
      expect(result.source).toBe("env");
      expect(result.serverUrl).toBe("http://env:1234");
      expect(result.fromEnv).toBe(true);
    } finally {
      delete process.env.LAMASYNC_SERVER_URL;
      delete process.env.LAMASYNC_API_KEY;
    }
  });

  test("falls back to client.toml when no env/flag is present", () => {
    withTempHome((home) => {
      delete process.env.LAMASYNC_SERVER_URL;
      delete process.env.LAMASYNC_API_KEY;
      const configDir = join(home, ".config", "lamasync");
      require("fs").mkdirSync(configDir, { recursive: true });
      writeFileSync(
        defaultConfigPath(),
        [
          'serverUrl = "http://cfg:9999"',
          'apiKey = "cfg-key-long-enough"',
          'hostname = "myhost"',
          "",
        ].join("\n"),
      );
      const result = buildCliClient({});
      expect(result.source).toBe("config");
      expect(result.serverUrl).toBe("http://cfg:9999");
      expect(result.hostname).toBe("myhost");
      expect(result.needsSetup).toBe(false);
    });
  });

  test("falls back to dev defaults when nothing is configured", () => {
    withTempHome(() => {
      delete process.env.LAMASYNC_SERVER_URL;
      delete process.env.LAMASYNC_API_KEY;
      const result = buildCliClient({});
      expect(result.source).toBe("default");
      expect(result.needsSetup).toBe(true);
    });
  });

  test("a malformed config file is treated as needsSetup (fall through)", () => {
    withTempHome((home) => {
      delete process.env.LAMASYNC_SERVER_URL;
      delete process.env.LAMASYNC_API_KEY;
      const configDir = join(home, ".config", "lamasync");
      require("fs").mkdirSync(configDir, { recursive: true });
      writeFileSync(defaultConfigPath(), "not valid toml = =", "utf8");
      const result = buildCliClient({});
      expect(result.source).toBe("default");
      expect(result.needsSetup).toBe(true);
    });
  });
});

describe("exitCodeForError (LAMA-229 exit contract)", () => {
  test("401/403 → 3 (auth failure)", () => {
    expect(
      exitCodeForError(
        Object.assign(new Error("401"), { status: 401 }),
      ),
    ).toBe(3);
    expect(
      exitCodeForError(
        Object.assign(new Error("403"), { status: 403 }),
      ),
    ).toBe(3);
  });

  test("5xx → 4 (server unreachable / error)", () => {
    expect(
      exitCodeForError(
        Object.assign(new Error("500"), { status: 500 }),
      ),
    ).toBe(4);
  });

  test("network errors → 4", () => {
    expect(exitCodeForError(new TypeError("fetch failed"))).toBe(4);
    expect(exitCodeForError(new Error("connect ECONNREFUSED"))).toBe(4);
  });

  test("unrelated errors → 1 (runtime)", () => {
    expect(exitCodeForError(new Error("something else"))).toBe(1);
  });
});
