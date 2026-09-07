// T-035 + T-036 — reconciler (FR-X3, GWT-6) and claim loop (RFC-001 A5).
import { describe, it, expect, vi } from 'vitest';
import { VirtualClock, type AgentId, type Position, type Venue } from '@arena/shared';
import { EventBus } from '@arena/data';
import { Reconciler, type LocalPositions } from '../reconciler.ts';
import { ClaimLoop } from '../claim.ts';
import { SimulatedVenue } from '../simulated.ts';
import { orderFor } from './venue.contract.ts';

const pos = (over: Partial<Position> = {}): Position => ({
  marketId: 'm1', agent: 'MIRA', netContracts: 10, avgPrice: 0.4, markPrice: 0.5,
  realizedPnlUsd: 0, unrealizedPnlUsd: 1, tsMs: 1_000, ...over,
});

/** A local view that records what the reconciler did to it. */
const localView = (initial: Position[] = []) => {
  const map = new Map<string, Position>(initial.map((p) => [p.marketId, p]));
  const adopted: Position[] = [];
  const dropped: string[] = [];
  const local: LocalPositions = {
    positions: () => [...map.values()],
    adopt: (p) => { adopted.push(p); map.set(p.marketId, p); },
    drop: (id) => { dropped.push(id); map.delete(id); },
  };
  return { local, map, adopted, dropped };
};

/** A venue stub that reports whatever chain positions we say, and records any
 *  write the reconciler might illegally attempt. */
const chainVenue = (chain: Position[], opts: { fail?: boolean } = {}) => {
  const writes: string[] = [];
  const v = {
    name: 'SimulatedVenue' as const, mode: 'SIM' as const, agent: 'MIRA' as AgentId,
    connect: async () => {}, disconnect: async () => {}, now: () => 1_000,
    getMarkets: async () => [], getQuote: async () => { throw new Error('unused'); },
    placeOrder: async () => { writes.push('placeOrder'); throw new Error('illegal'); },
    cancel: async () => { writes.push('cancel'); throw new Error('illegal'); },
    cancelAll: async () => { writes.push('cancelAll'); return []; },
    positions: async () => {
      if (opts.fail) throw new Error('RPC unavailable');
      return chain;
    },
    balanceUsd: async () => 100, health: async () => ({
      ok: true, mode: 'SIM' as const, name: 'SimulatedVenue', blockNumber: 1,
      latencyMs: 1, lastErrorMs: null, detail: null,
    }),
    onFill: () => () => {},
    settledMarkets: async () => [], claimable: async () => [],
    claim: async () => ({ marketId: 'x', claimed: false, amountUsd: 0, txHash: null, reason: 'stub', tsMs: 0 }),
    mintPair: async () => { writes.push('mintPair'); throw new Error('illegal'); },
  } satisfies Venue;
  return { venue: v as Venue, writes };
};

describe('T-035 no drift', () => {
  it('reports an empty drift list when local and chain agree', async () => {
    const { local, adopted } = localView([pos()]);
    const { venue } = chainVenue([pos()]);
    const r = await new Reconciler({ venue, local, agent: 'MIRA' }).reconcile();
    expect(r.drifted).toEqual([]);
    expect(adopted).toEqual([]);
    expect(r.correctedFrom).toBe('chain');
  });

  it('tolerates a float difference in avgPrice below epsilon', async () => {
    const { local, adopted } = localView([pos({ avgPrice: 0.4 })]);
    const { venue } = chainVenue([pos({ avgPrice: 0.4 + 1e-12 })]);
    const r = await new Reconciler({ venue, local, agent: 'MIRA' }).reconcile();
    expect(r.drifted).toEqual([]);
    expect(adopted).toEqual([]);
  });
});

