// LAMA-302: Linux inotify adapter integration test. Real filesystem — a
// temp worktree is watched and a write must fire `onDirty`. Linux-gated (the
// adapter uses Node's inotify-backed `fs.watch` recursive).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { FolderAssignment } from "@lamasync/core";
import { createLinuxInotifyFactory } from "./folder-watch.ts";

const isLinux = process.platform === "linux";

function assignment(overrides: Partial<FolderAssignment> = {}): FolderAssignment {
  return {
    id: "a-1",
    folderId: "f-1",
    hostId: "h-1",
    role: "both",
    localPath: overrides.localPath ?? "/tmp/placeholder",
    enabled: true,
    watchEnabled: true,
    ...overrides,
  };
}

function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (fn()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const skip = !isLinux;

describe("Linux inotify adapter (live)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lamasync-live-watch-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test.skipIf(skip)("a write below the watched root fires onDirty", async () => {
    const factory = createLinuxInotifyFactory();
    let dirty = 0;
    let err: Error | null = null;
    const handle = factory.start({
      assignment: assignment({ localPath: dir }),
      onDirty: () => { dirty += 1; },
      onError: (e) => { err = e; },
    });
    try {
      await new Promise((r) => setTimeout(r, 50)); // let the watcher attach
      writeFileSync(join(dir, "foo.txt"), "x");
      await waitFor(() => dirty > 0);
      expect(dirty).toBeGreaterThan(0);
      expect(err).toBeNull();
    } finally {
      handle.close();
    }
  });

  test.skipIf(skip)("a write in a subdirectory created after start also fires onDirty", async () => {
    const factory = createLinuxInotifyFactory();
    let dirty = 0;
    const handle = factory.start({
      assignment: assignment({ localPath: dir }),
      onDirty: () => { dirty += 1; },
      onError: () => undefined,
    });
    try {
      await new Promise((r) => setTimeout(r, 50));
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "bar.txt"), "y");
      await waitFor(() => dirty > 0);
      expect(dirty).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  test.skipIf(skip)("ignoreGitMetadata suppresses .git events", async () => {
    const factory = createLinuxInotifyFactory();
    let dirty = 0;
    const handle = factory.start({
      assignment: assignment({ localPath: dir, ignoreGitMetadata: true }),
      onDirty: () => { dirty += 1; },
      onError: () => undefined,
    });
    try {
      await new Promise((r) => setTimeout(r, 50));
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      // Give any (wrongly) suppressed callback a chance to fire.
      await new Promise((r) => setTimeout(r, 120));
      expect(dirty).toBe(0);
    } finally {
      handle.close();
    }
  });
});
