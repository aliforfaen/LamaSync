// Pure tests for friendlyError (WS3 / TUI foundations) — string in,
// string out, no I/O or network.

import { describe, expect, test } from "bun:test";
import { friendlyError } from "./friendly-error.ts";

describe("friendlyError", () => {
  test("API 401 maps to an API-key hint", () => {
    expect(friendlyError(new Error("LamaSync API error 401: Unauthorized"))).toBe(
      "API key rejected — check LAMASYNC_API_KEY or ~/.config/lamasync/client.toml",
    );
    expect(friendlyError("API error 401")).toBe(
      "API key rejected — check LAMASYNC_API_KEY or ~/.config/lamasync/client.toml",
    );
  });

  test("network-y messages map to a server-unreachable hint", () => {
    expect(friendlyError(new Error("fetch failed"))).toBe(
      "server unreachable — is it running? tailnet up?",
    );
    expect(
      friendlyError(new Error("connect ECONNREFUSED 100.64.0.1:8080"), {
        serverUrl: "http://100.64.0.1:8080",
      }),
    ).toBe(
      "server unreachable at http://100.64.0.1:8080 — is it running? tailnet up?",
    );
    expect(friendlyError(new Error("getaddrinfo ENOTFOUND host"))).toBe(
      "server unreachable — is it running? tailnet up?",
    );
  });

  test("daemon socket failures map to a lamasyncd hint", () => {
    expect(
      friendlyError(new Error("connect ENOENT /run/user/1000/lamasync.sock")),
    ).toBe("daemon not running — start lamasyncd (systemctl --user start lamasyncd)");
  });

  test("server-side socket failures do NOT map to the daemon hint", () => {
    // "socket hang up" is node's ECONNRESET surface — a SERVER failure, so
    // advising "start lamasyncd" would be actively wrong.
    expect(friendlyError(new Error("socket hang up"))).toBe(
      "server unreachable — is it running? tailnet up?",
    );
    expect(friendlyError(new Error("WebSocket connection closed"))).toBe(
      "WebSocket connection closed",
    );
  });

  test("rclone / spawn ENOENT maps to an rclone hint", () => {
    expect(friendlyError(new Error("spawn rclone ENOENT"))).toBe(
      "rclone not installed or not on PATH",
    );
  });

  test("anything else passes through trimmed to one line", () => {
    expect(friendlyError(new Error("boom"))).toBe("boom");
    expect(friendlyError("first line\nsecond line")).toBe("first line");
    expect(friendlyError(new Error("unknown error"))).toBe("unknown error");
  });
});
