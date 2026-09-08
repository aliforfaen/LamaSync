// Systemd unit generation smoke tests.
//
// These tests assert that the unit-file string generation is correct without
// invoking `systemctl` directly — the daemon-side run-loop is exercised
// through integration with `--mount` and the boot-adoption path.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMountUnitContent,
  daemonServiceTemplate,
  getRuntimeUnitDir,
  getUserUnitDir,
  mountUnitName,
  mountUnitPath,
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
