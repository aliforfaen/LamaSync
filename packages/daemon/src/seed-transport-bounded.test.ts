// LAMA-346 Stage 1b — the bounded part, asserted rather than promised.
//
// The task was explicit: implement the relay contract and prove it with a local
// fixture, and DO NOT make a live seed runnable. That is an invariant about the
// module graph and the capability flags, so it is tested the same way any other
// invariant is: by reading the source.
//
// If someone later wires the transport into a running job, the capability flags
// must flip in the same change — and that change must also bring a two-host
// fixture acceptance including a zero-content-change bisync baseline validation.
// This test fails until both happen together, which is the point.

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
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
      found.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  for (const pkg of PACKAGES) walk(join(REPO_ROOT, "packages", pkg, "src"));
  return found;
}

describe("Stage 1b is a bounded foundation, not a live seed", () => {
  test("the transport is a library: no production module imports it", () => {
    // `seed-relay-s3.ts` is the test-only network store (Stage 2c). It imports
    // the transport's hashing helper, so it is in the self-set — but nothing in
    // production may import IT either; a separate test below pins that.
    const self = new Set(["seed-transport.ts", "seed-relay-local.ts", "seed-relay-s3.ts"]);
    const importers = productionSources()
      .filter((file) => !self.has(file.path.slice(file.path.lastIndexOf("/") + 1)))
      .filter((file) =>
        /from "\.\/seed-transport\.ts"|from "\.\/seed-relay-local\.ts"|from "\.\/seed-relay-s3\.ts"/.test(
          file.text,
        ),
      )
      .map((file) => file.path.slice(REPO_ROOT.length + 1));
    // Tests import it (that is how it is exercised); production does not.
    expect(importers).toEqual([]);
  });

  test("the S3 store is test-only: no production module imports or constructs it", () => {
    // The S3 store legitimately carries credential-shaped constructor fields,
    // so the invariant is not "no file mentions a key" — it is "only the
    // test-only store does, and production never reaches it".
    const sources = productionSources();
    const storeName = "seed-relay-s3.ts";
    // Among modules that reach the seed transport, only the test-only store may
    // carry credential-shaped fields (backends elsewhere legitimately do, for
    // the managed-folder namespace — which is why the filter is combined).
    const credentialShaped = sources
      .filter((file) => file.text.includes("seed-transport"))
      .filter((file) => file.text.includes("secretAccessKey"))
      .map((file) => file.path.slice(REPO_ROOT.length + 1));
    expect(credentialShaped).toEqual([`packages/daemon/src/${storeName}`]);
    const importers = sources
      .filter((file) => file.path.slice(file.path.lastIndexOf("/") + 1) !== storeName)
      .filter((file) => /from "\.\/seed-relay-s3\.ts"|\.\/seed-relay-s3/.test(file.text))
      .map((file) => file.path.slice(REPO_ROOT.length + 1));
    expect(importers).toEqual([]);
  });

  test("no production module reaches a configured S3 or rclone for seeds", () => {
    // The relay contract has no credential, endpoint or bucket parameter, and
    // the only production-adjacent implementation is the local object store.
    // The S3 store is test-only (asserted above), so it is excluded here.
    const suspicious = productionSources()
      .filter((file) => file.path.slice(file.path.lastIndexOf("/") + 1) !== "seed-relay-s3.ts")
      .filter((file) => file.text.includes("seed-transport"))
      .filter((file) => /secretAccessKey|accessKeyId|buildS3RelayConfig|rclone/i.test(file.text))
      .map((file) => file.path.slice(REPO_ROOT.length + 1));
    expect(suspicious).toEqual([]);
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
