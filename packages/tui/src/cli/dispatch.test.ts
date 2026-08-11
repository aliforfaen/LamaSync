// Dispatch smoke tests: top-level help, command help, unknown command,
// and usage-error routing. Pure dispatch — no I/O against the server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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
    process.exit = ((code?: number): never => {
      exitCode = code ?? 0;
      throw new Error(`__exit:${code ?? 0}`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
    process.exit = originalExit;
  });

  test("bare 'lamasync' prints top-level help and exits", async () => {
    await runCli([]);
    expect(written).toContain("Usage: lamasync <command>");
    expect(written).toContain("backends list");
    expect(written).toContain("Exit codes");
    expect(exitCode).toBeUndefined();
  });

  test("--help prints top-level help too", async () => {
    await runCli(["--help"]);
    expect(written).toContain("Usage: lamasync <command>");
    expect(exitCode).toBeUndefined();
  });

  test("'folders list --help' prints command-specific help", async () => {
    await runCli(["folders", "list", "--help"]);
    expect(written).toContain("List folders");
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
    expect((caught as Error).message).toContain("__exit:2");
  });

  test("usage error inside a subcommand → exit 2", async () => {
    let caught: unknown;
    try {
      // `lamasync folders create` without --name triggers CliUsageError;
      // the dispatcher catches it inside run() and routes to exit(2).
      await runCli(["folders", "create", "--type", "sync"]);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain("__exit:2");
  });
});
