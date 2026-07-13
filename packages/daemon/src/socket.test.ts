// Unit tests for daemon socket dispatch.
//
// We exercise `dispatch` end-to-end against a mocked switch context so the
// real lock / mount / rclone helpers are never invoked. Each test installs a
// fresh context via `setSwitchContext` from `./index.ts` before dispatching.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dispatch } from "./socket.ts";
import {
  type SwitchContext,
  setSwitchContext,
} from "./index.ts";
import type { OperationLog, OperationStatus, Peer } from "@lamasync/core";

interface Captured {
  acquireLock: Array<{ folderId: string }>;
  releaseLock: Array<{ folderId: string; status: string; summary?: string }>;
  startMount: Array<Record<string, unknown>>;
  stopMount: Array<{ folderId: string }>;
  runOnce: Array<{ folderId: string }>;
  updateFolderType: Array<{ folderId: string; type: "sync" | "mount" }>;
}

function newCaptured(): Captured {
  return {
    acquireLock: [],
    releaseLock: [],
    startMount: [],
    stopMount: [],
    runOnce: [],
    updateFolderType: [],
  };
}

function makeCtx(
  captured: Captured,
  overrides: Partial<SwitchContext> = {},
): SwitchContext {
  return {
    acquireLock: async (folderId) => {
      captured.acquireLock.push({ folderId });
      return { lockId: "test-lock", folderId };
    },
    releaseLock: async (folderId, status, summary) => {
      captured.releaseLock.push({ folderId, status, summary });
    },
    getHostConfig: () => null,
    runOnce: async (assignment) => {
      captured.runOnce.push({ folderId: assignment.folderId });
    },
    startMount: async (opts) => {
      captured.startMount.push(opts);
    },
    stopMount: async (folderId) => {
      captured.stopMount.push({ folderId });
    },
    getRemoteName: (_remoteName, folderId) => `lamasync-${folderId}`,
    updateFolderType: async (folderId, type) => {
      captured.updateFolderType.push({ folderId, type });
    },
    ...overrides,
  };
}

function makeState(
  assignments: Array<{
    folderId: string;
    folderType: "sync" | "mount" | "backup" | "dotfile";
    lastStatus?: OperationStatus;
    lastSummary?: string;
  }> = [],
  operations: OperationLog[] = [],
): { assignments: unknown[]; operations: OperationLog[] } {
  return {
    assignments: assignments.map((a) => ({
      folderId: a.folderId,
      folderName: a.folderId,
      folderType: a.folderType,
      localPath: `/tmp/${a.folderId}`,
      lastRun:
        a.lastStatus !== undefined
          ? {
              timestamp: 0,
              status: a.lastStatus,
              summary: a.lastSummary ?? "",
            }
          : null,
    })),
    operations,
  };
}

let captured: Captured;
let prevCtx: SwitchContext | null;

beforeEach(() => {
  captured = newCaptured();
  prevCtx = null;
});

afterEach(() => {
  setSwitchContext(prevCtx);
});

describe("dispatch — sync helpers", () => {
  test("status returns counts from opts.getState()", async () => {
    const state = makeState(
      [
        { folderId: "f1", folderType: "sync" },
        { folderId: "f2", folderType: "mount" },
      ],
      [
        {
          id: 1,
          timestamp: 1,
          hostId: "h",
          folderId: "f1",
          operation: "sync",
          status: "success",
          summary: null,
          details: null,
          durationMs: 0,
        },
      ],
    );
    const opts = {
      socketPath: "/tmp/x",
      getState: () => ({
        localHostname: "host1",
        assignments: state.assignments as never,
        operations: state.operations,
      }),
    };
    // dispatch signature is internal; cast to any to satisfy TS in tests.
    const data = await (dispatch as unknown as (
      c: unknown,
      o: unknown,
    ) => Promise<unknown>)({ cmd: "status" }, opts);
    expect(data).toEqual({
      localHostname: "host1",
      assignmentCount: 2,
      operationCount: 1,
    });
  });

  test("sync fires onSyncRequest and returns started shape", async () => {
    let requested = "";
    const opts = {
      socketPath: "/tmp/x",
      getState: () => ({
        localHostname: "host1",
        assignments: [],
        operations: [],
      }),
      onSyncRequest: (folderId: string) => {
        requested = folderId;
      },
    };
    const data = await (dispatch as unknown as (
      c: unknown,
      o: unknown,
    ) => Promise<unknown>)({ cmd: "sync", folderId: "f1" }, opts);
    expect(requested).toBe("f1");
    expect(data).toEqual({ started: true, folderId: "f1" });
  });
});

