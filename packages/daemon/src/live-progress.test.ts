// LAMA-327 — daemon live-progress: phase parsing grounded in REAL rclone
// v1.68.2 `--use-json-log` output, bounded streaming tails, and the
// throttled/coalescing non-blocking reporter.

import { afterEach, describe, expect, test } from "bun:test";
import type { LamaSyncApiClient } from "@lamasync/core";
import {
  BoundedTail,
  LineSplitter,
  consumeLines,
  countersFromStats,
  createSyncProgressReporter,
  parseJsonLogLineSignal,
  statsPhase,
  TAIL_CAP,
  type SyncProgressReporter,
} from "./live-progress.ts";

// ---------------------------------------------------------------------------
// Phase parser — real rclone v1.68.2 messages (captured, see LAMA-327)
// ---------------------------------------------------------------------------

/** INFO-level bisync steady-state messages in real emission order. */
const BISYNC_STEADY = [
  '{"level":"info","msg":"Setting --ignore-listing-checksum as neither --checksum nor --compare checksum are set."}',
  '{"level":"info","msg":"Bisyncing with Comparison Settings: \\n{\\n\\t\\"Modtime\\": true,\\n}"}',
  '{"level":"info","msg":"Synching Path1 \\"/tmp/src/\\" with Path2 \\"/tmp/dst/\\""}',
  '{"level":"info","msg":"Building Path1 and Path2 listings"}',
  '{"level":"info","msg":"Path1 checking for diffs"}',
  '{"level":"info","msg":"Path1:    2 changes:    2 new,    0 modified,    0 deleted"}',
  '{"level":"info","msg":"Path2 checking for diffs"}',
  '{"level":"info","msg":"Applying changes"}',
  '{"level":"info","msg":"- Path1    Queue copy to Path2       - /tmp/dst/new.txt"}',
  '{"level":"info","msg":"- Path1    Do queued copies to                - Path2"}',
  '{"level":"info","msg":"Copied (new)","object":"new.txt"}',
  '{"level":"info","msg":"Updating listings"}',
  '{"level":"info","msg":"Validating listings for Path1 \\"/tmp/src/\\" vs Path2 \\"/tmp/dst/\\""}',
  '{"level":"info","msg":"\\u001b[32mBisync successful\\u001b[0m"}',
];

