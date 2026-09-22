// LAMA-346 Stage 1b — the seed relay contract: keys, metadata, cleanup state.
//
// These are the rules the transport depends on, so they are pinned here rather
// than only exercised through a store. The two that matter most are prefix
// containment (a key can never reach outside `lamasync/seed/<jobId>/`) and
// immutability (metadata is compared, never amended).

import { describe, expect, test } from "bun:test";
import {
  describeSeedRelayFailure,
  initialSeedRelayCleanup,
  isSeedRelayCleanupComplete,
  isValidSeedRelayJobId,
  normalizeSeedJobArchiveFacts,
  seedArchiveMatchesMetadata,
  seedArchiveMetadataProblem,
  seedRelayArchiveKey,
  seedRelayCleanupDue,
  seedRelayKeyBelongsToJob,
  seedRelayNamespace,
  seedRelayOrphanKeys,
  validateSeedRelayObjectKey,
  validateSeedRelayPrefix,
  emptySeedJobArchiveFacts,
  SEED_OBJECT_KEY_PREFIX,
  SEED_RELAY_ABANDONED_RETENTION_MS,
  SEED_SHA256_RE,
  type SeedArchiveMetadata,
  type SeedJob,
} from "@lamasync/core";

const JOB = "3f1c0a52-9d3a-4a6f-8a4d-1c2b3d4e5f60";
const DIGEST = "a".repeat(64);
const MANIFEST = "b".repeat(64);

function metadata(overrides: Partial<SeedArchiveMetadata> = {}): SeedArchiveMetadata {
  return {
    jobId: JOB,
    objectKey: seedRelayArchiveKey(JOB, "tar.zstd"),
    format: "tar.zstd",
    bytes: 1234,
    sha256: DIGEST,
    manifestFingerprint: MANIFEST,
    memberCount: 12,
    createdAt: 1_000,
    ...overrides,
  };
}

describe("the seed namespace is derived from the job id", () => {
  test("the namespace and key are inside the dedicated prefix", () => {
    expect(SEED_OBJECT_KEY_PREFIX).toBe("lamasync/seed");
    expect(seedRelayNamespace(JOB)).toBe(`lamasync/seed/${JOB}/`);
    expect(seedRelayArchiveKey(JOB, "tar.zstd")).toBe(`lamasync/seed/${JOB}/payload.tar.zst`);
    expect(seedRelayArchiveKey(JOB, "tar.gz")).toBe(`lamasync/seed/${JOB}/payload.tar.gz`);
  });

  test("a job id is a single safe key segment, or it is refused", () => {
    expect(isValidSeedRelayJobId(JOB)).toBe(true);
    expect(isValidSeedRelayJobId("job_1.2-3")).toBe(true);
    // Anything that could become a second segment, a traversal or a hidden
    // entry is not a job id.
    for (const bad of ["", ".", "..", "a/b", "../x", "-lead", ".hidden", "a\\b", "a b", "a\nb"]) {
      expect(isValidSeedRelayJobId(bad)).toBe(false);
    }
  });
});

