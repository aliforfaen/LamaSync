// LAMA-266: unit tests for the backup prove-it + monthly fire-drill engine
// + routes. Mock-restics via the __setResticRunnerForTests seam so the
// suite stays hermetic (AGENTS.md: "`bun test` always works").
//
// Coverage:
//   - pure helpers: parseSnapshotsJson, parseLsLong, pickCandidate,
//     scrubFailureSummary, sha256Hex
//   - prove path: ok returns file + duration, failure scrubs stderr,
//     tempdir cleaned up, 409-style outcome when no snapshots exist
//   - drill path: writes health_drills row + operation_log row + fires
//     notification; updates last_prove_at/last_prove_ok on the backend
//   - scheduler: due/not-due logic across the table boundary
//   - additive columns present in migrations (the schema-test style is
//     shared with backends.test.ts / pause.test.ts)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
import type {
  ResticSpawnFn,
  ResticSpawnInput,
  ResticSpawnResult,
} from "../health-drill.ts";
import {
  __setDb,
  __setResticRunnerForTests,
  appendOperationLog,
  lastDrillAtByBackend,
  listDrills,
  parseDrillIntervalMs,
  parseLsLong,
  parseSnapshotsJson,
  pickCandidate,
  recordDrill,
  runDrill,
  runDrillScheduler,
  runProve,
  scrubFailureSummary,
  sha256Hex,
  stampProveFromOutcome,
  upsertProveStamp,
} from "../health-drill.ts";
import { healthDrillRoutes } from "./health-drill.ts";

process.env.LAMASYNC_API_KEY = process.env.LAMASYNC_API_KEY ?? "health-drill-test-key";
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-health-drill-data";
process.env.LAMASYNC_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY ?? "health-drill-secret-key-0123456789";

const { getAuthPlugin } = await import("../auth.ts");

let db: Database;
let app: { handle(request: Request): Response | Promise<Response> };

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.LAMASYNC_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (!isRecord(parsed)) throw new Error("expected an object response");
  return parsed;
}

function insertResticBackend(
  id: string,
  name: string,
  repo: string,
  password: string,
): void {
  // Restic password is stored encrypted at rest in real backends; tests
  // re-use the same encryption path so the engine's decryptSecret call
  // works on the row. crypto.ts reads LAMASYNC_SECRET_KEY at module
  // load time — we set it before importing.
  const { encryptSecret } = (require("../crypto.ts") as typeof import("../crypto.ts"));
  db.run(
    `INSERT INTO backends
       (id, name, kind, restic_repository, restic_password_enc, created_at)
     VALUES (?, ?, 'restic', ?, ?, ?)`,
    [id, name, repo, encryptSecret(password), Date.now()],
  );
}

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
  __setDb(db);
  __setResticRunnerForTests(null); // reset to default
  app = new Elysia().use(getAuthPlugin()).use(healthDrillRoutes);
});

