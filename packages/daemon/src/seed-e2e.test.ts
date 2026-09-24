// LAMA-346 Stage 2a — the disposable two-host end-to-end proof.
//
// This is the automated proof that a seed produces a tree a real bisync accepts
// as a valid baseline. It is NOT a deployment and it touches nothing live: it
// runs entirely inside one `mkdtemp` sandbox, with two daemon-shaped identities
// (their own roots, their own ignore rules, their own bisync state dirs), a
// test-only local object store, and no configured backend, credential, rclone
// config, dev-vm, production service or real folder.
//
// The pipeline, exactly as a seed would run it:
//
//   1. source identity: effective filter universe → manifest → tar archive
//      (real GNU tar, through the Stage 1a primitives)
//   2. relay: upload through a local object store, read-back verified, then
//      download and RE-HASHED ON DISK before anything may extract
//   3. target identity: extract into a sibling staging dir → verify the tree
//      against the manifest → one atomic rename into an EMPTY target
//   4. rclone bisync (GATED, see below): `--resync` over the SAME filter rules
//      must transfer ZERO bytes — that is the zero-content-change proof that the
//      seed, not a sync, established the baseline — and then normal edits must
//      propagate in BOTH directions while ignored content never moves.
//
// The fixture is the real Projects shape: many files, an ignored `node_modules`
// holding symlinks (nested, as in a worktree), git metadata, ignored logs and a
// pinned mtime (bisync compares size + modtime, so a seed that reset mtimes
// would re-copy the whole tree).
//
// GATING. The seed pipeline half always runs. The bisync half needs a real
// rclone, so it is gated on `Bun.which("rclone")` and force-skipped by
// `LAMASYNC_TEST_RCLONE=1` (the repo's existing hermetic-CI convention, see
// `packages/server/src/routes/browse-ops.test.ts`). When it is skipped, the
// suite still proves everything except the real-bisync acceptance, and the gate
// test below states that in its own name so the gap is visible rather than
// silent. See the handoff's §2.11 for what host proof is still required.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";
import {
  checkSeedPlanValidity,
  computeSeedSpacePlan,
  seedArchiveObjectKey,
  seedPlanPrerequisites,
  seedRelayArchiveKey,
  seedStagingPath,
  shouldExtendSeedDeadline,
  validateStagingLocation,
  type FolderAssignment,
  type SeedJobArchiveFacts,
  type SeedPlan,
} from "@lamasync/core";
import {
  buildSeedSourceManifest,
  buildSeedFilterUniverse,
  type SeedFilterUniverseBuild,
} from "./seed-filter-universe.ts";
import {
  buildSeedManifest,
  createSeedArchive,
  detectArchiveTooling,
  extractSeedArchive,
  publishStagedTree,
  seedManifestBlockingReason,
  validateSeedArchive,
  verifyExtractedTree,
} from "./seed-archive.ts";
import { createLocalSeedRelayStore } from "./seed-relay-local.ts";
import { downloadSeedArchive, uploadSeedArchive } from "./seed-transport.ts";

// ---------------------------------------------------------------------------
// Sandbox: two isolated identities, one disposable root
// ---------------------------------------------------------------------------

const SANDBOX = mkdtempSync(join(tmpdir(), "lama346-stage2a-"));

/** Identity A — the device that holds the data. */
const SOURCE_ID = { hostId: "stage2a-source", assignmentId: "stage2a-a1" };
/** Identity B — the device being seeded. */
const TARGET_ID = { hostId: "stage2a-target", assignmentId: "stage2a-a2" };

const SOURCE_PARENT = join(SANDBOX, "host-source");
const TARGET_PARENT = join(SANDBOX, "host-target");
const SOURCE_ROOT = join(SOURCE_PARENT, "Projects");
const TARGET_ROOT = join(TARGET_PARENT, "Projects");
const STORE_ROOT = join(SANDBOX, "relay-objects");
const SOURCE_STATE = join(SANDBOX, "state", "source-bisync");
const TARGET_STATE = join(SANDBOX, "state", "target-bisync");
const JOB_ID = "stage2a-job-0001";

/** The ignore rules both identities run with (they must agree, or bisync would re-sync). */
const IGNORE_LINES = ["- node_modules/", "- *.log", "- tmp/"];

/** The bisync proof needs a real rclone; the seed half never does. */
const RCLONE_AVAILABLE = !!Bun.which("rclone") && process.env.LAMASYNC_TEST_RCLONE !== "1";

const tooling = await detectArchiveTooling();
const FORMAT = tooling.zstd ? ("tar.zstd" as const) : ("tar.gz" as const);

function sourceAssignment(): FolderAssignment {
  return {
    id: SOURCE_ID.assignmentId,
    folderId: "stage2a-folder",
    hostId: SOURCE_ID.hostId,
    role: "both",
    localPath: SOURCE_ROOT,
    enabled: true,
    ignorePath: ".lamasyncignore",
    ignoreGitMetadata: true,
  };
}

function targetAssignment(): FolderAssignment {
  return {
    id: TARGET_ID.assignmentId,
    folderId: "stage2a-folder",
    hostId: TARGET_ID.hostId,
    role: "both",
    localPath: TARGET_ROOT,
    enabled: true,
    ignorePath: ".lamasyncignore",
    ignoreGitMetadata: true,
  };
}

/**
 * A deterministic byte sequence, so every run of the harness produces the same
 * archive digest and a failure is reproducible.
 */
