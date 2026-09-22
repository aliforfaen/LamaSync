// LAMA-346 Stage 1a — the seed's effective filter universe.
//
// The claim these tests defend is narrow and load-bearing: the set of paths a
// seed archives is EXACTLY the set the following bisync considers its
// synchronization universe. That set is decided by the `--filter-from` rule
// lines the executor writes, so the tests below check the compiler against
// rclone's own behaviour (with a real binary when one is on PATH) and check the
// end-to-end fixture — a Projects-shaped tree with nested `node_modules`
// symlinks — against the manifest and the archive.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildSeedFilterUniverse,
  buildSeedSourceManifest,
  compileRcloneFilterRules,
  effectiveSyncFilterRuleLines,
  filterRulesFingerprint,
  parseRcloneFilterRule,
  rcloneGlobToRegexSource,
  universePathIncluded,
} from "./seed-filter-universe.ts";
import {
  buildSeedManifest,
  createSeedArchive,
  detectArchiveTooling,
  seedManifestBlockingReason,
  validateSeedArchive,
} from "./seed-archive.ts";
import type { FolderAssignment } from "@lamasync/core";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lama346-universe-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function assignment(overrides: Partial<FolderAssignment> = {}): FolderAssignment {
  return {
    id: "a1",
    folderId: "f1",
    hostId: "dev-vm",
    role: "both",
    localPath: root,
    enabled: true,
    ...overrides,
  };
}

/** Write a `.lamasyncignore` inside `root` and return its relative path. */
function writeIgnoreFile(lines: string[]): string {
  writeFileSync(join(root, ".lamasyncignore"), `${lines.join("\n")}\n`);
  return ".lamasyncignore";
}

describe("rclone rule parsing", () => {
  test("comments and blank lines are not rules", () => {
    expect(parseRcloneFilterRule("")).toEqual({ ok: true, rule: null });
    expect(parseRcloneFilterRule("   ")).toEqual({ ok: true, rule: null });
    expect(parseRcloneFilterRule("# a comment")).toEqual({ ok: true, rule: null });
    expect(parseRcloneFilterRule("; also a comment")).toEqual({ ok: true, rule: null });
  });

  test("a rule needs a sign AND exactly one space — rclone aborts otherwise", () => {
    expect(parseRcloneFilterRule("-a.txt").ok).toBe(false);
    expect(parseRcloneFilterRule("+a.txt").ok).toBe(false);
    expect(parseRcloneFilterRule("a.txt").ok).toBe(false);
    // rclone consumes the sign and ONE space, so a second space is part of the
    // pattern (verified against rclone: `-  a.txt` excludes nothing).
    const doubleSpace = parseRcloneFilterRule("-  a.txt");
    expect(doubleSpace.ok).toBe(true);
    expect(doubleSpace.ok && doubleSpace.rule?.pattern).toBe(" a.txt");
  });

  test("a trailing semicolon is part of the pattern, not a comment", () => {
    const parsed = parseRcloneFilterRule("- a.txt;");
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.rule?.pattern).toBe("a.txt;");
  });

  test("a malformed regex is refused, never treated as a glob", () => {
    const parsed = parseRcloneFilterRule("- {{[unclosed}}");
    expect(parsed.ok).toBe(false);
  });
});

describe("rclone glob translation", () => {
  test("`*` and `?` stay inside one path segment, `**` crosses", () => {
    expect(rcloneGlobToRegexSource("*.txt")).toBe("[^/]*\\.txt");
    expect(rcloneGlobToRegexSource("a?c")).toBe("a[^/]c");
    expect(rcloneGlobToRegexSource("a/**")).toBe("a/.*");
    expect(rcloneGlobToRegexSource("**/*.log")).toBe(".*/[^/]*\\.log");
  });

  test("a character class passes through and other metacharacters are escaped", () => {
    expect(rcloneGlobToRegexSource("[ab].txt")).toBe("[ab]\\.txt");
    expect(rcloneGlobToRegexSource("a+b(c)")).toBe("a\\+b\\(c\\)");
  });
});

