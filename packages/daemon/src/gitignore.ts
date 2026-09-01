// LAMA-302: Git ignore semantics for the `respectGitignore` assignment option.
//
// The handoff rule is explicit: do NOT pass `.gitignore` straight to rclone —
// rclone filters have different semantics. Instead we build a deterministic
// filter snapshot from Git's own ignore evaluation and feed that snapshot into
// bisync, retaining it alongside the assignment's bisync state. Because
// changing a filter changes the synchronization universe, a snapshot change
// must force rclone's safe resync/recovery path (see executor.ts).
//
// Approach: aggregate every gitignore source into one `ignore` matcher,
// re-prefixing nested `.gitignore` patterns with their directory relative to
// the worktree root so a nested `.gitignore` is scoped to its own subtree.
// `ignore` implements the subtle git rules — last-match-wins, and the
// "cannot re-include a path under an ignored directory" rule — within a single
// matcher. Sources are added in git's precedence order so conflicts resolve
// the way git resolves them:
//
//   1. per-directory `.gitignore` (deepest wins) — added root → deep
//   2. `.git/info/exclude`                     — after gitignore files
//   3. global excludes (`core.excludesFile`)   — lowest precedence
//
// This is an "equivalent fully-tested implementation" for the common cases.
// Exotic interactions (e.g. `..` breakout patterns) are documented v1 limits.

import { createHash } from "crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  type Dirent,
} from "fs";
import { homedir } from "os";
import { join, relative, dirname, isAbsolute, sep } from "path";
import ignore, { type Ignore } from "ignore";
import { writeExcludeFile } from "./ignore.ts";

export const GITIGNORE_FILENAME = ".gitignore";
/** File name inside `.git/` that holds per-repo excludes (info/exclude). */
export const GIT_INFO_EXCLUDE = join(".git", "info", "exclude");

/** True when `root` is (or is the worktree of) a Git repository. `.git` may
 * be a directory in a normal repo or a gitfile in a worktree/submodule. */
export function hasGitWorktree(root: string): boolean {
  return existsSync(join(root, ".git"));
}

