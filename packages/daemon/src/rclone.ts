import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

/**
 * Write the server-supplied rclone config to a private temp file so multiple
 * daemon processes don't collide on a shared path. The caller owns the returned
 * `cleanup` and MUST invoke it (typically via try/finally) to avoid leaving
 * credentials on disk.
 */
export function writeRcloneConfig(
  rcloneConfig: string,
): { configPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lamasync-rclone-"));
  const configPath = join(
    dir,
    `lamasync-rclone-${process.pid}-${randomBytes(6).toString("hex")}.conf`,
  );
  writeFileSync(configPath, rcloneConfig, { mode: 0o600 });
  const cleanup = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; nothing useful to do on failure
    }
  };
  return { configPath, cleanup };
}

/**
 * Resolve the rclone remote name for a folder assignment, defaulting to a
 * stable per-folder name when the assignment doesn't pin one.
 */
export function getRemoteName(
  remoteName: string | null | undefined,
  folderId: string,
): string {
  return remoteName && remoteName.length > 0 ? remoteName : `lamasync-${folderId}`;
}