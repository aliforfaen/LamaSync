// LAMA-247 #12: rclone `--use-json-log` stats accumulation. Modern rclone
// (>= 1.63) writes the JSON log to stderr; older writers used stdout — the
// accumulator must reflect a non-trivial transfer from EITHER stream, or
// summaries regress to the "0 transfers, 0 B" misreport.

import { describe, expect, test } from "bun:test";

import { accumulateRcloneJsonLog, type RcloneLogStats } from "./executor.ts";

function fresh(): RcloneLogStats {
  return {
    files: 0,
    bytes: 0,
    errors: 0,
    checks: 0,
    transfers: 0,
    wouldCopy: [],
    wouldDelete: [],
    wouldMkdir: [],
  };
}

/** Real rclone v1.68.2 copy output (stderr stream) — captured 2026-08-23. */
const REAL_STDERR_SAMPLE = [
  '{"level":"info","msg":"Copied (new)","object":"a.txt","source":"operations/operations.go:251","time":"2026-08-23T15:14:00.000000+02:00"}',
  '{"level":"info","msg":"Copied (new)","object":"big.bin","source":"operations/operations.go:251","time":"2026-08-23T15:14:00.000000+02:00"}',
  '{"level":"info","msg":"\\nTransferred:   \\t          0 B / 0 B, -, 0 B/s, ETA -\\nChecks:                 2 / 2, 100%\\nElapsed time:         0.0s\\n\\n","source":"accounting/stats.go:528","stats":{"bytes":8198,"checks":2,"deletedDirs":0,"deletes":0,"elapsedTime":0.05,"errors":0,"eta":null,"fatalError":false,"renames":0,"retryError":false,"serverSideCopies":0,"serverSideCopyBytes":0,"serverSideMoveBytes":0,"serverSideMoves":0,"speed":0,"totalBytes":8198,"totalChecks":2,"totalTransfers":2,"transferTime":0.01,"transfers":2},"time":"2026-08-23T15:14:00.000000+02:00"}',
].join("\n");

/**
 * Real rclone v1.68.2 `--dry-run` output (stderr, JSON log) — captured
 * 2026-09-19 from `rclone bisync --resync --dry-run` and a plain dry-run
 * bisync. This is the exact shape the release-blocking cachy incident ran
 * against: rclone tags each suppressed operation with a machine-readable
 * `skipped` field and does NOT emit any "Would copy" sentence. Matching only
 * the sentence made every plan report "0 changes".
 */
const REAL_DRY_RUN_SAMPLE = [
  '{"level":"warning","msg":"Skipped copy as --dry-run is set (size 17)","object":"f2.txt","objectType":"*local.Object","size":17,"skipped":"copy","source":"operations/operations.go:2570","time":"2026-09-19T21:20:28.697808+02:00"}',
  '{"level":"warning","msg":"Skipped copy as --dry-run is set (size 17)","object":"f4.txt","objectType":"*local.Object","size":17,"skipped":"copy","source":"operations/operations.go:2570","time":"2026-09-19T21:20:28.697858+02:00"}',
  '{"level":"warning","msg":"Skipped delete as --dry-run is set (size 2)","object":"a.txt","skipped":"delete","source":"operations/operations.go:2570","time":"2026-09-19T21:20:28.697900+02:00"}',
  '{"level":"warning","msg":"Skipped make directory as --dry-run is set","object":"Local file system at /tmp/x/local/created","skipped":"make directory","source":"operations/operations.go:2570","time":"2026-09-19T21:20:28.697950+02:00"}',
  '{"level":"warning","msg":"Skipped set directory modification time as --dry-run is set","object":"emptydir","skipped":"set directory modification time","source":"sync/sync.go:1234","time":"2026-09-19T21:20:28.698000+02:00"}',
  '{"level":"warning","msg":"\\nTransferred:   \\t         34 B / 34 B, 100%, 0 B/s, ETA -\\nDeleted:                1 (files), 0 (dirs), 2 B (freed)\\nTransferred:            2 / 2, 100%\\nElapsed time:         0.0s\\n\\n","source":"accounting/stats.go:528","stats":{"bytes":34,"checks":12,"deletedDirs":0,"deletes":1,"errors":0,"fatalError":false,"renames":0,"retryError":false,"serverSideCopies":0,"serverSideCopyBytes":0,"serverSideMoveBytes":0,"serverSideMoves":0,"speed":0,"totalBytes":34,"totalChecks":12,"totalTransfers":2,"transfers":2},"time":"2026-09-19T21:20:28.698834+02:00"}',
].join("\n");

