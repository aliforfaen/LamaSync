// LAN peer sync helpers. The server-detected peers live on `hostConfig.peers`;
// for each shared folder id we either serve the local tree to the peer
// (`rclone serve sftp`) or use the peer's local tree as the sync target
// (swap the rclone remote to `lamasync-peer-<peerId>`).
//
// The serve side owns a long-running child process that must be killed when
// the operation completes. The use side may fall back to the standard remote
// when the peer is unreachable (5s nc probe).

import { homedir } from "os";
import { join } from "path";
import type { FolderAssignment, HostConfig, Peer } from "@lamasync/core";

const PEER_SFTP_PORT = 2022;

// SFTP port used for every peer session on a single host; the SFTP user's
// password differentiates clients.
export const LAN_PEER_PORT = PEER_SFTP_PORT;

export interface LanPeerSession {
  // When this host is the "use" side and the peer is reachable, this is the
  // substituted remote name (e.g. `lamasync-peer-<peerId>`). Callers replace
  // the standard remote in their rclone command with this.
  useRemote: string | null;
  // When this host is the "serve" side, a handle whose `close()` kills the
  // background `rclone serve sftp` process. The caller MUST close it.
  serveHandle: ServeHandle | null;
  // Human-readable summary of what was decided, for the operation report.
  detail: string;
}

export interface ServeHandle {
  close(): Promise<void>;
  pid: number;
}

// `pickPeerRole` mirrors the server's helper so the executor can decide which
// side it's on without consulting the server. The two must agree: the smaller
// id serves. Re-exported here to keep the daemon self-contained.
export function pickPeerRole(
  currentHostId: string,
  peerHostId: string,
): "serve" | "use" {
  return currentHostId < peerHostId ? "serve" : "use";
}

// Find the peer (if any) that lists `folderId` among its shared folders.
export function findPeerForFolder(
  hostConfig: HostConfig,
  folderId: string,
): Peer | null {
  for (const p of hostConfig.peers) {
    if (p.folderIds.includes(folderId)) return p;
  }
  return null;
}

// Lightweight TCP probe: connect to <ip>:<port> with a 5s timeout. Returns
// true when the port accepts a connection. Used to detect whether the peer
// has its `rclone serve sftp` listener up before swapping the rclone target.
async function probePeerTcp(ip: string, port: number): Promise<boolean> {
  if (!ip) return false;
  const proc = Bun.spawn(["nc", "-z", "-w", "5", ip, String(port)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return code === 0;
}

// "Use" the peer: swap the rclone target from the standard remote to the
// peer's SFTP section, when the peer is reachable. Returns the substituted
// remote name (e.g. `lamasync-peer-<peerId>`) on success, or null when the
// peer is not reachable (caller falls back to the standard remote).
async function usePeer(peer: Peer): Promise<{ remote: string | null; detail: string }> {
  const reachable = await probePeerTcp(peer.peerLanIp, PEER_SFTP_PORT).catch(
    () => false,
  );
  if (!reachable) {
    return {
      remote: null,
      detail: `peer ${peer.peerHostId} (${peer.peerLanIp}) unreachable; using server relay`,
    };
  }
  return {
    remote: peer.peerRemote,
    detail: `LAN peer ${peer.peerHostId} (${peer.peerLanIp}:${PEER_SFTP_PORT}) used as sync target`,
  };
}

// "Serve" the peer: spawn `rclone serve sftp` exposing the local tree, then
// run the rclone command against the standard remote (which the peer's
// rclone config points at the current host's LAN IP). The returned handle
// must be `close()`d to terminate the listener.
async function servePeer(opts: {
  peer: Peer;
  folderName: string;
  apiKey: string;
  configPath: string;
  localPath: string;
}): Promise<ServeHandle> {
  // Expose the local tree as a SFTP endpoint for the peer. The same
  // rclone config file is used so the served remote resolves correctly.
  const proc = Bun.spawn(
    [
      "rclone",
      "serve",
      "sftp",
      opts.localPath,
      "--addr",
      `:${PEER_SFTP_PORT}`,
      "--user",
      "lamasync",
      "--pass",
      opts.apiKey,
      "--config",
      opts.configPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  // Give the listener a moment to bind the port. The peer's nc probe has
  // 5s of headroom.
  await Bun.sleep(500);
  return {
    pid: proc.pid,
    close: async () => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
      try {
        await proc.exited;
      } catch {
        // best-effort
      }
    },
  };
}

// Wire the LAN peer logic for a single (assignment, folder) execution. Pure
// orchestration: returns a session the caller uses to swap the rclone target
// and to clean up the serve process afterwards.
export async function startLanPeerSession(opts: {
  hostId: string;
  hostConfig: HostConfig;
  assignment: FolderAssignment;
  folderId: string;
  folderName: string;
  apiKey: string;
  configPath: string;
  localPath: string;
}): Promise<LanPeerSession> {
  const peer = findPeerForFolder(opts.hostConfig, opts.folderId);
  if (!peer) {
    return { useRemote: null, serveHandle: null, detail: "no LAN peer" };
  }
  const role = pickPeerRole(opts.hostId, peer.peerHostId);
  if (role === "serve") {
    const serveHandle = await servePeer({
      peer,
      folderName: opts.folderName,
      apiKey: opts.apiKey,
      configPath: opts.configPath,
      localPath: opts.localPath,
    });
    return {
      useRemote: null,
      serveHandle,
      detail: `serving LAN peer ${peer.peerHostId} (${peer.peerLanIp}) on :${PEER_SFTP_PORT}`,
    };
  }
  const { remote, detail } = await usePeer(peer);
  return { useRemote: remote, serveHandle: null, detail };
}

// Where the daemon caches peer-specific rclone state files (currently unused
// but reserved for future state files). Exported so callers and tests can
// point at the same canonical location.
export function peerStateDir(): string {
  return join(homedir(), ".local", "share", "lamasync", "peers");
}
