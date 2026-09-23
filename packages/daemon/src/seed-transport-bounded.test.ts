// LAMA-346 — the bounded part, asserted rather than promised.
//
// Stage 1b's task was: implement the relay contract and prove it with a local
// fixture, and DO NOT make a live seed runnable. Stage 2d then had to wire the
// shipped daemon's action loop, which necessarily means the transport and the
// real store ARE reachable — so the invariant this file enforces was RESTATED
// rather than dropped:
//
//   the transport and the S3 store have exactly ONE production importer
//   (`seed-runner.ts`), the runner is reached only through a DYNAMIC import in
//   the daemon dispatcher, that call site is guarded by the doubly-gated seam,
//   and the capability flags stay `false` so the API still refuses by default.
//
// If someone later loosens any of that — a static import, a seam with one
// variable, a third importer — this test fails, which is the point.

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

  test("the runner is reached only by a dynamic import guarded by the shared seam", () => {
    const runner = sourceAt(SEED_RUNNER);
    // The runner itself reads the shared seam predicate.
    expect(runner.text).toContain('from "./seed-daemon-seam.ts"');
    expect(runner.text).toContain("seedDaemonE2eEnabled()");

    const index = sourceAt(DAEMON_INDEX);
    // The daemon dispatcher must NOT statically import the runner...
    expect(/from "\.\/seed-runner\.ts"/.test(index.text)).toBe(false);
    // ...only dynamically, and only after the seam check.
    const dynamic = index.text.indexOf('import("./seed-runner.ts")');
    const guard = index.text.indexOf("if (!seedDaemonE2eEnabled())");
    expect(dynamic).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(dynamic);
  });

  test("there is exactly one daemon seam implementation, and it needs BOTH variables", () => {
    // The server has its own (separate package) seam; on the daemon side there
    // must be exactly one module that reads the seed variables, so the
    // dispatcher's check and the runner's check cannot drift.
    const daemonSeams = productionSources()
      .filter((file) => rel(file).startsWith("packages/daemon/"))
      .filter((file) => file.text.includes('process.env["LAMASYNC_SEED_E2E"]'))
      .map(rel);
    expect(daemonSeams).toEqual([SEED_DAEMON_SEAM]);

    const seam = sourceAt(SEED_DAEMON_SEAM).text;
    expect(seam).toContain('process.env["LAMASYNC_SEED_E2E"] === "1"');
    expect(seam).toContain('process.env["LAMASYNC_TEST"] === "1"');
    expect(seam).toContain("&&");

    // The server's seam is the same shape (it is pinned independently by
    // seed-e2e-seam.test.ts); assert it here too so one cannot loosen alone.
    const serverSeam = sourceAt(SERVER_SEED_JOBS).text;
    expect(serverSeam).toContain('process.env["LAMASYNC_SEED_E2E"] === "1"');
    expect(serverSeam).toContain('process.env["LAMASYNC_TEST"] === "1"');
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
    // ...and the runner reads it from the seam environment, never a file.
    const runner = sourceAt(SEED_RUNNER).text;
    expect(runner).toContain("LAMASYNC_SEED_S3_SECRET_KEY");
    expect(runner).toContain("LAMASYNC_SEED_S3_ENDPOINT");
    // The resync peer is seam-gated too: with no peer the baseline phase FAILS,
    // because a seed may never be reported completed without that proof.
    expect(runner).toContain("LAMASYNC_SEED_DAEMON_PEER_PATH");
    expect(runner).toContain("zero-change baseline could not be proven");
  });

  test("execution is still unavailable and the UI control is still disabled", () => {
    expect(SEED_ARCHIVE_TRANSPORT_IMPLEMENTED).toBe(false);
    expect(SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED).toBe(true);
    const execution = seedPlanExecution();
    expect(execution.available).toBe(false);
    expect(execution.reason).toContain("temporary seed space");
    expect(execution.reason).toContain("no live archive transfer is claimed");
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
