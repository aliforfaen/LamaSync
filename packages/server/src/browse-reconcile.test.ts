// LAMA-226 P1-3: the boot-time `reconcileStuckBrowseJobs` walk must mark
// every `running` browse_jobs row as `failed` so the (now-correct) busy
// guard can't get stuck on a key the previous server crashed on.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SERVER_SCHEMA, MIGRATIONS } from "@lamasync/core";

const { reconcileStuckBrowseJobs } = await import("./browse-jobs.ts");

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // idempotent
    }
  }
});

afterEach(() => {
  db.close();
});

describe("reconcileStuckBrowseJobs", () => {
  test("marks every running row failed with a restart message", () => {
    const now = Date.now();
    db.run(
      `INSERT INTO browse_jobs (id, operation, source, destination, status, progress_bytes, total_bytes, created_at, updated_at)
       VALUES ('a', 'copy', 'local::src', 'local::dst', 'running', 0, 1, ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO browse_jobs (id, operation, source, destination, status, progress_bytes, total_bytes, created_at, updated_at)
       VALUES ('b', 'move', 'local::src', 'local::dst', 'running', 0, 1, ?, ?)`,
      [now, now],
    );
    db.run(
      `INSERT INTO browse_jobs (id, operation, source, destination, status, progress_bytes, total_bytes, created_at, updated_at)
       VALUES ('c', 'mkdir', 'local::src', 'local::dst', 'done', NULL, NULL, ?, ?)`,
      [now, now],
    );

    const reconciled = reconcileStuckBrowseJobs(db);
    expect(reconciled).toBe(2);

    const rows = db
      .query<
        { id: string; status: string; error: string | null },
        []
      >("SELECT id, status, error FROM browse_jobs ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: "a", status: "failed", error: "server restarted while job was in flight" },
      { id: "b", status: "failed", error: "server restarted while job was in flight" },
      { id: "c", status: "done", error: null },
    ]);
  });

  test("returns 0 when nothing is stuck (no-op)", () => {
    const reconciled = reconcileStuckBrowseJobs(db);
    expect(reconciled).toBe(0);
  });
});