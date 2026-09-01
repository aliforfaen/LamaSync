// LAMA-301: lamasync-deploy-agent — LXC-resident production deploy runner.
//
// Polls the LamaSync API for pending server-deploy jobs using a dedicated
// `deploy` credential, claims one atomically, executes the FIXED update
// script (compiled-in path, no arguments, fixed working directory), and
// reports sanitized/capped progress + completion. It owns NO daemon
// responsibilities, holds NO docker socket, and accepts NO job-carried
// commands — see docs/prod-deploy.md for the security model.
//
// Configuration (environment):
//   LAMASYNC_SERVER_URL              LamaSync API base URL (required)
//   LAMASYNC_DEPLOY_API_KEY          deploy credential (required; lmsk.…)
//   LAMASYNC_DEPLOY_SCRIPT           fixed script path
//                                    (default /home/messhias/lamasync/update.sh)
//   LAMASYNC_DEPLOY_WORKDIR          fixed working directory
//                                    (default /home/messhias/lamasync)
//   LAMASYNC_DEPLOY_POLL_MS          poll interval (default 15000)
//   LAMASYNC_DEPLOY_SCRIPT_TIMEOUT_MS   script timeout (default 600000)
//   LAMASYNC_DEPLOY_HEALTH_TIMEOUT_MS   health wait (default 240000)

import { accessSync, constants, statSync } from "node:fs";
import {
  LamaSyncApiClient,
  VERSION,
  type ServerDeployJob,
} from "@lamasync/core";
import {
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  runDeployScript,
  type DeployRunOutcome,
} from "./runner.ts";

const DEFAULT_SCRIPT_PATH = "/home/messhias/lamasync/update.sh";
const DEFAULT_WORK_DIR = "/home/messhias/lamasync";
const DEFAULT_POLL_MS = 15_000;

