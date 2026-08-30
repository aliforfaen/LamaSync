import { LamaSyncApiClient, LamaSyncApiError, type OperationReport } from "@lamasync/core";

export interface LockHandle {
  folderId: string;
  destinationKey: string;
  lockId: string;
  ttl: number;
  acquiredAt: number;
}

export type LockAcquireResult =
  | { ok: true; handle: LockHandle; destinationKey: string }
  | { ok: false; reason: "contended"; lockedBy: string; remainingSec: number; destinationKey: string }
  | { ok: false; reason: "unreachable"; destinationKey: string };

export interface LockAcquireOutcome {
  ok: boolean;
  handle?: LockHandle;
  reason?: "contended" | "unreachable";
  lockedBy?: string;
  remainingSec?: number;
  attempts: number;
  destinationKey: string;
}

export type LockHeartbeatResult = "ok" | "lost" | "unknown";

const activeLocks = new Map<string, LockHandle>();

/** Test seam: clear in-process lock state between tests. */
export function __clearActiveLocks(): void {
  activeLocks.clear();
}

/** Default lock identity when a caller doesn't supply a canonical key. */
export function defaultLockKey(folderId: string): string {
  return `folder:${folderId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function conflictDetails(error: unknown): {
  lockedBy: string;
  remainingSec: number;
  destinationKey: string;
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
      const destinationKey =
        "destinationKey" in body && typeof body.destinationKey === "string"
          ? body.destinationKey
          : "";
      return { lockedBy, remainingSec, destinationKey };
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

/**
 * Single attempt to acquire the canonical destination lock.
 *
 * `destinationKey` is the LAMA-294 canonical destination/repository key. When
 * omitted the server falls back to a `folder:<folder-id>` identity (and the
 * in-process guard uses the same fallback), so mount-switch and other
 * legacy callers keep today's per-folder serialization.
 */
export async function acquireLock(
  client: LamaSyncApiClient,
  folderId: string,
  hostId: string,
  destinationKey?: string,
): Promise<LockAcquireResult> {
  const key = destinationKey ?? defaultLockKey(folderId);

  // Guard against overlapping sync attempts on the same daemon. The server
  // lock also prevents cross-host overlap, but the same host re-acquires
  // silently, so we need an in-process guard too.
  if (activeLocks.has(key)) {
    return {
      ok: false,
      reason: "contended",
      lockedBy: hostId,
      remainingSec: 0,
      destinationKey: key,
    };
  }

  try {
    const result = await client.acquireLock(folderId, hostId, key);
    if (!("lockId" in result)) {
      // Should not happen for 200 responses, but handle defensively.
      return {
        ok: false,
        reason: "contended",
        lockedBy: "unknown",
        remainingSec: 0,
        destinationKey: key,
      };
    }

    const handle: LockHandle = {
      folderId,
      destinationKey: key,
      lockId: result.lockId,
      ttl: result.ttl,
      acquiredAt: Date.now(),
    };
    activeLocks.set(key, handle);
    return { ok: true, handle, destinationKey: key };
  } catch (error) {
    const conflict = conflictDetails(error);
    if (conflict) {
      return {
        ok: false,
        reason: "contended",
        lockedBy: conflict.lockedBy,
        remainingSec: conflict.remainingSec,
        destinationKey: conflict.destinationKey || key,
      };
    }

    return { ok: false, reason: "unreachable", destinationKey: key };
  }
}

/**
 * LAMA-294: acquire the lock with bounded exponential backoff plus jitter and
 * contention coalescing so a simultaneous schedule doesn't permanently skip a
 * host until the next cron interval. Never returns after a net positive
 * attempt unless it actually holds the lock; classification (contended vs
 * unreachable) and attempt count are retained for first-class deferred
 * reporting.
 */
export async function acquireLockWithRetry(
  client: LamaSyncApiClient,
  folderId: string,
  hostId: string,
  destinationKey?: string,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    now?: () => number;
  } = {},
): Promise<LockAcquireOutcome> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? 2_000);
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? 30_000);
  const now = opts.now ?? Date.now;

  let attempts = 0;
  let last: LockAcquireResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    last = await acquireLock(client, folderId, hostId, destinationKey);
    if (last.ok) {
      return { ok: true, handle: last.handle, attempts, destinationKey: last.destinationKey };
    }

    const backoff = Math.min(
      maxDelayMs,
      baseDelayMs * 2 ** (attempt - 1),
    );
    let waitMs: number;
    if (last.reason === "contended") {
      // Coalesce onto the current holder's expiry if it's sooner than our
      // exponential backoff, so a short-lived transfer lets us slip in right
      // after it releases instead of racing forever.
      const remaining = Math.max(0, last.remainingSec * 1000);
      waitMs = Math.min(remaining, backoff);
    } else {
      // Server unreachable: exponential backoff with jitter.
      waitMs = backoff;
    }
    if (attempt === maxAttempts) break;
    // Add ±20% jitter to avoid thundering-herd re-acquire storms.
    await Bun.sleep(Math.round(waitMs * (0.8 + Math.random() * 0.4)));
  }

  // All attempts exhausted; classify for first-class deferred reporting.
  return {
    ok: false,
    reason: last?.reason ?? "unreachable",
    lockedBy: last?.reason === "contended" ? last.lockedBy : undefined,
    remainingSec: last?.reason === "contended" ? last.remainingSec : undefined,
    attempts,
    destinationKey: last?.destinationKey ?? (destinationKey ?? defaultLockKey(folderId)),
  };
}

export async function heartbeatLock(
  client: LamaSyncApiClient,
  folderId: string,
  hostId: string,
  handle?: LockHandle,
  destinationKey?: string,
): Promise<LockHeartbeatResult> {
  try {
    const result = await client.heartbeatLock(
      folderId,
      hostId,
      handle?.lockId,
      handle?.destinationKey ?? destinationKey,
    );
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

/**
 * LAMA-294: build the first-class deferred OperationReport for a lock that
 * could not be acquired after bounded retries. Contention or a temporary
 * control-plane outage is a deferral (no transfer started), never a failed
 * backup. Pure + exported so the wording/status mapping is testable.
 */
export function buildDeferredReport(
  outcome: LockAcquireOutcome,
  hostId: string,
  folderId: string,
  operation: string,
  now: number = Date.now(),
): OperationReport {
  const reason = outcome.reason ?? "unreachable";
  const lockedBy = outcome.lockedBy ?? "unknown";
  const summary =
    reason === "contended"
      ? `deferred: destination locked by ${lockedBy === hostId ? "this host" : lockedBy} (${outcome.remainingSec ?? 0}s remaining) after ${outcome.attempts} attempt(s)`
      : `deferred: server unreachable, lock not acquired after ${outcome.attempts} attempt(s)`;
  return {
    hostId,
    folderId,
    operation,
    status: "deferred",
    summary,
    details: JSON.stringify({
      destinationKey: outcome.destinationKey,
      reason,
      lockedBy,
      attempts: outcome.attempts,
    }),
    timestamp: now,
    durationMs: 0,
  };
}

export async function releaseLock(
  client: LamaSyncApiClient,
  folderId: string,
  hostId: string,
  status: string,
  summary?: string,
  handle?: LockHandle,
  destinationKey?: string,
): Promise<void> {
  try {
    await client.releaseLock(
      folderId,
      hostId,
      status,
      summary,
      handle?.lockId,
      handle?.destinationKey ?? destinationKey,
    );
  } catch (error) {
    console.error(
      `[lock] failed to release folder=${folderId}: ${errorMessage(error)}`,
    );
  } finally {
    activeLocks.delete(handle?.destinationKey ?? destinationKey ?? defaultLockKey(folderId));
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
          undefined,
          lock.destinationKey,
        ),
      ),
    );

    console.warn(`[lock] released ${staleLocks.length} stale lock(s)`);
  } catch (error) {
    console.error(`[lock] stale recovery failed: ${errorMessage(error)}`);
  }
}
