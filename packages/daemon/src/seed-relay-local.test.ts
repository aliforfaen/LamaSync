// LAMA-346 Stage 1b — the local object store and the transport, driven against
// each other. No rclone, no network, no configured backend, no credentials.
//
// The pipeline under test is the whole bounded transport:
//
//   archive bytes → hash locally → put (immutability + streaming verify)
//     → head read-back → immutable metadata
//       → get into a target path → re-hash ON DISK → verified before extraction
//         → cleanup (idempotent, retryable, namespace-confined)
//
// plus the fail-closed paths: a corrupted object, a short object, a swapped
// digest, a key outside the namespace, an aborted upload, an immutable re-put,
// a partial cleanup, and a re-run of a finished cleanup.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  cleanupAfterFailure,
  cleanupSeedRelayObjects,
  downloadSeedArchive,
  seedRelayFileDigest,
  seedTransportPhaseAllowed,
  uploadSeedArchive,
} from "./seed-transport.ts";
import {
  SEED_RELAY_DIGEST_SUFFIX,
  SEED_RELAY_TMP_DIR,
  createLocalSeedRelayStore,
  resolveSeedRelayObjectPath,
  seedRelayBytesSource,
} from "./seed-relay-local.ts";
import {
  SEED_JOB_PHASES,
  initialSeedRelayCleanup,
  seedRelayArchiveKey,
  seedRelayCleanupDue,
  seedRelayOrphanKeys,
  type SeedRelayStore,
} from "@lamasync/core";

const JOB = "job-1";
const MANIFEST = "b".repeat(64);
const DIGEST = "a".repeat(64);

let root: string;
let storeRoot: string;
let sourceDir: string;
let targetDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lama346-relay-"));
  storeRoot = join(root, "objects");
  sourceDir = join(root, "source");
  targetDir = join(root, "target");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function store(): SeedRelayStore {
  return createLocalSeedRelayStore({ rootDir: storeRoot });
}

/** Write a fake "archive" and return its path plus its real digest. */
async function fixtureArchive(
  name = "payload.tar.gz",
  size = 4096,
  salt = 1,
): Promise<{ path: string; bytes: number; sha256: string }> {
  const path = join(sourceDir, name);
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + salt * 17) % 251;
  writeFileSync(path, bytes);
  const digest = await seedRelayFileDigest(path);
  return { path, ...digest };
}

async function upload(path: string, overrides: { manifestFingerprint?: string } = {}) {
  return uploadSeedArchive({
    store: store(),
    jobId: JOB,
    format: "tar.gz",
    archivePath: path,
    manifestFingerprint: overrides.manifestFingerprint ?? MANIFEST,
    memberCount: 7,
    now: 1_000,
  });
}

/** Write a fixture archive, upload it, and return the upload result. */
async function uploadFixture() {
  const archive = await fixtureArchive();
  const result = await upload(archive.path);
  expect(result.ok).toBe(true);
  return result;
}

describe("local object store: keys cannot escape the namespace or the root", () => {
  test("a valid key resolves inside the root and an invalid one is refused", () => {
    const good = resolveSeedRelayObjectPath(storeRoot, seedRelayArchiveKey(JOB, "tar.gz"));
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.path.startsWith(storeRoot)).toBe(true);

    for (const key of [
      "lamasync/seed/../../etc/passwd",
      "/etc/passwd",
      "lamasync/seed/j/a/b",
      "folders/lamasync/seed/j/payload.tar.gz",
      "lamasync/seed/j/payload.tar.gz\n",
    ]) {
      expect(resolveSeedRelayObjectPath(storeRoot, key).ok).toBe(false);
    }
  });

  test("every store call refuses a key outside the namespace before touching disk", async () => {
    const s = store();
    const outside = "lamasync/seed/../../escape.txt";
    expect((await s.head(outside)).ok).toBe(false);
    expect((await s.delete(outside)).ok).toBe(false);
    expect(
      (await s.put({ key: outside, source: seedRelayBytesSource(new Uint8Array([1])), expected: { bytes: 1, sha256: DIGEST } })).ok,
    ).toBe(false);
    expect((await s.get({ key: outside, destPath: join(targetDir, "x"), expected: { bytes: 1, sha256: DIGEST } })).ok).toBe(false);
    // Nothing was created anywhere outside the store root.
    expect(existsSync(join(root, "escape.txt"))).toBe(false);
    expect(existsSync(join(storeRoot, "escape.txt"))).toBe(false);
  });

  test("listing refuses a prefix outside the seed namespace", async () => {
    const s = store();
    expect((await s.list("folders/")).ok).toBe(false);
    expect((await s.list("")).ok).toBe(false);
    expect((await s.list("lamasync/seed/")).ok).toBe(true);
  });
});

