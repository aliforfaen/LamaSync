// LAMA-226 P1-6: the shared temp rclone config helper must produce 0600
// files in private directories and clean up reliably.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTempRcloneConfig, writeTempRcloneConfig } from "./temp-rclone-config.ts";

describe("writeTempRcloneConfig", () => {
  test("writes the body to a unique 0600 file in a private dir", () => {
    const { configPath, dir } = writeTempRcloneConfig("[secret]\nkey = value\n");
    try {
      expect(existsSync(configPath)).toBe(true);
      expect(readFileSync(configPath, "utf8")).toContain("[secret]");
      const stat = statSync(configPath);
      // 0600 = owner rw only; group/other bits zero.
      expect(stat.mode & 0o077).toBe(0);
      // The directory lives under the OS temp root.
      expect(dir.startsWith(tmpdir())).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unique paths under concurrency", () => {
    const a = writeTempRcloneConfig("a");
    const b = writeTempRcloneConfig("b");
    try {
      expect(a.configPath).not.toBe(b.configPath);
      expect(a.dir).not.toBe(b.dir);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });
});

describe("withTempRcloneConfig", () => {
  test("runs the callback with a valid config path and cleans up on success", async () => {
    let captured: string | null = null;
    const result = await withTempRcloneConfig("body", async (configPath) => {
      captured = configPath;
      expect(existsSync(configPath)).toBe(true);
      return 42;
    });
    expect(captured).not.toBeNull();
    expect(result).toBe(42);
    expect(existsSync(captured!)).toBe(false);
  });

  test("cleans up on the error path", async () => {
    let path: string | null = null;
    await expect(
      withTempRcloneConfig("body", async (configPath) => {
        path = configPath;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(false);
    expect(existsSync(join(path!, ".."))).toBe(false);
  });
});

afterEach(() => {
  // Best-effort: any test that leaked should still be cleaned so the
  // shared tmpdir doesn't accumulate rclone configs forever.
  for (const entry of require("node:fs").readdirSync(tmpdir())) {
    if (entry.startsWith("lamasync-rclone-")) {
      rmSync(join(tmpdir(), entry), { recursive: true, force: true });
    }
  }
});