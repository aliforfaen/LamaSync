// LAMA-301: pure view-model for the Admin "Server deployment" card.
// Every card state (unconfigured / no-jobs / active / succeeded / failed)
// is derived here so it can be unit-tested without rendering React.
import type { ServerDeployJob } from "@lamasync/core";

export interface DeployCardState {
  kind: "unconfigured" | "no-jobs" | "active" | "succeeded" | "failed";
  headline: string;
  detail: string | null;
  /** Deploy button availability. Active jobs disable the button — a
   *  second click can never create a second deployment (the server
   *  additionally coalesces duplicates to the active job). */
  canRequest: boolean;
  requestLabel: string;
  activeJob: ServerDeployJob | null;
  lastJob: ServerDeployJob | null;
}

export function activeDeployJob(jobs: readonly ServerDeployJob[]): ServerDeployJob | null {
  return (
    jobs.find((j) => j.status === "pending" || j.status === "running") ?? null
  );
}

export function deployCardState(
  enabled: boolean,
  jobs: readonly ServerDeployJob[],
): DeployCardState {
  if (!enabled) {
    return {
      kind: "unconfigured",
      headline: "manual deploy only",
      detail:
        "No deploy agent is configured for this server. Deploy over SSH with the " +
        "documented update command (see docs/prod-deploy.md), or set " +
        "LAMASYNC_DEPLOY_AGENT_ENABLED=true and provision the agent to enable this control.",
      canRequest: false,
      requestLabel: "",
      activeJob: null,
      lastJob: null,
    };
  }

  const active = activeDeployJob(jobs);
  if (active) {
    return {
      kind: "active",
      headline: `deployment ${active.status}`,
      detail: active.summary,
      canRequest: false,
      requestLabel: "Deploying…",
      activeJob: active,
      lastJob: null,
    };
  }

  const last = jobs[0] ?? null;
  if (last?.status === "failed") {
    return {
      kind: "failed",
      headline: "last deployment failed",
      detail: last.summary ?? "the deploy agent reported a failure — see the output tail",
      canRequest: true,
      requestLabel: "Retry deployment",
      activeJob: null,
      lastJob: last,
    };
  }
  if (last?.status === "succeeded") {
    return {
      kind: "succeeded",
      headline: "last deployment succeeded",
      detail: last.summary,
      canRequest: true,
      requestLabel: "Deploy latest server image",
      activeJob: null,
      lastJob: last,
    };
  }
  return {
    kind: "no-jobs",
    headline: "no deployments recorded",
    detail: null,
    canRequest: true,
    requestLabel: "Deploy latest server image",
    activeJob: null,
    lastJob: last,
  };
}

/** Human-readable stage line for an active job (its `summary` field). */
export function deployStageLabel(job: ServerDeployJob): string {
  if (job.status === "pending") return "queued — waiting for the deploy agent";
  return job.summary ?? "running";
}
