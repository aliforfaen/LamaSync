// Systemd unit generation smoke tests.
//
// These tests assert that the unit-file string generation is correct without
// invoking `systemctl` directly — the daemon-side run-loop is exercised
// through integration with `--mount` and the boot-adoption path.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMountUnitContent,
  daemonServiceTemplate,
  mountUnitName,
  writeMountUnitTo,
} from "./systemd.ts";

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
      "Environment=LAMASYNC_SOCKET_PATH=%h/lamasync.sock",
    );
    expect(content).toContain("After=lamasyncd.service network-online.target");
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
});

describe("daemonServiceTemplate", () => {
  test("uses a single percent for CPUQuota and sets the socket env", () => {
    const content = daemonServiceTemplate();
    expect(content).toContain("CPUQuota=50%\n");
    expect(content).not.toContain("CPUQuota=50%%");
    expect(content).toContain(
      "Environment=LAMASYNC_SOCKET_PATH=%h/lamasync.sock",
    );
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
});