describe("rclone filter semantics", () => {
  /** True when the rules EXCLUDE `rel` — i.e. it is not in the universe. */
  function excluded(rules: string[], rel: string, isDir = false): boolean {
    const compiled = compileRcloneFilterRules(rules);
    expect(compiled.ok).toBe(true);
    return !compiled.includes(rel, isDir);
  }

  test("the FIRST matching rule wins, and an unmatched path is included", () => {
    expect(excluded(["- *.txt", "+ sub/a.txt"], "sub/a.txt")).toBe(true);
    expect(excluded(["+ sub/a.txt", "- *.txt"], "sub/a.txt")).toBe(false);
    expect(excluded(["+ sub/a.txt", "- *.txt"], "other.txt")).toBe(true);
    // Default include: nothing matched `keep.bin`.
    expect(excluded(["+ sub/a.txt", "- *.txt"], "keep.bin")).toBe(false);
  });

  test("a pattern with a slash is root-relative; a bare name matches at any depth", () => {
    expect(excluded(["- a.txt"], "a.txt")).toBe(true);
    expect(excluded(["- a.txt"], "sub/a.txt")).toBe(true);
    expect(excluded(["- a.txt"], "x/deep/a.txt")).toBe(true);
    expect(excluded(["- sub/a.txt"], "sub/a.txt")).toBe(true);
    // A slash anywhere anchors it to the root...
    expect(excluded(["- sub/a.txt"], "deep/sub/a.txt")).toBe(false);
    // ...and so does a leading slash.
    expect(excluded(["- /sub/a.txt"], "sub/a.txt")).toBe(true);
    expect(excluded(["- /sub/a.txt"], "deep/sub/a.txt")).toBe(false);
  });

  test("only a trailing-slash rule can match a directory", () => {
    // `- node_modules/` prunes the DIRECTORY...
    expect(excluded(["- node_modules/"], "node_modules", true)).toBe(true);
    // ...but not a FILE of the same name.
    expect(excluded(["- node_modules/"], "node_modules", false)).toBe(false);
    // And a bare name never matches the directory, which is why `- node_modules`
    // does NOT prune the subtree.
    expect(excluded(["- node_modules"], "node_modules", true)).toBe(false);
    expect(excluded(["- node_modules"], "node_modules", false)).toBe(true);
  });

  test("`{{...}}` is prefix-anchored at any depth and must consume the whole path", () => {
    expect(excluded(["- {{a\\.txt$}}"], "a.txt")).toBe(true);
    expect(excluded(["- {{a\\.txt$}}"], "sub/a.txt")).toBe(true);
    expect(excluded(["- {{a\\.txt$}}"], "b.log")).toBe(false);
    // Verified against rclone: a partial match does NOT exclude, and a regex
    // rule never matches a directory.
    expect(excluded(["- {{sub/inner}}"], "sub/inner/g.bin")).toBe(false);
    expect(excluded(["- {{sub/inner}}"], "sub/inner", true)).toBe(false);
    expect(excluded(["- {{^sub$}}"], "sub", true)).toBe(false);
    expect(excluded(["- {{^sub$}}"], "sub/a.txt")).toBe(false);
    // The user can anchor it themselves.
    expect(excluded(["- {{^sub/inner$}}"], "sub/inner", true)).toBe(false);
  });

  test("a malformed rule makes the whole rule set unusable", () => {
    const compiled = compileRcloneFilterRules(["- node_modules/", "-broken"]);
    expect(compiled.ok).toBe(false);
    expect(compiled.errors[0]).toContain("malformed rule");
  });

  test("rule fingerprints change with the rule list", () => {
    expect(filterRulesFingerprint(["- a"])).not.toBe(filterRulesFingerprint(["- b"]));
    expect(filterRulesFingerprint(["- a"])).toBe(filterRulesFingerprint(["- a"]));
  });
});

