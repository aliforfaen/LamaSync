/**
 * Regression tests for LAMA-173 review follow-ups:
 *
 *   - P2: socket-client wrappers used to ignore `ctx.socketPath` and
 *     instead defer to the env-fallback inside `connectSocket()`. In
 *     non-default socket deployments the adoption falsely reported
 *     "adopted" after a swallowed socket error.
 *
 *   - P1: GhView.adoptRepo's nested catch around requestSyncOne used to
 *     swallow transport errors and then fall through to the "adopted"
 *     success status — users got a false positive when sync never
 *     triggered.
 *
 * Fix: wrappers accept an optional `socketPath` parameter that is
 * forwarded to `connectSocket()`; adoptRepo distinguishes sync-failure
 * from adopt-failure via early return.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOCKET_CLIENT_PATH = join(HERE, "socket-client.ts");
const GH_VIEW_PATH = join(HERE, "views", "gh-selector.ts");

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

describe("GhView.adoptRepo surfaces sync failure (LAMA-173 P1)", () => {
  test("inner catch around requestSyncOne reports and returns before success path", () => {
    const src = readFileSync(GH_VIEW_PATH, "utf8");
    const adoptIdx = src.indexOf("private async adoptRepo(");
    expect(adoptIdx).toBeGreaterThan(-1);
    const adoptEnd = src.indexOf("\n  }\n", adoptIdx);
    expect(adoptEnd).toBeGreaterThan(adoptIdx);
    const body = src.slice(adoptIdx, adoptEnd);

    expect(body).toContain("await requestSyncOne(folder.id, ctx.socketPath)");
    expect(body).toContain("initial sync failed");
    expect(body.indexOf("initial sync failed")).toBeLessThan(
      body.lastIndexOf("return;"),
    );
  });
});
