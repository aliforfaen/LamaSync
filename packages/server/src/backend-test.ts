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

import { createHash, createHmac } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { withTempRcloneConfig } from "./temp-rclone-config.ts";

export interface TestOutcome {
  ok: boolean;
  detail?: string;
}

export interface BucketCreateOutcome extends TestOutcome {
  status: 200 | 400 | 403 | 409 | 502;
}

function b2BucketError(stderr: string): BucketCreateOutcome {
  if (/BucketAlreadyExists/i.test(stderr)) {
    return { ok: false, status: 409, detail: "That B2 bucket name is already in use globally. Choose a different name." };
  }
  if (/InvalidBucketName/i.test(stderr)) {
    return { ok: false, status: 400, detail: "Backblaze rejected that bucket name. Use 6–63 lowercase letters, numbers, and hyphens." };
  }
  if (/AccessDenied|Forbidden|writeBuckets|writeBucketEncryption|not authorized/i.test(stderr)) {
    return { ok: false, status: 403, detail: "Backblaze denied bucket setup. Give the management key listBuckets, writeBuckets, and writeBucketEncryption permissions." };
  }
  if (/InvalidAccessKeyId|SignatureDoesNotMatch|Unauthorized|authorization/i.test(stderr)) {
    return { ok: false, status: 502, detail: "Backblaze rejected the management credentials. Check the key ID, application key, endpoint, and region." };
  }
  return { ok: false, status: 502, detail: "Backblaze could not create the bucket. Test the management key and try again." };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/** Enable B2's default SSE-B2 (AES-256) after creating the private bucket.
 * rclone creates buckets but does not expose PutBucketEncryption. */
async function enableB2DefaultEncryption(opts: {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}): Promise<BucketCreateOutcome> {
  const endpoint = new URL(opts.endpoint.startsWith("http") ? opts.endpoint : `https://${opts.endpoint}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payload = "<ServerSideEncryptionConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>";
  const payloadHash = sha256(payload);
  const canonicalUri = `/${encodeURIComponent(opts.bucket)}/`;
  const canonicalHeaders = `content-type:application/xml\nhost:${endpoint.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const scope = `${date}/${opts.region}/s3/aws4_request`;
  const canonicalRequest = `PUT\n${canonicalUri}\nencryption=\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, date), opts.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  try {
    const response = await fetch(`${endpoint.origin}${canonicalUri}?encryption`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/xml",
        "X-Amz-Content-Sha256": payloadHash,
        "X-Amz-Date": amzDate,
        Authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body: payload,
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return { ok: true, status: 200, detail: `Private bucket '${opts.bucket}' created with Backblaze-managed encryption` };
    if (response.status === 403) return { ok: false, status: 403, detail: "Bucket was created, but Backblaze denied enabling encryption. Add writeBucketEncryption to the management key, then retry." };
    return { ok: false, status: 502, detail: `Bucket was created, but Backblaze could not enable its default encryption (HTTP ${response.status}).` };
  } catch {
    return { ok: false, status: 502, detail: "Bucket was created, but enabling Backblaze default encryption timed out or failed." };
  }
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

/** Create one bucket through an S3-compatible remote. This is used only by
 * the explicit B2 bucket-creation action in the admin UI; credentials stay
 * in the private temporary rclone config and never reach a response. */
export async function createS3Bucket(
  opts: {
    provider: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    region: string | null;
  },
  bucket: string,
): Promise<BucketCreateOutcome> {
  const config = s3RcloneConfig(opts);
  const result = await withTempRcloneConfig(config, async (configPath) => {
    const proc = Bun.spawn(
      ["rclone", "mkdir", `test:${bucket}`, "--s3-acl", "private", "--config", configPath, "--timeout", "15s"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  });
  if (result.code !== 0) return b2BucketError(result.stderr);
  return enableB2DefaultEncryption({
    endpoint: opts.endpoint,
    region: opts.region ?? "",
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    bucket,
  });
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