interface PatternSource {
  /** Directory base for the pattern, relative to root ("" = root). */
  base: string;
  /** Raw pattern lines from the file. */
  patterns: string[];
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readLinesIfExists(p: string): string[] | null {
  if (!existsSync(p) || !statSync(p).isFile()) return null;
  const text = readFileSync(p, "utf8");
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    // Skip blank lines and comments. A trailing-space-escaped pattern is an
    // edge case we intentionally don't handle in v1.
    if (line.length === 0 || line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
}

/** Resolve the global git excludes file (core.excludesFile), with fallbacks. */
function globalExcludesPath(): string | null {
  // Ask git first (most faithful); fall back to conventional locations when
  // git is unavailable or unconfigured.
  try {
    const res = Bun.spawnSync(["git", "config", "--get", "core.excludesfile"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (res.exitCode === 0) {
      const val = new TextDecoder().decode(res.stdout).trim();
      if (val) return isAbsolute(val) ? val : join(homedir(), val);
    }
  } catch {
    // git not installed / not a repo — proceed to the fallbacks.
  }
  const env = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const candidates = [
    join(env, "git", "ignore"),
    join(homedir(), ".gitignore_global"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Recursively collect every `.gitignore` under `dir`, sorted root → deep. */
function collectGitignoreFiles(dir: string): string[] {
  const found: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" && entry.isDirectory()) continue; // don't descend into .git
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name === GITIGNORE_FILENAME) {
        found.push(full);
      }
    }
  }
  // Root's .gitignore should be processed before deeper ones (deeper wins).
  const rootIgnore = join(dir, GITIGNORE_FILENAME);
  return found.sort((a, b) => {
    const da = a.split("/").length;
    const db = b.split("/").length;
    return da - db;
  }).filter((f) => f !== rootIgnore);
}

/** Re-prefix a nested `.gitignore` pattern with its base directory. */
function prefixPattern(pattern: string, base: string): string {
  if (!base) return pattern;
  let body = pattern;
  let negative = false;
  if (body.startsWith("!")) {
    negative = true;
    body = body.slice(1);
  }
  let anchored = false;
  if (body.startsWith("/")) {
    anchored = true;
    body = body.slice(1);
  }
  // `<base>/<pattern>` — anchored patterns still get the base prefix so they
  // stay scoped to the nested directory.
  const prefixed = base + "/" + body;
  return (negative ? "!" : "") + prefixed;
}

/**
 * Build the aggregated `ignore` matcher for a worktree root.
 *
 * `pathExistsGate`: optional predicate used by the watcher to avoid touching
 * the filesystem for paths that no longer exist (events can carry dead paths).
 */
export class GitignoreEvaluator {
  private matcher: Ignore;
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    this.matcher = this.buildMatcher(root);
  }

  /** True when `relPath` (relative to root, POSIX separators) is ignored. */
  isIgnored(relPath: string): boolean {
    const posix = this.toPosix(relPath);
    if (posix === "" || posix === ".") return false;
    return this.matcher.ignores(posix);
  }

  /**
   * True when a directory `relDir` is ignored as a whole (so it can be
   * pruned). A `dir/` gitignore pattern only matches the path when tested with
   * a trailing slash — the bare path returns false in `ignore`.
   */
  isIgnoredDir(relDir: string): boolean {
    const posix = this.toPosix(relDir).replace(/\/$/, "");
    if (posix === "" || posix === ".") return false;
    return this.matcher.ignores(posix + "/");
  }

  private toPosix(relPath: string): string {
    return relPath.split(sep).join("/").replace(/^\.\//, "");
  }

  private buildMatcher(root: string): Ignore {
    const sources: PatternSource[] = [];

    // Global excludes (lowest precedence).
    const globalPath = globalExcludesPath();
    if (globalPath) {
      const lines = readLinesIfExists(globalPath);
      if (lines) sources.push({ base: "", patterns: lines });
    }

    // .git/info/exclude (above global, below per-dir .gitignore).
    const infoExclude = readLinesIfExists(join(root, GIT_INFO_EXCLUDE));
    if (infoExclude) sources.push({ base: "", patterns: infoExclude });

    // Root .gitignore (higher precedence than info/exclude + global).
    const rootIgnore = readLinesIfExists(join(root, GITIGNORE_FILENAME));
    if (rootIgnore) sources.push({ base: "", patterns: rootIgnore });

    // Per-directory .gitignore files by increasing depth (deepest wins —
    // added last so it overrides shallower files in last-match-wins).
    const gitignoreFiles = collectGitignoreFiles(root);
    for (const file of gitignoreFiles) {
      const lines = readLinesIfExists(file);
      if (!lines) continue;
      const base = relative(root, dirname(file)).split(sep).join("/");
      sources.push({ base, patterns: lines });
    }

    const matcher = ignore();
    for (const source of sources) {
      for (const pattern of source.patterns) {
        matcher.add(prefixPattern(pattern, source.base));
      }
    }
    return matcher;
  }
}

/**
 * Build a deterministic rclone `--filter-from` snapshot for a worktree root.
 *
 * Walks the tree and emits an `- <path>` exclude rule per ignored entry,
 * collapsing fully-ignored directories to a single `- <dir>/` rule (rclone
 * prunes the whole subtree). Because `ignore` enforces the parent-dir rule
 * ("can't re-include under an ignored dir"), an ignored directory implies no
 * re-included descendants, so pruning is safe.
 *
 * Returns the rclone filter rules plus a stable fingerprint of the rules so
 * the executor can detect when the synchronization universe changed.
 */
export function buildRcloneFilterSnapshot(root: string): {
  rules: string[];
  hash: string;
} {
  const evaluator = new GitignoreEvaluator(root);
  const rules: string[] = [];

  const walk = (dirAbs: string, dirRel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" && entry.isDirectory()) continue;
      const full = join(dirAbs, entry.name);
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      const ignored = entry.isDirectory()
        ? evaluator.isIgnoredDir(rel)
        : evaluator.isIgnored(rel);
      if (ignored) {
        if (entry.isDirectory()) {
          rules.push(`- ${rel}/`);
        } else {
          rules.push(`- ${rel}`);
        }
        continue; // pruned (dir) or excluded (file) — no descendants reachable
      }
      if (entry.isDirectory()) {
        walk(full, rel);
      }
    }
  };

  walk(root, "");
  const hash = createHash("sha256").update(rules.join("\n")).digest("hex");
  return { rules, hash };
}

/**
 * Materialise the gitignore-derived rclone filter rules (plus any extra
 * `.lamasyncignore` patterns) into a temp `--filter-from` file. Returns null
 * when nothing is ignored. The caller owns the returned `cleanup`.
 */
export function materialiseGitignoreFilter(
  root: string,
  extraExcludes: readonly string[],
): { rules: string[]; hash: string; path: string; cleanup: () => void } | null {
  const { rules, hash } = buildRcloneFilterSnapshot(root);
  if (rules.length === 0 && extraExcludes.length === 0) return null;
  const all = [...rules, ...extraExcludes];
  const file = writeExcludeFile(all);
  return { rules, hash, path: file.path, cleanup: file.cleanup };
}
