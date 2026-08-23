// Command-path tests: real dispatch → real command module → real
// LamaSyncApiClient, with only the transport (globalThis.fetch) stubbed.
// These pin the exit-code contract (LAMA-229: 401/403 → exit 3) and the
// third-level `dotfiles manifests` dispatch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

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
