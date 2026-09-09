// LAMA-327 — daemon-side live sync progress.
//
// Three pieces:
//
//  1. `parseRcloneJsonLine` — a PURE parser over real rclone `--use-json-log`
//     lines (grounded in captured rclone v1.68.2 output). It maps only INFO
//     messages rclone actually emits to phases; unknown messages stay honest
//     (no phase change, and keep `working` when nothing has been seen yet).
//     It also surfaces periodic `stats` blocks and per-file transfer messages
//     so counters stay live during long runs.
//
//  2. A bounded streaming line consumer (`StreamTail`) that mirrors the old
//     end-only collection semantics: each stream's full content is fed
//     through the JSON-log accumulator exactly once (so stats stay intact)
//     while keeping only the bounded terminal tail in memory.
//
//  3. `createSyncProgressReporter` — a throttled, coalescing, non-blocking
//     reporter. Progress reporting can NEVER stall or fail an rclone run:
//     at most one HTTP send is in flight, the latest state is coalesced, and
//     failures are dropped after one log line.

import type {
  LiveSyncPhase,
  LiveSyncProgressUpdate,
  LamaSyncApiClient,
} from "@lamasync/core";

// ---------------------------------------------------------------------------
// Phase parsing (pure, fixture-tested)
// ---------------------------------------------------------------------------

/**
 * One recognised signal from an rclone JSON-log line.
 * `phase` is set only when the line is an actual rclone phase boundary.
 * `detail` carries a bounded, safe one-line description when useful.
 */
export interface RcloneLineSignal {
  /** Phase transition to apply, when the message is a real phase boundary. */
  phase?: LiveSyncPhase;
  /** Safe one-line detail (rclone's own msg text, ANSI-stripped, bounded). */
  detail?: string;
}

/**
 * Map rclone INFO `msg` values to phases. Grounded in real v1.68.2 output:
 *
 *   bisync steady state:  "Setting --ignore-listing-checksum ..." →
 *                         "Bisyncing with Comparison Settings" →
 *                         "Synching Path1 ... with Path2 ..." →
 *                         "Building Path1 and Path2 listings" →
 *                         "Path1/Path2 checking for diffs" →
 *                         "Applying changes" →
 *                         "Queue copy ..." / "Do queued copies to ..." →
 *                         "Updating listings" / "Validating listings ..." →
 *                         "Bisync successful"
 *   bisync --resync:      "Copying Path2 files to Path1" /
 *                         "- PathN Resync is copying files to - PathM" →
 *                         "Resync updating listings"
 *   one-way copy:         no phase INFO messages before the first transfer —
 *                         the daemon reports honest generic `working` until a
 *                         per-file/stats signal arrives.
 *
 * Precedence is by insertion order (first match wins); the trailing entries
 * are the transfer per-file messages mirrored by the existing accumulator.
 */
const PHASE_RULES: ReadonlyArray<{ match: string; phase: LiveSyncPhase; detail: string }> = [
  {
    match: "Setting --ignore-listing-checksum",
    phase: "preparing",
    detail: "building bisync comparison settings",
  },
  { match: "Bisyncing with Comparison Settings", phase: "preparing", detail: "computing bisync comparison settings" },
  { match: "Building Path1 and Path2 listings", phase: "enumerating", detail: "building listings for both paths" },
  { match: "Synching Path1", phase: "enumerating", detail: "listing local and remote trees" },
  { match: "Resync is in progress", phase: "enumerating", detail: "resync — building listings" },
  { match: "Path1 checking for diffs", phase: "reconciling", detail: "comparing local listings" },
  { match: "Path2 checking for diffs", phase: "reconciling", detail: "comparing remote listings" },
  { match: "changes:", phase: "reconciling", detail: "comparing changes" },
  { match: "Applying changes", phase: "reconciling", detail: "building the change plan" },
  { match: "Reconciling", phase: "reconciling", detail: "reconciling listings" },
  { match: "Matching", phase: "reconciling", detail: "matching listings" },
  { match: "Do queued copies to", phase: "transferring", detail: "executing queued copies" },
  { match: "Resync is copying files to", phase: "transferring", detail: "resync copy in progress" },
  { match: "Copying Path1 files to Path2", phase: "transferring", detail: "copying path1 files to path2" },
  { match: "Copying Path2 files to Path1", phase: "transferring", detail: "copying path2 files to path1" },
  { match: "Updating listings", phase: "finalizing", detail: "updating listings" },
  { match: "Resync updating listings", phase: "finalizing", detail: "updating resync listings" },
  { match: "Validating listings", phase: "finalizing", detail: "validating listings" },
  { match: "Bisync successful", phase: "success", detail: "bisync successful" },
];

