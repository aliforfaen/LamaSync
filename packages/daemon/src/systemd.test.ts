// Systemd unit generation smoke tests.
//
// These tests assert that the unit-file string generation is correct without
// invoking `systemctl` directly — the daemon-side run-loop is exercised
// through integration with `--mount` and the boot-adoption path.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMountUnitContent,
  daemonServiceTemplate,
  daemonUnitPath,
  getRuntimeUnitDir,
  getUserUnitDir,
  hasDaemonUnitDropIns,
  isLamaSyncManagedDaemonUnit,
  mountUnitName,
  mountUnitPath,
  planDaemonUnitMigration,
  reconcileDaemonServiceUnit,
  removeMountUnit,
  writeMountUnit,
  writeMountUnitTo,
} from "./systemd.ts";

// Unit dirs derive from the environment at call time, so tests that need a
// predictable (or tmp-backed) location set $XDG_RUNTIME_DIR and restore it
// afterwards. Bun runs tests within a file sequentially, so the mutation is
// safe as long as each test restores the prior value in `finally`.
function withXdgRuntimeDir(dir: string | undefined, fn: () => void): void {
  const prev = process.env.XDG_RUNTIME_DIR;
  if (dir === undefined) {
    delete process.env.XDG_RUNTIME_DIR;
  } else {
    process.env.XDG_RUNTIME_DIR = dir;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = prev;
    }
  }
}

describe("mountUnitName", () => {
  test("returns lamasync-mount-<folderId>.service", () => {
    expect(mountUnitName("abc123")).toBe("lamasync-mount-abc123.service");
    expect(mountUnitName("f1")).toBe("lamasync-mount-f1.service");
  });
});

describe("buildMountUnitContent", () => {
  test("includes the expected ExecStart, Requires, and --mount lines", () => {
    const content = buildMountUnitContent("abc-123");
    expect(content).toContain("Description=LamaSync mount abc-123");
    expect(content).toContain("Requires=lamasyncd.service");
    expect(content).toContain(
      "ExecStart=%h/.local/bin/lamasyncd --mount abc-123",
    );
    expect(content).toContain(
      "Environment=LAMASYNC_SOCKET_PATH=${XDG_RUNTIME_DIR}/lamasync.sock",
    );
    expect(content).toContain("After=lamasyncd.service network-online.target");
    expect(content).toContain("Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin");
    expect(content).toContain("WantedBy=default.target");
  });

  test("honours custom installDir and socketPath", () => {
    const content = buildMountUnitContent("fid", {
      installDir: "/opt/lamasyncd",
      socketPath: "/run/lamasync.sock",
    });
    expect(content).toContain(
      "ExecStart=/opt/lamasyncd --mount fid",
    );
    expect(content).toContain(
      "Environment=LAMASYNC_SOCKET_PATH=/run/lamasync.sock",
    );
  });
});

describe("getRuntimeUnitDir", () => {
  test("resolves under $XDG_RUNTIME_DIR when set", () => {
    withXdgRuntimeDir("/run/user/4242", () => {
      expect(getRuntimeUnitDir()).toBe("/run/user/4242/systemd/user");
    });
  });

  test("falls back to /run/user/<uid>/systemd/user when unset", () => {
    withXdgRuntimeDir(undefined, () => {
      const dir = getRuntimeUnitDir();
      expect(dir).toMatch(/^\/run\/user\/\d+\/systemd\/user$/);
      // ...and not the persistent ~/.config location
      expect(dir.startsWith(join(homedir(), ".config"))).toBe(false);
    });
  });

  test("treats an empty $XDG_RUNTIME_DIR as unset", () => {
    withXdgRuntimeDir("", () => {
      expect(getRuntimeUnitDir()).toMatch(/^\/run\/user\/\d+\/systemd\/user$/);
    });
  });
});

