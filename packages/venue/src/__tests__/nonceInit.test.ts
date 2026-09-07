// The memoized nonce bootstrap must not poison the manager permanently.
// Observed LIVE: `submit->queue` logged, `run` was NEVER invoked, and every
// write hung — because `init ??= source.getTransactionCount()` caches the very
// first promise, so one hung or rejected bootstrap disables all writes for the
// life of the process. A signing key that can never reserve a nonce is a dead agent.
import { describe, it, expect, vi } from 'vitest';
import { NonceManager } from '../txqueue.ts';

describe('NonceManager bootstrap resilience', () => {
  it('recovers after a failed first read instead of caching the failure', async () => {
    const getTransactionCount = vi.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValue(7);
    const n = new NonceManager({ getTransactionCount });
    await expect(n.reserve()).rejects.toThrow('RPC timeout');
    // The retry must actually re-read the chain, not await the dead promise.
    await expect(n.reserve()).resolves.toBe(7);
    expect(getTransactionCount).toHaveBeenCalledTimes(2);
  });

  it('still reads the chain only once on the happy path', async () => {
    const getTransactionCount = vi.fn().mockResolvedValue(3);
    const n = new NonceManager({ getTransactionCount });
    const [a, b, c] = await Promise.all([n.reserve(), n.reserve(), n.reserve()]);
    // one bootstrap, gapless sequence — the concurrency guarantee T-033 exists for
    expect(getTransactionCount).toHaveBeenCalledTimes(1);
    expect([a, b, c].sort((x, y) => x - y)).toEqual([3, 4, 5]);
  });

  it('a slow-then-failing bootstrap does not strand later callers', async () => {
    const getTransactionCount = vi.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(11);
    const n = new NonceManager({ getTransactionCount });
    await expect(n.reserve()).rejects.toThrow('down');
    await expect(n.reserve()).rejects.toThrow('down');
    await expect(n.reserve()).resolves.toBe(11);
  });
});
