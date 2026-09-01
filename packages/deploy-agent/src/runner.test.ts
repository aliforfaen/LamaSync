// LAMA-301: deploy-agent runner tests with injected process spawners and
// health probes. No real processes, no network.

import { describe, expect, test } from "bun:test";
import {
  capDeployOutputTail,
  scrubDeployOutput,
  DEPLOY_OUTPUT_TAIL_CAP,
} from "@lamasync/core";
import {
  detectStage,
  runDeployScript,
  type DeployProcess,
  type DeployProcessSpawner,
} from "./runner.ts";

async function* streamOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c;
}

function scriptProcess(
  stdoutText: string,
  exitCode = 0,
  opts: { stderrText?: string; delayMs?: number } = {},
): DeployProcess {
  const encoder = new TextEncoder();
  return {
    exited: new Promise<number>((resolve) => {
      setTimeout(() => resolve(exitCode), opts.delayMs ?? 0);
    }),
    stdout: streamOf(encoder.encode(stdoutText)),
    stderr: streamOf(encoder.encode(opts.stderrText ?? "")),
  };
}

function spawner(result: () => DeployProcess, capture?: string[][]): DeployProcessSpawner {
  return (opts) => {
    capture?.push([opts.scriptPath]);
    return result();
  };
}

const BASE = {
  scriptPath: "/home/messhias/lamasync/update.sh",
  workDir: "/home/messhias/lamasync",
  serverUrl: "http://127.0.0.1:8080",
  healthToken: "lmsk.testkey.secretvalue",
};

describe("runDeployScript", () => {
  test("success: script exits 0 and health restores", async () => {
    const stages: (string | null)[] = [];
    const outcome = await runDeployScript({
      ...BASE,
      spawn: spawner(() =>
        scriptProcess("Image ghcr.io/... Pulled\ndocker compose up -d\nrecreating container\n"),
      ),
      probe: async () => true,
      onProgress: async (stage) => {
        stages.push(stage);
      },
      flushIntervalMs: 0,
      sleep: async () => {},
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.healthRestored).toBe(true);
    expect(outcome.summary).toContain("exited 0");
    expect(stages).toContain("pulling");
    expect(stages).toContain("recreating");
  });

  test("script failure: non-zero exit → failed outcome with exit code", async () => {
    const outcome = await runDeployScript({
      ...BASE,
      spawn: spawner(() => scriptProcess("compose pull failed", 18, { stderrText: "err" })),
      probe: async () => true,
      flushIntervalMs: 0,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(18);
    expect(outcome.summary).toContain("exited 18");
    expect(outcome.outputTail).toContain("compose pull failed");
  });

  test("health timeout: exit 0 but API never returns → failed", async () => {
    const outcome = await runDeployScript({
      ...BASE,
      spawn: spawner(() => scriptProcess("done", 0)),
      probe: async () => false,
      healthTimeoutMs: 100,
      sleep: async () => {},
      flushIntervalMs: 0,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.healthRestored).toBe(false);
    expect(outcome.summary).toContain("did not return to health");
  });

  test("health restored after downtime: probe fails then succeeds (exponential backoff loop)", async () => {
    let probes = 0;
    const outcome = await runDeployScript({
      ...BASE,
      spawn: spawner(() => scriptProcess("ok", 0)),
      probe: async () => {
        probes++;
        return probes >= 3;
      },
      healthTimeoutMs: 60_000,
      sleep: async () => {},
      flushIntervalMs: 0,
    });
    expect(outcome.ok).toBe(true);
    expect(probes).toBe(3);
  });

  test("spawner always receives the fixed script path with no arguments", async () => {
    const argvs: string[][] = [];
    await runDeployScript({
      ...BASE,
      spawn: spawner(() => scriptProcess("", 0), argvs),
      probe: async () => true,
      flushIntervalMs: 0,
    });
    expect(argvs).toEqual([["/home/messhias/lamasync/update.sh"]]);
  });

  test("output is scrubbed before onProgress sees it", async () => {
    let seen = "";
    await runDeployScript({
      ...BASE,
      spawn: spawner(() =>
        scriptProcess("pulling\nLAMASYNC_DEPLOY_API_KEY=lmsk.AaBbCcDdEeFf.supersecret\n", 0),
      ),
      probe: async () => true,
      onProgress: async (_stage, output) => {
        seen = output;
      },
      flushIntervalMs: 0,
    });
    expect(seen).not.toContain("supersecret");
    expect(seen).toContain("[redacted]");
  });

  test("output tail is capped", async () => {
    const outcome = await runDeployScript({
      ...BASE,
      spawn: spawner(() => scriptProcess("x".repeat(DEPLOY_OUTPUT_TAIL_CAP + 2000), 0)),
      probe: async () => true,
      flushIntervalMs: 0,
    });
    expect(outcome.outputTail.length).toBeLessThanOrEqual(DEPLOY_OUTPUT_TAIL_CAP + 20);
  });
});

describe("detectStage", () => {
  test("maps update.sh output to deploy stages", () => {
    expect(detectStage("docker compose pull lamasync-server Pulled")).toBe("pulling");
    expect(detectStage("Building image from local source")).toBe("building");
    expect(detectStage("Recreating container lamasync-server")).toBe("recreating");
    expect(detectStage("waiting for container healthy")).toBe("waiting for health");
    expect(detectStage("git pull --ff-only done")).toBeNull();
  });
});

describe("scrub/cap shared module", () => {
  test("cap keeps the tail and marks truncation", () => {
    const capped = capDeployOutputTail("a".repeat(DEPLOY_OUTPUT_TAIL_CAP + 10));
    expect(capped.startsWith("[…truncated…]")).toBe(true);
  });
  test("scrubDeployOutput redacts bearer tokens", () => {
    expect(scrubDeployOutput("Authorization: Bearer abc.def.ghi")).toBe("Authorization: [redacted]");
  });
});
