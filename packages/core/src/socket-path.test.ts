// LAMA-218: the shared default-socket-path helper is the single source of
// truth for both the daemon and the TUI. Cover every branch here so a
// regression in either consumer is caught centrally.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultSocketDir, defaultSocketPath } from "./socket-path.ts";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Reset every input we touch.
  delete process.env.LAMASYNC_SOCKET_PATH;
  delete process.env.XDG_RUNTIME_DIR;
});

afterEach(() => {
  // Restore the original env so other tests aren't affected.
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

describe("defaultSocketPath", () => {
  test("override argument wins over everything", () => {
    process.env.LAMASYNC_SOCKET_PATH = "/env/sock";
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    expect(defaultSocketPath("/explicit/sock")).toBe("/explicit/sock");
  });

  test("env var wins over XDG / HOME fallback", () => {
    process.env.LAMASYNC_SOCKET_PATH = "/env/sock";
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    expect(defaultSocketPath()).toBe("/env/sock");
  });

  test("XDG_RUNTIME_DIR is preferred when no env override", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    expect(defaultSocketPath()).toBe("/run/user/1000/lamasync.sock");
  });

  test("falls back to ~/.lamasync/lamasync.sock when XDG is unset", () => {
    // Reproduces the "root container" path: no XDG_RUNTIME_DIR, no
    // LAMASYNC_SOCKET_PATH, $HOME=/root → /root/.lamasync/lamasync.sock.
    process.env.HOME = "/root";
    expect(defaultSocketPath()).toBe("/root/.lamasync/lamasync.sock");
  });

  test("empty override is treated as unset", () => {
    expect(defaultSocketPath("")).not.toBe("");
  });

  test("null override is treated as unset", () => {
    expect(defaultSocketPath(null)).not.toBe("");
  });
});

describe("defaultSocketDir", () => {
  test("returns XDG_RUNTIME_DIR when set", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    expect(defaultSocketDir()).toBe("/run/user/1000");
  });

  test("returns ~/.lamasync when XDG is unset", () => {
    process.env.HOME = "/root";
    expect(defaultSocketDir()).toBe("/root/.lamasync");
  });
});