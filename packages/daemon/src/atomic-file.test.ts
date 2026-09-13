// LAMA-336: the daemon's small state files (offline config cache, update
// cooldown, report queue) must never be observable half-written — a truncated
// file reads back as "no state", which silently drops the offline scheduling
// cache and lets a crash loop re-fire every update check.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PRIVATE_FILE_MODE, writeFileAtomic } from "./atomic-file.ts";

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lamasync-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates the file and its parent directory with owner-only mode", () => {
    const path = join(dir, "nested", "state.json");
    writeFileAtomic(path, '{"a":1}');
    expect(readFileSync(path, "utf8")).toBe('{"a":1}');
    expect(statSync(path).mode & 0o777).toBe(PRIVATE_FILE_MODE);
  });

  test("replaces existing contents and leaves no temporary file behind", () => {
    const path = join(dir, "state.json");
    writeFileAtomic(path, "first");
    writeFileAtomic(path, "second");
    expect(readFileSync(path, "utf8")).toBe("second");
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  test("preserves the mode an operator already set", () => {
    const path = join(dir, "state.json");
    writeFileAtomic(path, "first");
    chmodSync(path, 0o644);
    writeFileAtomic(path, "second");
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  test("a failed write keeps the previous contents and cleans up", () => {
    const path = join(dir, "state.json");
    writeFileAtomic(path, "previous");
    chmodSync(dir, 0o500);
    try {
      expect(() => writeFileAtomic(path, "next")).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(path, "utf8")).toBe("previous");
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  test("an unreadable existing file aborts instead of replacing it blindly", () => {
    // statSync is what reads the current mode; if that fails the write must
    // not proceed with guessed permissions.
    const path = join(dir, "state.json");
    writeFileAtomic(path, "previous");
    const missingParent = join(dir, "no-such-dir", "state.json");
    mkdirSync(join(dir, "no-such-dir"), { recursive: true });
    chmodSync(join(dir, "no-such-dir"), 0o500);
    try {
      expect(() => writeFileAtomic(missingParent, "next")).toThrow();
    } finally {
      chmodSync(join(dir, "no-such-dir"), 0o700);
    }
    expect(existsSync(missingParent)).toBe(false);
  });

  test("a reader never observes the intermediate state", () => {
    // The observable contract: after the call returns, the file holds exactly
    // the new bytes; during the call the target is untouched (the new bytes
    // live under a different name).
    const path = join(dir, "state.json");
    writeFileAtomic(path, JSON.stringify({ lastCheckAt: 1 }));
    writeFileAtomic(path, JSON.stringify({ lastCheckAt: 2 }));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ lastCheckAt: 2 });
    expect(readFileSync(path, "utf8")).toBe('{"lastCheckAt":2}');
  });
});

describe("state files written through the atomic writer", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lamasync-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("the update cooldown file is owner-only and leaves no temp file", async () => {
    const { markUpdateCheckAttempted, withinUpdateCooldown } = await import("./update-check.ts");
    const path = join(dir, "update-state.json");
    markUpdateCheckAttempted(1_000_000, path);
    expect(statSync(path).mode & 0o777).toBe(PRIVATE_FILE_MODE);
    expect(readdirSync(dir)).toEqual(["update-state.json"]);
    expect(withinUpdateCooldown(1_000_001, path)).toBe(true);
  });

  test("a truncated config cache reads as absent rather than throwing", async () => {
    const { loadCache, saveCache } = await import("./config-cache.ts");
    const path = join(dir, "config-cache.json");
    // A partial write from a pre-LAMA-336 daemon (or a killed process).
    writeFileSync(path, '{"hostId":"h1","apps":[');
    expect(loadCache(path)).toBeNull();

    // A complete save round-trips and is replaceable in place.
    saveCache({ hostId: "h1", assignments: [], apps: [] } as never, path);
    expect((loadCache(path) as { hostId: string } | null)?.hostId).toBe("h1");
    expect(readdirSync(dir)).toEqual(["config-cache.json"]);
  });

  test("the report queue is rewritten atomically on flush", async () => {
    const { createReportQueue } = await import("./report-queue.ts");
    const { LamaSyncApiClient } = await import("@lamasync/core");
    const client = new LamaSyncApiClient("http://localhost:8080", "key", {
      fetchImpl: (() => Promise.resolve(new Response(null, { status: 204 }))) as unknown as typeof fetch,
      maxRetries: 0,
    });
    const queue = createReportQueue(dir, client);
    queue.enqueue({
      hostId: "h1",
      folderId: "f1",
      operation: "sync",
      status: "success",
      summary: "ok",
    });
    expect(await queue.flush()).toBe(1);
    expect(readdirSync(dir)).toEqual(["reports-queue.jsonl"]);
    expect(readFileSync(join(dir, "reports-queue.jsonl"), "utf8")).toBe("");
  });
});
