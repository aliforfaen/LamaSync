// LAMA-320: mount readiness must reflect a real FUSE mount (mountinfo, not
// "directory exists"), rclone startup failures must surface their stderr, and
// --allow-other must be gated on /etc/fuse.conf's user_allow_other.
//
// Regression coverage (AC5):
//  (a) existing-but-unmounted plain dir → isFuseMounted false
//  (b) fixture mountinfo: fuse.rclone entry true, non-fuse entry false,
//      octal-escaped (\040 = space) mount point true
//  (c) early rclone exit: startMount failure surfaces the child's stderr
//  (d) user_allow_other fixture gates --allow-other in buildRcloneArgs
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRcloneArgs,
  createStderrTail,
  getRecentMountStderr,
  isFuseMounted,
  isUserAllowOtherEnabled,
  startMount,
} from "./mounts.ts";

// mountinfo fields contain literal backslashes; a mount point with a space is
// recorded as `my\040mount` on disk.
const escapeMountinfoField = (path: string): string =>
  path.replace(/ /g, "\\040");

describe("isFuseMounted (mountinfo-backed, LAMA-320)", () => {
  test("(a) an existing but unmounted plain directory is not FUSE-mounted", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-fuse-a-"));
    try {
      expect(isFuseMounted(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-existent paths and unreadable mountinfo fail closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-fuse-failclosed-"));
    try {
      expect(isFuseMounted(join(dir, "does-not-exist"))).toBe(false);
      expect(isFuseMounted(dir, join(dir, "no-mountinfo-here"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(b) fixture mountinfo: fuse.rclone true, plain-dir entry false, \\040 path true", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-fuse-b-"));
    try {
      const plainDir = join(dir, "plain");
      const spacedDir = join(dir, "my mount");
      mkdirSync(plainDir);
      mkdirSync(spacedDir);
      const fixture = join(dir, "mountinfo");
      writeFileSync(
        fixture,
        [
          // Non-fuse filesystem whose mount point is plainDir.
          `29 25 0:21 / ${plainDir} rw,nosuid,nodev,relatime - ext4 /dev/sda2 rw`,
          // fuse.rclone mount point containing a space, recorded with \040.
          `30 25 0:22 / ${escapeMountinfoField(spacedDir)} rw,nosuid,nodev,relatime - fuse.rclone rclone rw,nosuid,nodev,relatime`,
          // Optional tag:value fields before the separator must not confuse
          // the filesystem-type lookup.
          `31 25 0:23 / /somewhere/else rw,nosuid,nodev,relatime user_id=1000,group_id=1000 - fuse.sshfs sshfs rw,user_id=1000`,
          "",
        ].join("\n"),
      );

      expect(isFuseMounted(spacedDir, fixture)).toBe(true); // fuse.rclone + \040 decode
      expect(isFuseMounted(plainDir, fixture)).toBe(false); // listed, but not a FUSE fs
      expect(isFuseMounted(join(dir, "not-listed"), fixture)).toBe(false);
      // A fuse entry at a path that does not exist locally cannot be mounted.
      expect(isFuseMounted("/somewhere/else", fixture)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createStderrTail (bounded tail, LAMA-320)", () => {
  test("keeps only the last 8 KiB and never exceeds the cap", () => {
    const tail = createStderrTail();
    tail.push("x".repeat(9_000));
    const text = tail.text();
    expect(text.length).toBeLessThanOrEqual(8 * 1024);
    expect(text).toBe("x".repeat(8 * 1024));
  });

  test("trims from the front on line boundaries, keeping the newest lines", () => {
    const tail = createStderrTail();
    for (let i = 0; i < 1_000; i += 1) {
      tail.push(`line-${String(i).padStart(4, "0")}\n`);
    }
    const text = tail.text();
    // 1000 lines × 10 bytes = 10000 bytes → drops everything before the line
    // that crosses the 8192-byte mark (line 0180 ends at byte 1809).
    expect(text.length).toBeLessThanOrEqual(8 * 1024);
    expect(text.startsWith("line-0181\n")).toBe(true);
    expect(text.endsWith("line-0999\n")).toBe(true);
  });

  test("preserves lines split across pushes", () => {
    const tail = createStderrTail(64);
    tail.push("a");
    tail.push("bc\nsecond ");
    tail.push("line\n");
    expect(tail.text()).toBe("abc\nsecond line\n");
  });
});

describe("allow-other preflight (LAMA-320)", () => {
  test("isUserAllowOtherEnabled parses fuse.conf-style fixtures", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-fuseconf-"));
    try {
      const disabled = join(dir, "fuse-disabled.conf");
      const enabled = join(dir, "fuse-enabled.conf");
      const inlineComment = join(dir, "fuse-inline.conf");
      writeFileSync(
        disabled,
        "# The file /etc/fuse.conf allows for the following parameters:\n#user_allow_other\n#mount_max = 1000\n",
      );
      writeFileSync(enabled, "# enabled by the admin\nuser_allow_other\nmount_max = 1000\n");
      writeFileSync(inlineComment, "user_allow_other   # enable shared access\n");

      expect(isUserAllowOtherEnabled(disabled)).toBe(false);
      expect(isUserAllowOtherEnabled(enabled)).toBe(true);
      expect(isUserAllowOtherEnabled(inlineComment)).toBe(true);
      expect(isUserAllowOtherEnabled(join(dir, "missing.conf"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(d) fixture conf gates --allow-other in buildRcloneArgs", () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-allowother-"));
    try {
      const disabledConf = join(dir, "disabled.conf");
      const enabledConf = join(dir, "enabled.conf");
      writeFileSync(disabledConf, "#user_allow_other\n");
      writeFileSync(enabledConf, "user_allow_other\n");
      const base = {
        remotePath: "remote:backup",
        mountPath: "/mnt/backup",
        configPath: "/cfg/rclone.conf",
        cacheProfile: "media" as const,
        cacheMaxSize: "5G",
        cacheDir: "/cache/vfs/x",
      };

      const without = buildRcloneArgs({
        ...base,
        allowOther: isUserAllowOtherEnabled(disabledConf),
      });
      expect(without).not.toContain("--allow-other");
      // The rest of the invocation is unaffected.
      expect(without[0]).toBe("mount");
      expect(without).toContain("--vfs-cache-mode");

      const withAllowOther = buildRcloneArgs({
        ...base,
        allowOther: isUserAllowOtherEnabled(enabledConf),
      });
      expect(withAllowOther).toContain("--allow-other");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("startMount surfaces early rclone failures (LAMA-320)", () => {
  test("(c) thrown error includes the child's stderr when rclone exits early", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lamasync-startmount-c-"));
    const binDir = join(dir, "bin");
    const mountPath = join(dir, "mnt");
    const configPath = join(dir, "rclone.conf");
    mkdirSync(binDir);
    mkdirSync(mountPath);
    writeFileSync(configPath, "[dummy]\ntype = local\n");

    // Fake rclone: prints a startup error to stderr and dies immediately.
    const fakeRclone = join(binDir, "rclone");
    writeFileSync(
      fakeRclone,
      "#!/bin/sh\necho 'rclone: FUSE error: remote \"bogus\" not found' >&2\nexit 1\n",
      { mode: 0o755 },
    );

    const folderId = `test-early-exit-${process.pid}-${Date.now()}`;
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const pidFilePath = `/run/user/${uid}/lamasync/mounts/${folderId}.pid`;
    const cacheDir = join(homedir(), ".cache", "lamasync", "vfs", folderId);
    try {
      // The pid dir lives under /run/user/<uid>; create it if absent so the
      // test is not coupled to a desktop session already having done so.
      try {
        mkdirSync(`/run/user/${uid}/lamasync/mounts`, { recursive: true });
      } catch {
        // best-effort; the failure branch also removes the pid file
      }

      await expect(
        startMount({
          folderId,
          remotePath: "bogus:whatever",
          mountPath,
          configPath,
          cacheProfile: "minimal",
          rcloneBin: fakeRclone,
        }),
      ).rejects.toThrow(
        // The failure names the exit code and includes the child's stderr.
        /rclone exited with code 1[\s\S]*FUSE error: remote "bogus" not found/,
      );
      // Entry was torn down on the failed start → no retained stderr tail.
      expect(getRecentMountStderr(folderId)).toBeNull();
    } finally {
      try {
        unlinkSync(pidFilePath);
      } catch {
        // already removed by the failure path
      }
      rmSync(dir, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
