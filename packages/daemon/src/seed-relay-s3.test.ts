// LAMA-346 Stage 2c — the REAL network relay store, proven against MinIO.
//
// The Stage 1b/2a/2b proofs moved seed objects between two directories on one
// host. This suite moves them through an actual S3-compatible HTTP object
// space, which is the host proof §2.11 item 1 asked for. It is GATED and
// explicit: without `LAMASYNC_TEST_S3_ENDPOINT` (and credentials) it skips, and
// the named gate test below says so rather than implying a pass.
//
// The disposable harness (`scripts/lama346-seed-e2e.ts`) starts MinIO and sets
// these variables. `bun test` on its own never touches a network store.
//
// What it proves, at the store-contract level:
//   * `put` writes the digest as object metadata and refuses a differing object
//     (immutability), while a byte-identical re-put is an idempotent success;
//   * `head` reads the digest back, which is what the transport's read-back
//     verification needs from a store with no native SHA-256;
//   * `get` streams the bytes back, verifies them, and deletes a download whose
//     expected digest does not match;
//   * `delete` is idempotent (absent is a success);
//   * `list` returns exactly the namespace's keys;
//   * a key outside `lamasync/seed/` is refused before any request is built.

import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { seedRelayArchiveKey, seedRelayManifestKey } from "@lamasync/core";
import { createS3SeedRelayStore, ensureS3SeedRelayBucket } from "./seed-relay-s3.ts";

const ENDPOINT = process.env["LAMASYNC_TEST_S3_ENDPOINT"] ?? "";
const BUCKET = process.env["LAMASYNC_TEST_S3_BUCKET"] ?? "lamasync-seed-e2e";
const ACCESS_KEY = process.env["LAMASYNC_TEST_S3_ACCESS_KEY"] ?? "";
const SECRET_KEY = process.env["LAMASYNC_TEST_S3_SECRET_KEY"] ?? "";
const REGION = process.env["LAMASYNC_TEST_S3_REGION"] ?? "us-east-1";

const AVAILABLE = ENDPOINT.length > 0 && ACCESS_KEY.length > 0 && SECRET_KEY.length > 0;

const SANDBOX = mkdtempSync(join(tmpdir(), "lama346-s3-"));

