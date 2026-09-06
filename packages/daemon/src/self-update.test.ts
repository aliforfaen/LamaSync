import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  downloadAndReplace,
  fetchLatestRelease,
  isNewer,
  resolveSelfBinaryPath,
} from "./self-update.ts";

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

describe("downloadAndReplace", () => {
  const STAGED_PREFIX = ".lamasyncd-update-";
  const URL = "https://example.invalid/lamasyncd";

  let dir: string;
  let binaryPath: string;
  let originalFetch: typeof globalThis.fetch;
  let originalTmpdir: string | undefined;
  let originalWarn: typeof console.warn;

  /** Failures are best-effort: they log a warning and return false. */
  async function expectUpdateFailure(run: () => Promise<boolean>): Promise<void> {
    console.warn = () => {};
    try {
      expect(await run()).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  }

  /** Stand-in for the network. Bun's fetch type also carries `preconnect`. */
  function fetchStub(body: BodyInit, status = 200): typeof globalThis.fetch {
    return Object.assign(
      async (): Promise<Response> => new Response(body, { status }),
      { preconnect: globalThis.fetch.preconnect },
    );
  }

  function stagedFiles(): string[] {
    return readdirSync(dir).filter((name) => name.startsWith(STAGED_PREFIX));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lamasync-selfupdate-"));
    binaryPath = join(dir, "lamasyncd");
    originalFetch = globalThis.fetch;
    originalTmpdir = process.env.TMPDIR;
    originalWarn = console.warn;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    console.warn = originalWarn;
    rmSync(dir, { recursive: true, force: true });
  });

  test("stages next to the binary and replaces it atomically (same filesystem — no EXDEV)", async () => {
    writeFileSync(binaryPath, "old-binary", { mode: 0o755 });
    // LAMA-319 regression pin: point the OS temp dir at a non-existent
    // path. A regression back to os.tmpdir() staging would fail with
    // ENOENT here; the update must stage in dirname(binaryName) so the
    // rename never crosses filesystems (EXDEV on /tmp vs install dir).
    process.env.TMPDIR = join(dir, "nonexistent-tmp");

    const payload = new TextEncoder().encode("new-binary-bytes");
    globalThis.fetch = fetchStub(payload);

    const ok = await downloadAndReplace(URL, binaryPath);

    expect(ok).toBe(true);
    // Replaced with the downloaded bytes, executable, no staged leftovers.
    expect(readFileSync(binaryPath).equals(payload)).toBe(true);
    expect(statSync(binaryPath).mode & 0o777).toBe(0o755);
    expect(stagedFiles()).toEqual([]);
  });

  test("a pre-rename download failure leaves the installed binary intact", async () => {
    writeFileSync(binaryPath, "old-binary", { mode: 0o755 });
    globalThis.fetch = fetchStub("boom", 500);

    await expectUpdateFailure(() => downloadAndReplace(URL, binaryPath));

    expect(readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(stagedFiles()).toEqual([]);
  });

  test("a failed rename leaves the installed target intact and removes the staged file", async () => {
    // The destination is an existing directory, so rename(2) fails with
    // EISDIR AFTER the staged file was written and chmod'd. The target is
    // never touched before the rename, and the staged file is cleaned up.
    mkdirSync(binaryPath);
    const payload = new TextEncoder().encode("new-binary-bytes");
    globalThis.fetch = fetchStub(payload);

    await expectUpdateFailure(() => downloadAndReplace(URL, binaryPath));

    expect(statSync(binaryPath).isDirectory()).toBe(true);
    expect(stagedFiles()).toEqual([]);
  });
});
