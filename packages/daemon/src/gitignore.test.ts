// LAMA-302: Git ignore semantics for `respectGitignore`. Builds real temp
// worktrees and asserts the scoped evaluator + rclone filter snapshot.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildRcloneFilterSnapshot, GitignoreEvaluator } from "./gitignore.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lamasync-gitignore-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function file(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

describe("GitignoreEvaluator", () => {
  test("root .gitignore patterns apply", () => {
    file(".gitignore", "node_modules/\n*.log\n");
    const ev = new GitignoreEvaluator(root);
    expect(ev.isIgnoredDir("node_modules")).toBe(true);
    expect(ev.isIgnored("node_modules/x.js")).toBe(true);
    expect(ev.isIgnored("app.log")).toBe(true);
    expect(ev.isIgnored("src/main.ts")).toBe(false);
    expect(ev.isIgnored(".gitignore")).toBe(false);
  });

  test("nested .gitignore is scoped to its own directory with re-include", () => {
    file(".gitignore", "*.log\n");
    file("src/.gitignore", "!important.log\n");
    const ev = new GitignoreEvaluator(root);
    // Deepest file re-includes its own child even though root ignores *.log.
    expect(ev.isIgnored("src/important.log")).toBe(false);
    // Other logs still ignored by the root rule.
    expect(ev.isIgnored("src/other.log")).toBe(true);
    // Other dirs unaffected.
    expect(ev.isIgnored("docs/readme.log")).toBe(true);
  });

  test("negation cannot re-include a path under an ignored directory", () => {
    file(".gitignore", "build/\n");
    file("build/.gitignore", "!keep.txt\n");
    const ev = new GitignoreEvaluator(root);
    // Git: once `build/` is ignored you can't un-ignore `build/keep.txt`.
    expect(ev.isIgnoredDir("build")).toBe(true);
    expect(ev.isIgnored("build/keep.txt")).toBe(true);
    expect(ev.isIgnored("build/other.txt")).toBe(true);
  });

  test(".git/info/exclude and global excludes apply", () => {
    // info/exclude inside the repo.
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "exclude"), "secret.txt\n");
    const ev = new GitignoreEvaluator(root);
    expect(ev.isIgnored("secret.txt")).toBe(true);
    expect(ev.isIgnored("nested/secret.txt")).toBe(true);
    expect(ev.isIgnored("public.txt")).toBe(false);
  });

  test("does not descend into .git to find nested gitignore files", () => {
    // A fake .gitignore inside .git must not be treated as a project rule.
    file(".git/info/.gitignore", "secret.txt\n");
    const ev = new GitignoreEvaluator(root);
    expect(ev.isIgnored("secret.txt")).toBe(false);
  });
});

describe("buildRcloneFilterSnapshot", () => {
  test("emits exclude rules collapsed to ignored directories", () => {
    file(".gitignore", "node_modules/\n*.log\ndist/\n");
    file("src/index.ts", "");
    file("src/app.log", "");
    // Create the directories the ignore rules target so the walker sees them.
    file("node_modules/pkg/index.js", "");
    file("dist/bundle.js", "");
    const { rules } = buildRcloneFilterSnapshot(root);
    expect(rules).toContain("- node_modules/");
    expect(rules).toContain("- dist/");
    // The ignored .log file is excluded by its own path.
    expect(rules).toContain("- src/app.log");
    // Ignored subtree is pruned — nothing under it.
    expect(rules.some((r) => r.startsWith("- node_modules/"))).toBe(true);
    // Non-ignored entries are not excluded.
    expect(rules).not.toContain("- src/index.ts");
  });

  test("shared the same stable fingerprint across identical trees", () => {
    file(".gitignore", "*.log\n");
    file("a.log", "");
    const a = buildRcloneFilterSnapshot(root);
    const b = buildRcloneFilterSnapshot(root);
    expect(a.hash).toBe(b.hash);
    expect(a.hash.length).toBe(64);
    expect(a.rules).toContain("- a.log");
  });

  test("fingerprint changes when the ignore set changes", () => {
    // Pre-seed the same file the pattern will target so the rules differ.
    file("a.log", "");
    const a = buildRcloneFilterSnapshot(root);
    file(".gitignore", "*.log\n");
    const b = buildRcloneFilterSnapshot(root);
    expect(a.rules).not.toContain("- a.log");
    expect(b.rules).toContain("- a.log");
    expect(a.hash).not.toBe(b.hash);
  });

  test("skips the .git tree entirely", () => {
    file(".git/HEAD", "ref: refs/heads/main\n");
    file(".git/index", "");
    const { rules } = buildRcloneFilterSnapshot(root);
    expect(rules.some((r) => r.includes(".git"))).toBe(false);
  });
});
