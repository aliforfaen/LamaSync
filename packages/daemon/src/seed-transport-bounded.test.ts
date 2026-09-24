// LAMA-346 — the bounded part, asserted rather than promised.
//
// Stage 1b's task was: implement the relay contract and prove it with a local
// fixture, and DO NOT make a live seed runnable. Stage 2d then had to wire the
// shipped daemon's action loop, which necessarily means the transport and the
// real store ARE reachable — so the invariant this file enforces was RESTATED
// rather than dropped:
//
//   the transport and the S3 store have exactly ONE production importer
//   (`seed-runner.ts`); the runner is reached only through a DYNAMIC import in
//   the daemon dispatcher, never a static one; and every sandbox affordance the
//   runner reads from the environment is gated by the doubly-gated seam, so a
//   production build cannot be redirected by it.
//
// Stage 2f RESTATED the authorization half, because it changed: seed work is no
// longer opened by an environment variable but by the JOB — the server creates a
// seed job only inside the operator's seed pilot and issues this device a relay
// space for that job and role inside its own host config. So the assertion is no
// longer "the dispatcher guards the import with the seam"; it is:
//
//   * the runner requires a server-ISSUED relay space (bound to the job id and
//     the side) before it touches the network;
//   * the environment can only SUBSTITUTE that space, and only when the seam is
//     open;
//   * the capability flag stays `false`, so nothing is opened fleet-wide.
//
// If someone later loosens any of that — a static import, a seam with one
// variable, a third importer, an ungated environment read — this test fails,
// which is the point.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  SEED_ARCHIVE_TRANSPORT_IMPLEMENTED,
  SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED,
  seedPlanExecution,
} from "@lamasync/core";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const PACKAGES = ["core", "daemon", "server", "cli", "web-ui", "agent-skill"];

interface SourceFile {
  path: string;
  text: string;
}

