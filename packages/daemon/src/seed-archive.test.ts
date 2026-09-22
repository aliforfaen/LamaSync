// LAMA-346: end-to-end tests for the seed archive primitives, driven with the
// real GNU tar on this host against a fixture tree. No rclone, no network.
//
// The pipeline under test is exactly the local half of a seed:
//
//   fixture tree + effective filter universe → manifest → tar(+zstd|gzip)
//                → member validation → extract into a sibling staging dir
//                → verify byte-for-byte → atomic rename into the final target
//
// plus the fail-closed paths: a member the universe includes but a seed cannot
// represent (symlink), source churn during archiving, an archive that does not
// match the manifest, a traversal member, a non-empty target, staging inside
// the target, and staging that is not a true sibling.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
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
  normalizeArchiveMemberName,
  parseVerboseMemberLine,
  publishStagedTree,
  seedManifestBlockingReason,
  seedPreflight,
  validateSeedArchive,
  verifyExtractedTree,
  type SeedCommandRunner,
} from "./seed-archive.ts";
import {
  parentPathOf,
  validateStagingLocation,
  type SeedSourceFilterUniverse,
} from "@lamasync/core";

let root: string;

/** The whole tree — the universe a folder with no ignore rules would have. */
function allFilesFilter(): SeedSourceFilterUniverse {
  return { fingerprint: "test-universe-all", patterns: [], includes: () => true };
}

/**
 * The real-world shape: a folder whose ignore rules exclude a subtree. This is
 * what makes a Projects tree (whose nested `node_modules` hold symlinks)
 * seedable — the excluded subtree is never walked, so its symlinks never enter
 * the manifest.
 */
function excludePrefixFilter(prefix: string, fingerprint: string): SeedSourceFilterUniverse {
  return {
    fingerprint,
    patterns: [`- ${prefix}/**`],
    includes: (relativePath) => relativePath !== prefix && !relativePath.startsWith(`${prefix}/`),
  };
}

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

/**
 * A runner that rewrites the `--files-from` member list before delegating to
 * the real tar. It is the only remaining way to produce an archive that does
 * not match the manifest, which is exactly what the equality guard defends
 * against — so both directions of that guard stay testable.
 */
function rewriteMembersFileRunner(transform: (lines: string[]) => string[]): SeedCommandRunner {
  return async (args, opts) => {
    const index = args.indexOf("--files-from");
    const membersFile = args[index + 1];
    if (index < 0 || membersFile === undefined) {
      // Only the create call carries a member list; listing/extracting calls
      // must pass through untouched.
      return defaultSeedCommandRunner(args, opts);
    }
    const lines = readFileSync(membersFile, "utf8").split("\n").filter((line) => line.length > 0);
    const next = transform(lines);
    writeFileSync(membersFile, next.length > 0 ? `${next.join("\n")}\n` : "");
    return defaultSeedCommandRunner(args, opts);
  };
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

  test("normalizes tar's ./ and trailing-slash decorations", () => {
    expect(normalizeArchiveMemberName("./a.txt")).toBe("a.txt");
    expect(normalizeArchiveMemberName("./sub/")).toBe("sub");
    expect(normalizeArchiveMemberName("./")).toBe("");
    expect(normalizeArchiveMemberName("a.txt")).toBe("a.txt");
  });
});

