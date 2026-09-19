// Tests for the rclone argv builder + folder-lifecycle helpers (LAMA-308 /
// LAMA-309). Mostly pure functions; the mkdir / archive helpers touch the
// filesystem only.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, relative } from "path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { LamaSyncApiClient } from "@lamasync/core";
import type { EffectivePause, FolderAssignment } from "@lamasync/core";
import {
  appArchivePath,
  appArchiveTransforms,
  appTarExclude,
  captureAppSnapshot,
  isRecoverableAppTarResult,
  keepLocalConflictCopy,
  runAppTarCapture,
  archiveBisyncState,
  buildRcloneCommand,
  classifyRcloneExit,
  effectiveSyncFilterPatterns,
  effectiveBandwidthSchedule,
  ensureLocalDirectory,
  executeAssignment,
  isPauseActive,
  pickConflictAction,
  bisyncResyncPlan,
  shouldAcknowledgeFilter,
  selectRunTimeoutSec,
} from "./executor.ts";

describe("appArchivePath", () => {
  test("uses a portable home namespace and a separate absolute namespace", () => {
    expect(appArchivePath("~/.config/foo/settings.json")).toBe(
      "home/.config/foo/settings.json",
    );
    expect(appArchivePath("/etc/foo/settings.json")).toBe(
      "absolute/etc/foo/settings.json",
    );
  });

  test("rejects root, relative, and traversal paths", () => {
    expect(appArchivePath("/")).toBeNull();
    expect(appArchivePath("relative/settings.json")).toBeNull();
    expect(appArchivePath("~/.config/../secrets")).toBeNull();
  });
});

describe("appArchiveTransforms", () => {
  test("matches only a selected source path or its descendants", () => {
    expect(appArchiveTransforms("tmp/lamasync/foo", "home/.config/foo")).toEqual([
      "--transform=s|^tmp/lamasync/foo/|home/.config/foo/|",
      "--transform=s|^tmp/lamasync/foo$|home/.config/foo|",
    ]);
  });
});

describe("app tar capture helpers", () => {
  test("normalizes home and absolute excludes into tar's root-relative namespace", () => {
    expect(appTarExclude("~/.hermes/backups")).toBe(
      `${homedir().slice(1)}/.hermes/backups`,
    );
    expect(appTarExclude("/var/lib/app/*.sock")).toBe("var/lib/app/*.sock");
    expect(appTarExclude("node_modules")).toBe("node_modules");
  });

  test("accepts only the known live-tree tar warnings at exit 1", () => {
    expect(isRecoverableAppTarResult(0, "")).toBe(true);
    expect(isRecoverableAppTarResult(1, [
      "tar: home/alice/.hermes/state.db: file changed as we read it",
      "tar: home/alice/.hermes/gateway.sock: socket ignored",
    ].join("\n"))).toBe(true);
    expect(isRecoverableAppTarResult(1, "tar: home/alice/.hermes/private: Cannot open: Permission denied\n")).toBe(false);
    expect(isRecoverableAppTarResult(2, "tar: Error is not recoverable: exiting now\n")).toBe(false);
    expect(isRecoverableAppTarResult(1, "")).toBe(false);
  });
});

// LAMA-336: the exit-code contract above only matters if real GNU tar
// produces those diagnostics. These tests drive the production tar seam
// (runAppTarCapture) and the full capture path against a live tree
// containing an actual changing file and an actual Unix socket.
const MEGABYTE = 1024 * 1024;

function liveBinary(sizeBytes: number): Buffer {
  const chunk = randomBytes(MEGABYTE);
  return Buffer.concat(Array.from({ length: sizeBytes / MEGABYTE }, () => chunk));
}

function listArchiveMembers(tarball: string): string[] {
  const listed = Bun.spawnSync(["tar", "tzf", tarball], { stdout: "pipe", stderr: "pipe" });
  if (listed.exitCode !== 0) throw new Error(`tar tzf failed: ${new TextDecoder().decode(listed.stderr)}`);
  return new TextDecoder().decode(listed.stdout).split("\n").filter(Boolean);
}

