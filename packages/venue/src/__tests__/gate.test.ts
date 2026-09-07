// The RPC lane must allow concurrency. T-S4 measured a 1-rps limit on the
// INDEXER; `eth_call` reads (order book, on-chain status, balances) were given
// the same serial lane and starved the write path — placeOrder took 2.8s alone
// but blew a 30s timeout under agent load. THROTTLE.rpcMaxInFlight is 4.
import { describe, it, expect } from 'vitest';
import { ConcurrentGate } from '../gate.ts';

const defer = () => {
  let resolve!: (v?: unknown) => void;
  const p = new Promise((r) => { resolve = r as never; });
  return { p, resolve };
};

describe('ConcurrentGate', () => {
  it('runs up to `limit` tasks at once', async () => {
    const gate = new ConcurrentGate(4);
    const d = [defer(), defer(), defer(), defer(), defer()];
    let started = 0;
    const runs = d.map((x) => gate.run(async () => { started++; await x.p; return started; }));
    await Promise.resolve(); await Promise.resolve();
    expect(started, 'four in flight, the fifth waits').toBe(4);
    d[0]!.resolve();
    await runs[0];
    await Promise.resolve(); await Promise.resolve();
    expect(started, 'the fifth starts when a slot frees').toBe(5);
    for (const x of d) x.resolve();
    await Promise.all(runs);
  });

  it('a limit of 1 is strictly serial (the indexer lane)', async () => {
    const gate = new ConcurrentGate(1);
    const order: number[] = [];
    const mk = (n: number) => gate.run(async () => {
      order.push(n);
      await new Promise((r) => setTimeout(r, 1));
      order.push(-n);
    });
    await Promise.all([mk(1), mk(2), mk(3)]);
    // strict serialization: each task completes before the next begins
    expect(order).toEqual([1, -1, 2, -2, 3, -3]);
  });

  it('a rejecting task frees its slot and never poisons the lane', async () => {
    const gate = new ConcurrentGate(1);
    await expect(gate.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
    expect(gate.inFlight).toBe(0);
  });

  it('reports depth so starvation is observable rather than guessed at', async () => {
    const gate = new ConcurrentGate(1);
    const d = defer();
    const a = gate.run(async () => { await d.p; });
    const b = gate.run(async () => 'second');
    await Promise.resolve();
    expect(gate.inFlight).toBe(1);
    expect(gate.waiting).toBe(1);
    d.resolve();
    await Promise.all([a, b]);
    expect(gate.waiting).toBe(0);
  });

  it('preserves each task\'s own result and ordering of resolution', async () => {
    const gate = new ConcurrentGate(2);
    const vals = await Promise.all([1, 2, 3, 4, 5].map((n) => gate.run(async () => n * 10)));
    expect(vals).toEqual([10, 20, 30, 40, 50]);
  });

  it('treats a non-positive limit as 1 rather than deadlocking', async () => {
    const gate = new ConcurrentGate(0);
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });
});
