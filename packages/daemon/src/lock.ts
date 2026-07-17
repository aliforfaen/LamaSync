import { LamaSyncApiClient, LamaSyncApiError } from "@lamasync/core";

export interface LockHandle {
  folderId: string;
  lockId: string;
  ttl: number;
  acquiredAt: number;
}

export type LockAcquireResult =
  | { ok: true; handle: LockHandle }
  | { ok: false; reason: "contended"; lockedBy: string; remainingSec: number }
  | { ok: false; reason: "unreachable" };

export type LockHeartbeatResult = "ok" | "lost" | "unknown";

const activeLocks = new Map<string, LockHandle>();

/** Test seam: clear in-process lock state between tests. */
export function __clearActiveLocks(): void {
  activeLocks.clear();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function conflictDetails(error: unknown): {
  lockedBy: string;
  remainingSec: number;
} | null {
  if (!(error instanceof LamaSyncApiError) || error.status !== 409) {
    return null;
  }
  try {
    const body = JSON.parse(error.body) as unknown;
    if (typeof body === "object" && body !== null) {
      const lockedBy =
        "lockedBy" in body && typeof body.lockedBy === "string"
          ? body.lockedBy
          : "unknown";
      const remainingSec =
        "remainingSec" in body && typeof body.remainingSec === "number"
          ? body.remainingSec
          : 0;
      return { lockedBy, remainingSec };
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

export async function acquireLock(
  client: LamaSyncApiClient,
  folderId: string,
  hostId: string,
): Promise<LockAcquireResult> {
  // Guard against overlapping sync attempts on the same daemon. The server
  // lock also prevents cross-host overlap, but the same host re-acquires
  // silently, so we need an in-process guard too.
  if (activeLocks.has(folderId)) {
    return {
      ok: false,
      reason: "contended",
      lockedBy: hostId,
      remainingSec: 0,
    };
  }

  try {
    const result = await client.acquireLock(folderId, hostId);
    if (!("lockId" in result)) {
      // Should not happen for 200 responses, but handle defensively.
      return {
        ok: false,
        reason: "contended",
        lockedBy: "unknown",
        remainingSec: 0,
      };
    }

    const handle: LockHandle = {
      folderId,
      lockId: result.lockId,
      ttl: result.ttl,
      acquiredAt: Date.now(),
    };
    activeLocks.set(folderId, handle);
    return { ok: true, handle };
  } catch (error) {
    const conflict = conflictDetails(error);
    if (conflict) {
      return {
        ok: false,
        reason: "contended",
        lockedBy: conflict.lockedBy,
        remainingSec: conflict.remainingSec,
      };
    }

    return { ok: false, reason: "unreachable" };
  }
}

export async function heartbeatLock(
  client: LamaSyncApiClient,
  folderId: string,
  hostId: string,
  handle?: LockHandle,
): Promise<LockHeartbeatResult> {
  try {
    const result = await client.heartbeatLock(folderId, hostId, handle?.lockId);
    return result.ok ? "ok" : "unknown";
  } catch (error) {
    if (error instanceof LamaSyncApiError && (error.status === 404 || error.status === 409)) {
      // no_active_lock, lock_expired, lock_held_by_other, or lock_id_mismatch
      // all mean our lock is gone and we must stop writing.
      return "lost";
    }
    return "unknown";
  }
}

export async function releaseLock(
  client: LamaSyncApiClient,
  folderId: string,
  hostId: string,
  status: string,
  summary?: string,
  handle?: LockHandle,
): Promise<void> {
  try {
    await client.releaseLock(folderId, hostId, status, summary, handle?.lockId);
  } catch (error) {
    console.error(
      `[lock] failed to release folder=${folderId}: ${errorMessage(error)}`,
    );
  } finally {
    activeLocks.delete(folderId);
  }
}

export async function releaseStaleLocks(
  client: LamaSyncApiClient,
  hostId: string,
): Promise<void> {
  try {
    const locks = await client.listLocks();
    const staleLocks = locks.filter((lock) => lock.lockedBy === hostId);

    await Promise.all(
      staleLocks.map((lock) =>
        releaseLock(
          client,
          lock.folderId,
          hostId,
          "stale_recovery",
          "released on daemon startup",
        ),
      ),
    );

    console.warn(`[lock] released ${staleLocks.length} stale lock(s)`);
  } catch (error) {
    console.error(`[lock] stale recovery failed: ${errorMessage(error)}`);
  }
}
