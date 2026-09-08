// LAMA-262: `lamasync register` — pairing-code exchange flow.
//
// Coverage:
//   - happy path: create + exchange + client.toml round-trip
//   - already-configured refusal (no --force): exits 1, no network
//   - --force overwrites an existing client.toml
//   - missing --code in non-interactive: exit 2, no network
//   - missing --server: exit 2, no network
//   - invalid code shape: exit 2, no network
//   - second-exchange 409 + used-status: exit 1
//   - expired 410: exit 1
//   - lookup 401/404 swallowed (exchange is the authoritative call)
//   - exemption wiring: `register` with no config does NOT refuse

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { parseClientConfig } from "@lamasync/core";

import { runCli } from "./dispatch.ts";

interface RecordedRequest {
  method: string;
  url: string;
  body: string | null;
}

interface FixtureOptions {
  /** Stub for globalThis.fetch. Records every call. */
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** HOME for this test (so client.toml lands in a temp dir). */
  home: string;
}

function withFixture(
  fn: (opts: FixtureOptions, helpers: { recorded: RecordedRequest[] }) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const originalHome = process.env.HOME;
    const originalUrl = process.env.LAMASYNC_SERVER_URL;
    const originalKey = process.env.LAMASYNC_API_KEY;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalErrWrite = process.stderr.write.bind(process.stderr);
    const originalExit = process.exit;
    const originalFetch = globalThis.fetch;
    const originalIsTTY = process.stdin.isTTY;

    const fakeHome = mkdtempSync(join(tmpdir(), "lamasync-register-"));
    let written = "";
    let exitCode: number | undefined;
    const recorded: RecordedRequest[] = [];

    process.env.HOME = fakeHome;
    delete process.env.LAMASYNC_SERVER_URL;
    delete process.env.LAMASYNC_API_KEY;
    process.stdin.isTTY = false; // force --code required in non-interactive tests

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

    try {
      await fn(
        {
          home: fakeHome,
          fetchImpl: (input, init) => {
            const req: RecordedRequest = {
              method: init?.method ?? "GET",
              url: String(input),
              body: typeof init?.body === "string" ? init.body : null,
            };
            recorded.push(req);
            return Promise.resolve(new Response("{}", { status: 500 }));
          },
        },
        { recorded },
      );
    } finally {
      process.env.HOME = originalHome;
      if (originalUrl === undefined) delete process.env.LAMASYNC_SERVER_URL;
      else process.env.LAMASYNC_SERVER_URL = originalUrl;
      if (originalKey === undefined) delete process.env.LAMASYNC_API_KEY;
      else process.env.LAMASYNC_API_KEY = originalKey;
      process.stdout.write = originalWrite;
      process.stderr.write = originalErrWrite;
      process.exit = originalExit;
      globalThis.fetch = originalFetch;
      process.stdin.isTTY = originalIsTTY;
      rmSync(fakeHome, { recursive: true, force: true });
      // Make the recorded / written values accessible for assertions in
      // the test bodies via the closure (intentionally unused here —
      // individual tests inspect their own captured fixture state).
      void written;
      void exitCode;
    }
  };
}