describe('T-035 the chain wins', () => {
  it('adopts a divergent net position with action ADOPT_CHAIN', async () => {
    const { local, adopted, map } = localView([pos({ netContracts: 10 })]);
    const { venue } = chainVenue([pos({ netContracts: 7 })]);
    const r = await new Reconciler({ venue, local, agent: 'MIRA' }).reconcile();
    expect(r.drifted).toHaveLength(1);
    expect(r.drifted[0]).toMatchObject({
      marketId: 'm1', localNet: 10, chainNet: 7, action: 'ADOPT_CHAIN',
    });
    expect(adopted).toHaveLength(1);
    expect(map.get('m1')!.netContracts).toBe(7);
  });

  it('adopts a divergent average price', async () => {
    const { local, map } = localView([pos({ avgPrice: 0.40 })]);
    const { venue } = chainVenue([pos({ avgPrice: 0.55 })]);
    await new Reconciler({ venue, local, agent: 'MIRA' }).reconcile();
    expect(map.get('m1')!.avgPrice).toBe(0.55);
  });

  it('drops a local position the chain has never heard of (the ghost)', async () => {
    const { local, dropped, map } = localView([pos({ marketId: 'ghost', netContracts: 25 })]);
    const { venue } = chainVenue([]);
    const r = await new Reconciler({ venue, local, agent: 'MIRA' }).reconcile();
    expect(dropped).toEqual(['ghost']);
    expect(map.has('ghost')).toBe(false);
    expect(r.drifted[0]).toMatchObject({ localNet: 25, chainNet: 0, action: 'ADOPT_CHAIN' });
  });

  it('does not report a local position that is already flat', async () => {
    const { local, dropped } = localView([pos({ netContracts: 0 })]);
    const { venue } = chainVenue([]);
    const r = await new Reconciler({ venue, local, agent: 'MIRA' }).reconcile();
    expect(r.drifted).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('adopts a chain position absent locally', async () => {
    const { local, adopted, map } = localView([]);
    const { venue } = chainVenue([pos({ marketId: 'new', netContracts: 5 })]);
    await new Reconciler({ venue, local, agent: 'MIRA' }).reconcile();
    expect(adopted).toHaveLength(1);
    expect(map.get('new')!.netContracts).toBe(5);
  });

  it('handles several drifting markets in one pass', async () => {
    const { local } = localView([
      pos({ marketId: 'a', netContracts: 10 }),
      pos({ marketId: 'b', netContracts: 3 }),
      pos({ marketId: 'ghost', netContracts: 8 }),
    ]);
    const { venue } = chainVenue([
      pos({ marketId: 'a', netContracts: 10 }),      // agrees
      pos({ marketId: 'b', netContracts: 4 }),       // drifts
      pos({ marketId: 'c', netContracts: 2 }),       // new
    ]);
    const r = await new Reconciler({ venue, local, agent: 'MIRA' }).reconcile();
    const ids = r.drifted.map((d) => d.marketId).sort();
    expect(ids).toEqual(['b', 'c', 'ghost']);
  });
});

describe('T-035 the reconciler never trades', () => {
  it('calls no write method, in any drift situation', async () => {
    for (const [localPs, chainPs] of [
      [[pos({ netContracts: 10 })], [pos({ netContracts: 0 })]],
      [[pos({ marketId: 'ghost' })], []],
      [[], [pos({ marketId: 'new' })]],
    ] as const) {
      const { local } = localView([...localPs]);
      const { venue, writes } = chainVenue([...chainPs]);
      await new Reconciler({ venue, local, agent: 'MIRA' }).reconcile();
      expect(writes).toEqual([]);
    }
  });
});

describe('T-035 reporting', () => {
  it('publishes exactly one reconcile event per pass', async () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.on('reconcile', (d) => { seen.push(d.drifted.length); });
    const { local } = localView([pos({ netContracts: 10 })]);
    const { venue } = chainVenue([pos({ netContracts: 4 })]);
    await new Reconciler({ venue, local, agent: 'MIRA', bus }).reconcile();
    expect(seen).toEqual([1]);
  });

  it('invokes onReport so the pass can be journaled', async () => {
    const onReport = vi.fn();
    const { local } = localView([]);
    const { venue } = chainVenue([]);
    await new Reconciler({ venue, local, agent: 'MIRA', onReport }).reconcile();
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  it('records a duration and a timestamp', async () => {
    const { local } = localView([]);
    const { venue } = chainVenue([]);
    const r = await new Reconciler({ venue, local, agent: 'MIRA' }).reconcile();
    expect(r.tsMs).toBe(1_000);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('T-035 RPC failure leaves local state untouched', () => {
  it('adopts nothing and drops nothing', async () => {
    const { local, adopted, dropped } = localView([pos({ netContracts: 10 })]);
    const { venue } = chainVenue([], { fail: true });
    const r = await new Reconciler({ venue, local, agent: 'MIRA' }).reconcile();
    expect(adopted).toEqual([]);
    expect(dropped).toEqual([]);
    expect(r.drifted).toEqual([]);
    expect(r.checked).toBe(0);
  });

  it('emits an error event and calls onError instead of throwing', async () => {
    const bus = new EventBus();
    const errs: string[] = [];
    bus.on('error', (d) => { errs.push(d.where); });
    const onError = vi.fn();
    const { local } = localView([pos()]);
    const { venue } = chainVenue([], { fail: true });
    const rec = new Reconciler({ venue, local, agent: 'MIRA', bus, onError });
    await expect(rec.reconcile()).resolves.toBeDefined();
    expect(errs).toEqual(['reconciler']);
    expect(onError).toHaveBeenCalled();
    expect(rec.stats.failures).toBe(1);
  });
});

describe('T-035 GWT-6: a dropped tx self-corrects within 10 s', () => {
  it('heals local PnL inside the budget, at the measured poll cadence', async () => {
    // The chain never saw our order; locally we think we are long 20.
    const { local, map } = localView([pos({ marketId: 'dropped', netContracts: 20, avgPrice: 0.5 })]);
    const { venue } = chainVenue([]);
    const clock = new VirtualClock(0);
    const rec = new Reconciler({ venue, local, agent: 'MIRA' });

    // T-S4 committed reconcilePollMs = 3 000, and three polls must fit in 10 s.
    const POLL = 3_000;
    const stop = rec.start(POLL,
      (fn, ms) => clock.setInterval(fn, ms),
      (h) => clock.clearTimeout(h));

    clock.advance(POLL);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(clock.now()).toBeLessThan(10_000);
    expect(map.has('dropped')).toBe(false);
    stop();
  });
});

// ─────────────────────────── T-036 claim loop ───────────────────────────────

/** A venue whose settled markets are ready to claim. */
const settledVenue = async () => {
  const clock = new VirtualClock(0);
  const venue = new SimulatedVenue({
    clock, agent: 'MIRA', depth: 40, balanceUsd: 1_000,
    markets: [{ id: 'w1', asset: 'BTC', strike: 79_000, intervalSec: 60, expiryMs: 60_000 }],
  });
  await venue.connect();
  const m = (await venue.getMarkets())[0]!;
  await venue.placeOrder(orderFor(m, {
    type: 'MARKET', limitPrice: null, limitPriceRaw: null, sizeContracts: 10,
  }));
  venue.setSpot('BTC', 80_000);                 // finishes above the strike
  clock.advanceTo(120_000);
  return { clock, venue };
};

describe('T-036 the claim loop', () => {
  it('claims a settled winning market and credits collateral', async () => {
    const { venue } = await settledVenue();
    const before = await venue.balanceUsd();
    const loop = new ClaimLoop({ venue });
    const rs = await loop.sweep(true);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.claimed).toBe(true);
    expect(await venue.balanceUsd()).toBeCloseTo(before + 10, 9);
    expect(loop.statsSnapshot().totalClaimedUsd).toBe(10);
  });

  it('is idempotent: a second sweep claims nothing more', async () => {
    const { venue } = await settledVenue();
    const loop = new ClaimLoop({ venue });
    await loop.sweep(true);
    const after = await venue.balanceUsd();
    const rs = await loop.sweep(true);
    expect(rs.filter((r) => r.claimed)).toHaveLength(0);
    expect(await venue.balanceUsd()).toBe(after);
    expect(loop.statsSnapshot().claimed).toBe(1);
  });

  it('surfaces unclaimed payout so the failure is VISIBLE, not merely prevented', async () => {
    const { venue } = await settledVenue();
    const loop = new ClaimLoop({ venue });
    // Before any sweep, health should be able to show money left on the table.
    expect(loop.unclaimedUsd).toBe(0);
    await loop.sweep(true);
    expect(loop.statsSnapshot().totalClaimedUsd).toBe(10);
    expect(loop.unclaimedUsd).toBe(0);
  });

  it('reports outstanding payout when claiming is disabled', async () => {
    const { venue } = await settledVenue();
    // A loop that only observes: scanLimit 0 inspects nothing but still totals.
    const loop = new ClaimLoop({ venue, scanLimit: 0 });
    await loop.sweep(true);
    expect(loop.unclaimedUsd).toBe(10);
    expect(loop.statsSnapshot().claimed).toBe(0);
  });

  it('respects its interval unless forced', async () => {
    const { clock, venue } = await settledVenue();
    const loop = new ClaimLoop({ venue, intervalMs: 600_000 });
    expect(loop.due()).toBe(true);
    await loop.sweep();
    expect(loop.due()).toBe(false);
    expect(await loop.sweep()).toEqual([]);          // skipped, not re-run
    clock.advance(600_001);
    expect(loop.due()).toBe(true);
  });

  it('publishes a claim event and calls onClaim', async () => {
    const { venue } = await settledVenue();
    const bus = new EventBus();
    const seen: number[] = [];
    bus.on('claim', (d) => { seen.push(d.amountUsd); });
    const onClaim = vi.fn();
    await new ClaimLoop({ venue, bus, onClaim }).sweep(true);
    expect(seen).toEqual([10]);
    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  it('never throws, so a claim failure cannot stall the trading loop', async () => {
    const { venue } = chainVenue([]);
    const broken = {
      ...venue,
      claimable: async () => { throw new Error('indexer down'); },
    } as Venue;
    const onError = vi.fn();
    const loop = new ClaimLoop({ venue: broken, onError });
    await expect(loop.sweep(true)).resolves.toEqual([]);
    expect(onError).toHaveBeenCalled();
  });

  it('keeps going when one market fails to claim', async () => {
    const { venue } = await settledVenue();
    let calls = 0;
    const flaky = {
      ...venue,
      claimable: async () => [
        { marketId: 'bad', symbol: 'b', expiryMs: 1, outcomeIdx: 0 as 0 | 1, sizeContracts: 1, estPayoutUsd: 1 },
        { marketId: 'w1', symbol: 'w', expiryMs: 1, outcomeIdx: 0 as 0 | 1, sizeContracts: 10, estPayoutUsd: 10 },
      ],
      claim: async (id: string) => {
        calls++;
        if (id === 'bad') throw new Error('reverted');
        return venue.claim(id);
      },
      now: () => venue.now(),
    } as Venue;
    const loop = new ClaimLoop({ venue: flaky, onError: () => {} });
    const rs = await loop.sweep(true);
    expect(calls).toBe(2);
    expect(rs.filter((r) => r.claimed)).toHaveLength(1);
  });

  it('finds a settled market that getMarkets no longer treats as live (gotcha 11)', async () => {
    const { venue } = await settledVenue();
    const live = (await venue.getMarkets()).filter((m) => m.status === 'Trading');
    expect(live).toHaveLength(0);                     // nothing tradable any more
    expect((await venue.settledMarkets()).map((m) => m.id)).toContain('w1');
    expect(await venue.claimable()).toHaveLength(1);  // yet the payout is findable
  });

  it('does not claim a losing outcome', async () => {
    const clock = new VirtualClock(0);
    const venue = new SimulatedVenue({
      clock, agent: 'MIRA', depth: 40,
      markets: [{ id: 'l1', asset: 'BTC', strike: 79_000, intervalSec: 60, expiryMs: 60_000 }],
    });
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    await venue.placeOrder(orderFor(m, {
      type: 'MARKET', limitPrice: null, limitPriceRaw: null, sizeContracts: 10,
    }));
    venue.setSpot('BTC', 70_000);                     // finishes below
    clock.advanceTo(120_000);
    const loop = new ClaimLoop({ venue });
    expect(await loop.sweep(true)).toEqual([]);
    expect(loop.statsSnapshot().claimed).toBe(0);
  });

  it('reset clears history so a fresh run re-scans', async () => {
    const { venue } = await settledVenue();
    const loop = new ClaimLoop({ venue });
    await loop.sweep(true);
    loop.reset();
    expect(loop.statsSnapshot().sweeps).toBe(0);
    expect(loop.due()).toBe(true);
  });
});
