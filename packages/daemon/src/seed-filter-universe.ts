// LAMA-346 Stage 1a — the effective filter universe of a folder, as a predicate.
//
// A seed may only archive what the FOLLOWING bisync will consider its
// synchronization universe. That universe is decided by exactly one artifact:
// the `--filter-from` rule file the executor hands to rclone, built from
// `.lamasyncignore` (plus `- .git/**` when `ignoreGitMetadata` is on) and, when
// `respectGitignore` is on, a deterministic Git-ignore rule snapshot.
//
// So this module does not invent a second notion of "ignored". It compiles THE
// SAME RULE LINES the executor would write for the run, with rclone's own
// `--filter-from` semantics, and exposes the result as the
// `SeedSourceFilterUniverse` the manifest and archive primitives require. The
// seed's membership therefore equals the sync's membership by construction, and
// `seed-filter-universe.test.ts` pins that claim against a real rclone binary
// when one is on PATH.
//
// rclone semantics implemented here (verified against rclone v1.68.2, see the
// cross-check test):
//
//   * a line is trimmed; blank lines and lines starting with `#` or `;` are
//     comments;
//   * a rule is a sign (`-` exclude, `+` include) followed by EXACTLY one
//     space and then the pattern — `-a.txt` is a malformed rule, and rclone
//     aborts the whole run on one, so a seed must fail closed too;
//   * the FIRST matching rule wins; when no rule matches, the path is INCLUDED;
//   * ONLY a rule whose pattern ends with `/` can match a directory. A bare
//     `- sub` therefore excludes a FILE called `sub` and leaves the DIRECTORY
//     `sub` — and everything under it — in the universe, while `- sub/` prunes
//     the whole subtree. This is the single most surprising rclone rule and the
//     one a naive matcher gets wrong;
//   * a rule is matched against the full relative path. A pattern containing a
//     `/` (or starting with one) is anchored to the root, so `sub/a.txt` is
//     root-relative; a pattern without one is matched against the basename at
//     any depth, so `a.txt` matches `sub/a.txt` too;
//   * `{{...}}` wraps a (Go) regular expression. rclone compiles it as
//     `^(?:.*/)?<regex>$`, so it is prefix-anchored but may match at any depth
//     and must consume the whole path — `{{sub/inner}}` does NOT exclude
//     `sub/inner/g.bin`, while `{{f\.bin$}}` excludes it at any depth;
//   * in a glob, `**` matches across `/`, `*` and `?` do not, and `[...]` is a
//     character class; matching is case-sensitive.

import { createHash } from "crypto";
import { expandHomePath } from "./config.ts";
import { effectiveFilterFingerprint } from "./bisync-baseline.ts";
import { buildRcloneFilterSnapshot } from "./gitignore.ts";
import { cheapEffectiveFilter } from "./folder-health.ts";
import { effectiveSyncFilterPatterns, loadFilterPatterns, resolveFilterPath } from "./ignore.ts";
import { buildSeedManifest, type SeedManifest } from "./seed-archive.ts";
import type { FolderAssignment, FolderType } from "@lamasync/core";
import type { SeedSourceFilterUniverse } from "@lamasync/core";

/** A rule line rclone would accept, compiled into a predicate. */
export interface RcloneFilterRule {
  /** `+` includes, `-` excludes. */
  include: boolean;
  /** The pattern exactly as rclone receives it (after the `- `/`+ ` prefix). */
  pattern: string;
  /** True for a trailing-slash pattern, which only matches directories. */
  directoryOnly: boolean;
  /** True for a `{{...}}` regular expression rather than a glob. */
  regex: boolean;
  matches(relativePath: string, isDirectory: boolean): boolean;
}

export type ParseRcloneRuleResult =
  | { ok: true; rule: RcloneFilterRule | null }
  | { ok: false; reason: string };

const REGEX_METACHARACTERS = new Set("\\^$.|+(){}".split(""));

