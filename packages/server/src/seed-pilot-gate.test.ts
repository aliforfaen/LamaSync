// LAMA-346 Stage 2f — the gate that replaced the server-side test seam.
//
// Through Stage 2e the server opened `POST /seed-jobs` and the archive route
// only when BOTH `LAMASYNC_SEED_E2E=1` and `LAMASYNC_TEST=1` were set, because
// there was no production authorization to consult. Stage 2f replaced that with
// the operator's SEED PILOT: exactly one folder and one source/target pair,
// opened only after its temporary seed space has been probed.
//
// This suite pins the three things that could quietly go wrong:
//   1. no environment variable opens anything on the server any more;
//   2. the pilot's scope rule is exact and ORDERED (a swapped pair is not the
//      same pair) and fails closed on every missing field;
//   3. an unprobed or failed seed space authorizes nothing.

import { afterEach, describe, expect, test } from "bun:test";
import {
  emptySeedPilotConfig,
  isSeedRelayBucketName,
  parseSeedPilotUpdatePayload,
  SEED_ARCHIVE_TRANSPORT_IMPLEMENTED,
  seedPilotEligibility,
  seedPilotExecutionEligibility,
  seedPilotSummary,
  seedPlanExecution,
  type SeedPilotConfig,
} from "@lamasync/core";

const ORIGINAL = {
  seed: process.env["LAMASYNC_SEED_E2E"],
  test: process.env["LAMASYNC_TEST"],
};

afterEach(() => {
  if (ORIGINAL.seed === undefined) delete process.env["LAMASYNC_SEED_E2E"];
  else process.env["LAMASYNC_SEED_E2E"] = ORIGINAL.seed;
  if (ORIGINAL.test === undefined) delete process.env["LAMASYNC_TEST"];
  else process.env["LAMASYNC_TEST"] = ORIGINAL.test;
});

const REQUEST = { folderId: "projects", sourceHostId: "master", targetHostId: "dev-vm" };

function pilot(over: Partial<SeedPilotConfig> = {}): SeedPilotConfig {
  return {
    enabled: true,
    folderId: "projects",
    sourceHostId: "master",
    targetHostId: "dev-vm",
    backendId: "b2-tmp",
    bucket: "lamasync-tmp",
    updatedAt: 1,
    readiness: { state: "ready", bucket: "lamasync-tmp", checkedAt: 1, message: "probe passed" },
    ...over,
  };
}

describe("no environment variable opens seed execution on the server", () => {
  test("the capability constant stays false and the default verdict is unavailable", () => {
    process.env["LAMASYNC_SEED_E2E"] = "1";
    process.env["LAMASYNC_TEST"] = "1";
    expect(SEED_ARCHIVE_TRANSPORT_IMPLEMENTED).toBe(false);
    expect(seedPlanExecution().available).toBe(false);
    expect(seedPlanExecution().reason).toContain("seed pilot");
    expect(seedPlanExecution({ pilot: null }).available).toBe(false);
  });

  test("an eligible pilot is what opens a plan, not the environment", () => {
    expect(seedPlanExecution({ pilot: seedPilotExecutionEligibility(pilot(), REQUEST) }).available).toBe(true);
    expect(seedPlanExecution({ pilot: seedPilotExecutionEligibility(emptySeedPilotConfig(), REQUEST) }).available).toBe(false);
  });
});

describe("the pilot authorizes ONE folder and ONE ordered pair", () => {
  test("the exact pair is eligible", () => {
    const verdict = seedPilotEligibility(pilot(), REQUEST);
    expect(verdict.eligible).toBe(true);
    expect(seedPilotSummary(pilot())).toContain("lamasync-tmp");
  });

  test("a swapped pair is NOT the same pair", () => {
    const swapped = seedPilotEligibility(pilot(), { ...REQUEST, sourceHostId: "dev-vm", targetHostId: "master" });
    expect(swapped.eligible).toBe(false);
    expect(swapped.reason).toContain("source of truth");
  });

  test("another folder, another source or another target is refused with its own sentence", () => {
    expect(seedPilotEligibility(pilot(), { ...REQUEST, folderId: "other" }).reason).toContain("one folder at a time");
    expect(seedPilotEligibility(pilot(), { ...REQUEST, sourceHostId: "other" }).reason).toContain("master");
    expect(seedPilotEligibility(pilot(), { ...REQUEST, targetHostId: "other" }).reason).toContain("dev-vm");
  });

  test("a disabled, absent or incomplete pilot fails closed", () => {
    expect(seedPilotEligibility(null, REQUEST).eligible).toBe(false);
    expect(seedPilotEligibility(emptySeedPilotConfig(), REQUEST).eligible).toBe(false);
    expect(seedPilotEligibility(pilot({ enabled: false }), REQUEST).eligible).toBe(false);
    expect(seedPilotEligibility(pilot({ backendId: null }), REQUEST).eligible).toBe(false);
    expect(seedPilotEligibility(pilot({ bucket: null }), REQUEST).eligible).toBe(false);
  });
});

