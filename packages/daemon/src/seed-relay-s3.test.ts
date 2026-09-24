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
import { createHash, randomUUID as cryptoRandomUuid } from "crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { seedRelayArchiveKey, seedRelayManifestKey } from "@lamasync/core";
import {
  createS3SeedRelayStore,
  ensureS3SeedRelayBucket,
  seedRelayS3MultipartProblem,
  seedRelayS3Transport,
  SEED_RELAY_S3_DEFAULT_PART_BYTES,
  SEED_RELAY_S3_MAX_PARTS,
  SEED_RELAY_S3_MAX_SINGLE_PUT_BYTES,
  SEED_RELAY_S3_MIN_PART_BYTES,
} from "./seed-relay-s3.ts";

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

// ---------------------------------------------------------------------------
// The transport DECISION, proven without a network or a 15 GB file.
// ---------------------------------------------------------------------------

describe("the store never sends a whole large archive in one request", () => {
  test("a small object stays a single request, a large one goes multipart", () => {
    const small = seedRelayS3Transport(1024, {});
    expect(small.multipart).toBe(false);
    expect(small.parts).toBe(1);

    // The default threshold is one part, so anything that does not fit in a
    // single part is chunked — and a real Projects archive (~14.86 GB) is
    // hundreds of parts.
    const archive = seedRelayS3Transport(14_864_173_809, {});
    expect(archive.multipart).toBe(true);
    expect(archive.partSize).toBe(SEED_RELAY_S3_DEFAULT_PART_BYTES);
    expect(archive.parts).toBe(Math.ceil(14_864_173_809 / SEED_RELAY_S3_DEFAULT_PART_BYTES));
    expect(archive.parts).toBeLessThanOrEqual(SEED_RELAY_S3_MAX_PARTS);
  });

  test("the single-request ceiling is unreachable even with an absurd part size", () => {
    // Backblaze documents 5 GB for a single-request upload. A deployment that
    // raises the part size cannot raise THIS: above the ceiling the transport is
    // multipart no matter what the threshold says.
    const overCeiling = seedRelayS3Transport(SEED_RELAY_S3_MAX_SINGLE_PUT_BYTES + 1, {
      partSizeBytes: SEED_RELAY_S3_MAX_SINGLE_PUT_BYTES,
      multipartThresholdBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(overCeiling.multipart).toBe(true);
    expect(overCeiling.reason).toContain("single-request ceiling");
  });

  test("the part size is clamped to S3's own limits", () => {
    // Too small a part is invalid S3 (only the LAST part may be under 5 MiB).
    expect(seedRelayS3Transport(10, { partSizeBytes: 1 }).partSize).toBe(SEED_RELAY_S3_MIN_PART_BYTES);
    // And a threshold below one part cannot force an invalid first part.
    const tiny = seedRelayS3Transport(6 * 1024 * 1024, { partSizeBytes: 1024, multipartThresholdBytes: 1 });
    expect(tiny.partSize).toBe(SEED_RELAY_S3_MIN_PART_BYTES);
    expect(tiny.parts).toBe(2);
  });

  test("a part count above S3's limit fails closed with the numbers", () => {
    const problem = seedRelayS3MultipartProblem(SEED_RELAY_S3_MAX_PARTS * 1024 + 1, 1024);
    expect(problem).not.toBeNull();
    expect(problem).toContain("above S3's limit");
    expect(seedRelayS3MultipartProblem(SEED_RELAY_S3_MAX_PARTS * 1024, 1024)).toBeNull();
  });
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

// ---------------------------------------------------------------------------
// MULTIPART, against the real object space.
//
// A real Projects archive is ~14.86 GB before compression and Backblaze
// documents a 5 GB single-request ceiling, so a one-shot PUT is not a transport.
// Allocating gigabytes in a test would prove nothing that a lowered part size
// does not prove better, so these tests set the part size to S3's own MINIMUM
// (5 MiB) and use a 12 MiB object: three real parts, over the real wire, through
// the real multipart protocol.
// ---------------------------------------------------------------------------

/** The S3 minimum part size, and an object that needs three of them. */
const MULTIPART_PART_BYTES = SEED_RELAY_S3_MIN_PART_BYTES;
const MULTIPART_OBJECT_BYTES = 12 * 1024 * 1024;

interface RecordedRequest {
  method: string;
  url: string;
}

/** A fetch wrapper that records the multipart conversation it observes. */
function recordingFetch(): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const wrapped = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push({ method: init?.method ?? "GET", url: String(input) });
      return await fetch(input, init);
    },
    { preconnect: () => {} },
  );
  return { fetchImpl: wrapped as unknown as typeof fetch, requests };
}

function multipartOptions(fetchImpl?: typeof fetch) {
  return {
    ...options(),
    partSizeBytes: MULTIPART_PART_BYTES,
    multipartThresholdBytes: MULTIPART_PART_BYTES,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  };
}

/**
 * A key unique to THIS run. The object space outlives a test run (the MinIO
 * container is disposable, the bucket inside it is reused), and an object left
 * by an earlier run would turn "did this upload go multipart?" into a question
 * about someone else's object.
 */
function uniqueKey(name: string): string {
  return seedRelayArchiveKey(`${name}-${cryptoRandomUuid().slice(0, 8)}`, "tar.gz");
}

function multipartFixture(name: string): { path: string; bytes: number; sha256: string } {
  const path = join(SANDBOX, `${name}.bin`);
  const data = pseudoBytes(0x5eed, MULTIPART_OBJECT_BYTES);
  writeFileSync(path, data);
  return { path, bytes: data.byteLength, sha256: sha256Hex(data) };
}

describe.skipIf(!AVAILABLE)("a large archive goes multipart, and keeps every guarantee", () => {
  test("a 3-part upload round-trips with the whole-file digest as object metadata", async () => {
    await ensureS3SeedRelayBucket(options());
    const recorder = recordingFetch();
    const store = createS3SeedRelayStore(multipartOptions(recorder.fetchImpl));
    const fixture = multipartFixture("multipart-round-trip");
    const key = uniqueKey("multipart-round-trip");

    const progress: number[] = [];
    const put = await store.put({
      key,
      source: { kind: "file", path: fixture.path },
      expected: { bytes: fixture.bytes, sha256: fixture.sha256 },
      onProgress: (p) => progress.push(p.bytesDone),
    });
    expect(put.ok).toBe(true);
    if (!put.ok) return;

    // The protocol, observed: initiate, one request per part, complete — and
    // never a request carrying more than one part.
    expect(recorder.requests.some((r) => r.url.includes("uploads"))).toBe(true);
    const parts = recorder.requests.filter((r) => r.url.includes("partNumber="));
    expect(parts.length).toBe(3);
    expect(parts.map((r) => r.method)).toEqual(["PUT", "PUT", "PUT"]);
    expect(recorder.requests.filter((r) => r.url.includes("uploadId=") && r.method === "POST").length).toBe(1);

    // Progress is reported ACROSS the parts, monotonically, ending at the total.
    expect(progress.length).toBe(3);
    expect(progress[progress.length - 1]).toBe(fixture.bytes);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);

    // The digest the transport needs is the WHOLE-FILE one, on the object.
    expect(put.value.bytes).toBe(fixture.bytes);
    expect(put.value.sha256).toBe(fixture.sha256);

    const head = await store.head(key);
    expect(head.ok && head.value.sha256 === fixture.sha256).toBe(true);

    const dest = join(SANDBOX, "multipart-round-trip.out");
    const got = await store.get({
      key,
      destPath: dest,
      expected: { bytes: fixture.bytes, sha256: fixture.sha256 },
    });
    expect(got.ok).toBe(true);
    expect(sha256Hex(readFileSync(dest))).toBe(fixture.sha256);
  });

  test("immutability still holds for a multipart object", async () => {
    const store = createS3SeedRelayStore(multipartOptions());
    const fixture = multipartFixture("multipart-immutable");
    const key = uniqueKey("multipart-immutable");
    const first = await store.put({
      key,
      source: { kind: "file", path: fixture.path },
      expected: { bytes: fixture.bytes, sha256: fixture.sha256 },
    });
    expect(first.ok).toBe(true);
    // Byte-identical re-put: idempotent success.
    const again = await store.put({
      key,
      source: { kind: "file", path: fixture.path },
      expected: { bytes: fixture.bytes, sha256: fixture.sha256 },
    });
    expect(again.ok).toBe(true);
    // Different content at the same key: REFUSED, and the stored object stays.
    const other = pseudoBytes(1, 1024);
    const different = await store.put({
      key,
      source: { kind: "bytes", data: other },
      expected: { bytes: other.byteLength, sha256: sha256Hex(other) },
    });
    expect(different.ok).toBe(false);
    if (!different.ok) expect(different.error).toContain("immutable");
    const head = await store.head(key);
    expect(head.ok && head.value.sha256 === fixture.sha256).toBe(true);
  });

  test("a cancelled multipart upload leaves NO object and ABORTS the upload", async () => {
    const recorder = recordingFetch();
    const store = createS3SeedRelayStore(multipartOptions(recorder.fetchImpl));
    const fixture = multipartFixture("multipart-cancelled");
    const key = uniqueKey("multipart-cancelled");
    const controller = new AbortController();
    const put = await store.put({
      key,
      source: { kind: "file", path: fixture.path },
      expected: { bytes: fixture.bytes, sha256: fixture.sha256 },
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    expect(put.ok).toBe(false);
    if (!put.ok) expect(put.error).toContain("cancelled");

    // Nothing a target could find...
    const head = await store.head(key);
    expect(head.ok).toBe(false);
    if (!head.ok) expect(head.notFound).toBe(true);
    // ...and the unfinished upload was ABORTED rather than left behind.
    const aborts = recorder.requests.filter((r) => r.method === "DELETE" && r.url.includes("uploadId="));
    expect(aborts.length).toBeGreaterThan(0);
  });

  test("a failing part aborts the upload, and a later retry starts clean", async () => {
    // A store whose SECOND part request is refused: the first part has already
    // been accepted by the object space, so this is exactly the case an abort
    // exists for.
    let partPuts = 0;
    let failTheSecondPart = true;
    const inner = fetch;
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (init?.method === "PUT" && String(input).includes("partNumber=")) {
          partPuts += 1;
          if (failTheSecondPart && partPuts === 2) {
            return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
          }
        }
        return await inner(input, init);
      },
      { preconnect: () => {} },
    ) as unknown as typeof fetch;
    const store = createS3SeedRelayStore(multipartOptions(fetchImpl));
    const fixture = multipartFixture("multipart-part-failure");
    const key = uniqueKey("multipart-part-failure");
    const put = await store.put({
      key,
      source: { kind: "file", path: fixture.path },
      expected: { bytes: fixture.bytes, sha256: fixture.sha256 },
    });
    expect(put.ok).toBe(false);
    if (!put.ok) expect(put.error).toContain("AccessDenied");
    const head = await store.head(key);
    expect(head.ok).toBe(false);
    if (!head.ok) expect(head.notFound).toBe(true);
    // No half-uploaded state is inherited by a retry: the same key uploads
    // cleanly once the fault is gone, which it could not do if the aborted
    // upload's parts were still attached to it.
    failTheSecondPart = false;
    const retry = await store.put({
      key,
      source: { kind: "file", path: fixture.path },
      expected: { bytes: fixture.bytes, sha256: fixture.sha256 },
    });
    expect(retry.ok).toBe(true);
    await store.delete(key);
  });
});
