// LAMA-301: manual production server deploy routes.
//
// Security model (hard boundary — see the handoff + docs/prod-deploy.md):
//   - the lamasync-server container NEVER receives /var/run/docker.sock,
//     host SSH credentials, privileged mode, or a shell-execution endpoint.
//     This job model is the entire deploy surface;
//   - the LXC-resident deploy agent (systemd service, dedicated `deploy`
//     credential) claims jobs and runs the FIXED update script with no
//     arguments and a fixed working directory;
//   - admin/master credentials may request and read jobs; a `deploy`
//     principal may only claim/progress/complete them; device keys are
//     blocked at the auth boundary;
//   - only one active (pending/running) production job may exist;
//   - all reported output passes the scrubber and a 16 KiB tail cap.

import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import {
  type ServerDeployJob,
  type ServerDeployStatus,
  type WSEvent,
} from "@lamasync/core";
import { broadcast } from "../ws.ts";
import { principalOf, requireAdmin, requireDeployAgent } from "../auth.ts";
import {
  DEPLOY_OUTPUT_TAIL_CAP,
  capDeployOutputTail,
  scrubDeployOutput,
} from "@lamasync/core";

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

/** Feature gate: deploy jobs may only be created when explicitly enabled. */
export function deployAgentEnabled(): boolean {
  const raw = (process.env.LAMASYNC_DEPLOY_AGENT_ENABLED ?? "").toLowerCase();
  return raw === "true" || raw === "1";
}

const HISTORY_LIMIT = 25;
const HISTORY_MAX_LIMIT = 100;
// A deploy agent that died mid-run leaves a 'running' job. The script
// timeout is 10 min + bounded health wait; after 15 min the job is
// reclaimable, mirroring the stale-'taken' daemon action recovery.
export const STALE_RUNNING_MS = 15 * 60_000;

interface DeployRow {
  id: string;
  requested_at: number;
  requested_by: string | null;
  status: string;
  started_at: number | null;
  completed_at: number | null;
  target: string;
  summary: string | null;
  output_tail: string | null;
}

const DEPLOY_SELECT =
  "SELECT id, requested_at, requested_by, status, started_at, completed_at, target, summary, output_tail FROM server_deploy_jobs";

function rowToJob(row: DeployRow): ServerDeployJob {
  return {
    id: row.id,
    requestedAt: row.requested_at,
    requestedBy: row.requested_by,
    status: row.status as ServerDeployStatus,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    target: "production",
    summary: row.summary,
    outputTail: row.output_tail,
  };
}

function jobById(id: string): ServerDeployJob | null {
  const row = activeDb.query<DeployRow, [string]>(`${DEPLOY_SELECT} WHERE id = ?`).get(id);
  return row ? rowToJob(row) : null;
}

function jobByStatus(status: string): ServerDeployJob | null {
  const row = activeDb
    .query<DeployRow, [string]>(
      `${DEPLOY_SELECT} WHERE status = ? ORDER BY requested_at DESC LIMIT 1`,
    )
    .get(status);
  return row ? rowToJob(row) : null;
}

function broadcastJob(job: ServerDeployJob): void {
  const event: WSEvent = { kind: "server_deploy", job };
  broadcast(event);
}

/** Flip stale 'running' rows (agent died) back to 'pending'. */
export function reapStaleRunningDeploys(database: Database = activeDb): number {
  const cutoff = Date.now() - STALE_RUNNING_MS;
  const result = database.run(
    `UPDATE server_deploy_jobs
       SET status = 'pending', started_at = NULL
       WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?`,
    [cutoff],
  );
  return Number(result.changes ?? 0);
}

function trimHistory(): void {
  activeDb.run(
    `DELETE FROM server_deploy_jobs WHERE id NOT IN (
       SELECT id FROM server_deploy_jobs ORDER BY requested_at DESC LIMIT ?
     )`,
    [HISTORY_LIMIT],
  );
}

/** Human-readable requester label (managed-key name + id); never a secret. */
function requesterLabel(keyId: string): string {
  const row = activeDb
    .query<{ name: string }, [string]>("SELECT name FROM api_keys WHERE id = ?")
    .get(keyId);
  return row ? `${row.name} (${keyId})` : keyId;
}

