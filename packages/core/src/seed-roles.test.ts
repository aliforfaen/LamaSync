// LAMA-346 Stage 2d — the two-party role rules, pinned directly.
//
// A seed has two parties, and until Stage 2d only the target was named on the
// job row. These are the pure rules the server routes and the daemon both read,
// so they are tested without a database, a route or a store: the phase halves,
// the archive/completion authority, and the "facts complete" predicate the
// target's start depends on.

import { describe, expect, test } from "bun:test";
import {
  SEED_JOB_PHASES,
  emptySeedJobArchiveFacts,
  seedArchiveFactsComplete,
  seedArchiveFactsEqual,
  seedJobPhaseRole,
  seedJobRoleFor,
  seedJobRoleMayComplete,
  seedJobRoleMayEnterPhase,
  seedJobRoleMayReportArchive,
  type SeedJobArchiveFacts,
} from "./folder-seed.ts";

const JOB = { hostId: "target-host", sourceHostId: "source-host" };

describe("seed job roles", () => {
  test("a device is the target, the source, or nobody", () => {
    expect(seedJobRoleFor(JOB, "target-host")).toBe("target");
    expect(seedJobRoleFor(JOB, "source-host")).toBe("source");
    expect(seedJobRoleFor(JOB, "third-host")).toBeNull();
    expect(seedJobRoleFor(JOB, null)).toBeNull();
    expect(seedJobRoleFor(JOB, "")).toBeNull();
  });

  test("a job with no recorded source authorizes only the target", () => {
    // A pre-Stage-2d row has no sourceHostId. It must fail closed: the target
    // still works, and NO other host can claim to be the source.
    const legacy = { hostId: "target-host", sourceHostId: null };
    expect(seedJobRoleFor(legacy, "target-host")).toBe("target");
    expect(seedJobRoleFor(legacy, "source-host")).toBeNull();
    expect(seedJobRoleFor(legacy, "anyone")).toBeNull();
  });

  test("the phase halves are complete and disjoint", () => {
    const byRole = { source: [] as string[], target: [] as string[] };
    for (const phase of SEED_JOB_PHASES) byRole[seedJobPhaseRole(phase)].push(phase);
    // Every phase has exactly one owner, the source goes first, and the target's
    // first phase is exactly one step after the source's last — which is what
    // makes "the target cannot start before the source finished" structural.
    expect(byRole.source).toEqual([
      "preflight",
      "measuring_source",
      "archiving_source",
      "uploading_archive",
    ]);
    expect(byRole.target).toEqual([
      "downloading_archive",
      "verifying_archive",
      "extracting_target",
      "verifying_target",
      "publishing",
      "baseline_validation",
    ]);
    expect(byRole.source.length + byRole.target.length).toBe(SEED_JOB_PHASES.length);
    expect(SEED_JOB_PHASES.indexOf("downloading_archive")).toBe(
      SEED_JOB_PHASES.indexOf("uploading_archive") + 1,
    );
  });

  test("each role may enter only its own phases", () => {
    for (const phase of SEED_JOB_PHASES) {
      const owner = seedJobPhaseRole(phase);
      expect(seedJobRoleMayEnterPhase(owner, phase)).toBe(true);
      expect(seedJobRoleMayEnterPhase(owner === "source" ? "target" : "source", phase)).toBe(false);
    }
  });

  test("only the source authors archive facts, and only the target completes a seed", () => {
    expect(seedJobRoleMayReportArchive("source")).toBe(true);
    expect(seedJobRoleMayReportArchive("target")).toBe(false);
    expect(seedJobRoleMayReportArchive(null)).toBe(false);

    expect(seedJobRoleMayComplete("target")).toBe(true);
    expect(seedJobRoleMayComplete("source")).toBe(false);
    expect(seedJobRoleMayComplete(null)).toBe(false);
  });
});

describe("the target's start condition", () => {
  test("an empty archive record is not complete", () => {
    expect(seedArchiveFactsComplete(emptySeedJobArchiveFacts("tar.gz"))).toBe(false);
  });

  test("every fact the target verifies against is required", () => {
    const full: SeedJobArchiveFacts = {
      ...emptySeedJobArchiveFacts("tar.gz"),
      bytes: 10,
      sha256: "a".repeat(64),
      objectKey: "lamasync/seed/j/archive.tar.gz",
      memberCount: 3,
      manifestFingerprint: "b".repeat(64),
      manifestObjectKey: "lamasync/seed/j/manifest.json",
      manifestBytes: 5,
      manifestSha256: "c".repeat(64),
    };
    expect(seedArchiveFactsComplete(full)).toBe(true);
    // Dropping ANY one of them must fail closed: each is used to verify bytes
    // or to re-derive the universe.
    for (const key of [
      "sha256",
      "bytes",
      "objectKey",
      "memberCount",
      "manifestFingerprint",
      "manifestObjectKey",
      "manifestBytes",
      "manifestSha256",
    ] as const) {
      expect(seedArchiveFactsComplete({ ...full, [key]: null })).toBe(false);
    }
  });
});

describe("archive-fact immutability comparison", () => {
  const base: SeedJobArchiveFacts = {
    ...emptySeedJobArchiveFacts("tar.gz"),
    bytes: 10,
    sha256: "a".repeat(64),
    objectKey: "lamasync/seed/j/archive.tar.gz",
    memberCount: 3,
    manifestFingerprint: "b".repeat(64),
    manifestObjectKey: "lamasync/seed/j/manifest.json",
    manifestBytes: 5,
    manifestSha256: "c".repeat(64),
  };

  test("a retry with different bookkeeping is the same record", () => {
    // The clock and the cleanup state are not identity: a re-sent report with a
    // later timestamp must be accepted as the idempotent retry it is.
    expect(
      seedArchiveFactsEqual(base, {
        ...base,
        uploadedAt: 123,
        verifiedAt: 456,
        cleanup: { state: "not_started", attempts: 0, lastAttemptAt: null, deletedKeys: [], message: null },
      }),
    ).toBe(true);
  });

  test("a differing identifying field is a DIFFERENT record", () => {
    for (const key of [
      "bytes",
      "sha256",
      "objectKey",
      "memberCount",
      "manifestFingerprint",
      "manifestObjectKey",
      "manifestBytes",
      "manifestSha256",
    ] as const) {
      const changed = key === "sha256" || key === "manifestFingerprint" || key === "manifestSha256"
        ? "d".repeat(64)
        : key === "objectKey" || key === "manifestObjectKey"
          ? "lamasync/seed/j/other"
          : 99;
      expect(seedArchiveFactsEqual(base, { ...base, [key]: changed })).toBe(false);
    }
    expect(seedArchiveFactsEqual(base, { ...base, format: "tar.zstd" })).toBe(false);
  });
});
