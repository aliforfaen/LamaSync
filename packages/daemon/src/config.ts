import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { parseClientConfig, type ClientConfig } from "@lamasync/core";

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

/** Expand a leading `~` / `~/` / `~user` in a local path. rclone expands
 *  these itself, but our pre-flight existence checks run before rclone. */
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

export interface MissingPath {
  folderId: string;
  folderName: string;
  localPath: string;
}

/** Assignments whose local path doesn't exist yet (LAMA-241). This is a
 *  normal pre-first-use state (e.g. a tool hasn't run yet), so the daemon
 *  warns instead of failing; the first scheduled sync still reports the
 *  rclone error until the path appears. */
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