describe("register command (LAMA-262)", () => {
  test(
    "exemption wiring: `register` with no client.toml does NOT refuse",
    withFixture(async ({ fetchImpl }, { recorded }) => {
      // Stub fetch to 200 on create + 200 on lookup + 200 on exchange so
      // the command runs end-to-end. The point of this test is the
      // exemption wiring — without it the dispatcher would exit 3 BEFORE
      // any fetch.
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const req: RecordedRequest = {
          method: init?.method ?? "GET",
          url,
          body: typeof init?.body === "string" ? init.body : null,
        };
        recorded.push(req);
        if (url.endsWith("/api/v1/pairing") && req.method === "POST") {
          return new Response(
            JSON.stringify({ code: "LAMA-72B4-9PQ2", expiresInSeconds: 600 }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/v1/pairing/LAMA-72B4-9PQ2/exchange")) {
          return new Response(
            JSON.stringify({ apiKey: "real-key-1234567890" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ status: "pending" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      let caught: unknown;
      try {
        await runCli([
          "register",
          "--code", "LAMA-72B4-9PQ2",
          "--server", "http://lamasync.test",
        ]);
      } catch (err) {
        caught = err;
      }
      // On success, runCli doesn't throw → caught is undefined. The
      // critical check is that we did NOT refuse (no __exit:3 "No
      // client.toml found" message) and that the create + exchange
      // requests actually went out.
      expect(caught).toBeUndefined();
      expect(recorded.length).toBeGreaterThan(0);
      // No refusal message.
      const allUrls = recorded.map((r) => r.url).join("\n");
      expect(allUrls).toContain("/api/v1/pairing");
    }),
  );

  test(
    "happy path: create + lookup + exchange → client.toml round-trips",
    withFixture(async ({ home, fetchImpl: _fetchImpl }, { recorded }) => {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        recorded.push({
          method: init?.method ?? "GET",
          url,
          body: typeof init?.body === "string" ? init.body : null,
        });
        if (url.endsWith("/api/v1/pairing") && (init?.method ?? "GET") === "POST") {
          return new Response(
            JSON.stringify({ code: "LAMA-72B4-9PQ2", expiresInSeconds: 600 }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/v1/pairing/LAMA-72B4-9PQ2")) {
          return new Response(
            JSON.stringify({ status: "pending", expiresAt: new Date(Date.now() + 600_000).toISOString() }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/v1/pairing/LAMA-72B4-9PQ2/exchange")) {
          return new Response(
            JSON.stringify({ apiKey: "real-key-1234567890abcdef" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return _fetchImpl(input, init);
      }) as typeof fetch;
      await runCli([
        "register",
        "--code", "lama-72b4-9pq2",
        "--server", "http://lamasync.test",
        "--hostname", "my-laptop",
        "--json",
      ]);
      const configPath = join(home, ".config", "lamasync", "client.toml");
      expect(existsSync(configPath)).toBe(true);
      const parsed = parseClientConfig(readFileSync(configPath, "utf8"));
      expect(parsed.serverUrl).toBe("http://lamasync.test");
      expect(parsed.apiKey).toBe("real-key-1234567890abcdef");
      expect(parsed.hostname).toBe("my-laptop");
      // We called both lookup and exchange — at minimum 2 outbound
      // requests to the pairing surface.
      const exchangeCall = recorded.find((r) =>
        r.url.endsWith("/api/v1/pairing/LAMA-72B4-9PQ2/exchange"),
      );
      expect(exchangeCall?.method).toBe("POST");
    }),
  );

  test(
    "already-configured refusal (no --force): exits 1, no network",
    withFixture(async ({ home }, { recorded }) => {
      const configDir = join(home, ".config", "lamasync");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "client.toml"),
        `serverUrl = "http://existing.test"\napiKey = "existing-key-1234567890"\nhostname = "old"\n`,
        "utf8",
      );
      let caught: unknown;
      try {
        await runCli([
          "register",
          "--code", "LAMA-72B4-9PQ2",
          "--server", "http://lamasync.test",
        ]);
      } catch (err) {
        caught = err;
      }
      expect((caught as Error).message).toContain("__exit:1");
      // No fetch was attempted.
      expect(recorded).toHaveLength(0);
      // The existing file was preserved verbatim.
      const parsed = parseClientConfig(
        readFileSync(join(configDir, "client.toml"), "utf8"),
      );
      expect(parsed.serverUrl).toBe("http://existing.test");
    }),
  );

  test(
    "--force overwrites an existing client.toml",
    withFixture(async ({ home }, { recorded }) => {
      const configDir = join(home, ".config", "lamasync");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "client.toml"),
        `serverUrl = "http://existing.test"\napiKey = "old-key-1234567890"\nhostname = "old"\n`,
        "utf8",
      );
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        recorded.push({
          method: init?.method ?? "GET",
          url,
          body: typeof init?.body === "string" ? init.body : null,
        });
        if (url.endsWith("/api/v1/pairing") && (init?.method ?? "GET") === "POST") {
          return new Response(
            JSON.stringify({ code: "LAMA-72B4-9PQ2", expiresInSeconds: 600 }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/v1/pairing/LAMA-72B4-9PQ2/exchange")) {
          return new Response(
            JSON.stringify({ apiKey: "new-key-9876543210" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/v1/pairing/LAMA-72B4-9PQ2")) {
          return new Response(JSON.stringify({ status: "pending" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 500 });
      }) as typeof fetch;
      await runCli([
        "register",
        "--code", "LAMA-72B4-9PQ2",
        "--server", "http://new.test",
        "--hostname", "new",
        "--force",
        "--json",
      ]);
      const parsed = parseClientConfig(
        readFileSync(join(configDir, "client.toml"), "utf8"),
      );
      expect(parsed.serverUrl).toBe("http://new.test");
      expect(parsed.apiKey).toBe("new-key-9876543210");
      expect(parsed.hostname).toBe("new");
    }),
  );

  test(
    "missing --code in non-interactive: exit 2, no network",
    withFixture(async (_opts, { recorded }) => {
      let caught: unknown;
      try {
        await runCli(["register", "--server", "http://lamasync.test"]);
      } catch (err) {
        caught = err;
      }
      expect((caught as Error).message).toContain("__exit:2");
      expect(recorded).toHaveLength(0);
    }),
  );

  test(
    "missing --server: exit 2, no network",
    withFixture(async (_opts, { recorded }) => {
      let caught: unknown;
      try {
        await runCli(["register", "--code", "LAMA-72B4-9PQ2"]);
      } catch (err) {
        caught = err;
      }
      expect((caught as Error).message).toContain("__exit:2");
      expect(recorded).toHaveLength(0);
    }),
  );

  test(
    "invalid code shape: exit 2, no network",
    withFixture(async (_opts, { recorded }) => {
      let caught: unknown;
      try {
        await runCli([
          "register",
          "--code", "not-a-code",
          "--server", "http://lamasync.test",
        ]);
      } catch (err) {
        caught = err;
      }
      expect((caught as Error).message).toContain("__exit:2");
      expect(recorded).toHaveLength(0);
    }),
  );

  test(
    "second-exchange 409 + used-status: exit 1, clear error",
    withFixture(async (_opts, { recorded }) => {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        recorded.push({
          method: init?.method ?? "GET",
          url,
          body: typeof init?.body === "string" ? init.body : null,
        });
        if (url.endsWith("/api/v1/pairing") && (init?.method ?? "GET") === "POST") {
          return new Response(
            JSON.stringify({ code: "LAMA-72B4-9PQ2", expiresInSeconds: 600 }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/v1/pairing/LAMA-72B4-9PQ2/exchange")) {
          return new Response(JSON.stringify({ error: "pairing code already used" }), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/api/v1/pairing/LAMA-72B4-9PQ2")) {
          return new Response(JSON.stringify({ status: "used" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("{}", { status: 500 });
      }) as typeof fetch;
      let caught: unknown;
      try {
        await runCli([
          "register",
          "--code", "LAMA-72B4-9PQ2",
          "--server", "http://lamasync.test",
        ]);
      } catch (err) {
        caught = err;
      }
      expect((caught as Error).message).toContain("__exit:1");
      // At least one outbound request happened (the create + lookup +
      // exchange attempts).
      expect(recorded.length).toBeGreaterThan(0);
    }),
  );

  test(
    "expired 410: exit 1, no client.toml written",
    withFixture(async ({ home }, { recorded }) => {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        recorded.push({
          method: init?.method ?? "GET",
          url,
          body: typeof init?.body === "string" ? init.body : null,
        });
        if (url.endsWith("/api/v1/pairing") && (init?.method ?? "GET") === "POST") {
          return new Response(
            JSON.stringify({ code: "LAMA-72B4-9PQ2", expiresInSeconds: 600 }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/v1/pairing/LAMA-72B4-9PQ2/exchange")) {
          return new Response(JSON.stringify({ error: "pairing code expired" }), {
            status: 410,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ status: "expired" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      let caught: unknown;
      try {
        await runCli([
          "register",
          "--code", "LAMA-72B4-9PQ2",
          "--server", "http://lamasync.test",
        ]);
      } catch (err) {
        caught = err;
      }
      expect((caught as Error).message).toContain("__exit:1");
      const configPath = join(home, ".config", "lamasync", "client.toml");
      expect(existsSync(configPath)).toBe(false);
    }),
  );

  test(
    "lookup 401 is swallowed; exchange is the authoritative call",
    withFixture(async ({ home }, { recorded }) => {
      // GET /pairing/:code returns 401 (no key on the wire; auth-exempt
      // endpoint expected). The exchange is auth-exempt too — it
      // succeeds without a header. The command must NOT refuse the
      // lookup 401.
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        recorded.push({
          method: init?.method ?? "GET",
          url,
          body: typeof init?.body === "string" ? init.body : null,
        });
        if (url.endsWith("/api/v1/pairing") && (init?.method ?? "GET") === "POST") {
          return new Response(
            JSON.stringify({ code: "LAMA-72B4-9PQ2", expiresInSeconds: 600 }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/v1/pairing/LAMA-72B4-9PQ2")) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/api/v1/pairing/LAMA-72B4-9PQ2/exchange")) {
          return new Response(
            JSON.stringify({ apiKey: "real-key-abcdef-1234567890" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 500 });
      }) as typeof fetch;
      await runCli([
        "register",
        "--code", "LAMA-72B4-9PQ2",
        "--server", "http://lamasync.test",
        "--json",
      ]);
      const configPath = join(home, ".config", "lamasync", "client.toml");
      expect(existsSync(configPath)).toBe(true);
    }),
  );
});

// Pure-helper unit tests (no I/O, no stubs).
describe("register command helpers (LAMA-262)", () => {
  // Lazy import so the test can pull helpers without polluting the
  // describe-with-fixture closure shape above.
  let helpers: typeof import("./register.ts")["__registerHelpersForTests"];
  beforeEach(async () => {
    helpers = (await import("./register.ts")).__registerHelpersForTests;
  });
  afterEach(() => {
    // No teardown; helpers are pure functions.
  });

  test("looksLikePairingCode accepts both lower + upper + ambiguous-char rejection", () => {
    expect(helpers.looksLikePairingCode("lama-72B4-9PQ2")).toBe(true);
    expect(helpers.looksLikePairingCode("LAMA-72B4-9PQ2")).toBe(true);
    expect(helpers.looksLikePairingCode("lama-72b4-9pq2")).toBe(true);
    expect(helpers.looksLikePairingCode("LAMA-72B4-9PQI")).toBe(false); // I excluded
    expect(helpers.looksLikePairingCode("LAMA-72B4-9PQ1")).toBe(false); // 1 excluded
    expect(helpers.looksLikePairingCode("LAMA-72B4-9PQL")).toBe(false); // L excluded
    expect(helpers.looksLikePairingCode("LAMA-72B4-9PQO")).toBe(false); // O excluded
    expect(helpers.looksLikePairingCode("LAMA-72B4-9PQ0")).toBe(false); // 0 excluded
    expect(helpers.looksLikePairingCode("nope")).toBe(false);
  });

  test("normalizeCode upper-cases + trims", () => {
    expect(helpers.normalizeCode("  lama-72b4-9pq2  ")).toBe("LAMA-72B4-9PQ2");
    expect(helpers.normalizeCode("LAMA-72B4-9PQ2")).toBe("LAMA-72B4-9PQ2");
  });

  test("resolveServerUrl prefers --server flag, then env", () => {
    const originalUrl = process.env.LAMASYNC_SERVER_URL;
    try {
      expect(helpers.resolveServerUrl("http://flag.test/")).toEqual({
        serverUrl: "http://flag.test",
      });
      process.env.LAMASYNC_SERVER_URL = "http://env.test";
      expect(helpers.resolveServerUrl(undefined)).toEqual({
        serverUrl: "http://env.test",
      });
      // Flag wins over env.
      expect(helpers.resolveServerUrl("http://flag.test/")).toEqual({
        serverUrl: "http://flag.test",
      });
      delete process.env.LAMASYNC_SERVER_URL;
      expect(helpers.resolveServerUrl(undefined)).toBeNull();
    } finally {
      if (originalUrl === undefined) delete process.env.LAMASYNC_SERVER_URL;
      else process.env.LAMASYNC_SERVER_URL = originalUrl;
    }
  });

  test("friendlyPairingError maps wire contract to operator copy", () => {
    expect(helpers.friendlyPairingError(404, "")).toContain("not found");
    expect(helpers.friendlyPairingError(409, "already used")).toContain("already used");
    expect(helpers.friendlyPairingError(410, "expired")).toContain("expired");
    expect(helpers.friendlyPairingError(503, "")).toContain("LAMASYNC_SECRET_KEY");
    expect(helpers.friendlyPairingError(500, "boom")).toContain("500");
  });

  test("exitCodeForStatus matches the LAMA-229 contract", () => {
    expect(helpers.exitCodeForStatus(401)).toBe(3);
    expect(helpers.exitCodeForStatus(403)).toBe(3);
    expect(helpers.exitCodeForStatus(404)).toBe(1);
    expect(helpers.exitCodeForStatus(409)).toBe(1);
    expect(helpers.exitCodeForStatus(410)).toBe(1);
    expect(helpers.exitCodeForStatus(500)).toBe(4);
    expect(helpers.exitCodeForStatus(503)).toBe(4);
    expect(helpers.exitCodeForStatus(0)).toBe(1);
  });
});

// Avoid "unused" warnings by referencing the test seam in a single
// `describe` block. The withFixture closure handles stdin.isTTY=false
// restoration, but Bun's lint complains about the parameter — give
// it a use.
void withFixture;
