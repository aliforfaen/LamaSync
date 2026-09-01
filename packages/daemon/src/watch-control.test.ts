// LAMA-302: coordinator eligibility tests — only effective `sync` +
// watchEnabled assignments with an existing local path start a watcher.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Folder, FolderAssignment } from "@lamasync/core";
import { WatchCoordinator } from "./watch-control.ts";
import { type FolderWatchFactory, type FolderWatchHandle } from "./folder-watch.ts";

let realDir: string;

beforeEach(() => {
  realDir = mkdtempSync(join(tmpdir(), "lamasync-watch-ctrl-"));
});
afterEach(() => {
  rmSync(realDir, { recursive: true, force: true });
});

function folder(id: string, type: Folder["type"]): Folder {
  return { id, name: id, type };
}

function assignment(
  id: string,
  folderId: string,
  overrides: Partial<FolderAssignment> = {},
): FolderAssignment {
  return {
    id,
    folderId,
    hostId: "h-1",
    role: "both",
    localPath: realDir,
    enabled: true,
    ...overrides,
  };
}

class FakeFactory implements FolderWatchFactory {
  started: string[] = [];
  stopped: string[] = [];
  start(options: { assignment: FolderAssignment }): FolderWatchHandle {
    this.started.push(options.assignment.id);
    const assignmentId = options.assignment.id;
    const factory = this;
    return {
      close() {
        factory.stopped.push(assignmentId);
      },
    };
  }
}

function makeCoordinator(overrides: {
  factory?: FakeFactory;
  assignments: FolderAssignment[];
  folders: Folder[];
  runOnce?: (a: FolderAssignment) => Promise<void>;
  log?: (m: string) => void;
}): { coordinator: WatchCoordinator; factory: FakeFactory } {
  const factory = overrides.factory ?? new FakeFactory();
  const log = overrides.log ?? (() => undefined);
  const coordinator = new WatchCoordinator({
    factory,
    getAssignments: () => overrides.assignments,
    getFolders: () => overrides.folders,
    runOnce: overrides.runOnce ?? (async () => undefined),
    log,
  });
  return { coordinator, factory };
}

describe("WatchCoordinator eligibility", () => {
  test("starts a watcher only for effective sync + watchEnabled + existing path", () => {
    const { coordinator, factory } = makeCoordinator({
      assignments: [
        assignment("a-sync", "f-sync", { watchEnabled: true }),
        assignment("a-sync-off", "f-sync2", { watchEnabled: false }), // not opted-in
        assignment("a-mount", "f-mount", { watchEnabled: true }), // effective mount
        assignment("a-backup", "f-backup", { watchEnabled: true }), // type backup
        assignment("a-missing", "f-missing", {
          watchEnabled: true,
          localPath: join(realDir, "does-not-exist"),
        }),
      ],
      folders: [
        folder("f-sync", "sync"),
        folder("f-sync2", "sync"),
        folder("f-mount", "mount"),
        folder("f-backup", "backup"),
        folder("f-missing", "sync"),
      ],
    });
    coordinator.reconcile();
    // Only the effective sync + enabled + existing-path assignment starts.
    expect(factory.started).toEqual(["a-sync"]);
    coordinator.shutdown();
  });

  test("a mount override on a sync folder is never watched", () => {
    const { coordinator, factory } = makeCoordinator({
      assignments: [
        assignment("a", "f", {
          watchEnabled: true,
          mode: "mount", // per-host override → effective mount
        }),
      ],
      folders: [folder("f", "sync")],
    });
    coordinator.reconcile();
    expect(factory.started).toEqual([]);
    coordinator.shutdown();
  });

  test("disabling an assignment stops its watcher on the next reconcile", () => {
    const assignments = [assignment("a", "f", { watchEnabled: true, enabled: true })];
    const folders = [folder("f", "sync")];
    const factory = new FakeFactory();
    const { coordinator } = makeCoordinator({ factory, assignments, folders });
    coordinator.reconcile();
    expect(factory.started).toEqual(["a"]);

    // Disable it.
    assignments[0] = { ...assignments[0], enabled: false };
    coordinator.reconcile();
    expect(factory.stopped).toEqual(["a"]);
    coordinator.shutdown();
    expect(factory.started.length).toBe(1);
  });

  test("a disabled assignment never starts a watcher", () => {
    const { coordinator, factory } = makeCoordinator({
      assignments: [assignment("a", "f", { watchEnabled: true, enabled: false })],
      folders: [folder("f", "sync")],
    });
    coordinator.reconcile();
    expect(factory.started).toEqual([]);
    coordinator.shutdown();
  });

  test("reconcile restarts a watcher when the watch config changes", () => {
    const assignments = [assignment("a", "f", { watchEnabled: true, watchQuietSec: 30 })];
    const folders = [folder("f", "sync")];
    const factory = new FakeFactory();
    const { coordinator } = makeCoordinator({ factory, assignments, folders });
    coordinator.reconcile();
    expect(factory.started).toEqual(["a"]);

    // Quiet period changed → recreate (a new start).
    assignments[0] = { ...assignments[0], watchQuietSec: 60 };
    coordinator.reconcile();
    expect(factory.started).toEqual(["a", "a"]);
    coordinator.shutdown();
  });

  test("folder/host removal (no longer in config) stops the watcher", () => {
    const assignments = [assignment("a", "f", { watchEnabled: true })];
    const folders = [folder("f", "sync")];
    const factory = new FakeFactory();
    const { coordinator } = makeCoordinator({ factory, assignments, folders });
    coordinator.reconcile();
    expect(factory.started).toEqual(["a"]);

    // Remove the assignment from the config entirely.
    assignments.splice(0, 1);
    coordinator.reconcile();
    // No active controllers remain; shutdown is a no-op.
    coordinator.shutdown();
    expect(factory.started.length).toBe(1);
  });

  test("missing path is skipped, then started once the path appears", () => {
    const assignments = [assignment("a", "f", {
      watchEnabled: true,
      localPath: join(realDir, "later"),
    })];
    const folders = [folder("f", "sync")];
    const factory = new FakeFactory();
    const { coordinator } = makeCoordinator({ factory, assignments, folders });
    coordinator.reconcile();
    expect(factory.started).toEqual([]);

    // Path appears → the next reconcile starts the watcher.
    assignments[0] = { ...assignments[0], localPath: realDir };
    coordinator.reconcile();
    expect(factory.started).toEqual(["a"]);
    coordinator.shutdown();
  });
});