describe("the effective rule lines an assignment produces", () => {
  test("ignoreGitMetadata prepends `- .git/**` to the configured patterns", () => {
    mkdirSync(join(root, "sub"), { recursive: true });
    const ignorePath = writeIgnoreFile(["- node_modules/", "# comment"]);
    const info = effectiveSyncFilterRuleLines(
      assignment({ ignorePath, ignoreGitMetadata: true }),
      "sync",
    );
    expect(info.patterns).toEqual(["- .git/**", "- node_modules/"]);
    expect(info.gitignoreRules).toBeNull();
    expect(info.rules).toEqual(["- .git/**", "- node_modules/"]);
    expect(info.errors).toEqual([]);
  });

  test("respectGitignore prepends the Git-ignore snapshot and keeps the patterns after it", () => {
    mkdirSync(join(root, "build"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "build/\n");
    const ignorePath = writeIgnoreFile(["- node_modules/"]);
    const info = effectiveSyncFilterRuleLines(
      assignment({ ignorePath, respectGitignore: true }),
      "sync",
    );
    expect(info.gitignoreRules).toEqual(["- build/"]);
    // Order matters: rclone's first match wins, and this is the order the
    // executor writes into its `--filter-from` file.
    expect(info.rules).toEqual(["- build/", "- node_modules/"]);
  });
});

describe("the universe of a Projects-shaped tree", () => {
  /** A tree with nested `node_modules` (holding symlinks), ignored content and real content. */
  function projectsFixture(): void {
    mkdirSync(join(root, "repo", "src"), { recursive: true });
    mkdirSync(join(root, "repo", "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "repo", "src", "index.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "repo", "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(root, ".git", "config"), "[core]\n");
    writeFileSync(join(root, "notes.log"), "ignore me\n");
    // The real-world shape: a symlink INSIDE the excluded subtree.
    symlinkSync("index.js", join(root, "repo", "node_modules", "pkg", "link.js"));
  }

  test("an excluded subtree is pruned, so its symlinks never enter the manifest", async () => {
    projectsFixture();
    const ignorePath = writeIgnoreFile(["- node_modules/", "- *.log"]);
    const built = buildSeedFilterUniverse(
      assignment({ ignorePath, ignoreGitMetadata: true }),
      "sync",
    );
    expect(built.errors).toEqual([]);
    expect(universePathIncluded(built.universe.includes, "repo", true)).toBe(true);
    expect(universePathIncluded(built.universe.includes, "repo/node_modules", true)).toBe(false);
    // A trailing-slash rule only matches directories, so pruning is what
    // removes the subtree — exactly as rclone and the manifest walk do.
    expect(universePathIncluded(built.universe.includes, "repo/node_modules/pkg", true)).toBe(false);
    expect(universePathIncluded(built.universe.includes, "notes.log", false)).toBe(false);
    // `- .git/**` is not a trailing-slash rule, so it does not match the
    // directory itself — it excludes everything INSIDE it, and the now-empty
    // directory is pruned from the manifest rather than archived.
    expect(universePathIncluded(built.universe.includes, ".git", true)).toBe(true);
    expect(universePathIncluded(built.universe.includes, ".git/config", false)).toBe(false);

    const manifest = await buildSeedManifest(root, { filter: built.universe });
    // The symlink lives inside the pruned subtree, so the seed never sees it.
    expect(manifest.unsupported).toEqual([]);
    // `.lamasyncignore` is itself part of the synced universe (the fleet syncs
    // it on purpose), so only the pruned subtree and the ignored log are gone.
    expect(manifest.entries.map((e) => e.path)).toEqual([
      ".lamasyncignore",
      "repo",
      "repo/src",
      "repo/src/index.ts",
    ]);
    expect(manifest.emptyDirsPruned).toContain(".git");
    expect(manifest.filter.skippedSample).toContain("repo/node_modules");
    expect(manifest.filter.fingerprint).toBe(built.universe.fingerprint);
  });

  test("a filter-included symlink still fails closed before any archive work", async () => {
    projectsFixture();
    // No ignore rules at all: the symlink is inside the universe now.
    const built = buildSeedFilterUniverse(assignment(), "sync");
    expect(built.errors).toEqual([]);
    const manifest = await buildSeedManifest(root, { filter: built.universe });
    expect(manifest.unsupported).toEqual([
      { path: "repo/node_modules/pkg/link.js", reason: "symlink" },
    ]);
  });

  test("the archive contains exactly the manifest's members, never the pruned subtree", async () => {
    const tooling = await detectArchiveTooling();
    if (!tooling.tar) return;
    projectsFixture();
    const ignorePath = writeIgnoreFile(["- node_modules/"]);
    const built = buildSeedFilterUniverse(
      assignment({ ignorePath, ignoreGitMetadata: true }),
      "sync",
    );
    const manifest = await buildSeedManifest(root, { filter: built.universe });
    const archivePath = join(root, "..", "seed.tar.gz");
    const created = await createSeedArchive({
      format: "tar.gz",
      sourceRoot: root,
      outputPath: archivePath,
      manifest,
      filter: built.universe,
    });
    expect(created.ok).toBe(true);
    const validation = await validateSeedArchive({ format: "tar.gz", archivePath });
    expect(validation.ok).toBe(true);
    expect(validation.members.count).toBe(manifest.entries.length);
    expect(validation.members.sample.some((m) => m.includes("node_modules"))).toBe(false);
    expect(existsSync(archivePath)).toBe(true);
    rmSync(archivePath, { force: true });
  });

  test("a malformed ignore rule fails the universe closed instead of guessing", () => {
    const ignorePath = writeIgnoreFile(["-node_modules/"]);
    const built = buildSeedFilterUniverse(assignment({ ignorePath }), "sync");
    expect(built.errors.length).toBeGreaterThan(0);
    expect(built.errors[0]).toContain("malformed rule");
  });

  test("an absent ignore file yields the all-including universe with a null fingerprint", () => {
    const built = buildSeedFilterUniverse(assignment(), "sync");
    expect(built.rules).toEqual([]);
    expect(built.fingerprint).toBeNull();
    expect(built.universe.fingerprint).toBe("none");
    expect(built.universe.includes("anything", false)).toBe(true);
  });

  test("the one entry point produces a manifest AND the universe the archive needs", async () => {
    projectsFixture();
    const ignorePath = writeIgnoreFile(["- node_modules/"]);
    const built = await buildSeedSourceManifest(
      assignment({ ignorePath, ignoreGitMetadata: true }),
      "sync",
    );
    expect(built.blocking).toEqual([]);
    expect(built.manifest).not.toBeNull();
    // The manifest carries the SAME universe fingerprint the caller will hand
    // to `createSeedArchive`, so the pair cannot drift apart.
    expect(built.manifest?.filter.fingerprint).toBe(built.universe.fingerprint);
    expect(built.manifest?.unsupported).toEqual([]);
    expect(built.manifest?.filter.patternCount).toBe(built.rules.length);
  });

  test("the one entry point fails closed on a malformed rule, with no manifest", async () => {
    projectsFixture();
    const ignorePath = writeIgnoreFile(["-node_modules/"]);
    const built = await buildSeedSourceManifest(assignment({ ignorePath }), "sync");
    expect(built.manifest).toBeNull();
    expect(built.blocking[0]).toContain("malformed rule");
  });

  test("the one entry point fails closed on an unrepresentable universe", async () => {
    projectsFixture();
    // No excludes: the nested symlink is inside the universe now, so the
    // manifest exists but says the seed cannot represent it.
    const built = await buildSeedSourceManifest(assignment(), "sync");
    expect(built.blocking).toEqual([]);
    expect(built.manifest?.unsupported.length).toBeGreaterThan(0);
    const reason = seedManifestBlockingReason(built.manifest!)!;
    expect(reason).toContain("cannot be represented");
    // The remedy names a pattern form that can actually match a symlink: a
    // trailing-slash rule only matches directories.
    expect(reason).toContain("only matches directories");
    expect(reason).toContain("- link.js");
  });

  test("the one entry point fails closed on an unreadable source root", async () => {
    const built = await buildSeedSourceManifest(
      assignment({ localPath: join(root, "does-not-exist") }),
      "sync",
    );
    expect(built.manifest).toBeNull();
    expect(built.blocking.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Fidelity cross-check against a real rclone
// ---------------------------------------------------------------------------

const RCLONE_AVAILABLE = (() => {
  try {
    const probe = Bun.spawnSync(["rclone", "version"], { stdout: "pipe", stderr: "pipe" });
    return probe.exitCode === 0;
  } catch {
    return false;
  }
})();

const CROSS_CHECK_TREE = [
  "a.txt",
  "b.log",
  "keep.bin",
  "sub/a.txt",
  "sub/b.log",
  "sub/deep/c.txt",
  "x/a.txt",
  "node_modules/pkg/index.js",
  "Abc/a.txt",
  "empty/deep/.keepme",
];

const CROSS_CHECK_RULES: string[][] = [
  ["- a.txt"],
  ["- /a.txt"],
  ["- *.log"],
  ["- sub/"],
  ["- sub"],
  ["- {{^sub$}}"],
  ["- {{sub/inner}}"],
  ["- {{inner}}"],
  ["- {{.*\\.txt$}}"],
  ["- sub/a.txt"],
  ["- /sub/a.txt"],
  ["- **/*.log"],
  ["- sub/**"],
  ["- [ab].txt"],
  ["- *.TXT"],
  ["- *.txt", "+ sub/a.txt"],
  ["+ sub/a.txt", "- *.txt"],
  ["- node_modules/"],
  ["- {{a\\.txt$}}"],
  ["# comment", "", "- *.log"],
  ["- a.txt", "+ a.txt"],
];

function crossCheckTreeFixture(base: string, entries: readonly string[]): void {
  for (const rel of entries) {
    const full = join(base, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, `${rel}\n`);
  }
}

/** The file set rclone itself includes for a rule list, as sorted relative paths. */
function rcloneIncludedFiles(base: string, rules: string[]): string[] {
  const filterFile = join(base, "..", `filter-${Math.random().toString(16).slice(2)}.txt`);
  writeFileSync(filterFile, rules.length > 0 ? `${rules.join("\n")}\n` : "");
  try {
    const result = Bun.spawnSync(
      ["rclone", "lsf", "--recursive", "--files-only", "--filter-from", filterFile, base],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `rclone lsf exited ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`,
      );
    }
    return new TextDecoder()
      .decode(result.stdout)
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .sort();
  } finally {
    rmSync(filterFile, { force: true });
  }
}

describe.skipIf(!RCLONE_AVAILABLE)("fidelity against the host's real rclone", () => {
  test("the compiler's universe equals rclone's own --filter-from membership", () => {
    crossCheckTreeFixture(root, CROSS_CHECK_TREE);
    for (const rules of CROSS_CHECK_RULES) {
      const compiled = compileRcloneFilterRules(rules);
      expect(compiled.ok).toBe(true);
      const mine = CROSS_CHECK_TREE.filter((rel) =>
        universePathIncluded(compiled.includes, rel, false),
      ).sort();
      const theirs = rcloneIncludedFiles(root, rules);
      expect({ rules, included: mine }).toEqual({ rules, included: theirs });
    }
  });

  test("a directory-only rule is not applied to a FILE of the same name", () => {
    const base = mkdtempSync(join(tmpdir(), "lama346-universe-file-"));
    try {
      crossCheckTreeFixture(base, ["pkg", "pkgdir/inside.txt"]);
      const compiled = compileRcloneFilterRules(["- pkg/"]);
      // The FILE `pkg` survives a directory-only rule...
      expect(compiled.includes("pkg", false)).toBe(true);
      // ...and the rule does not match the unrelated directory `pkgdir`.
      expect(compiled.includes("pkgdir", true)).toBe(true);
      const included = rcloneIncludedFiles(base, ["- pkg/"]);
      expect(included).toContain("pkg");
      expect(included).toContain("pkgdir/inside.txt");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
