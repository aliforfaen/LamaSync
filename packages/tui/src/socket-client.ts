import { connect } from "node:net";
import { homedir } from "os";
import { join } from "path";

export interface SocketResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface SocketClient {
  cmd(req: Record<string, unknown>): Promise<SocketResponse>;
  close(): void;
}

const DEFAULT_SOCKET_PATH = join(
  homedir(),
  ".local",
  "share",
  "lamasync",
  "lamasync.sock",
);


/**
 * Opens a fresh Unix-socket connection per request and exchanges a single
 * line of JSON. Returns a handle that can be reused for subsequent calls.
 *
 * The daemon (or any counterpart) is expected to read one line, write a
 * single JSON response terminated by `\n`, and close the connection.
 */
export function connectSocket(path?: string): Promise<SocketClient> {
  const socketPath = path ?? (process.env.LAMASYNC_SOCKET_PATH ?? DEFAULT_SOCKET_PATH);
  const { promise, resolve, reject } = Promise.withResolvers<SocketClient>();
  let settled = false;
  const probe = connect(socketPath);
  probe.once("connect", () => {
    settled = true;
    probe.end();
    resolve(buildClient(socketPath));
  });
  probe.once("error", (err: NodeJS.ErrnoException) => {
    if (settled) return;
    settled = true;
    reject(err);
  });
  return promise;
}

function buildClient(socketPath: string): SocketClient {
  return {
    cmd(req) {
      return sendRequest(socketPath, req);
    },
    close() {
      // Stateless: no persistent connection to close.
    },
  };
}

function sendRequest(
  socketPath: string,
  req: Record<string, unknown>,
): Promise<SocketResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<SocketResponse>();
  const sock = connect(socketPath);
  let buf = "";
  let resolved = false;

  const finish = (value: SocketResponse): void => {
    if (resolved) return;
    resolved = true;
    sock.destroy();
    resolve(value);
  };

  const fail = (err: Error): void => {
    if (resolved) return;
    resolved = true;
    sock.destroy();
    reject(err);
  };

  sock.setEncoding("utf8");
  sock.once("connect", () => {
    sock.write(JSON.stringify(req) + "\n");
  });
  sock.on("data", (chunk: string) => {
    buf += chunk;
    const idx = buf.indexOf("\n");
    if (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      try {
        const parsed = JSON.parse(line) as SocketResponse;
        finish(parsed);
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });
  sock.once("error", fail);
  sock.once("close", () => {
    if (!resolved) {
      fail(new Error("socket closed before response"));
    }
  });
  sock.once("timeout", () => fail(new Error("socket timeout")));

  return promise;
}
