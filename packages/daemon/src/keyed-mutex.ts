/**
 * LAMA-308: in-process per-key serialization. Sync / mount / backup runs for
 * the same folder must execute one after another, not concurrently — N claimed
 * `trigger_sync` actions (manual + schedule + watch) for one folder would
 * otherwise race the same bisync state directory / rclone mount. The
 * cross-daemon lock (lock.ts) only guards against OTHER hosts; this keyed
 * mutex serializes callers within this daemon process.
 *
 * A simple FIFO promise chain per key: each caller waits for the previous
 * holder to release before it runs. Callers that arrive later are queued and
 * run in order, so an already-queued run is naturally deduplicated by waiting
 * rather than spawned concurrently.
 */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<void>>();

  /** Run `fn` while holding the per-key lock. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.chains.set(key, gate);
    // A previous holder's error must not poison the queue for later callers.
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      // Only clean up when this call is still the tail; otherwise a later
      // caller has already replaced the chain entry.
      if (this.chains.get(key) === gate) {
        this.chains.delete(key);
      }
    }
  }
}
