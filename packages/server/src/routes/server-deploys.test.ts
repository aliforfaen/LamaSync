// LAMA-301: unit tests for the server-deploy routes + scrubber. Follows
// the __setDb in-memory-sqlite pattern used by the other route tests.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "server-deploys-test-master";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "server-deploys-test-secret-1234567890";
delete process.env.LAMASYNC_DEPLOY_AGENT_ENABLED;

const { getAuthPlugin } = await import("../auth.ts");
const { serverDeployRoutes, reapStaleRunningDeploys, STALE_RUNNING_MS, __setDb } =
  (await import("./server-deploys.ts")) as typeof import("./server-deploys.ts");
const { insertManagedApiKey } = await import("../api-keys.ts");
const { scrubDeployOutput, capDeployOutputTail, DEPLOY_OUTPUT_TAIL_CAP } = await import("@lamasync/core");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };
let deployToken: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // idempotent by design
    }
  }
  __setDb(db);
  delete process.env.LAMASYNC_DEPLOY_AGENT_ENABLED;
  const created = insertManagedApiKey({ name: "lxc deploy agent", kind: "deploy", hostId: null });
  deployToken = created.token;
  app = new Elysia().use(getAuthPlugin()).use(serverDeployRoutes);
});

afterEach(() => {
  db.close();
  delete process.env.LAMASYNC_DEPLOY_AGENT_ENABLED;
});

function request(path: string, init: RequestInit = {}, token?: string): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token ?? process.env.LAMASYNC_API_KEY}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function post(path: string, body: Record<string, unknown>, token?: string): Promise<Response> {
  return app.handle(request(path, { method: "POST", body: JSON.stringify(body) }, token));
}

function enableDeploy(): void {
  process.env.LAMASYNC_DEPLOY_AGENT_ENABLED = "true";
}

describe("scrubDeployOutput / capDeployOutputTail", () => {
  test("scrubs bearer tokens, managed keys, KEY=value secrets, long hex", () => {
    const raw = [
      "Authorization: Bearer lmsk.AbCdEfGhIjKl.aVerySecretValue",
      "export LAMASYNC_API_KEY=hunter2secret",
      "digest sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "nonce 0123456789abcdef0123456789abcdef",
    ].join("\n");
    const clean = scrubDeployOutput(raw);
    expect(clean).not.toContain("aVerySecretValue");
    expect(clean).not.toContain("hunter2secret");
    expect(clean).toContain("sha256:e3b0c442");
    expect(clean).toContain("[redacted]");
  });

  test("cap keeps the final 16 KiB and marks truncation", () => {
    const big = "x".repeat(DEPLOY_OUTPUT_TAIL_CAP + 5000);
    const capped = capDeployOutputTail(big);
    expect(capped.length).toBeLessThanOrEqual(DEPLOY_OUTPUT_TAIL_CAP + 20);
    expect(capped.startsWith("[…truncated…]")).toBe(true);
    expect(capped.endsWith("x")).toBe(true);
  });
});

