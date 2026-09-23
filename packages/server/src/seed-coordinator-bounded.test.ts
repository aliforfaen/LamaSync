// LAMA-346 Stage 2b — the coordinator is test-only, asserted rather than
// promised.
//
// The task was explicit: close the orchestration proof gap while remaining
// test-only — no configured S3 access, no real credentials, no rclone config
// changes, no dev-vm, no production jobs, no live API enablement. That is an
// invariant about the module graph and the capability flags, so it is tested
// the way any other invariant is: by reading the source.
//
// If someone later wires the coordinator into a running job, the capability
// flag must flip in the same change, and that change owes the host proofs the
// handoff lists. This test fails until both happen together.

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

/** Source with comments removed, so prose cannot satisfy or break a code check. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every non-test TypeScript file under `packages/<name>/src`. */
function productionSources(): Array<{ path: string; text: string }> {
  const found: Array<{ path: string; text: string }> = [];
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

describe("Stage 2b is test-only orchestration, not production wiring", () => {
  test("no production module imports the coordinator", () => {
    const importers = productionSources()
      .filter((file) => file.path.slice(file.path.lastIndexOf("/") + 1) !== "seed-coordinator.ts")
      .filter((file) => /from "\.\/seed-coordinator\.ts"|seed-coordinator/.test(file.text))
      .map((file) => file.path.slice(REPO_ROOT.length + 1));
    expect(importers).toEqual([]);
  });

  test("the coordinator carries no credential, endpoint or bucket surface", () => {
    // Its injected dependencies are a store interface, two sides and a cleanup
    // step. Nothing in it can name a backend: the store is constructed by
    // whoever owns the configuration, and this module never sees one.
    //
    // The check is on CODE, not prose: the header deliberately *describes* what
    // the module does not do (including "no rclone invocation"), so comments are
    // stripped first.
    const coordinator = productionSources().find(
      (file) => file.path.endsWith("/seed-coordinator.ts"),
    );
    expect(coordinator).toBeDefined();
    const code = stripComments(coordinator!.text);
    for (const forbidden of [
      "accessKeyId",
      "secretAccessKey",
      "buildS3RelayConfig",
      "endpoint",
      "bucket",
      "rclone",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  test("execution is still unavailable and the API still refuses", () => {
    expect(SEED_ARCHIVE_TRANSPORT_IMPLEMENTED).toBe(false);
    expect(SEED_FILTER_AWARE_ARCHIVE_IMPLEMENTED).toBe(true);
    const execution = seedPlanExecution();
    expect(execution.available).toBe(false);
    expect(execution.reason).toContain("temporary seed space");
  });

  test("the coordinator uses only the ownership-conditional writes", () => {
    // `seed-jobs.ts` has two families: the LAST-WRITER-WINS helpers the device
    // routes use, and the conditional `*Owned*`/`claim*` ones. Reaching for the
    // unguarded trio here would silently reintroduce the steal this correction
    // fixed, so the boundary is asserted rather than remembered.
    const coordinator = productionSources().find(
      (file) => file.path.endsWith("/seed-coordinator.ts"),
    )!;
    // Find the import statement that targets seed-jobs.ts: split on `import` and
    // take the one whose clause ends there, so a neighbouring import cannot be
    // mistaken for it.
    const block = coordinator.text
      .split("\nimport ")
      .find((part) => part.includes('} from "./seed-jobs.ts";'));
    expect(block).toBeDefined();
    // Comments inside the import (there is a deliberate one explaining the
    // cleanup exception) are stripped, so prose cannot become an "import name".
    const clean = stripComments(block!);
    const names = clean
      .slice(0, clean.indexOf("} from"))
      .replace(/^\{/, "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    expect(names.sort()).toEqual([
      "claimSeedJobProgress",
      "finishOwnedSeedJob",
      "getSeedJob",
      "reportOwnedSeedJobProgress",
      "updateOwnedSeedJobArchive",
      // Cleanup is the ONE deliberate exception: it records the cleanup state
      // after the job has ended, when its objects are already deletable, so it
      // uses the status-blind write on purpose.
      "updateSeedJobArchive",
    ]);
    // The unguarded trio appears nowhere in its body.
    for (const unguarded of ["updateSeedJobProgress", "finishSeedJob", "renewSeedJobLease"]) {
      expect(names).not.toContain(unguarded);
      expect(stripComments(coordinator.text)).not.toContain(`${unguarded}(`);
    }
    // `updateSeedJobArchive` may appear exactly ONCE — in cleanup — and never on
    // the in-flight transport path, where it would let a run whose lease lapsed
    // overwrite the facts of the owner that took the job over.
    const code = stripComments(coordinator.text);
    expect(code.split("updateSeedJobArchive(").length - 1).toBe(1);
  });

  test("the coordinator invents no phase: it drives the machine's own list", () => {
    // A type-level and value-level check: every phase it names is one the job
    // machine defines, and it never adds a phase of its own.
    const coordinator = productionSources().find(
      (file) => file.path.endsWith("/seed-coordinator.ts"),
    )!;
    expect(coordinator.text).toContain("satisfies readonly SeedJobPhase[]");
    expect(coordinator.text).not.toMatch(/"seed_[a-z_]+"/);
  });
});
