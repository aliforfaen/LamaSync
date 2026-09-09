// LAMA-315 — deterministic, explainable path classifier for the app capture
// contract. A small ordered pattern catalog (not an opaque model): every
// suggestion is reproducible, auditable, stateless (a pure function of the
// path string), and carries a stable rule id + human rationale.
//
// Safety contract (see docs/handoff-315-path-classification.md):
// - Classification is planning/review only. Nothing here consumes a class to
//   change capture or exclusion; suggestions are never silently applied.
// - `secrets` stays backup-eligible; it is only surfaced conspicuously.
// - `cache` may be SUGGESTED for exclusion elsewhere — never auto-discarded.
// - `unknown` is never guessed; a path with no confident rule returns null.
// - Raw-path manual templates remain first-class; a null suggestion never
//   blocks saving a template.

import type { PathClassification } from "./types.ts";

/** Coarse, human-readable confidence levels used by the catalog. */
export type ConfidenceLevel = "high" | "medium" | "low";

/** 0..1 numbers backing the coarse levels (high/medium/low). Confidence is
 *  never authority — it only prices how well-anchored a matched pattern is. */
export const CONFIDENCE_BY_LEVEL: Record<ConfidenceLevel, number> = {
  high: 0.9,
  medium: 0.6,
  low: 0.3,
};

/** One deterministic recommendation for a single configured path. */
export interface PathSuggestion {
  /** The path that was classified (original casing/separation). */
  path: string;
  /** Suggested class. Never `"unknown"` — no rule matched ⇒ null result. */
  classification: PathClassification;
  /** Backing number for `confidenceLevel`. */
  confidence: number;
  confidenceLevel: ConfidenceLevel;
  /** Human sentence: what matched and why. */
  rationale: string;
  /** Stable rule reference for auditability (e.g. `cache-home-cache-dir`). */
  ruleId: string;
}

/** One row of the read-only `/apps/classify` endpoint. No matched rule ⇒
 *  `classification: "unknown"` with null confidence/explanation — paths are
 *  never falsely classified. */
export interface PathClassificationResult {
  path: string;
  classification: PathClassification;
  confidence: number | null;
  confidenceLevel: ConfidenceLevel | null;
  rationale: string | null;
  ruleId: string | null;
}

interface ClassifyRule {
  id: string;
  level: ConfidenceLevel;
  classification: PathClassification;
  /** Short human label of the class for the rationale sentence. */
  label: string;
  match: (path: string, segments: string[], leaf: string) => boolean;
  /** "what matched" fragment completing: "Detected as <label>: <why>." */
  why: string;
}

const CLASS_LABEL: Record<PathClassification, string> = {
  portable_config: "portable config",
  machine_state: "machine-specific state",
  cache: "cache",
  secrets: "secrets",
  custom: "custom",
  unknown: "unknown",
};

/** Segment-aware prefix: `a/b` matches `a/b` itself and any descendant, so a
 *  bare directory rule never leaks into sibling paths (`~/.sshuttle` is not
 *  `~/.ssh`). */