describe("POST /server-deploys — request / reuse", () => {
  test("409 when the deploy agent is not configured", async () => {
    const res = await post("/api/v1/server-deploys", {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("manual deploy only");
  });

  test("creates a job when enabled, reuses the active one on duplicates", async () => {
    enableDeploy();
    const first = await post("/api/v1/server-deploys", {});
    expect(first.status).toBe(201);
    const job1 = (await first.json()) as {
      id: string;
      status: string;
      target: string;
      requestedBy: string | null;
    };
    expect(job1.status).toBe("pending");
    expect(job1.target).toBe("production");
    // Requested by the master key in this test → generic label, never a secret.
    expect(job1.requestedBy).toBe("master");

    const second = await post("/api/v1/server-deploys", {});
    expect(second.status).toBe(200);
    const job2 = (await second.json()) as { id: string };
    expect(job2.id).toBe(job1.id);
  });

  test("allows a new job after the previous one is terminal", async () => {
    enableDeploy();
    const first = (await (await post("/api/v1/server-deploys", {})).json()) as { id: string };
    await post(`/api/v1/server-deploys/${first.id}/claim`, {}, deployToken);
    const done = await post(
      `/api/v1/server-deploys/${first.id}/complete`,
      { status: "succeeded", summary: "ok" },
      deployToken,
    );
    expect(done.status).toBe(200);
    const second = await post("/api/v1/server-deploys", {});
    expect(second.status).toBe(201);
  });
});

describe("deploy-agent claim / progress / complete", () => {
  test("deploy principal claims the pending job atomically", async () => {
    enableDeploy();
    const job = (await (await post("/api/v1/server-deploys", {})).json()) as { id: string };

    const claimed = await post(`/api/v1/server-deploys/${job.id}/claim`, {}, deployToken);
    expect(claimed.status).toBe(200);
    const body = (await claimed.json()) as { status: string; startedAt: number | null };
    expect(body.status).toBe("running");
    expect(body.startedAt).not.toBeNull();

    // Second claim attempt → 409.
    const again = await post(`/api/v1/server-deploys/${job.id}/claim`, {}, deployToken);
    expect(again.status).toBe(409);
  });

  test("progress appends scrubbed, capped output", async () => {
    enableDeploy();
    const job = (await (await post("/api/v1/server-deploys", {})).json()) as { id: string };
    await post(`/api/v1/server-deploys/${job.id}/claim`, {}, deployToken);
    const res = await post(
      `/api/v1/server-deploys/${job.id}/progress`,
      { stage: "pulling", output: "pulling ghcr image\nLAMASYNC_API_KEY=leaked\n" },
      deployToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: string | null; outputTail: string | null };
    expect(body.summary).toBe("pulling");
    expect(body.outputTail).toContain("pulling ghcr image");
    expect(body.outputTail).not.toContain("leaked");
  });

  test("complete records terminal state; further progress → 409", async () => {
    enableDeploy();
    const job = (await (await post("/api/v1/server-deploys", {})).json()) as { id: string };
    await post(`/api/v1/server-deploys/${job.id}/claim`, {}, deployToken);
    const done = await post(
      `/api/v1/server-deploys/${job.id}/complete`,
      { status: "succeeded", summary: "image pulled, container healthy" },
      deployToken,
    );
    expect(done.status).toBe(200);
    const body = (await done.json()) as { status: string; completedAt: number | null };
    expect(body.status).toBe("succeeded");
    expect(body.completedAt).not.toBeNull();

    const late = await post(
      `/api/v1/server-deploys/${job.id}/progress`,
      { output: "stray" },
      deployToken,
    );
    expect(late.status).toBe(409);
  });

  test("authorization matrix: master/admin read+request, deploy claim, device nothing", async () => {
    enableDeploy();
    // deploy key cannot request jobs
    expect((await post("/api/v1/server-deploys", {}, deployToken)).status).toBe(403);
    // deploy key cannot read history
    expect((await app.handle(request("/api/v1/server-deploys", {}, deployToken))).status).toBe(403);
    // admin/master can request + read
    expect((await post("/api/v1/server-deploys", {})).status).toBe(201);
    expect((await app.handle(request("/api/v1/server-deploys"))).status).toBe(200);
    const job = (await (await app.handle(request("/api/v1/server-deploys"))).json())[0] as {
      id: string;
    };
    // admin cannot claim
    expect((await post(`/api/v1/server-deploys/${job.id}/claim`, {})).status).toBe(403);
    // deploy key CAN claim
    expect((await post(`/api/v1/server-deploys/${job.id}/claim`, {}, deployToken)).status).toBe(200);
  });
});

describe("stale running reclaim", () => {
  test("reapStaleRunningDeploys flips old running jobs back to pending", async () => {
    enableDeploy();
    const job = (await (await post("/api/v1/server-deploys", {})).json()) as { id: string };
    await post(`/api/v1/server-deploys/${job.id}/claim`, {}, deployToken);
    // Backdate started_at beyond the stale window.
    db.run("UPDATE server_deploy_jobs SET started_at = ? WHERE id = ?", [
      Date.now() - STALE_RUNNING_MS - 1000,
      job.id,
    ]);
    expect(reapStaleRunningDeploys()).toBe(1);
    const row = db
      .query<{ status: string }, [string]>("SELECT status FROM server_deploy_jobs WHERE id = ?")
      .get(job.id);
    expect(row?.status).toBe("pending");
  });

  test("GET /server-deploys/pending reaps and returns the stale job", async () => {
    enableDeploy();
    const job = (await (await post("/api/v1/server-deploys", {})).json()) as { id: string };
    await post(`/api/v1/server-deploys/${job.id}/claim`, {}, deployToken);
    db.run("UPDATE server_deploy_jobs SET started_at = ? WHERE id = ?", [
      Date.now() - STALE_RUNNING_MS - 1000,
      job.id,
    ]);
    const peek = await app.handle(request("/api/v1/server-deploys/pending", {}, deployToken));
    const body = (await peek.json()) as { job: { id: string; status: string } | null };
    expect(body.job?.id).toBe(job.id);
    expect(body.job?.status).toBe("pending");
  });

  test("GET /server-deploys/pending returns null when queue is empty", async () => {
    const res = await app.handle(request("/api/v1/server-deploys/pending", {}, deployToken));
    const body = (await res.json()) as { job: unknown };
    expect(body.job).toBeNull();
  });
});

describe("history + config", () => {
  test("history is trimmed on create", async () => {
    enableDeploy();
    for (let i = 0; i < 30; i++) {
      const res = await post("/api/v1/server-deploys", {});
      const job = (await res.json()) as { id: string };
      await post(`/api/v1/server-deploys/${job.id}/claim`, {}, deployToken);
      await post(
        `/api/v1/server-deploys/${job.id}/complete`,
        { status: "succeeded", summary: `run ${i}` },
        deployToken,
      );
    }
    const rows = (await (await app.handle(request("/api/v1/server-deploys"))).json()) as unknown[];
    expect(rows.length).toBeLessThanOrEqual(25);
  });

  test("GET /server-deploys/config reflects the feature flag", async () => {
    const off = (await (await app.handle(request("/api/v1/server-deploys/config"))).json()) as {
      enabled: boolean;
    };
    expect(off.enabled).toBe(false);
    enableDeploy();
    const on = (await (await app.handle(request("/api/v1/server-deploys/config"))).json()) as {
      enabled: boolean;
    };
    expect(on.enabled).toBe(true);
  });
});