describe("an unprobed seed space authorizes nothing", () => {
  test("the readiness verdict is part of the execution verdict", () => {
    const scope = seedPilotEligibility(pilot(), REQUEST);
    expect(scope.eligible).toBe(true);

    const unknown = seedPilotExecutionEligibility(pilot({ readiness: emptySeedPilotConfig().readiness }), REQUEST);
    expect(unknown.eligible).toBe(false);
    expect(unknown.reason).toContain("has not been probed");

    const failed = seedPilotExecutionEligibility(
      pilot({ readiness: { state: "failed", bucket: "lamasync-tmp", checkedAt: 2, message: "access denied" } }),
      REQUEST,
    );
    expect(failed.eligible).toBe(false);
    expect(failed.reason).toContain("access denied");
  });

  test("a verdict about a DIFFERENT bucket does not authorize this one", () => {
    const stale = seedPilotExecutionEligibility(
      pilot({ readiness: { state: "ready", bucket: "some-other-bucket", checkedAt: 1, message: "ok" } }),
      REQUEST,
    );
    expect(stale.eligible).toBe(false);
    expect(stale.reason).toContain("has not been probed");
  });
});

describe("the pilot write grammar refuses anything it cannot fully authorize", () => {
  test("confirm is required, and unknown fields are refused rather than ignored", () => {
    expect(parseSeedPilotUpdatePayload({ enabled: true }).ok).toBe(false);
    expect(parseSeedPilotUpdatePayload({ enabled: false }).ok).toBe(false);
    const extra = parseSeedPilotUpdatePayload({ enabled: true, confirm: true, sneaky: "x" });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.error).toContain("unsupported field");
  });

  test("an enabled pilot must name a real folder, pair, backend and a valid bucket", () => {
    const missingFolder = parseSeedPilotUpdatePayload({
      enabled: true,
      confirm: true,
      sourceHostId: "a",
      targetHostId: "b",
      backendId: "x",
      bucket: "lamasync-tmp",
    });
    expect(missingFolder.ok).toBe(false);
    const sameHost = parseSeedPilotUpdatePayload({
      enabled: true,
      confirm: true,
      folderId: "f",
      sourceHostId: "a",
      targetHostId: "a",
      backendId: "x",
      bucket: "lamasync-tmp",
    });
    expect(sameHost.ok).toBe(false);
    const badBucket = parseSeedPilotUpdatePayload({
      enabled: true,
      confirm: true,
      folderId: "f",
      sourceHostId: "a",
      targetHostId: "b",
      backendId: "x",
      bucket: "Not A Bucket",
    });
    expect(badBucket.ok).toBe(false);
    if (!badBucket.ok) expect(badBucket.error).toContain("valid S3 bucket name");
  });

  test("a disabled write may carry no scope at all", () => {
    const parsed = parseSeedPilotUpdatePayload({ enabled: false, confirm: true });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.folderId).toBeNull();
      expect(parsed.payload.bucket).toBeNull();
    }
  });

  test("the bucket name rule is the S3 rule, not a hardcoded bucket", () => {
    expect(isSeedRelayBucketName("lamasync-tmp")).toBe(true);
    expect(isSeedRelayBucketName("a-b")).toBe(true);
    expect(isSeedRelayBucketName("ab")).toBe(false);
    expect(isSeedRelayBucketName("-leading")).toBe(false);
    expect(isSeedRelayBucketName("trailing-")).toBe(false);
    expect(isSeedRelayBucketName("Uppercase")).toBe(false);
    expect(isSeedRelayBucketName("has_underscore")).toBe(false);
  });
});