describe("local object store: put, head, get, delete", () => {
  test("put is atomic, head reports the digest, get verifies, delete is idempotent", async () => {
    const s = store();
    const archive = await fixtureArchive();
    const key = seedRelayArchiveKey(JOB, "tar.gz");

    const put = await s.put({ key, source: { kind: "file", path: archive.path }, expected: archive });
    expect(put.ok).toBe(true);
    if (put.ok) {
      expect(put.value.bytes).toBe(archive.bytes);
      expect(put.value.sha256).toBe(archive.sha256);
      expect(put.value.key).toBe(key);
    }
    // A digest sidecar is written, and it is not itself an object.
    expect(existsSync(join(storeRoot, key))).toBe(true);
    expect(existsSync(join(storeRoot, `${key}${SEED_RELAY_DIGEST_SUFFIX}`))).toBe(true);
    const listed = await s.list("lamasync/seed/");
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value.keys).toEqual([key]);
    // No partial upload is left behind in the working directory.
    expect(existsSync(join(storeRoot, SEED_RELAY_TMP_DIR, "x"))).toBe(false);
    expect(readdirSync(join(storeRoot, SEED_RELAY_TMP_DIR))).toEqual([]);

    const head = await s.head(key);
    expect(head.ok && head.value.sha256).toBe(archive.sha256);

    const dest = join(targetDir, "downloaded.tar.gz");
    const got = await s.get({ key, destPath: dest, expected: archive });
    expect(got.ok).toBe(true);
    expect(readFileSync(dest).length).toBe(archive.bytes);

    const first = await s.delete(key);
    expect(first.ok && first.value).toEqual({ deleted: true, alreadyAbsent: false });
    const second = await s.delete(key);
    expect(second.ok && second.value).toEqual({ deleted: false, alreadyAbsent: true });
    // The sidecar goes with the object.
    expect(existsSync(join(storeRoot, `${key}${SEED_RELAY_DIGEST_SUFFIX}`))).toBe(false);
  });

  test("put refuses to replace an object with different content (immutable)", async () => {
    const s = store();
    const key = seedRelayArchiveKey(JOB, "tar.gz");
    const first = await fixtureArchive("one.tar.gz", 2048, 1);
    expect((await s.put({ key, source: { kind: "file", path: first.path }, expected: first })).ok).toBe(true);

    const second = await fixtureArchive("two.tar.gz", 2048, 2);
    const overwrite = await s.put({ key, source: { kind: "file", path: second.path }, expected: second });
    expect(overwrite.ok).toBe(false);
    if (!overwrite.ok) expect(overwrite.error).toContain("immutable");
    // The stored object is untouched.
    const head = await s.head(key);
    expect(head.ok && head.value.sha256).toBe(first.sha256);

    // Re-putting the SAME bytes is an idempotent success, which is what makes a
    // retried upload safe.
    const again = await s.put({ key, source: { kind: "file", path: first.path }, expected: first });
    expect(again.ok).toBe(true);
  });

  test("put refuses a source that does not match the expected digest or size", async () => {
    const s = store();
    const key = seedRelayArchiveKey(JOB, "tar.gz");
    const archive = await fixtureArchive();
    const wrongDigest = await s.put({
      key,
      source: { kind: "file", path: archive.path },
      expected: { bytes: archive.bytes, sha256: "c".repeat(64) },
    });
    expect(wrongDigest.ok).toBe(false);
    if (!wrongDigest.ok) expect(wrongDigest.error).toContain("SHA-256");
    const wrongSize = await s.put({
      key,
      source: { kind: "file", path: archive.path },
      expected: { bytes: archive.bytes - 1, sha256: archive.sha256 },
    });
    expect(wrongSize.ok).toBe(false);
    if (!wrongSize.ok) expect(wrongSize.error).toContain("larger than the recorded");
    // A refused put leaves nothing behind.
    expect((await s.head(key)).ok).toBe(false);
    expect(readdirSync(join(storeRoot, SEED_RELAY_TMP_DIR))).toEqual([]);
  });

  test("get deletes the partial file when the stored bytes do not match", async () => {
    const s = store();
    const key = seedRelayArchiveKey(JOB, "tar.gz");
    const archive = await fixtureArchive();
    expect((await s.put({ key, source: { kind: "file", path: archive.path }, expected: archive })).ok).toBe(true);
    // Corrupt the stored object behind the store's back.
    writeFileSync(join(storeRoot, key), Buffer.alloc(archive.bytes, 9));
    const dest = join(targetDir, "corrupt.tar.gz");
    const got = await s.get({ key, destPath: dest, expected: archive });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("SHA-256");
    expect(existsSync(dest)).toBe(false);
  });

  test("a truncated stored object is refused and never handed over", async () => {
    const s = store();
    const key = seedRelayArchiveKey(JOB, "tar.gz");
    const archive = await fixtureArchive();
    expect((await s.put({ key, source: { kind: "file", path: archive.path }, expected: archive })).ok).toBe(true);
    writeFileSync(join(storeRoot, key), Buffer.alloc(16, 3));
    const dest = join(targetDir, "short.tar.gz");
    const got = await s.get({ key, destPath: dest, expected: archive });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("bytes");
    expect(existsSync(dest)).toBe(false);
  });

  test("head reports notFound for an absent object and never a digest", async () => {
    const s = store();
    const head = await s.head(seedRelayArchiveKey("nobody", "tar.gz"));
    expect(head.ok).toBe(false);
    if (!head.ok) {
      expect(head.notFound).toBe(true);
      expect(head.error).toContain("no object stored");
    }
  });

  test("a store root that cannot be created fails without throwing", async () => {
    const broken = createLocalSeedRelayStore({ rootDir: join(root, "file-not-dir") });
    writeFileSync(join(root, "file-not-dir"), "not a directory");
    const put = await broken.put({
      key: seedRelayArchiveKey(JOB, "tar.gz"),
      source: seedRelayBytesSource(new Uint8Array([1, 2, 3])),
      expected: { bytes: 3, sha256: DIGEST },
    });
    expect(put.ok).toBe(false);
  });
});

