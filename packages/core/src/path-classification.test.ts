// LAMA-315: acceptance tests for the deterministic path classifier. Covers
// the catalog contract from docs/handoff-315-path-classification.md: exact
// well-known paths (high), segment/stem matches (medium), weak heuristics
// (low), unknown fallback (never guessed), boundary safety (no substring
// leakage between sibling paths), determinism, and per-suggestion
// explanation presence.

import { describe, expect, test } from "bun:test";
import {
  classifyPath,
  classificationRuleIds,
  CONFIDENCE_BY_LEVEL,
  type PathSuggestion,
} from "./path-classification.ts";

function suggestionFor(path: string): PathSuggestion {
  const suggestion = classifyPath(path);
  expect(suggestion, `${path} should classify`).not.toBeNull();
  return suggestion!;
}

describe("LAMA-315 classifier — exact well-known paths (high)", () => {
  test("cache: ~/.cache and descendants", () => {
    const dir = suggestionFor("~/.cache");
    const child = suggestionFor("~/.cache/nvim");
    expect(dir.classification).toBe("cache");
    expect(dir.confidenceLevel).toBe("high");
    expect(dir.confidence).toBe(CONFIDENCE_BY_LEVEL.high);
    expect(child.classification).toBe("cache");
  });

  test("secrets: ~/.ssh, ~/.gnupg, ~/.netrc, ~/.git-credentials, gh hosts.yml", () => {
    for (const path of [
      "~/.ssh",
      "~/.ssh/id_ed25519",
      "~/.gnupg",
      "~/.netrc",
      "~/.git-credentials",
      "~/.config/gh/hosts.yml",
    ]) {
      expect(suggestionFor(path).classification, path).toBe("secrets");
    }
  });

  test("machine_state: ~/.ssh/known_hosts wins over the secrets ~/.ssh rule", () => {
    const knownHosts = suggestionFor("~/.ssh/known_hosts");
    expect(knownHosts.classification).toBe("machine_state");
    expect(knownHosts.ruleId).toBe("machine-state-ssh-known-hosts");
  });

  test("machine_state: ~/.local/state tree", () => {
    const suggestion = suggestionFor("~/.local/state/SomeApp");
    expect(suggestion.classification).toBe("machine_state");
    expect(suggestion.confidenceLevel).toBe("high");
  });

  test("portable_config: shell rcs, git, vscode user dir (per-OS variants)", () => {
    for (const path of [
      "~/.zshrc",
      "~/.bashrc",
      "~/.bash_profile",
      "~/.profile",
      "~/.gitconfig",
      "~/.gitignore_global",
      "~/.tmux.conf",
      "~/.config/nvim",
      "~/.config/fish",
      "~/.config/tmux",
    ]) {
      expect(suggestionFor(path).classification, path).toBe("portable_config");
    }
    // VS Code per-OS roots (case-insensitive matching for the mac/Win forms).
    expect(suggestionFor("~/.config/Code/User/settings.json").classification).toBe("portable_config");
    expect(suggestionFor("~/Library/Application Support/Code/User/settings.json").classification).toBe("portable_config");
    expect(suggestionFor("%APPDATA%\\Code\\User\\settings.json").classification).toBe("portable_config");
  });
});

describe("LAMA-315 classifier — stems and segments (medium)", () => {
  test("node_modules anywhere is cache", () => {
    expect(suggestionFor("~/.config/SomeApp/node_modules").classification).toBe("cache");
    expect(suggestionFor("~/projects/app/node_modules/pkg").classification).toBe("cache");
  });

  test("*.log files are cache", () => {
    expect(suggestionFor("~/.config/App/logs/error.log").classification).toBe("cache");
    expect(suggestionFor("~/App/app.log").classification).toBe("cache");
  });

  test("*.vscdb files are machine_state", () => {
    expect(suggestionFor("~/.config/Code/state.vscdb").classification).toBe("machine_state");
    expect(suggestionFor("~/Library/Application Support/Code/state.vscdb").classification).toBe("machine_state");
  });

  test("Local State segment and licence files are machine_state", () => {
    expect(suggestionFor("~/.config/SomeApp/Local State").classification).toBe("machine_state");
    expect(suggestionFor("~/.config/SomeApp/license.dat").classification).toBe("machine_state");
  });

  test("browser profile trees are machine_state (Linux + Windows)", () => {
    expect(suggestionFor("~/.mozilla/firefox").classification).toBe("machine_state");
    expect(suggestionFor("%APPDATA%\\Mozilla\\Firefox").classification).toBe("machine_state");
  });

  test("AppData/Local/Temp is cache", () => {
    expect(suggestionFor("%APPDATA%\\AppData\\Local\\Temp\\Code").classification).toBe("cache");
  });
});

describe("LAMA-315 classifier — weak heuristics (low) and unknown", () => {
  test(".env anywhere is a low-confidence secrets suggestion", () => {
    const suggestion = suggestionFor("~/apps/backend/.env");
    expect(suggestion.classification).toBe("secrets");
    expect(suggestion.confidenceLevel).toBe("low");
    expect(suggestion.confidence).toBe(CONFIDENCE_BY_LEVEL.low);
  });

  test("unknown paths return null — never guessed", () => {
    for (const path of [
      "~/.config/SomeApp/whatever.dat",
      "~/projects/notes.txt",
      "~/Documents/tax-2025.pdf",
      "~/.oh-my-zsh",
    ]) {
      expect(classifyPath(path), path).toBeNull();
    }
  });
});

describe("LAMA-315 classifier — boundary safety and determinism", () => {
  test("directory-aware prefixes never leak into sibling paths", () => {
    // `~/.ssh` must not match `~/.sshuttle`; `~/.cache` must not match `~/.cachex`.
    expect(classifyPath("~/.sshuttle/config")).toBeNull();
    expect(classifyPath("~/.cachex/broken")).toBeNull();
    expect(classifyPath("~/.config/gh/hostsy.yml")).toBeNull();
    // But descendants DO match.
    expect(suggestionFor("~/.ssh/authorized_keys").classification).toBe("secrets");
    expect(suggestionFor("~/.cache/pip").classification).toBe("cache");
  });

  test("classifier is deterministic and every suggestion is explained + auditable", () => {
    const sample = ["~/.cache", "~/.ssh/id_ed25519", "~/.config/nvim", "~/apps/.env", "~/random/thing"];
    for (const path of sample) {
      const first = classifyPath(path);
      for (let i = 0; i < 5; i++) {
        expect(classifyPath(path)).toEqual(first);
      }
      if (first !== null) {
        expect(first.rationale.length).toBeGreaterThan(10);
        expect(first.ruleId.length).toBeGreaterThan(0);
        expect(classificationRuleIds()).toContain(first.ruleId);
        expect(first.path).toBe(path);
      }
    }
  });

  test("windows backslashes and case are normalized for matching", () => {
    const suggestion = suggestionFor("C:\\Users\\me\\AppData\\Local\\Temp\\code");
    expect(suggestion.classification).toBe("cache");
    expect(suggestion.path).toBe("C:\\Users\\me\\AppData\\Local\\Temp\\code");
  });

  test("confidence values match the documented coarse levels", () => {
    expect(CONFIDENCE_BY_LEVEL).toEqual({ high: 0.9, medium: 0.6, low: 0.3 });
  });
});