describe("object keys are validated before any store call", () => {
  test("the archive key of a job is valid and belongs to it", () => {
    const key = seedRelayArchiveKey(JOB, "tar.gz");
    expect(validateSeedRelayObjectKey(key)).toEqual({
      ok: true,
      error: null,
      jobId: JOB,
      inNamespace: true,
    });
    expect(seedRelayKeyBelongsToJob(key, JOB)).toBe(true);
    expect(seedRelayKeyBelongsToJob(key, "another-job")).toBe(false);
  });

  test("a key outside the namespace, or with the wrong shape, is refused", () => {
    const cases: Array<[string, string]> = [
      ["/lamasync/seed/j/payload.tar.gz", "absolute"],
      ["C:/lamasync/seed/j/payload.tar.gz", "Windows path"],
      ["lamasync\\seed\\j\\payload.tar.gz", "backslash"],
      ["lamasync/seed/j/../../etc/passwd", "traversal"],
      ["lamasync/seed/../j/payload.tar.gz", "traversal"],
      ["lamasync/seed/j//payload.tar.gz", "empty path segment"],
      ["lamasync/seed/j/payload.tar.gz\n", "control character"],
      ["lamasync/seed/j", "exactly"],
      ["lamasync/seed/j/a/b", "exactly"],
      ["folders/lamasync/seed/j/payload.tar.gz", "not inside"],
      ["lamasync/seed/./payload.tar.gz", "traversal"],
      ["lamasync/seed/bad id/payload.tar.gz", "job id"],
    ];
    for (const [key, expected] of cases) {
      const verdict = validateSeedRelayObjectKey(key);
      expect(verdict.ok).toBe(false);
      expect(String(verdict.error)).toContain(expected);
    }
  });

  test("a key is refused when it belongs to a different job", () => {
    const verdict = validateSeedRelayObjectKey(seedRelayArchiveKey(JOB, "tar.gz"), "other");
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain(`belongs to job ${JOB}`);
    expect(verdict.jobId).toBe(JOB);
  });

  test("list prefixes may be a namespace but must stay inside the seed prefix", () => {
    expect(validateSeedRelayPrefix("lamasync/seed/").ok).toBe(true);
    expect(validateSeedRelayPrefix(`lamasync/seed/${JOB}/`).ok).toBe(true);
    expect(validateSeedRelayPrefix(`lamasync/seed/${JOB}`).ok).toBe(true);
    for (const bad of [
      "",
      "/lamasync/seed/",
      "lamasync/",
      "lamasync/seed",
      "lamasync/seed/../",
      "lamasync/seed/a//b",
      "lamasync/seed/a\\b",
      "lamasync/seed/a\nb",
      "folders/",
    ]) {
      expect(validateSeedRelayPrefix(bad).ok).toBe(false);
    }
  });
});

describe("archive metadata is immutable and explicitly checked", () => {
  test("a well-formed record has no problem", () => {
    expect(seedArchiveMetadataProblem(metadata())).toBeNull();
    expect(SEED_SHA256_RE.test(DIGEST)).toBe(true);
  });

  test("every field that could hide a wrong archive is checked", () => {
    expect(seedArchiveMetadataProblem(metadata({ bytes: 0 }))).toContain("byte count");
    expect(seedArchiveMetadataProblem(metadata({ bytes: 1.5 }))).toContain("byte count");
    expect(seedArchiveMetadataProblem(metadata({ sha256: "short" }))).toContain("SHA-256");
    expect(seedArchiveMetadataProblem(metadata({ sha256: DIGEST.toUpperCase() }))).toContain("SHA-256");
    expect(seedArchiveMetadataProblem(metadata({ manifestFingerprint: "" }))).toContain(
      "manifest fingerprint",
    );
    expect(seedArchiveMetadataProblem(metadata({ memberCount: 0 }))).toContain("member count");
    expect(seedArchiveMetadataProblem(metadata({ objectKey: "lamasync/seed/other/x" }))).toContain(
      "belongs to job",
    );
    // A key that is valid but is not THIS job's archive key is refused too.
    expect(seedArchiveMetadataProblem(metadata({ objectKey: seedRelayArchiveKey(JOB, "tar.gz") }))).toContain(
      "not the archive key",
    );
  });

  test("observations are compared, and a missing digest is never a pass", () => {
    expect(seedArchiveMatchesMetadata(metadata(), { bytes: 1234, sha256: DIGEST })).toEqual({
      ok: true,
      error: null,
    });
    expect(seedArchiveMatchesMetadata(metadata(), { bytes: 1233, sha256: DIGEST }).error).toContain(
      "1233 bytes but 1234",
    );
    expect(seedArchiveMatchesMetadata(metadata(), { bytes: 1234, sha256: "c".repeat(64) }).error).toContain(
      "does not match the recorded digest",
    );
    expect(seedArchiveMatchesMetadata(metadata(), { bytes: 1234, sha256: null }).error).toContain(
      "could not be read back",
    );
  });
});

