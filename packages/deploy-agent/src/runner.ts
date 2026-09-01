// LAMA-301: deploy-agent execution core.
//
// The agent is an LXC-resident systemd service with a dedicated, narrowly
// scoped `deploy` credential. It executes EXACTLY ONE allowlisted script —
// the fixed absolute path compiled into its configuration, with no user
// arguments and a fixed working directory — and reports sanitized, capped
// progress + completion to the normal LamaSync API.
//
// Security invariants (enforced by construction here):
//   - no argv, script path, image ref, or working directory is ever taken
//     from the server or the job payload; the job model carries no
//     command fields at all;
//   - output is capped (final 16 KiB) and scrubbed server-side too —
//     this side scrubs so credentials never even transit the wire;
//   - after the script exits the agent waits for the server's health
//     endpoint (bounded exponential backoff) BEFORE completing the job,
//     because the deploy itself restarts the API. The SQLite volume
//     survives the container recreation, so the same job is completed
//     by the same agent after the API is back.

import { VERSION } from "@lamasync/core";
import { capDeployOutputTail, scrubDeployOutput } from "@lamasync/core";

export const DEPLOY_OUTPUT_CAP = 16 * 1024;
export const DEFAULT_SCRIPT_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_HEALTH_TIMEOUT_MS = 4 * 60_000;
export const DEFAULT_FLUSH_INTERVAL_MS = 2_000;

export interface DeployProcess {
  /** Resolves with the process exit code (killed processes included). */
  exited: Promise<number>;
  stdout: AsyncIterable<Uint8Array | string>;
  stderr: AsyncIterable<Uint8Array | string>;
}

/** The ONLY thing the agent ever executes: [scriptPath], nothing else. */
export type DeployProcessSpawner = (opts: {
  scriptPath: string;
  cwd: string;
  timeoutMs: number;
}) => DeployProcess;

export interface DeployRunDeps {
  scriptPath: string;
  workDir: string;
  scriptTimeoutMs?: number;
  healthTimeoutMs?: number;
  flushIntervalMs?: number;
  /** Base URL of the LamaSync API (health probe target). */
  serverUrl: string;
  /** Deploy credential — used only for the health probe bearer header. */
  healthToken: string;
  /** Injected process spawner (default: Bun.spawn of the fixed script). */
  spawn?: DeployProcessSpawner;
  /** Injected health probe (default: GET /api/v1/health with bearer). */
  probe?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Stage/output callback; receives already-scrubbed text. */
  onProgress?: (stage: string | null, output: string) => Promise<void> | void;
}

export interface DeployRunOutcome {
  ok: boolean;
  /** null when the process was killed by the timeout. */
  exitCode: number | null;
  timedOut: boolean;
  healthRestored: boolean;
  summary: string;
  outputTail: string;
}

