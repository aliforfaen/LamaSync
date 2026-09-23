// LAMA-346 Stage 2c — the TEST-ONLY transport seam, pinned.
//
// The disposable E2E harness needs a runnable plan and a creatable job, but
// production must keep refusing. That is exactly the kind of thing that must be
// asserted rather than described: this suite pins that the capability constant
// is still `false`, that the seam requires BOTH environment variables, and that
// the default plan-execution verdict is unchanged.

import { afterEach, describe, expect, test } from "bun:test";
import { SEED_ARCHIVE_TRANSPORT_IMPLEMENTED, seedPlanExecution } from "@lamasync/core";
import { seedTransportE2eEnabled } from "./seed-jobs.ts";

const ORIGINAL = {
  seed: process.env["LAMASYNC_SEED_E2E"],
  test: process.env["LAMASYNC_TEST"],
};

function restore(): void {
  if (ORIGINAL.seed === undefined) delete process.env["LAMASYNC_SEED_E2E"];
  else process.env["LAMASYNC_SEED_E2E"] = ORIGINAL.seed;
  if (ORIGINAL.test === undefined) delete process.env["LAMASYNC_TEST"];
  else process.env["LAMASYNC_TEST"] = ORIGINAL.test;
}

afterEach(restore);

describe("the E2E transport seam is test-only and doubly gated", () => {
  test("the capability constant stays false and the default verdict is unavailable", () => {
    delete process.env["LAMASYNC_SEED_E2E"];
    delete process.env["LAMASYNC_TEST"];
    expect(SEED_ARCHIVE_TRANSPORT_IMPLEMENTED).toBe(false);
    expect(seedTransportE2eEnabled()).toBe(false);
    expect(seedPlanExecution().available).toBe(false);
    expect(seedPlanExecution().reason).toContain("no live archive transfer is claimed");
  });

  test("one environment variable alone opens nothing", () => {
    process.env["LAMASYNC_SEED_E2E"] = "1";
    delete process.env["LAMASYNC_TEST"];
    expect(seedTransportE2eEnabled()).toBe(false);
    process.env["LAMASYNC_TEST"] = "1";
    delete process.env["LAMASYNC_SEED_E2E"];
    expect(seedTransportE2eEnabled()).toBe(false);
  });

  test("both variables open the seam, and only the override makes a plan runnable", () => {
    process.env["LAMASYNC_SEED_E2E"] = "1";
    process.env["LAMASYNC_TEST"] = "1";
    expect(seedTransportE2eEnabled()).toBe(true);
    // The constant itself is untouched: only the explicit override changes the
    // verdict, so no production caller can accidentally inherit it.
    expect(SEED_ARCHIVE_TRANSPORT_IMPLEMENTED).toBe(false);
    expect(seedPlanExecution({ transportImplemented: true }).available).toBe(true);
  });
});