function options() {
  return { endpoint: ENDPOINT, bucket: BUCKET, region: REGION, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY };
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A deterministic byte sequence, so a failure is reproducible. */
function pseudoBytes(seed: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

describe("the real-network relay gate is explicit, not silent", () => {
  test("the MinIO integration is either running or explicitly skipped", () => {
    if (AVAILABLE) {
      expect(ENDPOINT.startsWith("http")).toBe(true);
      return;
    }
    // Documented gap: without a disposable object space the local store still
    // proves the transport logic, but the real network hop needs this harness.
    expect(ENDPOINT.length === 0 || ACCESS_KEY.length === 0 || SECRET_KEY.length === 0).toBe(true);
  });
});

test("a network failure during HEAD returns a relay failure", async () => {
  const store = createS3SeedRelayStore({
    endpoint: "http://127.0.0.1:1",
    bucket: "seed-test",
    region: "us-east-1",
    accessKeyId: "test",
    secretAccessKey: "test",
    fetchImpl: Object.assign(
      async () => { throw new Error("connection refused"); },
      { preconnect: () => {} },
    ),
  });
  const key = seedRelayArchiveKey("network-failure", "tar.gz");
  const head = await store.head(key);
  expect(head.ok).toBe(false);
  if (!head.ok) expect(head.error).toContain("could not be reached");

  const put = await store.put({
    key,
    source: { kind: "bytes", data: new Uint8Array([1]) },
    expected: { bytes: 1, sha256: sha256Hex(new Uint8Array([1])) },
  });
  expect(put.ok).toBe(false);
});

describe.skipIf(!AVAILABLE)("the S3 relay store is a real object space", () => {
  test("put → head → get → list → delete, with the digest as object metadata", async () => {
    await ensureS3SeedRelayBucket(options());
    const store = createS3SeedRelayStore(options());
    expect(store.kind).toBe("s3");

    const jobId = `s3-job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const key = seedRelayArchiveKey(jobId, "tar.gz");
    const sourcePath = join(SANDBOX, `${jobId}.bin`);
    const data = pseudoBytes(7, 256 * 1024);
    writeFileSync(sourcePath, data);
    const digest = { bytes: data.length, sha256: sha256Hex(data) };

    const put = await store.put({ key, source: { kind: "file", path: sourcePath }, expected: digest });
    expect(put.ok).toBe(true);
    if (!put.ok) return;
    expect(put.value.bytes).toBe(digest.bytes);
    expect(put.value.sha256).toBe(digest.sha256);

    const head = await store.head(key);
    expect(head.ok).toBe(true);
    if (!head.ok) return;
    // The digest came back from object metadata, not from the caller.
    expect(head.value.sha256).toBe(digest.sha256);

    const destPath = join(SANDBOX, `${jobId}.download`);
    const get = await store.get({ key, destPath, expected: digest });
    expect(get.ok).toBe(true);
    expect(sha256Hex(readFileSync(destPath))).toBe(digest.sha256);

    const listed = await store.list("lamasync/seed/");
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.keys).toContain(key);

    const del = await store.delete(key);
    expect(del.ok && del.value.deleted).toBe(true);
    const delAgain = await store.delete(key);
    expect(delAgain.ok && delAgain.value.alreadyAbsent).toBe(true);
    const gone = await store.head(key);
    expect(gone.ok).toBe(false);
    expect(gone.ok === false && gone.notFound).toBe(true);
  });

  test("immutability: a differing object is refused, an identical re-put succeeds", async () => {
    await ensureS3SeedRelayBucket(options());
    const store = createS3SeedRelayStore(options());
    const jobId = `s3-immutable-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const key = seedRelayArchiveKey(jobId, "tar.gz");
    const firstPath = join(SANDBOX, `${jobId}-first.bin`);
    const secondPath = join(SANDBOX, `${jobId}-second.bin`);
    const first = pseudoBytes(11, 64 * 1024);
    const second = pseudoBytes(13, 64 * 1024);
    writeFileSync(firstPath, first);
    writeFileSync(secondPath, second);
    const firstDigest = { bytes: first.length, sha256: sha256Hex(first) };
    const secondDigest = { bytes: second.length, sha256: sha256Hex(second) };

    const put = await store.put({ key, source: { kind: "file", path: firstPath }, expected: firstDigest });
    expect(put.ok).toBe(true);

    const conflicting = await store.put({ key, source: { kind: "file", path: secondPath }, expected: secondDigest });
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) expect(conflicting.error).toContain("immutable");

    const identical = await store.put({ key, source: { kind: "file", path: firstPath }, expected: firstDigest });
    expect(identical.ok).toBe(true);
    await store.delete(key);
  });

  test("a download whose expected digest is wrong is refused and removed", async () => {
    await ensureS3SeedRelayBucket(options());
    const store = createS3SeedRelayStore(options());
    const jobId = `s3-mismatch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const key = seedRelayArchiveKey(jobId, "tar.gz");
    const sourcePath = join(SANDBOX, `${jobId}.bin`);
    const data = pseudoBytes(17, 32 * 1024);
    writeFileSync(sourcePath, data);
    const digest = { bytes: data.length, sha256: sha256Hex(data) };
    await store.put({ key, source: { kind: "file", path: sourcePath }, expected: digest });

    const destPath = join(SANDBOX, `${jobId}.wrong`);
    const get = await store.get({ key, destPath, expected: { bytes: digest.bytes, sha256: "0".repeat(64) } });
    expect(get.ok).toBe(false);
    expect(existsSync(destPath)).toBe(false);
    await store.delete(key);
  });

  test("a bytes source (the manifest) round-trips too", async () => {
    await ensureS3SeedRelayBucket(options());
    const store = createS3SeedRelayStore(options());
    const jobId = `s3-bytes-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const key = seedRelayManifestKey(jobId);
    const data = new TextEncoder().encode(JSON.stringify({ hello: "manifest", jobId }));
    const digest = { bytes: data.byteLength, sha256: sha256Hex(data) };
    const put = await store.put({ key, source: { kind: "bytes", data }, expected: digest });
    expect(put.ok).toBe(true);
    const destPath = join(SANDBOX, `${jobId}.manifest.json`);
    mkdirSync(join(SANDBOX, "nested"), { recursive: true });
    const get = await store.get({ key, destPath, expected: digest });
    expect(get.ok).toBe(true);
    expect(JSON.parse(readFileSync(destPath, "utf8")).hello).toBe("manifest");
    await store.delete(key);
  });

  test("a key outside the seed namespace never reaches the object space", async () => {
    const store = createS3SeedRelayStore(options());
    const put = await store.put({
      key: "some-other-bucket-prefix/object.bin",
      source: { kind: "bytes", data: new Uint8Array([1, 2, 3]) },
      expected: { bytes: 3, sha256: sha256Hex(new Uint8Array([1, 2, 3])) },
    });
    expect(put.ok).toBe(false);
    if (!put.ok) expect(put.error).toContain("namespace");
    const head = await store.head("../../etc/passwd");
    expect(head.ok).toBe(false);
    const list = await store.list("not-the-seed-namespace/");
    expect(list.ok).toBe(false);
  });
});
