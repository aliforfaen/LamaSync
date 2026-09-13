// Skill bundle update (LAMA-230):
//   lamasyncd --update skill
//
// Refreshes `~/.agents/skills/lamasync/` from the GitHub release matching
// the locally-running binary's version. The binary version and the skill
// version stay synchronized; deliberately NOT cross-version so that a
// freshly-installed binary ships with the matching skill and never lags.
//
// The release publishes a single asset named
//   lamasync-skill-<version>.tar.gz
// produced by `packaging/build-skill-tarball.sh` and shipped alongside the
// `lamasyncd`, `lamasync`, and transitional `lamasync-tui` binaries. We do not import
// the skill's reference source — `~/.agents/skills/lamasync/` is the
// delivered artifact the agent reads at runtime.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { VERSION } from "@lamasync/core";

import { fetchReleaseByTag, type ReleaseInfo } from "./self-update.ts";

export const SKILL_DIR = join(homedir(), ".agents", "skills", "lamasync");

/** Return the asset name the GitHub release should publish for our skill. */
export function skillAssetName(version: string): string {
  return `lamasync-skill-${version}.tar.gz`;
}

/** Top-level directory the skill tarball extracts into (see
 *  packaging/build-skill-tarball.sh). */
export function skillBundleRoot(version: string): string {
  return `lamasync-skill-${version}`;
}

interface TarRun {
  ok: boolean;
  stdout: string;
}

/** Run GNU tar with stdout captured. stderr is captured too (rather than
 *  inherited) so warnings from a rejected archive never reach the daemon log
 *  as if they were its own. */
function runTar(args: string[]): TarRun {
  const proc = Bun.spawnSync(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: proc.success, stdout: proc.stdout.toString() };
}

function tarMemberLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line !== "");
}

/** Every entry type a skill bundle may contain. A release is plain files and
 *  directories; links, devices, FIFOs and sockets are rejected. */
const SKILL_MEMBER_TYPES: ReadonlySet<string> = new Set(["-", "d"]);

/** True when a listed member is a relative path living inside `root`.
 *  Exported because this is the security predicate, not a formatting helper:
 *  it is what stops an absolute name or a `..` component from escaping the
 *  staged extraction directory. */
export function isContainedSkillMember(name: string, root: string): boolean {
  if (name.startsWith("/")) return false;
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  if (trimmed === "") return false;
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  return parts[0] === root;
}

/**
 * Validate the downloaded bundle before tar is allowed to write anything.
 *
 * `tar -xzf` trusts every member path and entry type it finds: a hostile or
 * merely corrupt artifact can carry traversal names, absolute paths or links
 * whose later members land outside the stage directory. List the names and
 * types first and reject anything the pack script never produces. Extraction
 * additionally runs with defensive flags as a second layer.
 *
 * `--quoting-style=escape` keeps one member per line even when a name carries
 * an embedded newline.
 */
export function validateSkillBundle(tarPath: string, root: string): boolean {
  const listed = runTar(["-tzf", tarPath, "--quoting-style=escape"]);
  if (!listed.ok) return false;
  const names = tarMemberLines(listed.stdout);
  if (names.length === 0) return false;
  if (!names.every((name) => isContainedSkillMember(name, root))) return false;

  const typed = runTar(["-tvzf", tarPath, "--quoting-style=escape"]);
  if (!typed.ok) return false;
  const types = tarMemberLines(typed.stdout).map((line) => line.charAt(0));
  if (types.length !== names.length) return false;
  return types.every((type) => SKILL_MEMBER_TYPES.has(type));
}

/** Fetch the release TAGGED for the locally-running binary's VERSION (NOT
 *  the latest release — cross-version drift is rejected, see the LAMA-227
 *  design notes — so a daemon one version behind latest can still refresh
 *  its skill). Returns null when the tag has no release or the release
 *  does not carry the skill asset yet; the caller surfaces a clear error. */
export async function locateSkillAsset(): Promise<
  | { release: ReleaseInfo; assetName: string }
  | null
