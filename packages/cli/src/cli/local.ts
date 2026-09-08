/**
 * `lamasync local <subcommand>` — talk to the local daemon over its
 * Unix socket via the line-JSON protocol defined in `packages/daemon/src/socket.ts`.
 *
 * Mapping:
 *   lamasync local status       → {"cmd":"status"}
 *   lamasync local folders      → {"cmd":"list-folders"}
 *   lamasync local ops          → {"cmd":"list-ops"}
 *   lamasync local sync [id]    → {"cmd":"sync","folderId":"..."}
 *   lamasync local sync-all     → {"cmd":"sync-all"}
 *   lamasync local mount <id>   → {"cmd":"switch-to-mount","folderId":"..."}
 *   lamasync local unmount <id> → {"cmd":"switch-to-sync","folderId":"..."}
 *
 * The CLI is the documented escape hatch for agents — never expose the
 * raw `socat`/`netcat` invocation path. Socket failures (ENOENT, EAGAIN,
 * ECONNRESET) surface as exit code 1 with a stable message; transport
 * errors are not retried.
 *
 * Reuses `connectSocket()` from `socket-client.ts` so we never duplicate
 * the framing or get out of sync with the daemon.
 */

import { connectSocket } from "../socket-client.ts";
import { CliUsageError } from "./args.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";

interface SocketOk<T = unknown> {
  ok: true;
  data: T;
}
interface SocketErr {
  ok: false;
  error?: string;
}
type SocketResult<T = unknown> = SocketOk<T> | SocketErr;

async function call<T>(req: Record<string, unknown>): Promise<T> {
  let client;
  try {
    client = await connectSocket();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`local daemon socket not reachable: ${message}`);
  }
  try {
    const res = (await client.cmd(req)) as SocketResult<T>;
    if (!res.ok) {
      throw new Error(res.error ?? "daemon command failed");
    }
    return res.data;
  } finally {
    client.close();
  }
}

export async function runStatus(ctx: CliContext): Promise<void> {
  const data = await call<{
    localHostname: string;
    assignmentCount: number;
    operationCount: number;
  }>({ cmd: "status" });
  if (ctx.json) {
    printJson(data);
    return;
  }
  console.log(`local daemon: ${data.localHostname}`);
  console.log(`  assignments: ${data.assignmentCount}`);
  console.log(`  operations:  ${data.operationCount}`);
}

interface SocketAssignment {
  folderId: string;
  folderName: string;
  folderType: string;
  localPath: string;
  lastRun: { timestamp: number; status: string; summary: string } | null;
}

export async function runFolders(ctx: CliContext): Promise<void> {
  const data = await call<SocketAssignment[]>({ cmd: "list-folders" });
  if (ctx.json) {
    printJson(data);
    return;
  }
  printTable(
    [
      { header: "FOLDER", key: "folderName" },
      { header: "TYPE", key: "folderType" },
      { header: "PATH", key: "localPath" },
      { header: "LAST", key: "lastRunLabel" },
    ],
    data.map((a) => ({
      folderName: a.folderName,
      folderType: a.folderType,
      localPath: a.localPath,
      lastRunLabel: a.lastRun ? `${a.lastRun.status}` : "—",
    })),
  );
}

interface SocketOp {
  id: number;
  timestamp: number;
  hostId: string;
  folderId?: string | null;
  operation: string;
  status: string;
  summary?: string | null;
}

export async function runOps(ctx: CliContext): Promise<void> {
  const data = await call<SocketOp[]>({ cmd: "list-ops" });
  if (ctx.json) {
    printJson(data);
    return;
  }
  printTable(
    [
      { header: "WHEN", key: "whenLabel" },
      { header: "FOLDER", key: "folderLabel" },
      { header: "OP", key: "operation" },
      { header: "STATUS", key: "status" },
      { header: "SUMMARY", key: "summary" },
    ],
    data.map((o) => ({
      whenLabel: new Date(o.timestamp).toISOString(),
      folderLabel: o.folderId ?? "—",
      operation: o.operation,
      status: o.status,
      summary: o.summary ?? "",
    })),
  );
}

export async function runSync(ctx: CliContext): Promise<void> {
  const id = ctx.parsed.rest[0];
  if (!id) {
    throw new CliUsageError("local sync <folderId> requires an id");
  }
  const data = await call<{ started: boolean; folderId: string }>({
    cmd: "sync",
    folderId: id,
  });
  if (ctx.json) {
    printJson(data);
    return;
  }
  console.log(`triggered sync for folder ${id}`);
}

export async function runSyncAll(ctx: CliContext): Promise<void> {
  const data = await call<{ started: boolean; all: true }>({ cmd: "sync-all" });
  if (ctx.json) {
    printJson(data);
    return;
  }
  console.log("triggered sync for all folders");
}

export async function runMount(ctx: CliContext): Promise<void> {
  const id = ctx.parsed.rest[0];
  if (!id) {
    throw new CliUsageError("local mount <folderId> requires an id");
  }
  const data = await call<{ folderId: string; ok: boolean }>({
    cmd: "switch-to-mount",
    folderId: id,
  });
  if (ctx.json) {
    printJson(data);
    return;
  }
  console.log(`switched folder ${id} to mount mode`);
}

export async function runUnmount(ctx: CliContext): Promise<void> {
  const id = ctx.parsed.rest[0];
  if (!id) {
    throw new CliUsageError("local unmount <folderId> requires an id");
  }
  const data = await call<{ folderId: string; ok: boolean }>({
    cmd: "switch-to-sync",
    folderId: id,
  });
  if (ctx.json) {
    printJson(data);
    return;
  }
  console.log(`switched folder ${id} to sync mode`);
}