describe("mount unit location (LAMA-320)", () => {
  test("per-mount units resolve under the runtime dir, not ~/.config/systemd/user", () => {
    withXdgRuntimeDir("/run/user/4242", () => {
      expect(mountUnitPath("fid")).toBe(
        join(getRuntimeUnitDir(), mountUnitName("fid")),
      );
      expect(mountUnitPath("fid")).toBe("/run/user/4242/systemd/user/lamasync-mount-fid.service");
      expect(mountUnitPath("fid").includes(".config/systemd/user")).toBe(false);
    });
  });

  test("writeMountUnit lands in the runtime dir and removeMountUnit clears it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-runtime-test-"));
    withXdgRuntimeDir(dir, () => {
      const path = writeMountUnit("fid");
      expect(path).toBe(join(getRuntimeUnitDir(), mountUnitName("fid")));
      expect(existsSync(path)).toBe(true);
      const onDisk = readFileSync(path, "utf8");
      expect(onDisk).toContain("--mount fid");
      removeMountUnit("fid");
      expect(existsSync(path)).toBe(false);
    });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("writeMountUnitTo", () => {
  test("writes the unit file to the requested directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-systemd-test-"));
    try {
      const path = writeMountUnitTo("fid", dir);
      expect(path).toBe(join(dir, mountUnitName("fid")));
      const onDisk = readFileSync(path, "utf8");
      expect(onDisk).toContain("--mount fid");
      expect(onDisk).toContain("Requires=lamasyncd.service");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates the unit directory (including missing parents) first", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-systemd-test-"));
    const nested = join(dir, "systemd", "user");
    try {
      const path = writeMountUnitTo("fid", nested);
      expect(path).toBe(join(nested, mountUnitName("fid")));
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("daemon service location (LAMA-320)", () => {
  test("getUserUnitDir stays under ~/.config/systemd/user", () => {
    expect(getUserUnitDir()).toBe(
      join(homedir(), ".config", "systemd", "user"),
    );
    // The daemon service unit keeps its persistent home even though per-mount
    // units moved to the runtime dir.
    expect(join(getUserUnitDir(), "lamasyncd.service")).toBe(
      join(homedir(), ".config", "systemd", "user", "lamasyncd.service"),
    );
  });

  test("the runtime dir never shadows the daemon service dir", () => {
    withXdgRuntimeDir("/run/user/4242", () => {
      expect(getRuntimeUnitDir()).not.toBe(getUserUnitDir());
      expect(join(getRuntimeUnitDir(), "lamasyncd.service")).not.toBe(
        join(getUserUnitDir(), "lamasyncd.service"),
      );
    });
  });
});

describe("daemonServiceTemplate", () => {
  test("uses a single percent for CPUQuota and sets the socket env", () => {
    const content = daemonServiceTemplate();
    expect(content).toContain("CPUQuota=50%\n");
    expect(content).not.toContain("CPUQuota=50%%");
    expect(content).toContain(
      "Environment=LAMASYNC_SOCKET_PATH=${XDG_RUNTIME_DIR}/lamasync.sock",
    );
    // LAMA-218: %h (home) works for /root and every non-/home home; the
    // previous /home/%u only matched homes under /home.
    expect(content).toContain("Environment=PATH=%h/.local/bin");
  });

  test("leaves operator-selected home paths writable (LAMA-311)", () => {
    const content = daemonServiceTemplate();
    expect(content).not.toContain("ProtectHome=read-only");
    expect(content).not.toContain("ReadWritePaths=");
    expect(content).not.toContain("%h/projects");
    expect(content).toContain("NoNewPrivileges=true");
    expect(content).toContain("PrivateTmp=true");
    expect(content).toContain("ProtectSystem=full");
  });

  test("honours custom binaryPath and socketPath", () => {
    const content = daemonServiceTemplate({
      binaryPath: "/opt/lamasyncd",
      socketPath: "/var/run/lamasync.sock",
    });
    expect(content).toContain("ExecStart=/opt/lamasyncd");
    expect(content).toContain(
      "Environment=LAMASYNC_SOCKET_PATH=/var/run/lamasync.sock",
    );
  });

  test("bounds the crash loop with StartLimit (LAMA-243)", () => {
    const content = daemonServiceTemplate();
    expect(content).toContain("StartLimitIntervalSec=300");
    expect(content).toContain("StartLimitBurst=8");
  });
});

// ---------------------------------------------------------------------------
// LAMA-311: systemd user unit reconciliation.
//
// `dev-vm` (2026-09-17) ran a post-fix v0.3.11 binary under a unit written on
// Aug 6 — still `ProtectHome=read-only` plus a static `ReadWritePaths`
// allowlist — because neither `lamasyncd --update` nor `update_daemon` ever
// rewrote the unit. These tests pin the migration, its idempotence, and every
// refusal path that must leave an operator's custom unit alone.
// ---------------------------------------------------------------------------

/** The pre-fix unit as it exists on `dev-vm` (install.sh output + Aug-6 era
 *  hardening). Deliberately includes operator-added lines to prove the
 *  migration is line-surgical. */
const STALE_MANAGED_UNIT = [
  "[Unit]",
  "Description=LamaSync Daemon",
  "Documentation=https://github.com/aliforfaen/LamaSync",
  "After=network-online.target",
  "Wants=network-online.target",
  "",
  "[Service]",
  "Type=simple",
  "ExecStart=/home/messhias/.local/bin/lamasyncd",
  "ExecStartPre=-/home/messhias/.local/bin/lamasyncd --check-update",
  "ExecReload=/bin/kill -HUP $MAINPID",
  "Restart=on-failure",
  "RestartSec=10s",
  "StandardOutput=journal",
  "StandardError=journal",
  "SyslogIdentifier=lamasyncd",
  "NoNewPrivileges=true",
  "PrivateTmp=true",
  "ProtectSystem=full",
  "ProtectHome=read-only",
  "ReadWritePaths=%h/projects %h/lamasync /run/user/%U",
  "Environment=LAMASYNC_SOCKET_PATH=/run/user/1000/lamasync.sock",
  "Environment=PATH=/home/messhias/.local/bin:/usr/local/bin:/usr/bin",
  "Environment=OPERATOR_EXTRA=keep-me",
  "ReadOnlyPaths=/etc/lamasync-extra",
  "MemoryMax=512M",
  "CPUQuota=50%",
  "",
  "[Install]",
  "WantedBy=default.target",
  "",
].join("\n");

describe("isLamaSyncManagedDaemonUnit (LAMA-311)", () => {
  test("recognizes both the install.sh absolute path and the packaged %h unit", () => {
    expect(isLamaSyncManagedDaemonUnit(STALE_MANAGED_UNIT)).toBe(true);
    // The packaged template uses `%h` and carries the same markers.
    expect(
      isLamaSyncManagedDaemonUnit(
        [
          "[Unit]",
          "Description=LamaSync Daemon",
          "[Service]",
          "SyslogIdentifier=lamasyncd",
          "ExecStart=%h/.local/bin/lamasyncd",
          "",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  test("rejects a unit that only mentions lamasyncd in ExecStartPre/ExecReload", () => {
    expect(
      isLamaSyncManagedDaemonUnit(
        "[Service]\nExecStart=/usr/bin/other\nExecStartPre=-/home/u/.local/bin/lamasyncd --check-update\n",
      ),
    ).toBe(false);
  });

  test("rejects an operator-owned unit that starts lamasyncd without the shipped markers", () => {
    // LAMA-311 review: the binary name alone must never make a unit ours to
    // rewrite. The shipped `Description` + `SyslogIdentifier` pair is the
    // signature; a hand-written unit is refused and left for its owner.
    const custom = [
      "[Unit]",
      "Description=my own lamasyncd wrapper",
      "[Service]",
      "ExecStart=/opt/custom/lamasyncd",
      "ProtectHome=read-only",
      "",
    ].join("\n");
    expect(isLamaSyncManagedDaemonUnit(custom)).toBe(false);
    // ...and the same unit with only one of the two markers is still refused.
    expect(
      isLamaSyncManagedDaemonUnit(
        custom.replace("Description=my own lamasyncd wrapper", "Description=LamaSync Daemon"),
      ),
    ).toBe(false);
    expect(
      isLamaSyncManagedDaemonUnit(
        custom.replace("Description=my own lamasyncd wrapper", "SyslogIdentifier=lamasyncd"),
      ),
    ).toBe(false);
  });

  test("rejects an unrelated user unit", () => {
    expect(isLamaSyncManagedDaemonUnit("[Service]\nExecStart=/usr/bin/caddy\n")).toBe(
      false,
    );
  });
});

describe("planDaemonUnitMigration (LAMA-311)", () => {
  test("removes only ProtectHome/ReadWritePaths and preserves every other line", () => {
    const plan = planDaemonUnitMigration(STALE_MANAGED_UNIT);
    expect(plan.action).toBe("migrate");
    expect(plan.removed).toEqual([
      "ProtectHome=read-only",
      "ReadWritePaths=%h/projects %h/lamasync /run/user/%U",
    ]);
    expect(plan.content).not.toContain("ProtectHome=");
    expect(plan.content).not.toContain("ReadWritePaths=");
    // Preserved: hardening, custom lines, binary/socket paths, comments,
    // ExecStartPre/ExecReload, and the operator's own ReadOnlyPaths.
    for (const keep of [
      "ExecStart=/home/messhias/.local/bin/lamasyncd",
      "ExecStartPre=-/home/messhias/.local/bin/lamasyncd --check-update",
      "ExecReload=/bin/kill -HUP $MAINPID",
      "NoNewPrivileges=true",
      "PrivateTmp=true",
      "ProtectSystem=full",
      "Environment=LAMASYNC_SOCKET_PATH=/run/user/1000/lamasync.sock",
      "Environment=OPERATOR_EXTRA=keep-me",
      "ReadOnlyPaths=/etc/lamasync-extra",
      "MemoryMax=512M",
      "WantedBy=default.target",
    ]) {
      expect(plan.content).toContain(keep);
    }
    // Exact line count: two lines gone, nothing added or reordered.
    expect(plan.content.split("\n").length).toBe(
      STALE_MANAGED_UNIT.split("\n").length - 2,
    );
  });

  test("is idempotent — a migrated unit plans as unchanged", () => {
    const first = planDaemonUnitMigration(STALE_MANAGED_UNIT);
    const second = planDaemonUnitMigration(first.content);
    expect(second.action).toBe("unchanged");
    expect(second.removed).toEqual([]);
    expect(second.content).toBe(first.content);
  });

  test("leaves a unit with no obsolete directives untouched", () => {
    const content = "[Service]\nExecStart=/home/u/.local/bin/lamasyncd\n";
    const plan = planDaemonUnitMigration(content);
    expect(plan).toEqual({ action: "unchanged", content, removed: [] });
  });
});

describe("reconcileDaemonServiceUnit (LAMA-311)", () => {
  interface Fixture {
    dir: string;
    unitPath: string;
    dropInDir: string;
  }

  function fixture(options: { content?: string } = {}): Fixture {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-unit-reconcile-"));
    const unitPath = join(dir, "lamasyncd.service");
    if (options.content !== undefined) {
      writeFileSync(unitPath, options.content, { mode: 0o644 });
    }
    return { dir, unitPath, dropInDir: `${unitPath}.d` };
  }

  test("missing unit → skipped with install guidance", () => {
    const fx = fixture();
    try {
      const result = reconcileDaemonServiceUnit({
        unitPath: fx.unitPath,
        dropInDir: fx.dropInDir,
      });
      expect(result.status).toBe("skipped");
      expect(result.summary).toContain("no systemd user unit");
      expect(result.guidance).toContain("install.sh");
      expect(result.restartRequired).toBe(false);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("migrates a stale managed unit, rewrites the file, and reloads systemd", () => {
    const fx = fixture({ content: STALE_MANAGED_UNIT });
    let reloads = 0;
    try {
      const result = reconcileDaemonServiceUnit({
        unitPath: fx.unitPath,
        dropInDir: fx.dropInDir,
        systemdAvailable: () => true,
        reload: () => {
          reloads += 1;
          return { ok: true };
        },
      });
      expect(result.status).toBe("migrated");
      expect(result.restartRequired).toBe(true);
      expect(result.guidance).toContain("restart lamasyncd.service");
      expect(reloads).toBe(1);
      const onDisk = readFileSync(fx.unitPath, "utf8");
      expect(onDisk).not.toContain("ProtectHome=");
      expect(onDisk).not.toContain("ReadWritePaths=");
      expect(onDisk).toContain("ExecStart=/home/messhias/.local/bin/lamasyncd");
      expect(onDisk).toContain("Environment=OPERATOR_EXTRA=keep-me");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("second run is a no-op (current) — no rewrite, no reload", () => {
    const fx = fixture({ content: STALE_MANAGED_UNIT });
    let reloads = 0;
    const deps = {
      unitPath: fx.unitPath,
      dropInDir: fx.dropInDir,
      systemdAvailable: () => true,
      reload: () => {
        reloads += 1;
        return { ok: true };
      },
    };
    try {
      expect(reconcileDaemonServiceUnit(deps).status).toBe("migrated");
      const afterFirst = readFileSync(fx.unitPath, "utf8");
      const second = reconcileDaemonServiceUnit(deps);
      expect(second.status).toBe("current");
      expect(second.restartRequired).toBe(false);
      expect(reloads).toBe(1);
      expect(readFileSync(fx.unitPath, "utf8")).toBe(afterFirst);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("an operator-owned unit (no shipped markers) is never rewritten", () => {
    const custom = [
      "[Unit]",
      "Description=my own lamasyncd wrapper",
      "[Service]",
      "ExecStart=/opt/custom/lamasyncd",
      "ProtectHome=read-only",
      "ReadWritePaths=/srv/data",
      "",
    ].join("\n");
    const fx = fixture({ content: custom });
    try {
      const result = reconcileDaemonServiceUnit({
        unitPath: fx.unitPath,
        dropInDir: fx.dropInDir,
        systemdAvailable: () => true,
        reload: () => ({ ok: true }),
      });
      expect(result.status).toBe("skipped");
      expect(result.summary).toContain("shipped LamaSync unit signature");
      expect(result.guidance).toContain("operator-managed");
      expect(readFileSync(fx.unitPath, "utf8")).toBe(custom);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a unit that is not a daemon unit is never rewritten", () => {
    const custom = "[Service]\nExecStart=/usr/bin/caddy\nProtectHome=read-only\n";
    const fx = fixture({ content: custom });
    try {
      const result = reconcileDaemonServiceUnit({
        unitPath: fx.unitPath,
        dropInDir: fx.dropInDir,
        systemdAvailable: () => true,
        reload: () => ({ ok: true }),
      });
      expect(result.status).toBe("skipped");
      expect(result.summary).toContain("shipped LamaSync unit signature");
      expect(readFileSync(fx.unitPath, "utf8")).toBe(custom);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a unit with drop-ins is left alone with manual guidance", () => {
    const fx = fixture({ content: STALE_MANAGED_UNIT });
    mkdirSync(fx.dropInDir, { recursive: true });
    writeFileSync(join(fx.dropInDir, "10-override.conf"), "[Service]\nCPUQuota=10%\n");
    try {
      expect(hasDaemonUnitDropIns(fx.dropInDir)).toBe(true);
      const result = reconcileDaemonServiceUnit({
        unitPath: fx.unitPath,
        dropInDir: fx.dropInDir,
        systemdAvailable: () => true,
        reload: () => ({ ok: true }),
      });
      expect(result.status).toBe("skipped");
      expect(result.summary).toContain("drop-ins");
      expect(result.guidance).toContain("by hand");
      expect(readFileSync(fx.unitPath, "utf8")).toBe(STALE_MANAGED_UNIT);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("an empty drop-in directory is not a customisation", () => {
    const fx = fixture({ content: STALE_MANAGED_UNIT });
    mkdirSync(fx.dropInDir, { recursive: true });
    try {
      expect(hasDaemonUnitDropIns(fx.dropInDir)).toBe(false);
      expect(
        reconcileDaemonServiceUnit({
          unitPath: fx.unitPath,
          dropInDir: fx.dropInDir,
          systemdAvailable: () => true,
          reload: () => ({ ok: true }),
        }).status,
      ).toBe("migrated");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("a symlinked unit is refused (it may point into a checkout)", () => {
    const fx = fixture({ content: STALE_MANAGED_UNIT });
    const target = join(fx.dir, "real.service");
    renameSync(fx.unitPath, target);
    symlinkSync(target, fx.unitPath);
    try {
      const result = reconcileDaemonServiceUnit({
        unitPath: fx.unitPath,
        dropInDir: fx.dropInDir,
        systemdAvailable: () => true,
        reload: () => ({ ok: true }),
      });
      expect(result.status).toBe("skipped");
      expect(result.summary).toContain("symlink");
      expect(readFileSync(target, "utf8")).toBe(STALE_MANAGED_UNIT);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("systemctl unavailable → skipped without touching the file", () => {
    const fx = fixture({ content: STALE_MANAGED_UNIT });
    try {
      const result = reconcileDaemonServiceUnit({
        unitPath: fx.unitPath,
        dropInDir: fx.dropInDir,
        systemdAvailable: () => false,
      });
      expect(result.status).toBe("skipped");
      expect(result.summary).toContain("systemctl not available");
      expect(readFileSync(fx.unitPath, "utf8")).toBe(STALE_MANAGED_UNIT);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("the rewrite is atomic: no staging file is left behind", () => {
    const fx = fixture({ content: STALE_MANAGED_UNIT });
    try {
      expect(
        reconcileDaemonServiceUnit({
          unitPath: fx.unitPath,
          dropInDir: fx.dropInDir,
          systemdAvailable: () => true,
          reload: () => ({ ok: true }),
        }).status,
      ).toBe("migrated");
      // The default writer stages a sibling temp file, fsyncs it, then renames
      // it over the unit — so the directory holds only the final unit.
      expect(readdirSync(fx.dir)).toEqual(["lamasyncd.service"]);
      expect(readFileSync(fx.unitPath, "utf8")).not.toContain("ProtectHome=");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("write failure (sandboxed daemon) → failed with the CLI escape hatch", () => {
    const fx = fixture({ content: STALE_MANAGED_UNIT });
    try {
      const result = reconcileDaemonServiceUnit({
        unitPath: fx.unitPath,
        dropInDir: fx.dropInDir,
        systemdAvailable: () => true,
        writeFile: () => {
          throw new Error("EROFS: read-only file system");
        },
      });
      expect(result.status).toBe("failed");
      expect(result.summary).toContain("could not rewrite");
      expect(result.summary).toContain("lamasyncd --update");
      expect(result.guidance).toContain("daemon-reload");
      expect(result.restartRequired).toBe(false);
      // A failed write leaves the original unit byte-for-byte intact.
      expect(readFileSync(fx.unitPath, "utf8")).toBe(STALE_MANAGED_UNIT);
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  // Skipped for root, where directory permissions do not deny writes.
  test.skipIf(process.getuid?.() === 0)(
    "a real filesystem write failure leaves the original unit intact",
    () => {
      const fx = fixture({ content: STALE_MANAGED_UNIT });
      try {
        chmodSync(fx.dir, 0o500);
        const result = reconcileDaemonServiceUnit({
          unitPath: fx.unitPath,
          dropInDir: fx.dropInDir,
          systemdAvailable: () => true,
          reload: () => ({ ok: true }),
        });
        expect(result.status).toBe("failed");
        expect(result.summary).toContain("could not rewrite");
        chmodSync(fx.dir, 0o700);
        expect(readFileSync(fx.unitPath, "utf8")).toBe(STALE_MANAGED_UNIT);
        expect(readdirSync(fx.dir)).toEqual(["lamasyncd.service"]);
      } finally {
        chmodSync(fx.dir, 0o700);
        rmSync(fx.dir, { recursive: true, force: true });
      }
    },
  );

  test("daemon-reload failure → failed and names the reload command", () => {
    const fx = fixture({ content: STALE_MANAGED_UNIT });
    try {
      const result = reconcileDaemonServiceUnit({
        unitPath: fx.unitPath,
        dropInDir: fx.dropInDir,
        systemdAvailable: () => true,
        reload: () => ({ ok: false, reason: "exit 1: Failed to reload" }),
      });
      expect(result.status).toBe("failed");
      expect(result.summary).toContain("daemon-reload");
      expect(result.summary).toContain("Failed to reload");
      // The file changed but systemd has not re-read it: the operator must
      // reload first, so the caller must not just restart.
      expect(result.restartRequired).toBe(false);
      // The file is already migrated; the operator only has to reload/restart.
      expect(readFileSync(fx.unitPath, "utf8")).not.toContain("ProtectHome=");
    } finally {
      rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test("daemonUnitPath honours the unit-dir override", () => {
    expect(daemonUnitPath({ unitDir: "/tmp/x" })).toBe("/tmp/x/lamasyncd.service");
    expect(daemonUnitPath()).toBe(join(getUserUnitDir(), "lamasyncd.service"));
  });
});