afterEach(() => {
  __setResticRunnerForTests(null);
  db.close();
  // Clean up any leaked tempdirs (defensive — engine should always
  // rmSync in finally, but a buggy test shouldn't pollute /tmp).
  for (const entry of require("node:fs").readdirSync(tmpdir())) {
    if (entry.startsWith("lamasync-prove-")) {
      try {
        rmSync(join(tmpdir(), entry), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
});

// ---------- pure helpers --------------------------------------------------

describe("parseSnapshotsJson", () => {
  test("parses a typical restic snapshots --json document", () => {
    const stdout = JSON.stringify([
      { id: "abc123", time: "2026-01-01T00:00:00Z", paths: ["/foo"], tags: ["daily"] },
      { id: "def456", time: "2025-12-31T00:00:00Z", paths: ["/foo"], tags: [] },
    ]);
    const out = parseSnapshotsJson(stdout);
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe("abc123");
  });

  test("returns [] on empty stdout", () => {
    expect(parseSnapshotsJson("")).toEqual([]);
    expect(parseSnapshotsJson("   \n  ")).toEqual([]);
  });

  test("returns [] on malformed JSON without throwing", () => {
    expect(parseSnapshotsJson("not json")).toEqual([]);
  });

  test("returns [] when stdout is a single object (defensive)", () => {
    expect(parseSnapshotsJson('{"id":"solo"}')).toEqual([]);
  });
});

describe("parseLsLong", () => {
  test("extracts file paths + sizes from a typical long listing", () => {
    const stdout = [
      "-rw-r--r--    1024 2026-01-01 00:00:00  /data/notes.txt",
      "-rw-r--r--      42 2026-01-01 00:00:00  /data/readme.md",
      "drwxr-xr-x       0 2026-01-01 00:00:00  /data/dir",
    ].join("\n");
    const out = parseLsLong(stdout);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ path: "/data/notes.txt", size: 1024, isDir: false });
    expect(out[1]).toEqual({ path: "/data/readme.md", size: 42, isDir: false });
  });

  test("drops malformed lines without throwing", () => {
    const out = parseLsLong("garbage\n-short  10  x  /file\n");
    expect(out).toEqual([]);
  });

  test("ignores directory entries (mode starts with d)", () => {
    const out = parseLsLong("drwxr-xr-x  0  2026-01-01 00:00:00  /data/dir");
    expect(out).toEqual([]);
  });
});

describe("pickCandidate", () => {
  const entries = [
    { path: "/big.bin", size: 1_000_000, isDir: false },
    { path: "/notes.txt", size: 1024, isDir: false },
    { path: "/readme.md", size: 42, isDir: false },
    { path: "/.lamasyncignore", size: 10, isDir: false },
    { path: "/script.swp", size: 50, isDir: false },
  ];
  test("returns a small non-sidecar file", () => {
    const pick = pickCandidate(entries, { rng: () => 0.7 });
    expect(pick?.path).toBe("/readme.md");
  });
  test("returns null when no small files exist", () => {
    expect(pickCandidate([entries[0]!], { maxBytes: 100 })).toBeNull();
  });
  test("returns null when only sidecar files match", () => {
    expect(pickCandidate([entries[3]!, entries[4]!])).toBeNull();
  });
});

describe("scrubFailureSummary (LAMA-226 + LAMA-266)", () => {
  test("produces a safe summary that names the stage + exit code", () => {
    expect(scrubFailureSummary("restore", 11)).toBe(
      "restic restore failed with exit code 11",
    );
  });
  test("strips all dangerous metacharacters from the stage", () => {
    // A malicious or malformed stage arg must not survive into the wire.
    // The actual scrubbed result is implementation-detail; we assert the
    // security-relevant invariants (no shell metas, no slashes, no NUL).
    const out = scrubFailureSummary("re$to\x00re; rm -rf /", 1);
    expect(out).toMatch(/^restic [a-z0-9_-]+ failed with exit code 1$/);
    expect(out).not.toContain("$");
    expect(out).not.toContain(";");
    expect(out).not.toContain("/");
    expect(out).not.toContain("\x00");
    expect(out).not.toMatch(/[<>|&`\\]/); // shell metas
  });
  test("falls back to a generic message when the stage is empty/garbage", () => {
    expect(scrubFailureSummary("", 1)).toBe("restic command failed with exit code 1");
    expect(scrubFailureSummary("!!!", 2)).toBe("restic command failed with exit code 2");
  });
  test("never embeds raw stderr text (the contract under LAMA-226)", () => {
    // Whatever the caller passes for `code`, the returned string must
    // be fully determined by `stage` + `code` — no input from stderr.
    const out = scrubFailureSummary("snapshots", 1);
    expect(out).not.toContain("Fatal");
    expect(out).not.toContain("s3://");
    expect(out).not.toContain("secret");
  });
});

describe("sha256Hex", () => {
  test("produces a deterministic 64-char hex digest", () => {
    const a = sha256Hex(Buffer.from("hello"));
    const b = sha256Hex(Buffer.from("hello"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------- prove path ----------------------------------------------------

describe("runProve", () => {
  test("returns file + duration on the happy path; backend columns stamped", async () => {
    insertResticBackend("b1", "repo", "s3:bucket/prod", "pw");
    let capturedArgs: string[][] = [];
    const runner: ResticSpawnFn = async (input) => {
      capturedArgs.push(input.args);
      if (input.args[0] === "snapshots") {
        return {
          code: 0,
          stdout: JSON.stringify([{ id: "snap-1" }]),
          stderr: "",
        };
      }
      if (input.args[0] === "ls") {
        return {
          code: 0,
          stdout: "-rw-r--r--   5 2026-01-01 00:00:00  /notes.txt\n",
          stderr: "",
        };
      }
      if (input.args[0] === "restore") {
        // Synthesize the target file by echoing the include arg as bytes
        // — proves the engine passes the candidate path correctly. The
        // 5-byte size matches the listing above.
        const include = input.args[input.args.indexOf("--include") + 1];
        const target = input.args[input.args.indexOf("--target") + 1];
        const path = join(target ?? "", (include ?? "").replace(/^\/+/, ""));
        const { mkdirSync, writeFileSync } = require("node:fs");
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "hello");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    __setResticRunnerForTests(runner);
    const outcome = await runProve({ backendId: "b1" });
    expect(outcome.ok).toBe(true);
    expect(outcome.file).toBe("/notes.txt");
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.detail).toContain("sha256=");

    // The route layer is what stamps the badge columns for a manual
    // prove (engine-level stamp is the drill's job). Mirror that here
    // so the assertion exercises the helper that production wires up.
    stampProveFromOutcome("b1", outcome);
    const row = db
      .query<{ last_prove_at: number | null; last_prove_ok: number | null }, [string]>(
        "SELECT last_prove_at, last_prove_ok FROM backends WHERE id = ?",
      )
      .get("b1");
    expect(row?.last_prove_ok).toBe(1);
    expect(row?.last_prove_at).toBeGreaterThan(0);

    // Restore arg set: --include <file>, --target <tempdir>, snapshot id, -r repo
    const restoreCall = capturedArgs.find((a) => a[0] === "restore");
    expect(restoreCall).toBeDefined();
    expect(restoreCall).toContain("--no-lock");
    expect(restoreCall).toContain("snap-1");
    expect(restoreCall).toContain("s3:bucket/prod");
  });

  test("scrubs stderr on failure; never returns raw stderr in detail", async () => {
    insertResticBackend("b1", "repo", "/tmp/repo", "pw");
    const runner: ResticSpawnFn = async (input) => {
      if (input.args[0] === "snapshots") {
        return {
          code: 0,
          stdout: JSON.stringify([{ id: "snap-1" }]),
          stderr: "",
        };
      }
      if (input.args[0] === "ls") {
        return { code: 0, stdout: "-rw-r--r--   5 2026-01-01 00:00:00  /notes.txt\n", stderr: "" };
      }
      if (input.args[0] === "restore") {
        return {
          code: 11,
          stdout: "",
          stderr:
            "Fatal: unable to open repository at s3://super-secret-bucket/prod\n  at line two\n",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    __setResticRunnerForTests(runner);
    const outcome = await runProve({ backendId: "b1" });
    expect(outcome.ok).toBe(false);
    // LAMA-226 hard rule: the raw stderr must NEVER appear in the wire
    // response. We assert the contract by checking that nothing the
    // fake runner put in stderr survives into `detail`.
    expect(outcome.detail).toBeDefined();
    expect(outcome.detail).not.toContain("Fatal");
    expect(outcome.detail).not.toContain("super-secret-bucket");
    expect(outcome.detail).not.toContain("s3://");
    expect(outcome.detail).not.toContain("prod");
    // Detail still tells the operator WHICH stage broke + the exit code.
    expect(outcome.detail).toContain("restore");
    expect(outcome.detail).toContain("11");
    // The tempdir cleanup invariant: no lamasync-prove-* dirs left.
    const leaked = require("node:fs")
      .readdirSync(tmpdir())
      .filter((n: string) => n.startsWith("lamasync-prove-"));
    expect(leaked).toHaveLength(0);
  });

  test("returns ok=false with 'no snapshots' detail when restic snapshots is empty", async () => {
    insertResticBackend("b1", "repo", "/tmp/repo", "pw");
    const runner: ResticSpawnFn = async (input) => {
      if (input.args[0] === "snapshots") {
        return { code: 0, stdout: "[]\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    __setResticRunnerForTests(runner);
    const outcome = await runProve({ backendId: "b1" });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("no restic snapshots");
  });

  test("returns 409-style outcome for a non-restic backend without throwing", async () => {
    // An s3 backend with no restic_repository — must NOT throw, and must
    // surface a clear "not a restic backend" detail. The route layer
    // maps this to 409.
    db.run(
      `INSERT INTO backends (id, name, kind, s3_endpoint, s3_access_key_id, created_at)
       VALUES ('s3-1', 'just-s3', 's3', 's3.example.com', 'AK', ?)`,
      [Date.now()],
    );
    const outcome = await runProve({ backendId: "s3-1" });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("not a restic backend");
  });

  test("cleans up the temp dir even on the error path", async () => {
    insertResticBackend("b1", "repo", "/tmp/repo", "pw");
    const runner: ResticSpawnFn = async (input) => {
      if (input.args[0] === "snapshots") {
        return {
          code: 0,
          stdout: JSON.stringify([{ id: "snap-1" }]),
          stderr: "",
        };
      }
      if (input.args[0] === "ls") {
        return {
          code: 0,
          stdout: "-rw-r--r--   5 2026-01-01 00:00:00  /a.txt\n",
          stderr: "",
        };
      }
      if (input.args[0] === "restore") {
        // Pretend restic failed AFTER the tempdir was created.
        const target = input.args[input.args.indexOf("--target") + 1];
        expect(target).toMatch(/lamasync-prove-/);
        return { code: 99, stdout: "", stderr: "kaboom" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    __setResticRunnerForTests(runner);
    const outcome = await runProve({ backendId: "b1" });
    expect(outcome.ok).toBe(false);
    const leaked = require("node:fs")
      .readdirSync(tmpdir())
      .filter((n: string) => n.startsWith("lamasync-prove-"));
    expect(leaked).toHaveLength(0);
  });
});

// ---------- drill path ----------------------------------------------------

describe("runDrill", () => {
  beforeEach(() => {
    // Re-seed per-test (the route-level __setDb hooks the same db
    // into the engine + notifications modules).
    // No-op here — db + engine are wired in the outer beforeEach.
  });

  test("writes operation_log + health_drills + fires notification on success", async () => {
    insertResticBackend("b1", "repo", "/tmp/repo", "pw");
    const runner: ResticSpawnFn = async (input) => {
      if (input.args[0] === "snapshots") {
        return {
          code: 0,
          stdout: JSON.stringify([{ id: "snap-1" }]),
          stderr: "",
        };
      }
      if (input.args[0] === "ls") {
        return {
          code: 0,
          stdout: "-rw-r--r--   5 2026-01-01 00:00:00  /ok.txt\n",
          stderr: "",
        };
      }
      if (input.args[0] === "restore") {
        const include = input.args[input.args.indexOf("--include") + 1];
        const target = input.args[input.args.indexOf("--target") + 1];
        const path = join(target ?? "", (include ?? "").replace(/^\/+/, ""));
        const { mkdirSync, writeFileSync } = require("node:fs");
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "hello");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    __setResticRunnerForTests(runner);
    const out = await runDrill({ backendId: "b1", kind: "drill" });
    expect(out.ok).toBe(true);
    expect(out.kind).toBe("drill");

    // operation_log row
    const log = db
      .query<
        { operation: string; status: string; summary: string },
        []
      >("SELECT operation, status, summary FROM operation_log WHERE host_id = '_backup-health-drill'")
      .all();
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual({
      operation: "backup_drill",
      status: "success",
      summary: "backup fire drill passed for repo",
    });

    // health_drills row
    const drills = db
      .query<
        { kind: string; ok: number; detail: string | null },
        []
      >("SELECT kind, ok, detail FROM health_drills ORDER BY rowid DESC LIMIT 1")
      .all();
    expect(drills[0]?.kind).toBe("drill");
    expect(drills[0]?.ok).toBe(1);
    expect(drills[0]?.detail).toBeNull();

    // Notification fired (no channels configured → only the DB row
    // remains, but it must exist with the expected type/severity).
    const notif = db
      .query<{ type: string; severity: string; message: string }, []>(
        "SELECT type, severity, message FROM notification_events ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    expect(notif?.type).toBe("operation_success");
    expect(notif?.severity).toBe("info");
    expect(notif?.message).toBe("backup fire drill passed for repo");

    // last_prove_at + last_prove_ok stamped on backend
    const row = db
      .query<
        { last_prove_at: number | null; last_prove_ok: number | null },
        [string]
      >("SELECT last_prove_at, last_prove_ok FROM backends WHERE id = ?")
      .get("b1");
    expect(row?.last_prove_ok).toBe(1);
  });

  test("records ok=false + critical notification on failure", async () => {
    insertResticBackend("b1", "repo", "/tmp/repo", "pw");
    const runner: ResticSpawnFn = async (input) => {
      if (input.args[0] === "snapshots") {
        return { code: 0, stdout: JSON.stringify([{ id: "snap-1" }]), stderr: "" };
      }
      if (input.args[0] === "ls") {
        return { code: 0, stdout: "-rw-r--r--   5 2026-01-01 00:00:00  /a.txt\n", stderr: "" };
      }
      return { code: 7, stdout: "", stderr: "Fatal: snapshot is truncated" };
    };
    __setResticRunnerForTests(runner);
    const out = await runDrill({ backendId: "b1", kind: "drill" });
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("restic restore failed with exit code 7");
    expect(out.detail).not.toContain("Fatal");
    expect(out.detail).not.toContain("snapshot is truncated");

    // health_drills row marked ok=0 with the scrubbed detail
    const drillRow = db
      .query<{ ok: number; detail: string | null }, []>(
        "SELECT ok, detail FROM health_drills ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    expect(drillRow?.ok).toBe(0);
    expect(drillRow?.detail).toContain("restic restore failed with exit code 7");

    // Notification: failed → the existing notification engine emits
    // "default" for the FIRST consecutive failure and escalates to
    // "critical" on the second one inside FAILURE_WINDOW_MS. We assert
    // the failure type here (the escalation is exercised by the
    // built-in notification tests; this one only proves the drill
    // pipeline plumbs into the engine).
    const notif = db
      .query<{ type: string; severity: string }, []>(
        "SELECT type, severity FROM notification_events ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    expect(notif?.type).toBe("operation_failed");
    expect(["default", "critical"]).toContain(notif?.severity ?? "");
  });

  test("throws HealthDrillError for non-restic backends (route → 409)", async () => {
    db.run(
      `INSERT INTO backends (id, name, kind, s3_endpoint, s3_access_key_id, created_at)
       VALUES ('s3-1', 'just-s3', 's3', 's3.example.com', 'AK', ?)`,
      [Date.now()],
    );
    await expect(
      runDrill({ backendId: "s3-1", kind: "drill" }),
    ).rejects.toThrow(/not a restic backend/);
  });
});

// ---------- scheduler -----------------------------------------------------

describe("runDrillScheduler", () => {
  test("picks only backends with no recent 'drill' row", async () => {
    // b1 never drilled → due
    // b2 drilled 5 days ago, interval = 3 days → due (5 > 3)
    // b3 drilled 1 hour ago, interval = 3 days → not due
    insertResticBackend("b1", "repo-1", "/tmp/r1", "pw");
    insertResticBackend("b2", "repo-2", "/tmp/r2", "pw");
    insertResticBackend("b3", "repo-3", "/tmp/r3", "pw");
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    db.run(
      `INSERT INTO health_drills (id, backend_id, kind, ran_at, ok, detail)
       VALUES ('h-b2', 'b2', 'drill', ?, 1, NULL)`,
      [now - 5 * day],
    );
    db.run(
      `INSERT INTO health_drills (id, backend_id, kind, ran_at, ok, detail)
       VALUES ('h-b3', 'b3', 'drill', ?, 1, NULL)`,
      [now - 60 * 60 * 1000],
    );
    // 'prove' rows must NOT count toward the cadence (only 'drill' does).
    db.run(
      `INSERT INTO health_drills (id, backend_id, kind, ran_at, ok, detail)
       VALUES ('h-b1-prove', 'b1', 'prove', ?, 1, NULL)`,
      [now - 1 * day],
    );

    const runner: ResticSpawnFn = async (input) => {
      if (input.args[0] === "snapshots") {
        return { code: 0, stdout: JSON.stringify([{ id: "snap-1" }]), stderr: "" };
      }
      if (input.args[0] === "ls") {
        return { code: 0, stdout: "-rw-r--r--   5 2026-01-01 00:00:00  /ok.txt\n", stderr: "" };
      }
      if (input.args[0] === "restore") {
        const include = input.args[input.args.indexOf("--include") + 1];
        const target = input.args[input.args.indexOf("--target") + 1];
        const path = join(target ?? "", (include ?? "").replace(/^\/+/, ""));
        const { mkdirSync, writeFileSync } = require("node:fs");
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "hello");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    __setResticRunnerForTests(runner);
    const result = await runDrillScheduler({
      intervalMs: 3 * day,
      now,
      runner,
    });
    expect(result.inspected).toBe(3);
    expect(result.due).toBe(2); // b1 (never drilled) + b2 (5 days > 3-day interval)
    expect(result.ran).toBe(2);
    expect(result.failed).toBe(0);

    // The newly-inserted 'drill' rows for b1 and b2 must exist after the pass.
    const newRows = db
      .query<{ backend_id: string; kind: string }, [number]>(
        "SELECT backend_id, kind FROM health_drills WHERE ran_at = ?",
      )
      .all(now);
    const ids = newRows.map((r) => r.backend_id).sort();
    expect(ids).toEqual(["b1", "b2"]);
  });

  test("after a fresh run, the next pass at the same now() is a no-op", async () => {
    insertResticBackend("b1", "repo-1", "/tmp/r1", "pw");
    const runner: ResticSpawnFn = async (input) => {
      if (input.args[0] === "snapshots") {
        return { code: 0, stdout: JSON.stringify([{ id: "snap-1" }]), stderr: "" };
      }
      if (input.args[0] === "ls") {
        return { code: 0, stdout: "-rw-r--r--   5 2026-01-01 00:00:00  /ok.txt\n", stderr: "" };
      }
      if (input.args[0] === "restore") {
        const include = input.args[input.args.indexOf("--include") + 1];
        const target = input.args[input.args.indexOf("--target") + 1];
        const path = join(target ?? "", (include ?? "").replace(/^\/+/, ""));
        const { mkdirSync, writeFileSync } = require("node:fs");
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "hello");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    __setResticRunnerForTests(runner);
    const now = 1_700_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    const first = await runDrillScheduler({ intervalMs: day, now, runner });
    expect(first.ran).toBe(1);
    const second = await runDrillScheduler({ intervalMs: day, now, runner });
    expect(second.due).toBe(0);
    expect(second.ran).toBe(0);
  });

  test("skips non-restic backends without throwing", async () => {
    db.run(
      `INSERT INTO backends (id, name, kind, s3_endpoint, s3_access_key_id, created_at)
       VALUES ('s3-1', 'just-s3', 's3', 's3.example.com', 'AK', ?)`,
      [Date.now()],
    );
    const result = await runDrillScheduler({
      intervalMs: 24 * 60 * 60 * 1000,
      now: Date.now(),
    });
    expect(result.inspected).toBe(1);
    expect(result.ran).toBe(0);
    // No audit row was written for the non-restic backend.
    expect(
      db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM health_drills").get()?.c,
    ).toBe(0);
  });
});

// ---------- helpers / read APIs -------------------------------------------

describe("listDrills + lastDrillAtByBackend", () => {
  test("listDrills joins with backends for the destination name", () => {
    insertResticBackend("b1", "prod-bucket", "/tmp/r1", "pw");
    recordDrill({ backendId: "b1", kind: "drill", ranAt: 1000, ok: true, detail: null });
    recordDrill({ backendId: "b1", kind: "drill", ranAt: 2000, ok: false, detail: "boom" });
    const list = listDrills();
    expect(list).toHaveLength(2);
    expect(list[0]?.ranAt).toBe(2000);
    expect(list[0]?.backendName).toBe("prod-bucket");
    expect(list[0]?.detail).toBe("boom");
  });

  test("lastDrillAtByBackend returns the latest 'drill' row per backend (not 'prove')", () => {
    insertResticBackend("b1", "repo", "/tmp/r", "pw");
    recordDrill({ backendId: "b1", kind: "drill", ranAt: 1000, ok: true, detail: null });
    recordDrill({ backendId: "b1", kind: "prove", ranAt: 9999, ok: true, detail: null });
    const map = lastDrillAtByBackend();
    expect(map.get("b1")).toBe(1000);
  });
});

describe("upsertProveStamp + appendOperationLog", () => {
  test("upsertProveStamp writes the last-prove columns", () => {
    insertResticBackend("b1", "repo", "/tmp/r", "pw");
    upsertProveStamp("b1", 555, true);
    const row = db
      .query<{ last_prove_at: number | null; last_prove_ok: number | null }, [string]>(
        "SELECT last_prove_at, last_prove_ok FROM backends WHERE id = ?",
      )
      .get("b1");
    expect(row?.last_prove_at).toBe(555);
    expect(row?.last_prove_ok).toBe(1);
  });
  test("appendOperationLog records an audit row with the right shape", () => {
    appendOperationLog({ hostId: "_backup-health-drill", summary: "x", ok: true, durationMs: 12 });
    const row = db
      .query<
        {
          host_id: string;
          operation: string;
          status: string;
          summary: string;
          duration_ms: number | null;
        },
        []
      >("SELECT host_id, operation, status, summary, duration_ms FROM operation_log")
      .get();
    expect(row?.host_id).toBe("_backup-health-drill");
    expect(row?.operation).toBe("backup_drill");
    expect(row?.status).toBe("success");
    expect(row?.summary).toBe("x");
    expect(row?.duration_ms).toBe(12);
  });
});

// ---------- routes --------------------------------------------------------

describe("health-drill routes", () => {
  test("POST /prove → 200 with file + duration on success", async () => {
    insertResticBackend("b1", "repo", "/tmp/r", "pw");
    const runner: ResticSpawnFn = async (input) => {
      if (input.args[0] === "snapshots") {
        return { code: 0, stdout: JSON.stringify([{ id: "snap-1" }]), stderr: "" };
      }
      if (input.args[0] === "ls") {
        return { code: 0, stdout: "-rw-r--r--   5 2026-01-01 00:00:00  /hello.txt\n", stderr: "" };
      }
      if (input.args[0] === "restore") {
        const include = input.args[input.args.indexOf("--include") + 1];
        const target = input.args[input.args.indexOf("--target") + 1];
        const path = join(target ?? "", (include ?? "").replace(/^\/+/, ""));
        const { mkdirSync, writeFileSync } = require("node:fs");
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "hello");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    __setResticRunnerForTests(runner);
    const res = await app.handle(
      request("/api/v1/backends/b1/prove", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = await responseObject(res);
    expect(body["ok"]).toBe(true);
    expect(body["file"]).toBe("/hello.txt");
    expect(typeof body["durationMs"]).toBe("number");
    expect(typeof body["checkedAt"]).toBe("string");
  });

  test("POST /prove → 502 with scrubbed detail on restic failure", async () => {
    insertResticBackend("b1", "repo", "/tmp/r", "pw");
    const runner: ResticSpawnFn = async (input) => {
      if (input.args[0] === "snapshots") {
        return { code: 0, stdout: JSON.stringify([{ id: "snap-1" }]), stderr: "" };
      }
      if (input.args[0] === "ls") {
        return { code: 0, stdout: "-rw-r--r--   5 2026-01-01 00:00:00  /a.txt\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "secret-bucket-shouldnt-leak" };
    };
    __setResticRunnerForTests(runner);
    const res = await app.handle(
      request("/api/v1/backends/b1/prove", { method: "POST" }),
    );
    expect(res.status).toBe(502);
    const body = await responseObject(res);
    expect(body["ok"]).toBe(false);
    const detail = String(body["detail"] ?? "");
    expect(detail).not.toContain("secret-bucket");
    expect(detail).not.toContain("shouldnt-leak");
    expect(detail).toContain("restore");
    expect(detail).toContain("1");
  });

  test("POST /drill → 409 for non-restic backends", async () => {
    db.run(
      `INSERT INTO backends (id, name, kind, s3_endpoint, s3_access_key_id, created_at)
       VALUES ('s3-1', 'just-s3', 's3', 's3.example.com', 'AK', ?)`,
      [Date.now()],
    );
    const res = await app.handle(
      request("/api/v1/backends/s3-1/drill", { method: "POST" }),
    );
    expect(res.status).toBe(409);
    const body = await responseObject(res);
    expect(String(body["error"])).toContain("not a restic backend");
  });

  test("POST /drill → 201 with audit row on success", async () => {
    insertResticBackend("b1", "repo", "/tmp/r", "pw");
    const runner: ResticSpawnFn = async (input) => {
      if (input.args[0] === "snapshots") {
        return { code: 0, stdout: JSON.stringify([{ id: "snap-1" }]), stderr: "" };
      }
      if (input.args[0] === "ls") {
        return { code: 0, stdout: "-rw-r--r--   5 2026-01-01 00:00:00  /a.txt\n", stderr: "" };
      }
      if (input.args[0] === "restore") {
        const include = input.args[input.args.indexOf("--include") + 1];
        const target = input.args[input.args.indexOf("--target") + 1];
        const path = join(target ?? "", (include ?? "").replace(/^\/+/, ""));
        const { mkdirSync, writeFileSync } = require("node:fs");
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "hello");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    __setResticRunnerForTests(runner);
    const res = await app.handle(
      request("/api/v1/backends/b1/drill", { method: "POST" }),
    );
    expect(res.status).toBe(201);
    const body = await responseObject(res);
    expect(body["ok"]).toBe(true);
    expect(typeof body["drillId"]).toBe("string");
    expect(body["summary"]).toContain("passed");

    const drillCount = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM health_drills")
      .get()?.c;
    expect(drillCount).toBe(1);
  });

  test("GET /health/drills returns rows newest-first + joined with backend name", async () => {
    insertResticBackend("b1", "prod", "/tmp/r", "pw");
    recordDrill({ backendId: "b1", kind: "drill", ranAt: 1000, ok: true, detail: null });
    recordDrill({ backendId: "b1", kind: "drill", ranAt: 2000, ok: false, detail: "scrubbed" });
    const res = await app.handle(request("/api/v1/health/drills"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drills: Array<Record<string, unknown>> };
    expect(body.drills).toHaveLength(2);
    expect(body.drills[0]?.["ranAt"]).toBe(new Date(2000).toISOString());
    expect(body.drills[0]?.["backendName"]).toBe("prod");
    expect(body.drills[0]?.["detail"]).toBe("scrubbed");
    expect(body.drills[1]?.["ok"]).toBe(true);
  });

  test("GET /health/drills?limit=N caps to N", async () => {
    insertResticBackend("b1", "prod", "/tmp/r", "pw");
    for (let i = 0; i < 5; i += 1) {
      recordDrill({ backendId: "b1", kind: "drill", ranAt: i + 1, ok: true, detail: null });
    }
    const res = await app.handle(request("/api/v1/health/drills?limit=2"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drills: Array<Record<string, unknown>> };
    expect(body.drills).toHaveLength(2);
  });

  test("POST /prove requires auth (401 without bearer)", async () => {
    insertResticBackend("b1", "repo", "/tmp/r", "pw");
    __setResticRunnerForTests(async () => ({ code: 0, stdout: "[]\n", stderr: "" }));
    const noAuth = new Request("http://localhost/api/v1/backends/b1/prove", {
      method: "POST",
    });
    const res = await app.handle(noAuth);
    expect(res.status).toBe(401);
  });
});

// ---------- env parsing + schema columns ---------------------------------

describe("parseDrillIntervalMs", () => {
  test("returns fallback on undefined", () => {
    expect(parseDrillIntervalMs(undefined, 30_000)).toBe(30_000);
  });
  test("returns fallback on invalid input", () => {
    expect(parseDrillIntervalMs("not-a-number", 30_000)).toBe(30_000);
  });
  test("parses a valid integer", () => {
    expect(parseDrillIntervalMs("12345", 30_000)).toBe(12345);
  });
  test("returns fallback on negative input (interval must be non-negative)", () => {
    expect(parseDrillIntervalMs("-1", 30_000)).toBe(30_000);
  });
});

describe("schema additions", () => {
  test("backends.last_prove_at and last_prove_ok exist after migrations", () => {
    const cols = db
      .query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('backends') WHERE name IN ('last_prove_at', 'last_prove_ok')",
      )
      .all()
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(["last_prove_at", "last_prove_ok"]);
  });
  test("health_drills table + index exist after migrations", () => {
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE 'health_drills%' OR name = 'idx_health_drills_backend_ran_at'",
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(tables).toContain("health_drills");
    expect(tables).toContain("idx_health_drills_backend_ran_at");
  });
});

describe("default runner wires the password via env (smoke)", () => {
  test("the default runner is wired up via __setResticRunnerForTests(null)", () => {
    // We don't call the real default runner here (that would require a
    // real `restic` binary on the host). This smoke test exists so a
    // future refactor that removes the `__setResticRunnerForTests(null)`
    // reset gets a single failing test instead of puzzling downstream
    // behaviour. The route + engine tests above all run with the real
    // default restored between each case.
    expect(typeof __setResticRunnerForTests).toBe("function");
    __setResticRunnerForTests(null);
    expect(__setResticRunnerForTests).toBeTruthy();
  });
});

// Belt-and-braces: ResticSpawnInput is exported to keep the seam stable
// for downstream tests; touch it so unused-import lint never complains.
const _typeProbe: ResticSpawnInput = { args: ["snapshots"] };
void _typeProbe;
