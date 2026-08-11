/**
 * `lamasync doctor` — structured health report.
 *
 * Checks run in order:
 *   1. env vars (LAMASYNC_SERVER_URL + LAMASYNC_API_KEY)
 *   2. auth source + MASKED key preview
 *   3. server reachability (GET /health) and round-trip latency
 *   4. daemon Unix socket probe (defaultSocketPath from @lamasync/core)
 *   5. binary vs latest release drift via GitHub Releases
 *
 * Exit non-zero when any check has `ok = false`. JSON output preserves
 * the raw shape so the agent skill's drift-check can correlate against
 * the same numbers (LAMA-230).
 *
 * Note on the GitHub fetch: matches `packages/daemon/src/self-update.ts`'s
 * shape but does NOT import from `@lamasync/daemon` (cross-package
 * dependency). The release payload format is a stable public API.
 */

import { existsSync } from "fs";
import { connect } from "node:net";
import { isNewer, VERSION, defaultSocketPath } from "@lamasync/core";

import { asApiError, type CliClient } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { maskSecret, printJson, printTable } from "./output.ts";



interface CheckBundle {
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  ok: boolean;
}

const GITHUB_API =
  "https://api.github.com/repos/aliforfaen/LamaSync/releases/latest";

interface GithubRelease {
  tag_name?: string;
  published_at?: string;
}

export async function run(ctx: CliContext): Promise<void> {
  const { client, json } = ctx;
  const checks: CheckBundle["checks"] = [];

  // 1. Env vars
  const envUrl = process.env.LAMASYNC_SERVER_URL;
  const envKey = process.env.LAMASYNC_API_KEY;
  checks.push({
    name: "env: LAMASYNC_SERVER_URL",
    ok: typeof envUrl === "string" && envUrl.length > 0,
    detail: envUrl ? envUrl : "(not set)",
  });
  checks.push({
    name: "env: LAMASYNC_API_KEY",
    ok: typeof envKey === "string" && envKey.length > 0,
    detail: envKey ? maskSecret(envKey) : "(not set)",
  });

  // 2. Auth source + masked key
  checks.push({
    name: "auth: source",
    ok: client.source !== "default",
    detail:
      client.source === "flag"
        ? "flag (--server/--api-key)"
        : client.source === "env"
          ? "env (LAMASYNC_*)"
          : client.source === "config"
            ? `config (${client.hostname})`
            : "default (localhost/dev-key) — needsSetup",
  });
  checks.push({
    name: "auth: masked key",
    ok: client.source !== "default",
    detail: client.maskedKey,
  });

  // 3. Server reachability
  const serverCheck = await checkServer(client);
  checks.push(serverCheck);

  // 4. Daemon socket probe
  checks.push(await checkSocket());

  // 5. Version drift
  checks.push(await checkVersionDrift());

  const ok = checks.every((c) => c.ok);
  if (json) {
    printJson({ ok, checks });
  } else {
    printTable(
      [
        { header: "CHECK", key: "CHECK" },
        { header: "RESULT", key: "RESULT" },
        { header: "DETAIL", key: "DETAIL" },
      ],
      checks.map<Record<string, string>>((c) => ({
        CHECK: c.name,
        RESULT: c.ok ? "OK" : "FAIL",
        DETAIL: c.detail,
      })),
    );
    console.log("");
    console.log(ok ? "doctor: all checks passed" : "doctor: one or more checks failed");
  }
  if (!ok) process.exit(1);
}

async function checkServer(client: CliClient): Promise<CheckBundle["checks"][number]> {
  if (client.source === "default") {
    return {
      name: "server: reachability",
      ok: false,
      detail: `(no config; would default to ${client.serverUrl})`,
    };
  }
  const t0 = Date.now();
  try {
    const health = await client.client.getHealth();
    return {
      name: "server: reachability",
      ok: health.status === "ok",
      detail: `${client.serverUrl} (${health.hostCount} hosts, ${Date.now() - t0}ms)`,
    };
  } catch (err) {
    const apiErr = asApiError(err);
    const message = apiErr ? apiErr.message : err instanceof Error ? err.message : String(err);
    return {
      name: "server: reachability",
      ok: false,
      detail: `${client.serverUrl} (${message})`,
    };
  }
}

async function checkSocket(): Promise<CheckBundle["checks"][number]> {
  const socketPath = defaultSocketPath();
  if (!existsSync(socketPath)) {
    return {
      name: "socket: daemon",
      ok: false,
      detail: `${socketPath} (not present)`,
    };
  }
  // Best-effort connect: a listener on the path means the daemon is alive.
  // We don't send/receive a real request because the doctor is meant to be
  // informative even if the protocol handlers are flaky.
  return new Promise((resolve) => {
    const sock = connect(socketPath);
    const settle = (ok: boolean, extra: string): void => {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      resolve({
        name: "socket: daemon",
        ok,
        detail: `${socketPath} (${extra})`,
      });
    };
    sock.once("connect", () => settle(true, "connect OK"));
    sock.once("error", (err: NodeJS.ErrnoException) =>
      settle(false, `error: ${err.code ?? err.message}`),
    );
    setTimeout(() => settle(false, "timeout"), 2000);
  });
}

interface GithubAsset {
  name?: string;
}

interface GithubReleaseShape {
  tag_name?: string;
  published_at?: string;
  assets?: GithubAsset[];
}

async function checkVersionDrift(): Promise<CheckBundle["checks"][number]> {
  try {
    const res = await fetch(GITHUB_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `lamasync/${VERSION}` },
    });
    if (!res.ok) {
      return {
        name: "release: drift vs GitHub latest",
        ok: false,
        detail: `GitHub responded ${res.status}`,
      };
    }
    const json = (await res.json()) as GithubReleaseShape;
    const tag = json.tag_name;
    if (typeof tag !== "string") {
      return {
        name: "release: drift vs GitHub latest",
        ok: false,
        detail: "GitHub payload missing tag_name",
      };
    }
    const version = tag.startsWith("v") ? tag.slice(1) : tag;
    if (isNewer(VERSION, version)) {
      return {
        name: "release: drift vs GitHub latest",
        ok: false,
        detail: `current=${VERSION} latest=${version} (update available)`,
      };
    }
    return {
      name: "release: drift vs GitHub latest",
      ok: true,
      detail: `current=${VERSION} latest=${version}`,
    };
  } catch (err) {
    return {
      name: "release: drift vs GitHub latest",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