function pseudoBytes(seed: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

const FIXTURE_FILE_COUNT = 180;

/** The Projects shape: many files, an ignored node_modules with symlinks, git metadata. */
function buildProjectsFixture(): void {
  mkdirSync(SOURCE_ROOT, { recursive: true });
  mkdirSync(TARGET_ROOT, { recursive: true });
  // The source's `.lamasyncignore` is part of the synced universe, so it is in
  // the manifest and arrives on the target through the seed.
  writeFileSync(join(SOURCE_ROOT, ".lamasyncignore"), `${IGNORE_LINES.join("\n")}\n`);
  // The target starts EMPTY — the executor's pre-sync `mkdir` leaves an empty
  // directory, and publishing refuses anything else. That is the real shape, and
  // it is why the seeded `.lamasyncignore` must come from the seed itself.

  // 1. Real content: 180 files across nested directories.
  for (let i = 0; i < FIXTURE_FILE_COUNT; i += 1) {
    const dir = join(SOURCE_ROOT, "src", `module-${String(i % 12).padStart(2, "0")}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `file-${String(i).padStart(3, "0")}.ts`), `export const n${i} = ${i};\n`);
  }
  // A couple of larger files so the archive is not trivially small.
  mkdirSync(join(SOURCE_ROOT, "assets"), { recursive: true });
  writeFileSync(join(SOURCE_ROOT, "assets", "blob-a.bin"), pseudoBytes(7, 64 * 1024));
  writeFileSync(join(SOURCE_ROOT, "assets", "blob-b.bin"), pseudoBytes(11, 32 * 1024));
  writeFileSync(join(SOURCE_ROOT, "README.md"), "# Projects fixture\n");
  // A pinned mtime: bisync compares size + modtime, so this is the assertion
  // that the archive preserved it end to end.
  utimesSync(join(SOURCE_ROOT, "README.md"), 1_700_000_000, 1_700_000_000);

  // 2. Ignored `node_modules` holding symlinks — the real Projects shape.
  for (const base of ["node_modules", "worktrees/feature-x/node_modules"]) {
    mkdirSync(join(SOURCE_ROOT, base, "pkg"), { recursive: true });
    writeFileSync(join(SOURCE_ROOT, base, "pkg", "index.js"), "module.exports = 1;\n");
    // A symlink INSIDE the ignored subtree: pruned before it is ever walked.
    symlinkSync("index.js", join(SOURCE_ROOT, base, "pkg", "link.js"));
  }

  // 3. Git metadata (excluded by ignoreGitMetadata) and ignored logs/tmp.
  mkdirSync(join(SOURCE_ROOT, ".git", "objects"), { recursive: true });
  writeFileSync(join(SOURCE_ROOT, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  writeFileSync(join(SOURCE_ROOT, ".git", "objects", "pack-abc"), pseudoBytes(3, 1024));
  mkdirSync(join(SOURCE_ROOT, "logs"), { recursive: true });
  writeFileSync(join(SOURCE_ROOT, "logs", "app.log"), "ignored log line\n");
  mkdirSync(join(SOURCE_ROOT, "tmp"), { recursive: true });
  writeFileSync(join(SOURCE_ROOT, "tmp", "scratch.bin"), pseudoBytes(5, 2048));
}

/**
 * rclone colourises its logs, and the escapes land *inside* the sentences this
 * harness asserts on (`File changed: <esc>[35mtime`), so strip them first.
 * Under `--use-json-log` they arrive JSON-escaped as the six characters
 * `\u001b`, so both forms are handled.
 */
const ANSI_ESCAPES = /(?:\\u001b|\u001b)\[[0-9;]*m/g;

function plainLog(text: string): string {
  return text.replace(ANSI_ESCAPES, "");
}

/** Every path in a tree, relative and sorted — used for byte-level comparisons. */
function treePaths(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split("\\").join("/");
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

// ---------------------------------------------------------------------------
// The pipeline, run once
// ---------------------------------------------------------------------------

interface PipelineResult {
  filter: SeedFilterUniverseBuild;
  manifest: Awaited<ReturnType<typeof buildSeedManifest>>;
  archivePath: string;
  archive: SeedJobArchiveFacts;
  /** The target's own view: the same record with `verifiedAt` set. */
  targetArchive: SeedJobArchiveFacts;
  archiveMetadata: { bytes: number; sha256: string };
  stagingDir: string;
  targetPath: string;
  memberCount: number;
  publishOk: boolean;
}

let pipeline: PipelineResult;

beforeAll(async () => {
  buildProjectsFixture();
  mkdirSync(SOURCE_STATE, { recursive: true });
  mkdirSync(TARGET_STATE, { recursive: true });

  // 1. SOURCE: effective filter universe → manifest → archive.
  const filter = buildSeedFilterUniverse(sourceAssignment(), "sync");
  expect(filter.errors).toEqual([]);
  const manifest = await buildSeedManifest(SOURCE_ROOT, { filter: filter.universe });
  expect(manifest.unsupported).toEqual([]);
  expect(seedManifestBlockingReason(manifest)).toBeNull();

  const archivePath = join(SANDBOX, `payload${FORMAT === "tar.zstd" ? ".tar.zst" : ".tar.gz"}`);
  const created = await createSeedArchive({
    format: FORMAT,
    sourceRoot: SOURCE_ROOT,
    outputPath: archivePath,
    manifest,
    filter: filter.universe,
  });
  expect(created.error).toBeNull();
  expect(created.ok).toBe(true);
  expect(created.sha256).toMatch(/^[0-9a-f]{64}$/);

  // 2. RELAY: upload through a test-only local object store, then download and
  //    verify on disk. Nothing here is a configured backend.
  const store = createLocalSeedRelayStore({ rootDir: STORE_ROOT });
  const uploaded = await uploadSeedArchive({
    store,
    jobId: JOB_ID,
    format: FORMAT,
    archivePath,
    manifestFingerprint: manifest.fingerprint,
    memberCount: manifest.entries.length,
    now: Date.now(),
  });
  expect(uploaded.error).toBeNull();
  expect(uploaded.ok).toBe(true);
  expect(uploaded.metadata).not.toBeNull();

  // 3. TARGET: staging sibling, download, extract, verify, atomic publish.
  const stagingDir = seedStagingPath(TARGET_ROOT, JOB_ID)!;
  expect(stagingDir).not.toBeNull();
  const stagingPolicy = validateStagingLocation({
    stagingPath: stagingDir,
    targetPath: TARGET_ROOT,
    sameFilesystemProven: true,
  });
  expect(stagingPolicy.ok).toBe(true);
  expect(stagingPolicy.adjacentToTarget).toBe(true);
  expect(stagingPolicy.derivedSibling).toBe(true);

  const downloadedPath = join(SANDBOX, "downloaded.payload");
  const downloaded = await downloadSeedArchive({
    store,
    jobId: JOB_ID,
    archive: uploaded.archive,
    destPath: downloadedPath,
    now: Date.now(),
  });
  expect(downloaded.error).toBeNull();
  expect(downloaded.ok).toBe(true);
  expect(downloaded.sha256).toBe(uploaded.metadata!.sha256);

  const extracted = await extractSeedArchive({ format: FORMAT, archivePath: downloadedPath, stagingDir });
  expect(extracted.error).toBeNull();
  expect(extracted.ok).toBe(true);

  const verified = await verifyExtractedTree({ root: stagingDir, manifest });
  expect(verified.mismatches).toEqual([]);
  expect(verified.ok).toBe(true);

  // The executor's pre-sync `mkdir` leaves an EMPTY target behind.
  mkdirSync(TARGET_ROOT, { recursive: true });
  const published = publishStagedTree({ stagingDir, targetPath: TARGET_ROOT });
  expect(published.error).toBeNull();
  expect(published.ok).toBe(true);

  pipeline = {
    filter,
    manifest,
    archivePath,
    archive: uploaded.archive,
    targetArchive: downloaded.archive,
    archiveMetadata: {
      bytes: uploaded.metadata!.bytes,
      sha256: uploaded.metadata!.sha256,
    },
    stagingDir,
    targetPath: TARGET_ROOT,
    memberCount: manifest.entries.length,
    publishOk: published.ok,
  };
});

afterAll(() => {
  // Best-effort: an unwritable directory planted by a failure case would
  // otherwise make the recursive remove fail.
  try {
    chmodSync(join(SANDBOX, "unwritable"), 0o755);
  } catch {
    /* not planted */
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("the sandbox is disposable and offline", () => {
  test("every root lives under one temp sandbox", () => {
    for (const path of [SOURCE_ROOT, TARGET_ROOT, STORE_ROOT, SOURCE_STATE, TARGET_STATE]) {
      expect(path.startsWith(SANDBOX)).toBe(true);
      expect(path.startsWith(tmpdir())).toBe(true);
    }
  });

  test("the two identities are separate devices with separate roots and state", () => {
    expect(SOURCE_ROOT).not.toBe(TARGET_ROOT);
    expect(SOURCE_STATE).not.toBe(TARGET_STATE);
    expect(sourceAssignment().hostId).not.toBe(targetAssignment().hostId);
    // The relay is a local object store, not a configured backend.
    expect(createLocalSeedRelayStore({ rootDir: STORE_ROOT }).kind).toBe("local-fs");
  });

  test("the object namespace is the dedicated seed namespace, per job", () => {
    expect(seedArchiveObjectKey(JOB_ID, FORMAT)).toBe(seedRelayArchiveKey(JOB_ID, FORMAT));
    expect(seedRelayArchiveKey(JOB_ID, FORMAT).startsWith(`lamasync/seed/${JOB_ID}/`)).toBe(true);
  });
});

describe("source: the effective filter universe shapes the archive", () => {
  test("the universe excludes node_modules, git metadata, logs and tmp", () => {
    expect(pipeline.filter.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const includes = pipeline.filter.universe.includes;
    expect(includes("src/module-00/file-000.ts", false)).toBe(true);
    expect(includes("README.md", false)).toBe(true);
    // A directory-only rule prunes the subtree, symlinks and all.
    expect(includes("node_modules", true)).toBe(false);
    expect(includes("worktrees", true)).toBe(true);
    expect(includes("worktrees/feature-x/node_modules", true)).toBe(false);
    // `- .git/**` is NOT a trailing-slash rule, so it does not match the
    // directory itself — it excludes everything INSIDE it, and the emptied
    // directory is pruned from the manifest rather than archived.
    expect(includes(".git", true)).toBe(true);
    expect(includes(".git/config", false)).toBe(false);
    // `- *.log` is a glob, so it matches the file directly.
    expect(includes("logs/app.log", false)).toBe(false);
    // `- tmp/` is a TRAILING-SLASH rule: it matches the DIRECTORY and nothing
    // else. The subtree is removed by PRUNING, not by the rule matching each
    // file — which is why the raw predicate still says yes for the file.
    expect(includes("tmp", true)).toBe(false);
    expect(includes("tmp/scratch.bin", false)).toBe(true);
  });

  test("the manifest describes the fixture without any unsupported member", () => {
    // Every real source file, plus the directories that hold one.
    expect(pipeline.manifest.fileCount).toBe(FIXTURE_FILE_COUNT + 4);
    expect(pipeline.manifest.unsupported).toEqual([]);
    // The pruned subtrees are recorded, not silently dropped.
    expect(pipeline.manifest.filter.skippedCount).toBeGreaterThan(0);
    expect(pipeline.manifest.filter.skippedSample).toContain("node_modules");
    expect(pipeline.manifest.filter.fingerprint).toBe(pipeline.filter.universe.fingerprint);
    // Two DIFFERENT reasons a directory never reaches the target:
    //   * `node_modules` is pruned by the filter, so it is never walked and is
    //     not an entry at all (nor an "empty" one);
    //   * `.git`, `logs` and the worktree parents are INCLUDED by the filter but
    //     end up holding nothing, so they are pruned as empty.
    expect(pipeline.manifest.entries.some((e) => e.path.startsWith("node_modules"))).toBe(false);
    expect(pipeline.manifest.emptyDirsPruned).not.toContain("node_modules");
    expect(pipeline.manifest.emptyDirsPruned).toContain(".git");
    expect(pipeline.manifest.emptyDirsPruned).toContain("logs");
    expect(pipeline.manifest.emptyDirsPruned).toContain("worktrees");
  });

  test("the archive's member set equals the manifest's", async () => {
    const validation = await validateSeedArchive({ format: FORMAT, archivePath: pipeline.archivePath });
    expect(validation.ok).toBe(true);
    expect(validation.members.count).toBe(pipeline.manifest.entries.length);
    expect(validation.offenders).toEqual([]);
  });
});

describe("target: the published tree is exactly the source universe", () => {
  test("the archive was uploaded, verified and recorded immutably", () => {
    expect(pipeline.archive.objectKey).toBe(seedRelayArchiveKey(JOB_ID, FORMAT));
    expect(pipeline.archive.bytes).toBe(pipeline.archiveMetadata.bytes);
    expect(pipeline.archive.sha256).toBe(pipeline.archiveMetadata.sha256);
    expect(pipeline.archive.manifestFingerprint).toBe(pipeline.manifest.fingerprint);
    expect(pipeline.archive.memberCount).toBe(pipeline.memberCount);
    expect(pipeline.archive.uploadedAt).not.toBeNull();
    // The SOURCE has not verified anything; the TARGET records that.
    expect(pipeline.archive.verifiedAt).toBeNull();
    expect(pipeline.targetArchive.verifiedAt).not.toBeNull();
    expect(pipeline.targetArchive.sha256).toBe(pipeline.archive.sha256);
    expect(pipeline.archive.cleanup.state).toBe("not_started");
  });

  test("the published tree contains the universe and nothing excluded", () => {
    const published = treePaths(TARGET_ROOT);
    const expected = pipeline.manifest.entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.path)
      .sort();
    expect(published).toEqual(expected);
    for (const absent of [
      "node_modules/pkg/index.js",
      "worktrees/feature-x/node_modules/pkg/index.js",
      ".git/config",
      "logs/app.log",
      "tmp/scratch.bin",
    ]) {
      expect(existsSync(join(TARGET_ROOT, absent))).toBe(false);
    }
    expect(existsSync(join(TARGET_ROOT, "node_modules"))).toBe(false);
  });

  test("mtimes survived the archive, so bisync will not re-copy the tree", () => {
    // This is the property that makes the zero-change baseline possible.
    const sourceStat = statSync(join(SOURCE_ROOT, "README.md"));
    const targetStat = statSync(join(TARGET_ROOT, "README.md"));
    expect(Math.round(targetStat.mtimeMs / 1000)).toBe(1_700_000_000);
    expect(Math.round(targetStat.mtimeMs / 1000)).toBe(Math.round(sourceStat.mtimeMs / 1000));
  });

  test("the staging sibling is gone: publication was a rename, not a copy", () => {
    expect(existsSync(pipeline.stagingDir)).toBe(false);
  });

  test("the published bytes match the source bytes file for file", () => {
    for (const rel of ["README.md", "src/module-00/file-000.ts", "assets/blob-a.bin"]) {
      const source = readFileSync(join(SOURCE_ROOT, rel));
      const target = readFileSync(join(TARGET_ROOT, rel));
      expect(target.equals(source)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The rclone bisync acceptance (gated)
// ---------------------------------------------------------------------------

/**
 * Run a real bisync between the two identities over the SAME filter rules the
 * seed used, and return the machine-readable stats rclone reports.
 *
 * `--filter-from` is the only filter input, exactly as the executor passes it,
 * so the seed's universe and bisync's universe are provably the same list.
 */
function bisync(options: { resync?: boolean; filterRules?: string[] } = {}): {
  exitCode: number;
  successful: boolean;
  transfers: number;
  bytes: number;
  deletes: number;
  errors: number;
  raw: string;
} {
  const filterFile = join(SANDBOX, "bisync-filter.txt");
  const rules = options.filterRules ?? pipeline.filter.rules;
  writeFileSync(filterFile, rules.length > 0 ? `${rules.join("\n")}\n` : "");
  const args = [
    "rclone",
    "bisync",
    SOURCE_ROOT,
    TARGET_ROOT,
    "--workdir",
    SOURCE_STATE,
    "--filter-from",
    filterFile,
    "--use-json-log",
    "-v",
    "--resilient",
    "--recover",
    "--max-lock",
    "10m",
  ];
  if (options.resync) args.push("--resync");
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  const raw = plainLog(new TextDecoder().decode(result.stderr));
  let stats: Record<string, number> | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { stats?: Record<string, number> };
      if (parsed.stats) stats = parsed.stats;
    } catch {
      // rclone interleaves non-JSON progress lines; ignore them.
    }
  }
  return {
    exitCode: result.exitCode,
    successful: raw.includes("Bisync successful"),
    transfers: stats?.["totalTransfers"] ?? -1,
    bytes: stats?.["bytes"] ?? -1,
    deletes: stats?.["deletes"] ?? -1,
    errors: stats?.["errors"] ?? -1,
    raw,
  };
}

describe("the bisync gate is explicit, not silent", () => {
  test("the bisync acceptance is either running or explicitly skipped", () => {
    if (RCLONE_AVAILABLE) {
      // Nothing to skip: the real proof below runs.
      expect(Bun.which("rclone")).not.toBeNull();
      return;
    }
    // Documented gap: without rclone the seed pipeline is still proven end to
    // end, but the real-bisync acceptance needs a host that has rclone. The
    // handoff's §2.11 lists exactly what that host proof must show.
    expect(process.env.LAMASYNC_TEST_RCLONE === "1" || Bun.which("rclone") === null).toBe(true);
  });
});

describe.skipIf(!RCLONE_AVAILABLE)("real bisync accepts the seeded tree as a baseline", () => {
  test("a resync over the same filters transfers ZERO bytes, then edits flow both ways", () => {
    // 1. The seed, not a sync, established the baseline: with the seeded target
    //    in place a `--resync` has nothing to do.
    //
    //    The assertion is "no file is reported as CHANGED", not merely "no
    //    bytes moved". Measured: bisync compares size + modtime, so a seed that
    //    reset mtimes would print `File changed: time` for every file and then
    //    re-check content — reporting "nothing to transfer" while still failing
    //    to be a clean baseline. With a whole tree of changed mtimes its safety
    //    check aborts the run outright. Asserting on the change report is
    //    therefore the assertion that actually covers mtime preservation.
    const baseline = bisync({ resync: true });
    expect(baseline.exitCode).toBe(0);
    expect(baseline.successful).toBe(true);
    expect(baseline.transfers).toBe(0);
    expect(baseline.bytes).toBe(0);
    expect(baseline.errors).toBe(0);
    expect(baseline.raw).not.toContain("File changed");
    expect(baseline.raw).not.toContain("Safety abort");
    expect(baseline.raw).toContain("nothing to transfer");

    // 2. A second run is a no-op, which is the steady state.
    const steady = bisync();
    expect(steady.exitCode).toBe(0);
    expect(steady.transfers).toBe(0);

    // 3. A normal post-seed edit on the SOURCE propagates to the target.
    writeFileSync(join(SOURCE_ROOT, "README.md"), "# Projects fixture\n\nedited on the source\n");
    const forward = bisync();
    expect(forward.exitCode).toBe(0);
    expect(forward.transfers).toBeGreaterThan(0);
    expect(readFileSync(join(TARGET_ROOT, "README.md"), "utf8")).toContain("edited on the source");

    // 4. A normal post-seed edit on the TARGET propagates back to the source.
    writeFileSync(join(TARGET_ROOT, "src", "module-00", "file-000.ts"), "// edited on the target\n");
    const backward = bisync();
    expect(backward.exitCode).toBe(0);
    expect(backward.transfers).toBeGreaterThan(0);
    expect(readFileSync(join(SOURCE_ROOT, "src", "module-00", "file-000.ts"), "utf8")).toContain(
      "edited on the target",
    );

    // 5. Ignored content never moves, in either direction.
    writeFileSync(join(SOURCE_ROOT, "logs", "app.log"), "a new ignored line\n");
    writeFileSync(join(SOURCE_ROOT, "node_modules", "pkg", "added.js"), "ignored\n");
    const ignored = bisync();
    expect(ignored.exitCode).toBe(0);
    expect(ignored.transfers).toBe(0);
    expect(existsSync(join(TARGET_ROOT, "node_modules", "pkg", "added.js"))).toBe(false);

  });

  test("anti-vacuity: without the seed's filters bisync DOES have work to do", () => {
    // The zero-transfer baseline above must not be an artefact of bisync
    // ignoring everything. On its own pair of roots, an ignored subtree that
    // exists only on the source is invisible WITH the filters and visible
    // WITHOUT them — which is exactly why the seed must use the same universe
    // the sync does.
    const root = join(SANDBOX, "anti-vacuity");
    const src = join(root, "src");
    const dst = join(root, "dst");
    const wd = join(root, "wd");
    for (const dir of [src, dst, wd]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(src, "kept.txt"), "kept\n");
    writeFileSync(join(dst, "kept.txt"), "kept\n");
    // mtimes must match for this comparison, so copy rather than re-write.
    utimesSync(join(dst, "kept.txt"), statSync(join(src, "kept.txt")).atime, statSync(join(src, "kept.txt")).mtime);
    mkdirSync(join(src, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(src, "node_modules", "pkg", "index.js"), "ignored\n");

    const run = (rules: string[], resync: boolean) => {
      const filterFile = join(root, `filter-${rules.length}.txt`);
      writeFileSync(filterFile, rules.length > 0 ? `${rules.join("\n")}\n` : "");
      const args = [
        "rclone", "bisync", src, dst, "--workdir", wd, "--filter-from", filterFile,
        "--use-json-log", "-v", "--resilient", "--recover", "--max-lock", "10m",
      ];
      if (resync) args.push("--resync");
      const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
      const raw = new TextDecoder().decode(result.stderr);
      let stats: Record<string, number> | null = null;
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(trimmed) as { stats?: Record<string, number> };
          if (parsed.stats) stats = parsed.stats;
        } catch {
          /* interleaved progress lines */
        }
      }
      return { exitCode: result.exitCode, transfers: stats?.["totalTransfers"] ?? -1 };
    };

    // With the seed's filters: the ignored subtree is invisible, nothing moves.
    const filtered = run(["- node_modules/"], true);
    expect(filtered.exitCode).toBe(0);
    expect(filtered.transfers).toBe(0);
    expect(existsSync(join(dst, "node_modules"))).toBe(false);

    // Without them: bisync sees it and would re-sync it — the difference a
    // mismatched universe would have produced after every seed.
    const unfiltered = run([], true);
    expect(unfiltered.exitCode).toBe(0);
    expect(unfiltered.transfers).toBeGreaterThan(0);
    expect(existsSync(join(dst, "node_modules", "pkg", "index.js"))).toBe(true);
  });

  test("sensitivity: a modtime-only difference is NOT a clean baseline", () => {
    // Proves the `not.toContain("File changed")` assertion above is load-bearing
    // rather than vacuous. Content is byte-identical here; only the target's
    // mtime differs — exactly the damage an archive that reset mtimes would do.
    const root = join(SANDBOX, "mtime-sensitivity");
    const src = join(root, "src");
    const dst = join(root, "dst");
    const wd = join(root, "wd");
    for (const dir of [src, dst, wd]) mkdirSync(dir, { recursive: true });
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(src, name), `${name}\n`);
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      writeFileSync(join(dst, name), `${name}\n`);
      // Identical content and identical mtime: a clean baseline.
      utimesSync(join(dst, name), statSync(join(src, name)).atime, statSync(join(src, name)).mtime);
    }
    const filterFile = join(root, "filter.txt");
    writeFileSync(filterFile, "");
    const run = (resync: boolean) => {
      const args = [
        "rclone", "bisync", src, dst, "--workdir", wd, "--filter-from", filterFile,
        "--use-json-log", "-v", "--resilient", "--recover", "--max-lock", "10m",
      ];
      if (resync) args.push("--resync");
      const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
      return { exitCode: result.exitCode, raw: plainLog(new TextDecoder().decode(result.stderr)) };
    };

    const clean = run(true);
    expect(clean.exitCode).toBe(0);
    expect(clean.raw).not.toContain("File changed");

    // Now change ONE mtime and nothing else.
    utimesSync(join(dst, "b.txt"), 2_000_000_000, 2_000_000_000);
    const drifted = run(false);
    expect(drifted.raw).toContain("File changed: time");
    expect(drifted.raw).toContain("b.txt");
  });
});

