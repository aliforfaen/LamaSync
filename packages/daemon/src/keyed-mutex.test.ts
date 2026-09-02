// LAMA-308: in-process per-folder run serialization. Concurrent runs for the
// same folder (manual + schedule + watch trigger_sync actions) must execute
// one after another, not concurrently.

import { describe, expect, test } from "bun:test";
import { KeyedMutex } from "./keyed-mutex.ts";

describe("KeyedMutex (LAMA-308)", () => {
  test("serializes concurrent runs for the same key (at most one active)", async () => {
    const mutex = new KeyedMutex();
    let active = 0;
    let maxActive = 0;
    const run = async (tag: string): Promise<void> => {
      await mutex.run("f1", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(5);
        active -= 1;
      });
    };
    await Promise.all([run("a"), run("b"), run("c")]);
    expect(maxActive).toBe(1);
  });

  test("later callers wait for the first to finish before starting", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const releases: (() => void)[] = [];
    const run1 = mutex.run("f1", async () => {
      events.push("start1");
      await new Promise<void>((resolve) => releases.push(resolve));
      events.push("end1");
    });
    const run2 = mutex.run("f1", async () => {
      events.push("start2");
      await new Promise<void>((resolve) => releases.push(resolve));
      events.push("end2");
    });

    // Both queued, only the first may run.
    await Bun.sleep(5);
    expect(events).toEqual(["start1"]);

    releases[0]!();
    await Bun.sleep(5);
    expect(events).toEqual(["start1", "end1", "start2"]);

    releases[1]!();
    await Promise.all([run1, run2]);
    expect(events).toEqual(["start1", "end1", "start2", "end2"]);
  });

  test("different keys do not block each other", async () => {
    const mutex = new KeyedMutex();
    let active = 0;
    let maxActive = 0;
    const run = async (key: string): Promise<void> => {
      await mutex.run(key, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(5);
        active -= 1;
      });
    };
    await Promise.all([run("f1"), run("f2")]);
    expect(maxActive).toBe(2);
  });

  test("a failing run does not poison the queue for later callers", async () => {
    const mutex = new KeyedMutex();
    const throws = mutex.run("f1", async () => {
      throw new Error("boom");
    });
    await expect(throws).rejects.toThrow("boom");
    await expect(mutex.run("f1", async () => "ok")).resolves.toBe("ok");
  });
});