describe("manifest", () => {
  test("counts files, directories and bytes and is stable across runs", async () => {
    const source = fixture();
    const first = await buildSeedManifest(source, { filter: allFilesFilter() });
    const second = await buildSeedManifest(source, { filter: allFilesFilter() });
    expect(first.fileCount).toBe(3);
    // `sub` and `sub/deep`; the root itself is not an entry.
    expect(first.dirCount).toBe(2);
    expect(first.totalBytes).toBe(6 + 6 + 4096);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.statsFingerprint).toBe(second.statsFingerprint);
    expect(first.unsupported).toEqual([]);
    expect(first.filter.fingerprint).toBe("test-universe-all");
    expect(first.filter.skippedCount).toBe(0);
  });

  test("records a symlink in the universe as UNSUPPORTED, never as silently excluded", async () => {
    const source = fixture();
    symlinkSync("/etc/passwd", join(source, "link"));
    const manifest = await buildSeedManifest(source, { filter: allFilesFilter() });
    expect(manifest.unsupported).toEqual([{ path: "link", reason: "symlink" }]);
    expect(manifest.entries.some((e) => e.path === "link")).toBe(false);
    // And it BLOCKS the seed rather than being quietly dropped.
    const blocking = seedManifestBlockingReason(manifest);
    expect(blocking).not.toBeNull();
    expect(blocking).toContain("link (symlink)");
    expect(blocking).toContain("a seed never publishes a partial tree");
  });

  test("the effective filter universe prunes a subtree, so its symlinks never enter the manifest", async () => {
    // The real shape: nested node_modules under a Projects worktree.
    const source = fixture();
    mkdirSync(join(source, "worktree", "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(source, "worktree", "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    symlinkSync("pkg", join(source, "worktree", "node_modules", ".bin-link"));
    symlinkSync("/etc/passwd", join(source, "worktree", "node_modules", "abs-link"));

    // Without the exclude the folder cannot be seeded at all.
    const raw = await buildSeedManifest(source, { filter: allFilesFilter() });
    expect(raw.unsupported.map((m) => m.path)).toEqual([
      "worktree/node_modules/.bin-link",
      "worktree/node_modules/abs-link",
    ]);
    expect(seedManifestBlockingReason(raw)).not.toBeNull();

    // With the folder's ignore rules the subtree is pruned before it is
    // walked, so the same tree becomes seedable.
    const filtered = await buildSeedManifest(source, {
      filter: excludePrefixFilter("worktree/node_modules", "universe-excluding-node-modules"),
    });
    expect(filtered.unsupported).toEqual([]);
    expect(seedManifestBlockingReason(filtered)).toBeNull();
    expect(filtered.filter.fingerprint).toBe("universe-excluding-node-modules");
    expect(filtered.filter.skippedCount).toBe(1);
    expect(filtered.filter.skippedSample).toEqual(["worktree/node_modules"]);
    // The excluded subtree contributed nothing to the size.
    expect(filtered.entries.some((e) => e.path.startsWith("worktree/node_modules"))).toBe(false);
  });

  test("stats fingerprint changes when a file changes", async () => {
    const source = fixture();
    const before = buildStatsFingerprint(source);
    writeFileSync(join(source, "a.txt"), "alpha changed\n");
    expect(buildStatsFingerprint(source)).not.toBe(before);
  });
});

describe("archive argument construction", () => {
  test("archives exactly the manifest's member list, never the raw tree", () => {
    const zstd = archiveCreateArgs({
      format: "tar.zstd",
      sourceRoot: "/src",
      outputPath: "/o.tar.zst",
      membersFilePath: "/o.members",
    });
    expect(zstd).toContain("--zstd");
    expect(zstd).toContain("--verbose");
    // The member list is the archive's contract, and `--no-recursion` is what
    // makes it authoritative: without it tar would descend into every listed
    // directory and re-archive the content the filter universe excludes.
    expect(zstd).toContain("--files-from");
    expect(zstd).toContain("/o.members");
    expect(zstd).toContain("--no-recursion");
    expect(zstd).not.toContain(".");
    // Reproducibility flags that would destroy bisync's size+modtime
    // comparison must never be present.
    expect(zstd).not.toContain("--mtime=@0");
    const gz = archiveCreateArgs({
      format: "tar.gz",
      sourceRoot: "/src",
      outputPath: "/o.tar.gz",
      membersFilePath: "/o.members",
    });
    expect(gz).toContain("--gzip");
    expect(gz).toContain("--no-recursion");
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
      const manifest = await buildSeedManifest(source, { filter: allFilesFilter() });
      const archivePath = join(root, `payload${format === "tar.zstd" ? ".tar.zst" : ".tar.gz"}`);
      let archiveProgress = 0;
      const created = await createSeedArchive({
        format,
        sourceRoot: source,
        outputPath: archivePath,
        manifest,
        filter: allFilesFilter(),
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
      // The archive root (`./`) is the target directory itself, so the member
      // set is exactly the manifest's entries.
      expect(validation.members.count).toBe(manifest.entries.length);
      expect(validation.offenders).toEqual([]);

      // Staging is a sibling of the target, never inside it.
      const targetPath = join(root, "target");
      const stagingDir = join(root, ".lamasync-seed-staging-target-job1");
      const policy = validateStagingLocation({
        stagingPath: stagingDir,
        targetPath,
        sameFilesystemProven: true,
      });
      expect(policy.ok).toBe(true);
      expect(policy.adjacentToTarget).toBe(true);
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
      const manifest = await buildSeedManifest(source, { filter: allFilesFilter() });
      const archivePath = join(root, "p.tar.gz");
      await createSeedArchive({
        format: "tar.gz",
        sourceRoot: source,
        outputPath: archivePath,
        manifest,
        filter: allFilesFilter(),
      });
      const targetPath = join(root, "target");
      const stagingDir = join(root, ".lamasync-seed-staging-target-job1");
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
  test("create REFUSES a symlink in the universe before tar ever runs", async () => {
    const source = fixture();
    symlinkSync("/etc/passwd", join(source, "link"));
    const manifest = await buildSeedManifest(source, { filter: allFilesFilter() });
    const archivePath = join(root, "link.tar.gz");
    let runnerCalled = false;
    const spyRunner: SeedCommandRunner = async (args, opts) => {
      runnerCalled = true;
      return defaultSeedCommandRunner(args, opts);
    };
    const created = await createSeedArchive({
      format: "tar.gz",
      sourceRoot: source,
      outputPath: archivePath,
      manifest,
      filter: allFilesFilter(),
      runner: spyRunner,
    });
    expect(created.ok).toBe(false);
    expect(created.error).toContain("link (symlink)");
    // The whole point: no archive was built from an unrepresentable universe.
    expect(runnerCalled).toBe(false);
    expect(existsSync(archivePath)).toBe(false);
  });

  test("the archive never contains content the effective filter universe excludes", async () => {
    const source = fixture();
    // The real-world shape: a subtree the folder's ignore rules exclude (where
    // a Projects tree keeps its nested node_modules and their symlinks).
    mkdirSync(join(source, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(source, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    symlinkSync("../../a.txt", join(source, "node_modules", "pkg", "link.txt"));

    const filter = excludePrefixFilter("node_modules", "universe-excluding-node-modules");
    const manifest = await buildSeedManifest(source, { filter });
    // The excluded subtree is never walked, so its symlink never appears.
    expect(manifest.unsupported).toEqual([]);
    expect(manifest.entries.some((e) => e.path.startsWith("node_modules"))).toBe(false);
    expect(manifest.filter.skippedSample).toContain("node_modules");

    const archivePath = join(root, "filtered.tar.gz");
    const created = await createSeedArchive({
      format: "tar.gz",
      sourceRoot: source,
      outputPath: archivePath,
      manifest,
      filter,
    });
    expect(created.ok).toBe(true);
    expect(created.error).toBeNull();

    // The archive's member set is EXACTLY the manifest's — tar was given the
    // manifest's paths and nothing else, so the excluded subtree cannot leak in.
    const validation = await validateSeedArchive({ format: "tar.gz", archivePath });
    expect(validation.ok).toBe(true);
    expect(validation.members.count).toBe(manifest.entries.length);
    expect(validation.members.sample.some((m) => m.startsWith("node_modules"))).toBe(false);

    // And the published tree contains no trace of it either.
    const stagingDir = join(root, ".lamasync-seed-staging-target-job1");
    await extractSeedArchive({ format: "tar.gz", archivePath, stagingDir });
    expect(existsSync(join(stagingDir, "node_modules"))).toBe(false);
    const verified = await verifyExtractedTree({ root: stagingDir, manifest });
    expect(verified.ok).toBe(true);
  });

  test("the member-list file is removed whether tar succeeds or fails", async () => {
    const source = fixture();
    const manifest = await buildSeedManifest(source, { filter: allFilesFilter() });
    const archivePath = join(root, "cleanup.tar.gz");
    await createSeedArchive({
      format: "tar.gz",
      sourceRoot: source,
      outputPath: archivePath,
      manifest,
      filter: allFilesFilter(),
      runner: async () => ({ exitCode: 1, stdout: "", stderr: "simulated failure" }),
    });
    expect(existsSync(`${archivePath}.members`)).toBe(false);
  });

  test("create REFUSES an archive missing a manifest member", async () => {
    const source = fixture();
    const manifest = await buildSeedManifest(source, { filter: allFilesFilter() });
    const archivePath = join(root, "missing.tar.gz");
    // Drop one path from the member list tar is given: the archive then lacks
    // content the manifest promised, which must fail closed.
    const created = await createSeedArchive({
      format: "tar.gz",
      sourceRoot: source,
      outputPath: archivePath,
      manifest,
      filter: allFilesFilter(),
      runner: rewriteMembersFileRunner((lines) => lines.filter((line) => line !== "a.txt")),
    });
    expect(created.ok).toBe(false);
    expect(created.error).toContain("does not match the source manifest");
    expect(created.error).toContain("content the manifest requires but the archive lacks");
    // The inconsistent archive is not left behind to be uploaded.
    expect(existsSync(archivePath)).toBe(false);
  });

  test("create REFUSES an archive with content the manifest does not describe", async () => {
    const source = fixture();
    const manifest = await buildSeedManifest(source, { filter: allFilesFilter() });
    // A file that appears AFTER the manifest was measured: the manifest does
    // not describe it, so an archive carrying it must fail closed.
    writeFileSync(join(source, "late.txt"), "appeared after the manifest\n");
    const archivePath = join(root, "extra.tar.gz");
    const created = await createSeedArchive({
      format: "tar.gz",
      sourceRoot: source,
      outputPath: archivePath,
      manifest,
      filter: allFilesFilter(),
      runner: rewriteMembersFileRunner((lines) => [...lines, "late.txt"]),
    });
    expect(created.ok).toBe(false);
    expect(created.error).toContain("does not match the source manifest");
    expect(created.error).toContain("content the manifest does not describe");
    expect(existsSync(archivePath)).toBe(false);
  });

  test("churn OUTSIDE the universe does not fail the archive", async () => {
    const source = fixture();
    mkdirSync(join(source, "node_modules"), { recursive: true });
    writeFileSync(join(source, "node_modules", "junk.js"), "junk\n");
    const filter = excludePrefixFilter("node_modules", "universe-excluding-node-modules");
    const manifest = await buildSeedManifest(source, { filter });
    const archivePath = join(root, "outside-churn.tar.gz");
    const created = await createSeedArchive({
      format: "tar.gz",
      sourceRoot: source,
      outputPath: archivePath,
      manifest,
      filter,
      runner: async (args, opts) => {
        // Excluded content changing mid-archive is not a seed problem.
        writeFileSync(join(source, "node_modules", "junk.js"), "junk changed\n");
        return defaultSeedCommandRunner(args, opts);
      },
    });
    expect(created.churned).toBe(false);
    expect(created.ok).toBe(true);
  });

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
    const manifest = await buildSeedManifest(source, { filter: allFilesFilter() });
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
      manifest,
      filter: allFilesFilter(),
      runner: churningRunner,
    });
    expect(created.churned).toBe(true);
    expect(created.ok).toBe(false);
    expect(created.error).toContain("changed while it was being archived");
  });

  test("verification catches a corrupted extracted tree", async () => {
    const source = fixture();
    const manifest = await buildSeedManifest(source, { filter: allFilesFilter() });
    const archivePath = join(root, "p.tar.gz");
    await createSeedArchive({
      format: "tar.gz",
      sourceRoot: source,
      outputPath: archivePath,
      manifest,
      filter: allFilesFilter(),
    });
    const stagingDir = join(root, ".lamasync-seed-staging-target-job1");
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

  test("staging that is not a true sibling is refused by the publish step too", async () => {
    const targetPath = join(root, "target");
    mkdirSync(targetPath);
    // Same device, outside the target, but NOT in the target's parent — the
    // exact shape the sibling rule exists to reject.
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const stagingDir = join(elsewhere, ".lamasync-seed-staging-target-job1");
    mkdirSync(stagingDir);
    writeFileSync(join(stagingDir, "a.txt"), "x");
    const published = publishStagedTree({ stagingDir, targetPath });
    expect(published.ok).toBe(false);
    expect(published.error).toContain("not a sibling of the target");
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
      filter: allFilesFilter(),
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
      filter: allFilesFilter(),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.errors.some((e) => e.includes("inside the final target"))).toBe(true);
  });

  test("reports an unrepresentable universe as an error, not as a silent skip", async () => {
    const source = fixture();
    symlinkSync("/etc/passwd", join(source, "link"));
    const targetPath = join(root, "target");
    mkdirSync(targetPath);
    const preflight = await seedPreflight({
      sourceRoot: source,
      targetPath,
      stagingDir: join(root, ".lamasync-seed-staging-target-job1"),
      tooling: { tar: true, zstd: false, gzip: true },
      format: "tar.gz",
      filter: allFilesFilter(),
    });
    expect(preflight.ok).toBe(false);
    expect(preflight.errors.some((e) => e.includes("a seed never publishes a partial tree"))).toBe(true);
  });
});

describe("staging sibling rule", () => {
  test("parentPathOf is the directory that must hold the staging sibling", () => {
    expect(parentPathOf("/data/projects")).toBe("/data");
    expect(parentPathOf("/data/a/b/")).toBe("/data/a");
    expect(parentPathOf("/data")).toBe("/");
    expect(parentPathOf("relative/path")).toBeNull();
  });

  test("rejects /data/elsewhere for a /data/projects target even on the same device", () => {
    const verdict = validateStagingLocation({
      stagingPath: "/data/elsewhere/staging",
      targetPath: "/data/projects",
      sameFilesystemProven: true,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.adjacentToTarget).toBe(false);
    expect(verdict.insideTarget).toBe(false);
    expect(verdict.message).toContain("not a sibling of the target");
  });

  test("accepts a sibling and requires a PROVEN same filesystem", () => {
    const ok = validateStagingLocation({
      stagingPath: "/data/.lamasync-seed-staging-projects-job1",
      targetPath: "/data/projects",
      sameFilesystemProven: true,
    });
    expect(ok.ok).toBe(true);
    expect(ok.adjacentToTarget).toBe(true);
    expect(ok.sameFilesystem).toBe(true);

    // Unknown is refused, never assumed.
    const unknown = validateStagingLocation({
      stagingPath: "/data/.lamasync-seed-staging-projects-job1",
      targetPath: "/data/projects",
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.sameFilesystem).toBeNull();
    expect(unknown.message).toContain("has not confirmed");
  });
});
