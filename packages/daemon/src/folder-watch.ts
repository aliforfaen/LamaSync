// LAMA-302: platform-neutral file-watch boundary + the debounce/single-flight
// controller that turns local filesystem events into one bounded `runOnce`.
//
// The factory/platform selection is deliberately separate from the
// debounce/coalescing state machine so a future Windows/Android watcher only
// has to emit `onDirty()` — it never learns about controllers, quiet periods,
// or runs. The controller owns one assignment's state machine:
//
//   idle → diving → running → (dirty-during-run ? debouncing : idle)
//
// It never queues paths or launches concurrent runs: a burst is one
// reconciliation; events during a run coalesce into at most one follow-up
// debounced run. All locking / destination contention / pause / retry /
// reporting stays in the existing `runOnce` path — a watch event never
// bypasses them.

import { watch, type FSWatcher } from "fs";
import { existsSync } from "fs";
import { sep } from "path";
import type { FolderAssignment } from "@lamasync/core";
import { resolveWatchQuietSec } from "@lamasync/core";
import { expandHomePath } from "./config.ts";
import { GitignoreEvaluator } from "./gitignore.ts";
import { loadFilterPatterns, resolveFilterPath } from "./ignore.ts";

/** Handle to a started filesystem watcher. */
export interface FolderWatchHandle {
  close(): void;
}

/** Platform-neutral boundary: a watcher factory for one assignment. */
export interface FolderWatchFactory {
  start(options: {
    assignment: FolderAssignment;
    onDirty(): void;
    onError(error: Error): void;
  }): FolderWatchHandle;
}

/** Injectable timer boundary so pure controller tests can use a fake clock. */
export interface WatchTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

export const defaultWatchTimers: WatchTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

/** One assignment's debounce state machine. */
export class WatchController {
  private handle: FolderWatchHandle | null = null;
  private timer: unknown = null;
  private state: "idle" | "debouncing" | "running" = "idle";
  private dirtyDuringRun = false;
  private closed = false;

  constructor(
    private readonly opts: {
      assignment: FolderAssignment;
      factory: FolderWatchFactory;
      run(): Promise<void>;
      timers?: WatchTimers;
      log?: (msg: string) => void;
    },
  ) {}

  start(): void {
    if (this.handle) return;
    try {
      this.handle = this.opts.factory.start({
        assignment: this.opts.assignment,
        onDirty: () => this.markDirty(),
        onError: (err) => this.handleError(err),
      });
    } catch (err) {
      // A path that vanished between eligibility check and watch is a normal
      // non-start condition (LAMA-241 policy). Log once and leave the
      // controller empty — the coordinator retries on the next refresh.
      this.opts.log?.(
        `[watch] failed to start watcher for ${this.opts.assignment.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Stop the watcher + clear the pending run. Idempotent. */
  stop(): void {
    this.closed = true;
    this.clearTimer();
    this.handle?.close();
    this.handle = null;
  }

  private get timers(): WatchTimers {
    return this.opts.timers ?? defaultWatchTimers;
  }

  private markDirty(): void {
    if (this.closed) return;
    if (this.state === "running") {
      this.dirtyDuringRun = true;
      return;
    }
    this.scheduleRun();
  }

  private scheduleRun(): void {
    const quiet = resolveWatchQuietSec(this.opts.assignment.watchQuietSec);
    this.clearTimer();
    this.state = "debouncing";
    const t = this.timers.setTimeout(() => void this.fire(), quiet * 1000);
    // Don't keep the daemon alive on its own timer.
    (t as { unref?: () => void })?.unref?.();
    this.timer = t;
  }

  private async fire(): Promise<void> {
    if (this.closed) return;
    this.clearTimer();
    if (this.state !== "debouncing") return;
    this.state = "running";
    this.dirtyDuringRun = false;
    try {
      await this.opts.run();
    } catch (err) {
      this.opts.log?.(
        `[watch] run threw for ${this.opts.assignment.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (this.closed) return;
    if (this.dirtyDuringRun) {
      // At most one follow-up debounced run after a run that saw new events.
      this.scheduleRun();
    } else {
      this.state = "idle";
    }
  }

  private handleError(err: Error): void {
    this.opts.log?.(
      `[watch] ${this.opts.assignment.id} event stream error/incomplete: ${err.message}`,
    );
    this.markDirty();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Linux inotify-backed adapter (Node's `fs.watch` is inotify on Linux and
 * handles directories created after start). Watches `assignment.localPath`
 * recursively and only reports events that are meaningful for a sync:
 *
 *   - `ignoreGitMetadata`: skip the `.git/` tree.
 *   - `respectGitignore`: skip paths Git ignores (via the evaluator).
 *   - existing `.lamasyncignore` / `.lamasyncmountignore`: skip paths an
 *     rclone exclude pattern matches (best-effort; the debounce is the real
 *     protection against event storms).
 */
export function createLinuxInotifyFactory(): FolderWatchFactory {
  return {
    start(options) {
      const { assignment, onDirty, onError } = options;
      const localPath = expandHomePath(assignment.localPath);

      const gitignore = assignment.respectGitignore
        ? new GitignoreEvaluator(localPath)
        : null;
      const filterPath = resolveFilterPath(
        assignment.ignorePath,
        assignment.mountIgnorePath ?? null,
        "sync",
      );
      const excludePatterns = loadFilterPatterns(filterPath, localPath);
      const excludeRegexes = excludePatterns
        .map((p) => p.replace(/^[-+]\s*/, "").trim())
        .filter((p) => p.length > 0 && !p.startsWith("#"))
        .map(globToRegex);

      let closed = false;
      let fsWatcher: FSWatcher | null = null;
      try {
        fsWatcher = watch(localPath, { recursive: true }, (_event, filename) => {
          if (closed) return;
          if (!filename) return; // some inotify events carry no path
          const rel = filename.split(sep).join("/");
          if (assignment.ignoreGitMetadata && (rel === ".git" || rel.startsWith(".git/"))) {
            return;
          }
          if (gitignore && gitignore.isIgnored(rel)) return;
          if (excludeRegexes.some((re) => isExcluded(rel, re))) return;
          onDirty();
        });
        fsWatcher.on("error", (err) => {
          if (closed) return;
          onError(err instanceof Error ? err : new Error(String(err)));
        });
      } catch (err) {
        // Directories can vanish before we attach; surface as a non-fatal
        // error and let the debounce state machine schedule a reconciliation.
        onError(err instanceof Error ? err : new Error(String(err)));
        return { close: () => undefined };
      }

      return {
        close() {
          closed = true;
          try {
            fsWatcher?.close();
          } catch {
            // already closed
          }
          fsWatcher = null;
        },
      };
    },
  };
}

/** True when an rclone-style `/`-rooted glob excludes `rel`. */
function isExcluded(rel: string, regex: RegExp): boolean {
  const norm = rel.replace(/^\//, "");
  return regex.test(norm);
}

/** Translate a lightweight glob (`*`, `**`, `?`) into a RegExp. */
export function globToRegex(pattern: string): RegExp {
  const body = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  let re = "^";
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === "*") {
      if (body[i + 1] === "*") {
        re += ".*";
        i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\.^$+()[]{}|".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}
