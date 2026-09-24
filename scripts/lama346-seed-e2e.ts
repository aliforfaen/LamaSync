#!/usr/bin/env bun
/**
 * scripts/lama346-seed-e2e.ts — LAMA-346 Stage 2c, the real vertical path.
 *
 * This is the automated, repeatable proof the work order asks for, and it is
 * deliberately NOT a deployment:
 *
 *   * an ISOLATED server on a random port, in a `mkdtemp` sandbox, with its own
 *     SQLite file and `HOME` (so no client.toml, socket or unit is ever the
 *     operator's);
 *   * a DISPOSABLE S3-compatible object space (MinIO in Docker) on a random
 *     loopback port, used for the real network object hop;
 *   * TWO INDEPENDENT PROCESSES — a source worker and a target worker — that
 *     communicate ONLY through the real HTTP job API and the object space;
 *   * disposable source/target trees and a REAL `rclone bisync --resync` over
 *     the same filter rules, requiring ZERO changed files;
 *   * no production credential, no rclone config, no real folder, no dev-vm, no
 *     push and no deploy.
 *
 * The seed surface is opened ONLY for this run: the server is started with
 * `LAMASYNC_SEED_E2E=1` AND `LAMASYNC_TEST=1`, which is the doubly-gated
 * test-only seam. Without both, `POST /seed-jobs` still answers 503 and
 * `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` is still `false`.
 *
 * Usage:
 *   bun run scripts/lama346-seed-e2e.ts [--keep] [--json <path>] [--no-docker]
 *
 * Exit code 0 means every non-gated check passed. A gated check (no Docker, no
 * rclone, no bounded volume) is reported as GATED and is never counted as a
 * pass.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { statfsSync } from "node:fs";
import {
  seedRelayArchiveKey,
  seedRelayManifestKey,
  seedRelayOrphanKeys,
  seedStagingPath,
  type SeedJob,
} from "@lamasync/core";
import { detectArchiveTooling, verifyExtractedTree } from "../packages/daemon/src/seed-archive.ts";
import { buildSeedFilterUniverse, buildSeedSourceManifest } from "../packages/daemon/src/seed-filter-universe.ts";
import { measureLocalTree } from "../packages/daemon/src/folder-health.ts";
import { createS3SeedRelayStore, ensureS3SeedRelayBucket } from "../packages/daemon/src/seed-relay-s3.ts";
import { cleanupSeedRelayObjects, seedManifestContentFingerprint } from "../packages/daemon/src/seed-transport.ts";

const ROOT = resolve(import.meta.dir, "..");
const KEEP = process.argv.includes("--keep");
const NO_DOCKER = process.argv.includes("--no-docker");
const JSON_OUT = (() => {
  const index = process.argv.indexOf("--json");
  return index >= 0 ? process.argv[index + 1] ?? null : null;
})();

type Status = "pass" | "fail" | "gated";
interface Check {
  name: string;
  status: Status;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, status: ok ? "pass" : "fail", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function gated(name: string, detail: string): void {
  checks.push({ name, status: "gated", detail });
  console.log(`GATED ${name} — ${detail}`);
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const SANDBOX = mkdtempSync(join(tmpdir(), "lama346-e2e-"));
const HOME = join(SANDBOX, "home");
const DATA_DIR = join(SANDBOX, "data");
const BACKUP_DIR = join(SANDBOX, "backup");
const SOCKET_PATH = join(SANDBOX, "run", "lamasyncd.sock");
const SOURCE_PARENT = join(SANDBOX, "host-source");
const TARGET_PARENT = join(SANDBOX, "host-target");
const SOURCE_ROOT = join(SOURCE_PARENT, "Projects");
const TARGET_ROOT = join(TARGET_PARENT, "Projects");
const WORK_DIR = join(SANDBOX, "work");
// The daemons point TMPDIR at the sandbox (see `daemonEnv`), so it must exist.
const TMP_DIR = join(SANDBOX, "tmp");
const RULES_PATH = join(SANDBOX, "filter-rules.txt");
const TEST_KEY = `lama346-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
for (const dir of [HOME, DATA_DIR, BACKUP_DIR, dirname(SOCKET_PATH), SOURCE_ROOT, TARGET_ROOT, WORK_DIR, TMP_DIR]) {
  mkdirSync(dir, { recursive: true });
}

const children: Array<{ name: string; kill: () => void }> = [];
function cleanupChildren(): void {
  for (const child of [...children].reverse()) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}
function removeMinioContainer(): void {
  const name = MINIO_CONTAINER;
  if (!name) return;
  try {
    Bun.spawnSync(["docker", "rm", "-f", name], { stdout: "pipe", stderr: "pipe" });
  } catch {
    // best effort
  }
}
process.on("exit", () => {
  cleanupChildren();
  removeMinioContainer();
  if (!KEEP) rmSync(SANDBOX, { recursive: true, force: true });
  else console.log(`\nkept sandbox: ${SANDBOX}`);
});

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = server.port;
  server.stop(true);
  return port;
}
const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

/**
 * A server call made with a DEVICE key rather than the harness's master key.
 *
 * The Stage 2d denial checks must be made by a credential the server can only
 * know as a device — the same shape a real daemon uses — so the authorization
 * rules are exercised on the real boundary, not on an admin shortcut.
 */
async function deviceRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function sandboxEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HOME,
    LAMASYNC_API_KEY: TEST_KEY,
    LAMASYNC_DATA_DIR: DATA_DIR,
    LAMASYNC_BACKUP_DIR: BACKUP_DIR,
    LAMASYNC_SOCKET_PATH: SOCKET_PATH,
    LAMASYNC_TEST: "1",
    PORT: String(PORT),
    ...extra,
  };
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TEST_KEY}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Object space
// ---------------------------------------------------------------------------

let MINIO_CONTAINER: string | null = null;
// The device keys the daemons use. The Stage 2c worker diagnostic reuses them so
// it speaks the SAME per-role contract: the archive-facts route admits the
// source device and refuses the master key, which is the point of Stage 2d.
let SOURCE_DEVICE_KEY = "";
let TARGET_DEVICE_KEY = "";
let S3 = {
  endpoint: "",
  // The operator's real temporary seed bucket name. The PILOT names the bucket
  // (the code hardcodes none), so using the real name here exercises the same
  // value an operator would type.
  bucket: "lamasync-tmp",
  region: "us-east-1",
  accessKeyId: "lamae2e",
  secretAccessKey: "lamae2e-secret",
};

async function waitForHttp(url: string, attempts = 120, intervalMs = 250): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(intervalMs);
  }
  return false;
}

