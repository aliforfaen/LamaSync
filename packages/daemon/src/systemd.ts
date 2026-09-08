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
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const DEFAULT_INSTALL_DIR = "%h/.local/bin/lamasyncd";
// Default lives under XDG_RUNTIME_DIR (writable under systemd user
// services without needing a ReadWritePaths exception). When unset,
// systemd --user sets XDG_RUNTIME_DIR to /run/user/<uid>, which is
// already on the writable set for the user service. When the daemon
// runs outside systemd (interactive shell), $XDG_RUNTIME_DIR is also
// set on every modern Linux desktop.
const DEFAULT_SOCKET_PATH = "${XDG_RUNTIME_DIR}/lamasync.sock";
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
 * Directory holding the persistent user systemd units — currently only the
 * daemon's own `lamasyncd.service`. Per-mount units are transient and live
 * under `getRuntimeUnitDir()` instead, so they never linger after logout or
 * a reboot. Exposed so callers (and tests) can override the location.
 */
export function getUserUnitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

/**
 * Directory for transient per-mount systemd user units: the runtime unit dir
 * under `$XDG_RUNTIME_DIR` (`/run/user/<uid>/systemd/user`). Units written
 * here are ephemeral — systemd clears the runtime dir on logout and reboot —
 * so boot persistence comes from the daemon re-creating them from the host
 * config (see the reconcile-on-refresh path in index.ts), not from unit
 * files surviving. Falls back to `/run/user/<uid>/systemd/user` when
 * `XDG_RUNTIME_DIR` is unset, mirroring systemd's own convention.
 */
export function getRuntimeUnitDir(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir !== undefined && runtimeDir !== "") {
    return join(runtimeDir, "systemd", "user");
  }
  const uid = process.getuid?.() ?? userInfo().uid;
  return join("/run/user", String(uid), "systemd", "user");
}

export function mountUnitName(folderId: string): string {
  return `lamasync-mount-${folderId}.service`;
}

/**
 * Path of the per-mount unit for `folderId` inside the runtime unit dir.
 */
export function mountUnitPath(folderId: string): string {
  return join(getRuntimeUnitDir(), mountUnitName(folderId));
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
    "Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin",
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
 * Write the mount unit for `folderId` into the runtime unit directory
 * (`getRuntimeUnitDir()`), creating it first if needed. Returns the absolute
 * path written.
 */
export function writeMountUnit(
  folderId: string,
  opts: { installDir?: string; socketPath?: string } = {},
): string {
  return writeMountUnitTo(folderId, getRuntimeUnitDir(), opts);
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

/**
 * Best-effort teardown: `disable --now` removes any enablement symlink and
 * stops the unit. For an ephemeral runtime unit that was never enabled (or
 * whose file is already gone) systemctl simply has nothing to disable and the
 * command stays silent with a non-fatal status — acceptable here, and the
 * index.ts caller stops the mount afterwards regardless.
 */
export function disableMountUnit(folderId: string): void {
  runSystemctl([
    "disable",
    "--now",
    mountUnitName(folderId),
  ]);
}

export function startMountUnit(folderId: string): void {
  for (const args of [["daemon-reload"], ["start", mountUnitName(folderId)]]) {
    const { status, stderr } = runSystemctl(args);
    if (status !== 0) {
      throw new Error(`systemctl ${args.join(" ")} failed (${status}): ${stderr.trim()}`);
    }
  }
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
    "# Bound the restart loop so a hard crash (e.g. corrupt config) can't run",
    "# forever: up to 8 restarts in 5 min, then the unit gives up until the",
    "# operator intervenes (LAMA-243).",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=8",
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
    "# systemd user services start with a minimal PATH (/usr/local/bin:/usr/bin)",
    "# even when the user manager has a richer one. Set PATH explicitly so",
    "# user-installed binaries (rclone at ~/.local/bin, bun at ~/.bun/bin,",
    "# etc.) are visible to the daemon. Bun.which() in the executor relies",
    "# on PATH for rclone, tar, restic, etc. `%h` expands to $HOME — works",
    "# for /root and every non-/home home; the previous `/home/%u/...` only",
    "# matched home dirs under /home.",
    "Environment=PATH=%h/.local/bin:%h/.bun/bin:%h/.cargo/bin:/usr/local/bin:/usr/bin",
    "# Hardening (relaxed for development; tighten in production)",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=full",
    "ProtectHome=read-only",
    "# Allow the daemon to write its cache, share data, project mounts in $HOME,",
    "# and its Unix socket under $XDG_RUNTIME_DIR (/run/user/<uid>).",
    "# IMPORTANT: ProtectHome=read-only also marks /run/user as read-only, so",
    "# /run/user must be explicitly whitelisted or the socket bind fails with",
    "# EROFS (errno 30, syscall=listen). The %U specifier expands to the",
    "# invoking UID, matching where systemd places $XDG_RUNTIME_DIR.",
    `ReadWritePaths=%h/.config/lamasync %h/.local/share/lamasync %h/.cache/lamasync %h/projects /run/user/%U`,
    "# Standardize socket path so the daemon, local CLI, and per-mount units agree.",
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

/**
 * Restart the known `lamasyncd.service` user unit. The unit name is a
 * fixed literal — never interpolated from user input — so this is safe to
 * call from the LAMA-299 remote-update path. Best-effort: returns the
 * outcome so callers can surface a precise manual fallback.
 */
export function restartDaemonService(): { ok: boolean; reason?: string } {
  if (!isSystemdAvailable()) {
    return {
      ok: false,
      reason: "systemctl not available",
    };
  }
  const { status, stderr } = runSystemctl(["restart", "lamasyncd.service"]);
  if (status !== 0) {
    return {
      ok: false,
      reason: `systemctl exit ${status}${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ""}`,
    };
  }
  return { ok: true };
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
