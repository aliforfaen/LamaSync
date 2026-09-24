// LAMA-346 — the daemon's seed seam, its fail-closed gates, and the peer rule.
//
// Stage 2f moved the AUTHORIZATION for seed work to the server: the daemon runs
// a side because the server issued it a relay space for that job and role, not
// because an environment variable is set. What remains seam-gated are sandbox
// affordances only — a shortened lease, a held phase, an environment-supplied
// relay space, and a local resync peer. These tests pin the seam (BOTH
// variables), the relay-config fail-closed rule, the production peer rule
// (`<remoteName>:<canonical destination>`), and the baseline verdict — the pure
// rule that decides whether the post-seed resync proved a zero-change baseline.
// A seed may be reported completed ONLY on a passing verdict, so that rule is a
// safety boundary rather than a statistic.

import { afterEach, describe, expect, test } from "bun:test";
import type { HostConfig, SeedRelaySpace } from "@lamasync/core";
import { seedDaemonE2eEnabled } from "./seed-daemon-seam.ts";
import {
  resolveSeedBaselinePeer,
  runSeedAction,
  seedBaselineVerdict,
  seedDaemonPeerPathFromEnv,
  seedDaemonRelayConfigFromEnv,
  seedRelaySpaceFromHostConfig,
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

  test("the peer OVERRIDE is seam-gated: production can never be redirected by it", () => {
    clearSeam();
    process.env.LAMASYNC_SEED_DAEMON_PEER_PATH = "/tmp/peer";
    expect(seedDaemonPeerPathFromEnv()).toBeNull();
    process.env.LAMASYNC_SEED_E2E = "1";
    process.env.LAMASYNC_TEST = "1";
    expect(seedDaemonPeerPathFromEnv()).toBe("/tmp/peer");
  });
});

describe("the production resync peer comes from the assignment", () => {
  const folder = (type: "sync" | "backup"): never =>
    ({ id: "f1", name: "Projects", type }) as never;
  const assignment = (over: Record<string, unknown> = {}): never =>
    ({ hostId: "dev-vm", remoteName: null, destination: null, resticRepository: null, resticPassword: null, ...over }) as never;

  test("the default is the per-folder remote the server emits, plus the folder's canonical destination", () => {
    const resolved = resolveSeedBaselinePeer(folder("sync"), assignment());
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.peer).toBe("lamasync-f1:Projects");
  });

  test("an explicit remoteName and destination are honored exactly", () => {
    const resolved = resolveSeedBaselinePeer(
      folder("sync"),
      assignment({ remoteName: "b2-projects", destination: "team/Projects" }),
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.peer).toBe("b2-projects:team/Projects");
  });

  test("a malformed destination or remote name fails closed", () => {
    const bad = resolveSeedBaselinePeer(folder("sync"), assignment({ destination: "/absolute" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain("destination");
    const spaced = resolveSeedBaselinePeer(folder("sync"), assignment({ remoteName: "has space" }));
    expect(spaced.ok).toBe(false);
    const colons = resolveSeedBaselinePeer(folder("sync"), assignment({ remoteName: "a:b" }));
    expect(colons.ok).toBe(false);
  });

  test("a non-sync folder has no resync peer", () => {
    expect(resolveSeedBaselinePeer(folder("backup"), assignment()).ok).toBe(false);
  });
});

describe("the issued relay space is bound to the job and the side", () => {
  const space = (jobId: string, role: "source" | "target"): SeedRelaySpace => ({
    jobId,
    role,
    backendId: "b1",
    endpoint: "https://s3.example",
    bucket: "lamasync-tmp",
    region: "us-east-1",
    accessKeyId: "k",
    secretAccessKey: "s",
  });
  const host = (seedRelay: SeedRelaySpace | null): HostConfig =>
    ({
      host: { id: "h1", hostname: "h1", status: "online" },
      assignments: [],
      folders: [],
      apps: [],
      rcloneConfig: "",
      serverTailnetIp: null,
      peers: [],
      seedRelay,
    }) as HostConfig;

  test("a space issued for this job and side is used; any other is refused", () => {
    expect(seedRelaySpaceFromHostConfig(host(space("j1", "source")), "j1", "source")?.bucket).toBe("lamasync-tmp");
    expect(seedRelaySpaceFromHostConfig(host(space("j1", "source")), "j2", "source")).toBeNull();
    expect(seedRelaySpaceFromHostConfig(host(space("j1", "source")), "j1", "target")).toBeNull();
    expect(seedRelaySpaceFromHostConfig(host(null), "j1", "source")).toBeNull();
    expect(seedRelaySpaceFromHostConfig(null, "j1", "source")).toBeNull();
  });

  test("an incomplete space is no space", () => {
    expect(
      seedRelaySpaceFromHostConfig(host({ ...space("j1", "source"), bucket: "" }), "j1", "source"),
    ).toBeNull();
    expect(
      seedRelaySpaceFromHostConfig(host({ ...space("j1", "source"), secretAccessKey: "" }), "j1", "source"),
    ).toBeNull();
  });
});

describe("the runner refuses before it reaches anything", () => {
  const refusingClient = (onCall: () => void): never =>
    ({
      getSeedJob: () => {
        onCall();
        throw new Error("must not be reached");
      },
    }) as never;

  test("with NO issued relay space it fails before touching the client, seam on or off", async () => {
    for (const seam of [false, true]) {
      clearSeam();
      if (seam) {
        process.env.LAMASYNC_SEED_E2E = "1";
        process.env.LAMASYNC_TEST = "1";
      }
      let called = false;
      const outcome = await runSeedAction({
        client: refusingClient(() => {
          called = true;
        }),
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
    }
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
