// Systemd user-unit management for the lamasyncd daemon and per-mount units.
//
// All public functions are synchronous and best-effort: the daemon calls into
// this module from startup, boot-adoption, and `--mount` foreground paths, and
// any failure must not prevent the daemon from serving commands. `systemctl`
// itself is the source of truth for whether a unit is active, so `start`/`stop`
// intentionally rely on the spawn exit code rather than parsing stderr.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { homedir, userInfo } from "node:os";
import { writeFileAtomic } from "./atomic-file.ts";

const DEFAULT_INSTALL_DIR = "%h/.local/bin/lamasyncd";
// Default lives under XDG_RUNTIME_DIR. When unset, systemd --user sets
// XDG_RUNTIME_DIR to /run/user/<uid>; when the daemon runs outside systemd,
// the environment is used as-is by the caller.
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
    "# The daemon is authorized to write operator-selected local paths from",
    "# its assignments, including arbitrary paths below $HOME.",
    "# A home read-only sandbox paired with a static writable-path list cannot",
    "# express that contract: systemd applies the sandbox before assignments",
    "# are fetched, and a running daemon cannot safely rewrite its own unit.",
    "# Keep the system-wide protection above; the daemon's configured paths",
    "# are the deliberate trust boundary.",
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

// ---------------------------------------------------------------------------
// LAMA-311: reconcile an already-installed systemd user unit.
//
// The daemon's unit is rewritten only by `packaging/install/install.sh`, and
// neither `lamasyncd --update` nor the remote `update_daemon` action touches
// it. A unit-content fix therefore never reaches a client that updates its
// binary (dev-vm, 2026-09-17: binary v0.3.11 post-fix, unit from Aug 6 still
// carrying `ProtectHome=read-only` and a static `ReadWritePaths` allowlist).
//
// The migration below is deliberately narrow and line-surgical: it removes
// only the two obsolete sandbox directives and preserves every other byte of
// the file, so an operator's custom unit — extra directives, comments, a
// custom `ExecStartPre`, a non-default binary or socket path — is never
// rewritten. Anything that is not recognisably a LamaSync daemon unit, that is
// a symlink, or that carries drop-ins is left alone with manual guidance.
// ---------------------------------------------------------------------------

/**
 * Obsolete directives from the pre-LAMA-311 shipped unit. `ProtectHome`
 * made every `$HOME` path read-only for user units that actually establish a
 * mount/user namespace, so an assignment targeting `$HOME/<name>` could never
 * `mkdir` (EROFS); the static `ReadWritePaths` allowlist could not express the
 * product contract either. Both are removed; the remaining hardening
 * (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, resource limits)
 * is kept along with everything else in the file.
 */
const OBSOLETE_UNIT_DIRECTIVE = /^\s*(ProtectHome|ReadWritePaths)\s*=/;

/** Absolute path of the daemon's own persistent user unit. */
export function daemonUnitPath(opts: { unitDir?: string } = {}): string {
  return join(opts.unitDir ?? getUserUnitDir(), "lamasyncd.service");
}

/**
 * The shipped-unit markers every LamaSync-managed unit carries (all three
 * sources: `packaging/install/install.sh`, `packaging/systemd/lamasyncd.service`,
 * and `daemonServiceTemplate()`). Requiring the full signature — not just an
 * `ExecStart` that happens to point at the binary — keeps the migration away
 * from an operator's own hand-written `lamasyncd.service`, which must be
 * edited by its owner (see the refusal branch in `reconcileDaemonServiceUnit`).
 */
const MANAGED_UNIT_DESCRIPTION = "LamaSync Daemon";
const MANAGED_UNIT_SYSLOG_IDENTIFIER = "lamasyncd";

/** Trimmed values of every line whose key matches `key` (e.g. "ExecStart="). */
function unitDirectiveValues(content: string, key: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(key))
    .map((line) => line.slice(key.length).trim());
}

/**
 * True when `content` is recognisably a unit shipped by this project and it
 * starts the `lamasyncd` binary. Matches `ExecStart=` (not `ExecStartPre=` /
 * `ExecReload=`) and requires the shipped `Description` + `SyslogIdentifier`
 * markers, so a custom unit is never migrated on the strength of its binary
 * name alone.
 */
export function isLamaSyncManagedDaemonUnit(content: string): boolean {
  const startsDaemon = unitDirectiveValues(content, "ExecStart=").some((value) => {
    const token = value.split(/\s+/)[0] ?? "";
    return basename(token) === "lamasyncd";
  });
  if (!startsDaemon) return false;
  return (
    unitDirectiveValues(content, "Description=").includes(MANAGED_UNIT_DESCRIPTION) &&
    unitDirectiveValues(content, "SyslogIdentifier=").includes(
      MANAGED_UNIT_SYSLOG_IDENTIFIER,
    )
  );
}

