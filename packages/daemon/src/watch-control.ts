// LAMA-302: daemon-side reconciliation of one `WatchController` per eligible
// assignment. It owns the lifecycle: start a controller when an assignment is
// eligible, stop it when it becomes ineligible (disable/removal/effective-type
// change/missing local path), and restart it when the watch config changes.
//
// Eligibility: `watchEnabled === true`, effective type === "sync", and the
// local path exists. A missing local path is a normal non-start condition —
// the daemon's existing missing-path policy logs it once, and reconcile()
// retries on the next config refresh. Nothing here bypasses `runOnce`'s
// locking / pause / retry / reporting.

import { existsSync } from "fs";
import type { Folder, FolderAssignment } from "@lamasync/core";
import { effectiveFolderType } from "@lamasync/core";
import { expandHomePath } from "./config.ts";
import { hasGitWorktree } from "./gitignore.ts";
import {
  WatchController,
  type FolderWatchFactory,
  type WatchTimers,
} from "./folder-watch.ts";

export class WatchCoordinator {
  private readonly controllers = new Map<
    string,
    { ctl: WatchController; sig: string }
  >();

  constructor(
    private readonly opts: {
      factory: FolderWatchFactory;
      getAssignments(): FolderAssignment[];
      getFolders(): Folder[];
      runOnce(assignment: FolderAssignment): Promise<void>;
      timers?: WatchTimers;
      log?: (msg: string) => void;
    },
  ) {}

  /** Bring the controller set in line with the current config. Idempotent. */
  reconcile(): void {
    const { getAssignments, getFolders } = this.opts;
    const folders = getFolders();
    const folderById = new Map(folders.map((f) => [f.id, f]));
    const wanted = new Set<string>();

    for (const assignment of getAssignments()) {
      const folder = folderById.get(assignment.folderId);
      if (!folder) continue;
      // An assignment's enabled switch is authoritative for every trigger
      // source. A disabled assignment must not retain a live watcher which
      // can enqueue a new bisync run after the next filesystem write.
      if (!assignment.enabled) continue;
      if (assignment.watchEnabled !== true) continue;
      if (effectiveFolderType(folder, assignment) !== "sync") continue;
      const localPath = expandHomePath(assignment.localPath);
      if (!existsSync(localPath)) continue;
      // LAMA-302: `respectGitignore` requires a Git worktree. If the path is
      // not one, warn and skip — the watcher must not pretend the Git-ignore
      // filtering is active (matching the handoff's explicit rule).
      if (assignment.respectGitignore && !hasGitWorktree(localPath)) {
        this.opts.log?.(
          `[watch] folder=${assignment.folderId} has respectGitignore but ${localPath} is not a Git worktree; not watching`,
        );
        continue;
      }

      const sig = this.signature(assignment, folder);
      const existing = this.controllers.get(assignment.id);
      if (existing) {
        if (existing.sig === sig) {
          wanted.add(assignment.id);
          continue;
        }
        // Watch config changed — recreate so the new quiet period / filters
        // apply immediately.
        existing.ctl.stop();
        this.controllers.delete(assignment.id);
      }
      const ctl = new WatchController({
        assignment,
        factory: this.opts.factory,
        run: () => this.opts.runOnce(assignment),
        timers: this.opts.timers,
        log: this.opts.log,
      });
      this.controllers.set(assignment.id, { ctl, sig });
      ctl.start();
      this.opts.log?.(
        `[watch] watching folder=${assignment.folderId} (path=${assignment.localPath})`,
      );
      wanted.add(assignment.id);
    }

    // Stop controllers whose assignment is no longer eligible.
    for (const [id, entry] of this.controllers) {
      if (!wanted.has(id)) {
        entry.ctl.stop();
        this.controllers.delete(id);
        this.opts.log?.(`[watch] stopped watching folder=${id}`);
      }
    }
  }

  /** Stop every controller (daemon shutdown / refresh teardown). */
  shutdown(): void {
    for (const { ctl } of this.controllers.values()) ctl.stop();
    this.controllers.clear();
  }

  private signature(assignment: FolderAssignment, folder: Folder): string {
    return [
      assignment.watchEnabled === true,
      assignment.watchQuietSec ?? "",
      assignment.ignoreGitMetadata === true,
      assignment.respectGitignore === true,
      assignment.localPath,
      effectiveFolderType(folder, assignment),
    ].join("|");
  }
}
