// LAMA-242: unit tests for the server usage string and known-flag set. The
// help text and the entry-point's unknown-flag guard import the same `usage.ts`
// module, so these tests pin both surfaces at once.

import { describe, expect, test } from "bun:test";
import { VERSION } from "@lamasync/core";
import { SERVER_KNOWN_FLAGS, serverUsage } from "./usage.ts";

describe("serverUsage", () => {
  const text = serverUsage();

  test("starts with a `lamasync-server <version>` banner", () => {
    expect(text.startsWith(`lamasync-server ${VERSION}`)).toBe(true);
  });

  test("mentions the two universal flags", () => {
    expect(text).toContain("--help");
    expect(text).toContain("-h");
    expect(text).toContain("--version");
  });

  test("documents environment-variable configuration", () => {
    // The server has no operational flags — config comes from the
    // environment. The usage text must surface the key env vars so a new
    // operator can find them.
    expect(text).toContain("LAMASYNC_API_KEY");
    expect(text).toContain("PORT");
    expect(text).toContain("LAMASYNC_GITHUB_TOKEN");
  });

  test("documents the exit-code contract", () => {
    expect(text).toContain("Exit codes:");
    expect(text).toContain("0 ok");
    expect(text).toContain("2 usage error");
  });

  test("includes the current VERSION somewhere in the body", () => {
    expect(text).toContain(VERSION);
  });
});

describe("SERVER_KNOWN_FLAGS", () => {
  test("contains exactly the documented four tokens", () => {
    expect(SERVER_KNOWN_FLAGS.size).toBe(4);
    expect(SERVER_KNOWN_FLAGS.has("--version")).toBe(true);
    expect(SERVER_KNOWN_FLAGS.has("-V")).toBe(true);
    expect(SERVER_KNOWN_FLAGS.has("--help")).toBe(true);
    expect(SERVER_KNOWN_FLAGS.has("-h")).toBe(true);
  });

  test("rejects unknown flags", () => {
    expect(SERVER_KNOWN_FLAGS.has("--bogus")).toBe(false);
    expect(SERVER_KNOWN_FLAGS.has("-x")).toBe(false);
    expect(SERVER_KNOWN_FLAGS.has("--unknown=foo")).toBe(false);
  });
});
