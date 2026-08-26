// Command-path tests: real dispatch → real command module → real
// LamaSyncApiClient, with only the transport (globalThis.fetch) stubbed.
// These pin the exit-code contract (LAMA-229: 401/403 → exit 3) and the
// third-level `dotfiles manifests` dispatch.

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
    process.exit = ((code?: number): never => {
      exitCode = code ?? 0;
      throw new Error(`__exit:${code ?? 0}`);
    }) as typeof process.exit;

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
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/^__exit:\d+$/);
    return exitCode ?? -1;
  }

  test("401 from the server maps to exit 3 through the real command path", async () => {
    const code = await runExpectingExit([
      "status",
      "--server", "http://lamasync.test",
      "--api-key", "wrong-key-1234567890",
    ]);
    expect(code).toBe(3);
    // The request really went out (real client) and the wrapped error kept
    // its command prefix on stderr.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.url).toBe("http://lamasync.test/api/v1/health");
    expect(written).toContain("lamasync: status:");
  });

  test("403 from the server also maps to exit 3", async () => {
    responder = () =>
      new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    const code = await runExpectingExit([
      "folders", "list",
      "--server", "http://lamasync.test",
      "--api-key", "wrong-key-1234567890",
    ]);
    expect(code).toBe(3);
    expect(written).toContain("lamasync: list folders:");
  });

  // LAMA-247 #14: `--json` + exit 3 must emit a grep-able structured
  // `reason` on stdout so headless callers can jq it instead of scraping
  // a masked key string from stderr.
  test("--json auth failure emits {ok:false, reason:\"auth-failure\"} on stdout", async () => {
    const code = await runExpectingExit([
      "status",
      "--server", "http://lamasync.test",
      "--api-key", "wrong-key-1234567890",
      "--json",
    ]);
    expect(code).toBe(3);
    // stdout carries the machine-readable envelope; stderr the human line.
    const envelope = JSON.parse(stdout);
    expect(envelope).toMatchObject({
      ok: false,
      reason: "auth-failure",
      exitCode: 3,
    });
    expect(written).toContain("lamasync: status:");
  });

  // Owner decision (LAMA-247 #13): no-credentials invocations keep the
  // localhost/dev-key default but must warn loudly on stderr. HOME is
  // pointed at a temp dir so a real ~/.config/lamasync/client.toml on the
  // host can't side-step the fallback path.
  //
  // LAMA-248 / endgame split-by-surface: the loud warning now only fires
  // for diagnostic / exempt commands (doctor, local.*). Doctor is the
  // canonical case — it still warns and goes out to the network so it can
  // diagnose this state. Non-exempt subcommands refuse before any HTTP.
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
      // exits 1, but the point is it RAN end-to-end (refusal would have
      // short-circuited with exit 3 BEFORE any fetch).
      const code = await runExpectingExit(["doctor", "--json"]);
      // Refusal message MUST NOT appear.
      expect(written).not.toContain("No client.toml found");
      // Loud warning still fires.
      expect(written).toContain("[!] no credentials found");
      expect(written).toContain("dev-key");
      // Doctor really went out to the network — the refusal would have
      // left recorded empty. Doctor calls the version-drift probe too,
      // so recorded has at least one entry even though source=default
      // skips the server-reachability fetch.
      expect(recorded.length).toBeGreaterThan(0);
      // The LAMA-248 advice copy is present in the auth-source row.
      expect(written).toContain("subcommands refuse exit 3");
      // exit code is whatever doctor decides (0 / 1) — NOT the refusal's 3.
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

  // LAMA-248 / endgame split-by-surface: explicit subcommands without
  // a client.toml refuse with exit 3 BEFORE any network attempt. The
  // refusal must NOT hit the fake URL (no fetch happens). HOME is pointed
  // at a temp dir; no env vars; no flags. Three different commands are
  // exercised to pin the behavior across leaf / group-head shapes.
  describe("no-config refusal (LAMA-248)", () => {
    async function runWithNoConfig(argv: string[]): Promise<void> {
      const originalHome = process.env.HOME;
      const originalUrl = process.env.LAMASYNC_SERVER_URL;
      const originalKey = process.env.LAMASYNC_API_KEY;
      const fakeHome = mkdtempSync(join(tmpdir(), "lamasync-cli-no-config-"));
      try {
        process.env.HOME = fakeHome;
        delete process.env.LAMASYNC_SERVER_URL;
        delete process.env.LAMASYNC_API_KEY;
        await runExpectingExit(argv);
      } finally {
        process.env.HOME = originalHome;
        if (originalUrl === undefined) delete process.env.LAMASYNC_SERVER_URL;
        else process.env.LAMASYNC_SERVER_URL = originalUrl;
        if (originalKey === undefined) delete process.env.LAMASYNC_API_KEY;
        else process.env.LAMASYNC_API_KEY = originalKey;
        rmSync(fakeHome, { recursive: true, force: true });
      }
    }

    test("status (no config) → exit 3 + stderr + zero network calls", async () => {
      await runWithNoConfig(["status"]);
      expect(exitCode).toBe(3);
      expect(written).toContain("No client.toml found at");
      expect(written).toContain("run bare 'lamasync' once");
      // Critical: refusal fired BEFORE any fetch. The old behavior
      // hit localhost:8080 / 401; the new behavior must not.
      expect(recorded).toHaveLength(0);
    });

    test("folders list (no config) → exit 3 + stderr message", async () => {
      await runWithNoConfig(["folders", "list"]);
      expect(exitCode).toBe(3);
      expect(written).toContain("No client.toml found at");
      expect(recorded).toHaveLength(0);
    });

    test("ops list (no config) → exit 3 + stderr message", async () => {
      await runWithNoConfig(["ops", "list"]);
      expect(exitCode).toBe(3);
      expect(written).toContain("No client.toml found at");
      expect(recorded).toHaveLength(0);
    });

    test("status --json (no config) → exit 3 + structured no-config envelope on stdout", async () => {
      await runWithNoConfig(["status", "--json"]);
      expect(exitCode).toBe(3);
      // The grep-able envelope matches the LAMA-247 #14 shape but with
      // reason:"no-config" so scripts can distinguish from auth-failure.
      const envelope = JSON.parse(stdout);
      expect(envelope).toMatchObject({
        ok: false,
        reason: "no-config",
        exitCode: 3,
      });
      expect(envelope.error).toContain("No client.toml found at");
      expect(envelope.configPath).toContain(".config/lamasync/client.toml");
      // No fetch was attempted.
      expect(recorded).toHaveLength(0);
    });

    test("--server + --api-key (no config file) bypasses the refusal", async () => {
      // Inline credentials must not trigger the refusal even when no
      // client.toml exists on disk — same precedence as buildCliClient.
      responder = () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      const fakeHome = mkdtempSync(join(tmpdir(), "lamasync-cli-no-config-"));
      const originalHome = process.env.HOME;
      const originalUrl = process.env.LAMASYNC_SERVER_URL;
      const originalKey = process.env.LAMASYNC_API_KEY;
      try {
        process.env.HOME = fakeHome;
        delete process.env.LAMASYNC_SERVER_URL;
        delete process.env.LAMASYNC_API_KEY;
        const code = await runExpectingExit([
          "status",
          "--server", "http://lamasync.test",
          "--api-key", "real-key-1234567890",
        ]);
        // Hit the real URL the flags pointed at, not localhost:8080 —
        // proves the refusal didn't fire and the inline credentials were
        // honored.
        expect(code).toBe(3); // 401 from stubbed transport
        expect(recorded).toHaveLength(1);
        expect(recorded[0]?.url).toBe("http://lamasync.test/api/v1/health");
        expect(written).not.toContain("No client.toml found");
      } finally {
        process.env.HOME = originalHome;
        if (originalUrl === undefined) delete process.env.LAMASYNC_SERVER_URL;
        else process.env.LAMASYNC_SERVER_URL = originalUrl;
        if (originalKey === undefined) delete process.env.LAMASYNC_API_KEY;
        else process.env.LAMASYNC_API_KEY = originalKey;
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    test("LAMASYNC_SERVER_URL + LAMASYNC_API_KEY (no config file) bypass the refusal", async () => {
      responder = () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      const fakeHome = mkdtempSync(join(tmpdir(), "lamasync-cli-no-config-"));
      const originalHome = process.env.HOME;
      const originalUrl = process.env.LAMASYNC_SERVER_URL;
      const originalKey = process.env.LAMASYNC_API_KEY;
      try {
        process.env.HOME = fakeHome;
        process.env.LAMASYNC_SERVER_URL = "http://env.test";
        process.env.LAMASYNC_API_KEY = "env-key-long-enough";
        const code = await runExpectingExit(["status"]);
        expect(code).toBe(3);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]?.url).toBe("http://env.test/api/v1/health");
        expect(written).not.toContain("No client.toml found");
      } finally {
        process.env.HOME = originalHome;
        if (originalUrl === undefined) delete process.env.LAMASYNC_SERVER_URL;
        else process.env.LAMASYNC_SERVER_URL = originalUrl;
        if (originalKey === undefined) delete process.env.LAMASYNC_API_KEY;
        else process.env.LAMASYNC_API_KEY = originalKey;
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    test("malformed client.toml does NOT refuse (falls through to loud warning + 401)", async () => {
      // A config file that exists but fails to parse keeps the old
      // behavior: loud warning + fake server + 401. The refusal is only
      // for the "no file at all" case so a broken TOML gets a different
      // signal than an absent one (doctor's job is to tell them apart).
      const fakeHome = mkdtempSync(join(tmpdir(), "lamasync-cli-malformed-"));
      const originalHome = process.env.HOME;
      const originalUrl = process.env.LAMASYNC_SERVER_URL;
      const originalKey = process.env.LAMASYNC_API_KEY;
      try {
        process.env.HOME = fakeHome;
        delete process.env.LAMASYNC_SERVER_URL;
        delete process.env.LAMASYNC_API_KEY;
        const configDir = join(fakeHome, ".config", "lamasync");
        require("fs").mkdirSync(configDir, { recursive: true });
        writeFileSync(
          join(configDir, "client.toml"),
          "not valid toml = =",
          "utf8",
        );
        const code = await runExpectingExit(["status"]);
        // Hit the fake URL with fake creds — same path as LAMA-247 #13.
        expect(code).toBe(3); // 401 from stub transport
        expect(written).toContain("[!] no credentials found");
        expect(written).toContain("dev-key");
        expect(recorded[0]?.url).toContain("localhost:8080");
        // And NOT the refusal message — the file exists, just broken.
        expect(written).not.toContain("No client.toml found");
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

  test("'dotfiles manifests create' dispatches to create (POST), not list", async () => {
    responder = (req) => {
      expect(req.method).toBe("POST");
      return new Response(
        JSON.stringify({
          id: "manifest-1",
          hostId: "_global",
          appName: "nvim",
          paths: ["~/.config/nvim"],
          excludes: null,
          schedule: null,
          instructions: null,
          lastSyncAt: null,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };
    await runCli([
      "dotfiles", "manifests", "create",
      "--app-name", "nvim",
      "--paths", "~/.config/nvim",
      "--server", "http://lamasync.test",
      "--api-key", "good-key-1234567890",
      "--json",
    ]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe("POST");
    expect(recorded[0]?.url).toBe(
      "http://lamasync.test/api/v1/dotfiles/manifests",
    );
    expect(recorded[0]?.body).toContain('"appName":"nvim"');
    expect(exitCode).toBeUndefined();
  });

  test("'dotfiles manifests delete <id> --yes' dispatches to delete (DELETE)", async () => {
    responder = () => new Response(null, { status: 204 });
    await runCli([
      "dotfiles", "manifests", "delete", "manifest-1",
      "--yes",
      "--server", "http://lamasync.test",
      "--api-key", "good-key-1234567890",
      "--json",
    ]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe("DELETE");
    expect(recorded[0]?.url).toBe(
      "http://lamasync.test/api/v1/dotfiles/manifests/manifest-1",
    );
    expect(exitCode).toBeUndefined();
  });

  test("'dotfiles manifests delete' without --yes stays behind confirm (exit 2)", async () => {
    const code = await runExpectingExit([
      "dotfiles", "manifests", "delete", "manifest-1",
      "--server", "http://lamasync.test",
      "--api-key", "good-key-1234567890",
    ]);
    expect(code).toBe(2);
    // confirmDestructive fired before any network write.
    expect(recorded).toHaveLength(0);
  });

  test("'notifications test' POSTs to /notifications/test", async () => {
    responder = () =>
      new Response(
        JSON.stringify({
          id: "event-1",
          type: "test",
          severity: "default",
          message: "Test notification from Admin UI",
          hostId: null,
          folderId: null,
          payload: null,
          createdAt: Date.now(),
          ntfyDelivered: false,
          webhookDelivered: false,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    await runCli([
      "notifications", "test",
      "--server", "http://lamasync.test",
      "--api-key", "good-key-1234567890",
      "--json",
    ]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe("POST");
    expect(recorded[0]?.url).toBe(
      "http://lamasync.test/api/v1/notifications/test",
    );
    expect(exitCode).toBeUndefined();
  });

  test("'sync --host X' without a folderId enqueues an all-assignments sync", async () => {
    responder = () =>
      new Response(
        JSON.stringify({
          id: "action-1",
          hostId: "host-1",
          type: "trigger_sync",
          payload: { all: true },
          status: "pending",
          createdAt: Date.now(),
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    await runCli([
      "sync",
      "--host", "host-1",
      "--server", "http://lamasync.test",
      "--api-key", "good-key-1234567890",
      "--json",
    ]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe("POST");
    expect(recorded[0]?.body).toContain('"all":true');
    expect(exitCode).toBeUndefined();
  });
});
