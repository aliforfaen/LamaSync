// Config revision bumping (LAMA-198).
//
// The server tracks a per-host `config_revision` counter that increments
// whenever the daemon's effective config (folders, assignments, dotfile
// manifests, LAN peers, etc.) could have changed. The daemon compares the
// server-side revision on each heartbeat against the revision it cached
// with its last `/config/:hostId` payload; if the server's is higher it
// pulls a fresh config without waiting for the 5-min refresh timer.
//
// Bumping-all is fine where the affected host set is unknown (e.g. a folder
// delete with multiple assigned hosts). Each bump is a single UPDATE
// statement — no transactions needed, no over-engineering.

import type { Database } from "bun:sqlite";
import { db as defaultDb } from "./db.ts";

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

/**
 * Increment `config_revision` for the given host ids. Pass `null` (the
 * default) to bump every host — used by writes that don't have a known
 * affected-host set, or when the set is "every host with this folder
 * assigned".
 */
export function bumpConfigRevision(hostIds: string[] | null = null): void {
  if (hostIds === null || hostIds.length === 0) {
    activeDb.run("UPDATE hosts SET config_revision = COALESCE(config_revision, 0) + 1");
    return;
  }
  const placeholders = hostIds.map(() => "?").join(",");
  activeDb.run(
    `UPDATE hosts SET config_revision = COALESCE(config_revision, 0) + 1 WHERE id IN (${placeholders})`,
    hostIds,
  );
}

/**
 * Bump every host that currently has a folder assignment for `folderId`.
 * Used by folder create/update/delete and assignment mutations where the
 * "affected hosts" set is the assignment table.
 */
export function bumpConfigRevisionForFolder(folderId: string): void {
  activeDb.run(
    `UPDATE hosts
       SET config_revision = COALESCE(config_revision, 0) + 1
     WHERE id IN (SELECT host_id FROM folder_assignments WHERE folder_id = ?)`,
    [folderId],
  );
}

/** Bump every host that has a dotfile manifest assigned to it. */
export function bumpConfigRevisionForManifest(hostId: string): void {
  bumpConfigRevision([hostId]);
}

/**
 * Bump every other host — used by `/register` and any other write that
 * could have shifted LAN-peer / rclone-remote wiring for the fleet. Cheap
 * (single UPDATE); better than trying to compute the precise affected set.
 */
export function bumpConfigRevisionForPeers(exceptHostId: string): void {
  activeDb.run(
    "UPDATE hosts SET config_revision = COALESCE(config_revision, 0) + 1 WHERE id != ?",
    [exceptHostId],
  );
}