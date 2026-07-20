import { CronExpressionParser } from "cron-parser";
import type { DotfileManifest, Folder, FolderAssignment } from "@lamasync/core";

const DEFAULT_REBOOT_DELAY_MS = 30_000;

export interface SchedulerOptions {
  onTick: (assignment: FolderAssignment) => void | Promise<void>;
  getAssignments: () => FolderAssignment[];
  /** Folder metadata so dotfile assignments can resolve manifest schedules. */
  getFolders?: () => Folder[];
  /** Manifest metadata so dotfile assignment schedules can be read from manifests. */
  getManifests?: () => DotfileManifest[];
  /** Delay before firing @reboot assignments (default 30s). */
  rebootDelayMs?: number;
}

type ScheduleKind = "cron" | "@reboot" | "@login" | "unknown";

interface ParsedSchedule {
  kind: ScheduleKind;
  /** Original expression, when meaningful for diagnostics. */
  expr?: string;
}

/**
 * Cron-driven timer for folder assignments.
 *
 * Each enabled assignment with a `syncExpr` gets its own `setTimeout` for the
 * next fire time. On fire, we call `onTick` and reschedule for the following
 * occurrence. `refresh` rebuilds the schedule from scratch (e.g. after a
 * config refresh from the server); `stop` cancels everything without firing.
 *
 * Dotfile assignments may use a manifest `schedule` field, which supports the
 * special tokens `@reboot` and `@login` in addition to regular cron
 * expressions. Unknown `@*` tokens are logged and ignored.
 */
export class Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly firedSpecial = new Set<string>();
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
    if (!assignment.enabled) return null;
    const parsed = this.parseSchedule(this.effectiveSchedule(assignment));
    if (parsed.kind !== "cron") return null;
    if (!this.timers.has(assignment.id)) return null;
    try {
      return CronExpressionParser.parse(parsed.expr!, {
        currentDate: new Date(),
      })
        .next()
        .toDate();
    } catch {
      return null;
    }
  }

  /** Visible for testing: parse a schedule expression into its kind. */
  parseSchedule(expr: string | null | undefined): ParsedSchedule {
    if (!expr) return { kind: "unknown" };
    const trimmed = expr.trim();
    if (trimmed === "@reboot") return { kind: "@reboot", expr: trimmed };
    if (trimmed === "@login") return { kind: "@login", expr: trimmed };
    return { kind: "cron", expr: trimmed };
  }

  /** Visible for testing: resolve the schedule that applies to an assignment. */
  effectiveSchedule(assignment: FolderAssignment): string | null {
    if (!assignment.enabled) return null;
    const folders = this.opts.getFolders?.() ?? [];
    const folder = folders.find((f) => f.id === assignment.folderId);
    if (folder?.type === "dotfile") {
      const manifests = this.opts.getManifests?.() ?? [];
      const manifest = manifests.find((m) => m.appName === folder.name);
      if (manifest?.schedule) return manifest.schedule;
    }
    return assignment.syncExpr ?? null;
  }

  private schedule(assignment: FolderAssignment): void {
    if (!assignment.enabled) return;
    const schedule = this.effectiveSchedule(assignment);
    const parsed = this.parseSchedule(schedule);

    switch (parsed.kind) {
      case "@reboot":
        this.scheduleOneShot(assignment, parsed.kind);
        return;
      case "@login":
        this.scheduleOneShot(assignment, parsed.kind);
        return;
      case "cron":
        this.scheduleCron(assignment, parsed.expr!);
        return;
      case "unknown":
        if (schedule && schedule.startsWith("@")) {
          console.warn(
            `[scheduler] unknown special schedule for assignment=${assignment.id}: ${schedule}`,
          );
        }
        return;
    }
  }

  private scheduleOneShot(
    assignment: FolderAssignment,
    kind: "@reboot" | "@login",
  ): void {
    if (this.firedSpecial.has(assignment.id)) return;

    const delay = kind === "@reboot" ? (this.opts.rebootDelayMs ?? DEFAULT_REBOOT_DELAY_MS) : 0;

    if (kind === "@login" && !this.isUserSession()) {
      console.warn(
        `[scheduler] @login for assignment=${assignment.id} running at startup because no desktop/user session was detected`,
      );
    }

    const timer = setTimeout(() => {
      this.timers.delete(assignment.id);
      this.firedSpecial.add(assignment.id);
      void Promise.resolve(this.opts.onTick(assignment)).catch((err) => {
        console.error(
          `[scheduler] onTick error for assignment=${assignment.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, delay);
    timer.unref?.();
    this.timers.set(assignment.id, timer);
  }

  private scheduleCron(assignment: FolderAssignment, expr: string): void {
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

  private isUserSession(): boolean {
    return Boolean(
      process.env.DISPLAY ||
        process.env.WAYLAND_DISPLAY ||
        (process.env.XDG_SESSION_TYPE &&
          process.env.XDG_SESSION_TYPE !== "tty"),
    );
  }
}
