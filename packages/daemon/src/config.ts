import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { parseClientConfig, type ClientConfig, type HostConfig } from "@lamasync/core";

const CONFIG_PATH = join(homedir(), ".config", "lamasync", "client.toml");
const CONFIG_DIR = dirname(CONFIG_PATH);

export function loadConfig(): ClientConfig {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Client config not found at ${CONFIG_PATH}. ` +
        `Create it with:\n` +
        `  serverUrl = "http://<lamasync-server>:8080"\n` +
        `  apiKey = "<LAMASYNC_API_KEY>"\n` +
        `  hostname = "$(hostname)"\n`,
    );
  }
  const buf = readFileSync(CONFIG_PATH, "utf8");
  return parseClientConfig(buf);
}

/** Expand a leading `~` / `~/` / `~user` in a local path. rclone does NOT
 *  expand `~` in local paths (verified on rclone v1.68.2: `rclone lsf '~/x'`
 *  reports a directory-not-found error), so every consumer (rclone argv,
 *  checkDiskSpace's `df`, watch-control existsSync, mounts, systemd units)
 *  must see an absolute path. The daemon expands assignment local paths once
 *  at config load (see expandConfigPaths); this helper stays idempotent so
 *  per-consumer defensive use is harmless. */
export function expandHomePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p.startsWith("~")) {
    // `~user/...` → /home/user/...
    const rest = p.slice(1);
    const slash = rest.indexOf("/");
    const user = slash === -1 ? rest : rest.slice(0, slash);
    const tail = slash === -1 ? "" : rest.slice(slash);
    return join(dirname(homedir()), user, tail);
  }
  return p;
}

/**
 * LAMA-309: expand every assignment's local path once at config load so the
 * whole daemon (rclone argv, checkDiskSpace `df`, watch-control existsSync,
 * mounts, systemd units) consumes absolute paths. Idempotent — already
 * absolute paths pass through unchanged. Returns the same reference when no
 * assignment uses `~` so the cached config object is not needlessly copied.
 */
export function expandConfigPaths(config: HostConfig): HostConfig {
  if (config.assignments.every((a) => !a.localPath.startsWith("~"))) {
    return config;
  }
  return {
    ...config,
    assignments: config.assignments.map((a) => ({
      ...a,
      localPath: expandHomePath(a.localPath),
    })),
  };
}

export interface MissingPath {
  folderId: string;
  folderName: string;
  localPath: string;
}

/** Assignments whose local path does not exist yet (LAMA-241). This is a
 *  normal pre-first-use state: the local directory is created lazily on the
 *  first sync/mount run (see executor.ts ensureLocalDirectory), so the daemon
 *  only logs an info-level note here instead of failing the assignment. */
export function missingAssignmentPaths(
  assignments: { folderId: string; localPath: string }[],
  folderName: (folderId: string) => string | null,
): MissingPath[] {
  const missing: MissingPath[] = [];
  for (const a of assignments) {
    if (!existsSync(expandHomePath(a.localPath))) {
      missing.push({
        folderId: a.folderId,
        folderName: folderName(a.folderId) ?? a.folderId,
        localPath: a.localPath,
      });
    }
  }
  return missing;
}
