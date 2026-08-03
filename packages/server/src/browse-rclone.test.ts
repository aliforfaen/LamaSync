// LAMA-226 P0-1 / P0-2: unit tests for the pure helpers that produce the
// rclone config + argv for Data Browser write operations. They run without
// `rclone`, the filesystem, or a DB — the AGENTS.md invariant "`bun test`
// always works" must hold even on hosts without rclone installed.

import { describe, expect, test } from "bun:test";
import type { BrowseRef } from "@lamasync/core";
import {
  buildRcloneArgv,
  buildRcloneConfig,
  destKey,
  isContainedLocalMove,
  isSafeS3IntraFolderMove,
  refLabel,
  remotePath,
} from "./browse-rclone.ts";

const localRef: BrowseRef = { kind: "local", path: "src" };
const s3Ref: BrowseRef = { kind: "s3", folderId: "folder-1", path: "docs/sub" };

describe("destKey", () => {
  test("canonical form strips leading/trailing slashes", () => {
    expect(destKey({ kind: "local", path: "/src/" })).toBe("local::src");
  });

  test("encodes s3 folderId when present", () => {
    expect(destKey(s3Ref)).toBe("s3:folder-1:docs/sub");
  });
});

describe("refLabel", () => {
  test("local label uses colon-prefixed form", () => {
    expect(refLabel(localRef)).toBe("local:src");
  });

  test("s3 label includes folder id", () => {
    expect(refLabel(s3Ref)).toBe("s3:folder-1:docs/sub");
  });
});

describe("remotePath", () => {
  test("local ref: returns prefix/name", () => {
    expect(remotePath(localRef, "hello.txt", undefined)).toBe("src/hello.txt");
  });

  test("s3 ref: prepends the bucket (the bug fix)", () => {
    // Before the fix the function returned "docs/sub/hello.txt" and rclone
    // would have created a bucket named `docs` and a `sub/hello.txt` key.
    // After the fix it returns "cold-bucket/docs/sub/hello.txt", matching
    // the read-side `listS3Objects` which already uses bucket separately.
    expect(remotePath(s3Ref, "hello.txt", "cold-bucket")).toBe(
      "cold-bucket/docs/sub/hello.txt",
    );
  });

  test("s3 ref with empty prefix still emits the bucket", () => {
    expect(
      remotePath(
        { kind: "s3", folderId: "f", path: "" },
        "key.txt",
        "vault",
      ),
    ).toBe("vault/key.txt");
  });

  test("local ref drops a trailing slash before joining", () => {
    expect(remotePath({ kind: "local", path: "a/b/" }, "c", undefined)).toBe(
      "a/b/c",
    );
  });
});

describe("buildRcloneConfig", () => {
  test("emits a single s3 section when both sides share a bucket", () => {
    const text = buildRcloneConfig({
      src: {
        name: "src",
        folder: {} as never,
        provider: "other",
        endpoint: "s3.example.com",
        accessKeyId: "AKIA",
        secretAccessKey: "SECRET",
        region: null,
        bucket: "vault",
      },
      dst: {
        name: "src",
        folder: {} as never,
        provider: "other",
        endpoint: "s3.example.com",
        accessKeyId: "AKIA",
        secretAccessKey: "SECRET",
        region: null,
        bucket: "vault",
      },
    });
    expect(text).toContain("[src]");
    expect(text).toContain("type = s3");
    expect(text).toContain("secret_access_key = SECRET");
    expect(text).not.toContain("[dst]");
  });

  test("emits separate src + dst sections when endpoints differ", () => {
    const text = buildRcloneConfig({
      src: {
        name: "src",
        folder: {} as never,
        provider: "aws",
        endpoint: "s3.amazonaws.com",
        accessKeyId: "AKIA_SRC",
        secretAccessKey: "SECRET_SRC",
        region: "us-east-1",
        bucket: "src-bucket",
      },
      dst: {
        name: "dst",
        folder: {} as never,
        provider: "other",
        endpoint: "sos-ch-dk-2.exo.io",
        accessKeyId: "AKIA_DST",
        secretAccessKey: "SECRET_DST",
        region: "other-v2-signature",
        bucket: "dst-bucket",
      },
    });
    expect(text).toContain("[src]");
    expect(text).toContain("endpoint = s3.amazonaws.com");
    expect(text).toContain("region = us-east-1");
    expect(text).toContain("[dst]");
    expect(text).toContain("endpoint = sos-ch-dk-2.exo.io");
    expect(text).toContain("region = other-v2-signature");
    expect(text).not.toContain("src-bucket");
    expect(text).not.toContain("dst-bucket");
  });

  test("emits local section for non-s3 side", () => {
    const text = buildRcloneConfig({
      src: { name: "src" },
      dst: {
        name: "dst",
        folder: {} as never,
        provider: "aws",
        endpoint: "s3.amazonaws.com",
        accessKeyId: "AKIA",
        secretAccessKey: "SECRET",
        region: "us-east-1",
        bucket: "b",
      },
    });
    expect(text).toContain("[src]\ntype = local");
    expect(text).toContain("[dst]\ntype = s3");
  });
});

