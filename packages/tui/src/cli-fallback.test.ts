// Tests for the bare-TTY / LAMASYNC_NO_TUI=1 CLI fallback path. The
// LAMA-248 / endgame split-by-surface spec REQUIRES this path to keep the
// friendly localhost/dev-key default + the LAMA-254 loud warning — the
// refusal logic is for explicit subcommands only. These tests pin that
// surface so the split can't accidentally bleed into the fallback.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runCliFallback } from "./cli-fallback.ts";

interface RecordedRequest {
  method: string;
  url: string;
}

describe("runCliFallback — bare-TTY friendly default (LAMA-248)", () => {
  let originalWrite: typeof process.stdout.write;
  let originalErrWrite: typeof process.stderr.write;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalFetch: typeof globalThis.fetch;
  let originalHome: string | undefined;
  let originalUrl: string | undefined;
  let originalKey: string | undefined;
  let stdout: string;
  let stderr: string;
  let recorded: RecordedRequest[];
  let fakeHome: string;

  beforeEach(() => {
    stdout = "";
    stderr = "";
    recorded = [];

    originalWrite = process.stdout.write.bind(process.stdout);
    originalErrWrite = process.stderr.write.bind(process.stderr);
    originalLog = console.log;
    originalError = console.error;
    originalFetch = globalThis.fetch;

    originalHome = process.env.HOME;
    originalUrl = process.env.LAMASYNC_SERVER_URL;
    originalKey = process.env.LAMASYNC_API_KEY;

    process.stdout.write = ((data: string | Uint8Array): boolean => {
      stdout += typeof data === "string" ? data : new TextDecoder().decode(data);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((data: string | Uint8Array): boolean => {
      stderr += typeof data === "string" ? data : new TextDecoder().decode(data);
      return true;
    }) as typeof process.stderr.write;
    // runCliFallback uses console.log / console.error directly.
    console.log = (...args: unknown[]): void => {
      stdout += args.map((a) => String(a)).join(" ") + "\n";
    };
    console.error = (...args: unknown[]): void => {
      stderr += args.map((a) => String(a)).join(" ") + "\n";
    };

    fakeHome = mkdtempSync(join(tmpdir(), "lamasync-cli-fallback-"));
    process.env.HOME = fakeHome;
    delete process.env.LAMASYNC_SERVER_URL;
    delete process.env.LAMASYNC_API_KEY;

    globalThis.fetch = (async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      recorded.push({ method: "GET", url: String(input) });
      // The bare-TTY path should hit the fake default localhost:8080
      // when no config is present. Return a plausible health response so
      // the function exits cleanly.
      return new Response(
        JSON.stringify({
          status: "ok",
          hostCount: 0,
          onlineCount: 0,
          hosts: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
    console.log = originalLog;
    console.error = originalError;
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUrl === undefined) delete process.env.LAMASYNC_SERVER_URL;
    else process.env.LAMASYNC_SERVER_URL = originalUrl;
    if (originalKey === undefined) delete process.env.LAMASYNC_API_KEY;
    else process.env.LAMASYNC_API_KEY = originalKey;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test("no-config bare TTY still uses fake localhost/dev-key (NOT refused)", async () => {
    await runCliFallback();
    // The friendly-default contract: with no client.toml, the fallback
    // hits the fake URL (the LAMA-247 #13 "fake fleet" is real for this
    // surface — the operator is in the local dev loop).
    //
    // Note on the loud-warning check: `buildClient()` in `api.ts`
    // snapshots `homedir()` at module load and exports a frozen
    // CONFIG_PATH, so this test can't safely assert on the
    // `needsSetup` branch without resetting module state. The split-by-
    // surface contract we care about here is just "no refusal on the
    // bare-TTY path" — the loud-warning copy is exercised in
    // `commands.test.ts` (the doctor test) against a HOME-isolated
    // dispatcher path. We only need to prove the friendly default still
    // applies + the refusal message does NOT appear.
    expect(recorded.length).toBeGreaterThan(0);
    // The fallback hits the fake localhost URL — NOT a refusal.
    expect(recorded.some((r) => r.url.includes("localhost:8080"))).toBe(true);
    // CRITICAL: the LAMA-248 no-config refusal message MUST NOT appear
    // on the bare-TTY path. That's the whole point of split-by-surface.
    const captured = stdout + stderr;
    expect(captured).not.toContain("No client.toml found at");
    expect(captured).not.toContain("run bare 'lamasync' once");
  });
});
