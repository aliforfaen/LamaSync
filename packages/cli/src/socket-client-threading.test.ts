/**
 * Regression tests for the LAMA-173 review follow-up:
 *
 *   socket-client wrappers used to ignore `ctx.socketPath` and instead
 *   defer to the env-fallback inside `connectSocket()`. In non-default
 *   socket deployments the adoption falsely reported "adopted" after a
 *   swallowed socket error.
 *
 * Fix: wrappers accept an optional `socketPath` parameter that is
 * forwarded to `connectSocket()`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOCKET_CLIENT_PATH = join(HERE, "socket-client.ts");

describe("socket-client wrappers thread socketPath (LAMA-173 P2)", () => {
  test("all four wrappers accept a socketPath parameter", () => {
    const src = readFileSync(SOCKET_CLIENT_PATH, "utf8");
    const re = (name: string) =>
      new RegExp(
        `export async function ${name}\\([\\s\\S]*?socketPath\\?:\\s*string[\\s\\S]*?\\)`,
      );
    expect(re("requestSyncOne").test(src)).toBe(true);
    expect(re("requestSyncAll").test(src)).toBe(true);
    expect(re("requestSwitchMount").test(src)).toBe(true);
    expect(re("requestSwitchSync").test(src)).toBe(true);
  });

  test("every wrapper internally forwards socketPath to connectSocket", () => {
    const src = readFileSync(SOCKET_CLIENT_PATH, "utf8");
    expect(src).toContain("connectSocket(socketPath)");
    expect(src).not.toMatch(/connectSocket\(\s*\)/);
  });
});
