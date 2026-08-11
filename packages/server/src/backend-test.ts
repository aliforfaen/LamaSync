// Shared connectivity checks for backend tests (LAMA-238). Both the
// per-id test route (`POST /backends/:backendId/test`) and the draft test
// route (`POST /backends/test`, which validates an unsaved form) run the
// exact same checks so a backend behaves identically before and after
// creation.
//
// Secrets never cross the API boundary; the routes pass plaintext straight
// from the request body (draft) or from the encrypted store (per-id) into
// these helpers, which drop them into private 0600 temp rclone configs or
// the process env.

import { readdirSync, statSync } from "node:fs";
import { withTempRcloneConfig } from "./temp-rclone-config.ts";

export interface TestOutcome {
  ok: boolean;
  detail?: string;
}

/** Build the rclone config body for an S3 remote from the given settings. */
export function s3RcloneConfig(opts: {
  provider: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  region: string | null;
}): string {
  return [
    `[test]`,
    `type = s3`,
    `provider = ${opts.provider === "aws" ? "AWS" : "Other"}`,
    `env_auth = false`,
    `access_key_id = ${opts.accessKeyId}`,
    `secret_access_key = ${opts.secretAccessKey}`,
    `endpoint = ${opts.endpoint}`,
    ...(opts.region ? [`region = ${opts.region}`] : []),
  ].join("\n");
}

/**
 * Cheap connectivity check for an S3 remote: `rclone lsd <remote>:` against
 * a temp config, 5s timeout. `ok` on exit 0; `detail` is the last stderr
 * line otherwise.
 */
export async function testS3Connection(opts: {
  provider: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  region: string | null;
}): Promise<TestOutcome> {
  const config = s3RcloneConfig(opts);
  // LAMA-226 P1-6: the secret lives in a private 0600 temp dir and is
  // removed on both the happy and error paths via the shared helper.
  const result = await withTempRcloneConfig(config, async (configPath) => {
    const proc = Bun.spawn(
      ["rclone", "lsd", "test:", "--config", configPath, "--timeout", "5s"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  });
  if (result.code === 0) {
    return { ok: true, detail: "connection ok" };
  }
  const detail = result.stderr.trim().split("\n").pop() ?? "unknown rclone error";
  return { ok: false, detail };
}

/** Server-side directory check: path exists, is a directory, is readable. */
export function testLocalDirectory(path: string): TestOutcome {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) {
      return {
        ok: false,
        detail: `path exists but is not a directory: ${path}`,
      };
    }
    readdirSync(path);
    return { ok: true, detail: `readable directory: ${path}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Restic repository check: `restic snapshots --json -r <repo>` with the
 * password via env (never on the command line — it would land in the
 * process list). Exit 0 means reachable; the snapshot count is surfaced
 * when the output parses.
 */
export async function testResticRepository(
  repository: string,
  password: string,
): Promise<TestOutcome> {
  try {
    const proc = Bun.spawn(["restic", "snapshots", "--json", "-r", repository], {
      env: { ...process.env, RESTIC_PASSWORD: password },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code === 0) {
      let count = 0;
      try {
        const parsed: unknown = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
        if (Array.isArray(parsed)) count = parsed.length;
      } catch {
        // exit 0 with unparseable stdout still means reachable.
      }
      return { ok: true, detail: `repository ok (${count} snapshot(s))` };
    }
    const detail = stderr.trim().split("\n").pop() ?? "unknown restic error";
    return { ok: false, detail };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