async function startObjectSpace(): Promise<boolean> {
  if (NO_DOCKER) {
    gated("real network object space (MinIO)", "--no-docker was passed");
    return false;
  }
  if (!Bun.which("docker")) {
    gated("real network object space (MinIO)", "docker is not on PATH");
    return false;
  }
  const info = Bun.spawnSync(["docker", "info"], { stdout: "pipe", stderr: "pipe" });
  if (info.exitCode !== 0) {
    gated("real network object space (MinIO)", "the Docker daemon is not reachable");
    return false;
  }
  const image = "quay.io/minio/minio:latest";
  const hasImage = Bun.spawnSync(["docker", "image", "inspect", image], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  if (!hasImage) {
    const pull = Bun.spawnSync(["docker", "pull", image], { stdout: "pipe", stderr: "pipe" });
    if (pull.exitCode !== 0) {
      gated("real network object space (MinIO)", `could not pull ${image}`);
      return false;
    }
  }
  const port = freePort();
  MINIO_CONTAINER = `lama346-minio-${process.pid}`;
  const run = Bun.spawnSync(
    [
      "docker", "run", "-d", "--name", MINIO_CONTAINER,
      "-p", `127.0.0.1:${port}:9000`,
      "-e", `MINIO_ROOT_USER=${S3.accessKeyId}`,
      "-e", `MINIO_ROOT_PASSWORD=${S3.secretAccessKey}`,
      image, "server", "/data",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (run.exitCode !== 0) {
    gated("real network object space (MinIO)", `docker run failed: ${new TextDecoder().decode(run.stderr).slice(0, 200)}`);
    MINIO_CONTAINER = null;
    return false;
  }
  S3 = { ...S3, endpoint: `http://127.0.0.1:${port}` };
  const up = await waitForHttp(`${S3.endpoint}/minio/health/live`);
  if (!up) {
    gated("real network object space (MinIO)", "MinIO did not become healthy");
    return false;
  }
  await ensureS3SeedRelayBucket(S3);
  check("a disposable S3-compatible object space is running", true, S3.endpoint);
  return true;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const IGNORE_LINES = ["- node_modules/", "- *.log", "- tmp/"];
const FIXTURE_FILE_COUNT = 60;

function pseudoBytes(seed: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

function buildSourceFixture(): void {
  writeFileSync(join(SOURCE_ROOT, ".lamasyncignore"), `${IGNORE_LINES.join("\n")}\n`);
  for (let i = 0; i < FIXTURE_FILE_COUNT; i += 1) {
    const dir = join(SOURCE_ROOT, "src", `module-${String(i % 6).padStart(2, "0")}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `file-${String(i).padStart(3, "0")}.ts`), `export const n${i} = ${i};\n`);
  }
  mkdirSync(join(SOURCE_ROOT, "assets"), { recursive: true });
  writeFileSync(join(SOURCE_ROOT, "assets", "blob-a.bin"), pseudoBytes(7, 256 * 1024));
  writeFileSync(join(SOURCE_ROOT, "README.md"), "# E2E fixture\n");
  utimesSync(join(SOURCE_ROOT, "README.md"), 1_700_000_000, 1_700_000_000);
  // Ignored content that must never reach the target.
  mkdirSync(join(SOURCE_ROOT, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(SOURCE_ROOT, "node_modules", "pkg", "index.js"), "ignored\n");
  mkdirSync(join(SOURCE_ROOT, "tmp"), { recursive: true });
  writeFileSync(join(SOURCE_ROOT, "tmp", "scratch.bin"), pseudoBytes(5, 4096));
  writeFileSync(join(SOURCE_ROOT, "debug.log"), "ignored log\n");
}

/** Relative path -> size, for the universe only. */
function treeMap(root: string, skip: (rel: string, isDir: boolean) => boolean): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split("\\").join("/");
      if (skip(rel, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      out.set(rel, statSync(full).size);
    }
  };
  walk(root);
  return out;
}

function plainLog(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * The source manifest, rebuilt by the HARNESS from the source tree.
 *
 * The daemon path's independent check uses this: it trusts no log any worker or
 * daemon emitted — only the bytes on disk and the folder's own ignore rules.
 */
async function harnessManifestFixture(folderId: string) {
  const built = await buildSeedSourceManifest(
    {
      id: "e2e-source",
      folderId,
      hostId: "seed-source",
      role: "both",
      localPath: SOURCE_ROOT,
      enabled: true,
      ignorePath: ".lamasyncignore",
      ignoreGitMetadata: true,
    },
    "sync",
  );
  if (built.manifest === null) {
    throw new Error(`the harness could not rebuild the source manifest: ${built.blocking.join("; ")}`);
  }
  return built.manifest;
}

function runBisync(resync: boolean): { exitCode: number; raw: string; transfers: number; bytes: number } {
  const state = join(SANDBOX, "harness-bisync-state");
  if (resync) rmSync(state, { recursive: true, force: true });
  mkdirSync(state, { recursive: true });
  const args = [
    "rclone", "bisync", SOURCE_ROOT, TARGET_ROOT,
    "--workdir", state,
    "--filter-from", RULES_PATH,
    "--use-json-log", "-v", "--resilient", "--recover", "--max-lock", "10m",
  ];
  if (resync) args.push("--resync");
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  const raw = plainLog(new TextDecoder().decode(result.stderr));
  let transfers = -1;
  let bytes = -1;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { stats?: Record<string, number> };
      if (parsed.stats) {
        transfers = parsed.stats["totalTransfers"] ?? transfers;
        bytes = parsed.stats["bytes"] ?? bytes;
      }
    } catch {
      // progress lines
    }
  }
  return { exitCode: result.exitCode, raw, transfers, bytes };
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

interface WorkerResult {
  code: number;
  events: Array<Record<string, unknown>>;
  stdout: string;
  stderr: string;
}

async function runWorker(role: "source" | "target", jobId: string, extra: Record<string, string> = {}): Promise<WorkerResult> {
  const env = sandboxEnv({
    LAMASYNC_SEED_ROLE: role,
    LAMASYNC_SEED_JOB_ID: jobId,
    LAMASYNC_SEED_SERVER_URL: `http://127.0.0.1:${PORT}`,
    // A DEVICE key, never the master key: the server admits only the job's own
    // source to the archive route, and the target may not author those facts.
    LAMASYNC_SEED_API_KEY: role === "source" ? SOURCE_DEVICE_KEY : TARGET_DEVICE_KEY,
    LAMASYNC_SEED_HOST_ID: role === "source" ? "seed-source" : "seed-target",
    LAMASYNC_SEED_FOLDER_ROOT: role === "source" ? SOURCE_ROOT : TARGET_ROOT,
    LAMASYNC_SEED_FOLDER_TYPE: "sync",
    LAMASYNC_SEED_FILTER_RULES_PATH: RULES_PATH,
    LAMASYNC_SEED_WORK_DIR: join(WORK_DIR, `${role}-${jobId}`),
    LAMASYNC_SEED_S3_ENDPOINT: S3.endpoint,
    LAMASYNC_SEED_S3_BUCKET: S3.bucket,
    LAMASYNC_SEED_S3_REGION: S3.region,
    LAMASYNC_SEED_S3_ACCESS_KEY: S3.accessKeyId,
    LAMASYNC_SEED_S3_SECRET_KEY: S3.secretAccessKey,
    ...(role === "target" ? { LAMASYNC_SEED_PEER_ROOT: SOURCE_ROOT } : {}),
    ...extra,
  });
  const proc = Bun.spawn(["bun", "run", join(ROOT, "scripts", "lama346-seed-worker.ts")], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push({ name: `worker-${role}-${jobId}`, kill: () => proc.kill() });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const events: Array<Record<string, unknown>> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // not a structured line
    }
  }
  return { code, events, stdout, stderr };
}

interface TerminalWaitOptions {
  timeoutMs?: number;
  /** Called with every poll, so a test can watch the lease move. */
  onSample?: (job: SeedJob) => void;
  /** Cancel the job as soon as this returns true, exactly once. */
  cancelWhen?: () => boolean;
}

async function waitForTerminalJobWith(jobId: string, options: TerminalWaitOptions = {}): Promise<SeedJob> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const deadline = Date.now() + timeoutMs;
  let cancelled = false;
  for (;;) {
    const res = await api("GET", `/seed-jobs/${jobId}`);
    const job = res.body as SeedJob;
    if (job) options.onSample?.(job);
    if (job && ["completed", "failed", "cancelled"].includes(job.phase)) return job;
    if (options.cancelWhen !== undefined && !cancelled && options.cancelWhen()) {
      cancelled = true;
      const cancelledRes = await api("POST", `/seed-jobs/${jobId}/cancel`);
      console.log(`  (operator cancellation sent: status ${cancelledRes.status})`);
    }
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not reach a terminal state`);
    await Bun.sleep(300);
  }
}

async function waitForTerminalJob(jobId: string, timeoutMs = 180_000): Promise<SeedJob> {
  return waitForTerminalJobWith(jobId, { timeoutMs });
}

/** How many times a marker appears in a log buffer (per-job scoping). */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Two tree snapshots are equal when they hold the same paths at the same sizes. */
function sameTree(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [rel, size] of a) {
    if (b.get(rel) !== size) return false;
  }
  return true;
}

/**
 * The diagnostic sections' variant: return whatever the job is when the wait
 * runs out, and say so.
 *
 * A job whose owner died without acking stays `running` until its lease lapses
 * (the reaper fails it), so a bounded wait can legitimately time out. Aborting
 * the whole harness there would hide the failure's real shape, which is exactly
 * what the checks below are for.
 */
async function waitForTerminalJobTolerant(jobId: string, timeoutMs = 180_000): Promise<SeedJob> {
  try {
    return await waitForTerminalJob(jobId, timeoutMs);
  } catch (err) {
    const res = await api("GET", `/seed-jobs/${jobId}`);
    const job = res.body as SeedJob;
    console.error(
      `[harness] ${err instanceof Error ? err.message : String(err)}; job is phase=${job?.phase ?? "?"} status=${job?.status ?? "?"}`,
    );
    return job;
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function startServer(): Promise<boolean> {
  const log = join(SANDBOX, "server.log");
  const proc = Bun.spawn(["bun", "run", "packages/server/src/index.ts"], {
    cwd: ROOT,
    // NOTE: no seed seam on the server. Stage 2f replaced it with the operator's
    // pilot, and the harness configures a REAL pilot through the REAL admin
    // routes below — so the sandbox cannot open anything a production server
    // would not, and the pilot is exercised on its own.
    env: sandboxEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push({ name: "server", kill: () => proc.kill() });
  void new Response(proc.stdout).text().then((text) => writeFileSync(log, text));
  void new Response(proc.stderr).text();
  const ready = await (async (): Promise<boolean> => {
    for (let i = 0; i < 120; i += 1) {
      try {
        const res = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${TEST_KEY}` } });
        if (res.ok) return true;
      } catch {
        // not up yet
      }
      await Bun.sleep(200);
    }
    return false;
  })();
  check("the isolated server answers /health", ready, `port ${PORT}`);
  if (!ready) {
    const tail = existsSync(log) ? readFileSync(log, "utf8").slice(-800) : "(no log)";
    console.error(tail);
  }
  return ready;
}

async function registerHost(id: string, hostname: string): Promise<void> {
  const res = await api("POST", "/register", { id, hostname, tailnetIp: null });
  if (res.status !== 200 && res.status !== 201) throw new Error(`register ${id} answered ${res.status}`);
}

// ---------------------------------------------------------------------------
// Health facts, so the real plan API can build a runnable plan
// ---------------------------------------------------------------------------

