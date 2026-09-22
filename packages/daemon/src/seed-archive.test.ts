// LAMA-346: end-to-end tests for the seed archive primitives, driven with the
// real GNU tar on this host against a fixture tree. No rclone, no network.
//
// The pipeline under test is exactly the local half of a seed:
//
//   fixture tree → manifest → tar(+zstd|gzip) → member validation
//                → extract into a sibling staging dir → verify byte-for-byte
//                → atomic rename into the final target
//
// plus the fail-closed paths: source churn during archiving, a traversal
// member, a symlink member, a non-empty target, and staging inside the target.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  archiveCreateArgs,
  archiveExtractArgs,
  archiveListArgs,
  buildSeedManifest,
  buildStatsFingerprint,
  createSeedArchive,
  defaultSeedCommandRunner,
  detectArchiveTooling,
  extractSeedArchive,
  parseVerboseMemberLine,
  publishStagedTree,
  seedPreflight,
  validateSeedArchive,
  verifyExtractedTree,
  type SeedCommandRunner,
} from "./seed-archive.ts";
import { validateStagingLocation } from "@lamasync/core";

let root: string;

function fixture(): string {
  const source = join(root, "source");
  mkdirSync(join(source, "sub", "deep"), { recursive: true });
  writeFileSync(join(source, "a.txt"), "alpha\n");
  writeFileSync(join(source, "sub", "b.txt"), "bravo\n");
  writeFileSync(join(source, "sub", "deep", "c.bin"), Buffer.alloc(4096, 7));
  // Pin an mtime so preservation can be asserted exactly.
  utimesSync(join(source, "a.txt"), 1_700_000_000, 1_700_000_000);
  return source;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lama346-"));
});

afterEach(() => {
  try {
    chmodSync(root, 0o755);
  } catch {
    /* ignore */
  }
  rmSync(root, { recursive: true, force: true });
});

describe("parseVerboseMemberLine", () => {
  test("reads the type and the name from a GNU tar listing line", () => {
    expect(parseVerboseMemberLine("-rw-r--r-- 1000/1000  6 2026-09-22 17:57 ./a.txt")).toEqual({
      type: "-",
      name: "./a.txt",
    });
    expect(parseVerboseMemberLine("drwxr-xr-x 0/0  0 2026-09-22 17:57:03 ./sub/")).toEqual({
      type: "d",
      name: "./sub/",
    });
    expect(parseVerboseMemberLine("lrwxrwxrwx 1/1 0 2026-09-22 17:57 link -> /etc/passwd")?.type).toBe("l");
    expect(parseVerboseMemberLine("not a tar line")).toBeNull();
  });
});

describe("manifest", () => {
  test("counts files, directories and bytes and is stable across runs", async () => {
    const source = fixture();
    const first = await buildSeedManifest(source);
    const second = await buildSeedManifest(source);
    expect(first.fileCount).toBe(3);
    // `sub` and `sub/deep`; the root itself is not an entry.
    expect(first.dirCount).toBe(2);
    expect(first.totalBytes).toBe(6 + 6 + 4096);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.statsFingerprint).toBe(second.statsFingerprint);
    expect(first.excluded).toEqual([]);
  });

  test("records symlinks as excluded instead of archiving them", async () => {
    const source = fixture();
    symlinkSync("/etc/passwd", join(source, "link"));
    const manifest = await buildSeedManifest(source);
    expect(manifest.excluded).toEqual([{ path: "link", reason: "symlink" }]);
    expect(manifest.entries.some((e) => e.path === "link")).toBe(false);
  });

  test("stats fingerprint changes when a file changes", async () => {
    const source = fixture();
    const before = buildStatsFingerprint(source);
    writeFileSync(join(source, "a.txt"), "alpha changed\n");
    expect(buildStatsFingerprint(source)).not.toBe(before);
  });
});

describe("archive argument construction", () => {
  test("prefers the explicit compressor flag and keeps mtimes", () => {
    const zstd = archiveCreateArgs({ format: "tar.zstd", sourceRoot: "/src", outputPath: "/o.tar.zst" });
    expect(zstd).toContain("--zstd");
    expect(zstd).toContain("--verbose");
    // Reproducibility flags that would destroy bisync's size+modtime
    // comparison must never be present.
    expect(zstd).not.toContain("--mtime=@0");
    const gz = archiveCreateArgs({ format: "tar.gz", sourceRoot: "/src", outputPath: "/o.tar.gz" });
    expect(gz).toContain("--gzip");
  });

  test("extraction never restores ownership or setuid bits", () => {
    const args = archiveExtractArgs({ format: "tar.gz", archivePath: "/a", stagingDir: "/s" });
    expect(args).toContain("--no-same-owner");
    expect(args).toContain("--no-same-permissions");
    expect(args).toContain("--no-overwrite-dir");
    expect(args).toContain("--verbose");
  });

  test("listing asks for numeric owners so the parse is stable", () => {
    expect(archiveListArgs({ format: "tar.zstd", archivePath: "/a" })).toContain("--numeric-owner");
  });
});

