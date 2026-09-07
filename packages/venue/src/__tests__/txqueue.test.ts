// T-033 — serialized tx queue + nonce manager (FR-X1, WP §7).
// The concurrency assertions here are the ones that matter: a queue that
// *usually* serializes is a queue that drops a transaction on demo day.
import { describe, it, expect, vi } from 'vitest';
import { NonceManager, TxQueue, type NonceSource } from '../txqueue.ts';

const source = (start = 0): NonceSource & { count: number } => {
  const s = { count: start, getTransactionCount: async () => s.count };
  return s;
};

const mk = (over: Partial<ConstructorParameters<typeof TxQueue>[0]> = {}) => {
  const src = source();
  const nonces = new NonceManager(src);
  const q = new TxQueue({ nonces, timeoutMs: 0, ...over });
  return { q, nonces, src };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('T-033 NonceManager', () => {
  it('starts from the chain count and increases by one', async () => {
    const n = new NonceManager(source(17));
    expect(await n.reserve()).toBe(17);
    expect(await n.reserve()).toBe(18);
    expect(await n.reserve()).toBe(19);
  });

  it('reads the chain once, not per transaction', async () => {
    const src = source(5);
    const spy = vi.spyOn(src, 'getTransactionCount');
    const n = new NonceManager(src);
    for (let i = 0; i < 10; i++) await n.reserve();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('assigns 100 concurrent reservations with no gaps and no repeats', async () => {
    const n = new NonceManager(source(0));
    const got = await Promise.all(Array.from({ length: 100 }, () => n.reserve()));
    const sorted = [...got].sort((a, b) => a - b);
    expect(new Set(got).size).toBe(100);
    expect(sorted[0]).toBe(0);
    expect(sorted[99]).toBe(99);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBe(1);
  });

  it('releases the newest nonce for reuse so the sequence stays gapless', async () => {
    const n = new NonceManager(source(0));
    const a = await n.reserve();
    n.release(a);
    expect(await n.reserve()).toBe(a);
  });

  it('does not rewind when an older nonce fails behind newer ones', async () => {
    const n = new NonceManager(source(0));
    const a = await n.reserve();     // 0
    const b = await n.reserve();     // 1
    n.release(a);                    // 0 failed but 1 is already out
    expect(await n.reserve()).toBe(b + 1);
  });

  it('tracks pending reservations and clears them on confirm', async () => {
    const n = new NonceManager(source(0));
    const a = await n.reserve();
    expect(n.pendingCount).toBe(1);
    n.confirm(a);
    expect(n.pendingCount).toBe(0);
  });

  it('resync re-reads the chain and counts itself', async () => {
    const src = source(3);
    const n = new NonceManager(src);
    await n.reserve();
    src.count = 9;
    expect(await n.resync()).toBe(9);
    expect(n.resyncCount).toBe(1);
    expect(await n.reserve()).toBe(9);
  });
});

describe('T-033 strict serialization', () => {
  it('never runs two tasks at the same time', async () => {
    const { q } = mk();
    let concurrent = 0;
    let maxConcurrent = 0;
    const task = (id: string) => q.submit({
      clientOrderId: id,
      run: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(5);
        concurrent--;
        return id;
      },
    });
    await Promise.all([task('a'), task('b'), task('c'), task('d')]);
    expect(maxConcurrent).toBe(1);
  });

  it('executes in submission order', async () => {
    const { q } = mk();
    const order: string[] = [];
    const task = (id: string, delay: number) => q.submit({
      clientOrderId: id,
      run: async () => { await sleep(delay); order.push(id); return id; },
    });
    // The first is slowest: a non-serializing queue would finish it last.
    await Promise.all([task('first', 20), task('second', 5), task('third', 1)]);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('returns each task its own result', async () => {
    const { q } = mk();
    const out = await Promise.all([1, 2, 3].map((i) =>
      q.submit({ clientOrderId: `t${i}`, run: async () => i * 10 })));
    expect(out).toEqual([10, 20, 30]);
  });

  it('a failing task does not stall the queue behind it', async () => {
    const { q } = mk();
    const boom = q.submit({ clientOrderId: 'boom', run: async () => { throw new Error('nope'); } });
    const after = q.submit({ clientOrderId: 'after', run: async () => 'ok' });
    await expect(boom).rejects.toThrow('nope');
    await expect(after).resolves.toBe('ok');
  });

  it('a rejected task does not poison later submissions', async () => {
    const { q } = mk();
    for (let i = 0; i < 5; i++) {
      await q.submit({ clientOrderId: `f${i}`, run: async () => { throw new Error('x'); } })
        .catch(() => undefined);
    }
    await expect(q.submit({ clientOrderId: 'good', run: async () => 42 })).resolves.toBe(42);
  });

  it('assigns nonces in execution order under concurrent submission', async () => {
    const { q } = mk();
    const seen: number[] = [];
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      q.submit({ clientOrderId: `n${i}`, run: async (nonce) => { seen.push(nonce); return nonce; } })));
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});

describe('T-033 deduplication by clientOrderId', () => {
  it('runs the task once and returns the same result for a repeat', async () => {
    const { q } = mk();
    const run = vi.fn(async () => 'once');
    const a = await q.submit({ clientOrderId: 'same', run });
    const b = await q.submit({ clientOrderId: 'same', run });
    expect(a).toBe('once');
    expect(b).toBe('once');
    expect(run).toHaveBeenCalledTimes(1);
    expect(q.statsSnapshot().deduped).toBe(1);
  });

  it('dedupes a concurrent repeat, not just a sequential one', async () => {
    const { q } = mk();
    const run = vi.fn(async () => { await sleep(5); return 'v'; });
    const [a, b] = await Promise.all([
      q.submit({ clientOrderId: 'same', run }),
      q.submit({ clientOrderId: 'same', run }),
    ]);
    expect(a).toBe(b);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('consumes only one nonce for a deduped submission', async () => {
    const { q, nonces } = mk();
    const run = async (n: number) => n;
    await q.submit({ clientOrderId: 'same', run });
    await q.submit({ clientOrderId: 'same', run });
    expect(await nonces.reserve()).toBe(1);        // only nonce 0 was used
  });

  it('replays a failure rather than silently retrying it', async () => {
    // A repeated id must not become a second attempt: that is how one intent
    // becomes two positions.
    const { q } = mk();
    const run = vi.fn(async () => { throw new Error('rejected by pool'); });
    await expect(q.submit({ clientOrderId: 'dup', run })).rejects.toThrow(/rejected/);
    await expect(q.submit({ clientOrderId: 'dup', run })).rejects.toThrow(/rejected/);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('T-033 nonce clash recovery', () => {
  it('retries once with a refreshed nonce', async () => {
    const src = source(0);
    const nonces = new NonceManager(src);
    const q = new TxQueue({ nonces, timeoutMs: 0 });
    let calls = 0;
    const seen: number[] = [];
    const out = await q.submit({
      clientOrderId: 'clash',
      run: async (nonce) => {
        seen.push(nonce);
        calls++;
        if (calls === 1) { src.count = 7; throw new Error('nonce too low'); }
        return nonce;
      },
    });
    expect(calls).toBe(2);
    expect(seen).toEqual([0, 7]);
    expect(out).toBe(7);
    expect(nonces.resyncCount).toBe(1);
    expect(q.statsSnapshot().retried).toBe(1);
  });

  it('retries at most once — a surviving clash is a real error', async () => {
    const { q } = mk();
    let calls = 0;
    await expect(q.submit({
      clientOrderId: 'always',
      run: async () => { calls++; throw new Error('nonce too low'); },
    })).rejects.toThrow(/nonce/);
    expect(calls).toBe(2);
  });

  it('produces exactly one position effect across a clash retry', async () => {
    // The point of the whole mechanism: a retry must not double-apply.
    const { q } = mk();
    let applied = 0;
    let attempts = 0;
    await q.submit({
      clientOrderId: 'once-only',
      run: async (nonce) => {
        attempts++;
        if (attempts === 1) throw new Error('nonce too low');   // failed before applying
        applied++;
        return nonce;
      },
    });
    expect(applied).toBe(1);
  });

  it('does not retry an unrelated error', async () => {
    const { q } = mk();
    let calls = 0;
    await expect(q.submit({
      clientOrderId: 'other',
      run: async () => { calls++; throw new Error('insufficient funds'); },
    })).rejects.toThrow(/insufficient/);
    expect(calls).toBe(1);
  });

  it('honours a custom clash classifier', async () => {
    const { q } = mk();
    let calls = 0;
    await q.submit({
      clientOrderId: 'custom',
      run: async (n) => { calls++; if (calls === 1) throw new Error('WEIRD_VENUE_CODE_42'); return n; },
      isNonceClash: (e) => /WEIRD_VENUE_CODE_42/.test(String(e)),
    });
    expect(calls).toBe(2);
  });

  it('releases the nonce on failure so later work is not stranded', async () => {
    const { q, nonces } = mk();
    await q.submit({ clientOrderId: 'f', run: async () => { throw new Error('insufficient funds'); } })
      .catch(() => undefined);
    expect(nonces.pendingCount).toBe(0);
    expect(await nonces.reserve()).toBe(0);       // reusable, no gap
  });
});

describe('T-033 observability and timeouts', () => {
  it('exposes queue depth so health can see a backlog', async () => {
    const { q } = mk();
    // Resolvers are created UP FRONT, not as tasks start: the queue is
    // serialized, so a gate collected inside `run` only ever holds one entry
    // and releasing it would deadlock the rest.
    const release: (() => void)[] = [];
    const gates = Array.from({ length: 4 }, () =>
      new Promise<void>((res) => { release.push(res); }));
    const tasks = gates.map((g, i) => q.submit({
      clientOrderId: `d${i}`,
      run: async () => { await g; return i; },
    }));
    await sleep(5);
    const s = q.statsSnapshot();
    expect(s.inFlight).toBe(1);
    expect(s.depth).toBe(3);
    for (const r of release) r();
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3]);
    expect(q.statsSnapshot().depth).toBe(0);
  });

  it('times out a stalled item with an error rather than hanging forever', async () => {
    const errs: string[] = [];
    const { q } = mk({ timeoutMs: 20, onError: (e) => errs.push(e.message) });
    await expect(q.submit({
      clientOrderId: 'stalled',
      run: () => new Promise(() => { /* never settles */ }),
    })).rejects.toThrow(/did not settle within 20 ms/);
    expect(errs).toHaveLength(1);
    expect(q.statsSnapshot().timedOut).toBe(1);
  });

  it('a timeout does not block the next item', async () => {
    const { q } = mk({ timeoutMs: 20 });
    const stalled = q.submit({ clientOrderId: 's', run: () => new Promise(() => {}) });
    const next = q.submit({ clientOrderId: 'n', run: async () => 'fine' });
    await expect(stalled).rejects.toThrow();
    await expect(next).resolves.toBe('fine');
  });

  it('counts submitted, completed, failed and deduped', async () => {
    const { q } = mk();
    await q.submit({ clientOrderId: 'a', run: async () => 1 });
    await q.submit({ clientOrderId: 'a', run: async () => 1 });
    await q.submit({ clientOrderId: 'b', run: async () => { throw new Error('insufficient funds'); } })
      .catch(() => undefined);
    const s = q.statsSnapshot();
    expect(s.submitted).toBe(2);
    expect(s.completed).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.deduped).toBe(1);
  });

  it('drain resolves only after every in-flight item has settled', async () => {
    const { q } = mk();
    let done = 0;
    for (let i = 0; i < 10; i++) {
      void q.submit({ clientOrderId: `x${i}`, run: async () => { await sleep(2); done++; return i; } });
    }
    await q.drain();
    expect(done).toBe(10);
  });

  it('drain on an empty queue resolves immediately', async () => {
    const { q } = mk();
    await expect(q.drain()).resolves.toBeUndefined();
  });
});