describe("parseJsonLogLineSignal (LAMA-327)", () => {
  test("maps the real bisync steady-state lifecycle end to end", () => {
    const phases = BISYNC_STEADY.map((l) => parseJsonLogLineSignal(l)?.phase).filter(
      (p): p is NonNullable<typeof p> => p !== undefined,
    );
    expect(phases).toEqual([
      "preparing",
      "preparing",
      "enumerating",
      "enumerating",
      "reconciling",
      "reconciling",
      "reconciling",
      "reconciling",
      "transferring",
      "transferring",
      "transferring",
      "finalizing",
      "finalizing",
      "success",
    ]);
  });

  test("maps --resync copy messages to transferring + finalizing", () => {
    const lines = [
      '{"level":"info","msg":"Copying Path2 files to Path1"}',
      '{"level":"info","msg":"- \\u001b[34mPath1\\u001b[0m    \\u001b[35mResync is copying files to\\u001b[0m         - \\u001b[36mPath2\\u001b[0m"}',
      '{"level":"info","msg":"Resync updating listings"}',
      '{"level":"info","msg":"\\u001b[32mBisync successful\\u001b[0m"}',
    ];
    const phases = lines
      .map((l) => parseJsonLogLineSignal(l)?.phase)
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
    expect(phases).toEqual(["transferring", "transferring", "finalizing", "success"]);
  });

  test("per-file copy messages mean transferring with a bounded detail", () => {
    const s = parseJsonLogLineSignal('{"level":"info","msg":"Copied (new)","object":"a.txt"}');
    expect(s?.phase).toBe("transferring");
    expect(s?.detail?.length).toBeLessThanOrEqual(120);
  });

  test("unknown / debug / malformed messages never fabricate a phase", () => {
    expect(parseJsonLogLineSignal('{"level":"debug","msg":"starting to march!"}')).toBeNull();
    expect(parseJsonLogLineSignal('{"level":"debug","msg":"winner: copy to dst: \\n{\\n}"}')).toBeNull();
    expect(parseJsonLogLineSignal("INFO  : plain non-JSON line")).toBeNull();
    expect(parseJsonLogLineSignal("{not json")).toBeNull();
    expect(parseJsonLogLineSignal('{"msg":42}')).toBeNull();
    expect(parseJsonLogLineSignal("")).toBeNull();
  });

  test("detail never contains object paths or credentials — only fixed copy", () => {
    const s = parseJsonLogLineSignal('{"level":"info","msg":"Copied (new)","object":"/secret/creds.env"}');
    expect(s?.detail).toBe("copying files");
    expect(s?.detail?.includes("creds")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Streaming line splitter + bounded tail
// ---------------------------------------------------------------------------

describe("LineSplitter", () => {
  test("splits chunks into complete lines and flushes the final partial", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((l) => lines.push(l));
    splitter.append("a\nb\nc");
    expect(lines).toEqual(["a", "b"]);
    splitter.finish();
    expect(lines).toEqual(["a", "b", "c"]);
  });

  test("a line split across chunks is delivered complete", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((l) => lines.push(l));
    splitter.append('{"msg":"Cop');
    splitter.append('ied (new)"}\n');
    splitter.finish();
    expect(lines).toEqual(['{"msg":"Copied (new)"}']);
  });
});

describe("BoundedTail", () => {
  test("keeps exactly the last TAIL_CAP characters", () => {
    const tail = new BoundedTail();
    const long = "x".repeat(TAIL_CAP + 500);
    tail.append(long);
    expect(tail.tail().length).toBe(TAIL_CAP);
    expect(tail.tail().endsWith("x".repeat(TAIL_CAP))).toBe(true);
  });

  test("returns everything while under the cap", () => {
    const tail = new BoundedTail();
    tail.append("hello\nworld\n");
    expect(tail.tail()).toBe("hello\nworld\n");
  });
});

describe("consumeLines", () => {
  test("streams a ReadableStream and counts lines (UTF-8 across chunks)", async () => {
    const encoder = new TextEncoder();
    const chunkA = encoder.encode('{"level":"info","msg":"Cop');
    const chunkB = encoder.encode('ied (new)"}\n{"level":"info","msg":"Bisync successful"}\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunkA);
        controller.enqueue(chunkB);
        controller.close();
      },
    });
    const lines: string[] = [];
    const count = await consumeLines(stream, (l) => lines.push(l));
    expect(count).toBe(2);
    expect(lines[0]).toBe('{"level":"info","msg":"Copied (new)"}');
  });

  test("does not throw on a torn stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("line1\n"));
        controller.error(new Error("torn pipe"));
      },
    });
    const lines: string[] = [];
    const count = await consumeLines(stream, (l) => lines.push(l));
    expect(Number.isFinite(count)).toBe(true);
    expect(typeof count).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Reporter — throttle, coalesce, terminal, non-blocking
// ---------------------------------------------------------------------------

interface Sent {
  phase: string;
  detail: string | null;
  counters: { transfers: number | null; bytes: number | null };
}

function makeReporter(
  opts: {
    failures?: boolean;
    delayMs?: number;
    minIntervalMs?: number;
    now?: () => number;
  } = {},
): { reporter: SyncProgressReporter; sent: Sent[]; gate: { open(): void } } {
  let gated = false;
  let release: () => void = () => undefined;
  const gatePromise = new Promise<void>((res) => {
    release = res;
  });
  const sent: Sent[] = [];
  const client = {
    async reportSyncProgress(body: {
      phase: string;
      detail?: string | null;
      transfers?: number | null;
      bytes?: number | null;
    }): Promise<void> {
      if (opts.failures === true) throw new Error("network down");
      sent.push({
        phase: body.phase,
        detail: body.detail ?? null,
        counters: {
          transfers: body.transfers ?? null,
          bytes: body.bytes ?? null,
        },
      });
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      if (gated) await gatePromise;
    },
  } as unknown as LamaSyncApiClient;
  const reporter = createSyncProgressReporter({
    client,
    hostId: "host-a",
    hostname: "cachy",
    folderId: "f1",
    folderName: "Projects",
    operation: "sync",
    runId: "run-1",
    startedAt: 1_000,
    minIntervalMs: opts.minIntervalMs ?? 50,
    now: opts.now,
  });
  return {
    reporter,
    sent,
    gate: {
      open: () => {
        gated = false;
        release();
      },
    },
  };
}

describe("createSyncProgressReporter (LAMA-327)", () => {
  afterEach(() => {
    // No module-level state in the reporter; nothing to reset.
  });

  test("sends immediately on the first report and includes identity fields", async () => {
    const { reporter, sent } = makeReporter();
    reporter.report({ phase: "queued", detail: "waiting for lock" });
    await reporter.flush();
    expect(sent.length).toBe(1);
    expect(sent[0]?.phase).toBe("queued");
    expect(sent[0]?.detail).toBe("waiting for lock");
  });

  test("throttles counter-only reports to the min interval (coalesces)", async () => {
    // Fake clock starts large so `lastSentAt === 0` keeps meaning "never
    // sent" (in production the clock is Date.now()).
    let t = 1_000_000;
    const { reporter, sent } = makeReporter({ now: () => t, minIntervalMs: 100 });
    reporter.report({ phase: "enumerating", detail: "listing trees" });
    await reporter.flush();
    expect(sent.length).toBe(1);

    // Rapid burst within the throttle window coalesces into the trailing
    // flush (or the next report after the window) — never one send per line.
    t = 1_000_010;
    reporter.report({ transfers: 0, bytes: 0 });
    t = 1_000_020;
    reporter.report({ transfers: 1, bytes: 100 });
    t = 1_000_030;
    reporter.report({ transfers: 2, bytes: 200 });
    await reporter.flush();
    // flush() forces one trailing send even though the window never elapsed.
    expect(sent.length).toBe(2);
    expect(sent[1]?.counters.transfers).toBe(2);
    expect(sent[1]?.counters.bytes).toBe(200);
  });

  test("phase transitions change phaseStartedAt semantics by sending the new phase", async () => {
    const { reporter, sent } = makeReporter();
    reporter.report({ phase: "lock" });
    reporter.report({ phase: "transferring", transfers: 5 });
    await reporter.flush();
    const phases = sent.map((s) => s.phase);
    expect(phases).toContain("lock");
    expect(phases).toContain("transferring");
  });

  test("finish() sends the terminal phase and ignores later reports", async () => {
    const { reporter, sent } = makeReporter();
    reporter.report({ phase: "transferring", transfers: 4 });
    reporter.finish("success", "sync ok");
    reporter.report({ phase: "working", detail: "late" }); // ignored
    await reporter.flush();
    const last = sent[sent.length - 1];
    expect(last?.phase).toBe("success");
    expect(last?.detail).toBe("sync ok");
    expect(sent.filter((s) => s.phase === "success").length).toBe(1);
  });

  test("a failing client never throws and is dropped after one log", async () => {
    const { reporter } = makeReporter({ failures: true });
    reporter.report({ phase: "queued" });
    await expect(reporter.flush()).resolves.toBeUndefined();
    reporter.finish("failed", "boom");
    await expect(reporter.flush()).resolves.toBeUndefined();
  });

  test("reports arriving during an in-flight send coalesce into one follow-up", async () => {
    const { reporter, sent, gate } = makeReporter({ delayMs: 1 });
    reporter.report({ phase: "queued", detail: "waiting" });
    await Bun.sleep(5); // first send in flight

    // While the first send is still pending, new state arrives — it must be
    // coalesced into a single follow-up with the NEWEST state, not queued
    // per report.
    for (let i = 0; i < 20; i += 1) {
      reporter.report({ phase: "transferring", transfers: i, bytes: i * 10 });
    }
    await reporter.flush();
    expect(sent.length).toBeLessThanOrEqual(3);
    const last = sent[sent.length - 1]!;
    expect(last.phase).toBe("transferring");
    expect(last.counters.transfers).toBe(19);
  });

  test("finish during an in-flight send still delivers the terminal phase", async () => {
    const { reporter, sent, gate } = makeReporter({ delayMs: 1 });
    reporter.report({ phase: "enumerating" });
    await Bun.sleep(5);
    reporter.report({ transfers: 3 });
    reporter.finish("failed", "exit 1");
    await reporter.flush();
    const last = sent[sent.length - 1]!;
    expect(last.phase).toBe("failed");
    expect(last.detail).toBe("exit 1");
    void gate;
  });
});

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

describe("countersFromStats / statsPhase (LAMA-327)", () => {
  test("counters normalize unknown/garbage to null", () => {
    expect(countersFromStats({ transfers: NaN, bytes: -1, checks: 2, errors: 0 })).toEqual({
      transfers: null,
      bytes: null,
      checks: 2,
      errors: 0,
    });
  });

  test("in-flight transfers read as transferring", () => {
    expect(statsPhase({ transfers: 3, checks: 0 })).toBe("transferring");
  });

  test("no transfers but advancing checks reads as checking", () => {
    expect(statsPhase({ transfers: 0, checks: 10 })).toBe("checking");
  });

  test("zero/zero reads as null (stay on the current honest phase)", () => {
    expect(statsPhase({ transfers: 0, checks: 0 })).toBeNull();
  });
});