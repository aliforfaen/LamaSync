// Systemd user-unit management for the lamasyncd daemon and per-mount units.
//
// All public functions are synchronous and best-effort: the daemon calls into
// this module from startup, boot-adoption, and `--mount` foreground paths, and
// any failure must not prevent the daemon from serving commands. `systemctl`
// itself is the source of truth for whether a unit is active, so `start`/`stop`
// intentionally rely on the spawn exit code rather than parsing stderr.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_INSTALL_DIR = "%h/.local/bin/lamasyncd";
const DEFAULT_SOCKET_PATH = "%h/lamasync.sock";
const MOUNT_WAIT_TIMEOUT_MS = 30_000;
const MOUNT_POLL_INTERVAL_MS = 500;

/**
 * True iff `systemctl` resolves on PATH. Lets callers branch on availability
 * without shelling out repeatedly.
 */
export function isSystemdAvailable(): boolean {
  return !!Bun.which("systemctl");
}

/**
 * Directory holding the user's systemd units. Exposed so callers (and tests)
 * can override the location.
 */
export function getUserUnitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

export function mountUnitName(folderId: string): string {
  return `lamasync-mount-${folderId}.service`;
}

export function mountUnitPath(folderId: string): string {
  return join(getUserUnitDir(), mountUnitName(folderId));
}

/**
 * Build the content of a per-mount unit. Exposed for tests so they can assert
 * formatting without touching the filesystem.
 */
export function buildMountUnitContent(
  folderId: string,
  opts: { installDir?: string; socketPath?: string } = {},
): string {
  const installDir = opts.installDir ?? DEFAULT_INSTALL_DIR;
  const socketPath = opts.socketPath ?? DEFAULT_SOCKET_PATH;
  return [
    "[Unit]",
    `Description=LamaSync mount ${folderId}`,
    "Requires=lamasyncd.service",
    "After=lamasyncd.service network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${installDir} --mount ${folderId}`,
    "Restart=on-failure",
    "RestartSec=10s",
    `Environment=LAMASYNC_SOCKET_PATH=${socketPath}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * Write a per-mount unit for `folderId` into a specific directory. Split out
 * from `writeMountUnit` so tests can target a tmp dir.
 */
export function writeMountUnitTo(
  folderId: string,
  unitDir: string,
  opts: { installDir?: string; socketPath?: string } = {},
): string {
  mkdirSync(unitDir, { recursive: true });
  const content = buildMountUnitContent(folderId, opts);
  const path = join(unitDir, mountUnitName(folderId));
  writeFileSync(path, content, { mode: 0o644 });
  return path;
}

/**
 * Write the mount unit for `folderId` to the user's systemd unit directory.
 * Returns the absolute path written.
 */
export function writeMountUnit(
  folderId: string,
  opts: { installDir?: string; socketPath?: string } = {},
): string {
  return writeMountUnitTo(folderId, getUserUnitDir(), opts);
}

export function removeMountUnit(folderId: string): void {
  try {
    unlinkSync(mountUnitPath(folderId));
  } catch {
    // best-effort; the unit file may not exist yet
  }
}

function runSystemctl(args: string[]): { status: number; stderr: string } {
  const res = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
  });
  return {
    status: res.status ?? -1,
    stderr: res.stderr ?? "",
  };
}

export function enableMountUnit(folderId: string): void {
  const { status, stderr } = runSystemctl([
    "enable",
    mountUnitName(folderId),
  ]);
  if (status !== 0) {
    console.warn(
      `[systemd] enable ${mountUnitName(folderId)} failed (${status}): ${stderr.trim()}`,
    );
  }
}

export function disableMountUnit(folderId: string): void {
  runSystemctl([
    "disable",
    "--now",
    mountUnitName(folderId),
  ]);
}

export function startMountUnit(folderId: string): void {
  runSystemctl(["start", mountUnitName(folderId)]);
}

export function stopMountUnit(folderId: string): void {
  runSystemctl(["stop", mountUnitName(folderId)]);
}

export function isMountUnitActive(folderId: string): boolean {
  const { status } = runSystemctl(["is-active", mountUnitName(folderId)]);
  return status === 0;
}

/**
 * Wait up to 30s for the mount unit to become active. Used after `start` so
 * the caller can register the rclone child with the daemon's mounts map only
 * once the mount path is actually populated.
 */
export async function waitForMountUnitActive(folderId: string): Promise<boolean> {
  const deadline = Date.now() + MOUNT_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isMountUnitActive(folderId)) return true;
    await new Promise<void>((r) => setTimeout(r, MOUNT_POLL_INTERVAL_MS));
  }
  return isMountUnitActive(folderId);
}

/**
 * Build the daemon service unit content. Mirrors the package template but
 * interpolates caller-provided paths so generated units can target
 * non-default install locations.
 */
export function daemonServiceTemplate(opts: {
  binaryPath?: string;
  socketPath?: string;
} = {}): string {
  const binaryPath = opts.binaryPath ?? DEFAULT_INSTALL_DIR;
  const socketPath = opts.socketPath ?? DEFAULT_SOCKET_PATH;
  return [
    "[Unit]",
    "Description=LamaSync Daemon",
    "Documentation=https://github.com/aliforfaen/LamaSync",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `# %h expands to $HOME for the user running the service`,
    `ExecStart=${binaryPath}`,
    "Restart=on-failure",
    "RestartSec=10s",
    "# Logs to journald",
    "StandardOutput=journal",
    "StandardError=journal",
    "SyslogIdentifier=lamasyncd",
    "# Hardening (relaxed for development; tighten in production)",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=full",
    "ProtectHome=read-only",
    "# Allow the daemon to write its socket, cache, share data, and project mounts in $HOME.",
    `ReadWritePaths=%h/.config/lamasync %h/.local/share/lamasync %h/.cache/lamasync %h/lamasync.sock %h/projects`,
    "# Standardize socket path so the daemon, TUI, and per-mount units agree.",
    `Environment=LAMASYNC_SOCKET_PATH=${socketPath}`,
    "# Resource limits",
    "MemoryMax=512M",
    "CPUQuota=50%",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function readDaemonService(): string | null {
  const path = join(getUserUnitDir(), "lamasyncd.service");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export function installDaemonService(opts: {
  binaryPath?: string;
  socketPath?: string;
} = {}): void {
  const dir = getUserUnitDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "lamasyncd.service"),
    daemonServiceTemplate(opts),
    { mode: 0o644 },
  );
  runSystemctl(["daemon-reload"]);
  runSystemctl(["enable", "--now", "lamasyncd.service"]);
}
