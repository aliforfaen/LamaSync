/**
 * `lamasync register` (LAMA-262) — exchange a pairing code from the web
 * UI for a `client.toml` so the device can talk to the fleet. Replaces
 * the old "agent fallback for the install script" flow; the daemon-side
 * POST /api/v1/register is unchanged (still owned by the daemon's
 * heartbeat path).
 *
 * Flow (LAMA-262):
 *   1. Refuse if a client.toml already exists, unless --force (safety:
 *      don't silently overwrite an operator's working config).
 *   2. Resolve the server URL (--server flag > LAMASYNC_SERVER_URL env).
 *      Refuse if neither is set; the operator needs a target.
 *   3. Prompt for the pairing code (TTY readline) or accept --code.
 *   4. GET /pairing/:code to confirm it's still pending (defensive:
 *      skip on 404 / 401 so the operator gets a clear error).
 *   5. POST /pairing/:code/exchange → { apiKey }. Single-use; a second
 *      call from anywhere returns 409 — the wire contract holds even
 *      on partial failures.
 *   6. Write the client.toml via `writeClientConfig` (creates the
 *      ~/.config/lamasync dir if needed). The apiKey is masked on the
 *      echo so the operator never sees it on a shared screen.
 *
 * Auth exemption: this command is added to `NO_CONFIG_EXEMPT` in
 * dispatch.ts. The whole POINT of the command is to write the file —
 * refusing (exit 3) without one would be a chicken/egg.
 */

import { existsSync } from "fs";
import { hostname as osHostname } from "os";
import { createInterface } from "readline";
import { LamaSyncApiClient } from "@lamasync/core";

import { CliUsageError, flagBool, flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import { defaultConfigPath } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { fail, maskSecret, printJson } from "./output.ts";
import { writeClientConfig } from "../api.ts";
/** Match the wire format the server returns. Case-insensitive — the
 *  server normalizes inbound codes to UPPER, so both shapes work.
 *  Mirrors the server's CODE_ALPHABET (no 0/O/1/I/L) so a typo'd code
 *  is rejected locally before we burn an HTTP round trip. */
const PAIRING_CODE_RE = /^lama-[abcdefghjkmnpqrstuvwxyz23456789]{4}-[abcdefghjkmnpqrstuvwxyz23456789]{4}$/i;

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

function looksLikePairingCode(value: string): boolean {
  return PAIRING_CODE_RE.test(value.trim());
}

interface ResolvedRegisterTarget {
  serverUrl: string;
}

function resolveServerUrl(flagServer: string | undefined): ResolvedRegisterTarget | null {
  const flag = typeof flagServer === "string" ? flagServer.trim() : "";
  if (flag.length > 0) return { serverUrl: flag.replace(/\/+$/, "") };
  const env = (process.env.LAMASYNC_SERVER_URL ?? "").trim();
  if (env.length > 0) return { serverUrl: env.replace(/\/+$/, "") };
  return null;
}

/** Ask the operator for the pairing code interactively. Returns null on
 *  EOF / empty input. Single-line, terminal:false so it pipes cleanly
 *  in a CI loop (the operator just won't type — same shape as
 *  `safety.readLineOnce`). */
async function promptForCode(prompt: string): Promise<string | null> {
  process.stdout.write(prompt);
  return await new Promise<string | null>((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    });
    let resolved = false;
    const settle = (value: string | null): void => {
      if (resolved) return;
      resolved = true;
      try {
        rl.close();
      } catch {
        // ignore
      }
      resolve(value);
    };
    rl.once("line", (line) => settle(line.trim()));
    rl.once("close", () => settle(null));
    process.stdin.once("end", () => settle(null));
  });
}

/** Build a minimal, unauthenticated client just for the pairing flow.
 *  We don't reuse `buildCliClient` because that one enforces the
 *  pre-shared-key precedence ladder (config > env > flag) and the
 *  pairing exchange is auth-exempt — the code is the proof of intent.
 *  We still pass the server URL through the same trimming rules. */
function buildPairingClient(serverUrl: string, apiKeyOverride?: string): LamaSyncApiClient {
  // The exchange endpoint is auth-exempt (see auth.ts AUTH_EXEMPT_PATHS)
  // so any string is fine as the API key for the client constructor —
  // it's never sent. But the lookup endpoint IS auth-protected; for that
  // we need a real key. The CLI never requires the lookup (the create
  // + exchange flow is enough), but if an operator wants to poll, they
  // can pass --api-key too.
  return new LamaSyncApiClient(
    serverUrl,
    apiKeyOverride ?? "pairing-flow",
  );
}

function friendlyPairingError(status: number, body: string): string {
  // Map the wire contract to operator-readable copy. The exact messages
  // here are stable so scripts / docs can grep them; keep them in sync
  // with `reference/cli.md` and `packages/agent-skill/SKILL.md`.
  const lower = body.toLowerCase();
  switch (status) {
    case 404:
      return "pairing code not found — double-check the code or generate a new one in the web UI";
    case 409:
      if (lower.includes("already used")) {
        return "pairing code already used — generate a new code in the web UI";
      }
      return `pairing code unavailable (${body.trim()})`;
    case 410:
      return "pairing code expired — generate a new code in the web UI";
    case 503:
      return "pairing exchange unavailable — server has no API key configured; set LAMASYNC_API_KEY on the server";
    default:
      return `pairing failed (status ${status}): ${body.trim()}`;
  }
}

