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
// `lamasyncd` and `lamasync-tui` binaries. We deliberately do not import
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
    const extract = Bun.spawnSync(["tar", "-xzf", tarPath, "-C", stageDir], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (!extract.success) {
      await rmSync(stageDir, { recursive: true, force: true });
      return false;
    }
    // The tarball extracts into `<stageDir>/lamasync-skill-<ver>/...` —
    // the pack script is owned by us, so we simply move the only
    // top-level directory over.
    const extracted = readdirSync(stageDir).filter((n) => n !== skillAssetName(VERSION));
    if (extracted.length !== 1) {
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