describe("tooling detection", () => {
  test("detects tar and gzip on this host", async () => {
    const tooling = await detectArchiveTooling();
    expect(tooling.tar).toBe(true);
    expect(tooling.gzip).toBe(true);
  });
});

const tooling = await detectArchiveTooling();
const formats = tooling.zstd ? (["tar.zstd", "tar.gz"] as const) : (["tar.gz"] as const);

for (const format of formats) {
  describe(`seed archive pipeline — ${format}`, () => {
    test("creates, validates, extracts, verifies and publishes atomically", async () => {
      const source = fixture();
      const manifest = await buildSeedManifest(source);
      const archivePath = join(root, `payload${format === "tar.zstd" ? ".tar.zst" : ".tar.gz"}`);
      let archiveProgress = 0;
      const created = await createSeedArchive({
        format,
        sourceRoot: source,
        outputPath: archivePath,
        onProgress: (n) => {
          archiveProgress = n;
        },
      });
      expect(created.ok).toBe(true);
      expect(created.churned).toBe(false);
      expect(created.bytes).toBeGreaterThan(0);
      expect(created.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(archiveProgress).toBeGreaterThan(0);

      const validation = await validateSeedArchive({ format, archivePath });
      expect(validation.ok).toBe(true);
      // tar also emits the archive root (`./`), so the member count is the
      // manifest entry count plus one.
      expect(validation.members.count).toBe(manifest.entries.length + 1);
      expect(validation.offenders).toEqual([]);

      // Staging is a sibling of the target, never inside it.
      const targetPath = join(root, "target");
      const stagingDir = join(root, ".lamasync-seed-staging-target-job1");
      const policy = validateStagingLocation({ stagingPath: stagingDir, targetPath });
      expect(policy.ok).toBe(true);
      // The executor's pre-sync mkdir leaves an empty target behind.
      mkdirSync(targetPath);

      const extracted = await extractSeedArchive({ format, archivePath, stagingDir });
      expect(extracted.ok).toBe(true);
      expect(extracted.membersExtracted).toBeGreaterThan(0);

      const verified = await verifyExtractedTree({ root: stagingDir, manifest });
      expect(verified.ok).toBe(true);
      expect(verified.mismatches).toEqual([]);

      const published = publishStagedTree({ stagingDir, targetPath });
      expect(published.ok).toBe(true);
      expect(readFileSync(join(targetPath, "a.txt"), "utf8")).toBe("alpha\n");
      expect(readdirSync(join(targetPath, "sub", "deep"))).toEqual(["c.bin"]);
      // mtime survives: bisync compares size + modtime, so a seed that reset
      // mtimes would trigger a full re-copy.
      expect(Math.round(statSync(join(targetPath, "a.txt")).mtimeMs / 1000)).toBe(1_700_000_000);
      // The staging directory is gone after publication.
      expect(readdirSync(root).includes(".lamasync-seed-staging-target-job1")).toBe(false);
    });

    test("refuses a non-empty target rather than merging", async () => {
      const source = fixture();
      const archivePath = join(root, "p.tar.gz");
      await createSeedArchive({ format: "tar.gz", sourceRoot: source, outputPath: archivePath });
      const targetPath = join(root, "target");
      const stagingDir = join(root, "staging");
      await extractSeedArchive({ format: "tar.gz", archivePath, stagingDir });
      mkdirSync(targetPath);
      writeFileSync(join(targetPath, "existing.txt"), "keep me");
      const published = publishStagedTree({ stagingDir, targetPath });
      expect(published.ok).toBe(false);
      expect(published.error).toContain("already contains files");
      expect(readFileSync(join(targetPath, "existing.txt"), "utf8")).toBe("keep me");
    });
  });
}

describe("fail-closed safety paths", () => {
  test("a traversal member aborts validation", async () => {
    const source = fixture();
    const evil = join(root, "evil.tar.gz");
    // Craft a member named `../escape.txt` with tar's own transform.
    await defaultSeedCommandRunner([
      "tar",
      "--create",
      "--file",
      evil,
      "--gzip",
      "--transform=s|^\\./a.txt$|../escape.txt|",
      "--directory",
      source,
      ".",
    ]);
    const validation = await validateSeedArchive({ format: "tar.gz", archivePath: evil });
    expect(validation.ok).toBe(false);
    expect(validation.offenders.some((o) => o.includes("escape.txt"))).toBe(true);
  });

  test("a symlink member aborts validation", async () => {
    const source = fixture();
    symlinkSync("/etc/passwd", join(source, "link"));
    const linkArchive = join(root, "link.tar.gz");
    await defaultSeedCommandRunner([
      "tar",
      "--create",
      "--file",
      linkArchive,
      "--gzip",
      "--directory",
      source,
      "link",
    ]);
    const validation = await validateSeedArchive({ format: "tar.gz", archivePath: linkArchive });
    expect(validation.ok).toBe(false);
    expect(validation.message).toContain("not regular files or directories");
  });

  test("an unlistable archive fails instead of being trusted", async () => {
    const bad = join(root, "not-an-archive.tar.gz");
    writeFileSync(bad, "definitely not a tarball");
    const validation = await validateSeedArchive({ format: "tar.gz", archivePath: bad });
    expect(validation.ok).toBe(false);
    expect(validation.message).toContain("could not be listed");
  });

  test("source churn during archiving is detected and fails the archive", async () => {
    const source = fixture();
    const archivePath = join(root, "churn.tar.gz");
    const churningRunner: SeedCommandRunner = async (args, opts) => {
      // Mutate the tree between the pre- and post-archive fingerprints.
      writeFileSync(join(source, "a.txt"), "changed mid-archive\n");
      return defaultSeedCommandRunner(args, opts);
    };
    const created = await createSeedArchive({
      format: "tar.gz",
      sourceRoot: source,
      outputPath: archivePath,
      runner: churningRunner,
    });
    expect(created.churned).toBe(true);
    expect(created.ok).toBe(false);
    expect(created.error).toContain("changed while it was being archived");
  });

  test("verification catches a corrupted extracted tree", async () => {
    const source = fixture();
    const manifest = await buildSeedManifest(source);
    const archivePath = join(root, "p.tar.gz");
    await createSeedArchive({ format: "tar.gz", sourceRoot: source, outputPath: archivePath });
    const stagingDir = join(root, "staging");
    await extractSeedArchive({ format: "tar.gz", archivePath, stagingDir });
    // Corrupt one file and add an unexpected one.
    writeFileSync(join(stagingDir, "a.txt"), "tampered\n");
    writeFileSync(join(stagingDir, "extra.txt"), "surprise\n");
    const verified = await verifyExtractedTree({ root: stagingDir, manifest });
    expect(verified.ok).toBe(false);
    expect(verified.mismatches.some((m) => m.includes("size mismatch: a.txt"))).toBe(true);
    expect(verified.mismatches.some((m) => m.includes("unexpected entry: extra.txt"))).toBe(true);
  });

  test("staging inside the target is refused by the publish step too", async () => {
    const targetPath = join(root, "target");
    const stagingDir = join(targetPath, "staging");
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "a.txt"), "x");
    const published = publishStagedTree({ stagingDir, targetPath });
    expect(published.ok).toBe(false);
    expect(published.error).toContain("inside the final target");
  });
});

describe("preflight", () => {
  test("measures the source, checks staging and computes the reservation", async () => {
    const source = fixture();
    const targetPath = join(root, "target");
    mkdirSync(targetPath);
    const stagingDir = join(root, ".lamasync-seed-staging-target-job1");
    const preflight = await seedPreflight({
      sourceRoot: source,
      targetPath,
      stagingDir,
      tooling: { tar: true, zstd: true, gzip: true },
      format: "tar.zstd",
    });
    expect(preflight.manifest?.fileCount).toBe(3);
    expect(preflight.space).not.toBeNull();
    expect(preflight.space!.sourceBytes).toBe(4108);
    expect(preflight.errors).toEqual([]);
    expect(preflight.ok).toBe(true);
  });

  test("reports an unsafe staging location as an error", async () => {
    const source = fixture();
    const targetPath = join(root, "target");
    mkdirSync(targetPath);
    const preflight = await seedPreflight({
      sourceRoot: source,
      targetPath,
      stagingDir: join(targetPath, "staging"),
      tooling: { tar: true, zstd: false, gzip: true },
      format: "tar.gz",
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.errors.some((e) => e.includes("inside the final target"))).toBe(true);
  });
});
