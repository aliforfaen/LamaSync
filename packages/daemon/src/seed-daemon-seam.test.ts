// LAMA-346 Stage 2d — the daemon's seed seam and its fail-closed gates.
//
// The seed path is reachable only when BOTH `LAMASYNC_SEED_E2E=1` and
// `LAMASYNC_TEST=1` are set. These tests pin that, pin the relay-config
// fail-closed rule, and pin the baseline verdict — the pure rule that decides
// whether the post-seed resync proved a zero-change baseline. A seed may be
// reported completed ONLY on a passing verdict, so this rule is a safety
// boundary rather than a statistic.

import { afterEach, describe, expect, test } from "bun:test";
import { seedDaemonE2eEnabled } from "./seed-daemon-seam.ts";
import {
  runSeedAction,
  seedBaselineVerdict,
  seedDaemonPeerPathFromEnv,
  seedDaemonRelayConfigFromEnv,
} from "./seed-runner.ts";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(saved)) process.env[key] = value;
});

function clearSeam(): void {
  delete process.env.LAMASYNC_SEED_E2E;
  delete process.env.LAMASYNC_TEST;
  delete process.env.LAMASYNC_SEED_S3_ENDPOINT;
  delete process.env.LAMASYNC_SEED_S3_BUCKET;
  delete process.env.LAMASYNC_SEED_S3_REGION;
  delete process.env.LAMASYNC_SEED_S3_ACCESS_KEY;
  delete process.env.LAMASYNC_SEED_S3_SECRET_KEY;
  delete process.env.LAMASYNC_SEED_DAEMON_PEER_PATH;
}

function relayEnv(): void {
  process.env.LAMASYNC_SEED_S3_ENDPOINT = "http://127.0.0.1:9";
  process.env.LAMASYNC_SEED_S3_BUCKET = "seed-e2e";
  process.env.LAMASYNC_SEED_S3_ACCESS_KEY = "key";
  process.env.LAMASYNC_SEED_S3_SECRET_KEY = "secret";
}

describe("the daemon seed seam needs BOTH variables", () => {
  test("neither, either, and both", () => {
    clearSeam();
    expect(seedDaemonE2eEnabled()).toBe(false);
    process.env.LAMASYNC_SEED_E2E = "1";
    expect(seedDaemonE2eEnabled()).toBe(false);
    delete process.env.LAMASYNC_SEED_E2E;
    process.env.LAMASYNC_TEST = "1";
    expect(seedDaemonE2eEnabled()).toBe(false);
    process.env.LAMASYNC_SEED_E2E = "1";
    expect(seedDaemonE2eEnabled()).toBe(true);
  });
});

describe("the relay configuration fails closed", () => {
  test("a partial configuration is no configuration", () => {
    clearSeam();
    expect(seedDaemonRelayConfigFromEnv()).toBeNull();
    relayEnv();
    expect(seedDaemonRelayConfigFromEnv()?.bucket).toBe("seed-e2e");
    expect(seedDaemonRelayConfigFromEnv()?.region).toBe("us-east-1");
    for (const key of [
      "LAMASYNC_SEED_S3_ENDPOINT",
      "LAMASYNC_SEED_S3_BUCKET",
      "LAMASYNC_SEED_S3_ACCESS_KEY",
      "LAMASYNC_SEED_S3_SECRET_KEY",
    ]) {
      const kept = process.env[key];
      delete process.env[key];
      expect(seedDaemonRelayConfigFromEnv()).toBeNull();
      process.env[key] = kept;
    }
  });

  test("there is no configured peer by default", () => {
    clearSeam();
    expect(seedDaemonPeerPathFromEnv()).toBeNull();
    process.env.LAMASYNC_SEED_DAEMON_PEER_PATH = "/tmp/peer";
    expect(seedDaemonPeerPathFromEnv()).toBe("/tmp/peer");
  });
});

describe("the runner refuses before it reaches anything", () => {
  test("with the seam off it fails without touching the client or a store", async () => {
    clearSeam();
    let called = false;
    const outcome = await runSeedAction({
      client: {
        getSeedJob: () => {
          called = true;
          throw new Error("must not be reached");
        },
      } as never,
      hostId: "h1",
      jobId: "j1",
      payloadRole: "source",
      getHostConfig: () => null,
      refreshConfig: async () => false,
      dataDir: "/tmp/does-not-matter",
      log: () => {},
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.result).toContain("seam is off");
    expect(called).toBe(false);
  });

  test("with the seam on but no relay configured it fails before touching the client", async () => {
    clearSeam();
    process.env.LAMASYNC_SEED_E2E = "1";
    process.env.LAMASYNC_TEST = "1";
    let called = false;
    const outcome = await runSeedAction({
      client: {
        getSeedJob: () => {
          called = true;
          throw new Error("must not be reached");
        },
      } as never,
      hostId: "h1",
      jobId: "j1",
      payloadRole: "source",
      getHostConfig: () => null,
      refreshConfig: async () => false,
      dataDir: "/tmp/does-not-matter",
      log: () => {},
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.result).toContain("relay space");
    expect(called).toBe(false);
  });
});

describe("the zero-change baseline verdict is the completion gate", () => {
  const ok = JSON.stringify({ stats: { totalTransfers: 0, bytes: 0, errors: 0 } });
  const changed = (transfers: number, bytes: number): string =>
    JSON.stringify({ stats: { totalTransfers: transfers, bytes, errors: 0 } });

  test("a clean resync passes", () => {
    const verdict = seedBaselineVerdict({
      exitCode: 0,
      stderr: `${ok}\nTransferred: 0 B\nBisync successful`,
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.transfers).toBe(0);
  });

  test("a resync that moved anything fails", () => {
    expect(
      seedBaselineVerdict({ exitCode: 0, stderr: `${changed(1, 0)}\nBisync successful` }).ok,
    ).toBe(false);
    expect(
      seedBaselineVerdict({ exitCode: 0, stderr: `${changed(0, 12)}\nBisync successful` }).ok,
    ).toBe(false);
    expect(
      seedBaselineVerdict({
        exitCode: 0,
        stderr: `${JSON.stringify({ stats: { totalTransfers: 0, bytes: 0, errors: 2 } })}\nBisync successful`,
      }).ok,
    ).toBe(false);
  });

  test("a changed file with zero bytes is still a change", () => {
    // The exact trap the handoff calls out: an mtime rewrite reports
    // `File changed: time` with 0 bytes transferred, and accepting it would
    // leave the folder re-syncing forever.
    const verdict = seedBaselineVerdict({
      exitCode: 0,
      stderr: `${ok}\nNOTICE: File changed: time\nBisync successful`,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("changed file");
  });

  test("a failed or aborted run never passes", () => {
    expect(seedBaselineVerdict({ exitCode: 1, stderr: ok }).ok).toBe(false);
    expect(seedBaselineVerdict({ exitCode: 0, stderr: ok }).ok).toBe(false);
    expect(
      seedBaselineVerdict({ exitCode: 0, stderr: `${ok}\nSafety abort\nBisync successful` }).ok,
    ).toBe(false);
  });
});