function requireAdminPrincipal(
  store: unknown,
  set: { status?: unknown },
): ReturnType<typeof requireAdmin> {
  const principal = requireAdmin({ principal: principalOf(store) });
  if (!principal) set.status = 403;
  return principal;
}

export const serverDeployRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/server-deploys/config",
    ({ store, set }) => {
      if (!requireAdminPrincipal(store, set)) return;
      return { enabled: deployAgentEnabled() };
    },
    {
      detail: {
        summary: "Whether server-deploy jobs are enabled on this server",
        tags: ["Server Deploys"],
        responses: {
          200: { description: "Deploy capability flag" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/server-deploys/pending",
    ({ store, set }) => {
      if (!requireDeployAgent({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      reapStaleRunningDeploys();
      const job = jobByStatus("pending");
      return { job }; // job: null when nothing to do
    },
    {
      detail: {
        summary: "Deploy agent: peek at the pending production job ({ job: null } when none)",
        tags: ["Server Deploys"],
        responses: {
          200: { description: "Pending job or null" },
          401: { description: "Unauthorized" },
          403: { description: "Deploy credential required" },
        },
      },
    },
  )
  .post(
    "/server-deploys",
    ({ store, set }) => {
      if (!requireAdminPrincipal(store, set)) return;
      if (!deployAgentEnabled()) {
        set.status = 409;
        return {
          error:
            "manual deploy only — the deploy agent is not configured on this server (LAMASYNC_DEPLOY_AGENT_ENABLED)",
        };
      }
      reapStaleRunningDeploys();
      const existing = jobByStatus("pending") ?? jobByStatus("running");
      if (existing) {
        set.status = 200;
        return existing;
      }
      const principal = requireAdminPrincipal(store, set);
      const id = crypto.randomUUID();
      const now = Date.now();
      activeDb.run(
        `INSERT INTO server_deploy_jobs
           (id, requested_at, requested_by, status, target)
         VALUES (?, ?, ?, 'pending', 'production')`,
        [id, now, principal ? requesterLabel(principal.keyId ?? "master") : null],
      );
      trimHistory();
      const job = jobById(id)!;
      broadcastJob(job);
      set.status = 201;
      return job;
    },
    {
      detail: {
        summary:
          "Request a production server deploy (returns the existing active job on duplicate clicks)",
        tags: ["Server Deploys"],
        responses: {
          201: { description: "Deploy job created" },
          200: { description: "An active deploy job already exists — returned instead" },
          401: { description: "Unauthorized" },
          403: { description: "Device keys cannot deploy" },
          409: { description: "Deploy agent not configured (manual deploy only)" },
        },
      },
    },
  )
  .get(
    "/server-deploys",
    ({ store, set, query }) => {
      if (!requireAdminPrincipal(store, set)) return;
      reapStaleRunningDeploys();
      const requestedRaw = (query as { limit?: number | string }).limit;
      const requested =
        typeof requestedRaw === "number"
          ? requestedRaw
          : requestedRaw
            ? Number.parseInt(requestedRaw, 10)
            : HISTORY_LIMIT;
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(1, requested), HISTORY_MAX_LIMIT)
        : HISTORY_LIMIT;
      const rows = activeDb
        .query<DeployRow, [number]>(
          `${DEPLOY_SELECT} ORDER BY requested_at DESC LIMIT ?`,
        )
        .all(limit);
      return rows.map(rowToJob);
    },
    {
      query: t.Object({ limit: t.Optional(t.Union([t.Number(), t.String()])) }),
      detail: {
        summary: "Recent production deploy history, newest first",
        tags: ["Server Deploys"],
        responses: {
          200: { description: "Deploy job history" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/server-deploys/:id",
    ({ store, set, params }) => {
      if (!requireAdminPrincipal(store, set)) return;
      const job = jobById(params.id);
      if (!job) {
        set.status = 404;
        return { error: "Deploy job not found" };
      }
      return job;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary: "Deploy job status/output tail",
        tags: ["Server Deploys"],
        responses: {
          200: { description: "Deploy job" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/server-deploys/:id/claim",
    ({ store, set, params }) => {
      if (!requireDeployAgent({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      // Atomic claim: exactly one agent invocation can flip pending → running.
      const now = Date.now();
      const result = activeDb.run(
        `UPDATE server_deploy_jobs
           SET status = 'running', started_at = ?
         WHERE id = ? AND status = 'pending'`,
        [now, params.id],
      );
      if (Number(result.changes ?? 0) === 0) {
        set.status = 409;
        return { error: "Deploy job is not claimable (not pending)" };
      }
      const job = jobById(params.id)!;
      broadcastJob(job);
      return job;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary: "Deploy agent: atomically claim a pending job (pending → running)",
        tags: ["Server Deploys"],
        responses: {
          200: { description: "Claimed" },
          404: { description: "Not found" },
          409: { description: "Job is not pending (already claimed/completed)" },
          401: { description: "Unauthorized" },
          403: { description: "Deploy credential required" },
        },
      },
    },
  )
  .post(
    "/server-deploys/:id/progress",
    ({ store, set, params, body }) => {
      if (!requireDeployAgent({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const job = jobById(params.id);
      if (!job) {
        set.status = 404;
        return { error: "Deploy job not found" };
      }
      if (job.status !== "running") {
        set.status = 409;
        return { error: `Deploy job is ${job.status}, not running` };
      }
      // Scrub + cap server-side: the persisted audit trail is the boundary,
      // regardless of what the agent sent.
      const stage = body.stage ? scrubDeployOutput(body.stage).slice(0, 200) : null;
      const appended = body.output ? scrubDeployOutput(body.output) : "";
      const merged = capDeployOutputTail(
        `${job.outputTail ?? ""}${appended}`,
        DEPLOY_OUTPUT_TAIL_CAP,
      );
      activeDb.run(
        `UPDATE server_deploy_jobs SET summary = ?, output_tail = ? WHERE id = ?`,
        [stage ?? job.summary, merged, params.id],
      );
      const updated = jobById(params.id)!;
      broadcastJob(updated);
      return updated;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        stage: t.Optional(t.Union([t.String(), t.Null()])),
        output: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary: "Deploy agent: stage/output update (scrubbed + capped server-side)",
        tags: ["Server Deploys"],
        responses: {
          200: { description: "Progress recorded" },
          404: { description: "Not found" },
          409: { description: "Job is not running" },
          401: { description: "Unauthorized" },
          403: { description: "Deploy credential required" },
        },
      },
    },
  )
  .post(
    "/server-deploys/:id/complete",
    ({ store, set, params, body }) => {
      if (!requireDeployAgent({ principal: principalOf(store) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const job = jobById(params.id);
      if (!job) {
        set.status = 404;
        return { error: "Deploy job not found" };
      }
      if (job.status !== "running" && job.status !== "pending") {
        set.status = 409;
        return { error: `Deploy job already ${job.status}` };
      }
      const now = Date.now();
      const summary = body.summary
        ? scrubDeployOutput(body.summary).slice(0, 500)
        : null;
      const output = body.output
        ? capDeployOutputTail(scrubDeployOutput(body.output), DEPLOY_OUTPUT_TAIL_CAP)
        : job.outputTail;
      activeDb.run(
        `UPDATE server_deploy_jobs
           SET status = ?, completed_at = ?, summary = ?, output_tail = ?
         WHERE id = ?`,
        [body.status, now, summary ?? job.summary, output, params.id],
      );
      const updated = jobById(params.id)!;
      broadcastJob(updated);
      return updated;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        status: t.Union([t.Literal("succeeded"), t.Literal("failed")]),
        summary: t.Optional(t.Union([t.String(), t.Null()])),
        output: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary: "Deploy agent: record terminal success/failure",
        tags: ["Server Deploys"],
        responses: {
          200: { description: "Completion recorded" },
          404: { description: "Not found" },
          409: { description: "Job already terminal" },
          401: { description: "Unauthorized" },
          403: { description: "Deploy credential required" },
        },
      },
    },
  );