/** Result of planning the unit migration. Pure data — no filesystem effects. */
export interface DaemonUnitMigrationPlan {
  /**
   * `unchanged` — nothing obsolete present (idempotent no-op).
   * `migrate` — obsolete directives found; `content` is the replacement.
   */
  action: "unchanged" | "migrate";
  /** Replacement unit content (identical to the input for `unchanged`). */
  content: string;
  /** The obsolete directive lines that were (or would be) removed. */
  removed: string[];
}

/**
 * Plan the LAMA-311 unit migration for an already-read unit file. Pure, so
 * the migration and its idempotence are testable without touching disk.
 */
export function planDaemonUnitMigration(content: string): DaemonUnitMigrationPlan {
  const removed: string[] = [];
  const kept = content.split("\n").filter((line) => {
    if (!OBSOLETE_UNIT_DIRECTIVE.test(line)) return true;
    removed.push(line.trim());
    return false;
  });
  if (removed.length === 0) {
    return { action: "unchanged", content, removed: [] };
  }
  return { action: "migrate", content: kept.join("\n"), removed };
}

/**
 * Outcome of a reconcile attempt, shaped for a CLI line or an action ack.
 * Every variant carries human-readable text; `guidance` is the manual command
 * an operator must run when the daemon could not finish the job itself.
 */
export interface DaemonUnitReconcileResult {
  status: "current" | "migrated" | "skipped" | "failed";
  summary: string;
  guidance: string | null;
  /** True when the running service must be restarted for the change to apply. */
  restartRequired: boolean;
}

/** Manual recovery for every path that ends without systemd picking the unit up. */
const MANUAL_UNIT_GUIDANCE =
  "systemctl --user daemon-reload && systemctl --user restart lamasyncd.service";

/** True when `<unit>.d/` exists and holds at least one `*.conf` drop-in. */
export function hasDaemonUnitDropIns(dropInDir: string): boolean {
  try {
    return readdirSync(dropInDir).some((name) => name.endsWith(".conf"));
  } catch {
    return false;
  }
}

/** Filesystem/IO seams, overridable so tests never touch the real unit dir. */
export interface ReconcileDaemonUnitDeps {
  unitPath?: string;
  dropInDir?: string;
  /** Availability probe for the user manager (default: `isSystemdAvailable`). */
  systemdAvailable?: () => boolean;
  /** `systemctl --user daemon-reload` (default: runSystemctl). */
  reload?: () => { ok: boolean; reason?: string };
  /**
   * Unit write (default: `writeFileAtomic` — sibling temp file, fsync, rename).
   * The atomic writer is what guarantees a failed write leaves the original
   * unit intact instead of a truncated file that would break the service at
   * the next boot.
   */
  writeFile?: (path: string, content: string) => void;
}

/**
 * Bring an installed `lamasyncd.service` unit up to the LAMA-311 contract:
 * drop the obsolete `ProtectHome` / `ReadWritePaths` directives, reload
 * systemd, and report what the caller still has to do (a restart). Never
 * throws; every refusal is an explicit `skipped`/`failed` result with
 * guidance, so a remote `update_daemon` can surface it instead of silently
 * leaving the client on the old unit.
 *
 * Refusals (all preserve the operator's file):
 *  - no unit at the path (not a systemd-managed install) — install first;
 *  - the unit is a symlink (could point into a repo checkout) — edit the
 *    target by hand;
 *  - the unit has `*.conf` drop-ins (someone already customizes it) — edit
 *    the drop-in by hand;
 *  - the unit does not start `lamasyncd` — not ours to rewrite;
 *  - `systemctl` is unavailable — the file change could not be reloaded, so
 *    it is not written at all (no half-applied state).
 *
 * Note for the remote path: a daemon whose *old* unit is actually effective
 * has `$HOME` read-only and cannot rewrite `~/.config/systemd/user/...`; the
 * write fails and this returns `failed` with the manual command. Running
 * `lamasyncd --update` from a shell (no sandbox) migrates the unit even when
 * the binary is already current.
 */
