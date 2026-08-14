// LAMA-242: unit tests for the daemon usage string and known-flag set. The
// help text and the entry-point's unknown-flag guard import the same `usage.ts`
// module, so these tests pin both surfaces at once.

import { describe, expect, test } from "bun:test";
import { VERSION } from "@lamasync/core";
import { DAEMON_KNOWN_FLAGS, daemonUsage } from "./usage.ts";

describe("daemonUsage", () => {
  const text = daemonUsage();

  test("starts with a `lamasyncd <version>` banner", () => {
    expect(text.startsWith(`lamasyncd ${VERSION}`)).toBe(true);
  });

  test("mentions every documented flag", () => {
    // Usage section lists every operational invocation, including help/version
    // for completeness. The Flags section lists the universals.
    expect(text).toContain("--help");
    expect(text).toContain("-h");
    expect(text).toContain("--version");
    expect(text).toContain("--check-update");
    expect(text).toContain("--update");
    expect(text).toContain("--mount");
  });

  test("documents the exit-code contract", () => {
    expect(text).toContain("Exit codes:");
    expect(text).toContain("0 ok");
    expect(text).toContain("2 usage error");
  });

  test("includes the current VERSION somewhere in the body", () => {
    // The banner carries it, and we don't want a future edit to drop it from
    // the operational text by accident.
    expect(text).toContain(VERSION);
  });
});

describe("DAEMON_KNOWN_FLAGS", () => {
  test("contains exactly the documented seven tokens", () => {
    expect(DAEMON_KNOWN_FLAGS.size).toBe(7);
    expect(DAEMON_KNOWN_FLAGS.has("--version")).toBe(true);
    expect(DAEMON_KNOWN_FLAGS.has("-V")).toBe(true);
    expect(DAEMON_KNOWN_FLAGS.has("--help")).toBe(true);
    expect(DAEMON_KNOWN_FLAGS.has("-h")).toBe(true);
    expect(DAEMON_KNOWN_FLAGS.has("--check-update")).toBe(true);
    expect(DAEMON_KNOWN_FLAGS.has("--update")).toBe(true);
    expect(DAEMON_KNOWN_FLAGS.has("--mount")).toBe(true);
  });

  test("rejects unknown flags", () => {
    expect(DAEMON_KNOWN_FLAGS.has("--bogus")).toBe(false);
    expect(DAEMON_KNOWN_FLAGS.has("-x")).toBe(false);
    expect(DAEMON_KNOWN_FLAGS.has("--unknown=foo")).toBe(false);
  });
});