describe("app tar capture against real GNU tar (LAMA-336)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lamasync-app-tar-"));
  });

  afterEach(() => {
    // A permission-denied fixture has to be repaired before it can be removed.
    const locked = join(root, "locked");
    if (existsSync(locked)) chmodSync(locked, 0o700);
    rmSync(root, { recursive: true, force: true });
  });

  async function listenOnUnixSocket(path: string): Promise<Server> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    return server;
  }

  /** Keep appending for as long as the capture runs, so tar re-stats the
   * member after reading it and reports a changed file. */
  function appendWhile<T>(promise: Promise<T>, file: string): Promise<T> {
    const timer = setInterval(() => appendFileSync(file, "x"), 1);
    return promise.finally(() => clearInterval(timer));
  }

  test("a socket and a file changing during the read are recoverable", async () => {
    const appDir = join(root, "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "keep.txt"), "keep");
    const live = join(appDir, "live.bin");
    writeFileSync(live, liveBinary(8 * MEGABYTE));
    const socket = await listenOnUnixSocket(join(appDir, "gateway.sock"));
    const tarball = join(root, "out.tar.gz");

    try {
      const result = await appendWhile(
        runAppTarCapture({
          tarball,
          archiveInputs: [relative("/", appDir)],
          transforms: [],
          excludes: [],
        }),
        live,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("file changed as we read it");
      expect(result.stderr).toContain("socket ignored");
      expect(isRecoverableAppTarResult(result.exitCode, result.stderr)).toBe(true);

      // The archive is still usable: it holds the regular file, and the
      // socket is skipped rather than stored as a broken entry.
      const members = listArchiveMembers(tarball);
      expect(members).toContain(relative("/", join(appDir, "keep.txt")));
      expect(members.some((member) => member.endsWith("gateway.sock"))).toBe(false);
    } finally {
      socket.close();
    }
  });

  test("permission denied stays fatal", async () => {
    const locked = join(root, "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "secret.txt"), "secret");
    chmodSync(locked, 0o000);

    const result = await runAppTarCapture({
      tarball: join(root, "out.tar.gz"),
      archiveInputs: [relative("/", locked)],
      transforms: [],
      excludes: [],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Permission denied");
    expect(isRecoverableAppTarResult(result.exitCode, result.stderr)).toBe(false);
  });

  test("captureAppSnapshot uploads a live tree and honours absolute excludes", async () => {
    const appDir = join(root, "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "keep.txt"), "keep");
    writeFileSync(join(appDir, "skip.txt"), "skip");
    const live = join(appDir, "live.bin");
    writeFileSync(live, liveBinary(8 * MEGABYTE));
    const socket = await listenOnUnixSocket(join(appDir, "gateway.sock"));

    let uploaded: Uint8Array | null = null;
    const client = new LamaSyncApiClient("http://localhost:8080", "key", {
      fetchImpl: (async (_input: unknown, init?: RequestInit) => {
        const body = init?.body;
        if (body instanceof FormData) {
          const tarball = body.get("tarball");
          if (tarball instanceof Blob) uploaded = new Uint8Array(await tarball.arrayBuffer());
        }
        return new Response(JSON.stringify({ id: "snap-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
      timeoutMs: 5_000,
      maxRetries: 0,
    });

    try {
      const report = await appendWhile(
        captureAppSnapshot({
          hostId: "dev-vm",
          client,
          app: {
            appName: "hermes",
            hostId: "dev-vm",
            protectionId: "p1",
            paths: [appDir],
            excludes: [join(appDir, "skip.txt")],
          },
        }),
        live,
      );
      expect(report.status).toBe("success");
      expect(report.summary).toContain("app capture ok");
    } finally {
      socket.close();
    }

    // Re-read the uploaded archive to prove the exclude reached tar and the
    // live-tree warning did not silently truncate the payload.
    expect(uploaded).not.toBeNull();
    const received = join(root, "received.tar.gz");
    writeFileSync(received, uploaded ?? new Uint8Array());
    const members = listArchiveMembers(received);
    const archiveRoot = appArchivePath(appDir);
    expect(archiveRoot).not.toBeNull();
    expect(members).toContain(`${archiveRoot}/keep.txt`);
    expect(members.some((member) => member.endsWith("skip.txt"))).toBe(false);
    expect(members.some((member) => member.endsWith("live.bin"))).toBe(true);
  });

  test("captureAppSnapshot reports a permission-denied tree as failed without uploading", async () => {
    const locked = join(root, "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "secret.txt"), "secret");
    chmodSync(locked, 0o000);

    let uploads = 0;
    const client = new LamaSyncApiClient("http://localhost:8080", "key", {
      fetchImpl: (() => {
        uploads += 1;
        return Promise.resolve(new Response(JSON.stringify({ id: "snap-1" }), { status: 200 }));
      }) as unknown as typeof fetch,
      timeoutMs: 5_000,
      maxRetries: 0,
    });

    const report = await captureAppSnapshot({
      hostId: "dev-vm",
      client,
      app: { appName: "hermes", hostId: "dev-vm", protectionId: "p1", paths: [locked] },
    });
    expect(report.status).toBe("failed");
    expect(report.summary).toContain("app archive failed");
    expect(report.details).toContain("Permission denied");
    expect(uploads).toBe(0);
  });
});

describe("buildRcloneCommand", () => {
  test("sync emits bisync with resilient flags and workdir", () => {
    const argv = buildRcloneCommand({
      folderType: "sync",
      remotePath: "remote:Sync",
      localPath: "/tmp/Sync",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: null,
      bisyncStateful: true,
      bisyncStateDir: "/tmp/state",
    });
    expect(argv).toEqual([
      "bisync",
      "remote:Sync",
      "/tmp/Sync",
      "--config",
      "/tmp/rclone.conf",
      "--use-json-log",
      "-v",
      "--workdir",
      "/tmp/state",
      "--resilient",
      "--recover",
      "--max-lock",
      "10m",
    ]);
  });

  test("sync dry-run omits stateful flags and adds --dry-run", () => {
    const argv = buildRcloneCommand({
      folderType: "sync",
      remotePath: "remote:Sync",
      localPath: "/tmp/Sync",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: null,
      dryRun: true,
    });
    expect(argv).toContain("--dry-run");
    expect(argv).not.toContain("--resilient");
    expect(argv).not.toContain("--workdir");
  });

  test("backup emits copy with optional dry-run", () => {
    const argv = buildRcloneCommand({
      folderType: "backup",
      remotePath: "remote:Backup",
      localPath: "/tmp/Backup",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: null,
    });
    expect(argv).toEqual([
      "copy",
      "/tmp/Backup",
      "remote:Backup",
      "--config",
      "/tmp/rclone.conf",
      "--use-json-log",
      "-v",
    ]);
    expect(argv).not.toContain("--dry-run");

    const dry = buildRcloneCommand({
      folderType: "backup",
      remotePath: "remote:Backup",
      localPath: "/tmp/Backup",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: null,
      dryRun: true,
    });
    expect(dry).toContain("--dry-run");
  });

  test("mount emits mount with --daemon", () => {
    const argv = buildRcloneCommand({
      folderType: "mount",
      remotePath: "remote:Mount",
      localPath: "/mnt/Mount",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: null,
    });
    expect(argv).toContain("mount");
    expect(argv).toContain("--daemon");
    expect(argv).toContain("/mnt/Mount");
  });

  test("excludeFilePath adds --filter-from with the file", () => {
    const argv = buildRcloneCommand({
      folderType: "sync",
      remotePath: "remote:Sync",
      localPath: "/tmp/Sync",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: "/tmp/lamasync.exclude",
    });
    const idx = argv.indexOf("--filter-from");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("/tmp/lamasync.exclude");
  });

  test("ignoreGitMetadata excludes .git from the sync transfer", () => {
    expect(effectiveSyncFilterPatterns(["- node_modules/**"], "sync", true)).toEqual([
      "- .git/**",
      "- node_modules/**",
    ]);
    expect(effectiveSyncFilterPatterns(["- node_modules/**"], "mount", true)).toEqual([
      "- node_modules/**",
    ]);
  });

  test("bandwidthSchedule trims whitespace and adds --bwlimit", () => {
    const argv = buildRcloneCommand({
      folderType: "sync",
      remotePath: "remote:Sync",
      localPath: "/tmp/Sync",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: null,
      bandwidthSchedule: "  10M  ",
    });
    const idx = argv.indexOf("--bwlimit");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("10M");
  });

  test("bandwidthSchedule empty string is ignored", () => {
    const argv = buildRcloneCommand({
      folderType: "sync",
      remotePath: "remote:Sync",
      localPath: "/tmp/Sync",
      configPath: "/tmp/rclone.conf",
      excludeFilePath: null,
      bandwidthSchedule: "   ",
    });
    expect(argv).not.toContain("--bwlimit");
  });

  test("unsupported folder types throw", () => {
    expect(() =>
      buildRcloneCommand({
        folderType: "dotfile" as never,
        remotePath: "r:d",
        localPath: "/tmp/d",
        configPath: "/tmp/c",
        excludeFilePath: null,
      }),
    ).toThrow(/unsupported folder type/);
  });
});

describe("classifyRcloneExit (LAMA-294)", () => {
  test("exit 0 is success", () => {
    expect(classifyRcloneExit(0)).toBe("success");
  });

  test("exit 9 is NoFilesTransferred (a success, not an error)", () => {
    expect(classifyRcloneExit(9)).toBe("no-transfer");
  });

  test("exit 5 is a retryable transient error", () => {
    expect(classifyRcloneExit(5)).toBe("retryable");
  });

  test("bisync exit 1 is retryable but copy exit 1 is not", () => {
    expect(classifyRcloneExit(1, "sync")).toBe("retryable");
    expect(classifyRcloneExit(1, "backup")).toBe("non-retryable");
  });

  test("missing paths, syntax, fatal, quota are non-retryable", () => {
    // DirNotFound, FileNotFound, UsageError, NoRetryError, FatalError,
    // TransferExceeded, DurationExceeded, Uncategorized.
    for (const code of [1, 2, 3, 4, 6, 7, 8, 10]) {
      expect(classifyRcloneExit(code)).toBe("non-retryable");
    }
  });
});

describe("pickConflictAction", () => {
  test("newer_wins picks local when local is newer", () => {
    expect(pickConflictAction("newer_wins", 200, 100, "both")).toEqual({ kind: "local_wins" });
  });

  test("newer_wins picks remote when remote is newer", () => {
    expect(pickConflictAction("newer_wins", 100, 200, "both")).toEqual({ kind: "remote_wins" });
  });

  test("newer_wins falls back to keep_both on equal mtimes", () => {
    expect(pickConflictAction("newer_wins", 100, 100, "both")).toEqual({ kind: "keep_both" });
  });

  test("newer_wins falls back to keep_both when mtimes are missing", () => {
    expect(pickConflictAction("newer_wins", undefined, undefined, "both")).toEqual({ kind: "keep_both" });
  });

  test("source_wins uses local for source and both roles", () => {
    expect(pickConflictAction("source_wins", 100, 200, "source")).toEqual({ kind: "local_wins" });
    expect(pickConflictAction("source_wins", 100, 200, "both")).toEqual({ kind: "local_wins" });
  });

  test("source_wins uses remote for target role", () => {
    expect(pickConflictAction("source_wins", 200, 100, "target")).toEqual({ kind: "remote_wins" });
  });

  test("keep_both always keeps both", () => {
    expect(pickConflictAction("keep_both", 200, 100, "source")).toEqual({ kind: "keep_both" });
    expect(pickConflictAction("keep_both", 100, 200, "target")).toEqual({ kind: "keep_both" });
  });
});

// LAMA-273: pause / slow-mode helpers. The helpers are pure so we can
// exercise them without touching rclone or the hostConfig cache.
describe("effectiveBandwidthSchedule (LAMA-273)", () => {
  const baseAssignment: Pick<FolderAssignment, "bandwidthSchedule"> = {
    bandwidthSchedule: "10M",
  };
  const now = 1_700_000_000_000;

  test("returns null with no pause and no schedule", () => {
    expect(effectiveBandwidthSchedule({ bandwidthSchedule: null }, null, now)).toBeNull();
  });

  test("returns the assignment schedule when no pause is active", () => {
    expect(effectiveBandwidthSchedule(baseAssignment, null, now)).toBe("10M");
  });

  test("slow-mode pause bwlimit wins over the assignment schedule", () => {
    const pause: EffectivePause = {
      until: new Date(now + 60_000).toISOString(),
      mode: "slow",
      bwlimit: "1M",
    };
    expect(effectiveBandwidthSchedule(baseAssignment, pause, now)).toBe("1M");
  });

  test("pause-mode bwlimit is ignored — only slow mode injects --bwlimit", () => {
    const pause: EffectivePause = {
      until: new Date(now + 60_000).toISOString(),
      mode: "pause",
      // Defensive: even if a pause row carried bwlimit, the executor
      // must not throttle. The route layer rejects this combo, but the
      // helper is the second line of defense.
      bwlimit: "1M",
    };
    expect(effectiveBandwidthSchedule(baseAssignment, pause, now)).toBe("10M");
  });

  test("expired pause falls back to the assignment schedule", () => {
    const pause: EffectivePause = {
      until: new Date(now - 1).toISOString(),
      mode: "slow",
      bwlimit: "1M",
    };
    expect(effectiveBandwidthSchedule(baseAssignment, pause, now)).toBe("10M");
  });

  test("slow pause without a bwlimit falls back to the assignment schedule", () => {
    const pause: EffectivePause = {
      until: new Date(now + 60_000).toISOString(),
      mode: "slow",
      bwlimit: null,
    };
    expect(effectiveBandwidthSchedule(baseAssignment, pause, now)).toBe("10M");
  });

  test("trims whitespace from either source", () => {
    const pause: EffectivePause = {
      until: new Date(now + 60_000).toISOString(),
      mode: "slow",
      bwlimit: "  512K  ",
    };
    expect(effectiveBandwidthSchedule({ bandwidthSchedule: "  10M  " }, pause, now)).toBe("512K");
    expect(effectiveBandwidthSchedule({ bandwidthSchedule: "  10M  " }, null, now)).toBe("10M");
  });
});

describe("isPauseActive (LAMA-273)", () => {
  const now = 1_700_000_000_000;
  test("null / undefined pauses are inactive", () => {
    expect(isPauseActive(null, now)).toBe(false);
    expect(isPauseActive(undefined, now)).toBe(false);
  });
  test("future until is active", () => {
    expect(isPauseActive({ until: new Date(now + 1).toISOString(), mode: "pause", bwlimit: null }, now)).toBe(true);
  });
  test("past until is inactive", () => {
    expect(isPauseActive({ until: new Date(now - 1).toISOString(), mode: "pause", bwlimit: null }, now)).toBe(false);
  });
  test("garbage until is treated as inactive (fail-safe)", () => {
    expect(isPauseActive({ until: "not-a-date", mode: "pause", bwlimit: null }, now)).toBe(false);
  });
});

// LAMA-273: belt-and-braces — executeAssignment must short-circuit with
// a clear "paused until <iso>" report when hostConfig.pause is active,
// without spawning rclone. We exercise the helper directly via a tiny
// fake ExecuteOptions shape to assert the refusal path.
describe("executeAssignment pause refusal (LAMA-273)", () => {
  test("refuses with a paused summary when hostConfig.pause is active", async () => {
    const { executeAssignment } = await import("./executor.ts");
    const futureIso = new Date(Date.now() + 60 * 60_000).toISOString();
    const report = await executeAssignment({
      assignment: {
        id: "a1",
        folderId: "f1",
        hostId: "h1",
        role: "source",
        localPath: "/tmp/lamasync-test",
        enabled: true,
      },
      folder: { id: "f1", name: "MySync", type: "sync" },
      hostConfig: {
        host: { id: "h1", hostname: "h1", status: "online" },
        assignments: [],
        folders: [],
        apps: [],
        rcloneConfig: "[fake]\ntype = local\n",
        serverTailnetIp: null,
        peers: [],
        pause: { until: futureIso, mode: "pause", bwlimit: null },
      },
      client: {} as never, // pause refusal returns before any client call
      hostId: "h1",
      configPath: "/tmp/none",
    });
    expect(report.status).toBe("failed");
    expect(report.summary).toContain("sync skipped: paused until");
    expect(report.summary).toContain(futureIso);
    // No rclone was invoked — the rclone-missing error path would
    // produce a different summary, so the presence of the "paused"
    // marker is sufficient.
    expect(report.summary).not.toContain("rclone binary not found");
  });
});

// LAMA-309: the local directory must be created for sync/mount folders (not
// backup/dotfile), and a create failure must surface a clear summary so the
// run fails before rclone is invoked.
describe("ensureLocalDirectory (LAMA-309)", () => {
  test("creates the dir for sync and mount", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-ensure-"));
    const syncPath = join(dir, "sync");
    const mountPath = join(dir, "mount");
    try {
      expect(ensureLocalDirectory("sync", syncPath)).toBeNull();
      expect(existsSync(syncPath)).toBe(true);
      expect(ensureLocalDirectory("mount", mountPath)).toBeNull();
      expect(existsSync(mountPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT create a dir for backup or dotfile types", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-ensure-"));
    const backupPath = join(dir, "backup");
    const dotfilePath = join(dir, "dotfile");
    try {
      expect(ensureLocalDirectory("backup", backupPath)).toBeNull();
      expect(ensureLocalDirectory("dotfile", dotfilePath)).toBeNull();
      expect(existsSync(backupPath)).toBe(false);
      expect(existsSync(dotfilePath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns a clear failure summary when the dir cannot be created", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-ensure-"));
    const file = join(dir, "afile");
    writeFileSync(file, "x");
    const blocked = join(file, "sub"); // parent is a file -> ENOTDIR
    try {
      const err = ensureLocalDirectory("sync", blocked);
      expect(err).toBeTruthy();
      expect(err).toContain("local directory " + blocked + " could not be created");
      expect(err).toContain("ENOTDIR");
      expect(existsSync(blocked)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// LAMA-309: executeAssignment must fail the sync run with the mkdir summary
// before invoking rclone when the local directory cannot be created.
describe("executeAssignment mkdir failure (LAMA-309)", () => {
  test("fails with the clear summary before invoking rclone", async () => {
    // CI runners have no rclone, and the rclone-PATH check precedes the
    // mkdir guard in executeAssignment. Stub the PATH probe so the mkdir
    // failure path is exercised deterministically everywhere.
    const origWhich = Bun.which;
    Bun.which = () => "/usr/bin/rclone";
    const dir = mkdtempSync(join(tmpdir(), "lamasync-exec-"));
    const file = join(dir, "afile");
    writeFileSync(file, "x");
    const blocked = join(file, "sub");
    try {
      const report = await executeAssignment({
        assignment: {
          id: "a1",
          folderId: "f1",
          hostId: "h1",
          role: "source",
          localPath: blocked,
          enabled: true,
        },
        folder: { id: "f1", name: "MySync", type: "sync" },
        hostConfig: {
          host: { id: "h1", hostname: "h1", status: "online" },
          assignments: [],
          folders: [],
          apps: [],
          rcloneConfig: "[fake]\ntype = local\n",
          serverTailnetIp: null,
          peers: [],
        },
        client: {} as never, // mkdir failure returns before any client call
        hostId: "h1",
        configPath: "/tmp/none",
      });
      expect(report.status).toBe("failed");
      expect(report.summary).toContain("local directory " + blocked + " could not be created");
      // The mkdir guard runs after the rclone-PATH check but before the
      // command switch, so rclone was never spawned for this run.
      expect(report.summary).not.toContain("rclone binary not found");
    } finally {
      Bun.which = origWhich;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// LAMA-308: corrupted bisync-state archive names must never collide — the
// old second-resolution ".corrupted.<YYYYMMDDTHHmm>" suffix is replaced with
// a millisecond timestamp plus a counter when the target already exists.
describe("archiveBisyncState (LAMA-308)", () => {
  test("uses a millisecond timestamp instead of second resolution", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-archive-"));
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    const now = new Date("2026-09-02T19:06:10.123Z");
    try {
      const archived = archiveBisyncState(stateDir, now);
      expect(archived).toBe(stateDir + ".corrupted.2026-09-02T190610123Z");
      expect(archived).toContain("123Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appends a counter when the target archive name already exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-archive-"));
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    const now = new Date("2026-09-02T19:06:10.123Z");
    const first = stateDir + ".corrupted.2026-09-02T190610123Z";
    // Pre-create the exact name the function would pick, forcing collision.
    mkdirSync(first);
    try {
      const archived = archiveBisyncState(stateDir, now);
      expect(archived).toBe(first + ".1");
      expect(existsSync(first + ".1")).toBe(true);
      expect(existsSync(stateDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// LAMA-336: the manual keep-both path ran `mv` through Bun.spawnSync and
// ignored its exit status, then pulled the remote file into the original path.
// A failed rename therefore overwrote the local copy and still reported the
// conflict resolved. The move is now a checked rename that throws first.
describe("keepLocalConflictCopy (LAMA-336)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lamasync-keep-both-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const at = new Date("2026-09-13T10:20:30Z");

  test("moves the local copy aside and frees the original path", () => {
    const localFile = join(dir, "notes.txt");
    writeFileSync(localFile, "local version");
    const moved = keepLocalConflictCopy(localFile, at);
    expect(moved).toBe(`${localFile}.conflict-20260913`);
    expect(existsSync(localFile)).toBe(false);
    expect(existsSync(moved!)).toBe(true);
  });

  test("a second same-day conflict gets its own name instead of replacing the first", () => {
    const localFile = join(dir, "notes.txt");
    writeFileSync(localFile, "local version");
    const first = keepLocalConflictCopy(localFile, at);
    writeFileSync(localFile, "local version again");
    const second = keepLocalConflictCopy(localFile, at);

    expect(first).toBe(`${localFile}.conflict-20260913`);
    expect(second).toBe(`${localFile}.conflict-20260913.1`);
    expect(existsSync(first!)).toBe(true);
    expect(existsSync(second!)).toBe(true);
  });

  test("nothing to preserve returns null (the caller only pulls the remote side)", () => {
    expect(keepLocalConflictCopy(join(dir, "absent.txt"), at)).toBeNull();
  });

  test("a failed move throws and leaves the local copy untouched", () => {
    // Make the destination directory unwritable so the rename cannot land.
    // The caller must abort instead of pulling the remote file over the local
    // one: the local file is still exactly where it was, with its content.
    const lockedDir = join(dir, "locked");
    mkdirSync(lockedDir, { recursive: true });
    const localFile = join(lockedDir, "notes.txt");
    writeFileSync(localFile, "local version");
    chmodSync(lockedDir, 0o500);
    try {
      expect(() => keepLocalConflictCopy(localFile, at)).toThrow();
      expect(readFileSync(localFile, "utf8")).toBe("local version");
    } finally {
      chmodSync(lockedDir, 0o700);
    }
  });
});

// LAMA-345: the bisync resync decision, extracted as a pure function so the
// two acceptance rules are pinned without invoking rclone.
describe("bisyncResyncPlan (LAMA-345)", () => {
  test("a completed run with a ready paired baseline is NOT resynced", () => {
    expect(
      bisyncResyncPlan({ baselineReady: true, filterChanged: false, control: undefined }),
    ).toEqual({ resync: false, resyncMode: null, reason: null });
  });

  test("no usable listing pair forces a resync with the conservative Path 1 (remote) authority", () => {
    expect(
      bisyncResyncPlan({ baselineReady: false, filterChanged: false, control: undefined }),
    ).toEqual({ resync: true, resyncMode: "path1", reason: "no-baseline" });
  });

  test("a changed filter universe forces a resync rather than reusing stale listings", () => {
    expect(
      bisyncResyncPlan({ baselineReady: true, filterChanged: true, control: undefined }),
    ).toEqual({ resync: true, resyncMode: "path1", reason: "filter-changed" });
  });

  test("an explicit intervention always resyncs with the reviewed authority", () => {
    expect(
      bisyncResyncPlan({
        baselineReady: true,
        filterChanged: false,
        control: { mode: "initialize", authority: "remote" },
      }),
    ).toEqual({ resync: true, resyncMode: "path1", reason: "initialize" });
    // `seed` — the local tree (Path 2) is authoritative, never the implicit
    // Path 1 direction the old code fell into.
    expect(
      bisyncResyncPlan({
        baselineReady: true,
        filterChanged: false,
        control: { mode: "seed", authority: "local" },
      }),
    ).toEqual({ resync: true, resyncMode: "path2", reason: "seed" });
  });

  test("a resume is a normal run — no resync, no authority", () => {
    expect(
      bisyncResyncPlan({ baselineReady: true, filterChanged: false, control: { mode: "normal" } }),
    ).toEqual({ resync: false, resyncMode: null, reason: null });
  });
});

describe("shouldAcknowledgeFilter (LAMA-345)", () => {
  test("acknowledges only after a clean run that left a usable baseline", () => {
    expect(
      shouldAcknowledgeFilter({ filterChanged: true, runSucceeded: true, baselineEstablished: true }),
    ).toBe(true);
  });

  test("a failed resync never acknowledges the new fingerprint", () => {
    expect(
      shouldAcknowledgeFilter({ filterChanged: true, runSucceeded: false, baselineEstablished: true }),
    ).toBe(false);
  });

  test("a run that left no usable pair never acknowledges it either", () => {
    expect(
      shouldAcknowledgeFilter({ filterChanged: true, runSucceeded: true, baselineEstablished: false }),
    ).toBe(false);
  });

  test("with no filter change there is nothing to acknowledge", () => {
    expect(
      shouldAcknowledgeFilter({ filterChanged: false, runSucceeded: true, baselineEstablished: true }),
    ).toBe(false);
  });
});

// LAMA-345: a planned dry run is a real enumeration of both sides, so it must
// not be cut off by the legacy 60 s preview budget — that is exactly what
// would make every plan on a Projects-scale folder time out.
describe("selectRunTimeoutSec (LAMA-345)", () => {
  test("a planned dry run uses the assignment timeout", () => {
    expect(
      selectRunTimeoutSec({ dryRun: true, planned: true, assignmentTimeoutSec: 3_600 }),
    ).toBe(3_600);
  });

  test("a planned dry run with no assignment timeout falls back to the run default, not 60 s", () => {
    expect(selectRunTimeoutSec({ dryRun: true, planned: true, assignmentTimeoutSec: null })).toBe(
      600,
    );
  });

  test("a legacy ad-hoc preview keeps the short budget", () => {
    expect(
      selectRunTimeoutSec({ dryRun: true, planned: false, assignmentTimeoutSec: 3_600 }),
    ).toBe(60);
  });

  test("a real run uses the assignment timeout, else the run default", () => {
    expect(
      selectRunTimeoutSec({ dryRun: false, planned: false, assignmentTimeoutSec: 120 }),
    ).toBe(120);
    expect(
      selectRunTimeoutSec({ dryRun: false, planned: false, assignmentTimeoutSec: null }),
    ).toBe(600);
  });
});
