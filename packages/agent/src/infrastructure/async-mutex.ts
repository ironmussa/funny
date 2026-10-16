import { createPermitPool } from '@funny/shared/async';
/**
 * AsyncMutex — single-holder async lock for protecting read-modify-write sequences.
 *
 * In-process only. Does NOT provide cross-process locking.
 * Suitable for single-process applications like the pipeline service.
 */

export class AsyncMutex {
  private readonly permits = createPermitPool(1);
  private holders = 0;

  async acquire(): Promise<() => void> {
    const release = await this.permits.acquire();
    this.holders++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders--;
      release();
    };
  }

  /**
   * Execute a function while holding the lock.
   * Ensures the lock is released even if the function throws.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get isLocked(): boolean {
    return this.holders > 0;
  }
}