describe("cleanup and retention state", () => {
  test("a fresh state is not complete, and a cleaned one is", () => {
    const fresh = initialSeedRelayCleanup();
    expect(fresh).toEqual({
      state: "not_started",
      attempts: 0,
      lastAttemptAt: null,
      deletedKeys: [],
      message: null,
    });
    expect(isSeedRelayCleanupComplete(fresh)).toBe(false);
    expect(isSeedRelayCleanupComplete({ ...fresh, state: "cleaned" })).toBe(true);
    expect(isSeedRelayCleanupComplete({ ...fresh, state: "failed" })).toBe(false);
  });

  test("cleanup is due the moment the job ends, and not before", () => {
    const cleanup = initialSeedRelayCleanup();
    const now = 10_000_000;
    expect(
      seedRelayCleanupDue({ job: { status: "running", phase: "downloading_archive" }, cleanup, storedAt: now, now }).due,
    ).toBe(false);
    for (const status of ["completed", "failed", "cancelled"]) {
      const verdict = seedRelayCleanupDue({
        job: { status, phase: status === "completed" ? "completed" : "failed" },
        cleanup,
        storedAt: now,
        now,
      });
      expect(verdict.due).toBe(true);
      expect(verdict.reason).toContain("no longer needed");
    }
    // Already cleaned: nothing to do, ever again.
    const done = seedRelayCleanupDue({
      job: { status: "completed", phase: "completed" },
      cleanup: { ...cleanup, state: "cleaned" },
      storedAt: now,
      now,
    });
    expect(done.due).toBe(false);
    expect(done.reason).toContain("already cleaned");
  });

  test("an abandoned object is only reaped after the retention window", () => {
    const cleanup = initialSeedRelayCleanup();
    const storedAt = 1_000_000;
    const inside = seedRelayCleanupDue({
      job: null,
      cleanup,
      storedAt,
      now: storedAt + SEED_RELAY_ABANDONED_RETENTION_MS - 1,
    });
    expect(inside.due).toBe(false);
    expect(inside.reason).toContain("retention window");
    const past = seedRelayCleanupDue({
      job: null,
      cleanup,
      storedAt,
      now: storedAt + SEED_RELAY_ABANDONED_RETENTION_MS,
    });
    expect(past.due).toBe(true);
    expect(past.reason).toContain("the job is gone");
    // An unknown age is left alone: never delete on a guess.
    const unknownAge = seedRelayCleanupDue({ job: null, cleanup, storedAt: null, now: storedAt });
    expect(unknownAge.due).toBe(false);
    expect(unknownAge.reason).toContain("age is unknown");
  });

  test("orphan detection only ever names keys inside a seed namespace", () => {
    const known = ["known-job"];
    const { orphans, invalid, truncated } = seedRelayOrphanKeys({
      listedKeys: [
        `lamasync/seed/known-job/payload.tar.gz`,
        `lamasync/seed/gone-job/payload.tar.gz`,
        `lamasync/seed/gone-job/payload.tar.zst`,
        `lamasync/seed/../../etc/passwd`,
        `folders/somebody/file.txt`,
      ],
      knownJobIds: known,
    });
    expect(orphans).toEqual([
      `lamasync/seed/gone-job/payload.tar.gz`,
      `lamasync/seed/gone-job/payload.tar.zst`,
    ]);
    // A key that is not a valid seed key is REPORTED, never treated as an
    // orphan to delete — including one outside the namespace entirely, which is
    // exactly the case a mis-scoped store listing would produce.
    expect(invalid).toEqual([`lamasync/seed/../../etc/passwd`, `folders/somebody/file.txt`]);
    expect(truncated).toBe(false);
    expect(orphans.every((key) => key.startsWith("lamasync/seed/"))).toBe(true);
  });

  test("orphan detection is bounded", () => {
    const listed = Array.from({ length: 10 }, (_, i) => `lamasync/seed/gone-${i}/payload.tar.gz`);
    const { orphans, truncated } = seedRelayOrphanKeys({ listedKeys: listed, knownJobIds: [], limit: 3 });
    expect(orphans.length).toBe(3);
    expect(truncated).toBe(true);
  });

  test("failure sentences are bounded and name the store type only", () => {
    const sentence = describeSeedRelayFailure("local-fs", `  boom\n\n${"x".repeat(500)}  `);
    expect(sentence.startsWith("local-fs seed relay: boom x")).toBe(true);
    expect(sentence.length).toBeLessThanOrEqual("local-fs seed relay: ".length + 200);
    expect(sentence).not.toContain("\n");
  });
});