describe("accumulateRcloneJsonLog (LAMA-247 #12)", () => {
  test("counts transfers/bytes from a real stderr-writer sample", () => {
    const acc = accumulateRcloneJsonLog(REAL_STDERR_SAMPLE, fresh());
    expect(acc.transfers).toBe(2);
    expect(acc.bytes).toBe(8198);
    expect(acc.errors).toBe(0);
    expect(acc.files).toBe(2); // two "Copied (new)" lines
  });

  test("old stdout-writer samples still accumulate", () => {
    const acc = accumulateRcloneJsonLog(REAL_STDERR_SAMPLE, fresh());
    expect(acc.transfers).toBe(2);
  });

  test("dry-run would-* candidates accumulate", () => {
    const sample = [
      '{"msg":"Would copy","object":"a.txt","level":"info"}',
      '{"msg":"Would delete","object":"stale.txt","level":"info"}',
      '{"msg":"Would make directory","object":"sub","level":"info"}',
      '{"msg":"Some other message","object":"ignored","level":"info"}',
    ].join("\n");
    const acc = accumulateRcloneJsonLog(sample, fresh());
    expect(acc.wouldCopy).toEqual(["a.txt"]);
    expect(acc.wouldDelete).toEqual(["stale.txt"]);
    expect(acc.wouldMkdir).toEqual(["sub"]);
    expect(acc.bytes).toBe(0);
  });

  // The release-blocking regression: modern rclone reports a suppressed
  // operation through the machine-readable `skipped` field, not a "Would copy"
  // sentence. Reading only the sentence made every planned dry run report
  // "0 changes" while the real run copied the tree (cachy: plan 0 → 349
  // transfers / 803 MB).
  test("REAL v1.68.2 dry-run output is parsed via the `skipped` field", () => {
    const acc = accumulateRcloneJsonLog(REAL_DRY_RUN_SAMPLE, fresh());
    expect(acc.wouldCopy).toEqual(["f2.txt", "f4.txt"]);
    expect(acc.wouldDelete).toEqual(["a.txt"]);
    expect(acc.wouldMkdir).toEqual(["Local file system at /tmp/x/local/created"]);
    // The stats block is the true total the plan reports as bytes/files.
    expect(acc.transfers).toBe(2);
    expect(acc.bytes).toBe(34);
  });

  test("a dry run that reports only non-content skips stays empty", () => {
    const sample = [
      '{"msg":"Skipped set directory modification time as --dry-run is set","object":"dir","skipped":"set directory modification time","level":"warning"}',
      '{"msg":"Skipped update modification time as --dry-run is set","object":"dir","skipped":"update modification time","level":"warning"}',
    ].join("\n");
    const acc = accumulateRcloneJsonLog(sample, fresh());
    expect(acc.wouldCopy).toEqual([]);
    expect(acc.wouldDelete).toEqual([]);
    expect(acc.wouldMkdir).toEqual([]);
  });

  test("a `skipped` line is never double-counted by the legacy sentence path", () => {
    const sample = [
      '{"msg":"Skipped copy as --dry-run is set (size 1)","object":"a.txt","skipped":"copy","level":"warning"}',
    ].join("\n");
    const acc = accumulateRcloneJsonLog(sample, fresh());
    expect(acc.wouldCopy).toEqual(["a.txt"]);
  });

  test("the same log fed twice (both streams) does not double-count files", () => {
    // Real-world: modern rclone writes everything to stderr and stdout is
    // empty, so feeding both is idempotent for per-file counters.
    const a = accumulateRcloneJsonLog(REAL_STDERR_SAMPLE, fresh());
    const b = accumulateRcloneJsonLog("", a);
    expect(b.files).toBe(2);
    expect(b.transfers).toBe(2);
  });

  test("ignores non-JSON and malformed lines", () => {
    const acc = accumulateRcloneJsonLog(
      "INFO  : some plain log line\n{not json\n\n",
      fresh(),
    );
    expect(acc.transfers).toBe(0);
    expect(acc.files).toBe(0);
  });
});