export function reconcileDaemonServiceUnit(
  deps: ReconcileDaemonUnitDeps = {},
): DaemonUnitReconcileResult {
  const unitPath = deps.unitPath ?? daemonUnitPath();
  const dropInDir = deps.dropInDir ?? `${unitPath}.d`;

  let link: ReturnType<typeof lstatSync>;
  try {
    link = lstatSync(unitPath);
  } catch {
    return {
      status: "skipped",
      summary: `no systemd user unit at ${unitPath}`,
      guidance: "re-run packaging/install/install.sh to create it",
      restartRequired: false,
    };
  }
  if (link.isSymbolicLink()) {
    return {
      status: "skipped",
      summary: `${unitPath} is a symlink; not rewriting it`,
      guidance: `edit the symlink target by hand, then run: ${MANUAL_UNIT_GUIDANCE}`,
      restartRequired: false,
    };
  }
  if (hasDaemonUnitDropIns(dropInDir)) {
    return {
      status: "skipped",
      summary: `${unitPath} has drop-ins in ${dropInDir}; not rewriting it`,
      guidance: `remove ProtectHome/ReadWritePaths from ${dropInDir} by hand, then run: ${MANUAL_UNIT_GUIDANCE}`,
      restartRequired: false,
    };
  }

  let content: string;
  try {
    content = readFileSync(unitPath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "failed",
      summary: `could not read ${unitPath}: ${msg}`,
      guidance: MANUAL_UNIT_GUIDANCE,
      restartRequired: false,
    };
  }
  if (!isLamaSyncManagedDaemonUnit(content)) {
    return {
      status: "skipped",
      summary:
        `${unitPath} does not carry the shipped LamaSync unit signature ` +
        "(Description=LamaSync Daemon + SyslogIdentifier=lamasyncd + ExecStart=…/lamasyncd); " +
        "not rewriting it",
      guidance:
        "this unit is operator-managed — apply the sandbox fix by hand if it needs it",
      restartRequired: false,
    };
  }

  const plan = planDaemonUnitMigration(content);
  if (plan.action === "unchanged") {
    return {
      status: "current",
      summary: `systemd unit is current (${unitPath})`,
      guidance: null,
      restartRequired: false,
    };
  }

  // Do not half-apply: without a user manager the rewritten file would never
  // be reloaded, so leave the operator's unit untouched and say so.
  const systemdAvailable = (deps.systemdAvailable ?? isSystemdAvailable)();
  if (!systemdAvailable) {
    return {
      status: "skipped",
      summary: `systemctl not available; left ${unitPath} unchanged`,
      guidance: "install systemd or run the daemon under your own supervisor",
      restartRequired: false,
    };
  }

  const write =
    deps.writeFile ??
    ((path: string, content: string): void => {
      // LAMA-311 review: never write the live unit in place. A short write or
      // a full disk would truncate the file and break the next service start;
      // the staged temp + fsync + rename leaves either the old or the complete
      // new unit. `writeFileAtomic` also preserves the existing file's mode.
      writeFileAtomic(path, content, 0o644);
    });
  try {
    write(unitPath, plan.content);
  } catch (err) {
    const code =
      err instanceof Error && "code" in err && typeof err.code === "string"
        ? err.code
        : undefined;
    return {
      status: "failed",
      summary:
        `could not rewrite ${unitPath}` +
        (code ? ` (${code})` : "") +
        // The common cause is the pre-fix sandbox itself: `ProtectHome=read-only`
        // makes ~/.config/systemd/user read-only for the running daemon.
        "; if the daemon is sandboxed, run `lamasyncd --update` from a shell",
      guidance:
        "run `lamasyncd --update` from a shell, then " + MANUAL_UNIT_GUIDANCE,
      // The file is untouched, so a restart would apply nothing.
      restartRequired: false,
    };
  }

  const reload = (deps.reload ?? defaultDaemonReload)();
  const removed = plan.removed.join(", ");
  if (!reload.ok) {
    return {
      status: "failed",
      summary:
        `removed ${removed} from ${unitPath} but \`systemctl --user daemon-reload\` failed` +
        (reload.reason ? ` (${reload.reason})` : ""),
      guidance: MANUAL_UNIT_GUIDANCE,
      // The file changed but systemd has not re-read it; a plain restart would
      // reuse the cached unit, so the reload is the operator's step.
      restartRequired: false,
    };
  }
  return {
    status: "migrated",
    summary: `removed obsolete sandbox directive(s) [${removed}] from ${unitPath}`,
    guidance: "systemctl --user restart lamasyncd.service",
    restartRequired: true,
  };
}

/** Default `daemon-reload` seam for `reconcileDaemonServiceUnit`. */
function defaultDaemonReload(): { ok: boolean; reason?: string } {
  const { status, stderr } = runSystemctl(["daemon-reload"]);
  if (status === 0) return { ok: true };
  const detail = stderr.trim();
  return { ok: false, reason: `exit ${status}${detail ? `: ${detail}` : ""}` };
}
