// TUI tests: exercise the local-view folder description helper. The full
// OpenTUI render path requires a native renderer that is not available in CI,
// and the socket-client wrappers are exercised by the daemon socket test
// suite against the same line-JSON protocol.

import { describe, expect, test } from "bun:test";
import { describeFolder } from "./views/local.ts";
import type { LocalFolder } from "./views/local.ts";

const baseFolder: LocalFolder = {
  id: "id",
  hostId: "host",
  name: "LamaFiles",
  type: "sync",
};

describe("local view folder description", () => {
  test("sync folder shows 'sync — unknown' when status missing", () => {
    expect(describeFolder(baseFolder)).toBe("sync — unknown");
  });

  test("mount folder shows cache profile and size when set", () => {
    const folder: LocalFolder = {
      ...baseFolder,
      type: "mount",
      lastStatus: "success",
      cacheProfile: "media",
      cacheMaxSize: "1G",
    };
    expect(describeFolder(folder)).toBe("mount (cache: media/1G) — success");
  });

  test("mount folder without cache profile omits the cache segment", () => {
    const folder: LocalFolder = {
      ...baseFolder,
      type: "mount",
      lastStatus: "success",
    };
    expect(describeFolder(folder)).toBe("mount — success");
  });

  test("git folder with gh provider shows 'gh:<remote>'", () => {
    const folder: LocalFolder = {
      ...baseFolder,
      type: "git",
      gitProvider: "gh",
      gitRemote: "messhias/lamasync",
      lastStatus: "success",
    };
    expect(describeFolder(folder)).toBe("gh:messhias/lamasync — success");
  });

  test("git folder with git provider (no gh) shows 'git'", () => {
    const folder: LocalFolder = {
      ...baseFolder,
      type: "git",
      gitProvider: "git",
      lastStatus: "success",
    };
    expect(describeFolder(folder)).toBe("git — success");
  });

  test("backup folder shows plain type", () => {
    const folder: LocalFolder = {
      ...baseFolder,
      type: "backup",
      lastStatus: "failed",
    };
    expect(describeFolder(folder)).toBe("backup — failed");
  });
});