function isDirOrDescendant(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/** Exact leaf or exact file/dir at a canonical base. */
function isExact(path: string, base: string): boolean {
  return path === base;
}

function normalize(path: string): string {
  // Match on forward slashes only; keep casing (rule predicates decide
  // case sensitivity). Windows `C:\Users\...` becomes `c:/users/...` for
  // segment comparisons executed case-insensitively where appropriate.
  return path.replaceAll("\\", "/");
}

function splitSegments(path: string): string[] {
  return normalize(path)
    .split("/")
    .filter((segment) => segment.length > 0);
}

function leafOf(segments: string[]): string {
  return segments[segments.length - 1] ?? "";
}

/** Case-insensitive segment equality (for `Local State`, `AppData`, ...). */
function segmentIs(segment: string, target: string): boolean {
  return segment.toLowerCase() === target.toLowerCase();
}

/**
 * Two-tier catalog precedence — explicit, specificity/safety-correct:
 *
 * 1. `LEAF_OVERRIDES` (evaluated first) — exact-leaf / exact-file rules that
 *    deliberately outrank every broader parent-directory rule in `RULES`.
 *    A secret leaf must never be swallowed by the directory it lives in:
 *    `~/.cache/project/.env` and `~/.config/nvim/.env` stay `secrets`
 *    (conspicuous, never silently classed as cache/portable config), and the
 *    `~/.ssh/known_hosts` machine-identity file keeps its own class inside the
 *    secrets `~/.ssh` tree. Only precise patterns belong here — any rule in
 *    this tier wins against the entire catalog, and order within the tier
 *    still matters (known_hosts exception sits first).
 * 2. `RULES` — the ordered catalog for everything else, most-specific first.
 *    Only well-anchored patterns are listed — no substring guesses;
 *    `*log`/`*vscdb` recurrences are validated as full path segments.
 */
const LEAF_OVERRIDES: ClassifyRule[] = [
  {
    id: "machine-state-ssh-known-hosts",
    level: "high",
    classification: "machine_state",
    label: CLASS_LABEL.machine_state,
    match: (p) => isExact(p, "~/.ssh/known_hosts"),
    why: "exact well-known machine-identity file `~/.ssh/known_hosts`",
  },
  {
    id: "secrets-env-file",
    level: "low",
    classification: "secrets",
    label: CLASS_LABEL.secrets,
    match: (_p, _segments, leaf) => leaf === ".env",
    why: "environment file `.env` — may embed credentials; confirm before keeping",
  },
];

/**
 * The read-only catalog (tier 2), ordered most-specific first. The first
 * matching rule wins after `LEAF_OVERRIDES`; adding a rule here is a pure
 * data change and every suggestion remains deterministic.
 */
const RULES: ClassifyRule[] = [
  // --- high: exact, well-known paths (≈0.9) ---
  {
    id: "cache-home-cache-dir",
    level: "high",
    classification: "cache",
    label: CLASS_LABEL.cache,
    match: (p) => isDirOrDescendant(p, "~/.cache"),
    why: "well-known cache directory `~/.cache`",
  },
  {
    id: "secrets-ssh-dir",
    level: "high",
    classification: "secrets",
    label: CLASS_LABEL.secrets,
    match: (p) => isDirOrDescendant(p, "~/.ssh"),
    why: "well-known identity/credential directory `~/.ssh`",
  },
  {
    id: "secrets-gnupg-dir",
    level: "high",
    classification: "secrets",
    label: CLASS_LABEL.secrets,
    match: (p) => isDirOrDescendant(p, "~/.gnupg"),
    why: "well-known keyring directory `~/.gnupg`",
  },
  {
    id: "secrets-netrc-file",
    level: "high",
    classification: "secrets",
    label: CLASS_LABEL.secrets,
    match: (p) => isExact(p, "~/.netrc"),
    why: "exact well-known credential file `~/.netrc`",
  },
  {
    id: "secrets-git-credentials",
    level: "high",
    classification: "secrets",
    label: CLASS_LABEL.secrets,
    match: (p) => isExact(p, "~/.git-credentials"),
    why: "exact well-known credential file `~/.git-credentials`",
  },
  {
    id: "secrets-gh-hosts",
    level: "high",
    classification: "secrets",
    label: CLASS_LABEL.secrets,
    match: (p) => isExact(p, "~/.config/gh/hosts.yml"),
    why: "exact well-known GitHub credential file `~/.config/gh/hosts.yml`",
  },
  {
    id: "machine-state-local-state-dir",
    level: "high",
    classification: "machine_state",
    label: CLASS_LABEL.machine_state,
    match: (p) => isDirOrDescendant(p, "~/.local/state"),
    why: "well-known machine-local state directory `~/.local/state`",
  },
  {
    id: "portable-config-vscode-user",
    level: "high",
    classification: "portable_config",
    label: CLASS_LABEL.portable_config,
    match: (p) => {
      const n = normalize(p).toLowerCase();
      return (
        isDirOrDescendant(n, "~/.config/code/user") ||
        isDirOrDescendant(n, "~/library/application support/code/user") ||
        isDirOrDescendant(n, "%appdata%/code/user")
      );
    },
    why: "well-known portable VS Code settings root (per-OS variants)",
  },
  {
    id: "portable-config-gitconfig",
    level: "high",
    classification: "portable_config",
    label: CLASS_LABEL.portable_config,
    match: (p) => isExact(p, "~/.gitconfig"),
    why: "exact well-known portable file `~/.gitconfig`",
  },
  {
    id: "portable-config-gitignore-global",
    level: "high",
    classification: "portable_config",
    label: CLASS_LABEL.portable_config,
    match: (p) => isExact(p, "~/.gitignore_global"),
    why: "exact well-known portable file `~/.gitignore_global`",
  },
  {
    id: "portable-config-shell-rc",
    level: "high",
    classification: "portable_config",
    label: CLASS_LABEL.portable_config,
    match: (p) =>
      ["~/.zshrc", "~/.bashrc", "~/.bash_profile", "~/.profile"].includes(p),
    why: "exact well-known portable shell rc file",
  },
  {
    id: "portable-config-tmux-conf",
    level: "high",
    classification: "portable_config",
    label: CLASS_LABEL.portable_config,
    match: (p) => isExact(p, "~/.tmux.conf"),
    why: "exact well-known portable file `~/.tmux.conf`",
  },
  {
    id: "portable-config-nvim-dir",
    level: "high",
    classification: "portable_config",
    label: CLASS_LABEL.portable_config,
    match: (p) => isDirOrDescendant(p, "~/.config/nvim"),
    why: "well-known portable config directory `~/.config/nvim`",
  },
  {
    id: "portable-config-fish-dir",
    level: "high",
    classification: "portable_config",
    label: CLASS_LABEL.portable_config,
    match: (p) => isDirOrDescendant(p, "~/.config/fish"),
    why: "well-known portable config directory `~/.config/fish`",
  },
  {
    id: "portable-config-git-dir",
    level: "high",
    classification: "portable_config",
    label: CLASS_LABEL.portable_config,
    match: (p) => isDirOrDescendant(p, "~/.config/git"),
    why: "well-known portable config directory `~/.config/git`",
  },
  {
    id: "portable-config-tmux-dir",
    level: "high",
    classification: "portable_config",
    label: CLASS_LABEL.portable_config,
    match: (p) => isDirOrDescendant(p, "~/.config/tmux"),
    why: "well-known portable config directory `~/.config/tmux`",
  },
  {
    id: "portable-config-zsh-dir",
    level: "high",
    classification: "portable_config",
    label: CLASS_LABEL.portable_config,
    match: (p) => isDirOrDescendant(p, "~/.config/zsh"),
    why: "well-known portable config directory `~/.config/zsh`",
  },

  // --- medium: common stems / segments under any root (≈0.6) ---
  {
    id: "machine-state-vscdb-stem",
    level: "medium",
    classification: "machine_state",
    label: CLASS_LABEL.machine_state,
    match: (_p, _segments, leaf) => leaf.endsWith(".vscdb"),
    why: "recognizable machine-local VS Code state database (`*.vscdb`)",
  },
  {
    id: "machine-state-local-state-segment",
    level: "medium",
    classification: "machine_state",
    label: CLASS_LABEL.machine_state,
    match: (_p, segments) => segments.some((s) => segmentIs(s, "Local State")),
    why: "recognizable machine-local state store segment `Local State`",
  },
  {
    id: "machine-state-mozilla-dir",
    level: "medium",
    classification: "machine_state",
    label: CLASS_LABEL.machine_state,
    match: (p) => {
      const n = normalize(p).toLowerCase();
      return (
        isDirOrDescendant(n, "~/.mozilla") ||
        isDirOrDescendant(n, "%appdata%/mozilla")
      );
    },
    why: "browser profile tree — machine-bound profiles with session data",
  },
  {
    id: "machine-state-license-segment",
    level: "medium",
    classification: "machine_state",
    label: CLASS_LABEL.machine_state,
    match: (_p, segments) =>
      segments.some((s) => /^licen[cs]e([._-]|$)/i.test(s)),
    why: "licence/activation file — machine-bound install state",
  },
  {
    id: "cache-node-modules-segment",
    level: "medium",
    classification: "cache",
    label: CLASS_LABEL.cache,
    match: (_p, segments) => segments.includes("node_modules"),
    why: "regenerable dependency tree segment `node_modules`",
  },
  {
    id: "cache-log-stem",
    level: "medium",
    classification: "cache",
    label: CLASS_LABEL.cache,
    match: (_p, _segments, leaf) => leaf.endsWith(".log"),
    why: "regenerable log file (`*.log`)",
  },
  {
    id: "cache-appdata-local-temp",
    level: "medium",
    classification: "cache",
    label: CLASS_LABEL.cache,
    match: (_p, segments) =>
      segments.some((s, i) => s.toLowerCase() === "appdata" && (segments[i + 1] ?? "").toLowerCase() === "local" && (segments[i + 2] ?? "").toLowerCase() === "temp"),
    why: "regenerable per-user temp tree `AppData/Local/Temp`",
  },
];

/** Combined evaluation order — leaf overrides first, then the catalog.
 *  Hoisted so per-path classify calls don't reallocate the array. */
const RULES_IN_ORDER: ClassifyRule[] = [...LEAF_OVERRIDES, ...RULES];

/**
 * Classify one configured path. Pure + deterministic + stateless; returns
 * null when no rule matches (the path stays visibly `unknown` — never
 * guessed). Matching is conservative: exact paths, directory-aware prefixes,
 * or full path segments — never bare substrings. Specificity is safe by
 * construction: `LEAF_OVERRIDES` (precise secret-leaf / exact-file rules like
 * `.env` and `known_hosts`) are evaluated before the broader catalog so a
 * parent-directory rule can never shadow a more specific leaf.
 */
export function classifyPath(input: string): PathSuggestion | null {
  const segments = splitSegments(input);
  const leaf = leafOf(segments);
  const path = normalize(input);
  for (const rule of RULES_IN_ORDER) {
    if (rule.match(path, segments, leaf)) {
      return {
        path: input,
        classification: rule.classification,
        confidence: CONFIDENCE_BY_LEVEL[rule.level],
        confidenceLevel: rule.level,
        rationale: `Detected as ${rule.label}: ${rule.why}.`,
        ruleId: rule.id,
      };
    }
  }
  return null;
}

/** Read-only introspection for docs/tests: the ordered rule ids — tier-1
 *  leaf overrides first, then the catalog, exactly in evaluation order. */
export function classificationRuleIds(): string[] {
  return RULES_IN_ORDER.map((rule) => rule.id);
}