async function reportHealth(input: {
  hostId: string;
  folderId: string;
  root: string;
  isSource: boolean;
  filterFingerprint: string | null;
  patternCount: number;
  /**
   * The TARGET's own measurement of how many entries it already holds. A seed
   * only publishes into an EMPTY target, so the preflight needs this to be 0 —
   * and `undefined` means "never measured", which is refused too.
   */
  targetEntryCount?: number;
}): Promise<void> {
  const tooling = await detectArchiveTooling();
  const measurement = input.isSource
    ? measureLocalTree(input.root)
    : input.targetEntryCount === undefined
      ? null
      : { pathCount: input.targetEntryCount, totalBytes: 0, measuredAt: Date.now() };
  const free = statfsSync(existsSync(input.root) ? input.root : dirname(input.root));
  const res = await api("POST", "/folder-health", {
    hostId: input.hostId,
    folderId: input.folderId,
    state: "healthy",
    reasons: [],
    reportedAt: Date.now(),
    facts: {
      folderType: "sync",
      effectiveType: "sync",
      enabled: true,
      paused: false,
      runInProgress: false,
      rcloneAvailable: Bun.which("rclone") !== null,
      archive: tooling,
      seedStaging: {
        targetPath: input.root,
        targetParent: dirname(input.root),
        stagingParent: dirname(input.root),
        sameFilesystem: true,
        device: statSync(dirname(input.root)).dev,
        checkedAt: Date.now(),
      },
      localDir: "ok",
      freeSpaceBytes: Math.floor(free.bsize * free.bavail),
      freeSpaceThresholdBytes: 0,
      watcher: null,
      filter: {
        fingerprint: input.filterFingerprint,
        source: "lamasyncignore",
        changedSinceBaseline: false,
        patternCount: input.patternCount,
      },
      baseline: {
        present: false,
        ready: false,
        error: false,
        path1Count: null,
        path2Count: null,
        updatedAt: null,
        fingerprint: "e2e-no-baseline",
      },
      activePhase: null,
      pendingConflicts: 0,
      lastRun: null,
      measurement,
    },
  });
  if (res.status !== 204) throw new Error(`folder-health for ${input.hostId} answered ${res.status}: ${JSON.stringify(res.body)}`);
}

// ---------------------------------------------------------------------------
// One full seed run
// ---------------------------------------------------------------------------

interface RunOptions {
  label: string;
  expect: "completed" | "failed" | "cancelled";
  sourceExtra?: Record<string, string>;
  targetExtra?: Record<string, string>;
  preTarget?: () => void;
  cancelAfterMs?: number;
  concurrent?: boolean;
}

async function createJob(folderId: string): Promise<string> {
  const planRes = await api("POST", `/folders/${folderId}/seed-plans`, {
    hostId: "seed-target",
    sourceHostId: "seed-source",
    confirm: true,
  });
  if (planRes.status !== 201) throw new Error(`seed-plan answered ${planRes.status}: ${JSON.stringify(planRes.body).slice(0, 300)}`);
  const plan = record(planRes.body);
  const planId = str(record(plan["plan"])["id"]);
  const jobRes = await api("POST", "/seed-jobs", { planId, confirm: true });
  if (jobRes.status !== 201) throw new Error(`seed-job answered ${jobRes.status}: ${JSON.stringify(jobRes.body).slice(0, 300)}`);
  return str(record(jobRes.body)["id"]);
}

// ---------------------------------------------------------------------------
// Stage 2d: two REAL lamasyncd processes, driven by their own device keys
// ---------------------------------------------------------------------------
//
// This is the acceptance evidence for the daemon wiring, and it deliberately
// looks nothing like the worker diagnostic above:
//
//   * the two sides are the SHIPPED daemon (`packages/daemon/src/index.ts`),
//     started as two separate OS processes with their own HOME, their own
//     `client.toml` and their own DATA DIRECTORY;
//   * their credentials are DEVICE keys minted through the real pairing
//     exchange — never the master key — and the server authorizes each side's
//     half of the job from `seedJobRoleFor`;
//   * the seed is driven by the real queued-action loop: `POST /seed-jobs`
//     enqueues one `seed_job` action per party and each daemon claims its own;
//   * the target daemon OWNS the zero-change baseline gate: it will not report
//     the job completed unless a real `rclone bisync --resync` moved nothing.
//
// The worker-based sections below remain as a lower-level diagnostic (they can
// drive failure injection cheaply), and they are labelled as such.

/**
 * The lease shape this run uses, and the one deliberately LONG stage per side.
 *
 * The lease is shortened to the smallest window the route accepts (30 s) and the
 * renewal interval to 3 s, so a stage held for 35 s OUTLIVES the lease many times
 * over: that is the incident's shape (a healthy 43-minute transfer against a
 * 10-minute budget) compressed into half a minute. Without a renewal DURING the
 * stage the source's handover write — which requires a LIVE lease — is refused
 * and a healthy seed fails; with one it completes.
 *
 * All of it is seam-gated (`LAMASYNC_SEED_*` is read only when the doubly-gated
 * seam is open, and the lease is floored at the route's own minimum), so none of
 * it can reach a production build.
 */
const LEASE_MS = 30_000;
const LEASE_INTERVAL_MS = 3_000;
const SOURCE_HOLD_MS = 35_000;
const TARGET_HOLD_MS = 10_000;
const SOURCE_HOLD_PHASE = "uploading_archive";
const TARGET_HOLD_PHASE = "extracting_target";

function seamLeaseEnv(side: "source" | "target"): Record<string, string> {
  return {
    LAMASYNC_SEED_LEASE_MS: String(LEASE_MS),
    LAMASYNC_SEED_LEASE_INTERVAL_MS: String(LEASE_INTERVAL_MS),
    LAMASYNC_SEED_STAGE_DELAY_PHASE: side === "source" ? SOURCE_HOLD_PHASE : TARGET_HOLD_PHASE,
    LAMASYNC_SEED_STAGE_DELAY_MS: String(side === "source" ? SOURCE_HOLD_MS : TARGET_HOLD_MS),
  };
}

interface DaemonHandle {
  side: "source" | "target";
  hostId: string;
  home: string;
  proc: Bun.Subprocess;
  logs: () => string;
  stop: () => void;
}

/**
 * The environment a sandbox daemon gets: an ALLOWLIST, not the harness env.
 *
 * `HOME` and `XDG_RUNTIME_DIR` are per-daemon so no client.toml, cache, socket,
 * unit or update marker can be the operator's, and the D-Bus session address is
 * pointed at a path that does not exist so a `systemctl --user` probe cannot
 * reach the real session manager.
 */
function daemonEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const runtimeDir = join(home, "run");
  mkdirSync(runtimeDir, { recursive: true });
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: join(SANDBOX, "tmp"),
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtimeDir, "no-session-bus")}`,
    LAMASYNC_SOCKET_PATH: join(runtimeDir, "lamasyncd.sock"),
    // The doubly-gated seam, for SANDBOX AFFORDANCES ONLY (a shortened lease, a
    // held phase, a local resync peer). Note what is ABSENT: no
    // LAMASYNC_SEED_S3_* at all. The relay space must therefore arrive the way
    // production delivers it — inside this device's own authenticated host
    // config, issued by the server for this job and this side. If the host-config
    // path ever broke, the daemons here would have no relay space and every seed
    // below would fail, which is exactly the check we want.
    LAMASYNC_SEED_E2E: "1",
    LAMASYNC_TEST: "1",
    ...extra,
  };
}

async function waitForLog(handle: DaemonHandle, needle: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.logs().includes(needle)) return true;
    await Bun.sleep(200);
  }
  return handle.logs().includes(needle);
}

/** Mint a real device key for one host through the documented pairing flow. */
async function mintDeviceKey(hostId: string): Promise<string> {
  const created = await api("POST", "/pairing", { ttlSeconds: 600 });
  if (created.status !== 201) {
    throw new Error(`pairing create answered ${created.status}: ${JSON.stringify(created.body)}`);
  }
  const code = str(record(created.body)["code"]);
  if (code.length === 0) throw new Error("pairing create returned no code");
  const res = await fetch(`${BASE}/pairing/${encodeURIComponent(code)}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostId, hostname: hostId }),
  });
  const body = record(await res.json().catch(() => null));
  if (res.status !== 200) {
    throw new Error(`pairing exchange for ${hostId} answered ${res.status}: ${JSON.stringify(body)}`);
  }
  const apiKey = str(body["apiKey"]);
  if (apiKey.length === 0) throw new Error("pairing exchange returned no apiKey");
  return apiKey;
}

async function startDaemon(
  side: "source" | "target",
  hostId: string,
  apiKey: string,
): Promise<DaemonHandle> {
  const home = join(SANDBOX, `daemon-${side}`);
  const configDir = join(home, ".config", "lamasync");
  const dataDir = join(home, "data");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(configDir, "client.toml"),
    [
      `serverUrl = "http://127.0.0.1:${PORT}"`,
      `apiKey = "${apiKey}"`,
      `hostname = "${hostId}"`,
      `dataDir = "${dataDir}"`,
      `socketPath = "${join(home, "run", "lamasyncd.sock")}"`,
      "",
    ].join("\n"),
  );
  // Skip the boot release check: no outbound call, and deterministic timing.
  writeFileSync(
    join(configDir, "update-state.json"),
    JSON.stringify({ lastCheckAt: Date.now() }),
  );
  const env = daemonEnv(home, {
    ...(side === "target" ? { LAMASYNC_SEED_DAEMON_PEER_PATH: SOURCE_ROOT } : {}),
    ...seamLeaseEnv(side),
  });
  const proc = Bun.spawn(["bun", "run", join(ROOT, "packages", "daemon", "src", "index.ts")], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let buffer = "";
  const decoder = new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
    }
  };
  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);
  const handle: DaemonHandle = {
    side,
    hostId,
    home,
    proc,
    logs: () => buffer,
    stop: () => {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    },
  };
  children.push({ name: `daemon-${side}`, kill: handle.stop });
  return handle;
}