describe("dispatch — switch-to-mount", () => {
  test("happy path: runs once, moves trash, mounts, releases lock, updates server", async () => {
    const folderId = "folder-mount-1";
    const ctx = makeCtx(captured, {
      getHostConfig: () => ({
        host: {
          id: "h",
          hostname: "h",
          tailnetIp: null,
          lastSeen: 0,
          status: "online",
        },
        assignments: [
          {
            id: "a1",
            folderId,
            hostId: "h",
            role: "both",
            localPath: "/tmp/lamasync-mnt",
            remoteName: null,
            syncExpr: null,
            enabled: true,
            conflictStrategy: null,
            preSyncCmd: null,
            postSyncCmd: null,
            ignorePath: null,
            mountIgnorePath: null,
            timeoutSec: null,
            bandwidthSchedule: null,
            maxRetries: null,
            availableSpaceThreshold: null,
            cacheProfile: "media",
            cacheMaxSize: "5G",
          },
        ],
        folders: [
          { id: folderId, name: "docs", type: "sync", createdAt: 0 },
        ],
        manifests: [],
        rcloneConfig: "[remote]\ntype = local\n",
        serverTailnetIp: null,
        peers: [],
      }),
    });
    setSwitchContext(ctx);

    const opts = {
      socketPath: "/tmp/x",
      getState: () => ({
        localHostname: "host1",
        assignments: [],
        operations: [],
      }),
    };
    const data = await (dispatch as unknown as (
      c: unknown,
      o: unknown,
    ) => Promise<unknown>)({ cmd: "switch-to-mount", folderId }, opts);

    expect(captured.acquireLock.map((e) => e.folderId)).toEqual([folderId]);
    expect(captured.runOnce.map((e) => e.folderId)).toEqual([folderId]);
    expect(captured.startMount).toHaveLength(1);
    expect(captured.startMount[0]?.folderId).toBe(folderId);
    expect(captured.startMount[0]?.cacheProfile).toBe("media");
    expect(captured.startMount[0]?.cacheMaxSize).toBe("5G");
    expect(captured.startMount[0]?.remotePath).toContain(folderId);
    expect(captured.updateFolderType).toEqual([
      { folderId, type: "mount" },
    ]);
    expect(captured.releaseLock.map((e) => e.status)).toContain("success");

    expect(data).toMatchObject({
      folderId,
      ok: true,
      trashDir: expect.stringContaining(folderId) as string,
    });
  });

  test("rejects when folder type is not sync", async () => {
    const folderId = "folder-mount-bad";
    const ctx = makeCtx(captured, {
      getHostConfig: () => ({
        host: {
          id: "h",
          hostname: "h",
          tailnetIp: null,
          lastSeen: 0,
          status: "online",
        },
        assignments: [
          {
            id: "a1",
            folderId,
            hostId: "h",
            role: "both",
            localPath: "/tmp/lamasync-mnt",
            remoteName: null,
            syncExpr: null,
            enabled: true,
            conflictStrategy: null,
            preSyncCmd: null,
            postSyncCmd: null,
            ignorePath: null,
            mountIgnorePath: null,
            timeoutSec: null,
            bandwidthSchedule: null,
            maxRetries: null,
            availableSpaceThreshold: null,
            cacheProfile: null,
            cacheMaxSize: null,
          },
        ],
        folders: [
          { id: folderId, name: "docs", type: "mount", createdAt: 0 },
        ],
        manifests: [],
        rcloneConfig: "",
        serverTailnetIp: null,
        peers: [],
      }),
    });
    setSwitchContext(ctx);
    const opts = {
      socketPath: "/tmp/x",
      getState: () => ({
        localHostname: "host1",
        assignments: [],
        operations: [],
      }),
    };
    const data = await (dispatch as unknown as (
      c: unknown,
      o: unknown,
    ) => Promise<unknown>)({ cmd: "switch-to-mount", folderId }, opts);
    expect(data).toMatchObject({
      folderId,
      ok: false,
      error: expect.stringMatching(/expected sync/) as RegExp,
    });
    expect(captured.startMount).toHaveLength(0);
    expect(captured.updateFolderType).toHaveLength(0);
  });

  test("mount failure restores trash and releases lock as failed", async () => {
    const folderId = "folder-mount-fail";
    const ctx = makeCtx(captured, {
      getHostConfig: () => ({
        host: {
          id: "h",
          hostname: "h",
          tailnetIp: null,
          lastSeen: 0,
          status: "online",
        },
        assignments: [
          {
            id: "a1",
            folderId,
            hostId: "h",
            role: "both",
            localPath: "/tmp/lamasync-mnt-fail",
            remoteName: null,
            syncExpr: null,
            enabled: true,
            conflictStrategy: null,
            preSyncCmd: null,
            postSyncCmd: null,
            ignorePath: null,
            mountIgnorePath: null,
            timeoutSec: null,
            bandwidthSchedule: null,
            maxRetries: null,
            availableSpaceThreshold: null,
            cacheProfile: null,
            cacheMaxSize: null,
          },
        ],
        folders: [
          { id: folderId, name: "docs", type: "sync", createdAt: 0 },
        ],
        manifests: [],
        rcloneConfig: "",
        serverTailnetIp: null,
        peers: [],
      }),
      startMount: async () => {
        captured.startMount.push({ folderId, threw: true });
        throw new Error("mount exploded");
      },
    });
    setSwitchContext(ctx);
    const opts = {
      socketPath: "/tmp/x",
      getState: () => ({
        localHostname: "host1",
        assignments: [],
        operations: [],
      }),
    };
    const data = await (dispatch as unknown as (
      c: unknown,
      o: unknown,
    ) => Promise<unknown>)({ cmd: "switch-to-mount", folderId }, opts);

    expect(captured.startMount).toHaveLength(1);
    expect(captured.releaseLock.map((e) => e.status)).toContain("failed");
    expect(captured.updateFolderType).toHaveLength(0);
    expect(data).toMatchObject({
      folderId,
      ok: false,
      error: expect.stringMatching(/mount failed/) as RegExp,
    });
  });
});

