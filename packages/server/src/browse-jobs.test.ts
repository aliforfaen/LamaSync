// LAMA-247 #4: bounded stdout reader — oversized downloads must fail
// mid-stream without materializing the whole object in memory, and under-cap
// streams must concatenate exactly.

import { describe, expect, test } from "bun:test";

import { BrowseDownloadTooLarge, readStdoutBounded } from "./browse-jobs.ts";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

const MB = 1024 * 1024;

describe("readStdoutBounded", () => {
  test("concatenates an under-cap stream exactly", async () => {
    const chunk = new Uint8Array([1, 2, 3, 4, 5]);
    const out = await readStdoutBounded(
      streamOf([chunk, chunk, chunk]),
      64 * MB,
    );
    expect(out.length).toBe(15);
    expect([...out]).toEqual([1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5]);
  });

  test("fails fast when a chunk crosses the cap (mid-stream reject)", async () => {
    // 2 MiB of data with a 1 MiB cap: the second chunk trips the guard.
    const big = new Uint8Array(MB);
    // Track how much the reader actually consumed: it must reject on the
    // chunk that crosses the cap, not after reading everything.
    let errors = 0;
    try {
      await readStdoutBounded(streamOf([big, big]), MB);
    } catch (err) {
      errors++;
      expect(err).toBeInstanceOf(BrowseDownloadTooLarge);
      expect((err as BrowseDownloadTooLarge).message).toContain("64 MiB");
    }
    expect(errors).toBe(1);
  });

  test("exact-cap stream succeeds unchanged", async () => {
    const big = new Uint8Array(MB);
    const out = await readStdoutBounded(streamOf([big, big]), 2 * MB);
    expect(out.length).toBe(2 * MB);
  });

  test("no cap means no rejection", async () => {
    const out = await readStdoutBounded(streamOf([new Uint8Array(9)]), undefined);
    expect(out.length).toBe(9);
  });
});