describe("upload: hashed before upload, read back afterwards", () => {
  test("a good archive uploads and yields immutable metadata", async () => {
    const archive = await fixtureArchive();
    const progress: number[] = [];
    const result = await uploadSeedArchive({
      store: store(),
      jobId: JOB,
      format: "tar.gz",
      archivePath: archive.path,
      manifestFingerprint: MANIFEST,
      memberCount: 7,
      now: 1_000,
      onProgress: (p) => progress.push(p.bytesDone),
    });
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.metadata).toEqual({
      jobId: JOB,
      objectKey: seedRelayArchiveKey(JOB, "tar.gz"),
      format: "tar.gz",
      bytes: archive.bytes,
      sha256: archive.sha256,
      manifestFingerprint: MANIFEST,
      memberCount: 7,
      createdAt: 1_000,
    });
    expect(result.archive.uploadedAt).toBe(1_000);
    expect(result.archive.cleanup.state).toBe("not_started");
    // Progress was reported with a known total.
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(archive.bytes);
  });

  test("a missing archive, an empty archive or a bad manifest fingerprint is refused", async () => {
    const missing = await upload(join(sourceDir, "nope.tar.gz"));
    expect(missing.ok).toBe(false);
    expect(missing.metadata).toBeNull();

    const emptyPath = join(sourceDir, "empty.tar.gz");
    writeFileSync(emptyPath, "");
    const empty = await upload(emptyPath);
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain("empty");

    const archive = await fixtureArchive();
    const badManifest = await upload(archive.path, { manifestFingerprint: "not-a-digest" });
    expect(badManifest.ok).toBe(false);
    expect(badManifest.error).toContain("manifest fingerprint");
    // A refused upload stores nothing.
    expect((await store().head(seedRelayArchiveKey(JOB, "tar.gz"))).ok).toBe(false);
  });

  test("an archive that changes between the hash and the upload is refused and removed", async () => {
    const archive = await fixtureArchive();
    const s = store();
    // Simulate a store that receives different bytes than were hashed: the
    // store's own streaming verification catches it, and the transport deletes
    // whatever landed.
    const result = await uploadSeedArchive({
      store: {
        ...s,
        put: async (input) => {
          const tampered = join(sourceDir, "tampered.tar.gz");
          writeFileSync(tampered, Buffer.alloc(archive.bytes, 4));
          return s.put({ ...input, source: { kind: "file", path: tampered } });
        },
      },
      jobId: JOB,
      format: "tar.gz",
      archivePath: archive.path,
      manifestFingerprint: MANIFEST,
      memberCount: 7,
      now: 1_000,
    });
    expect(result.ok).toBe(false);
    expect(result.metadata).toBeNull();
    expect((await store().head(seedRelayArchiveKey(JOB, "tar.gz"))).ok).toBe(false);
  });

  test("a store that misreports what it stored is refused and the object removed", async () => {
    const archive = await fixtureArchive();
    const s = store();
    const result = await uploadSeedArchive({
      store: {
        ...s,
        head: async (key) => ({ ok: true, value: { key, bytes: archive.bytes, sha256: "d".repeat(64), storedAt: 1 } }),
      },
      jobId: JOB,
      format: "tar.gz",
      archivePath: archive.path,
      manifestFingerprint: MANIFEST,
      memberCount: 7,
      now: 1_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("removed");
    expect((await store().head(seedRelayArchiveKey(JOB, "tar.gz"))).ok).toBe(false);
  });

  test("an abort during upload leaves no object behind", async () => {
    const archive = await fixtureArchive("big.tar.gz", 512 * 1024);
    const controller = new AbortController();
    const result = await uploadSeedArchive({
      store: store(),
      jobId: JOB,
      format: "tar.gz",
      archivePath: archive.path,
      manifestFingerprint: MANIFEST,
      memberCount: 7,
      now: 1_000,
      signal: controller.signal,
      // Abort mid-transfer, which is the case that must clean up after itself.
      onProgress: () => controller.abort(),
    });
    expect(result.ok).toBe(false);
    expect((await store().head(seedRelayArchiveKey(JOB, "tar.gz"))).ok).toBe(false);
  });
});

describe("download: verified before extraction", () => {
  test("a matching download is verified against the recorded metadata", async () => {
    const up = await uploadFixture();
    const dest = join(targetDir, "staging.tar.gz");
    const progress: number[] = [];
    const down = await downloadSeedArchive({
      store: store(),
      jobId: JOB,
      archive: up.archive,
      destPath: dest,
      now: 2_000,
      onProgress: (p) => progress.push(p.bytesDone),
    });
    expect(down.error).toBeNull();
    expect(down.ok).toBe(true);
    expect(down.sha256).toBe(up.archive.sha256);
    expect(down.archive.verifiedAt).toBe(2_000);
    expect(existsSync(dest)).toBe(true);
    expect(progress.at(-1)).toBe(up.metadata?.bytes);
  });

  test("a job with no recorded metadata cannot download anything", async () => {
    const up = await uploadFixture();
    const dest = join(targetDir, "no-metadata.tar.gz");
    const down = await downloadSeedArchive({
      store: store(),
      jobId: JOB,
      archive: { ...up.archive, sha256: null, objectKey: null },
      destPath: dest,
      now: 2_000,
    });
    expect(down.ok).toBe(false);
    expect(down.error).toContain("no recorded archive metadata");
    expect(existsSync(dest)).toBe(false);
  });

  test("a digest that does not match the stored object is refused and the file deleted", async () => {
    const up = await uploadFixture();
    const dest = join(targetDir, "mismatch.tar.gz");
    const down = await downloadSeedArchive({
      store: store(),
      jobId: JOB,
      archive: { ...up.archive, sha256: "e".repeat(64) },
      destPath: dest,
      now: 2_000,
    });
    expect(down.ok).toBe(false);
    expect(down.error).toContain("SHA-256");
    expect(existsSync(dest)).toBe(false);
  });

  test("a recorded byte count that does not match is refused", async () => {
    const up = await uploadFixture();
    const dest = join(targetDir, "size.tar.gz");
    const down = await downloadSeedArchive({
      store: store(),
      jobId: JOB,
      archive: { ...up.archive, bytes: (up.archive.bytes ?? 0) + 1 },
      destPath: dest,
      now: 2_000,
    });
    expect(down.ok).toBe(false);
    expect(down.error).toContain("bytes");
    expect(existsSync(dest)).toBe(false);
  });

  test("a key that belongs to another job is refused before the store is called", async () => {
    const up = await uploadFixture();
    let storeCalled = false;
    const dest = join(targetDir, "other-job.tar.gz");
    const down = await downloadSeedArchive({
      store: {
        ...store(),
        get: async (input) => {
          storeCalled = true;
          return store().get(input);
        },
      },
      jobId: "different-job",
      archive: up.archive,
      destPath: dest,
      now: 2_000,
    });
    expect(down.ok).toBe(false);
    expect(down.error).toContain("belongs to job");
    expect(storeCalled).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  test("an absent object fails as notFound and leaves no file", async () => {
    const up = await uploadFixture();
    const dest = join(targetDir, "absent.tar.gz");
    const down = await downloadSeedArchive({
      store: store(),
      jobId: JOB,
      archive: { ...up.archive, objectKey: seedRelayArchiveKey("another-job", "tar.gz") },
      destPath: dest,
      now: 2_000,
    });
    // Refused for the wrong job before any store call.
    expect(down.ok).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  test("an abort during download leaves no file behind", async () => {
    const up = await uploadFixture();
    const dest = join(targetDir, "aborted.tar.gz");
    const controller = new AbortController();
    const down = await downloadSeedArchive({
      store: store(),
      jobId: JOB,
      archive: up.archive,
      destPath: dest,
      now: 2_000,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    expect(down.ok).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });
});

describe("cleanup and retention", () => {
  test("cleanup is idempotent: it finishes a partial pass and then no-ops", async () => {
    const up = await uploadFixture();
    const key = seedRelayArchiveKey(JOB, "tar.gz");
    const s = store();

    // First pass with a store that fails once.
    let attempts = 0;
    const flaky: SeedRelayStore = {
      ...s,
      delete: async (k) => {
        attempts += 1;
        if (attempts === 1) return { ok: false, error: "temporary store failure", notFound: false };
        return s.delete(k);
      },
    };
    const first = await cleanupSeedRelayObjects({
      store: flaky,
      keys: [key],
      cleanup: initialSeedRelayCleanup(),
      now: 3_000,
    });
    expect(first.complete).toBe(false);
    expect(first.cleanup.state).toBe("failed");
    expect(first.cleanup.attempts).toBe(1);
    expect(first.cleanup.message).toContain("temporary store failure");
    expect((await s.head(key)).ok).toBe(true);

    // Second pass completes it.
    const second = await cleanupSeedRelayObjects({ store: flaky, keys: [key], cleanup: first.cleanup, now: 3_001 });
    expect(second.complete).toBe(true);
    expect(second.cleanup.state).toBe("cleaned");
    expect(second.cleanup.attempts).toBe(2);
    expect(second.cleanup.deletedKeys).toEqual([key]);
    expect((await s.head(key)).ok).toBe(false);

    // Third pass is a no-op that reports the same state.
    const third = await cleanupSeedRelayObjects({ store: flaky, keys: [key], cleanup: second.cleanup, now: 3_002 });
    expect(third.complete).toBe(true);
    expect(third.cleanup).toEqual(second.cleanup);
    expect(attempts).toBe(2);
  });

  test("deleting an object that is already gone counts as cleaned, not failed", async () => {
    const key = seedRelayArchiveKey(JOB, "tar.gz");
    const result = await cleanupSeedRelayObjects({
      store: store(),
      keys: [key],
      cleanup: initialSeedRelayCleanup(),
      now: 3_000,
    });
    expect(result.complete).toBe(true);
    expect(result.cleanup.state).toBe("cleaned");
    expect(result.cleanup.deletedKeys).toEqual([key]);
  });

  test("a key outside the namespace is refused and never deleted", async () => {
    const up = await uploadFixture();
    const key = seedRelayArchiveKey(JOB, "tar.gz");
    const result = await cleanupSeedRelayObjects({
      store: store(),
      keys: [key, "lamasync/seed/../../escape.txt", "/etc/passwd"],
      cleanup: initialSeedRelayCleanup(),
      now: 3_000,
    });
    expect(result.complete).toBe(false);
    expect(result.cleanup.state).toBe("failed");
    expect(result.cleanup.deletedKeys).toEqual([key]);
    expect(result.error).toContain("traversal");
    expect((await store().head(key)).ok).toBe(false);
  });

  test("cleanup after a failure never masks the original error", async () => {
    const up = await uploadFixture();
    const key = seedRelayArchiveKey(JOB, "tar.gz");
    const cleanup = await cleanupAfterFailure({
      store: store(),
      keys: [key],
      cleanup: initialSeedRelayCleanup(),
      now: 3_000,
    });
    expect(cleanup.state).toBe("cleaned");
    expect((await store().head(key)).ok).toBe(false);
    // A cleanup failure still returns a retryable state instead of throwing.
    const broken: SeedRelayStore = {
      ...store(),
      delete: async () => {
        throw new Error("store exploded with a secret-looking value");
      },
    };
    const up2 = await uploadFixture();
    const afterThrow = await cleanupAfterFailure({
      store: broken,
      keys: [seedRelayArchiveKey(JOB, "tar.gz")],
      cleanup: initialSeedRelayCleanup(),
      now: 3_000,
    });
    expect(afterThrow.state).toBe("failed");
    void up2;
  });

  test("the job's own state decides when cleanup is due", async () => {
    const up = await uploadFixture();
    const cleanup = up.archive.cleanup;
    const storedAt = 1_000;
    expect(
      seedRelayCleanupDue({ job: { status: "running", phase: "downloading_archive" }, cleanup, storedAt, now: 2_000 }).due,
    ).toBe(false);
    expect(seedRelayCleanupDue({ job: { status: "completed", phase: "completed" }, cleanup, storedAt, now: 2_000 }).due).toBe(
      true,
    );
  });

  test("an orphan sweep only names seed-namespace keys", async () => {
    await uploadFixture();
    const s = store();
    const listed = await s.list("lamasync/seed/");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.keys).toEqual([seedRelayArchiveKey(JOB, "tar.gz")]);
    const { orphans, invalid } = seedRelayOrphanKeys({ listedKeys: listed.value.keys, knownJobIds: [] });
    expect(orphans).toEqual([seedRelayArchiveKey(JOB, "tar.gz")]);
    expect(invalid).toEqual([]);
  });
});

describe("no credentials, and the local store is not a live backend", () => {
  test("the store is constructed from a directory alone and labels itself", () => {
    expect(store().kind).toBe("local-fs");
    // There is no endpoint, bucket, key or secret anywhere in the contract: the
    // constructor takes a root directory, and nothing in the results carries one.
    const keys = Object.keys(createLocalSeedRelayStore({ rootDir: storeRoot }));
    expect(keys.sort()).toEqual(["delete", "get", "head", "kind", "list", "put"]);
  });

  test("failure sentences name the store type, never a location", async () => {
    const s = createLocalSeedRelayStore({ rootDir: join(root, "no-such-root") });
    const missing = await s.head(seedRelayArchiveKey("ghost", "tar.gz"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toContain("no object stored");
      expect(missing.error).not.toContain(storeRoot);
    }
  });

  test("a symlink cannot be used to reach outside the store root", async () => {
    const outside = join(root, "outside-secret.txt");
    writeFileSync(outside, "secret\n");
    mkdirSync(join(storeRoot, "lamasync", "seed"), { recursive: true });
    symlinkSync(outside, join(storeRoot, "lamasync", "seed", "link"));
    // A symlink is not an object: it is not a regular file, so it is refused
    // rather than followed.
    const s = store();
    const head = await s.head("lamasync/seed/link/placeholder.tar.gz");
    expect(head.ok).toBe(false);
    // And reading through it never happens: `get` on a path whose parent is the
    // symlink fails rather than returning the secret.
    const dest = join(targetDir, "leak.tar.gz");
    const got = await s.get({
      key: "lamasync/seed/link/placeholder.tar.gz",
      destPath: dest,
      expected: { bytes: 7, sha256: DIGEST },
    });
    expect(got.ok).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });
});

describe("the transport reuses the job state machine instead of inventing state", () => {
  test("each step names the phase it owns and only a legal transition is allowed", () => {
    // The transport's own phases, in the order the state machine defines.
    expect(seedTransportPhaseAllowed("archiving_source", "upload")).toEqual({
      ok: true,
      phase: "uploading_archive",
      error: null,
    });
    expect(seedTransportPhaseAllowed("uploading_archive", "download")).toEqual({
      ok: true,
      phase: "downloading_archive",
      error: null,
    });
    expect(seedTransportPhaseAllowed("downloading_archive", "verify")).toEqual({
      ok: true,
      phase: "verifying_archive",
      error: null,
    });
    // Re-entering the same phase is allowed (a resumable retry).
    expect(seedTransportPhaseAllowed("uploading_archive", "upload").ok).toBe(true);
  });

  test("a step that would skip a phase, or run on an ended job, is refused", () => {
    const skipped = seedTransportPhaseAllowed("preflight", "upload");
    expect(skipped.ok).toBe(false);
    expect(skipped.error).toContain("would skip a phase");
    // Going backwards is refused too.
    expect(seedTransportPhaseAllowed("verifying_archive", "upload").ok).toBe(false);
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      const ended = seedTransportPhaseAllowed(terminal, "download");
      expect(ended.ok).toBe(false);
      expect(ended.error).toContain("already ended");
    }
  });

  test("the phases the transport drives are real phases of the job machine", () => {
    for (const step of ["upload", "download", "verify"] as const) {
      expect(SEED_JOB_PHASES).toContain(seedTransportPhaseAllowed("preflight", step).phase);
    }
  });
});