describe("archive facts are the transport state, and normalize fail-closed", () => {
  test("a job with no transport yet carries empty, explicitly-null facts", () => {
    const facts = emptySeedJobArchiveFacts("tar.zstd");
    expect(facts).toEqual({
      format: "tar.zstd",
      bytes: null,
      sha256: null,
      objectKey: null,
      memberCount: null,
      manifestFingerprint: null,
      uploadedAt: null,
      verifiedAt: null,
      cleanup: { state: "not_started", attempts: 0, lastAttemptAt: null, deletedKeys: [], message: null },
    });
    // The exact field set is the wire shape: a credential-shaped field added
    // later would show up here.
    expect(Object.keys(facts).sort()).toEqual([
      "bytes",
      "cleanup",
      "format",
      "manifestFingerprint",
      "memberCount",
      "objectKey",
      "sha256",
      "uploadedAt",
      "verifiedAt",
    ]);
  });

  test("a malformed or partial record normalizes to null, never to a guess", () => {
    expect(normalizeSeedJobArchiveFacts(null)).toEqual(emptySeedJobArchiveFacts("tar.gz"));
    expect(normalizeSeedJobArchiveFacts("nonsense")).toEqual(emptySeedJobArchiveFacts("tar.gz"));
    const partial = normalizeSeedJobArchiveFacts({
      format: "tar.zstd",
      bytes: -5,
      sha256: "not-a-digest",
      objectKey: 42,
      memberCount: "many",
      manifestFingerprint: "",
      uploadedAt: 0,
      verifiedAt: "soon",
      cleanup: { state: "exploded", attempts: -1, deletedKeys: ["a", 7], message: 5 },
    });
    expect(partial.format).toBe("tar.zstd");
    expect(partial.bytes).toBeNull();
    expect(partial.sha256).toBeNull();
    expect(partial.objectKey).toBeNull();
    expect(partial.memberCount).toBeNull();
    expect(partial.manifestFingerprint).toBeNull();
    expect(partial.uploadedAt).toBeNull();
    expect(partial.verifiedAt).toBeNull();
    expect(partial.cleanup.state).toBe("not_started");
    expect(partial.cleanup.attempts).toBe(0);
    expect(partial.cleanup.deletedKeys).toEqual(["a"]);
    expect(partial.cleanup.message).toBeNull();
  });

  test("a complete record round-trips through JSON unchanged", () => {
    const facts = {
      ...emptySeedJobArchiveFacts("tar.gz"),
      bytes: 99,
      sha256: DIGEST,
      objectKey: seedRelayArchiveKey(JOB, "tar.gz"),
      memberCount: 3,
      manifestFingerprint: MANIFEST,
      uploadedAt: 5,
      verifiedAt: 6,
      cleanup: { state: "cleaned" as const, attempts: 2, lastAttemptAt: 7, deletedKeys: ["k"], message: null },
    };
    expect(normalizeSeedJobArchiveFacts(JSON.parse(JSON.stringify(facts)))).toEqual(facts);
  });
});

describe("the transport adds no new job state", () => {
  test("the archive block is a field of the existing SeedJob, not a parallel record", () => {
    // Type-level assertion, checked by the compiler: the transport's facts are
    // exactly `SeedJob["archive"]`.
    const job: Pick<SeedJob, "archive"> = { archive: emptySeedJobArchiveFacts("tar.gz") };
    expect(job.archive.cleanup.state).toBe("not_started");
  });
});
