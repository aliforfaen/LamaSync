// LAMA-336: the skill bundle is a downloaded release asset, so the archive
// is untrusted input. These tests build real GNU tar fixtures (including the
// hostile ones) and drive the pre-extraction validation that now runs before
// `tar -xzf` is allowed to write anything.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isContainedSkillMember,
  skillBundleRoot,
  validateSkillBundle,
} from "./skill-update.ts";

const VERSION = "1.2.3";
const ROOT = skillBundleRoot(VERSION);

describe("isContainedSkillMember", () => {
  test("accepts relative members under the expected root", () => {
    expect(isContainedSkillMember(`${ROOT}/SKILL.md`, ROOT)).toBe(true);
    expect(isContainedSkillMember(`${ROOT}/`, ROOT)).toBe(true);
    expect(isContainedSkillMember(`${ROOT}/reference/api.md`, ROOT)).toBe(true);
  });

  test("rejects absolute names, traversal, dots and other roots", () => {
    expect(isContainedSkillMember("/etc/passwd", ROOT)).toBe(false);
    expect(isContainedSkillMember(`${ROOT}/../../etc/passwd`, ROOT)).toBe(false);
    expect(isContainedSkillMember("../evil.txt", ROOT)).toBe(false);
    expect(isContainedSkillMember("lamasync-skill-9.9.9/SKILL.md", ROOT)).toBe(false);
    expect(isContainedSkillMember("./SKILL.md", ROOT)).toBe(false);
    expect(isContainedSkillMember("", ROOT)).toBe(false);
    expect(isContainedSkillMember("/", ROOT)).toBe(false);
  });
});

describe("validateSkillBundle", () => {
  let work: string;
  let stage: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "lamasync-skill-bundle-"));
    stage = join(work, "stage");
    mkdirSync(join(stage, ROOT, "reference"), { recursive: true });
    writeFileSync(join(stage, ROOT, "SKILL.md"), "skill");
    writeFileSync(join(stage, ROOT, "VERSION"), `${VERSION}\n`);
    writeFileSync(join(stage, ROOT, "reference", "api.md"), "api");
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  function pack(name: string, extraArgs: string[] = []): string {
    const archive = join(work, name);
    const built = Bun.spawnSync(["tar", "czf", archive, "-C", stage, ...extraArgs, ROOT], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(built.success).toBe(true);
    return archive;
  }

  test("accepts the bundle layout the pack script produces", () => {
    expect(validateSkillBundle(pack("good.tar.gz"), ROOT)).toBe(true);
  });

  test("rejects a traversal member", () => {
    const archive = join(work, "traversal.tar.gz");
    const built = Bun.spawnSync(
      [
        "tar",
        "czf",
        archive,
        "-C",
        stage,
        `--transform=s|^${ROOT}/SKILL.md$|../evil.md|`,
        `${ROOT}/SKILL.md`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(built.success).toBe(true);
    expect(validateSkillBundle(archive, ROOT)).toBe(false);
  });

  test("rejects an absolute member name", () => {
    const archive = join(work, "absolute.tar.gz");
    // -P keeps the leading slash the pack script never produces.
    const built = Bun.spawnSync(
      ["tar", "czPf", archive, join(stage, ROOT, "SKILL.md")],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(built.success).toBe(true);
    expect(validateSkillBundle(archive, ROOT)).toBe(false);
  });

  test("rejects a symlink member even when every name is contained", () => {
    symlinkSync("/etc/passwd", join(stage, ROOT, "evil-link"));
    expect(validateSkillBundle(pack("link.tar.gz"), ROOT)).toBe(false);
  });

  test("rejects a member under a different top-level directory", () => {
    const archive = join(work, "other-root.tar.gz");
    const built = Bun.spawnSync(
      ["tar", "czf", archive, "-C", stage, "--transform=s|^|other-root/|", `${ROOT}/SKILL.md`],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(built.success).toBe(true);
    expect(validateSkillBundle(archive, ROOT)).toBe(false);
  });

  test("rejects an archive with no members", () => {
    const archive = join(work, "empty.tar.gz");
    const built = Bun.spawnSync(["tar", "czf", archive, "--files-from", "/dev/null"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(built.success).toBe(true);
    expect(validateSkillBundle(archive, ROOT)).toBe(false);
  });

  test("rejects a corrupt or truncated archive", () => {
    const good = pack("good.tar.gz");
    const truncated = join(work, "truncated.tar.gz");
    writeFileSync(truncated, readFileSync(good).subarray(0, 40));
    expect(validateSkillBundle(truncated, ROOT)).toBe(false);
    expect(validateSkillBundle(join(work, "does-not-exist.tar.gz"), ROOT)).toBe(false);
  });
});