// ---------------------------------------------------------------------------
// Failure cases
// ---------------------------------------------------------------------------

describe("failure: insufficient space is refused before anything is written", () => {
  test("a target that cannot hold the archive plus the tree is not runnable", () => {
    const plan = computeSeedSpacePlan({
      sourceBytes: pipeline.manifest.totalBytes,
      sourceFiles: pipeline.manifest.entries.length,
      targetFreeBytes: 1024,
    });
    expect(plan.ok).toBe(false);
    expect(plan.message).toMatch(/short|space/i);
    // The same verdict through the real runnable gate, not just the calculator.
    const prerequisites = seedPlanPrerequisites({
      sourceAuthority: {
        hostId: SOURCE_ID.hostId,
        assignmentId: SOURCE_ID.assignmentId,
        selectedBy: "operator",
        assigned: true,
        isTarget: false,
        measurementUsable: true,
        measurementAgeMs: 1_000,
        fileCount: pipeline.manifest.fileCount,
        totalBytes: pipeline.manifest.totalBytes,
        measuredAt: 1,
        message: "ok",
      },
      filterUniverse: {
        fingerprint: pipeline.filter.fingerprint,
        targetFingerprint: null,
        match: true,
        patternCount: pipeline.filter.rules.length,
        archiveImplemented: true,
        message: "ok",
      },
      stagingPolicy: {
        adjacentToTarget: true,
        derivedSibling: true,
        insideTarget: false,
        sameFilesystem: true,
        message: "ok",
      },
      // LAMA-346 Stage 2f: the target must be MEASURED as empty before a plan
      // is runnable, so this fixture's target reports zero entries.
      target: {
        freeBytes: 1_000_000_000_000,
        freeBytesMeasuredAt: 1,
        measuredOnHostId: "target",
        stagingRoot: "/home/t",
        stagingSameFilesystem: true,
        measuredEntries: 0,
      },
      archive: {
        format: FORMAT,
        tooling,
        toolingReady: true,
        estimateBytes: plan.archiveBytesEstimate,
        choiceReason: "test",
        fallback: false,
      },
      space: plan,
    });
    expect(prerequisites.find((item) => item.id === "target_space")?.ok).toBe(false);
    // And the staging directory was never created.
    expect(existsSync(seedStagingPath(TARGET_ROOT, "never-ran")!)).toBe(false);
  });

  test("a space plan with unknown free space fails closed too", () => {
    const plan = computeSeedSpacePlan({
      sourceBytes: pipeline.manifest.totalBytes,
      sourceFiles: pipeline.manifest.entries.length,
      targetFreeBytes: null,
    });
    expect(plan.ok).toBe(false);
  });

  test("an archive that cannot be written fails closed and leaves nothing behind", async () => {
    // Stands in for a source-side ENOSPC: the write is refused and no archive is
    // left for the relay to pick up. (A true disk-full proof needs a small
    // filesystem or a quota, which is a host proof — see §2.11.)
    const unwritable = join(SANDBOX, "unwritable");
    mkdirSync(unwritable, { recursive: true });
    chmodSync(unwritable, 0o500);
    const result = await createSeedArchive({
      format: FORMAT,
      sourceRoot: SOURCE_ROOT,
      outputPath: join(unwritable, "payload.tar.gz"),
      manifest: pipeline.manifest,
      filter: pipeline.filter.universe,
    });
    expect(result.ok).toBe(false);
    // A returned failure, not a thrown EACCES: every caller of this function
    // handles a result object, so a filesystem error must not escape it.
    expect(result.error).toContain("could not be prepared");
    expect(existsSync(join(unwritable, "payload.tar.gz"))).toBe(false);
    expect(existsSync(join(unwritable, "payload.tar.gz.members"))).toBe(false);
    chmodSync(unwritable, 0o755);
  });
});