function exitCodeForStatus(status: number): number {
  // Match the LAMA-229 exit-code contract for the wire shape we expose
  // here. Auth failures (none today; the exchange is auth-exempt) → 3.
  // Server-unreachable (network / 5xx) → 4. Everything else → 1.
  if (status === 401 || status === 403) return 3;
  if (status >= 500) return 4;
  return 1;
}

export async function runRegister(ctx: CliContext): Promise<void> {
  const { flags, json } = ctx;

  // 1. Polite refusal if a client.toml already exists. --force lets a
  //    repair flow overwrite a broken / stale config (e.g. rotated
  //    key).
  const configPath = defaultConfigPath();
  if (existsSync(configPath) && !flagBool(flags, "force")) {
    // Run-time refusal (not a usage error): exit 1. fail() calls
    // process.exit directly, which runCli's catch block then re-routes
    // through exitCodeForError → 1 anyway. Keeping fail() here keeps
    // the stderr line clean ("lamasync: ...").
    fail(
      `client.toml already exists at ${configPath} — refusing to overwrite (use --force to replace it)`,
      1,
    );
  }

  // 2. Resolve the server URL. --server > LAMASYNC_SERVER_URL.
  //    Refuse rather than silently defaulting to localhost — the
  //    operator MUST be pointed at a real fleet for the exchange to
  //    succeed.
  const target = resolveServerUrl(flagString(flags, "server"));
  if (!target) {
    throw new CliUsageError(
      "register: --server URL (or LAMASYNC_SERVER_URL env) is required so the device knows which server to pair against",
    );
  }

  // 3. Get the code. --code > interactive prompt. The prompt only
  //    appears on a TTY; non-interactive contexts MUST pass --code
  //    (matches the safety rule 5 contract for "I really mean it").
  let code = normalizeCode(flagString(flags, "code") ?? "");
  if (code.length === 0) {
    if (!process.stdin.isTTY) {
      throw new CliUsageError(
        "register: --code <lama-XXXX-XXXX> is required in non-interactive contexts",
      );
    }
    const input = await promptForCode("pairing code (lama-XXXX-XXXX): ");
    if (input === null || input.length === 0) {
      fail("register: no pairing code provided", 1);
    }
    code = normalizeCode(input);
  }
  if (!looksLikePairingCode(code)) {
    throw new CliUsageError(
      `register: invalid pairing code '${code}' — expected shape lama-XXXX-XXXX (unambiguous alphabet; no 0/O/1/I/L)`,
    );
  }
  code = normalizeCode(code);

  // 4-5. Build a client just for this flow and run lookup + exchange.
  //    We tolerate a 401 on the lookup (auth-protected; we don't have a
  //    key yet) and skip straight to the exchange — that's the whole
  //    point of the auth-exempt endpoint.
  const client = buildPairingClient(target.serverUrl);

  try {
    try {
      await client.lookupPairingSession(code);
      // 200 means pending (or used/expired via the wire projection).
      // The exchange is the authoritative step; if the lookup reveals
      // the code is already gone, the exchange will 409 / 410 anyway.
    } catch (lookupErr) {
      // Swallow 401 / 404 — operator doesn't have a key yet, and a
      // 404 here is just a fast-fail signal we don't need.
      const apiErr = lookupErr as { status?: number };
      if (apiErr.status !== 401 && apiErr.status !== 404) {
        throw wrapApiError(lookupErr, "register lookup");
      }
    }

    let apiKey: string;
    try {
      const result = await client.exchangePairingSession(code);
      apiKey = result.apiKey;
    } catch (exchangeErr) {
      const apiErr = exchangeErr as { status?: number; body?: string; message?: string };
      const status = typeof apiErr.status === "number" ? apiErr.status : 0;
      const body = typeof apiErr.body === "string" && apiErr.body.length > 0
        ? apiErr.body
        : (typeof apiErr.message === "string" ? apiErr.message : "");
      const code = exitCodeForStatus(status);
      if (json) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: false,
              reason: status === 409 || status === 410 ? "pairing-code-state" : "register-failed",
              status,
              exitCode: code,
              error: friendlyPairingError(status, body),
            },
            null,
            2,
          ) + "\n",
        );
      }
      fail(friendlyPairingError(status, body), code);
    }

    // 6. Derive the hostname. Prefer --hostname; fall back to $(hostname)
    //    so a vanilla `lamasync register --code X --server URL` Just Works.
    let host = (flagString(flags, "hostname") ?? "").trim();
    if (host.length === 0) {
      try {
        host = osHostname();
      } catch {
        host = "";
      }
    }
    if (host.length === 0) {
      fail("register: failed to determine hostname — pass --hostname <name>", 1);
    }

    try {
      writeClientConfig(
        { serverUrl: target.serverUrl, apiKey, hostname: host },
        configPath,
      );
    } catch (writeErr) {
      const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
      fail(`register: failed to write ${configPath}: ${msg}`, 1);
    }

    if (json) {
      printJson({
        ok: true,
        configPath,
        serverUrl: target.serverUrl,
        hostname: host,
        apiKeyMasked: maskSecret(apiKey),
      });
      return;
    }
    console.log(`registered ${host} → ${target.serverUrl}`);
    console.log(`wrote ${configPath} (apiKey=${maskSecret(apiKey)})`);
    console.log("next: run `lamasync doctor` to verify connectivity");
  } catch (err) {
    throw wrapApiError(err, "register");
  }
}

/** Re-exported for unit tests so they can drive the helpers without
 *  touching the network. */
export const __registerHelpersForTests = {
  resolveServerUrl,
  looksLikePairingCode,
  normalizeCode,
  friendlyPairingError,
  exitCodeForStatus,
};
