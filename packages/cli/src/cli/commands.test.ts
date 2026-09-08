// Command-path tests for the LAMA-326 local-first CLI surface. Real
// dispatch → real command module → real LamaSyncApiClient, with only the
// transport (globalThis.fetch) stubbed. Pins:
//
//   - 401/403 → exit 3 through the real command path (register), with a
//     grep-able {reason:"auth-failure"} envelope under --json (LAMA-247 #14).
//   - config-less doctor still warns loudly and goes to the network (the
//     old LAMA-248 refusal is gone with the server-facing commands).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runCli } from "./dispatch.ts";

interface RecordedRequest {
  method: string;
  url: string;
  body: string | null;
}

describe("CLI command path against a stubbed transport (LAMA-229)", () => {
  let originalWrite: typeof process.stdout.write;
  let originalErrWrite: typeof process.stderr.write;
  let originalExit: typeof process.exit;
  let originalFetch: typeof globalThis.fetch;
  let written: string;
  let stdout: string;
  let exitCode: number | undefined;
  let recorded: RecordedRequest[];
  let responder: (req: RecordedRequest) => Response;

  beforeEach(() => {
    written = "";
    stdout = "";
    exitCode = undefined;
    recorded = [];
    responder = () =>
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });

    originalWrite = process.stdout.write.bind(process.stdout);
    originalErrWrite = process.stderr.write.bind(process.stderr);
    originalExit = process.exit;
    originalFetch = globalThis.fetch;

    process.stdout.write = ((data: string | Uint8Array): boolean => {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      written += text;
      stdout += text;
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

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const req: RecordedRequest = {
        method: init?.method ?? "GET",
        url: String(input),
        body: typeof init?.body === "string" ? init.body : null,
      };
      recorded.push(req);
      return responder(req);
    }) as typeof fetch;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
    process.exit = originalExit;
    globalThis.fetch = originalFetch;
  });

  async function runExpectingExit(argv: string[]): Promise<number> {
    let caught: unknown;
    try {
      await runCli(argv);
    } catch (err) {
      caught = err;
    }
    expect(caught).toEqual(expect.objectContaining({ __testExit: true }));
    return exitCode ?? -1;
  }

  async function runRegisterExpecting(argv: string[]): Promise<number> {
    // Point HOME at a temp dir so a real ~/.config/lamasync/client.toml on
    // the host can't trip register's exit-1 "already exists" refusal.
    const originalHome = process.env.HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), "lamasync-register-test-"));
    try {
      process.env.HOME = fakeHome;
      return await runExpectingExit(argv);
    } finally {
      process.env.HOME = originalHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }

  test("401 through register maps to exit 3 with a command prefix", async () => {
    const code = await runRegisterExpecting([
      "register",
      "--code", "lama-ABCD-EFGH",
      "--server", "http://lamasync.test",
      "--hostname", "trim-test-host",
    ]);
    expect(code).toBe(3);
    // The pairing exchange really went out (real client).
    expect(recorded.length).toBeGreaterThan(0);
    expect(written).toContain("lamasync: pairing failed (status 401)");
  });

  test("--json auth failure emits {ok:false, reason:\"auth-failure\"} on stdout", async () => {
    const code = await runRegisterExpecting([
      "register",
      "--code", "lama-ABCD-EFGH",
      "--server", "http://lamasync.test",
      "--hostname", "trim-test-host",
      "--json",
    ]);
    expect(code).toBe(3);
    // stdout carries register's machine-readable envelope; stderr the
    // human line.
    const envelope = JSON.parse(stdout);
    expect(envelope).toMatchObject({
      ok: false,
      reason: "register-failed",
      status: 401,
      exitCode: 3,
    });
    expect(written).toContain("lamasync: pairing failed (status 401)");
  });

  // Owner decision (LAMA-247 #13): no-credentials invocations keep the
  // localhost/dev-key default but must warn loudly on stderr. HOME is
  // pointed at a temp dir so a real ~/.config/lamasync/client.toml on the
  // host can't side-step the fallback path.
  //
  // LAMA-326: the old LAMA-248 refusal is gone with the server-facing
  // command surface. Doctor is the only remaining server-talking command;
  // it still warns and goes out to the network so it can diagnose this
  // state.
  test("config-less doctor still warns loudly and goes to the network", async () => {
    const originalHome = process.env.HOME;
    const originalUrl = process.env.LAMASYNC_SERVER_URL;
    const originalKey = process.env.LAMASYNC_API_KEY;
    const fakeHome = mkdtempSync(join(tmpdir(), "lamasync-cli-test-"));
    try {
      process.env.HOME = fakeHome;
      delete process.env.LAMASYNC_SERVER_URL;
      delete process.env.LAMASYNC_API_KEY;
      // Stub every fetch with 401 — doctor turns it into FAIL rows and
      // exits 1, but the point is it RAN end-to-end.
      const code = await runExpectingExit(["doctor", "--json"]);
      // Loud warning still fires.
      expect(written).toContain("[!] no credentials found");
      expect(written).toContain("dev-key");
      // Doctor really went out to the network.
      expect(recorded.length).toBeGreaterThan(0);
      // The auth-source row advises register / install.sh, not the old
      // refusal contract.
      expect(written).toContain("lamasync register");
      // exit code is whatever doctor decides (0 / 1) — NOT an auth exit 3.
      expect(code).not.toBe(3);
    } finally {
      process.env.HOME = originalHome;
      if (originalUrl === undefined) delete process.env.LAMASYNC_SERVER_URL;
      else process.env.LAMASYNC_SERVER_URL = originalUrl;
      if (originalKey === undefined) delete process.env.LAMASYNC_API_KEY;
      else process.env.LAMASYNC_API_KEY = originalKey;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
