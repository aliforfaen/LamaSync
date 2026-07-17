import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LamaSyncApiClient } from "@lamasync/core";
import { createReportQueue } from "./report-queue.ts";

const report1 = {
  hostId: "host-a",
  folderId: "f1",
  operation: "sync" as const,
  status: "success" as const,
  summary: "first",
};

const report2 = {
  hostId: "host-a",
  folderId: "f2",
  operation: "backup" as const,
  status: "failed" as const,
  summary: "second",
};

describe("createReportQueue", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lamasync-report-queue-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("enqueue writes a line and flush sends it", async () => {
    let received: unknown = null;
    const client = new LamaSyncApiClient("http://localhost:8080", "key", {
      fetchImpl: (() => {
        received = report1;
        return Promise.resolve(new Response(null, { status: 204 }));
      }) as unknown as typeof fetch,
      timeoutMs: 5_000,
      maxRetries: 0,
    });
    const queue = createReportQueue(dir, client);

    queue.enqueue(report1);
    const sent = await queue.flush();
    expect(sent).toBe(1);
    expect(received).toEqual(report1);
  });

  test("flush keeps unsent reports and removes sent ones", async () => {
    let calls = 0;
    const client = new LamaSyncApiClient("http://localhost:8080", "key", {
      fetchImpl: (() => {
        calls += 1;
        if (calls === 1) return Promise.resolve(new Response(null, { status: 204 }));
        return Promise.reject(new TypeError("offline"));
      }) as unknown as typeof fetch,
      timeoutMs: 5_000,
      maxRetries: 0,
    });
    const queue = createReportQueue(dir, client);

    queue.enqueue(report1);
    queue.enqueue(report2);
    const sent = await queue.flush();
    expect(sent).toBe(1);

    // Second flush should still have report2 and can succeed once back online.
    calls = 0;
    const sent2 = await queue.flush();
    expect(sent2).toBe(1);
  });

  test("caps the queue at 1000 entries by dropping oldest", () => {
    const client = new LamaSyncApiClient("http://localhost:8080", "key", {
      fetchImpl: (() => Promise.resolve(new Response(null, { status: 204 }))) as unknown as typeof fetch,
      timeoutMs: 5_000,
      maxRetries: 0,
    });
    const queue = createReportQueue(dir, client);

    for (let i = 0; i < 1002; i += 1) {
      queue.enqueue({ ...report1, summary: `r${i}` });
    }

    const text = readFileSync(join(dir, "reports-queue.jsonl"), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(1000);
    expect(lines[0]).toContain('"r2"');
    expect(lines.at(-1)).toContain('"r1001"');
  });
});