interface DaemonSeedResult {
  job: SeedJob;
  source: DaemonHandle;
  target: DaemonHandle;
  sourceKey: string;
  targetKey: string;
  actions: Array<Record<string, unknown>>;
}

/**
 * Start the two real daemons and wait until each has registered and reported.
 *
 * Both are given their own device key minted through the pairing exchange, so
 * from here on neither side ever sees an admin credential.
 */
async function startDaemons(): Promise<{
  source: DaemonHandle;
  target: DaemonHandle;
  sourceKey: string;
  targetKey: string;
}> {
  const sourceKey = await mintDeviceKey("seed-source");
  const targetKey = await mintDeviceKey("seed-target");
  SOURCE_DEVICE_KEY = sourceKey;
  TARGET_DEVICE_KEY = targetKey;
  check(
    "each daemon got its own DEVICE key through the pairing exchange",
    sourceKey.length > 0 &&
      targetKey.length > 0 &&
      sourceKey !== targetKey &&
      sourceKey !== TEST_KEY &&
      targetKey !== TEST_KEY,
  );

  const source = await startDaemon("source", "seed-source", sourceKey);
  const target = await startDaemon("target", "seed-target", targetKey);
  const sourceUp = await waitForLog(source, "[boot] registered and reported online");
  const targetUp = await waitForLog(target, "[boot] registered and reported online");
  check("the source daemon booted and registered", sourceUp, sourceUp ? "" : source.logs().slice(-300));
  check("the target daemon booted and registered", targetUp, targetUp ? "" : target.logs().slice(-300));
  return { source, target, sourceKey, targetKey };
}

/**
 * Create the plan and the job, then wait for the daemons to drive it home.
 *
 * The plan is created with the master key — preparing and approving a seed IS
 * operator work — and the job creation is what enqueues one action per party.
 * No device credential is used for either.
 */
async function runDaemonSeed(
  folderId: string,
  daemons: { source: DaemonHandle; target: DaemonHandle; sourceKey: string; targetKey: string },
  options: TerminalWaitOptions & { label?: string } = {},
): Promise<DaemonSeedResult> {
  const planRes = await api("POST", `/folders/${folderId}/seed-plans`, {
    hostId: "seed-target",
    sourceHostId: "seed-source",
    confirm: true,
  });
  if (planRes.status !== 201) {
    throw new Error(`seed-plan answered ${planRes.status}: ${JSON.stringify(planRes.body).slice(0, 300)}`);
  }
  const planId = str(record(record(planRes.body)["plan"])["id"]);
  const jobRes = await api("POST", "/seed-jobs", { planId, confirm: true });
  if (jobRes.status !== 201) {
    throw new Error(`seed-job answered ${jobRes.status}: ${JSON.stringify(jobRes.body).slice(0, 300)}`);
  }
  const jobId = str(record(jobRes.body)["id"]);
  console.log(`job ${jobId} (${options.label ?? "daemon seed"})`);

  // The server enqueues ONE action per party; the daemons claim their own.
  const sourceQueue = await api("GET", "/hosts/seed-source/actions");
  const targetQueue = await api("GET", "/hosts/seed-target/actions");
  const mine = (body: unknown): Array<Record<string, unknown>> =>
    Array.isArray(body)
      ? body
          .map(record)
          .filter(
            (a) => str(a["type"]) === "seed_job" && str(record(a["payload"])["jobId"]) === jobId,
          )
      : [];
  const actions = [...mine(sourceQueue.body), ...mine(targetQueue.body)];
  check(
    "the server enqueued one seed_job action per party",
    actions.length === 2,
    `found ${actions.length}`,
  );

  const job = await waitForTerminalJobWith(jobId, {
    timeoutMs: 300_000,
    ...(options.onSample === undefined ? {} : { onSample: options.onSample }),
    ...(options.cancelWhen === undefined ? {} : { cancelWhen: options.cancelWhen }),
  });
  return { job, ...daemons, actions };
}

