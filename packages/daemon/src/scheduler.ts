import { CronExpressionParser } from "cron-parser";
import type { FolderAssignment } from "@lamasync/core";

export interface SchedulerOptions {
  onTick: (assignment: FolderAssignment) => void | Promise<void>;
  getAssignments: () => FolderAssignment[];
}

/**
 * Cron-driven timer for folder assignments.
 *
 * Each enabled assignment with a `syncExpr` gets its own `setTimeout` for the
 * next fire time. On fire, we call `onTick` and reschedule for the following
 * occurrence. `refresh` rebuilds the schedule from scratch (e.g. after a
 * config refresh from the server); `stop` cancels everything without firing.
 */
export class Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private running = false;

  constructor(private readonly opts: SchedulerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const a of this.opts.getAssignments()) {
      this.schedule(a);
    }
  }

  refresh(): void {
    this.stop();
    this.start();
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Next scheduled fire for an assignment, or null when not scheduled. */
  nextRunFor(assignment: FolderAssignment): Date | null {
    if (!assignment.enabled || !assignment.syncExpr) return null;
    if (this.timers.has(assignment.id)) {
      try {
        return CronExpressionParser.parse(assignment.syncExpr, {
          currentDate: new Date(),
        })
          .next()
          .toDate();
      } catch {
        return null;
      }
    }
    return null;
  }

  private schedule(assignment: FolderAssignment): void {
    if (!assignment.enabled || !assignment.syncExpr) return;
    const expr = assignment.syncExpr;
    let next: Date;
    try {
      next = CronExpressionParser.parse(expr, {
        currentDate: new Date(),
      })
        .next()
        .toDate();
    } catch (err) {
      console.warn(
        `[scheduler] invalid cron for assignment=${assignment.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const delay = Math.max(0, next.getTime() - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(assignment.id);
      void Promise.resolve(this.opts.onTick(assignment))
        .catch((err) => {
          console.error(
            `[scheduler] onTick error for assignment=${assignment.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          if (this.running) this.schedule(assignment);
        });
    }, delay);
    // Don't keep the event loop alive on its own — the parent process holds it.
    timer.unref?.();
    this.timers.set(assignment.id, timer);
  }
}