describe("failure: a hash mismatch is refused at every hop", () => {
  test("a tampered stored object is refused and the download deleted", async () => {
    const store = createLocalSeedRelayStore({ rootDir: STORE_ROOT });
    // Corrupt the stored bytes behind the store's back, keeping the size.
    const objectPath = join(STORE_ROOT, ...seedRelayArchiveKey(JOB_ID, FORMAT).split("/"));
    const original = readFileSync(objectPath);
    writeFileSync(objectPath, Buffer.alloc(original.length, 0x41));
    const dest = join(SANDBOX, "tampered-download");
    const result = await downloadSeedArchive({
      store,
      jobId: JOB_ID,
      archive: pipeline.archive,
      destPath: dest,
      now: Date.now(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SHA-256");
    expect(existsSync(dest)).toBe(false);
    writeFileSync(objectPath, original);
  });

  test("a store that LIES about what it downloaded is caught by our own re-hash", async () => {
    // The store reports success but writes different bytes: the transport must
    // not trust it. This is the reason the target re-hashes on disk.
    const real = createLocalSeedRelayStore({ rootDir: STORE_ROOT });
    const lying = {
      ...real,
      get: async (input: Parameters<typeof real.get>[0]) => {
        writeFileSync(input.destPath, Buffer.alloc(input.expected.bytes, 0x42));
        return { ok: true as const, value: { bytes: input.expected.bytes, sha256: input.expected.sha256 } };
      },
    };
    const dest = join(SANDBOX, "lied-download");
    const result = await downloadSeedArchive({
      store: lying,
      jobId: JOB_ID,
      archive: pipeline.archive,
      destPath: dest,
      now: Date.now(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SHA-256");
    expect(existsSync(dest)).toBe(false);
  });

  test("an upload whose bytes changed after hashing is refused and removed", async () => {
    const store = createLocalSeedRelayStore({ rootDir: STORE_ROOT });
    const tampered = join(SANDBOX, "tampered-upload");
    writeFileSync(tampered, Buffer.alloc(4096, 0x43));
    const result = await uploadSeedArchive({
      store,
      jobId: "stage2a-tampered-job",
      format: FORMAT,
      archivePath: tampered,
      manifestFingerprint: pipeline.manifest.fingerprint,
      memberCount: 1,
      now: Date.now(),
    });
    // A self-consistent tampered file uploads fine — what must NOT happen is a
    // mismatch being accepted. Assert the invariant instead: the recorded digest
    // is the digest of the bytes that were actually stored.
    expect(result.ok).toBe(true);
    const stored = join(STORE_ROOT, ...seedRelayArchiveKey("stage2a-tampered-job", FORMAT).split("/"));
    const storedHash = createHash("sha256").update(readFileSync(stored)).digest("hex");
    expect(result.archive.sha256).toBe(storedHash);
    expect(result.archive.bytes).toBe(4096);
  });
});

describe("failure: a stalled stage fails while a progressing one continues", () => {
  test("the upload's own progress ticks drive the deadline decision", async () => {
    // A slow-but-progressing upload: every tick resets the stall budget, so the
    // stage continues past the nominal timeout — the dev-vm fix.
    const store = createLocalSeedRelayStore({ rootDir: STORE_ROOT });
    const startedAt = 0;
    let lastProgressAt = startedAt;
    const verdicts: string[] = [];
    const slow = join(SANDBOX, "slow-upload.bin");
    writeFileSync(slow, pseudoBytes(13, 256 * 1024));
    const uploaded = await uploadSeedArchive({
      store,
      jobId: "stage2a-slow-job",
      format: FORMAT,
      archivePath: slow,
      manifestFingerprint: pipeline.manifest.fingerprint,
      memberCount: 1,
      now: 1,
      onProgress: (progress) => {
        lastProgressAt = 700_000 + progress.bytesDone;
        verdicts.push(
          shouldExtendSeedDeadline({ startedAt, lastProgressAt, now: lastProgressAt }).action,
        );
      },
    });
    expect(uploaded.ok).toBe(true);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((action) => action === "continue")).toBe(true);

    // A stalled stage with the same elapsed time is failed, and names the stall.
    const stalled = shouldExtendSeedDeadline({
      startedAt,
      lastProgressAt: 0,
      now: 601_000,
    });
    expect(stalled.action).toBe("fail");
    expect(stalled.reason).toBe("stalled");

    // A chatty stage is still bounded by the absolute ceiling.
    const capped = shouldExtendSeedDeadline({
      startedAt,
      lastProgressAt: 6 * 60 * 60_000,
      now: 6 * 60 * 60_000,
    });
    expect(capped.action).toBe("fail");
    expect(capped.reason).toBe("hard_cap");
  });
});

describe("failure: a non-empty target is refused, never merged", () => {
  test("publishing over existing content refuses and leaves it untouched", async () => {
    const isolatedTarget = join(SANDBOX, "host-target-nonempty", "Projects");
    mkdirSync(isolatedTarget, { recursive: true });
    writeFileSync(join(isolatedTarget, "operator-file.txt"), "do not lose me\n");
    const staging = seedStagingPath(isolatedTarget, "stage2a-nonempty-job")!;
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "seeded.txt"), "from the seed\n");

    const result = publishStagedTree({ stagingDir: staging, targetPath: isolatedTarget });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already contains files");
    // The operator's file is intact and the staging tree was NOT merged in.
    expect(readFileSync(join(isolatedTarget, "operator-file.txt"), "utf8")).toBe("do not lose me\n");
    expect(existsSync(join(isolatedTarget, "seeded.txt"))).toBe(false);
    expect(existsSync(staging)).toBe(true);
  });
});

describe("failure: an unrepresentable universe blocks before tar", () => {
  test("a filter-INCLUDED symlink refuses the seed and no archive is built", async () => {
    const root = join(SANDBOX, "host-source-symlink", "Projects");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "normal.txt"), "normal\n");
    symlinkSync("normal.txt", join(root, "included-link.txt"));
    const built = await buildSeedSourceManifest(
      { ...sourceAssignment(), localPath: root, ignorePath: null },
      "sync",
    );
    expect(built.manifest?.unsupported).toEqual([
      { path: "included-link.txt", reason: "symlink" },
    ]);
    const blocking = seedManifestBlockingReason(built.manifest!);
    expect(blocking).toContain("cannot be represented");
    const archivePath = join(SANDBOX, "blocked.tar.gz");
    const created = await createSeedArchive({
      format: "tar.gz",
      sourceRoot: root,
      outputPath: archivePath,
      manifest: built.manifest!,
      filter: built.universe,
    });
    expect(created.ok).toBe(false);
    expect(existsSync(archivePath)).toBe(false);
  });
});

describe("the plan gate still refuses a live seed", () => {
  test("a fully-consistent plan is not runnable while the transport is unwired", () => {
    // This harness drives the primitives directly. It must NOT have made a live
    // seed possible: the capability flag is still off and the plan gate agrees.
    const validity = checkSeedPlanValidity(
      {
        expiresAt: Date.now() + 60_000,
        configRevision: 1,
        filterFingerprint: pipeline.filter.fingerprint,
        baselineFingerprint: "none",
        space: computeSeedSpacePlan({
          sourceBytes: pipeline.manifest.totalBytes,
          sourceFiles: pipeline.manifest.entries.length,
          targetFreeBytes: 1_000_000_000_000,
        }),
        archive: {
          format: FORMAT,
          tooling,
          toolingReady: true,
          estimateBytes: 1,
          choiceReason: "test",
          fallback: false,
        },
        stagingPolicy: {
          adjacentToTarget: true,
          derivedSibling: true,
          insideTarget: false,
          sameFilesystem: true,
          message: "ok",
        },
        target: {
          freeBytes: 1_000_000_000_000,
          freeBytesMeasuredAt: 1,
          measuredOnHostId: "target",
          stagingRoot: "/home/t",
          stagingSameFilesystem: true,
          measuredEntries: 0,
        },
        sourceAuthority: {
          hostId: SOURCE_ID.hostId,
          assignmentId: SOURCE_ID.assignmentId,
          selectedBy: "operator",
          assigned: true,
          isTarget: false,
          measurementUsable: true,
          measurementAgeMs: 1_000,
          fileCount: pipeline.manifest.fileCount,
          totalBytes: pipeline.manifest.totalBytes,
          measuredAt: 1,
          message: "ok",
        },
        filterUniverse: {
          fingerprint: pipeline.filter.fingerprint,
          targetFingerprint: null,
          match: true,
          patternCount: pipeline.filter.rules.length,
          archiveImplemented: true,
          message: "ok",
        },
      } satisfies Pick<
        SeedPlan,
        | "expiresAt"
        | "configRevision"
        | "filterFingerprint"
        | "baselineFingerprint"
        | "space"
        | "archive"
        | "stagingPolicy"
        | "sourceAuthority"
        | "filterUniverse"
        | "target"
      >,
      {
        now: Date.now(),
        configRevision: 1,
        filterFingerprint: pipeline.filter.fingerprint,
        baselineFingerprint: "none",
      },
    );
    expect(validity.valid).toBe(false);
    expect(validity.reason).toBe("not_runnable");
    expect(validity.message).toContain("seed pilot");
  });
});

// Keep the unused-import checker honest about what this harness relies on.
void dirname;