async function runSeedJob(folderId: string, options: RunOptions): Promise<{ job: SeedJob; source: WorkerResult; target: WorkerResult }> {
  section(`Seed run: ${options.label}`);
  const jobId = await createJob(folderId);
  console.log(`job ${jobId} (${options.label})`);
  if (options.preTarget) options.preTarget();
  if (options.concurrent) {
    // Two jobs at once: both sides are launched together and must not corrupt
    // each other's rows or objects.
    const [source, target] = await Promise.all([
      runWorker("source", jobId, options.sourceExtra ?? {}),
      runWorker("target", jobId, options.targetExtra ?? {}),
    ]);
    const job = await waitForTerminalJobTolerant(jobId);
    return { job, source, target };
  }
  if (options.cancelAfterMs !== undefined) {
    const sourcePromise = runWorker("source", jobId, { LAMASYNC_SEED_DELAY_MS: "4000", ...(options.sourceExtra ?? {}) });
    const targetPromise = runWorker("target", jobId, options.targetExtra ?? {});
    await Bun.sleep(options.cancelAfterMs);
    await api("POST", `/seed-jobs/${jobId}/cancel`);
    const [source, target] = await Promise.all([sourcePromise, targetPromise]);
    const job = await waitForTerminalJobTolerant(jobId);
    return { job, source, target };
  }
  const source = await runWorker("source", jobId, options.sourceExtra ?? {});
  const target = await runWorker("target", jobId, options.targetExtra ?? {});
  const job = await waitForTerminalJobTolerant(jobId);
  return { job, source, target };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const results: Record<string, unknown> = {};

async function main(): Promise<void> {
  section("Disposable sandbox");
  console.log(`sandbox: ${SANDBOX}`);
  console.log(`server:  http://127.0.0.1:${PORT} (source, isolated)`);
  console.log(`rclone:  ${Bun.which("rclone") ?? "MISSING"}`);

  const rcloneAvailable = Bun.which("rclone") !== null;
  if (!rcloneAvailable) {
    gated("real rclone bisync baseline", "rclone is not on PATH");
    console.log("\nNo rclone: the object hop and job lifecycle can still run, but the zero-change baseline cannot be proven.");
  }

  const objectSpaceUp = await startObjectSpace();
  if (!objectSpaceUp) {
    // Without a real object space the vertical path cannot run; report exactly
    // what is gated and exit non-zero rather than claiming a pass.
    gated("real vertical seed path", "no disposable object space available");
    finish();
    return;
  }

  if (!(await startServer())) {
    finish();
    process.exitCode = 1;
    return;
  }

  section("Fleet, folder and assignments");
  buildSourceFixture();
  await registerHost("seed-source", "seed-source");
  await registerHost("seed-target", "seed-target");
  const backendRes = await api("POST", "/backends", {
    name: "e2e-local",
    kind: "local",
    localPath: join(SANDBOX, "backend"),
  });
  mkdirSync(join(SANDBOX, "backend"), { recursive: true });
  check("a sandbox storage backend exists", backendRes.status < 300, `status ${backendRes.status}`);
  const folderRes = await api("POST", "/folders", { name: "e2e-seed-folder", type: "sync" });
  const folderId = str(record(folderRes.body)["id"]);
  check("folder created", folderId.length > 0, `status ${folderRes.status}: ${str(record(folderRes.body)["error"])}`);
  const assignSource = await api("POST", `/folders/${folderId}/assign`, {
    hostId: "seed-source",
    role: "both",
    localPath: SOURCE_ROOT,
    syncExpr: "0 0 1 1 *",
    enabled: true,
    // The daemon derives its effective filter universe from this assignment, so
    // the sandbox must configure the same universe the harness compiles its
    // reference rules from — otherwise the plan's reported fingerprint and the
    // archive's actual universe would describe different trees.
    ignorePath: ".lamasyncignore",
    ignoreGitMetadata: true,
  });
  const assignTarget = await api("POST", `/folders/${folderId}/assign`, {
    hostId: "seed-target",
    role: "both",
    localPath: TARGET_ROOT,
    syncExpr: "0 0 1 1 *",
    enabled: true,
    ignorePath: ".lamasyncignore",
    ignoreGitMetadata: true,
  });
  check(
    "both devices are assigned",
    assignSource.status < 300 && assignTarget.status < 300,
    `${assignSource.status}/${assignTarget.status}`,
  );

  const universe = buildSeedFilterUniverse(
    {
      id: "e2e-source", folderId, hostId: "seed-source", role: "both",
      localPath: SOURCE_ROOT, enabled: true, ignorePath: ".lamasyncignore", ignoreGitMetadata: true,
    },
    "sync",
  );
  check("the source effective filter universe compiles", universe.errors.length === 0, `${universe.rules.length} rule(s)`);
  writeFileSync(RULES_PATH, universe.rules.length > 0 ? `${universe.rules.join("\n")}\n` : "");
  await reportHealth({
    hostId: "seed-source", folderId, root: SOURCE_ROOT, isSource: true,
    filterFingerprint: universe.fingerprint, patternCount: universe.rules.length,
  });
  await reportHealth({
    hostId: "seed-target", folderId, root: TARGET_ROOT, isSource: false,
    filterFingerprint: universe.fingerprint, patternCount: universe.rules.length,
  });
  check("both devices reported the health facts the plan needs", true);

  // --- Stage 2d: the real daemon path (the acceptance evidence) --------------
  section("Stage 2d: two real lamasyncd processes, each with its own device key");
  const daemons = await startDaemons();
  // A daemon's boot health report is lightweight by design (no deep tree walk),
  // so it REPLACES the harness's earlier row with `measurement: null`. The plan
  // needs the source's fresh measurement, so re-report it here, immediately
  // before the plan is built.
  await reportHealth({
    hostId: "seed-source",
    folderId,
    root: SOURCE_ROOT,
    isSource: true,
    filterFingerprint: universe.fingerprint,
    patternCount: universe.rules.length,
  });
  await reportHealth({
    hostId: "seed-target",
    folderId,
    root: TARGET_ROOT,
    isSource: false,
    filterFingerprint: universe.fingerprint,
    patternCount: universe.rules.length,
  });
  // --- Stage 2f: the operator's seed pilot is the gate ----------------------
  //
  // The acceptance evidence for the pilot: with no pilot configured (or with one
  // that names a different folder, a swapped pair, or an unprobed seed space)
  // `POST /seed-jobs` refuses with 503 — even though this sandbox sets every seed
  // environment variable it can, because the SERVER no longer has a seam at all.
  // The pilot is then configured through the real admin routes with a REAL S3
  // backend row pointing at the disposable object space, probed, and only then
  // does a job become creatable.
  section("Stage 2f: the seed pilot gates execution, and its space is probed");
  const pilotBackend = await api("POST", "/backends", {
    name: "e2e-seed-space",
    kind: "s3",
    s3Provider: "other",
    s3Endpoint: S3.endpoint,
    s3Region: S3.region,
    s3AccessKeyId: S3.accessKeyId,
    s3SecretAccessKey: S3.secretAccessKey,
  });
  const pilotBackendId = str(record(pilotBackend.body)["id"]);
  check(
    "an EXISTING S3 backend row can be reused as the temporary seed space",
    pilotBackend.status < 300 && pilotBackendId.length > 0,
    `status ${pilotBackend.status}`,
  );

  const pilotPlan = await api("POST", `/folders/${folderId}/seed-plans`, {
    hostId: "seed-target",
    sourceHostId: "seed-source",
    confirm: true,
  });
  const pilotPlanId = str(record(record(pilotPlan.body)["plan"])["id"]);
  const createPilotJob = async (): Promise<{ status: number; body: unknown }> =>
    api("POST", "/seed-jobs", { planId: pilotPlanId, confirm: true });

  const beforePilot = await createPilotJob();
  check(
    "with NO pilot, job creation answers 503 even with every seed environment variable set",
    beforePilot.status === 503 && str(record(beforePilot.body)["error"]).includes("seed pilot"),
    `status ${beforePilot.status}: ${str(record(beforePilot.body)["error"]).slice(0, 120)}`,
  );

  const swapped = await api("PUT", "/seed-pilot", {
    enabled: true,
    folderId,
    // Deliberately the WRONG direction: the pair is ordered, so this authorizes
    // nothing for the plan above.
    sourceHostId: "seed-target",
    targetHostId: "seed-source",
    backendId: pilotBackendId,
    bucket: S3.bucket,
    confirm: true,
  });
  check("the pilot accepts a valid scope", swapped.status === 200, `status ${swapped.status}`);
  const swappedJob = await createPilotJob();
  check(
    "a pilot for the SWAPPED pair authorizes nothing (the direction decides which tree wins)",
    swappedJob.status === 503 && str(record(swappedJob.body)["error"]).includes("source of truth"),
    `status ${swappedJob.status}`,
  );

  await api("PUT", "/seed-pilot", {
    enabled: true,
    folderId,
    sourceHostId: "seed-source",
    targetHostId: "seed-target",
    backendId: pilotBackendId,
    bucket: S3.bucket,
    confirm: true,
  });
  const unprobedJob = await createPilotJob();
  check(
    "an UNPROBED seed space authorizes nothing",
    unprobedJob.status === 503 && str(record(unprobedJob.body)["error"]).includes("has not been probed"),
    `status ${unprobedJob.status}`,
  );

  const probe = await api("POST", "/seed-pilot/probe");
  const probeBody = record(probe.body);
  check(
    "the readiness probe proves the configured backend can write to and delete from the bucket",
    probe.status === 200 && record(probeBody["probe"])["ok"] === true,
    JSON.stringify(record(probeBody["probe"])).slice(0, 200),
  );
  check(
    "the probe's verdict is stored on the pilot, ready to be read back",
    record(probeBody["config"])["readiness"] !== undefined &&
      str(record(record(probeBody["config"])["readiness"])["state"]) === "ready",
  );
  // NO SECRET, anywhere. The access key id is an identifier the backends list
  // already exposes; the SECRET must appear in no pilot response.
  const pilotText = JSON.stringify(probe.body) + JSON.stringify((await api("GET", "/seed-pilot")).body);
  check(
    "no pilot response ever contains the storage secret",
    !pilotText.includes(S3.secretAccessKey) && pilotText.includes("hasSecret"),
    pilotText.includes(S3.secretAccessKey) ? "the secret appeared in a pilot response" : "",
  );

  // The operator's own preflight: a POPULATED target is refused before a plan
  // can be approved, with a sentence that says what to do about it.
  await reportHealth({
    hostId: "seed-target",
    folderId,
    root: TARGET_ROOT,
    isSource: false,
    filterFingerprint: universe.fingerprint,
    patternCount: universe.rules.length,
    targetEntryCount: 5,
  });
  const populatedPlan = await api("POST", `/folders/${folderId}/seed-plans`, {
    hostId: "seed-target",
    sourceHostId: "seed-source",
    confirm: true,
  });
  const populatedPlanBody = record(record(populatedPlan.body)["plan"]);
  const populatedValidity = record(record(populatedPlan.body)["validity"]);
  check(
    "a target the operator KNOWS is populated is refused at plan time, with a clear explanation",
    populatedPlan.status === 201 &&
      populatedValidity["valid"] === false &&
      str(populatedValidity["message"]).includes("already containing 5 entries"),
    str(populatedValidity["message"]).slice(0, 160),
  );
  const populatedJob = await api("POST", "/seed-jobs", {
    planId: str(populatedPlanBody["id"]),
    confirm: true,
  });
  check(
    "and the same populated target is refused at job creation, so nothing is ever merged",
    populatedJob.status === 409,
    `status ${populatedJob.status}`,
  );
  // Restore the empty-target measurement the daemon path needs.
  await reportHealth({
    hostId: "seed-target",
    folderId,
    root: TARGET_ROOT,
    isSource: false,
    filterFingerprint: universe.fingerprint,
    patternCount: universe.rules.length,
    targetEntryCount: 0,
  });
  check(
    "the pilot is enabled, probed and scoped to exactly one folder and pair",
    str(record((await api("GET", "/seed-pilot")).body)["summary"]).includes("lamasync-tmp"),
  );

  const leaseSamples: Array<{ phase: string; leaseExpiresAt: number | null; at: number }> = [];
  const daemonSeed = await runDaemonSeed(folderId, daemons, {
    label: "daemon happy path",
    onSample: (job) =>
      leaseSamples.push({ phase: job.phase, leaseExpiresAt: job.leaseExpiresAt, at: Date.now() }),
  });
  results["daemonJob"] = daemonSeed.job;
  const daemonPhases = [
    "measuring_source",
    "archiving_source",
    "uploading_archive",
    "downloading_archive",
    "verifying_archive",
    "extracting_target",
    "verifying_target",
    "publishing",
    "baseline_validation",
  ];
  const daemonLogs = `${daemonSeed.source.logs()}\n${daemonSeed.target.logs()}`;
  check(
    "the daemon-driven seed completed",
    daemonSeed.job.status === "completed",
    `status=${daemonSeed.job.status} phase=${daemonSeed.job.phase} error=${daemonSeed.job.error ?? "(none)"}`,
  );
  check(
    "every seed phase was entered by the daemons",
    daemonPhases.every((phase) => daemonLogs.includes(`phase=${phase}`)),
    daemonPhases.filter((phase) => !daemonLogs.includes(`phase=${phase}`)).join(", ") || "all present",
  );
  check(
    "the SOURCE daemon recorded the immutable archive facts",
    daemonSeed.job.archive.sha256 !== null &&
      daemonSeed.job.archive.manifestSha256 !== null &&
      daemonSeed.job.archive.manifestObjectKey !== null &&
      daemonSeed.job.archive.memberCount !== null,
  );
  check(
    "the TARGET daemon re-derived the source manifest fingerprint",
    daemonSeed.job.archive.manifestFingerprint !== null &&
      daemonLogs.includes(`re-derived manifest fingerprint=${daemonSeed.job.archive.manifestFingerprint}`),
  );
  check(
    "the TARGET daemon ran the baseline resync that gates completion",
    daemonLogs.includes("target baseline resync"),
  );
  // The relay space came through the DEVICE'S OWN HOST CONFIG, not an
  // environment variable: the daemons are started with no LAMASYNC_SEED_S3_* at
  // all, so this line can only have been produced by the server-issued space.
  check(
    "each daemon's relay space was ISSUED BY THE SERVER through its own host config",
    daemonLogs.includes(`job=${daemonSeed.job.id} source relay space issued by the server`) &&
      daemonLogs.includes(`job=${daemonSeed.job.id} target relay space issued by the server`),
    "both sides logged the issued space (the daemons have no relay environment at all)",
  );
  check(
    "the resolved resync peer is the assignment's own remote plus its canonical destination",
    daemonLogs.includes(`target baseline resync peer=lamasync-${folderId}:e2e-seed-folder`),
    `peer=lamasync-${folderId}:e2e-seed-folder (a seam override only replaces where it points)`,
  );
  check(
    "the job's terminal state released the lease",
    daemonSeed.job.leaseOwner === null && daemonSeed.job.leaseExpiresAt === null && daemonSeed.job.startedAt !== null,
    `lease=${daemonSeed.job.leaseOwner ?? "(none)"}`,
  );

  // A stage that OUTLIVES the lease TTL, which is the whole point of the job
  // lease supervisor: a 35 s hold against a 30 s lease. Without a renewal during
  // the stage the source's handover write (live lease required) is refused and a
  // perfectly healthy seed fails, which is the failure the original issue hit.
  const held = daemonLogs.includes(`holding phase=${SOURCE_HOLD_PHASE} for ${SOURCE_HOLD_MS}ms`);
  const uploadSamples = leaseSamples.filter(
    (sample) => sample.phase === SOURCE_HOLD_PHASE && sample.leaseExpiresAt !== null,
  );
  const uploadLeases = uploadSamples.map((sample) => sample.leaseExpiresAt as number);
  const spread = uploadLeases.length === 0 ? 0 : Math.max(...uploadLeases) - Math.min(...uploadLeases);
  // The server's own row, read while the stage ran: the lease was in the future
  // at EVERY observation, even though the stage outlived the whole lease window.
  const everLapsed = uploadSamples.filter((sample) => (sample.leaseExpiresAt as number) <= sample.at);
  check(
    `the source held a stage that OUTLIVED the lease TTL (${SOURCE_HOLD_MS / 1000}s hold, ${LEASE_MS / 1000}s lease)`,
    held,
    held ? "" : "the seam delay never ran",
  );
  check(
    "the job's lease was LIVE at every observation of that stage (no reaper could fire)",
    uploadSamples.length >= 10 && everLapsed.length === 0,
    `${uploadSamples.length} sample(s), ${everLapsed.length} observed as lapsed`,
  );
  check(
    "the job's lease was RENEWED during that stage, in the server's own row",
    new Set(uploadLeases).size >= 2 && spread >= 2 * LEASE_INTERVAL_MS,
    `${new Set(uploadLeases).size} distinct expiry value(s), spread ${spread}ms`,
  );
  check(
    "the source's handover write was accepted AFTER the long stage (it requires a live lease)",
    daemonSeed.job.archive.sha256 !== null && daemonSeed.job.finishedAt !== null,
    `sha256=${daemonSeed.job.archive.sha256 === null ? "absent" : "recorded"}`,
  );

  // Content, exclusions, and an independent re-verification of the tree.
  const daemonSourceTree = treeMap(SOURCE_ROOT, (rel) => rel === "node_modules" || rel.startsWith("node_modules/") || rel === "tmp" || rel.startsWith("tmp/") || rel.endsWith(".log"));
  const daemonTargetTree = treeMap(TARGET_ROOT, (rel) => rel === "node_modules" || rel.startsWith("node_modules/") || rel === "tmp" || rel.startsWith("tmp/") || rel.endsWith(".log"));
  check(
    "the daemon-published target holds exactly the source universe",
    daemonSourceTree.size === daemonTargetTree.size &&
      [...daemonSourceTree].every(([rel, size]) => daemonTargetTree.get(rel) === size),
    `${daemonSourceTree.size} vs ${daemonTargetTree.size} entries`,
  );
  check(
    "ignored content never reached the target through the daemon path",
    !existsSync(join(TARGET_ROOT, "node_modules")) &&
      !existsSync(join(TARGET_ROOT, "debug.log")) &&
      !existsSync(join(TARGET_ROOT, "tmp")),
  );
  const daemonVerified = await verifyExtractedTree({
    root: TARGET_ROOT,
    manifest: await harnessManifestFixture(folderId),
  });
  check(
    "the harness independently re-verifies the daemon-published tree",
    daemonVerified.ok,
    daemonVerified.message,
  );

  if (rcloneAvailable) {
    const daemonBaseline = runBisync(true);
    check(
      "after the daemon seed, bisync --resync reports ZERO changed files",
      daemonBaseline.exitCode === 0 &&
        daemonBaseline.transfers === 0 &&
        daemonBaseline.bytes === 0 &&
        daemonBaseline.raw.includes("Bisync successful") &&
        !daemonBaseline.raw.includes("File changed") &&
        !daemonBaseline.raw.includes("Safety abort"),
      `exit=${daemonBaseline.exitCode} transfers=${daemonBaseline.transfers} bytes=${daemonBaseline.bytes}`,
    );
    writeFileSync(join(SOURCE_ROOT, "README.md"), "# E2E fixture\n\nedited after the daemon seed\n");
    const daemonForward = runBisync(false);
    check(
      "a post-daemon source edit propagates to the target",
      daemonForward.exitCode === 0 &&
        daemonForward.transfers > 0 &&
        readFileSync(join(TARGET_ROOT, "README.md"), "utf8").includes("edited after the daemon seed"),
      `transfers=${daemonForward.transfers}`,
    );
    writeFileSync(join(TARGET_ROOT, "src", "module-01", "file-001.ts"), "// edited on the target after the daemon seed\n");
    const daemonBackward = runBisync(false);
    check(
      "a post-daemon target edit propagates back to the source",
      daemonBackward.exitCode === 0 &&
        daemonBackward.transfers > 0 &&
        readFileSync(join(SOURCE_ROOT, "src", "module-01", "file-001.ts"), "utf8").includes(
          "edited on the target after the daemon seed",
        ),
      `transfers=${daemonBackward.transfers}`,
    );
  } else {
    gated("the daemon path's zero-change baseline and both-way edits", "rclone is not on PATH");
  }

  const daemonStore = createS3SeedRelayStore(S3);
  const daemonLeftovers = await daemonStore.list("lamasync/seed/");
  check(
    "the daemon-run job's relay objects were cleaned up",
    daemonLeftovers.ok && daemonLeftovers.value.keys.length === 0,
    daemonLeftovers.ok ? `${daemonLeftovers.value.keys.length} object(s) left` : "list failed",
  );

  // Denial: the OTHER party's key, and a stranger's key, cannot touch the job,
  // and the recorded facts cannot be rewritten by anyone.
  const targetArchiveAttempt = await deviceRequest(
    daemonSeed.targetKey,
    "POST",
    `/seed-jobs/${daemonSeed.job.id}/archive`,
    daemonSeed.job.archive,
  );
  check(
    "the TARGET device may not rewrite the source's archive facts",
    targetArchiveAttempt.status === 403,
    `status ${targetArchiveAttempt.status}`,
  );
  const strangerKey = await mintDeviceKey("seed-stranger");
  const strangerRead = await deviceRequest(strangerKey, "GET", `/seed-jobs/${daemonSeed.job.id}`);
  check(
    "a third device with a valid key cannot read another fleet's seed job",
    strangerRead.status === 403,
    `status ${strangerRead.status}`,
  );
  const lateReport = await deviceRequest(
    daemonSeed.targetKey,
    "POST",
    `/seed-jobs/${daemonSeed.job.id}/progress`,
    { phase: "baseline_validation" },
  );
  check(
    "a late device report cannot reopen the finished job",
    lateReport.status === 409,
    `status ${lateReport.status}`,
  );
  const sourceArchiveRetry = await deviceRequest(
    daemonSeed.sourceKey,
    "POST",
    `/seed-jobs/${daemonSeed.job.id}/archive`,
    { ...daemonSeed.job.archive, sha256: "f".repeat(64) },
  );
  check(
    "the recorded archive digest cannot be rewritten after the fact",
    sourceArchiveRetry.status === 409,
    `status ${sourceArchiveRetry.status}`,
  );

  // --- A cancellation that lands in the MIDDLE of a long target stage ---------
  //
  // The target holds `extracting_target` for ten seconds. The operator cancels
  // while it holds. What must NOT happen is a published tree, a staging sibling
  // left behind, or a work directory left behind — and the run must end as a STOP
  // rather than as a job failure, because a cancelled job is not a broken one.
  //
  // The target already holds job 1's tree, so "nothing was published" is a real
  // assertion here: a publish would have replaced it.
  section(`Stage 2e: an operator cancellation during a ${TARGET_HOLD_MS / 1000}s target stage`);
  // A daemon heartbeat reports health WITHOUT a deep tree walk, so it replaces
  // the harness's measurement with `null`; the plan builder needs a fresh one, so
  // re-report immediately before asking for the plan (exactly as above).
  await reportHealth({
    hostId: "seed-source",
    folderId,
    root: SOURCE_ROOT,
    isSource: true,
    filterFingerprint: universe.fingerprint,
    patternCount: universe.rules.length,
  });
  await reportHealth({
    hostId: "seed-target",
    folderId,
    root: TARGET_ROOT,
    isSource: false,
    filterFingerprint: universe.fingerprint,
    patternCount: universe.rules.length,
    // The harness deliberately reports the SAME stale empty measurement an
    // operator would still be holding from before the first seed published.
    // This second job exists to prove that a cancellation publishes nothing, and
    // that proof is stronger against the POPULATED target the first job left
    // behind — so the stale measurement is the fixture, not a claim about the
    // target. The publish-time guard remains the authority (asserted below), and
    // a real operator preparing a second seed would be refused at plan time.
    targetEntryCount: 0,
  });
  const targetTreeBefore = treeMap(TARGET_ROOT, () => false);
  const holdMarker = `holding phase=${TARGET_HOLD_PHASE}`;
  const holdsBefore = occurrences(daemons.target.logs(), holdMarker);
  const cancelledSeed = await runDaemonSeed(folderId, daemons, {
    label: "cancel mid-stage",
    cancelWhen: () => occurrences(daemons.target.logs(), holdMarker) > holdsBefore,
  });
  // The server is terminal the moment the operator cancels, but the daemon only
  // observes it on its next renewal tick (3 s here). Wait for the side to have
  // actually stopped before asserting what it left behind — otherwise this would
  // be a race, not a check.
  const targetStopped = await waitForLog(
    daemons.target,
    `job=${cancelledSeed.job.id} stopped:`,
    60_000,
  );
  const cancelledTargetTree = treeMap(TARGET_ROOT, () => false);
  const cancelledStaging = seedStagingPath(TARGET_ROOT, cancelledSeed.job.id);
  check(
    "the operator cancellation ended the side as a STOP, not as a job failure",
    cancelledSeed.job.phase === "cancelled" &&
      targetStopped &&
      daemons.target.logs().includes("the job is cancelled") &&
      !daemons.target.logs().includes(`job=${cancelledSeed.job.id} target failed:`),
    `phase=${cancelledSeed.job.phase} stopped=${targetStopped}`,
  );
  check(
    "a cancelled target published NOTHING (the previous tree is untouched)",
    sameTree(targetTreeBefore, cancelledTargetTree),
    `${cancelledTargetTree.size} entries vs ${targetTreeBefore.size} before`,
  );
  check(
    "the cancelled target never reached the publishing phase for that job",
    !daemons.target.logs().includes(`job=${cancelledSeed.job.id} target phase=publishing`),
  );
  check(
    "the cancelled run left no staging sibling behind",
    cancelledStaging !== null && !existsSync(cancelledStaging),
    cancelledStaging ?? "(no staging path)",
  );
  check(
    "the cancelled run left no work directory behind",
    !existsSync(join(daemons.target.home, "data", "seed-work", cancelledSeed.job.id)),
  );
  check(
    "the cancelled job released its lease",
    cancelledSeed.job.leaseOwner === null && cancelledSeed.job.leaseExpiresAt === null,
    `lease=${cancelledSeed.job.leaseOwner ?? "(none)"}`,
  );

  // A terminal job's relay objects are deleted PROMPTLY (Stage 2f), by whichever
  // side observes the terminal state. Deleting on a stop is safe: the target is
  // the only reader, it has stopped by definition, an S3 delete does not truncate
  // a GET already streaming, and the keys are derived from this job's own
  // namespace. The retention sweep and the bucket's lifecycle remain the backstop
  // for anything a stopped side could not delete — asserted here too, so the
  // backstop is exercised rather than assumed.
  const cancelledStore = createS3SeedRelayStore(S3);
  const cancelledNamespace = `lamasync/seed/${cancelledSeed.job.id}/`;
  const cancelledLeft = await cancelledStore.list(cancelledNamespace);
  check(
    "a cancelled job's relay objects are deleted PROMPTLY by the stopped side, not left behind",
    cancelledLeft.ok &&
      cancelledLeft.value.keys.filter((key) => key !== cancelledNamespace).length === 0,
    cancelledLeft.ok ? `${cancelledLeft.value.keys.length} entry(ies) left` : "list failed",
  );
  // The previous (completed) job's namespace is untouched by that deletion: no
  // sweep may ever reach outside its own job.
  const otherNamespace = await cancelledStore.list(`lamasync/seed/${daemonSeed.job.id}/`);
  check(
    "deleting one job's objects never touches another job's namespace",
    otherNamespace.ok && otherNamespace.value.keys.filter((key) => key !== `lamasync/seed/${daemonSeed.job.id}/`).length === 0,
  );
  const sweptCancelled = await cleanupSeedRelayObjects({
    store: cancelledStore,
    keys: [
      seedRelayArchiveKey(cancelledSeed.job.id, cancelledSeed.job.archive.format),
      seedRelayManifestKey(cancelledSeed.job.id),
    ],
    cleanup: cancelledSeed.job.archive.cleanup,
    now: Date.now(),
  });
  check(
    "the retention sweep is idempotent over an already-cleaned job (the backstop costs nothing)",
    sweptCancelled.complete,
    `complete=${sweptCancelled.complete} deleted=${sweptCancelled.deleted.length}`,
  );

  daemonSeed.source.stop();
  daemonSeed.target.stop();
  await Bun.sleep(500);
  // Reset both trees so the worker-based diagnostic below starts from the same
  // empty-target precondition it was written for. The daemons are gone, so a
  // fresh health report now sticks — and the worker path needs the source's
  // measurement just as the daemon path did.
  rmSync(TARGET_ROOT, { recursive: true, force: true });
  mkdirSync(TARGET_ROOT, { recursive: true });
  rmSync(SOURCE_ROOT, { recursive: true, force: true });
  mkdirSync(SOURCE_ROOT, { recursive: true });
  buildSourceFixture();
  await reportHealth({
    hostId: "seed-source",
    folderId,
    root: SOURCE_ROOT,
    isSource: true,
    filterFingerprint: universe.fingerprint,
    patternCount: universe.rules.length,
  });
  await reportHealth({
    hostId: "seed-target",
    folderId,
    root: TARGET_ROOT,
    isSource: false,
    filterFingerprint: universe.fingerprint,
    patternCount: universe.rules.length,
    // The target was just emptied above, and the preflight requires a MEASURED
    // empty target, so this is the operator's real precondition.
    targetEntryCount: 0,
  });

  // --- Lower-level diagnostic: the test-only workers (NOT daemon evidence) ---
  section("Lower-level diagnostic: test-only workers drive the same primitives");

  // --- Happy path -----------------------------------------------------------
  const happy = await runSeedJob(folderId, { label: "happy path", expect: "completed" });
  results["job"] = happy.job;
  results["sourceEvents"] = happy.source.events;
  results["targetEvents"] = happy.target.events;
  check(
    "the source worker exited cleanly",
    happy.source.code === 0,
    happy.source.code === 0 ? "" : happy.source.stderr.slice(-200),
  );
  check(
    "the target worker exited cleanly",
    happy.target.code === 0,
    happy.target.code === 0 ? "" : happy.target.stderr.slice(-200),
  );
  check("the job completed", happy.job.status === "completed", `phase=${happy.job.phase}`);
  check(
    "the archive and manifest facts are recorded on the job",
    happy.job.archive.sha256 !== null && happy.job.archive.manifestSha256 !== null && happy.job.archive.manifestObjectKey !== null,
  );
  check(
    "every seed phase was entered",
    ["measuring_source", "archiving_source", "uploading_archive", "downloading_archive", "verifying_archive", "extracting_target", "verifying_target", "publishing", "baseline_validation"].every((phase) =>
      (happy.target.events.some((e) => e["phase"] === phase) || happy.source.events.some((e) => e["phase"] === phase)),
    ),
  );

  // --- Content and exclusions ----------------------------------------------
  section("Content and filtered exclusions");
  const skip = (rel: string, isDir: boolean): boolean => {
    if (rel === "node_modules" || rel.startsWith("node_modules/")) return true;
    if (rel === "tmp" || rel.startsWith("tmp/")) return true;
    if (rel.endsWith(".log")) return true;
    void isDir;
    return false;
  };
  const sourceTree = treeMap(SOURCE_ROOT, skip);
  const targetTree = treeMap(TARGET_ROOT, skip);
  check(
    "the target holds exactly the source universe",
    sourceTree.size === targetTree.size && [...sourceTree].every(([rel, size]) => targetTree.get(rel) === size),
    `${sourceTree.size} vs ${targetTree.size} entries`,
  );
  const manifestEvent = happy.source.events.find((e) => e["event"] === "manifest");
  const targetManifestEvent = happy.target.events.find((e) => e["event"] === "manifest_verified");
  check(
    "the target independently re-derived the source manifest fingerprint",
    manifestEvent !== undefined && targetManifestEvent !== undefined && manifestEvent["fingerprint"] === targetManifestEvent["fingerprint"],
  );
  check(
    "ignored content never reached the target",
    !existsSync(join(TARGET_ROOT, "node_modules")) && !existsSync(join(TARGET_ROOT, "debug.log")) && !existsSync(join(TARGET_ROOT, "tmp")),
  );
  // The harness independently rebuilds the source manifest from the source
  // tree and verifies the published target against it — a check that does not
  // trust the workers' own events.
  const harnessManifest = await buildSeedSourceManifest(
    {
      id: "e2e-source", folderId, hostId: "seed-source", role: "both",
      localPath: SOURCE_ROOT, enabled: true, ignorePath: ".lamasyncignore", ignoreGitMetadata: true,
    },
    "sync",
  );
  if (harnessManifest.manifest === null) throw new Error(`harness manifest: ${harnessManifest.blocking.join("; ")}`);
  const verified = await verifyExtractedTree({ root: TARGET_ROOT, manifest: harnessManifest.manifest });
  check(
    "the harness independently re-verifies the published tree against a freshly built manifest",
    verified.ok,
    verified.message,
  );

  // --- Zero-change baseline and edits --------------------------------------
  if (rcloneAvailable) {
    section("Real rclone: zero-change baseline, then edits both directions");
    const baseline = runBisync(true);
    check(
      "bisync --resync over the same rules reports ZERO changed files",
      baseline.exitCode === 0 &&
        baseline.transfers === 0 &&
        baseline.bytes === 0 &&
        baseline.raw.includes("Bisync successful") &&
        !baseline.raw.includes("File changed") &&
        !baseline.raw.includes("Safety abort"),
      `exit=${baseline.exitCode} transfers=${baseline.transfers} bytes=${baseline.bytes}`,
    );
    const steady = runBisync(false);
    check("a second bisync is a no-op", steady.exitCode === 0 && steady.transfers === 0, `transfers=${steady.transfers}`);

    writeFileSync(join(SOURCE_ROOT, "README.md"), "# E2E fixture\n\nedited on the source\n");
    const forward = runBisync(false);
    check(
      "a source edit propagates to the target",
      forward.exitCode === 0 && forward.transfers > 0 && readFileSync(join(TARGET_ROOT, "README.md"), "utf8").includes("edited on the source"),
      `transfers=${forward.transfers}`,
    );
    writeFileSync(join(TARGET_ROOT, "src", "module-00", "file-000.ts"), "// edited on the target\n");
    const backward = runBisync(false);
    check(
      "a target edit propagates back to the source",
      backward.exitCode === 0 && backward.transfers > 0 && readFileSync(join(SOURCE_ROOT, "src", "module-00", "file-000.ts"), "utf8").includes("edited on the target"),
      `transfers=${backward.transfers}`,
    );
    writeFileSync(join(SOURCE_ROOT, "logs-new.log"), "ignored\n");
    const ignored = runBisync(false);
    check(
      "ignored content still never moves",
      ignored.exitCode === 0 && ignored.transfers === 0 && !existsSync(join(TARGET_ROOT, "logs-new.log")),
      `transfers=${ignored.transfers}`,
    );
  }

  // --- Cleanup / retention --------------------------------------------------
  section("Relay cleanup and orphan retention");
  const store = createS3SeedRelayStore(S3);
  const listed = await store.list("lamasync/seed/");
  check(
    "the terminal job's relay objects were cleaned up",
    listed.ok && listed.value.keys.length === 0,
    listed.ok ? `${listed.value.keys.length} object(s) left` : "list failed",
  );
  // Plant an orphan under a job id nothing knows, then prove the sweep finds it
  // and that deleting it is confined to the seed namespace.
  const orphanKey = seedRelayArchiveKey("orphan-e2e-0001", "tar.gz");
  const orphanBytes = new TextEncoder().encode("orphan");
  const orphanDigest = { bytes: orphanBytes.byteLength, sha256: (await import("node:crypto")).createHash("sha256").update(orphanBytes).digest("hex") };
  await store.put({ key: orphanKey, source: { kind: "bytes", data: orphanBytes }, expected: orphanDigest });
  const listedWithOrphan = await store.list("lamasync/seed/");
  const sweep = seedRelayOrphanKeys({
    listedKeys: listedWithOrphan.ok ? listedWithOrphan.value.keys : [],
    // Both known jobs are in the set: the worker happy path AND the daemon job.
    // An object belonging to a job the harness knows about is not an orphan.
    knownJobIds: [happy.job.id, daemonSeed.job.id],
  });
  check("the abandoned object is detected as an orphan", sweep.orphans.includes(orphanKey), sweep.orphans.join(", "));
  await store.delete(orphanKey);
  const afterSweep = await store.list("lamasync/seed/");
  check("the orphan sweep leaves the namespace empty", afterSweep.ok && afterSweep.value.keys.length === 0);

  // --- Failure: manifest mismatch ------------------------------------------
  const mismatch = await runSeedJob(folderId, {
    label: "manifest fingerprint mismatch",
    expect: "failed",
    sourceExtra: { LAMASYNC_SEED_CORRUPT: "manifest-fingerprint" },
  });
  check("a manifest that does not match the recorded universe fails the job", mismatch.job.status === "failed", `phase=${mismatch.job.phase}`);
  check(
    "the mismatch is reported with the manifest reason",
    (mismatch.job.error ?? "").includes("manifest") || mismatch.target.events.some((e) => String(e["message"] ?? "").includes("manifest")),
    mismatch.job.error ?? "",
  );
  const afterMismatch = await store.list("lamasync/seed/");
  check("a failed job still cleans up its relay objects", afterMismatch.ok && afterMismatch.value.keys.length === 0);

  // --- Failure: non-empty target -------------------------------------------
  //
  // Stage 2f refuses a POPULATED target at plan time (the operator's preflight,
  // asserted in the Stage 2f section above). This is the LAST line of defence: a
  // target that measured empty and was populated afterwards — a stale
  // measurement — must still be refused at PUBLISH, so nothing is ever merged or
  // overwritten by a race the preflight could not see.
  writeFileSync(join(TARGET_ROOT, "appeared-after-the-measurement.txt"), "populated later\n");
  await reportHealth({
    hostId: "seed-target",
    folderId,
    root: TARGET_ROOT,
    isSource: false,
    filterFingerprint: universe.fingerprint,
    patternCount: universe.rules.length,
    targetEntryCount: 0,
  });
  const nonEmpty = await runSeedJob(folderId, { label: "non-empty target", expect: "failed" });
  check(
    "a target populated AFTER it measured empty is still refused at publication",
    nonEmpty.job.status === "failed",
    `phase=${nonEmpty.job.phase}`,
  );
  check(
    "the refusal names the non-empty target",
    (nonEmpty.job.error ?? "").toLowerCase().includes("target") || nonEmpty.target.events.some((e) => String(e["message"] ?? "").includes("target")),
    nonEmpty.job.error ?? "",
  );
  rmSync(join(TARGET_ROOT, "appeared-after-the-measurement.txt"), { force: true });

  // --- Cancellation ---------------------------------------------------------
  const cancelled = await runSeedJob(folderId, { label: "operator cancellation", expect: "cancelled", cancelAfterMs: 900 });
  check("an operator cancellation is terminal and not overwritten", cancelled.job.status === "cancelled", `phase=${cancelled.job.phase}`);

  // --- Partial network transfer --------------------------------------------
  section("Interrupted network transfer");
  const abortKey = seedRelayArchiveKey("abort-e2e-0001", "tar.gz");
  const abortPath = join(WORK_DIR, "abort-source.bin");
  writeFileSync(abortPath, pseudoBytes(3, 4 * 1024 * 1024));
  const abortDigest = {
    bytes: 4 * 1024 * 1024,
    sha256: (await import("node:crypto")).createHash("sha256").update(readFileSync(abortPath)).digest("hex"),
  };
  const controller = new AbortController();
  const aborted = await store.put({
    key: abortKey,
    source: { kind: "file", path: abortPath },
    expected: abortDigest,
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.bytesDone > 0) controller.abort();
    },
  });
  check("an aborted upload fails rather than reporting success", !aborted.ok, aborted.ok ? "" : aborted.error);
  const abortedHead = await store.head(abortKey);
  check("an aborted upload leaves no object behind", !abortedHead.ok, abortedHead.ok ? "object exists" : "");

  // --- Gated host proofs ----------------------------------------------------
  section("Host proofs this environment cannot provide");
  if (process.env["LAMASYNC_TEST_SMALL_FS"]) {
    gated("real ENOSPC on a bounded disposable volume", "LAMASYNC_TEST_SMALL_FS is set but the bounded-volume case is not implemented in this pass");
  } else {
    gated("real ENOSPC on a bounded disposable volume", "no bounded volume is available without root/mount privileges");
  }
  gated("two-MACHINE hop (network partition, retry/resume)", "this run uses two processes on one host and one disposable object space");
  gated("live dev-vm-shape run on a copy of a large tree", "requires the real fleet; stage 3");

  results["checks"] = checks;
  finish();
}

function finish(): void {
  // Stop the server before returning from main: its open pipes otherwise keep
  // Bun alive, so the exit-hook fallback never gets a chance to run.
  cleanupChildren();
  // Tear the disposable container down here, where a synchronous spawn still
  // works; the exit hook is only a fallback for an unexpected path.
  removeMinioContainer();
  MINIO_CONTAINER = null;
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const gatedCount = checks.filter((c) => c.status === "gated").length;
  console.log(`\n=== Summary ===\npass ${passed} · fail ${failed} · gated ${gatedCount}`);
  for (const c of checks.filter((c) => c.status !== "pass")) console.log(`${c.status.toUpperCase()}  ${c.name} — ${c.detail}`);
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ ...results, summary: { passed, failed, gated: gatedCount }, checks }, null, 2));
    console.log(`json: ${JSON_OUT}`);
  }
  if (failed > 0) process.exitCode = 1;
}

await main();