interface AgentConfig {
  serverUrl: string;
  apiKey: string;
  scriptPath: string;
  workDir: string;
  pollMs: number;
  scriptTimeoutMs: number;
  healthTimeoutMs: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadConfig(): AgentConfig | null {
  const serverUrl = (process.env.LAMASYNC_SERVER_URL ?? "").replace(/\/+$/, "");
  const apiKey = process.env.LAMASYNC_DEPLOY_API_KEY ?? "";
  if (!serverUrl || !apiKey) {
    console.error(
      "[deploy-agent] FATAL: LAMASYNC_SERVER_URL and LAMASYNC_DEPLOY_API_KEY are required",
    );
    return null;
  }
  return {
    serverUrl,
    apiKey,
    scriptPath: process.env.LAMASYNC_DEPLOY_SCRIPT ?? DEFAULT_SCRIPT_PATH,
    workDir: process.env.LAMASYNC_DEPLOY_WORKDIR ?? DEFAULT_WORK_DIR,
    pollMs: intEnv("LAMASYNC_DEPLOY_POLL_MS", DEFAULT_POLL_MS),
    scriptTimeoutMs: intEnv("LAMASYNC_DEPLOY_SCRIPT_TIMEOUT_MS", DEFAULT_SCRIPT_TIMEOUT_MS),
    healthTimeoutMs: intEnv("LAMASYNC_DEPLOY_HEALTH_TIMEOUT_MS", DEFAULT_HEALTH_TIMEOUT_MS),
  };
}

export interface EnvironmentProblems {
  ok: boolean;
  problems: string[];
}

/**
 * Boot-time validation of the fixed script path, working directory, and
 * Docker availability. An agent with an invalid environment refuses to
 * claim jobs and reports itself unavailable (repeatedly, rate-limited to
 * once per state change) so the operator sees exactly what is missing.
 */
export async function validateEnvironment(config: AgentConfig): Promise<EnvironmentProblems> {
  const problems: string[] = [];
  // Script must exist, be a regular file, and be executable.
  try {
    if (!statSync(config.scriptPath).isFile()) {
      problems.push(`script is not a regular file: ${config.scriptPath}`);
    }
  } catch {
    problems.push(`script missing: ${config.scriptPath}`);
  }
  try {
    accessSync(config.scriptPath, constants.X_OK);
  } catch {
    problems.push(`script not executable: ${config.scriptPath}`);
  }
  try {
    if (!statSync(config.workDir).isDirectory()) {
      problems.push(`working directory is not a directory: ${config.workDir}`);
    }
  } catch {
    problems.push(`working directory missing: ${config.workDir}`);
  }
  if (!Bun.which("docker")) {
    problems.push("docker not on PATH — update.sh pull/build will fail");
  }
  return { ok: problems.length === 0, problems };
}

/** POST a terminal completion with bounded retries (the API may still be
 *  settling right after the container recreation the deploy itself caused). */
async function completeWithRetry(
  client: LamaSyncApiClient,
  jobId: string,
  body: { status: "succeeded" | "failed"; summary: string; output: string },
  attempts = 10,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await client.completeServerDeploy(jobId, body);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[deploy-agent] complete attempt ${i + 1}/${attempts} failed: ${msg}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  console.error(
    `[deploy-agent] could not persist completion for job ${jobId} — the job will be reclaimed as stale`,
  );
}

async function processJob(
  client: LamaSyncApiClient,
  config: AgentConfig,
  job: ServerDeployJob,
): Promise<void> {
  let claimed: ServerDeployJob;
  try {
    claimed = await client.claimServerDeploy(job.id);
  } catch (err) {
    // 409 = someone else claimed it; anything else is logged for retry.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[deploy-agent] claim ${job.id} failed: ${msg}`);
    return;
  }
  console.log(
    `[deploy-agent] claimed job ${claimed.id} (requested by ${claimed.requestedBy ?? "unknown"}); running ${config.scriptPath}`,
  );

  const outcome: DeployRunOutcome = await runDeployScript({
    scriptPath: config.scriptPath,
    workDir: config.workDir,
    scriptTimeoutMs: config.scriptTimeoutMs,
    healthTimeoutMs: config.healthTimeoutMs,
    serverUrl: config.serverUrl,
    healthToken: config.apiKey,
    onProgress: async (stage, output) => {
      try {
        await client.updateServerDeployProgress(claimed.id, { stage, output });
      } catch {
        // Server likely mid-restart; the terminal completion below retries.
      }
    },
  });

  console.log(`[deploy-agent] job ${claimed.id}: ${outcome.summary}`);
  await completeWithRetry(client, claimed.id, {
    status: outcome.ok ? "succeeded" : "failed",
    summary: outcome.summary,
    output: outcome.outputTail,
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--version") || process.argv.includes("-V")) {
    console.log(`lamasync-deploy-agent ${VERSION}`);
    process.exit(0);
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`lamasync-deploy-agent — LAMA-301 production deploy runner

Polls the LamaSync API for pending server-deploy jobs, runs the FIXED
update script (no arguments, fixed working directory), waits for API
health, and records a terminal result. Configuration is environment-only:
  LAMASYNC_SERVER_URL, LAMASYNC_DEPLOY_API_KEY,
  LAMASYNC_DEPLOY_SCRIPT, LAMASYNC_DEPLOY_WORKDIR,
  LAMASYNC_DEPLOY_POLL_MS, LAMASYNC_DEPLOY_SCRIPT_TIMEOUT_MS,
  LAMASYNC_DEPLOY_HEALTH_TIMEOUT_MS`);
    process.exit(0);
  }

  const config = loadConfig();
  if (!config) process.exit(1);

  console.log(
    `[deploy-agent] starting script=${config.scriptPath} workdir=${config.workDir} poll=${config.pollMs}ms`,
  );
  const client = new LamaSyncApiClient(config.serverUrl, config.apiKey);

  let envOk: boolean | null = null;
  const checkEnvironment = async (): Promise<void> => {
    const result = await validateEnvironment(config);
    if (result.ok !== envOk) {
      envOk = result.ok;
      if (!result.ok) {
        console.error(
          `[deploy-agent] UNAVAILABLE — refusing to claim jobs until fixed: ${result.problems.join("; ")}`,
        );
      } else {
        console.log("[deploy-agent] environment validated; claiming enabled");
      }
    }
  };
  await checkEnvironment();

  // Re-validate the environment at a slow cadence so a fixed environment
  // (missing script restored, docker installed) recovers without a restart.
  const envTimer = setInterval(() => void checkEnvironment(), 60_000);
  envTimer.unref?.();

  let busy = false;
  const poll = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      if (envOk === false) return;
      const pending = await client.getPendingServerDeploy();
      if (pending) await processJob(client, config, pending);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[deploy-agent] poll failed: ${msg}`);
    } finally {
      busy = false;
    }
  };

  void poll();
  const pollTimer = setInterval(() => void poll(), config.pollMs);
  // Keep the service process alive. The environment recheck timer is safely
  // unreferenced above, but the polling loop is the agent's primary work.
  // If this timer is unreferenced too, a compiled Bun binary exits cleanly
  // immediately after boot before it can claim a deploy job.

  const shutdown = (signal: string): void => {
    console.log(`[deploy-agent] received ${signal}, shutting down`);
    clearInterval(pollTimer);
    clearInterval(envTimer);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise<void>(() => {});
}

if (import.meta.main) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`lamasync-deploy-agent fatal: ${msg}`);
    process.exit(1);
  });
}
