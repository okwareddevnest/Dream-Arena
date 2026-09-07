// TxQueue must not deadlock on a re-entrant submit.
// The LIVE failure: the Engine was given the venue's OWN TxQueue as its
// `submitter`, so the chain was
//   queue.submit(X, run: () => venue.placeOrder(order))
//     -> venue.placeOrder -> queue.submit(X, ...)        [same queue, same id]
//        -> dedupe returns the OUTER promise, which cannot resolve until the
//           venue returns -> deadlock -> 30s timeout, no transaction ever sent.
// Deduping a queued or finished task is correct; deduping a task that is
// currently EXECUTING can only be re-entrancy, and must fail loudly.
import { describe, it, expect, vi } from 'vitest';
import { TxQueue, NonceManager } from '../txqueue.ts';

const mkQueue = (timeoutMs = 200) =>
  new TxQueue({ nonces: new NonceManager({ getTransactionCount: async () => 0 }), timeoutMs });

describe('re-entrant submit', () => {
  it('throws instead of deadlocking when a task submits its own id', async () => {
    const q = mkQueue();
    const err = vi.fn();
    const outer = q.submit({
      clientOrderId: 'X',
      run: async () => {
        // exactly what venue.placeOrder did to the engine's task
        await q.submit({ clientOrderId: 'X', run: async () => 'inner' }).catch(err);
        return 'outer';
      },
    });
    await expect(outer).resolves.toBe('outer');
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toMatch(/re-entrant/i);
  });

  it('still dedupes a repeat submit that is only QUEUED, not executing', async () => {
    const q = mkQueue();
    let started = 0;
    const slow = q.submit({ clientOrderId: 'A', run: async () => { started++; return 'a'; } });
    const dup = q.submit({ clientOrderId: 'A', run: async () => { started++; return 'a2'; } });
    await Promise.all([slow, dup]);
    expect(started, 'the duplicate did not run twice').toBe(1);
    await expect(dup).resolves.toBe('a');
  });

  it('still dedupes after completion, so a retry is idempotent', async () => {
    const q = mkQueue();
    const first = await q.submit({ clientOrderId: 'B', run: async () => 'once' });
    const again = await q.submit({ clientOrderId: 'B', run: async () => 'twice' });
    expect(first).toBe('once');
    expect(again).toBe('once');
  });

  it('frees the id after execution so a later distinct task is unaffected', async () => {
    const q = mkQueue();
    await q.submit({ clientOrderId: 'C', run: async () => 'c' });
    await expect(q.submit({ clientOrderId: 'D', run: async () => 'd' })).resolves.toBe('d');
  });
});
