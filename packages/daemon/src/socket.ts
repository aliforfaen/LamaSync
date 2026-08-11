// Daemon-side Unix socket used by the TUI's "Local view" and any other
// in-process control clients.
//
// Protocol: line-JSON. Each connection sends one line of JSON
// (`{"cmd": "..."}`) and receives one line of JSON (`{"ok": true, "data": ...}`
// or `{"ok": false, "error": "..."}`) before the server closes the connection.
//
// Implemented on `node:net.Server` so the framing matches the TUI's
// `node:net` client and the protocol is genuinely raw (no HTTP, no WebSocket).

import { existsSync, mkdirSync, unlinkSync } from "fs";
import { dirname } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import type {
  FolderType,
  HostConfig,
  OperationLog,
  OperationStatus,
} from "@lamasync/core";
import { switchToMount, switchToSync } from "./index.ts";

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
  /** @returns true when the folder was found and the sync was queued; false
   *  when the folder isn't assigned to this host (LAMA-241). */
  onSyncRequest?: (folderId: string) => boolean | Promise<boolean>;
  onSyncAllRequest?: () => void | Promise<void>;
}

type Command =
  | { cmd: "status" }
  | { cmd: "list-folders" }
  | { cmd: "list-ops" }
  // LAMA-241: `folder` is accepted as an alias for `folderId` — the manual
  // socket protocol used `{"cmd":"sync","folder":"..."}` and the daemon
  // silently ignored it (returning started:true for an unknown folder).
  | { cmd: "sync"; folderId?: string; folder?: string }
  | { cmd: "sync-all" }
  | { cmd: "switch-to-mount"; folderId: string }
  | { cmd: "switch-to-sync"; folderId: string };

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
    void (async () => {
      try {
        const data = await dispatch(cmd, opts);
        reply({ ok: true, data });
      } catch (err) {
        reply({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      finish();
    })();
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
  // LAMA-218: ensure the parent dir exists before bind(). The default
  // location under XDG_RUNTIME_DIR is always present on Linux, but the
  // ~/.lamasync fallback is NOT created by systemd or any installer —
  // a daemon that just calls server.listen() there fails with ENOENT.
  const socketDir = dirname(opts.socketPath);
  if (socketDir !== "" && socketDir !== ".") {
    mkdirSync(socketDir, { recursive: true });
  }
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
  // Register the error listener BEFORE calling listen(): on AF_UNIX the
  // bind can fail synchronously (e.g. under systemd hardening where
  // ProtectHome/PrivateTmp/etc. overlay the socket path), and an error
  // emitted before this listener is attached becomes an unhandled 'error'
  // event that crashes the process with exit code 0.
  server.on("error", (err) => {
    const e = err as NodeJS.ErrnoException;
    console.error(
      `[socket] listener error: code=${e?.code ?? "(none)"} errno=${e?.errno ?? "(none)"} syscall=${e?.syscall ?? "(none)"} path=${e?.path ?? opts.socketPath} message=${err instanceof Error ? err.message : String(err)}`,
    );
  });
  server.listen(opts.socketPath);

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

export async function dispatch(cmd: Command, opts: StartSocketOptions): Promise<unknown> {
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
      // LAMA-241: accept the `folder` alias, require an identifier, and
      // surface an error instead of silently returning started:true.
      const folderId = cmd.folderId ?? cmd.folder;
      if (!folderId) {
        throw new Error("sync requires folderId (or folder)");
      }
      if (opts.onSyncRequest) {
        const found = await opts.onSyncRequest(folderId);
        if (!found) {
          throw new Error(`folder not found: ${folderId}`);
        }
      }
      return { started: true, folderId };
    }
    case "sync-all": {
      if (opts.onSyncAllRequest) opts.onSyncAllRequest();
      return { started: true, all: true };
    }
    case "switch-to-mount": {
      const result = await switchToMount(cmd.folderId);
      return { folderId: cmd.folderId, ...result };
    }
    case "switch-to-sync": {
      const result = await switchToSync(cmd.folderId);
      return { folderId: cmd.folderId, ...result };
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