/** Every non-test TypeScript file under `packages/<name>/src`. */
function productionSources(): SourceFile[] {
  const found: SourceFile[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
      found.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  for (const pkg of PACKAGES) walk(join(REPO_ROOT, "packages", pkg, "src"));
  return found;
}

function base(file: SourceFile): string {
  return file.path.slice(file.path.lastIndexOf("/") + 1);
}

function rel(file: SourceFile): string {
  return file.path.slice(REPO_ROOT.length + 1);
}

/** Look a production source up by its repo-relative path. */
function sourceAt(relativePath: string): SourceFile {
  const found = productionSources().find((file) => rel(file) === relativePath);
  if (!found) throw new Error(`production source ${relativePath} not found`);
  return found;
}

const DAEMON_INDEX = "packages/daemon/src/index.ts";
const SEED_RUNNER = "packages/daemon/src/seed-runner.ts";
const SEED_DAEMON_SEAM = "packages/daemon/src/seed-daemon-seam.ts";
const SEED_STORE = "packages/daemon/src/seed-relay-s3.ts";
const SERVER_SEED_JOBS = "packages/server/src/seed-jobs.ts";

describe("the seed transport is reachable only through the seam-gated runner", () => {
  test("the transport has exactly ONE production importer: the seam-gated runner", () => {
    const self = new Set(["seed-transport.ts", "seed-relay-local.ts", "seed-relay-s3.ts"]);
    const importers = productionSources()
      .filter((file) => !self.has(base(file)))
      .filter((file) =>
        /from "\.\/seed-transport\.ts"|from "\.\/seed-relay-local\.ts"|from "\.\/seed-relay-s3\.ts"/.test(
          file.text,
        ),
      )
      .map(rel);
    expect(importers).toEqual(["packages/daemon/src/seed-runner.ts"]);
  });

  test("the S3 store has exactly ONE production importer, and it is the runner", () => {
    const importers = productionSources()
      .filter((file) => base(file) !== "seed-relay-s3.ts")
      .filter((file) => /from "\.\/seed-relay-s3\.ts"/.test(file.text))
      .map(rel);
    expect(importers).toEqual(["packages/daemon/src/seed-runner.ts"]);
  });

  test("the runner is reached only by a dynamic import, and the daemon dispatcher does not gate it on the seam", () => {
    const runner = sourceAt(SEED_RUNNER);
    // The runner itself reads the shared seam predicate for its sandbox
    // affordances.
    expect(runner.text).toContain('from "./seed-daemon-seam.ts"');
    expect(runner.text).toContain("seedDaemonE2eEnabled()");

    const index = sourceAt(DAEMON_INDEX);
    // The daemon dispatcher must NOT statically import the runner...
    expect(/from "\.\/seed-runner\.ts"/.test(index.text)).toBe(false);
    // ...only dynamically. And the authorization is NOT an environment check:
    // the dispatcher must not consult the seam at all any more, because what
    // opens a run is the server-issued relay space the runner requires.
    expect(index.text).toContain('import("./seed-runner.ts")');
    expect(index.text).not.toContain("seedDaemonE2eEnabled");
  });

  test("the runner requires a SERVER-ISSUED relay space, and the environment can only substitute it", () => {
    const runner = sourceAt(SEED_RUNNER).text;
    // The issued space is matched on the job id AND the side, so a space issued
    // for another job (or the other half) is refused rather than used.
    expect(runner).toContain("seedRelaySpaceFromHostConfig");
    expect(runner).toContain("space.jobId !== jobId || space.role !== role");
    // The environment fallback is read ONLY behind the seam, and only after the
    // issued space has been tried (the production path wins).
    const seamGate = runner.indexOf("export function seedDaemonRelayConfigFromEnv");
    expect(seamGate).toBeGreaterThan(-1);
    const envFallback = runner.indexOf("const relay = seedDaemonRelayConfigFromEnv();");
    const issuedSpace = runner.indexOf("seedRelaySpaceFromHostConfig(ctx.getHostConfig()");
    expect(issuedSpace).toBeGreaterThan(-1);
    expect(envFallback).toBeGreaterThan(issuedSpace);
    // Without either, the run fails closed with a sentence about the space.
    expect(runner).toContain("holds no seed relay space for this job");
  });

  test("there is exactly one daemon seam implementation, and it needs BOTH variables", () => {
    // Exactly one module on the daemon side reads the seed variables, so the
    // sandbox affordances cannot drift apart.
    const daemonSeams = productionSources()
      .filter((file) => rel(file).startsWith("packages/daemon/"))
      .filter((file) => file.text.includes('process.env["LAMASYNC_SEED_E2E"]'))
      .map(rel);
    expect(daemonSeams).toEqual([SEED_DAEMON_SEAM]);

    const seam = sourceAt(SEED_DAEMON_SEAM).text;
    expect(seam).toContain('process.env["LAMASYNC_SEED_E2E"] === "1"');
    expect(seam).toContain('process.env["LAMASYNC_TEST"] === "1"');
    expect(seam).toContain("&&");

    // The SERVER no longer has a seed seam at all: its gate is the operator's
    // pilot, so a test environment cannot open anything there. `seed-jobs.ts`
    // must therefore contain no seed environment read.
    const serverSeedJobs = sourceAt(SERVER_SEED_JOBS).text;
    expect(serverSeedJobs).not.toContain('process.env["LAMASYNC_SEED_E2E"]');
    expect(serverSeedJobs).not.toContain('process.env["LAMASYNC_TEST"]');
  });

  test("credential-shaped seed configuration is confined to the store and the runner", () => {
    const credentialShaped = productionSources()
      .filter((file) => file.text.includes("seed-transport") || base(file) === "seed-relay-s3.ts")
      .filter((file) => file.text.includes("secretAccessKey"))
      .map(rel)
      .sort();
    expect(credentialShaped).toEqual([
      "packages/daemon/src/seed-relay-s3.ts",
      "packages/daemon/src/seed-runner.ts",
    ]);
    const runner = sourceAt(SEED_RUNNER).text;
    // The relay secret reaches the runner through the ISSUED space (which the
    // server fills in from the backend row)...
    expect(runner).toContain("secretAccessKey: space.secretAccessKey");
    // ...with the seam-gated environment as the sandbox substitute only.
    expect(runner).toContain("LAMASYNC_SEED_S3_SECRET_KEY");
    expect(runner).toContain("LAMASYNC_SEED_S3_ENDPOINT");
    // The resync peer OVERRIDE is seam-gated, and the production peer is the
    // assignment's own remote plus its canonical destination.
    expect(runner).toContain("LAMASYNC_SEED_DAEMON_PEER_PATH");
    expect(runner).toContain("resolveSeedBaselinePeer");
    expect(runner).toContain("--config");
    // A seed may never be reported completed without the zero-change proof.
    expect(runner).toContain("the post-seed resync");
  });

  test("execution is still unavailable by default and the UI control is still disabled", () => {
    expect(SEED_ARCHIVE_TRANSPORT_IMPLEMENTED).toBe(false);
    expect(SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED).toBe(true);
    const execution = seedPlanExecution();
    expect(execution.available).toBe(false);
    expect(execution.reason).toContain("seed pilot");
  });

  test("the seed relay namespace is separate from the managed-folder namespace", () => {
    // A seed object must never be mistakable for a synced file, and deleting the
    // namespace must never be able to touch user data.
    const sources = productionSources();
    const keys = sources
      .flatMap((file) => file.text.match(/SEED_OBJECT_KEY_PREFIX\s*=\s*"([^"]+)"/g) ?? [])
      .map((match) => match.split('"')[1]!);
    expect(new Set(keys)).toEqual(new Set(["lamasync/seed"]));
  });
});
