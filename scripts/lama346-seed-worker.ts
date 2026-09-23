#!/usr/bin/env bun
/**
 * scripts/lama346-seed-worker.ts — ONE side of a LAMA-346 seed, in its own
 * process.
 *
 * This is the Stage 2c test-only daemon-shaped worker: the disposable E2E
 * harness launches two of these (a SOURCE and a TARGET), each in its own OS
 * process, and they communicate only through the real HTTP server job API and
 * the real temporary S3 object space. It is NOT the production daemon action
 * loop — no production module imports it, and `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED`
 * stays `false`. It exists so the vertical path can be exercised without
 * wiring seed work into the shipped daemon before the evidence is reviewed.
 *
 * Isolation: every input comes from the environment the harness sets, all paths
 * are inside the harness sandbox, and the object space is the disposable MinIO
 * the harness starts. There is no rclone config, no credential file, no
 * production endpoint and no real folder.
 *
 * Role SOURCE: effective filter universe → manifest → real GNU tar archive →
 * upload the archive and the manifest (each with a recorded digest) through the
 * store, reporting each phase to the server.
 *
 * Role TARGET: wait for the source's recorded facts, download the archive and
 * the manifest, RE-VERIFY both, extract into a sibling staging directory,
 * verify the tree against the transported manifest, publish with one atomic
 * rename, run a real `rclone bisync --resync` over the same filter rules and
 * require zero changed files, then report the terminal outcome and clean up the
 * relay objects.
 *
 * Output is one JSON object per line on stdout so the harness can assert on the
 * exact evidence rather than on a human sentence.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  seedRelayArchiveKey,
  seedRelayManifestKey,
  seedStagingPath,
  type SeedJob,
  type SeedJobArchiveFacts,
  type SeedManifestDocument,
} from "@lamasync/core";
import { detectArchiveTooling, createSeedArchive, extractSeedArchive, publishStagedTree, verifyExtractedTree, type SeedManifest } from "../packages/daemon/src/seed-archive.ts";
import { buildSeedSourceManifest } from "../packages/daemon/src/seed-filter-universe.ts";
import { createS3SeedRelayStore } from "../packages/daemon/src/seed-relay-s3.ts";
import { cleanupSeedRelayObjects, downloadSeedArchive, downloadSeedManifest, uploadSeedArchive, uploadSeedManifest } from "../packages/daemon/src/seed-transport.ts";

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function emit(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const ROLE = env("LAMASYNC_SEED_ROLE");
if (ROLE !== "source" && ROLE !== "target") throw new Error(`unknown role ${ROLE}`);
const JOB_ID = env("LAMASYNC_SEED_JOB_ID");
const SERVER = env("LAMASYNC_SEED_SERVER_URL").replace(/\/$/, "");
const API_KEY = env("LAMASYNC_SEED_API_KEY");
const HOST_ID = env("LAMASYNC_SEED_HOST_ID");
const FOLDER_ROOT = resolve(env("LAMASYNC_SEED_FOLDER_ROOT"));
const FOLDER_TYPE = env("LAMASYNC_SEED_FOLDER_TYPE", "sync");
const IGNORE_PATH = env("LAMASYNC_SEED_IGNORE_PATH", ".lamasyncignore");
const WORK_DIR = resolve(env("LAMASYNC_SEED_WORK_DIR"));
const RULES_PATH = resolve(env("LAMASYNC_SEED_FILTER_RULES_PATH"));
const PEER_ROOT = process.env["LAMASYNC_SEED_PEER_ROOT"];
const BASELINE_STATE = process.env["LAMASYNC_SEED_BASELINE_STATE"] ?? join(WORK_DIR, "bisync-state");

const STORE = createS3SeedRelayStore({
  endpoint: env("LAMASYNC_SEED_S3_ENDPOINT"),
  bucket: env("LAMASYNC_SEED_S3_BUCKET"),
  region: env("LAMASYNC_SEED_S3_REGION", "us-east-1"),
  accessKeyId: env("LAMASYNC_SEED_S3_ACCESS_KEY"),
  secretAccessKey: env("LAMASYNC_SEED_S3_SECRET_KEY"),
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${SERVER}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
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

async function readJob(): Promise<SeedJob> {
  const res = await api("GET", `/seed-jobs/${JOB_ID}`);
  if (res.status !== 200) throw new Error(`GET /seed-jobs/${JOB_ID} answered ${res.status}`);
  return res.body as SeedJob;
}

/** Report a phase (and renew the lease) through the real device route. */
async function report(
  phase: string,
  message: string,
  extra: { bytesDone?: number; bytesTotal?: number | null; entriesDone?: number; entriesTotal?: number | null } = {},
): Promise<SeedJob> {
  const res = await api("POST", `/seed-jobs/${JOB_ID}/progress`, {
    phase,
    message,
    leaseOwner: HOST_ID,
    ...extra,
  });
  if (res.status !== 200) {
    throw new Error(`progress ${phase} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  emit({ event: "phase", role: ROLE, phase, message });
  return res.body as SeedJob;
}

function assignmentFor() {
  return {
    id: `e2e-${HOST_ID}`,
    folderId: "e2e-folder",
    hostId: HOST_ID,
    role: "both" as const,
    localPath: FOLDER_ROOT,
    enabled: true,
    ignorePath: IGNORE_PATH,
    ignoreGitMetadata: true,
  };
}

/** The transported document as the `verifyExtractedTree` input. */
function documentAsManifest(document: SeedManifestDocument): SeedManifest {
  return {
    entries: document.entries.map((entry) => ({ ...entry })),
    fileCount: document.fileCount,
    dirCount: document.dirCount,
    totalBytes: document.totalBytes,
    fingerprint: document.fingerprint,
    statsFingerprint: "",
    unsupported: [],
    emptyDirsPruned: [],
    filter: {
      fingerprint: document.filterFingerprint,
      patternCount: 0,
      skippedCount: 0,
      skippedSample: [],
    },
  };
}

function bisyncStats(raw: string): Record<string, number> | null {
  let stats: Record<string, number> | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { stats?: Record<string, number> };
      if (parsed.stats) stats = parsed.stats;
    } catch {
      // rclone interleaves non-JSON progress lines.
    }
  }
  return stats;
}

function plainLog(text: string): string {
  // rclone colourises its output; strip ANSI escapes so a sentence can be
  // matched exactly.
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

async function runSource(): Promise<void> {
  const delayMs = Number.parseInt(process.env["LAMASYNC_SEED_DELAY_MS"] ?? "0", 10);
  if (Number.isFinite(delayMs) && delayMs > 0) {
    emit({ event: "delay", role: ROLE, delayMs });
    await Bun.sleep(delayMs);
  }
  const job = await readJob();
  const format = job.archive.format;
  const tooling = await detectArchiveTooling();
  emit({ event: "tooling", role: ROLE, format, tooling });

  await report("measuring_source", "Building the effective-filter manifest.", { entriesTotal: null });
  const built = await buildSeedSourceManifest(assignmentFor(), FOLDER_TYPE as "sync");
  if (built.manifest === null || built.blocking.length > 0) {
    throw new Error(`the source manifest could not be built: ${built.blocking.join("; ")}`);
  }
  const manifest = built.manifest;
  emit({
    event: "manifest",
    role: ROLE,
    entries: manifest.entries.length,
    totalBytes: manifest.totalBytes,
    fingerprint: manifest.fingerprint,
    filterFingerprint: manifest.filter.fingerprint,
    ruleCount: built.rules.length,
  });

  mkdirSync(WORK_DIR, { recursive: true });
  const archivePath = join(WORK_DIR, "payload.archive");
  await report("archiving_source", "Archiving the manifest's members.", {
    entriesTotal: manifest.entries.length,
  });
  const archive = await createSeedArchive({
    format,
    sourceRoot: FOLDER_ROOT,
    outputPath: archivePath,
    manifest,
    filter: built.universe,
    onProgress: (membersDone) => emit({ event: "archive_progress", role: ROLE, membersDone }),
  });
  if (!archive.ok || archive.sha256 === null) {
    throw new Error(`archive creation failed: ${archive.error ?? "no digest"}`);
  }
  emit({ event: "archive", role: ROLE, bytes: archive.bytes, sha256: archive.sha256, memberCount: archive.memberCount });

  await report("uploading_archive", "Uploading the archive and manifest to the temporary seed space.", {
    bytesTotal: archive.bytes,
  });
  const uploaded = await uploadSeedArchive({
    store: STORE,
    jobId: JOB_ID,
    format,
    archivePath,
    manifestFingerprint: manifest.fingerprint,
    memberCount: archive.memberCount,
    now: Date.now(),
    onProgress: (progress) => emit({ event: "upload_progress", role: ROLE, ...progress }),
  });
  if (!uploaded.ok || uploaded.metadata === null) {
    throw new Error(`archive upload failed: ${uploaded.error ?? "no metadata"}`);
  }
  const manifestUpload = await uploadSeedManifest({ store: STORE, jobId: JOB_ID, manifest, now: Date.now() });
  if (!manifestUpload.ok || manifestUpload.metadata === null) {
    throw new Error(`manifest upload failed: ${manifestUpload.error ?? "no metadata"}`);
  }
  emit({ event: "uploaded", role: ROLE, archive: uploaded.metadata, manifest: manifestUpload.metadata });
  // The archive facts the target verifies against are persisted by the
  // COORDINATOR in production; in this harness the source records them through
  // the test-gated archive route (the same device shape the daemon will use), so
  // the target can read them from the job and re-verify independently.
  const facts: SeedJobArchiveFacts = {
    ...uploaded.archive,
    manifestObjectKey: manifestUpload.metadata.objectKey,
    manifestBytes: manifestUpload.metadata.bytes,
    manifestSha256: manifestUpload.metadata.sha256,
  };
  // Test-only fault injection: record a WRONG content fingerprint so the
  // target's re-derivation must refuse the manifest. Used by the E2E's
  // manifest-mismatch case; never set in production.
  if (process.env["LAMASYNC_SEED_CORRUPT"] === "manifest-fingerprint") {
    facts.manifestFingerprint = "b".repeat(64);
  }
  if (process.env["LAMASYNC_SEED_CORRUPT"] === "archive-digest") {
    facts.sha256 = "c".repeat(64);
  }
  const recorded = await api("POST", `/seed-jobs/${JOB_ID}/archive`, facts);
  if (recorded.status !== 200) {
    throw new Error(`recording archive facts answered ${recorded.status}: ${JSON.stringify(recorded.body).slice(0, 200)}`);
  }
  await report("uploading_archive", "Archive and manifest are recorded.", {
    bytesDone: archive.bytes,
    bytesTotal: archive.bytes,
  });
  emit({ event: "done", role: ROLE, facts });
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

async function waitForSourceFacts(timeoutMs: number): Promise<SeedJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await readJob();
    if (
      job.archive.sha256 !== null &&
      job.archive.bytes !== null &&
      job.archive.manifestSha256 !== null &&
      job.archive.manifestObjectKey !== null &&
      job.archive.manifestFingerprint !== null
    ) {
      return job;
    }
    if (job.phase === "completed" || job.phase === "failed" || job.phase === "cancelled") {
      throw new Error(`the job ended (${job.phase}) before the source recorded its facts`);
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the source's archive facts");
    await Bun.sleep(250);
  }
}

async function runTarget(): Promise<void> {
  const job = await waitForSourceFacts(120_000);
  const format = job.archive.format;
  emit({
    event: "source_facts",
    role: ROLE,
    archiveBytes: job.archive.bytes,
    archiveSha256: job.archive.sha256,
    manifestFingerprint: job.archive.manifestFingerprint,
  });

  mkdirSync(WORK_DIR, { recursive: true });
  const archivePath = join(WORK_DIR, "payload.archive");
  await report("downloading_archive", "Downloading the archive from the temporary seed space.", {
    bytesTotal: job.archive.bytes,
  });
  const downloaded = await downloadSeedArchive({
    store: STORE,
    archive: job.archive,
    jobId: JOB_ID,
    destPath: archivePath,
    now: Date.now(),
    onProgress: (progress) => emit({ event: "download_progress", role: ROLE, ...progress }),
  });
  if (!downloaded.ok) throw new Error(`archive download failed: ${downloaded.error ?? "unknown"}`);
  emit({ event: "downloaded", role: ROLE, bytes: downloaded.bytes, sha256: downloaded.sha256 });

  await report("verifying_archive", "Downloading and re-deriving the source manifest.");
  const manifestPath = join(WORK_DIR, "manifest.json");
  const manifestDownload = await downloadSeedManifest({
    store: STORE,
    archive: job.archive,
    jobId: JOB_ID,
    destPath: manifestPath,
  });
  if (!manifestDownload.ok || manifestDownload.document === null) {
    throw new Error(`manifest download failed: ${manifestDownload.error ?? "unknown"}`);
  }
  const document = manifestDownload.document;
  emit({ event: "manifest_verified", role: ROLE, entries: document.entries.length, fingerprint: document.fingerprint });

  // The staging directory must be the target's own derived sibling, in its own
  // parent, on the same filesystem. A wrong location never receives a byte.
  const stagingDir = seedStagingPath(FOLDER_ROOT, JOB_ID) ?? join(dirname(FOLDER_ROOT), `.lamasync-seed-staging-${JOB_ID}`);
  rmSync(stagingDir, { recursive: true, force: true });
  await report("extracting_target", "Extracting into the staging sibling.", {
    entriesTotal: document.entries.length,
  });
  const extracted = await extractSeedArchive({ format, archivePath, stagingDir });
  if (!extracted.ok) throw new Error(`extraction failed: ${extracted.error ?? "unknown"}`);

  await report("verifying_target", "Verifying the extracted tree against the transported manifest.");
  const verified = await verifyExtractedTree({ root: stagingDir, manifest: documentAsManifest(document) });
  if (!verified.ok) throw new Error(`tree verification failed: ${verified.message}`);
  emit({ event: "tree_verified", role: ROLE, checked: verified.checked });

  await report("publishing", "Publishing the staging tree with one atomic rename.");
  const published = publishStagedTree({ stagingDir, targetPath: FOLDER_ROOT });
  if (!published.ok) throw new Error(`publication failed: ${published.error ?? "unknown"}`);

  await report("baseline_validation", "Running a real bisync --resync over the same filter rules.");
  if (PEER_ROOT === undefined || PEER_ROOT.length === 0) throw new Error("the target needs LAMASYNC_SEED_PEER_ROOT");
  rmSync(BASELINE_STATE, { recursive: true, force: true });
  mkdirSync(BASELINE_STATE, { recursive: true });
  const bisync = Bun.spawnSync(
    [
      "rclone",
      "bisync",
      resolve(PEER_ROOT),
      FOLDER_ROOT,
      "--workdir",
      BASELINE_STATE,
      "--filter-from",
      RULES_PATH,
      "--use-json-log",
      "-v",
      "--resilient",
      "--recover",
      "--max-lock",
      "10m",
      "--resync",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const raw = plainLog(new TextDecoder().decode(bisync.stderr));
  const stats = bisyncStats(raw);
  const successful = raw.includes("Bisync successful");
  const transfers = stats?.["totalTransfers"] ?? -1;
  const bytes = stats?.["bytes"] ?? -1;
  const errors = stats?.["errors"] ?? -1;
  const clean = bisync.exitCode === 0 && successful && transfers === 0 && bytes === 0 && errors === 0 && !raw.includes("File changed") && !raw.includes("Safety abort");
  emit({ event: "baseline", role: ROLE, exitCode: bisync.exitCode, successful, transfers, bytes, errors, clean });
  if (!clean) {
    await finish("failed", `the post-seed bisync was not a zero-change baseline: ${raw.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-4).join(" | ").slice(0, 300)}`);
    throw new Error("the post-seed bisync was not a zero-change baseline");
  }

  await finish("completed", null);
  await cleanup();
  emit({ event: "done", role: ROLE });
}

async function finish(status: "completed" | "failed", error: string | null): Promise<void> {
  const res = await api("POST", `/seed-jobs/${JOB_ID}/complete`, {
    status,
    ...(status === "completed"
      ? { summary: "Seed transfer completed and the published tree validated with a zero-change bisync baseline." }
      : { error }),
  });
  emit({ event: "finished", role: ROLE, status, httpStatus: res.status });
}

async function cleanup(): Promise<void> {
  const job = await readJob();
  const result = await cleanupSeedRelayObjects({
    store: STORE,
    keys: [seedRelayArchiveKey(JOB_ID, job.archive.format), seedRelayManifestKey(JOB_ID)],
    cleanup: job.archive.cleanup,
    now: Date.now(),
  });
  emit({ event: "cleanup", role: ROLE, complete: result.complete, deleted: result.deleted, error: result.error });
}

// ---------------------------------------------------------------------------

try {
  if (ROLE === "source") await runSource();
  else await runTarget();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  emit({ event: "error", role: ROLE, message });
  if (ROLE === "target") {
    try {
      await finish("failed", message.slice(0, 300));
      await cleanup();
    } catch {
      // The harness reads the job row for the authoritative outcome.
    }
  }
  process.exit(1);
}

// Keep the type import used even when the source path skips it.
void writeFileSync;
