import { CronExpressionParser } from "cron-parser";
import type { AppCaptureAssignment, EffectivePause, Folder, FolderAssignment } from "@lamasync/core";
import { effectiveFolderType } from "@lamasync/core";

const DEFAULT_REBOOT_DELAY_MS = 30_000;

export interface SchedulerOptions {
  onTick: (assignment: FolderAssignment) => void | Promise<void>;
  getAssignments: () => FolderAssignment[];
  /** Folder metadata used to suppress mount assignments on the cron loop. */
  getFolders?: () => Folder[];
  /** LAMA-316: explicit capture commitments, independent of folders. */
  getApps?: () => AppCaptureAssignment[];
  onAppTick?: (app: AppCaptureAssignment) => void | Promise<void>;
  /** Delay before firing @reboot assignments (default 30s). */
  rebootDelayMs?: number;
  /** LAMA-273: effective pause for the host. When `until > now` the
   *  scheduler logs a "sync skipped: paused until <iso>" line and
   *  reschedules the fire (one-shots stay pending; cron re-arms
   *  normally). Optional so older callers that don't care about
   *  pause can keep working. */
  getEffectivePause?: () => EffectivePause | null;
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
    for (const app of this.opts.getApps?.() ?? []) {
      this.scheduleApp(app);
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

  /** Next scheduled capture for an application protection, or null. */
  nextRunForApp(app: AppCaptureAssignment): Date | null {
    const parsed = this.parseSchedule(app.schedule);
    const key = this.appTimerKey(app);
    if (parsed.kind !== "cron" || !this.timers.has(key)) return null;
    try {
      return CronExpressionParser.parse(parsed.expr!, { currentDate: new Date() }).next().toDate();
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
    // LAMA-239: a per-host `mount` override turns this assignment into a
    // persistent mount — the cron scheduler has nothing to do with it.
    // `reconcileOnRefresh` in the daemon starts/stops the mount unit;
    // returning null here keeps the cron fire loop out of the picture
    // entirely. (backup/dotfile/git modes are unaffected by the override
    // — see effectiveFolderType — so they keep their schedule.)
    if (folder && effectiveFolderType(folder, assignment) === "mount") return null;
    // App protections have their own scheduler below. A legacy dotfile
    // assignment must not schedule a second capture of the same protection.
    if (folder?.type === "dotfile") return null;
    return assignment.syncExpr ?? null;
  }

  private appTimerKey(app: AppCaptureAssignment): string {
    return `app:${app.protectionId}`;
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

  private scheduleApp(app: AppCaptureAssignment): void {
    const schedule = app.schedule;
    const parsed = this.parseSchedule(schedule);
    switch (parsed.kind) {
      case "@reboot":
        this.scheduleAppOneShot(app, parsed.kind);
        return;
      case "@login":
        this.scheduleAppOneShot(app, parsed.kind);
        return;
      case "cron":
        this.scheduleAppCron(app, parsed.expr!);
        return;
      case "unknown":
        if (schedule && schedule.startsWith("@")) {
          console.warn(
            `[scheduler] unknown special schedule for app protection=${app.protectionId}: ${schedule}`,
          );
        }
        return;
    }
  }

  // LAMA-273: pause check shared by the one-shot + cron fire paths.
  // Returns the active pause when one applies (so the caller can decide
  // whether to log once or to wait until expiry); null when no pause is
  // active and the fire should proceed.
  private currentPause(): { until: string } | null {
    const pause = this.opts.getEffectivePause?.();
    if (!pause) return null;
    const until = Date.parse(pause.until);
    if (!Number.isFinite(until) || until <= Date.now()) return null;
    return { until: pause.until };
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
      const pause = this.currentPause();
      if (pause) {
        // One-shot: don't mark fired — let a future refresh pick this up
        // once the pause window closes. Re-arm a short retry so a long
        // pause doesn't lose the fire forever.
        console.log(
          `[scheduler] sync skipped: paused until ${pause.until} (assignment=${assignment.id})`,
        );
        this.timers.delete(assignment.id);
        const retryDelay = Math.max(
          1_000,
          Math.min(60_000, Date.parse(pause.until) - Date.now()),
        );
        const retry = setTimeout(() => {
          this.timers.delete(assignment.id);
          if (this.running) this.schedule(assignment);
        }, retryDelay);
        retry.unref?.();
        this.timers.set(assignment.id, retry);
        return;
      }
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
      const pause = this.currentPause();
      if (pause) {
        console.log(
          `[scheduler] sync skipped: paused until ${pause.until} (assignment=${assignment.id})`,
        );
        // Reschedule via the existing .finally path — the next cron tick
        // (or refresh) will re-evaluate the pause state.
        if (this.running) this.schedule(assignment);
        return;
      }
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

  private scheduleAppOneShot(
    app: AppCaptureAssignment,
    kind: "@reboot" | "@login",
  ): void {
    const key = this.appTimerKey(app);
    if (this.firedSpecial.has(key)) return;
    const delay = kind === "@reboot" ? (this.opts.rebootDelayMs ?? DEFAULT_REBOOT_DELAY_MS) : 0;
    if (kind === "@login" && !this.isUserSession()) {
      console.warn(
        `[scheduler] @login app protection=${app.protectionId} running at startup because no desktop/user session was detected`,
      );
    }
    const timer = setTimeout(() => {
      const pause = this.currentPause();
      if (pause) {
        console.log(
          `[scheduler] app capture skipped: paused until ${pause.until} (protection=${app.protectionId})`,
        );
        this.timers.delete(key);
        const retryDelay = Math.max(1_000, Math.min(60_000, Date.parse(pause.until) - Date.now()));
        const retry = setTimeout(() => {
          this.timers.delete(key);
          if (this.running) this.scheduleApp(app);
        }, retryDelay);
        retry.unref?.();
        this.timers.set(key, retry);
        return;
      }
      this.timers.delete(key);
      this.firedSpecial.add(key);
      void Promise.resolve(this.opts.onAppTick?.(app)).catch((err) => {
        console.error(
          `[scheduler] app capture error protection=${app.protectionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, delay);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private scheduleAppCron(app: AppCaptureAssignment, expr: string): void {
    const key = this.appTimerKey(app);
    let next: Date;
    try {
      next = CronExpressionParser.parse(expr, { currentDate: new Date() }).next().toDate();
    } catch (err) {
      console.warn(
        `[scheduler] invalid cron for app protection=${app.protectionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const timer = setTimeout(() => {
      const pause = this.currentPause();
      if (pause) {
        console.log(
          `[scheduler] app capture skipped: paused until ${pause.until} (protection=${app.protectionId})`,
        );
        if (this.running) this.scheduleApp(app);
        return;
      }
      this.timers.delete(key);
      void Promise.resolve(this.opts.onAppTick?.(app))
        .catch((err) => {
          console.error(
            `[scheduler] app capture error protection=${app.protectionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          if (this.running) this.scheduleApp(app);
        });
    }, Math.max(0, next.getTime() - Date.now()));
    timer.unref?.();
    this.timers.set(key, timer);
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
