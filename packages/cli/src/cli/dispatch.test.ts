// Dispatch smoke tests: top-level help, command help, unknown command,
// and usage-error routing. Pure dispatch — no I/O against the server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runCli } from "./dispatch.ts";

describe("runCli dispatch (LAMA-229)", () => {
  let originalWrite: typeof process.stdout.write;
  let originalExit: typeof process.exit;
  let originalErrWrite: typeof process.stderr.write;
  let written: string;
  let exitCode: number | undefined;

  beforeEach(() => {
    written = "";
    exitCode = undefined;
    originalWrite = process.stdout.write.bind(process.stdout);
    originalErrWrite = process.stderr.write.bind(process.stderr);
    originalExit = process.exit;
    process.stdout.write = ((data: string | Uint8Array): boolean => {
      written += typeof data === "string" ? data : new TextDecoder().decode(data);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((data: string | Uint8Array): boolean => {
      written += typeof data === "string" ? data : new TextDecoder().decode(data);
      return true;
    }) as typeof process.stderr.write;
    // Throw a plain object sentinel (no `message` property) so runCli's
    // top-level catch rethrows it untouched instead of re-mapping the
    // exit code through exitCodeForError — fail()-style exits inside
    // runCliInner keep their original code.
    process.exit = ((code?: number): never => {
      exitCode = code ?? 0;
      throw { __testExit: true };
    }) as unknown as typeof process.exit;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
    process.exit = originalExit;
  });

  test("bare 'lamasync' prints top-level help and exits", async () => {
    await runCli([]);
    expect(written).toContain("Usage: lamasync <command>");
    expect(written).toContain("local status");
    expect(written).toContain("Exit codes");
    expect(exitCode).toBeUndefined();
  });

  test("--help prints top-level help too", async () => {
    await runCli(["--help"]);
    expect(written).toContain("Usage: lamasync <command>");
    expect(exitCode).toBeUndefined();
  });

  test("'local status --help' prints command-specific help", async () => {
    await runCli(["local", "status", "--help"]);
    expect(written).toContain("Show local daemon status");
    expect(exitCode).toBeUndefined();
  });

  test("unknown command → exit 2 with usage error", async () => {
    let caught: unknown;
    try {
      await runCli(["notacommand"]);
    } catch (err) {
      caught = err;
    }
    // The dispatcher maps unknown-command CliUsageError via process.exit(2);
    // we intercept exit so the marker is what surfaces to the test.
    expect(caught).toEqual(expect.objectContaining({ __testExit: true }));
    expect(exitCode).toBe(2);
  });

  test("removed server-facing commands are unknown (LAMA-326)", async () => {
    let caught: unknown;
    try {
      await runCli(["folders", "list", "--help"]);
    } catch (err) {
      caught = err;
    }
    // The whole server-facing management surface is gone; even --help
    // must not resurrect it.
    expect(caught).toEqual(expect.objectContaining({ __testExit: true }));
    expect(exitCode).toBe(2);
    expect(written).not.toContain("List folders.");
  });

  test("usage error inside a subcommand → exit 2", async () => {
    let caught: unknown;
    const originalHome = process.env.HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), "lamasync-dispatch-test-"));
    try {
      // Point HOME at a temp dir so a real ~/.config/lamasync/client.toml
      // on the dev machine can't turn `register` into the exit-1
      // config-exists refusal instead of the usage error under test.
      process.env.HOME = fakeHome;
      // `register` in a non-TTY context without --code / --server throws
      // CliUsageError; the dispatcher routes it to exit(2).
      await runCli(["register"]);
    } catch (err) {
      caught = err;
    } finally {
      process.env.HOME = originalHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
    expect(caught).toEqual(expect.objectContaining({ __testExit: true }));
    expect(exitCode).toBe(2);
  });
});