describe("buildRcloneArgv", () => {
  test("copyto: src remote:path, dst remote:path, --config, --timeout", () => {
    const argv = buildRcloneArgv({
      operation: "copyto",
      configPath: "/tmp/rclone.conf",
      srcRemote: "src",
      srcPath: "src/hello.txt",
      dstRemote: "dst",
      dstPath: "dst/hello.txt",
      timeout: "30s",
    });
    expect(argv).toEqual([
      "rclone",
      "copyto",
      "src:src/hello.txt",
      "dst:dst/hello.txt",
      "--config",
      "/tmp/rclone.conf",
      "--timeout",
      "30s",
    ]);
  });

  test("copyto with S3 bucket: src:bucket/prefix/key", () => {
    // Regression for the rclone-mis-bucket bug: the argv must include the
    // bucket between the remote name and the key, not as part of the key.
    const argv = buildRcloneArgv({
      operation: "copyto",
      configPath: "/tmp/rclone.conf",
      srcRemote: "src",
      srcPath: "cold-bucket/docs/hello.txt",
      dstRemote: "dst",
      dstPath: "cold-bucket/dst/hello.txt",
      timeout: "30s",
    });
    expect(argv).toContain("src:cold-bucket/docs/hello.txt");
    expect(argv).toContain("dst:cold-bucket/dst/hello.txt");
  });

  test("moveto: same single remote on both sides", () => {
    const argv = buildRcloneArgv({
      operation: "moveto",
      configPath: "/tmp/rclone.conf",
      srcRemote: "src",
      srcPath: "cold-bucket/a.txt",
      dstRemote: "src",
      dstPath: "cold-bucket/b.txt",
    });
    expect(argv).toContain("src:cold-bucket/a.txt");
    expect(argv).toContain("src:cold-bucket/b.txt");
  });

  test("mkdir: single remote:path, no dst", () => {
    const argv = buildRcloneArgv({
      operation: "mkdir",
      configPath: "/tmp/rclone.conf",
      srcRemote: "src",
      srcPath: "cold-bucket/dir",
    });
    expect(argv).toEqual([
      "rclone",
      "mkdir",
      "src:cold-bucket/dir",
      "--config",
      "/tmp/rclone.conf",
    ]);
  });

  test("delete with --rmdirs when requested", () => {
    const argv = buildRcloneArgv({
      operation: "delete",
      configPath: "/tmp/rclone.conf",
      srcRemote: "src",
      srcPath: "cold-bucket/dir",
      rmdirs: true,
    });
    expect(argv).toContain("src:cold-bucket/dir");
    expect(argv).toContain("--rmdirs");
  });
});

describe("isContainedLocalMove", () => {
  test("rejects dst == src/name", () => {
    expect(isContainedLocalMove("a", "b", "a/b")).toBe(true);
  });

  test("rejects dst nested under src/name", () => {
    expect(isContainedLocalMove("a", "b", "a/b/c")).toBe(true);
  });

  test("rejects dst == src (same dir; rclone would no-op then rmSync)", () => {
    // Regression for P1-2: src.path === dst.path was previously the
    // missed case — rclone copies src/name to src/name (no-op), then
    // deleteSource rmSyncs the same path.
    expect(isContainedLocalMove("a", "b", "a")).toBe(true);
  });

  test("accepts a different sibling path", () => {
    expect(isContainedLocalMove("a", "b", "c/d")).toBe(false);
  });
});

describe("isSafeS3IntraFolderMove", () => {
  test("rejects same-prefix intra-folder move", () => {
    expect(isSafeS3IntraFolderMove("a/b", "a/b")).toBe(false);
  });

  test("rejects dst nested under src prefix", () => {
    expect(isSafeS3IntraFolderMove("a", "a/b")).toBe(false);
  });

  test("accepts a sibling prefix", () => {
    expect(isSafeS3IntraFolderMove("a", "b")).toBe(true);
  });
});