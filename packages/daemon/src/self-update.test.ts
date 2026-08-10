import { describe, expect, test } from "bun:test";
import { fetchLatestRelease, isNewer, resolveSelfBinaryPath } from "./self-update.ts";

describe("resolveSelfBinaryPath", () => {
  test("prefers a real execPath over the bunfs virtual argv[1]", () => {
    // The compiled-binary case: argv[1] is the bunfs entrypoint and
    // renaming over it fails with ENOENT (v0.3.0 self-update bug).
    expect(resolveSelfBinaryPath("/home/u/.local/bin/lamasyncd", "/$bunfs/root/lamasyncd")).toBe(
      "/home/u/.local/bin/lamasyncd",
    );
  });

  test("falls back to argv[1] when execPath is the bun runtime (dev mode)", () => {
    expect(resolveSelfBinaryPath("/usr/bin/bun", "packages/daemon/src/index.ts")).toBe(
      "packages/daemon/src/index.ts",
    );
    expect(resolveSelfBinaryPath("/usr/bin/node", "/opt/lamasync/lamasyncd")).toBe(
      "/opt/lamasync/lamasyncd",
    );
  });

  test("never returns a bunfs or runtime path", () => {
    const result = resolveSelfBinaryPath("/$bunfs/root/lamasyncd", "/$bunfs/root/lamasyncd");
    expect(result.startsWith("/$bunfs")).toBe(false);
    expect(["bun", "node"]).not.toContain(result.split("/").pop());
  });
});

describe("isNewer", () => {
  test("strictly newer returns true", () => {
    expect(isNewer("0.2.0", "0.3.0")).toBe(true);
    expect(isNewer("0.2.0", "0.2.1")).toBe(true);
    expect(isNewer("0.2.0", "0.2.10")).toBe(true);
    expect(isNewer("1.0.0", "2.0.0")).toBe(true);
    expect(isNewer("0.0.0", "0.0.1")).toBe(true);
  });

  test("equal returns false", () => {
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
  });

  test("older returns false", () => {
    expect(isNewer("0.3.0", "0.2.0")).toBe(false);
    expect(isNewer("1.0.0", "0.9.9")).toBe(false);
  });

  test("invalid versions return false", () => {
    expect(isNewer("garbage", "0.3.0")).toBe(false);
    expect(isNewer("0.2.0", "garbage")).toBe(false);
    expect(isNewer("", "")).toBe(false);
  });

  test("ignores pre-release suffix on numeric prefix", () => {
    expect(isNewer("0.2.0", "0.3.0-rc.1")).toBe(true);
    expect(isNewer("  0.2.0  ", "  0.3.0  ")).toBe(true);
  });
});

describe("fetchLatestRelease", () => {
  test("returns object or null (network may be unavailable)", async () => {
    const result = await fetchLatestRelease();
    expect(result === null || typeof result === "object").toBe(true);
  }, { timeout: 10000 });
});