/**
 * Translate an rclone glob into a regular expression source.
 *
 * `**` crosses path separators, `*`/`?` do not, `[...]` passes through as a
 * character class, and everything else is escaped. The caller decides whether
 * the result is anchored.
 */
export function rcloneGlobToRegexSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      continue;
    }
    if (c === "[") {
      // Pass the character class through untouched, up to its closing bracket.
      const close = glob.indexOf("]", i + 1);
      if (close > i) {
        out += glob.slice(i, close + 1);
        i = close;
        continue;
      }
      out += "\\[";
      continue;
    }
    out += REGEX_METACHARACTERS.has(c) ? `\\${c}` : c;
  }
  return out;
}

/**
 * Compile one rclone `--filter-from` line.
 *
 * Returns `{ ok: true, rule: null }` for a comment or blank line, and
 * `{ ok: false }` for a line rclone itself would reject — a malformed rule
 * makes rclone abort the run, so the seed must not proceed either.
 */
export function parseRcloneFilterRule(line: string): ParseRcloneRuleResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { ok: true, rule: null };
  if (trimmed.startsWith("#") || trimmed.startsWith(";")) return { ok: true, rule: null };
  const sign = trimmed[0];
  if (sign !== "-" && sign !== "+") {
    return { ok: false, reason: `malformed rule "${trimmed}" (expected a "- " or "+ " prefix)` };
  }
  if (trimmed[1] !== " ") {
    return { ok: false, reason: `malformed rule "${trimmed}" (a rule needs exactly one space after the sign)` };
  }
  const raw = trimmed.slice(2);
  if (raw.length === 0) return { ok: false, reason: `malformed rule "${trimmed}" (empty pattern)` };
  const include = sign === "+";

  // `{{regex}}` is a regular expression. rclone compiles it as
  // `^(?:.*/)?<regex>$`: prefix-anchored, allowed at any depth, and required to
  // consume the whole path (verified against rclone — an unwrapped search would
  // wrongly exclude `sub/inner/g.bin` for `{{sub/inner}}`).
  if (raw.startsWith("{{") && raw.endsWith("}}") && raw.length > 4) {
    const source = raw.slice(2, -2);
    let re: RegExp;
    try {
      re = new RegExp(`^(?:.*/)?${source}$`);
    } catch (err) {
      return {
        ok: false,
        reason: `the filter rule "${trimmed}" is not a usable regular expression (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    return {
      ok: true,
      rule: {
        include,
        pattern: raw,
        directoryOnly: false,
        regex: true,
        // A regex rule never matches a directory: only a trailing-slash rule
        // can, which is rclone's rule for every pattern form.
        matches: (relativePath, isDirectory) => !isDirectory && re.test(relativePath),
      },
    };
  }

  let pattern = raw;
  let directoryOnly = false;
  if (pattern.length > 1 && pattern.endsWith("/")) {
    directoryOnly = true;
    pattern = pattern.slice(0, -1);
  }
  // Anchoring is decided BEFORE the leading `/` is stripped: `/a.txt` is
  // root-relative, while `a.txt` matches that basename at any depth.
  let anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);
  if (pattern.includes("/")) anchored = true;

  const body = rcloneGlobToRegexSource(pattern);
  const source = anchored ? `^${body}$` : `^(?:.*/)?${body}$`;
  let re: RegExp;
  try {
    re = new RegExp(source);
  } catch (err) {
    return {
      ok: false,
      reason: `the filter rule "${trimmed}" could not be compiled (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  return {
    ok: true,
    rule: {
      include,
      pattern: raw,
      directoryOnly,
      regex: false,
      matches: (relativePath, isDirectory) => {
        // Only a trailing-slash rule can match a directory, and a
        // trailing-slash rule matches nothing else.
        if (directoryOnly !== isDirectory) return false;
        return re.test(relativePath);
      },
    },
  };
}

export interface CompiledRcloneFilter {
  ok: boolean;
  /** First-match-wins predicate; unmatched paths are included. */
  includes(relativePath: string, isDirectory: boolean): boolean;
  /** Operator-facing reasons this rule set cannot be used at all. */
  errors: string[];
  ruleCount: number;
}

/**
 * Compile a whole `--filter-from` rule list into one predicate.
 *
 * First matching rule wins and an unmatched path is included, which is
 * rclone's behaviour for `--filter-from` (the `--include` FLAG adds an implicit
 * `- **`, but the fleet passes raw rules through `--filter-from`).
 */
export function compileRcloneFilterRules(lines: readonly string[]): CompiledRcloneFilter {
  const rules: RcloneFilterRule[] = [];
  const errors: string[] = [];
  for (const line of lines) {
    const parsed = parseRcloneFilterRule(line);
    if (!parsed.ok) {
      errors.push(parsed.reason);
      continue;
    }
    if (parsed.rule !== null) rules.push(parsed.rule);
  }
  return {
    ok: errors.length === 0,
    errors,
    ruleCount: rules.length,
    includes: (relativePath, isDirectory) => {
      if (relativePath.length === 0) return true;
      for (const rule of rules) {
        if (rule.matches(relativePath, isDirectory)) return rule.include;
      }
      return true;
    },
  };
}

/**
 * The exact `--filter-from` rule lines the executor writes for one assignment.
 *
 * `respectGitignore` replaces the plain `.lamasyncignore` file with a
 * deterministic Git-ignore snapshot that has the `.lamasyncignore` patterns
 * appended — so the seed composes the same list in the same order. Ordering
 * matters because rclone's first match wins.
 */
export function effectiveSyncFilterRuleLines(
  assignment: FolderAssignment,
  folderType: FolderType,
): { rules: string[]; gitignoreRules: string[] | null; patterns: string[]; source: string; errors: string[] } {
  const root = expandHomePath(assignment.localPath);
  const filterPath = resolveFilterPath(
    assignment.ignorePath ?? null,
    assignment.mountIgnorePath ?? null,
    folderType === "mount" ? "mount" : "sync",
  );
  const configured = loadFilterPatterns(filterPath, root);
  const patterns = effectiveSyncFilterPatterns(configured, folderType, assignment.ignoreGitMetadata);

  const errors: string[] = [];
  let gitignoreRules: string[] | null = null;
  if (assignment.respectGitignore) {
    try {
      gitignoreRules = buildRcloneFilterSnapshot(root).rules;
    } catch (err) {
      errors.push(
        `the Git-ignore rule snapshot for ${root} could not be built (${
          err instanceof Error ? err.message : String(err)
        }), so the effective filter universe is unknown`,
      );
      gitignoreRules = null;
    }
  }
  const rules = gitignoreRules === null ? [...patterns] : [...gitignoreRules, ...patterns];
  const source = cheapEffectiveFilter(assignment, folderType).source;
  return { rules, gitignoreRules, patterns, source, errors };
}

export interface SeedSourceManifestBuild extends SeedFilterUniverseBuild {
  /** Exactly what a seed would archive: the enumeration of the universe. */
  manifest: SeedManifest | null;
  /** Non-empty when the universe or the manifest cannot be trusted. */
  blocking: string[];
}

/**
 * The single entry point that turns ONE assignment into the manifest a seed
 * would archive: effective filter universe → manifest of that universe.
 *
 * This is the wiring Stage 1b's job calls. It fails closed: an unusable rule
 * set, an unbuildable Git-ignore snapshot, a member the universe includes but a
 * seed cannot represent, or an unreadable source all leave `manifest` null and
 * put the reason in `blocking` — the caller never has to guess whether the
 * measurement is complete. The transport is still missing, so nothing calls it
 * from a running job yet.
 */
export async function buildSeedSourceManifest(
  assignment: FolderAssignment,
  folderType: FolderType,
  opts: { entryCap?: number } = {},
): Promise<SeedSourceManifestBuild> {
  const built = buildSeedFilterUniverse(assignment, folderType);
  const blocking = [...built.errors];
  if (built.errors.length > 0) {
    return { ...built, manifest: null, blocking };
  }
  try {
    const manifest = await buildSeedManifest(expandHomePath(assignment.localPath), {
      filter: built.universe,
      ...(opts.entryCap === undefined ? {} : { entryCap: opts.entryCap }),
    });
    return { ...built, manifest, blocking };
  } catch (err) {
    blocking.push(err instanceof Error ? err.message : String(err));
    return { ...built, manifest: null, blocking };
  }
}


export interface SeedFilterUniverseBuild {
  /** The predicate the manifest builder and the archive primitives consume. */
  universe: SeedSourceFilterUniverse;
  /** The exact rule lines rclone would receive for this run. */
  rules: string[];
  /** The Git-ignore snapshot component, or null when `respectGitignore` is off. */
  gitignoreRules: string[] | null;
  /** The `.lamasyncignore` (plus `- .git/**`) component. */
  patterns: string[];
  /**
   * The live effective-filter fingerprint, computed with the SAME function the
   * executor uses (`effectiveFilterFingerprint`), so it is directly comparable
   * with the assignment's acknowledged baseline fingerprint.
   */
  fingerprint: string | null;
  source: string;
  ruleCount: number;
  /** Non-empty when the universe cannot be used at all; the seed fails closed. */
  errors: string[];
}

/**
 * Build the effective filter universe for one assignment.
 *
 * The result is the single input the manifest builder needs, and it carries the
 * fingerprint of the universe it represents so a plan can be checked against
 * it. `errors` is non-empty when the universe is unusable (a malformed rule
 * rclone would reject, or an unbuildable Git-ignore snapshot) — the caller must
 * fail closed rather than archive a tree whose membership is unknown.
 */
export function buildSeedFilterUniverse(
  assignment: FolderAssignment,
  folderType: FolderType,
): SeedFilterUniverseBuild {
  const { rules, gitignoreRules, patterns, source, errors } = effectiveSyncFilterRuleLines(
    assignment,
    folderType,
  );
  const compiled = compileRcloneFilterRules(rules);
  const allErrors = [...errors, ...compiled.errors];
  const fingerprint =
    gitignoreRules !== null || patterns.length > 0
      ? effectiveFilterFingerprint(gitignoreRules, patterns)
      : null;
  return {
    universe: {
      fingerprint: fingerprint ?? "none",
      patterns: rules,
      includes: compiled.includes,
    },
    rules,
    gitignoreRules,
    patterns,
    fingerprint,
    source,
    ruleCount: compiled.ruleCount,
    errors: allErrors,
  };
}

/**
 * Is `relativePath` inside the universe once PRUNING is taken into account?
 * A rule can exclude a directory while leaving its descendants unmatched — a
 * trailing-slash rule (`- node_modules/`) does exactly that, because it only
 * matches directories. Sync still drops the whole subtree, and so does the
 * manifest walk (it stops at the excluded directory). Callers that test a
 * single path without walking — a churn check, a plan question, a test — need
 * the same answer, so the ancestor chain is checked here.
 */
export function universePathIncluded(
  includes: SeedSourceFilterUniverse["includes"],
  relativePath: string,
  isDirectory: boolean,
): boolean {
  if (relativePath.length === 0 || relativePath === ".") return true;
  const parts = relativePath.split("/").filter((part) => part.length > 0);
  for (let i = 0; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i + 1).join("/");
    const isLast = i === parts.length - 1;
    if (!includes(prefix, isLast ? isDirectory : true)) return false;
  }
  return true;
}

/** Stable hash of a rule list, for logging and plan comparison. */
export function filterRulesFingerprint(rules: readonly string[]): string {
  return createHash("sha256").update(rules.join("\n")).digest("hex");
}
