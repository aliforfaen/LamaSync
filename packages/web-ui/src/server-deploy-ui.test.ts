// LAMA-301: tests for the Admin deploy-card view-model.
import { describe, expect, test } from "bun:test";
import type { ServerDeployJob } from "@lamasync/core";
import { activeDeployJob, deployCardState, deployStageLabel } from "./server-deploy-ui.ts";

function job(over: Partial<ServerDeployJob> = {}): ServerDeployJob {
  return {
    id: "j1",
    requestedAt: 100,
    requestedBy: "ops (keyId)",
    status: "pending",
    startedAt: null,
    completedAt: null,
    target: "production",
    summary: null,
    outputTail: null,
    ...over,
  };
}

describe("deployCardState", () => {
  test("unconfigured → manual deploy only, no button", () => {
    const s = deployCardState(false, [job({ status: "succeeded" })]);
    expect(s.kind).toBe("unconfigured");
    expect(s.canRequest).toBe(false);
    expect(s.headline).toContain("manual deploy only");
    expect(s.detail).toContain("LAMASYNC_DEPLOY_AGENT_ENABLED");
  });

  test("configured with no history → request available", () => {
    const s = deployCardState(true, []);
    expect(s.kind).toBe("no-jobs");
    expect(s.canRequest).toBe(true);
    expect(s.requestLabel).toBe("Deploy latest server image");
  });

  test("pending job → active, button disabled (duplicate-click coalescing)", () => {
    const s = deployCardState(true, [job({ status: "pending" })]);
    expect(s.kind).toBe("active");
    expect(s.canRequest).toBe(false);
    expect(s.activeJob?.status).toBe("pending");
  });

  test("running job → active with stage label", () => {
    const s = deployCardState(true, [job({ status: "running", summary: "pulling" })]);
    expect(s.kind).toBe("active");
    expect(deployStageLabel(s.activeJob!)).toBe("pulling");
  });

  test("succeeded → retry available with result summary", () => {
    const s = deployCardState(true, [
      job({ status: "succeeded", summary: "deploy script exited 0; API healthy after deploy" }),
    ]);
    expect(s.kind).toBe("succeeded");
    expect(s.canRequest).toBe(true);
    expect(s.requestLabel).toBe("Deploy latest server image");
    expect(s.detail).toContain("API healthy");
  });

  test("failed → retry available, summary surfaced", () => {
    const s = deployCardState(true, [job({ status: "failed", summary: "deploy script exited 18" })]);
    expect(s.kind).toBe("failed");
    expect(s.canRequest).toBe(true);
    expect(s.requestLabel).toBe("Retry deployment");
    expect(s.detail).toContain("exited 18");
  });

  test("active job wins over a newer terminal row", () => {
    const s = deployCardState(true, [
      job({ id: "active", status: "running", requestedAt: 200 }),
      job({ id: "old", status: "succeeded", requestedAt: 100 }),
    ]);
    expect(s.kind).toBe("active");
    expect(s.activeJob?.id).toBe("active");
  });
});

describe("activeDeployJob", () => {
  test("returns the pending/running job or null", () => {
    expect(activeDeployJob([job({ status: "pending" })])?.status).toBe("pending");
    expect(activeDeployJob([job({ status: "failed" })])).toBeNull();
  });
});

describe("deployStageLabel", () => {
  test("queued vs running stages", () => {
    expect(deployStageLabel(job({ status: "pending" }))).toContain("queued");
    expect(deployStageLabel(job({ status: "running", summary: "recreating" }))).toBe("recreating");
  });
});