/** Per-file / per-item transfer messages — the phase becomes transferring
 *  and the detail mirrors rclone's own wording. */
const TRANSFER_MESSAGES: ReadonlyArray<{ match: string; detail: string }> = [
  { match: "Copied (server-side copy)", detail: "server-side copy" },
  { match: "Copied (new)", detail: "copying files" },
  { match: "Deleted", detail: "deleting files" },
  { match: "Renamed", detail: "renaming files" },
  { match: "Moved", detail: "moving files" },
  { match: "Would copy", detail: "dry-run: would copy" },
  { match: "Would delete", detail: "dry-run: would delete" },
  { match: "Would make directory", detail: "dry-run: would make directory" },
  { match: "Queue copy", detail: "queued copy" },
];

const ANSI_RE = /\u001b\[[0-9;]*m/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasUnref(value: unknown): value is { unref: () => void } {
  return isRecord(value) && typeof value.unref === "function";
}

function sanitiseDetail(raw: string): string {
  const stripped = raw.replace(ANSI_RE, "").replace(/\s+/g, " ").trim();
  return stripped.length <= 120 ? stripped : `${stripped.slice(0, 120)}…`;
}

/**
 * Parse a single rclone JSON-log line into a phase signal. Lines that are
 * not JSON, or whose `msg` matches no real phase boundary, return null —
 * the caller keeps the current phase (honest: unknown messages never
 * fabricate progress). Per-file transfer messages map to `transferring`
 * with a bounded detail.
 */
export function parseJsonLogLineSignal(line: string): RcloneLineSignal | null {
  if (!line.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const obj = parsed;
  const msg = obj.msg;
  if (typeof msg !== "string" || msg.length === 0) return null;
  const level = obj.level;
  // Only INFO-level messages are phase boundaries; DEBUG noise (e.g. the
  // resync "result:" flood) is ignored so phases don't thrash.
  if (level !== undefined && level !== "info" && level !== "warning") return null;
  const haystack = msg.replace(ANSI_RE, "");

  for (const rule of PHASE_RULES) {
    if (haystack.includes(rule.match)) {
      return { phase: rule.phase, detail: rule.detail };
    }
  }
  for (const rule of TRANSFER_MESSAGES) {
    if (msg.includes(rule.match)) {
      return { phase: "transferring", detail: rule.detail };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Streaming line splitter + bounded raw tail
// ---------------------------------------------------------------------------

export const TAIL_CAP = 2000;

/**
 * Line splitter over decoded text chunks. `append` returns the complete
 * lines finished by this chunk (delivered to `onLine` too); `finish` must
 * be called once at end-of-stream to flush the trailing partial line. The
 * pending partial buffer is deliberately NOT capped so a single long JSON
 * line (e.g. the "Bisyncing with Comparison Settings" blob) parses exactly
 * like the old end-only collection did.
 */
export class LineSplitter {
  private pending = "";
  constructor(private readonly onLine?: (line: string) => void) {}

  append(chunk: string): string[] {
    this.pending += chunk;
    const out: string[] = [];
    let nl = this.pending.indexOf("\n");
    while (nl !== -1) {
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      out.push(line);
      this.onLine?.(line);
      nl = this.pending.indexOf("\n");
    }
    return out;
  }

  finish(): void {
    if (this.pending.length > 0) {
      this.onLine?.(this.pending);
      this.pending = "";
    }
  }
}

/**
 * Bounded raw-text tail — keeps only the last `cap` characters, exactly
 * mirroring the previous `tail(fullText, 2000)` for `stdoutTail` /
 * `stderrTail` without holding the whole stream in memory.
 */
export class BoundedTail {
  private buffer = "";
  constructor(private readonly cap: number = TAIL_CAP) {}

  append(text: string): void {
    this.buffer += text;
    if (this.buffer.length > this.cap) {
      this.buffer = this.buffer.slice(this.buffer.length - this.cap);
    }
  }

  tail(): string {
    return this.buffer;
  }
}

/**
 * Consume a Bun/Web ReadableStream line-by-line. `onLine` receives every
 * complete line (without the trailing newline); a final partial line is
 * delivered via `finish`. Decoding handles multi-byte UTF-8 split across
 * chunks. Never throws on stream errors — returns the number of lines.
 */
export async function consumeLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<number> {
  const decoder = new TextDecoder();
  const splitter = new LineSplitter(onLine);
  let count = 0;
  try {
    for await (const chunk of stream) {
      count += splitter.append(decoder.decode(chunk, { stream: true })).length;
    }
    count += splitter.append(decoder.decode()).length;
  } catch {
    // A dying child can tear the pipe mid-read; the bounded tails and
    // accumulator already contain everything parsed so far.
  }
  splitter.finish();
  return count;
}

// ---------------------------------------------------------------------------
// Reporter (throttled, coalescing, non-blocking)
// ---------------------------------------------------------------------------

export interface LiveProgressState {
  /** Phase transition to apply; omitted keeps the current phase. */
  phase?: LiveSyncPhase;
  detail?: string | null;
  transfers?: number | null;
  bytes?: number | null;
  checks?: number | null;
  errors?: number | null;
  files?: number | null;
}

export interface SyncProgressReporter {
  /** Coalesce a new state observation; the latest state wins. Never throws. */
  report(state: LiveProgressState): void;
  /** Terminate the run with the given detail and stop throttling. */
  finish(phase: "success" | "failed", detail?: string | null): void;
  /** Force-send the pending state (test seam); resolves after the send. */
  flush(): Promise<void>;
  /** The run id this reporter belongs to. */
  readonly runId: string;
}

export interface SyncProgressReporterOptions {
  client: LamaSyncApiClient;
  hostId: string;
  /** Display label — the host's last known hostname. */
  hostname: string | null | undefined;
  folderId: string | null | undefined;
  folderName: string | null | undefined;
  operation: string;
  runId: string;
  startedAt: number;
  /** Minimum wall-clock gap between HTTP sends. Default 2s. */
  minIntervalMs?: number;
  /** Test seam: injectable clock. */
  now?: () => number;
}

const DEFAULT_MIN_INTERVAL_MS = 2_000;

/**
 * Throttled, coalescing, non-blocking reporter. At most one HTTP send is in
 * flight; the latest state always wins; a trailing timer flushes a dirty
 * state even when signals go quiet; terminal `finish()` cancels throttling
 * and forces the final send. Failures log once and are otherwise silent —
 * progress reporting must never block or fail an rclone run.
 */
export function createSyncProgressReporter(
  opts: SyncProgressReporterOptions,
): SyncProgressReporter {
  const client = opts.client;
  const nowFn = opts.now ?? (() => Date.now());
  const startedAt = opts.startedAt;
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  let phase: LiveSyncPhase = "queued";
  let detail: string | null | undefined = null;
  let counters: Pick<
    LiveSyncProgressUpdate,
    "transfers" | "bytes" | "checks" | "errors" | "files"
  > = { transfers: null, bytes: null, checks: null, errors: null, files: null };
  let phaseStartedAt = startedAt;
  let lastSentAt = 0;
  let sending: Promise<void> | null = null;
  let dirty = false;
  let terminalPhase: "success" | "failed" | null = null;
  let failedOnce = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const body = (forcePhase?: "success" | "failed"): LiveSyncProgressUpdate => {
    const p = forcePhase ?? phase;
    return {
      runId: opts.runId,
      hostId: opts.hostId,
      hostname: opts.hostname ?? null,
      folderId: opts.folderId ?? null,
      folderName: opts.folderName ?? null,
      operation: opts.operation,
      phase: p,
      startedAt,
      phaseStartedAt,
      ...counters,
      detail: detail ?? null,
    };
  };

  const send = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    let pendingBody: LiveSyncProgressUpdate | null = null;
    try {
      dirty = false;
      pendingBody = body(terminalPhase ?? undefined);
      await client.reportSyncProgress(pendingBody);
      lastSentAt = nowFn();
    } catch (err) {
      if (!failedOnce) {
        failedOnce = true;
        console.error(
          `[live-progress] report failed (suppressing further errors): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      sending = null;
      // A report arrived while this send was in flight — coalesce into one
      // follow-up so the server sees the newest state without queue growth.
      if (dirty && terminalPhase === null) {
        void send();
      } else if (dirty && terminalPhase !== null) {
        void send();
      }
    }
  };

  /** Ensure a dirty state reaches the server even if signals go quiet. */
  const scheduleFlush = (): void => {
    if (timer !== null || sending !== null || terminalPhase !== null) return;
    const delay = Math.max(0, minIntervalMs - (nowFn() - lastSentAt));
    timer = setTimeout(() => {
      timer = null;
      if (dirty && sending === null) {
        sending = send();
        sending.catch(() => undefined);
      }
    }, delay);
    if (hasUnref(timer)) timer.unref();
  };

  const report = (state: LiveProgressState): void => {
    if (terminalPhase !== null) return; // terminal wins; ignore late reports
    if (state.phase !== undefined && state.phase !== phase) {
      phase = state.phase;
      phaseStartedAt = nowFn();
    }
    if (state.detail !== undefined) detail = state.detail;
    if (state.transfers !== undefined) counters.transfers = state.transfers;
    if (state.bytes !== undefined) counters.bytes = state.bytes;
    if (state.checks !== undefined) counters.checks = state.checks;
    if (state.errors !== undefined) counters.errors = state.errors;
    if (state.files !== undefined) counters.files = state.files;
    dirty = true;
    if (sending !== null) return; // the in-flight finally will coalesce
    if (lastSentAt === 0 || nowFn() - lastSentAt >= minIntervalMs) {
      sending = send();
      sending.catch(() => undefined);
    } else {
      scheduleFlush();
    }
  };

  const finish = (terminal: "success" | "failed", terminalDetail?: string | null): void => {
    terminalPhase = terminal;
    if (terminalDetail !== undefined) detail = terminalDetail;
    dirty = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (sending !== null) {
      // The in-flight send's finally will notice `dirty` and re-send with
      // the terminal phase.
      return;
    }
    sending = send();
    sending.catch(() => undefined);
  };

  return {
    report,
    finish,
    async flush(): Promise<void> {
      while (sending !== null) {
        await sending.catch(() => undefined);
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (dirty) {
        const p = send();
        sending = p;
        await p.catch(() => undefined);
      }
    },
    runId: opts.runId,
  };
}

/** Tiny helper: build a reporter-wired phase signal from a stats block. */
export function countersFromStats(stats: {
  transfers?: unknown;
  bytes?: unknown;
  checks?: unknown;
  errors?: unknown;
}): {
  transfers: number | null;
  bytes: number | null;
  checks: number | null;
  errors: number | null;
} {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  return {
    transfers: num(stats.transfers),
    bytes: num(stats.bytes),
    checks: num(stats.checks),
    errors: num(stats.errors),
  };
}

/**
 * Detect whether a stats block is mid-check: no in-flight transfers but the
 * check counter is advancing. rclone verifies each file after the transfer
 * pass (the `Checks: N/M` arm), so a stats block with `transfers === 0` and
 * `checks > 0` while the run is otherwise transferring is honestly
 * "checking". When transfers are in flight we stay on `transferring`.
 */
export function statsPhase(stats: {
  transfers?: unknown;
  checks?: unknown;
}): "transferring" | "checking" | null {
  const transfers = typeof stats.transfers === "number" ? stats.transfers : 0;
  const checks = typeof stats.checks === "number" ? stats.checks : 0;
  if (transfers > 0) return "transferring";
  if (checks > 0) return "checking";
  return null;
}