describe("dispatch — switch-to-sync", () => {
  test("happy path: stopMount, runOnce, update server to sync", async () => {
    const folderId = "folder-sync-1";
    const ctx = makeCtx(captured, {
      getHostConfig: () => ({
        host: {
          id: "h",
          hostname: "h",
          tailnetIp: null,
          lastSeen: 0,
          status: "online",
        },
        assignments: [
          {
            id: "a1",
            folderId,
            hostId: "h",
            role: "both",
            localPath: "/tmp/lamasync-sync",
            remoteName: null,
            syncExpr: null,
            enabled: true,
            conflictStrategy: null,
            preSyncCmd: null,
            postSyncCmd: null,
            ignorePath: null,
            mountIgnorePath: null,
            timeoutSec: null,
            bandwidthSchedule: null,
            maxRetries: null,
            availableSpaceThreshold: null,
            cacheProfile: null,
            cacheMaxSize: null,
          },
        ],
        folders: [
          { id: folderId, name: "docs", type: "mount", createdAt: 0 },
        ],
        manifests: [],
        rcloneConfig: "",
        serverTailnetIp: null,
        peers: [],
      }),
    });
    setSwitchContext(ctx);
    const opts = {
      socketPath: "/tmp/x",
      getState: () => ({
        localHostname: "host1",
        assignments: [],
        operations: [],
      }),
    };
    const data = await (dispatch as unknown as (
      c: unknown,
      o: unknown,
    ) => Promise<unknown>)({ cmd: "switch-to-sync", folderId }, opts);

    expect(captured.stopMount.map((e) => e.folderId)).toEqual([folderId]);
    expect(captured.runOnce.map((e) => e.folderId)).toEqual([folderId]);
    expect(captured.updateFolderType).toEqual([{ folderId, type: "sync" }]);
    expect(captured.releaseLock.map((e) => e.status)).toContain("success");
    expect(data).toMatchObject({ folderId, ok: true });
  });

  test("rejects when folder type is not mount", async () => {
    const folderId = "folder-sync-bad";
    const ctx = makeCtx(captured, {
      getHostConfig: () => ({
        host: {
          id: "h",
          hostname: "h",
          tailnetIp: null,
          lastSeen: 0,
          status: "online",
        },
        assignments: [
          {
            id: "a1",
            folderId,
            hostId: "h",
            role: "both",
            localPath: "/tmp/lamasync-sync-bad",
            remoteName: null,
            syncExpr: null,
            enabled: true,
            conflictStrategy: null,
            preSyncCmd: null,
            postSyncCmd: null,
            ignorePath: null,
            mountIgnorePath: null,
            timeoutSec: null,
            bandwidthSchedule: null,
            maxRetries: null,
            availableSpaceThreshold: null,
            cacheProfile: null,
            cacheMaxSize: null,
          },
        ],
        folders: [
          { id: folderId, name: "docs", type: "sync", createdAt: 0 },
        ],
        manifests: [],
        rcloneConfig: "",
        serverTailnetIp: null,
        peers: [],
      }),
    });
    setSwitchContext(ctx);
    const opts = {
      socketPath: "/tmp/x",
      getState: () => ({
        localHostname: "host1",
        assignments: [],
        operations: [],
      }),
    };
    const data = await (dispatch as unknown as (
      c: unknown,
      o: unknown,
    ) => Promise<unknown>)({ cmd: "switch-to-sync", folderId }, opts);
    expect(data).toMatchObject({
      folderId,
      ok: false,
      error: expect.stringMatching(/expected mount/) as RegExp,
    });
    expect(captured.stopMount).toHaveLength(0);
    expect(captured.updateFolderType).toHaveLength(0);
  });
});

describe("dispatch — unknown command", () => {
  test("rejects unknown commands", async () => {
    const opts = {
      socketPath: "/tmp/x",
      getState: () => ({
        localHostname: "host1",
        assignments: [],
        operations: [],
      }),
    };
    await expect(
      (dispatch as unknown as (
        c: unknown,
        o: unknown,
      ) => Promise<unknown>)({ cmd: "bogus" }, opts),
    ).rejects.toThrow(/unknown command/);
  });
});