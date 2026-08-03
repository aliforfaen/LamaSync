// Shared helper for the /tmp rclone config files we drop for stat, browse,
// and backend-test operations.
//
// Concerns:
//   - the secret must not survive the operation (0600 perms, removed in
//     `finally`)
//   - concurrent calls (multiple in-flight browse jobs, stats refreshes
//     mid-flight) must not clobber each other — `mkdtemp` + unique name
//     inside a private dir achieves that
//   - cleanup must still run on the error path
//
// Each call gets its own temp directory under the system temp root. The
// caller passes the rclone config body and an async function that does
// whatever work it needs (typically `Bun.spawn(argv, ...)`). The function
// receives the absolute config path it should pass to `--config`.

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempRcloneConfig {
  /** Absolute path to write the config body to and pass to rclone. */
  configPath: string;
  /** Absolute path of the private directory the config lives in. */
  dir: string;
}

const TMP_PREFIX = "lamasync-rclone-";

/**
 * Drop the given rclone config text into a unique 0600-perm file inside a
 * private temp directory and return its path. The caller is responsible for
 * removing it; `withTempRcloneConfig` wraps this with `try/finally`.
 *
 * Exposed so unit tests can assert the path layout (private dir, 0600,
 * non-clashing names under concurrency) without spinning up rclone.
 */
export function writeTempRcloneConfig(
  body: string,
  opts: { dir?: string; name?: string } = {},
): TempRcloneConfig {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), TMP_PREFIX));
  // `mkdtemp` already returns a private dir; ensure it exists when an
  // override was supplied.
  mkdirSync(dir, { recursive: true });
  const name = opts.name ?? `rclone-${crypto.randomUUID()}.conf`;
  const configPath = join(dir, name);
  writeFileSync(configPath, body, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return { configPath, dir };
}

/**
 * Run `fn` with a freshly-allocated rclone config file. The config is
 * written to a unique temp path with 0600 permissions and removed (along
 * with its parent dir) on both the happy and error paths — concurrent
 * calls do not clash because each gets its own temp directory.
 *
 * `fn` may return anything; thrown errors propagate after cleanup.
 */
export async function withTempRcloneConfig<T>(
  body: string,
  fn: (configPath: string) => Promise<T>,
): Promise<T> {
  const { configPath, dir } = writeTempRcloneConfig(body);
  try {
    return await fn(configPath);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}