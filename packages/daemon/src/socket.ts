// Daemon-side Unix socket used by the TUI's "Local view" and any other
// in-process control clients.
//
// Protocol: line-JSON. Each connection sends one line of JSON
// (`{"cmd": "..."}`) and receives one line of JSON (`{"ok": true, "data": ...}`
// or `{"ok": false, "error": "..."}`) before the server closes the connection.
//
// Implemented on `node:net.Server` so the framing matches the TUI's
// `node:net` client and the protocol is genuinely raw (no HTTP, no WebSocket).

import { existsSync, unlinkSync } from "fs";
import { createServer, type Server, type Socket } from "node:net";
import type {
  FolderType,
  HostConfig,
  OperationLog,
  OperationStatus,
} from "@lamasync/core";

export interface SocketAssignment {
  folderId: string;
  folderName: string;
  folderType: FolderType;
  localPath: string;
  lastRun: { timestamp: number; status: OperationStatus; summary: string } | null;
}

export interface SocketState {
  localHostname: string;
  assignments: SocketAssignment[];
  operations: OperationLog[];
}

export interface StartSocketOptions {
  socketPath: string;
  getState: () => SocketState;
  onSyncRequest?: (folderId: string) => void;
}

type Command =
  | { cmd: "status" }
  | { cmd: "list-folders" }
  | { cmd: "list-ops" }
  | { cmd: "sync"; folderId: string };

const BUFFER_LIMIT = 64 * 1024;

function handleConnection(socket: Socket, opts: StartSocketOptions): void {
  let buf = Buffer.alloc(0);
  let closed = false;

  const finish = (): void => {
    if (closed) return;
    closed = true;
    try {
      socket.end();
    } catch {
      // ignore
    }
  };

  const reply = (payload: unknown): void => {
    try {
      socket.write(JSON.stringify(payload) + "\n");
    } catch {
      // ignore
    }
  };

  socket.on("data", (chunk: string | Buffer) => {
    if (closed) return;
    const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buf.length + incoming.length > BUFFER_LIMIT) {
      reply({ ok: false, error: "buffer overflow" });
      finish();
      return;
    }
    buf = Buffer.concat([buf, incoming]);
    const nl = buf.indexOf(0x0a);
    if (nl === -1) return;
    const line = buf.subarray(0, nl).toString("utf8").trim();
    if (line.length === 0) {
      reply({ ok: false, error: "empty request" });
      finish();
      return;
    }
    let cmd: Command;
    try {
      cmd = JSON.parse(line) as Command;
    } catch (err) {
      reply({
        ok: false,
        error: `invalid json: ${err instanceof Error ? err.message : String(err)}`,
      });
      finish();
      return;
    }
    try {
      const data = dispatch(cmd, opts);
      reply({ ok: true, data });
    } catch (err) {
      reply({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    finish();
  });

  socket.on("error", () => {
    // Peer hung up; nothing to do.
  });
  socket.on("close", () => {
    closed = true;
  });
}

/**
 * Start a line-based JSON control socket on a Unix domain path.
 */
export function startSocketServer(
  opts: StartSocketOptions,
): { close: () => void } {
  if (existsSync(opts.socketPath)) {
    try {
      unlinkSync(opts.socketPath);
    } catch (err) {
      console.warn(
        `[socket] failed to unlink stale socket ${opts.socketPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const server: Server = createServer((socket) => handleConnection(socket, opts));
  server.listen(opts.socketPath);
  server.on("error", (err) => {
    console.error(
      `[socket] listener error: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  const close = (): void => {
    try {
      server.close();
    } catch {
      // ignore
    }
    if (existsSync(opts.socketPath)) {
      try {
        unlinkSync(opts.socketPath);
      } catch {
        // ignore
      }
    }
  };

  return { close };
}

function dispatch(cmd: Command, opts: StartSocketOptions): unknown {
  const state = opts.getState();
  switch (cmd.cmd) {
    case "status":
      return {
        localHostname: state.localHostname,
        assignmentCount: state.assignments.length,
        operationCount: state.operations.length,
      };
    case "list-folders":
      return state.assignments;
    case "list-ops":
      return state.operations;
    case "sync": {
      if (opts.onSyncRequest) opts.onSyncRequest(cmd.folderId);
      return { started: true, folderId: cmd.folderId };
    }
    default: {
      // Exhaustiveness check: TypeScript narrows `cmd` to `never` here.
      const _exhaustive: never = cmd;
      throw new Error(`unknown command: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Build a SocketState snapshot from the host config and last operation log.
 */
export function buildSocketState(
  localHostname: string,
  hostConfig: HostConfig | null,
  operations: OperationLog[],
): SocketState {
  const assignments: SocketAssignment[] = [];
  if (hostConfig) {
    for (const a of hostConfig.assignments) {
      const folder = hostConfig.folders.find((f) => f.id === a.folderId);
      const folderName = folder?.name ?? a.folderId;
      const folderType = (folder?.type ?? "sync") as FolderType;
      const opForFolder = operations.find(
        (o) => o.folderId === a.id && o.status !== "started",
      );
      const lastRun = opForFolder
        ? {
            timestamp: opForFolder.timestamp,
            status: opForFolder.status,
            summary: opForFolder.summary ?? "",
          }
        : null;
      assignments.push({
        folderId: a.id,
        folderName,
        folderType,
        localPath: a.localPath,
        lastRun,
      });
    }
  }
  return { localHostname, assignments, operations };
}

export type { FolderType, OperationLog, OperationStatus };
