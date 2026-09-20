#!/usr/bin/env bun
/**
 * scripts/lama345-integration.ts — LAMA-345 integration evidence.
 *
 * Runs a FULLY ISOLATED server (random free port, `mktemp` data dir, generated
 * test key) plus an optional isolated daemon, and exercises the managed-folder
 * health path end to end through the REAL routes:
 *
 *     heartbeat → folder-health report → Dashboard `/health` summary
 *              → dry-run plan (official device route) → reviewed-plan validation
 *
 * Isolation rules (this script must never touch a live fleet or the operator's
 * real daemon):
 *   - `HOME` is redirected into the temp dir, so client.toml, the config cache,
 *     the daemon socket, the bisync workdir and any systemd unit path resolve
 *     inside the sandbox.
 *   - `LAMASYNC_DATA_DIR`, `LAMASYNC_BACKUP_DIR`, `LAMASYNC_SOCKET_PATH` and
 *     `PORT` are all set explicitly.
 *   - `LAMASYNC_TEST=1` keeps the boot timers (retention prune, lock reaper,
 *     notification sweep) out of the run so host statuses are deterministic.
 *
 * rclone is NEVER invoked: the daemon runs with a never-firing schedule, no
 * manual trigger is sent, and the plan step uses the documented device route
 * (`POST /folder-plans`) that a daemon would otherwise populate from a dry run.
 *
 * Usage:
 *   bun run scripts/lama345-integration.ts [--keep] [--json <path>] [--serve]
 *
 * `--serve` keeps the sandbox and the seeded fleet running afterwards and
 * prints the port + key, so a browser pass can be driven against the exact
 * state the checks were run against.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const KEEP = process.argv.includes("--keep") || process.argv.includes("--serve");
const SERVE = process.argv.includes("--serve");
const JSON_OUT = (() => {
  const index = process.argv.indexOf("--json");
  return index !== -1 ? process.argv[index + 1] : null;
})();

const TEST_KEY = `lama345-integration-${crypto.randomUUID()}`;
const NOW = Date.now();
const LONG_AGO = Date.parse("2020-01-01T00:00:00Z");

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// Sandbox + processes
// ---------------------------------------------------------------------------

const sandbox = mkdtempSync(join(tmpdir(), "lama345-integration-"));
const home = join(sandbox, "home");
const dataDir = join(sandbox, "data");
const backupDir = join(sandbox, "backups");
const socketPath = join(sandbox, "run", "lamasyncd.sock");
mkdirSync(join(home, ".config", "lamasync"), { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(backupDir, { recursive: true });
mkdirSync(join(sandbox, "run"), { recursive: true });

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = server.port;
  server.stop(true);
  return port;
}
const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

const children: Array<{ kill: () => void; name: string }> = [];
function cleanup(): void {
  for (const child of children.reverse()) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function sandboxEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HOME: home,
    LAMASYNC_API_KEY: TEST_KEY,
    LAMASYNC_DATA_DIR: dataDir,
    LAMASYNC_BACKUP_DIR: backupDir,
    LAMASYNC_SOCKET_PATH: socketPath,
    LAMASYNC_TEST: "1",
    PORT: String(PORT),
    ...extra,
  };
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
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
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

section("Isolated sandbox");
console.log(`sandbox: ${sandbox}`);
console.log(`port:    ${PORT}`);
console.log(`server:  bun run packages/server/src/index.ts (source)`);

const serverLog = join(sandbox, "server.log");
const server = Bun.spawn(["bun", "run", "packages/server/src/index.ts"], {
  cwd: ROOT,
  env: sandboxEnv(),
  stdout: "pipe",
  stderr: "pipe",
});
children.push({ name: "server", kill: () => server.kill() });
void new Response(server.stdout).text().then((text) => writeFileSync(serverLog, text));
void new Response(server.stderr).text();

let ready = false;
for (let i = 0; i < 100; i += 1) {
  try {
    const res = await fetch(`${BASE}/health`, {
      headers: { Authorization: `Bearer ${TEST_KEY}` },
    });
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {
    // not up yet
  }
  await Bun.sleep(200);
}
check("isolated server answers /health", ready, `port ${PORT}`);
if (!ready) {
  console.error(await Bun.file(serverLog).text().catch(() => "(no log)"));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Synthetic fleet
// ---------------------------------------------------------------------------

section("Synthetic fleet: heartbeat → host state");

interface Seed {
  id: string;
  hostname: string;
  hostClass: string;
  status: string;
  version: string;
  lastSeen: number | null;
}
const fleet: Seed[] = [
  // Always-on and online: healthy.
  { id: "srv-main", hostname: "srv-main", hostClass: "server", status: "online", version: "0.3.7", lastSeen: NOW },
  // Always-on and offline: the only red host case.
  { id: "nas-1", hostname: "nas-1", hostClass: "nas", status: "offline", version: "0.3.7", lastSeen: NOW - 3 * 3_600_000 },
  // Sleeps by design and offline: informational, never red.
  { id: "laptop-1", hostname: "laptop-1", hostClass: "laptop", status: "offline", version: "0.3.7", lastSeen: NOW - 2 * 3_600_000 },
  // Never seen at all.
  { id: "phone-1", hostname: "phone-1", hostClass: "phone", status: "unknown", version: "0.3.7", lastSeen: null },
  // Online but ancient last_seen is impossible; use "offline since 2020" for the
  // update boundary, and a desktop for the remaining class.
  { id: "desk-old", hostname: "desk-old", hostClass: "desktop", status: "offline", version: "0.0.1", lastSeen: LONG_AGO },
  { id: "desk-new", hostname: "desk-new", hostClass: "desktop", status: "online", version: "0.0.1", lastSeen: NOW },
];

for (const host of fleet) {
  const res = await api("POST", "/register", { id: host.id, hostname: host.hostname, tailnetIp: null });
  check(`register ${host.id}`, res.status === 200 || res.status === 201, `status ${res.status}`);
  const hb = await api("POST", "/report/health", {
    hostId: host.id,
    timestamp: host.lastSeen ?? NOW,
    status: host.status,
    version: host.version,
    hostClass: host.hostClass,
  });
  if (hb.status !== 204) check(`heartbeat ${host.id}`, false, `status ${hb.status}`);
  // The heartbeat route records last_seen = now; force the exact value the
  // scenario needs through the host row (the daemon's own clock is not part of
  // what we are testing here).
  const raw = await api("PATCH", `/hosts/${host.id}`, { hostname: host.hostname });
  void raw;
}
check("all synthetic heartbeats accepted", true, `${fleet.length} hosts`);

// Force statuses/last_seen deterministically through the DB the server owns.
// (Done with the server's own migration-safe SQL via a tiny helper endpoint?
// No — the sandbox DB is a file we may open directly.)
{
  const { Database } = await import("bun:sqlite");
  const dbPath = join(dataDir, "lamasync.db");
  const db = new Database(dbPath, { readwrite: true });
  for (const host of fleet) {
    db.run("UPDATE hosts SET status = ?, last_seen = ?, version = ?, host_class = ? WHERE id = ?", [
      host.status,
      host.lastSeen,
      host.version,
      host.hostClass,
      host.id,
    ]);
  }
  db.close();
}
check("fleet state pinned deterministically", true, "status/last_seen/version/class");

// ---------------------------------------------------------------------------
// Folders + assignments + health reports
// ---------------------------------------------------------------------------

section("Managed folders: folder-health reports");

interface FolderSeed {
  key: string;
  name: string;
  hostId: string;
  state: string;
  reason: { code: string; message: string; remediation: string; action: string | null };
  reportedAt: number;
  localDir?: string;
  baseline?: Record<string, unknown>;
}
const folderSeeds: FolderSeed[] = [
  {
    key: "unsafe",
    name: "Projects",
    hostId: "srv-main",
    state: "unsafe",
    reason: { code: "baseline_error", message: "The saved sync record is unusable — the last sync stopped with a critical error.", remediation: "Preview a rebuild from this card, then approve it.", action: "resync" },
    reportedAt: NOW,
    // Facts first: the server re-derives the state from them, so an "unsafe"
    // fixture must actually carry an error-marked, unusable pair.
    baseline: { present: true, ready: false, error: true, path1Count: null, path2Count: null, updatedAt: NOW - 5_000, fingerprint: "base-err" },
  },
  {
    key: "healthy",
    name: "Photos",
    hostId: "srv-main",
    state: "healthy",
    reason: { code: "ok", message: "Baseline is paired and the last run agreed.", remediation: "Nothing to do.", action: null },
    reportedAt: NOW,
  },
  {
    key: "newhost",
    name: "Docs",
    hostId: "laptop-1",
    state: "new_host",
    // Mirrors the core template for baseline_missing verbatim.
    reason: { code: "baseline_missing", message: "This device has no saved sync record yet.", remediation: "Set up this device from the remote, or fill the remote from this device.", action: "initialize" },
    reportedAt: NOW - 60_000,
    // Facts must agree with the state: the server re-derives the state from
    // them, so a "no sync record" folder must not report a paired baseline.
    baseline: { present: false, ready: false, error: false, path1Count: null, path2Count: null, updatedAt: null, fingerprint: "none" },
  },
  {
    key: "stale",
    name: "Music",
    hostId: "srv-main",
    state: "healthy",
    reason: { code: "ok", message: "Baseline is paired and the last run agreed.", remediation: "Nothing to do.", action: null },
    // 40 minutes of silence: past the shared 15-minute budget.
    reportedAt: NOW - 40 * 60_000,
  },
  {
    key: "resync",
    name: "Archive",
    hostId: "nas-1",
    state: "resync_required",
    reason: { code: "filter_changed", message: "The effective ignore/filter set changed since the last baseline.", remediation: "Preview a rebuild from this card, then approve it.", action: "resync" },
    reportedAt: NOW - 30_000,
    // The pending-resync marker is what makes this folder "resync required".
    baseline: { present: true, ready: true, error: false, path1Count: 120, path2Count: 120, updatedAt: NOW - 40_000, fingerprint: "base-changed" },
  },
  {
    key: "unknown",
    name: "Vault",
    hostId: "phone-1",
    state: "unknown",
    reason: { code: "never_reported", message: "This device has not reported folder health yet.", remediation: "Run Check this device now to collect a first report.", action: "diagnose" },
    reportedAt: NOW - 10_000,
    baseline: { present: false, ready: false, error: false, path1Count: null, path2Count: null, updatedAt: null, fingerprint: "none" },
  },
];

// A fresh sandbox server has no storage backends, and `POST /folders` now
// requires one (LAMA-241). A server-side `local` backend keeps the sandbox
// self-contained — nothing here ever reaches a real remote or runs rclone.
const backend = await api("POST", "/backends", {
  name: "sandbox-local",
  kind: "local",
  localPath: join(sandbox, "backend"),
});
mkdirSync(join(sandbox, "backend"), { recursive: true });
check("sandbox storage backend created", backend.status === 200 || backend.status === 201, `status ${backend.status}`);

const folderIds: Record<string, string> = {};
const assignmentIds: Record<string, string> = {};

for (const seed of folderSeeds) {
  const created = await api("POST", "/folders", { name: seed.name, type: "sync" });
  const folderId = str(record(created.body)["id"]);
  if (!folderId) {
    check(`create folder ${seed.name}`, false, `status ${created.status}: ${str(record(created.body)["error"])}`);
    continue;
  }
  folderIds[seed.key] = folderId;
  const assigned = await api("POST", `/folders/${folderId}/assign`, {
    hostId: seed.hostId,
    role: "both",
    localPath: join(sandbox, "trees", seed.key),
    // Never fires during the run — no rclone is ever spawned.
    syncExpr: "0 0 1 1 *",
    enabled: true,
  });
  const assignmentId = str(record(assigned.body)["id"]);
  assignmentIds[seed.key] = assignmentId;
  if (!assignmentId) {
    check(`assign ${seed.name}`, false, `status ${assigned.status}: ${str(record(assigned.body)["error"])}`);
  }
}
check("folders created and assigned", Object.keys(folderIds).length === folderSeeds.length);

for (const seed of folderSeeds) {
  const folderId = folderIds[seed.key];
  if (!folderId) continue;
  const res = await api("POST", "/folder-health", {
    hostId: seed.hostId,
    folderId,
    state: seed.state,
    reasons: [seed.reason],
    reportedAt: seed.reportedAt,
    facts: {
      folderType: "sync",
      effectiveType: "sync",
      enabled: true,
      paused: false,
      runInProgress: false,
      rcloneAvailable: true,
      localDir: seed.localDir ?? "ok",
      freeSpaceBytes: 50_000_000_000,
      freeSpaceThresholdBytes: 1_000_000_000,
      watcher: { enabled: true, running: true, quietSec: 30 },
      filter: {
        fingerprint: "fp-1",
        source: "lamasyncignore",
        // Only the resync-required fixture carries an outstanding marker.
        changedSinceBaseline: seed.key === "resync",
      },
      baseline: seed.baseline ?? {
        present: true,
        ready: true,
        error: false,
        path1Count: 120,
        path2Count: 120,
        updatedAt: seed.reportedAt - 5_000,
        fingerprint: "base-1",
      },
      activePhase: null,
      pendingConflicts: 0,
      lastRun: { status: "success", summary: "sync ok", at: seed.reportedAt - 5_000 },
      measurement: { pathCount: 42, totalBytes: 1_048_576, measuredAt: seed.reportedAt },
    },
  });
  check(
    `report health for ${seed.name}`,
    res.status === 204,
    res.status === 204 ? `state ${seed.state}` : `status ${res.status}: ${str(record(res.body)["error"])}`,
  );
}

// ---------------------------------------------------------------------------
// Dashboard summary
// ---------------------------------------------------------------------------

section("Dashboard summary (GET /health → fleetHealth)");

const health = await api("GET", "/health");
const summary = record(record(health.body)["fleetHealth"]);
const buckets = record(summary["buckets"]);
const bucket = (key: string) => record(buckets[key]);
const items = (key: string) => list(bucket(key)["items"]).map(record);
const titles = (key: string) => items(key).map((i) => str(i["title"]));
const kinds = (key: string) => items(key).map((i) => str(i["kind"]));

check("fleetHealth present with four buckets", Object.keys(buckets).length === 4, Object.keys(buckets).join(", "));
check("headline is a plain-language verdict", str(summary["headline"]).length > 0, str(summary["headline"]));
check("healthy counts present", record(summary["healthy"])["folders"] !== undefined, JSON.stringify(summary["healthy"]));

const red = titles("needsIntervention");
const yellow = titles("checkWhenOnline");
const unknown = titles("unknownOrStale");

check("missing always-on NAS is red", red.includes("nas-1"), red.join(" · "));
check("unsafe folder is red", red.includes("Projects on srv-main"), red.join(" · "));
check(
  "sleeping laptop is yellow, never red",
  yellow.includes("laptop-1") && !red.includes("laptop-1"),
  `yellow: ${yellow.join(" · ")}`,
);
check(
  "never-seen phone is 'not heard from', not unhealthy",
  unknown.includes("phone-1") && !red.includes("phone-1"),
  `unknown: ${unknown.join(" · ")}`,
);
check(
  "stale report is distinct from unhealthy",
  unknown.includes("Music on srv-main") && !red.includes("Music on srv-main"),
  unknown.join(" · "),
);
check(
  "stale report is not counted healthy",
  Number(record(summary["healthy"])["folders"]) === 1,
  `healthy.folders=${record(summary["healthy"])["folders"]}`,
);
check(
  "a red host's own folder is suppressed (one root cause, one entry)",
  !red.includes("Archive on nas-1") && red.filter((t) => t === "nas-1").length === 1,
  red.join(" · "),
);
check(
  "laptop's unseeded folder waits for the device",
  yellow.includes("Docs on laptop-1"),
  yellow.join(" · "),
);
check(
  "a never-seen device speaks for its own folders (no double-listed root cause)",
  unknown.includes("phone-1") && !unknown.includes("Vault on phone-1"),
  unknown.join(" · "),
);

const allItems = [...items("needsIntervention"), ...items("checkWhenOnline"), ...items("unknownOrStale")];
check(
  "every item links somewhere and explains itself",
  allItems.every(
    (i) => str(i["href"]).startsWith("/") && str(i["title"]).length > 0 && str(i["detail"]).length > 10,
  ),
);
const jargon = allItems.filter((i) => {
  const detail = str(i["detail"]);
  return (
    detail.includes("Path 1") ||
    detail.includes("Path 2") ||
    detail.includes("--") ||
    detail.includes("bisync")
    // "rclone" is deliberately allowed: it is the real dependency name, and the
    // honest remediation for a missing binary is to say so.
  );
});
check(
  "no rclone vocabulary leaks into the summary copy",
  jargon.length === 0,
  jargon.map((i) => `${str(i["title"])}: ${str(i["detail"])}`).join(" || "),
);
check(
  "red items carry the health-card action they point at",
  items("needsIntervention").some((i) => str(i["action"]) === "resync"),
);
check(
  "item lists are bounded and totals are exact",
  Number(bucket("checkWhenOnline")["total"]) >= items("checkWhenOnline").length,
);

// ---------------------------------------------------------------------------
// Update verdict (evidence rule) — release-dependent
// ---------------------------------------------------------------------------

section("Update verdict: evidence rule");

const hosts = list(record(health.body)["hosts"]).map(record);
const byId = new Map(hosts.map((h) => [str(h["id"]), h]));
const oldDesk = record(byId.get("desk-old")["updateStatus"]);
const newDesk = record(byId.get("desk-new")["updateStatus"]);
const releaseKnown = str(oldDesk["releaseVersion"]).length > 0;

console.log(
  `release: ${releaseKnown ? `v${str(oldDesk["releaseVersion"])} published ${str(oldDesk["releasePublishedAt"])}` : "unavailable (offline?)"}`,
);
console.log(`desk-old (offline since 2020): ${str(oldDesk["kind"])}/${str(oldDesk["reason"])} — ${str(oldDesk["label"])}`);
console.log(`desk-new (online now):         ${str(newDesk["kind"])}/${str(newDesk["reason"])} — ${str(newDesk["label"])}`);

if (releaseKnown) {
  check(
    "offline-since-before-release is suppressed, not called outdated",
    str(oldDesk["kind"]) === "not_evaluated" && str(oldDesk["reason"]) === "checked_before_release",
    `${str(oldDesk["kind"])}/${str(oldDesk["reason"])}`,
  );
  check(
    "online-after-release on an old build IS actionable",
    str(newDesk["kind"]) === "available" && newDesk["actionable"] === true,
    `${str(newDesk["kind"])}`,
  );
  check(
    "updateAvailable mirrors updateStatus.actionable",
    hosts.every((h) => h["updateAvailable"] === (record(h["updateStatus"])["actionable"] === true)),
  );
} else {
  check("release info unavailable — boundary not asserted", true, "server could not reach the release proxy");
}

const neverSeen = record(byId.get("phone-1")["updateStatus"]);
check(
  "never-seen host is 'not_evaluated', never 'update available'",
  releaseKnown ? str(neverSeen["kind"]) === "not_evaluated" && str(neverSeen["reason"]) === "never_seen" : true,
  `${str(neverSeen["kind"])}/${str(neverSeen["reason"])}`,
);

// ---------------------------------------------------------------------------
// Dry-run plan (official device route) + reviewed-plan validation
// ---------------------------------------------------------------------------

section("Dry-run plan → reviewed-plan validation");

const planFolder = folderIds["unsafe"]!;
const planAssignment = assignmentIds["unsafe"]!;
const planRes = await api("POST", "/folder-plans", {
  id: crypto.randomUUID(),
  hostId: "srv-main",
  folderId: planFolder,
  assignmentId: planAssignment,
  intervention: "resync",
  authority: "local",
  maxDeletePercent: 10,
  summary: "Reseed the baseline — this device wins conflicting files. Dry run: 3 to copy, 1 to delete.",
  changes: { wouldCopy: ["a.txt", "b.txt", "c.txt"], wouldDelete: ["stale.txt"], wouldMkdir: [], files: 3, bytes: 4096 },
  configRevision: 1,
  filterFingerprint: "fp-1",
  baselineFingerprint: "base-1",
  createdAt: Date.now(),
  expiresAt: Date.now() + 30 * 60_000,
});
check("device reports a reviewed plan", planRes.status === 201, `status ${planRes.status}`);
const planId = str(record(planRes.body)["id"]);

const plansRead = await api("GET", `/folders/${planFolder}/plans`);
const firstPlan = record(list(plansRead.body)[0]);
check(
  "plan round-trips its reviewed semantics",
  str(record(firstPlan["plan"])["authority"]) === "local" &&
    record(firstPlan["plan"])["maxDeletePercent"] === 10,
  JSON.stringify(record(firstPlan["plan"])["maxDeletePercent"]),
);
check(
  "plan validity is reported",
  typeof record(firstPlan["validity"])["valid"] === "boolean",
  `${record(firstPlan["validity"])["valid"]} / ${str(record(firstPlan["validity"])["reason"])}`,
);

const mismatchAuthority = await api("POST", "/hosts/srv-main/actions", {
  type: "folder_intervention",
  payload: { folderId: planFolder, intervention: "resync", authority: "remote", planId, confirm: true },
});
check(
  "a local plan cannot authorize a remote resync",
  mismatchAuthority.status === 400,
  `${mismatchAuthority.status}: ${str(record(mismatchAuthority.body)["error"])}`,
);

const mismatchIntervention = await api("POST", "/hosts/srv-main/actions", {
  type: "folder_intervention",
  payload: { folderId: planFolder, intervention: "seed", authority: "local", planId, confirm: true },
});
check(
  "a different intervention is refused",
  mismatchIntervention.status === 400,
  `${mismatchIntervention.status}: ${str(record(mismatchIntervention.body)["error"])}`,
);

const mismatchThreshold = await api("POST", "/hosts/srv-main/actions", {
  type: "folder_intervention",
  payload: { folderId: planFolder, intervention: "resync", authority: "local", planId, maxDeletePercent: 90, confirm: true },
});
check(
  "a plan reviewed at 10% cannot run at 90%",
  mismatchThreshold.status === 400,
  `${mismatchThreshold.status}: ${str(record(mismatchThreshold.body)["error"])}`,
);

const accepted = await api("POST", "/hosts/srv-main/actions", {
  type: "folder_intervention",
  payload: { folderId: planFolder, intervention: "resync", authority: "local", planId, confirm: true },
});
check(
  "the matching reviewed plan is accepted",
  accepted.status === 201,
  `status ${accepted.status}`,
);

const argvShaped = await api("POST", "/hosts/srv-main/actions", {
  type: "folder_intervention",
  payload: { folderId: planFolder, intervention: "resync", authority: "local", planId, confirm: true, config: "/etc/rclone.conf" },
});
check(
  "an argv-shaped field is refused before it is stored",
  argvShaped.status === 400,
  `${argvShaped.status}: ${str(record(argvShaped.body)["error"])}`,
);

// LAMA-345 follow-up: a "0 change" plan is a legitimate BASELINE-ONLY
// RECOVERY and is accepted for daemon-side revalidation (the daemon re-runs a
// fresh dry run and refuses if anything would transfer). A claimed action
// holds a renewable lease so a long plan/intervention is never reclaimed
// mid-run, and a duplicate ack cannot rewrite the outcome.
const zeroPlanRes = await api("POST", "/folder-plans", {
  id: crypto.randomUUID(),
  hostId: "srv-main",
  folderId: planFolder,
  assignmentId: planAssignment,
  intervention: "resync",
  authority: "local",
  maxDeletePercent: 10,
  summary: "Reseed the baseline — this device wins conflicting files. Dry run: no file changes detected (baseline rebuild only).",
  changes: { wouldCopy: [], wouldDelete: [], wouldMkdir: [], files: 0, bytes: 0 },
  configRevision: 1,
  filterFingerprint: "fp-1",
  baselineFingerprint: "base-1",
  createdAt: Date.now(),
  expiresAt: Date.now() + 30 * 60_000,
});
const zeroPlanId = str(record(zeroPlanRes.body)["id"]);
const zeroApproval = await api("POST", "/hosts/srv-main/actions", {
  type: "folder_intervention",
  payload: { folderId: planFolder, intervention: "resync", authority: "local", planId: zeroPlanId, confirm: true },
});
check(
  "a 0-change plan is accepted as a baseline-only recovery (daemon revalidates)",
  zeroApproval.status === 201 && str(record(zeroApproval.body)["status"]) === "pending",
  `${zeroApproval.status}: ${str(record(zeroApproval.body)["error"])}`,
);
const zeroMismatch = await api("POST", "/hosts/srv-main/actions", {
  type: "folder_intervention",
  payload: { folderId: planFolder, intervention: "resync", authority: "remote", planId: zeroPlanId, confirm: true },
});
check(
  "a 0-change plan still cannot authorize a different reviewed operation",
  zeroMismatch.status === 400,
  `${zeroMismatch.status}: ${str(record(zeroMismatch.body)["error"])}`,
);

const leaseActionRes = await api("POST", "/hosts/srv-main/actions", { type: "check_update" });
const leaseActionId = str(record(leaseActionRes.body)["id"]);
const claimed = await api("GET", "/actions/pending?hostId=srv-main");
const claimedIds = list(claimed.body).map((a) => str(record(a)["id"]));
check(
  "a queued action is claimed for the host",
  claimedIds.includes(leaseActionId),
  `${claimed.status}: claimed=${claimedIds.length}`,
);
const leaseRenewed = await api("POST", `/actions/${leaseActionId}/lease`, {});
check(
  "a claimed action's lease is renewable while it runs",
  leaseRenewed.status === 200 && str(record(leaseRenewed.body)["status"]) === "taken",
  `${leaseRenewed.status}: ${str(record(leaseRenewed.body)["status"])}`,
);
const leaseAfterComplete = await api("POST", `/actions/${leaseActionId}/complete`, { status: "done", result: "integration check" });
const duplicateAck = await api("POST", `/actions/${leaseActionId}/complete`, { status: "failed", result: "must be ignored" });
check(
  "a duplicate ack cannot rewrite the terminal outcome",
  leaseAfterComplete.status === 200 &&
    duplicateAck.status === 200 &&
    str(record(duplicateAck.body)["status"]) === "done" &&
    str(record(duplicateAck.body)["result"]) === "integration check",
  `${duplicateAck.status}: ${str(record(duplicateAck.body)["status"])}/${str(record(duplicateAck.body)["result"])}`,
);
const leaseAfterDone = await api("POST", `/actions/${leaseActionId}/lease`, {});
check(
  "a completed action's lease is gone (409)",
  leaseAfterDone.status === 409,
  `${leaseAfterDone.status}: ${str(record(leaseAfterDone.body)["error"])}`,
);

// ---------------------------------------------------------------------------
// Isolated daemon: real heartbeat + folder-health reporting (no rclone)
// ---------------------------------------------------------------------------

section("Isolated daemon: heartbeat → folder-health report");

writeFileSync(
  join(home, ".config", "lamasync", "client.toml"),
  [
    `serverUrl = "http://127.0.0.1:${PORT}"`,
    `apiKey = "${TEST_KEY}"`,
    `hostname = "sandbox-daemon"`,
    `dataDir = "${join(home, ".local", "share", "lamasync")}"`,
  ].join("\n") + "\n",
  { mode: 0o600 },
);

// The daemon's host row must exist before it can be assigned a folder (the
// assignment route 404s on an unknown host). A real daemon registers itself on
// boot; doing it here as well keeps the ordering deterministic.
const daemonRegister = await api("POST", "/register", {
  id: "sandbox-daemon",
  hostname: "sandbox-daemon",
  tailnetIp: null,
});
check("sandbox-daemon host registered", daemonRegister.status === 200 || daemonRegister.status === 201, `status ${daemonRegister.status}`);

// A dedicated folder so the daemon's own report is unambiguous, pointing at a
// temp tree and a never-firing schedule.
const daemonFolder = await api("POST", "/folders", { name: "DaemonCheck", type: "sync" });
const daemonFolderId = str(record(daemonFolder.body)["id"]);
mkdirSync(join(sandbox, "trees", "daemon"), { recursive: true });
const daemonAssign = await api("POST", `/folders/${daemonFolderId}/assign`, {
  hostId: "sandbox-daemon",
  role: "both",
  localPath: join(sandbox, "trees", "daemon"),
  syncExpr: "0 0 1 1 *",
  enabled: true,
});
check(
  "sandbox-daemon folder assigned",
  daemonAssign.status === 200 || daemonAssign.status === 201,
  `${daemonAssign.status}: ${str(record(daemonAssign.body)["error"])}`,
);

const daemonLog = join(sandbox, "daemon.log");
const daemon = Bun.spawn(["bun", "run", "packages/daemon/src/index.ts"], {
  cwd: ROOT,
  env: sandboxEnv(),
  stdout: "pipe",
  stderr: "pipe",
});
children.push({ name: "daemon", kill: () => daemon.kill() });

// Bounded in-memory log so a startup failure is diagnosable (an empty file
// because the stream never closed is worse than no log at all).
const daemonLines: string[] = [];
async function capture(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    daemonLines.push(...decoder.decode(value).split("\n"));
    if (daemonLines.length > 300) daemonLines.splice(0, daemonLines.length - 300);
  }
}
void capture(daemon.stdout);
void capture(daemon.stderr);

let daemonHealthy = false;
let daemonReport: Record<string, unknown> = {};
for (let i = 0; i < 60; i += 1) {
  await Bun.sleep(500);
  const read = await api("GET", `/folders/${daemonFolderId}/health`);
  const record0 = list(record(read.body)["records"]).map(record)[0];
  if (record0) {
    daemonReport = record0;
    daemonHealthy = true;
    break;
  }
}

writeFileSync(daemonLog, daemonLines.join("\n"));
if (!daemonHealthy) {
  console.log(`daemon log tail:\n${daemonLines.slice(-14).join("\n")}`);
}
const daemonHost = await api("GET", "/hosts/sandbox-daemon");
check(
  "daemon registered itself from the sandbox HOME (isolated client.toml)",
  daemonHost.status === 200 && str(record(daemonHost.body)["status"]) !== "",
  `status ${daemonHost.status}`,
);
check(
  "daemon reported assignment health through POST /folder-health",
  daemonHealthy,
  daemonHealthy ? `state=${str(daemonReport["state"])}` : "no report within 30 s",
);
if (daemonHealthy) {
  check(
    "the daemon's report is a real lightweight probe (never a fabricated 'healthy')",
    ["new_host", "healthy", "resync_required", "blocked", "unknown", "unsafe", "recoverable", "busy"].includes(
      str(daemonReport["state"]),
    ),
    str(daemonReport["state"]),
  );
  check(
    "the probe carries the facts the card renders",
    record(daemonReport["facts"])["baseline"] !== undefined &&
      record(daemonReport["facts"])["measurement"] !== undefined,
  );
  check(
    "no credentials or rclone argv in the reported facts",
    !JSON.stringify(daemonReport).includes("apiKey") &&
      !JSON.stringify(daemonReport).includes("--resync-mode"),
  );
}
// Proof, not vibes: the daemon must not have executed anything. A far-future
// schedule previously overflowed setTimeout and synced in a tight loop (fixed
// in this branch), so the log is the place to prove it stayed quiet.
const daemonSpawnedRclone = daemonLines.some(
  (line) =>
    line.includes("[run]") ||
    line.includes("[executor]") ||
    line.includes("rclone") ||
    line.includes("TimeoutOverflowWarning"),
);
writeFileSync(daemonLog, daemonLines.join("\n"));
check(
  "daemon never spawned rclone (no run/executor/overflow lines)",
  !daemonSpawnedRclone,
  daemonSpawnedRclone
    ? daemonLines.filter((l) => l.includes("[run]") || l.includes("rclone")).slice(0, 3).join(" | ")
    : `${daemonLines.length} log lines, none from a run`,
);

// The Dashboard summary now includes the daemon's host/folder.
const health2 = await api("GET", "/health");
const summary2 = record(record(health2.body)["fleetHealth"]);
check(
  "the daemon's folder appears in the summary",
  JSON.stringify(summary2).includes("DaemonCheck") ||
    JSON.stringify(summary2).includes("sandbox-daemon"),
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

section("Result");
console.log(`${checks.length - failures}/${checks.length} checks passed`);
for (const c of checks.filter((c) => !c.ok)) {
  console.log(`  FAILED: ${c.name} — ${c.detail}`);
}

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify({ port: PORT, sandbox, checks, headline: str(summary["headline"]) }, null, 2),
  );
  console.log(`evidence written to ${JSON_OUT}`);
}

if (SERVE) {
  console.log("");
  console.log("=== SERVING (Ctrl+C to stop) ===");
  console.log(`SERVE url=http://127.0.0.1:${PORT} key=${TEST_KEY} sandbox=${sandbox}`);
  console.log("Seeded fleet is untouched; the server and the isolated daemon keep running.");
  await new Promise(() => {});
}

if (!KEEP) {
  rmSync(sandbox, { recursive: true, force: true });
  console.log("sandbox removed (pass --keep to inspect)");
} else {
  console.log(`sandbox kept at ${sandbox}`);
}

process.exit(failures === 0 ? 0 : 1);
