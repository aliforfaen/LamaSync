// LAMA-336: one atomic writer for the daemon's small private state files.
//
// The offline host-config cache and the update-check cooldown are JSON files
// that the NEXT process start reads back. A direct `writeFileSync` leaves a
// truncated file behind when the process dies or the disk fills mid-write, and
// every reader then discards the whole file: the host loses its offline
// scheduling cache, and — worse — loses the cooldown that stops a crash loop
// from re-firing an update check on every restart.
//
// The bytes go to a sibling temporary file, are permission-set and flushed to
// disk, and only then replace the target through a same-directory rename. The
// rename is the atomicity point, so a reader sees either the old file or the
// complete new one, never a half-written mixture.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  chmodSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { dirname } from "path";

/** Default permissions for daemon state: owner-only. */
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Write `contents` to `path` atomically, preserving the existing file's mode.
 *
 * `mode` applies to a file that does not exist yet. An existing file keeps its
 * current permissions, so an operator who tightened (or deliberately loosened)
 * them by hand is not silently overridden on the next write.
 *
 * Throws after cleaning up its temporary file, so a failed write leaves the
 * previous contents in place.
 */
export function writeFileAtomic(
  path: string,
  contents: string,
  mode: number = PRIVATE_FILE_MODE,
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const targetMode = existsSync(path) ? statSync(path).mode & 0o777 : mode;
  const tempPath = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, contents, { mode: targetMode });
    // writeFileSync's mode is masked by umask, so set it explicitly.
    chmodSync(tempPath, targetMode);
    const fd = openSync(tempPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, path);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* the temporary file may never have been created */
    }
    throw err;
  }
}