> {
  const release = await fetchReleaseByTag(`v${VERSION}`);
  if (!release) return null;
  const assetName = skillAssetName(VERSION);
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) return null;
  return { release, assetName };
}

/** Version of the installed skill bundle, read from the VERSION file the
 *  tarball ships (packaging/build-skill-tarball.sh). Returns null when the
 *  skill is not installed or predates the VERSION file. */
export function readInstalledSkillVersion(): string | null {
  try {
    const raw = readFileSync(join(SKILL_DIR, "VERSION"), "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/** Download `asset.downloadUrl` to a temp file under ~/.lamasync, then
 *  extract it over SKILL_DIR. The tarball (a `tar -czf` archive produced
 *  by packaging/build-skill-tarball.sh) extracts into a single top-level
 *  `lamasync-skill-<version>/` directory holding SKILL.md, VERSION, and
 *  reference/. The swap is staged: the current SKILL_DIR is moved aside
 *  first and only deleted after the new bundle is in place, so a failed
 *  `mv` can never leave no skill installed.
 *  Returns true on success; failures are reported as non-zero exit codes
 *  by the caller. */
export async function downloadSkillBundle(downloadUrl: string): Promise<boolean> {
  const backupDir = `${SKILL_DIR}.bak-${process.pid}`;
  try {
    const res = await fetch(downloadUrl, {
      headers: { "User-Agent": `lamasyncd/${VERSION}` },
    });
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();
    const stageDir = join(homedir(), ".lamasync", `skill-update-${process.pid}-${Date.now()}`);
    await mkdirSync(stageDir, { recursive: true });
    const tarPath = join(stageDir, skillAssetName(VERSION));
    await Bun.write(tarPath, buf);
    // We deliberately shell out to `tar` — Bun's bundled tar is OK on
    // Linux but not portable; the install / upgrade scripts already
    // rely on the system's GNU tar, so we do the same here. The daemon
    // does NOT shell out to install binaries elsewhere; this is the one
    // exception and it is documented in the skill's safety file.
    //
    // The asset is validated before extraction (LAMA-336): `-xzf` must
    // never be the first thing that touches an untrusted archive.
    const bundleRoot = skillBundleRoot(VERSION);
    if (!validateSkillBundle(tarPath, bundleRoot)) {
      await rmSync(stageDir, { recursive: true, force: true });
      return false;
    }
    const extract = Bun.spawnSync(
      ["tar", "-xzf", tarPath, "-C", stageDir, "--no-same-owner", "--no-same-permissions"],
      { stdout: "inherit", stderr: "inherit" },
    );
    if (!extract.success) {
      await rmSync(stageDir, { recursive: true, force: true });
      return false;
    }
    // The tarball extracts into `<stageDir>/lamasync-skill-<ver>/...` —
    // the pack script is owned by us and validation already rejected
    // anything else, so the only remaining check is that it arrived.
    const extracted = readdirSync(stageDir).filter((n) => n !== skillAssetName(VERSION));
    if (extracted.length !== 1 || extracted[0] !== bundleRoot) {
      await rmSync(stageDir, { recursive: true, force: true });
      return false;
    }
    await mkdirSync(join(homedir(), ".agents", "skills"), { recursive: true });
    // Swap: move the current install aside, move the new one in, then drop
    // the backup. If the second mv fails, restore the backup so the host
    // never ends up with no skill installed.
    if (existsSync(SKILL_DIR)) {
      const aside = Bun.spawnSync(["mv", SKILL_DIR, backupDir], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if (!aside.success) {
        await rmSync(stageDir, { recursive: true, force: true });
        return false;
      }
    }
    const move = Bun.spawnSync(["mv", join(stageDir, extracted[0]!), SKILL_DIR], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (!move.success) {
      if (existsSync(backupDir)) {
        Bun.spawnSync(["mv", backupDir, SKILL_DIR], {
          stdout: "inherit",
          stderr: "inherit",
        });
      }
      await rmSync(stageDir, { recursive: true, force: true });
      return false;
    }
    await rmSync(backupDir, { recursive: true, force: true });
    await rmSync(stageDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
