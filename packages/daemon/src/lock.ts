import type { LamaSyncApiClient } from "@lamasync/core";

export interface LockHandle {
  folderId: string;
  lockId: string;
  ttl: number;
  acquiredAt: number;
}

const activeLocks = new Map<string, LockHandle>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function conflictDetails(error: unknown): {
  lockedBy: string;
  remainingSec: number | string;
} | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("status" in error) ||
    error.status !== 409
  ) {
    return null;
  }

  let body: unknown = "body" in error ? error.body : undefined;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = undefined;
    }
  }

  if (typeof body !== "object" || body === null) {
    return { lockedBy: "unknown", remainingSec: "unknown" };
  }

  const lockedBy =
    "lockedBy" in body && typeof body.lockedBy === "string"
      ? body.lockedBy
      : "unknown";
  const remainingSec =
    "remainingSec" in body && typeof body.remainingSec === "number"
      ? body.remainingSec
      : "unknown";

  return { lockedBy, remainingSec };
}

export async function acquireLock(
  client: LamaSyncApiClient,
  folderId: string,
  hostId: string,
): Promise<LockHandle | null> {
  try {
    const result = await client.acquireLock(folderId, hostId);
    if (!("lockId" in result)) {
      console.warn(
        `[lock] folder=${folderId} locked by ${result.lockedBy}; remaining=${result.remainingSec}s`,
      );
      return null;
    }

    const handle: LockHandle = {
      folderId,
      lockId: result.lockId,
      ttl: result.ttl,
      acquiredAt: Date.now(),
    };
    activeLocks.set(folderId, handle);
    return handle;
  } catch (error) {
    const conflict = conflictDetails(error);
    if (conflict) {
      console.warn(
        `[lock] folder=${folderId} locked by ${conflict.lockedBy}; remaining=${conflict.remainingSec}s`,
      );
      return null;
    }

    console.error(
      `[lock] failed to acquire folder=${folderId}: ${errorMessage(error)}`,
    );
    return null;
  }
}

export async function heartbeatLock(
  client: LamaSyncApiClient,
  folderId: string,
  hostId: string,
  handle?: LockHandle,
): Promise<boolean> {
  try {
    const result = await client.heartbeatLock(folderId, hostId, handle?.lockId);
    return result.ok;
  } catch (error) {
    console.error(
      `[lock] heartbeat failed folder=${folderId}: ${errorMessage(error)}`,
    );
    return false;
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