/** Default spawner: Bun.spawn of the fixed script path — no arguments. */
export const defaultSpawn: DeployProcessSpawner = ({ scriptPath, cwd, timeoutMs }) => {
  const proc = Bun.spawn([scriptPath], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  return {
    exited: proc.exited,
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
  };
};

/** Default health probe: GET /api/v1/health with the deploy bearer token. */
export function defaultProbe(serverUrl: string, healthToken: string) {
  return async (url: string): Promise<boolean> => {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${healthToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  };
}

/** Ordered stage keyword detection over scrubbed output. */
export function detectStage(chunk: string): string | null {
  const lower = chunk.toLowerCase();
  if (lower.includes("pulling") || lower.includes("pulled") || lower.includes("pull complete") || lower.includes("compose pull")) {
    return "pulling";
  }
  if (lower.includes("building") || lower.includes("building image") || lower.includes("compose build")) {
    return "building";
  }
  if (lower.includes("recreat") || lower.includes("up -d") || lower.includes("starting container")) {
    return "recreating";
  }
  if (lower.includes("health") || lower.includes("healthy")) {
    return "waiting for health";
  }
  return null;
}

/**
 * Run the fixed deploy script and wait for API health. Never throws —
 * every failure mode lands in the structured outcome so the caller can
 * persist exactly one terminal completion.
 */
export async function runDeployScript(deps: DeployRunDeps): Promise<DeployRunOutcome> {
  const scriptTimeoutMs = deps.scriptTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  const healthTimeoutMs = deps.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const spawn = deps.spawn ?? defaultSpawn;
  const probe =
    deps.probe ?? defaultProbe(deps.serverUrl, deps.healthToken);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  const proc = spawn({
    scriptPath: deps.scriptPath,
    cwd: deps.workDir,
    timeoutMs: scriptTimeoutMs,
  });

  let output = "";
  let stage: string | null = null;
  let lastFlush = now();

  const flush = async (force: boolean): Promise<void> => {
    if (!deps.onProgress) return;
    if (!force && now() - lastFlush < flushIntervalMs) return;
    lastFlush = now();
    const tail = capDeployOutputTail(output, DEPLOY_OUTPUT_CAP);
    try {
      await deps.onProgress(stage, tail);
    } catch {
      // The server may be mid-restart; progress is best-effort. The
      // terminal completion below retries after health returns.
    }
  };

  const consume = async (stream: AsyncIterable<Uint8Array | string>): Promise<void> => {
    for await (const chunk of stream) {
      const text =
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      const scrubbed = scrubDeployOutput(text);
      output += scrubbed;
      output = capDeployOutputTail(output, DEPLOY_OUTPUT_CAP);
      // Stage detection is line-oriented so a chunk carrying several
      // stages (buffered pipe output) still advances in stream order;
      // each advance flushes immediately so the UI sees every stage.
      for (const line of scrubbed.split(/\r?\n/)) {
        const nextStage = detectStage(line);
        if (nextStage && nextStage !== stage) {
          stage = nextStage;
          await flush(true);
        }
      }
      await flush(false);
    }
  };

  const deadline = now() + scriptTimeoutMs;
  await Promise.all([consume(proc.stdout), consume(proc.stderr)]);
  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } catch (err) {
    return {
      ok: false,
      exitCode: null,
      timedOut: now() >= deadline,
      healthRestored: false,
      summary: `deploy script failed to run: ${err instanceof Error ? err.message : String(err)}`,
      outputTail: output,
    };
  }
  const timedOut = now() >= deadline && exitCode !== 0;
  await flush(true);

  if (exitCode !== 0) {
    return {
      ok: false,
      exitCode,
      timedOut,
      healthRestored: false,
      summary: timedOut
        ? `deploy script exceeded ${Math.round(scriptTimeoutMs / 1000)}s and was killed`
        : `deploy script exited ${exitCode}`,
      outputTail: output,
    };
  }

  // ---- wait for API health (bounded exponential backoff) ----
  const healthUrl = `${deps.serverUrl.replace(/\/+$/, "")}/api/v1/health`;
  const healthDeadline = now() + healthTimeoutMs;
  let delayMs = 1_000;
  let healthRestored = false;
  while (now() < healthDeadline) {
    if (await probe(healthUrl)) {
      healthRestored = true;
      break;
    }
    await sleep(Math.min(delayMs, 15_000));
    delayMs = Math.min(delayMs * 2, 15_000);
  }

  if (!healthRestored) {
    return {
      ok: false,
      exitCode,
      timedOut,
      healthRestored: false,
      summary: `deploy script exited 0 but the API did not return to health within ${Math.round(healthTimeoutMs / 1000)}s`,
      outputTail: output,
    };
  }

  return {
    ok: true,
    exitCode,
    timedOut: false,
    healthRestored: true,
    summary: "deploy script exited 0; API healthy after deploy",
    outputTail: output,
  };
}

/** Compile-time guard: version import stays used for --version output. */
export const AGENT_VERSION = VERSION;
