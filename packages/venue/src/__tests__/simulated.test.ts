// T-031 — SimulatedVenue. Runs the shared conformance oracle (T-030) plus the
// properties only a simulator can promise: a virtual clock, seeded determinism
// and a book whose physics match the chain's.
import { describe, it, expect } from 'vitest';
import { VirtualClock } from '@arena/shared';
import { SimulatedVenue, mulberry32 } from '../simulated.ts';
import { runVenueContract, orderFor, type VenueHarness } from './venue.contract.ts';

const make = async (): Promise<VenueHarness> => {
  const clock = new VirtualClock(0);
  const venue = new SimulatedVenue({ clock, agent: 'MIRA' });
  await venue.connect();
  return {
    venue,
    advance: async (ms) => { clock.advance(ms); },
    otherAgent: async () => {
      const v = new SimulatedVenue({ clock, agent: 'ECHO' });
      await v.connect();
      return v;
    },
    dispose: async () => { await venue.disconnect(); },
    canFill: true,
  };
};

// The shared oracle. Passing this is what makes the LIVE/SIM swap safe (GWT-8).
runVenueContract({ name: 'SimulatedVenue', make });

const mk = (over: Partial<ConstructorParameters<typeof SimulatedVenue>[0]> = {}) => {
  const clock = new VirtualClock(0);
  const venue = new SimulatedVenue({ clock, agent: 'MIRA', ...over });
  return { clock, venue };
};

describe('T-031 the virtual clock', () => {
  it('reports the clock, not wall time', async () => {
    const { clock, venue } = mk();
    expect(venue.now()).toBe(0);
    clock.advance(12_345);
    expect(venue.now()).toBe(12_345);
  });

  it('advances an hour of market in under 10 ms of real time', async () => {
    const { clock, venue } = mk();
    await venue.connect();
    const t0 = performance.now();
    clock.advance(3_600_000);
    expect(performance.now() - t0).toBeLessThan(10);
    expect(venue.now()).toBe(3_600_000);
  });
});

describe('T-031 seeded determinism (40-TESTPLAN §6 rule 3)', () => {
  it('the PRNG is reproducible', () => {
    const a = mulberry32(7); const b = mulberry32(7);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('two venues with the same seed produce an identical fill sequence', async () => {
    const run = async (seed: number) => {
      const { clock, venue } = mk({ seed });
      await venue.connect();
      const fills: string[] = [];
      venue.onFill((f) => fills.push(`${f.side} ${f.sizeContracts} @${f.price.toFixed(6)}`));
      const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
      for (let i = 0; i < 10; i++) {
        await venue.placeOrder(orderFor(m, {
          clientOrderId: `o${i}`, type: 'MARKET', limitPrice: null, limitPriceRaw: null, sizeContracts: 2,
        }));
        clock.advance(100);
      }
      return fills;
    };
    expect(await run(99)).toEqual(await run(99));
  });

  it('reading a quote does not move the book (noise is positional, not a stream)', async () => {
    const { venue } = mk({ seed: 5 });
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    const a = await venue.getQuote(m.id);
    const b = await venue.getQuote(m.id);
    expect(b).toEqual(a);
  });

  it('different seeds produce different books once noise exceeds the tick', async () => {
    // Noise is +/- spread*0.05, and every level snaps to the tick grid. At the
    // default spread of 0.02 that noise is +/-0.001 against a 0.001 tick, so it
    // rounds away and seeds are INDISTINGUISHABLE — which is correct: a venue
    // cannot quote finer than its own grid. Widen the spread and the seed shows.
    const quoteFor = async (seed: number) => {
      const { venue } = mk({ seed, spread: 0.4 });
      await venue.connect();
      const m = (await venue.getMarkets())[0]!;
      return (await venue.getQuote(m.id)).bid;
    };
    expect(await quoteFor(1)).not.toBe(await quoteFor(2));
  });

  it('sub-tick noise is invisible, because a venue cannot quote finer than its grid', async () => {
    const quoteFor = async (seed: number) => {
      const { venue } = mk({ seed, spread: 0.02, tickRaw: 100_000n });   // coarse grid
      await venue.connect();
      const m = (await venue.getMarkets())[0]!;
      return (await venue.getQuote(m.id)).bid;
    };
    expect(await quoteFor(1)).toBe(await quoteFor(2));
  });
});

describe('T-031 the order book is a real CLOB (S3 C4)', () => {
  it('a limit order far from the mid rests instead of crossing', async () => {
    const { venue } = mk();
    await venue.connect();
    const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
    const ack = await venue.placeOrder(orderFor(m, {
      limitPrice: 0.02, limitPriceRaw: 20_000n, sizeContracts: 5,
    }));
    expect(ack.status).toBe('ACCEPTED');
    expect(venue.openOrders()).toHaveLength(1);
  });

  it('a limit order fills only once the quote crosses its price', async () => {
    const { venue } = mk({ spread: 0.02 });
    await venue.connect();
    const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
    let fills = 0;
    venue.onFill(() => { fills++; });
    // Bid well below the book: no cross.
    await venue.placeOrder(orderFor(m, { clientOrderId: 'far', limitPrice: 0.05, limitPriceRaw: 50_000n }));
    expect(fills).toBe(0);
    // Move the fair price down so the ask comes to us.
    venue.setFairProb(m.id, 0.04);
    await venue.placeOrder(orderFor(m, { clientOrderId: 'near', limitPrice: 0.05, limitPriceRaw: 50_000n }));
    expect(fills).toBeGreaterThan(0);
  });

  it('consumes depth across levels, so a large order pays worse prices', async () => {
    const { venue } = mk({ depth: 4, levels: 3, spread: 0.02 });
    await venue.connect();
    const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
    const prices: number[] = [];
    venue.onFill((f) => prices.push(f.price));
    await venue.placeOrder(orderFor(m, {
      type: 'MARKET', limitPrice: null, limitPriceRaw: null, sizeContracts: 7,
    }));
    expect(prices.length).toBeGreaterThan(1);            // walked more than one level
    // Buying YES: each successive level costs more.
    for (let i = 1; i < prices.length; i++) expect(prices[i]!).toBeGreaterThan(prices[i - 1]!);
  });

  it('partially fills when depth runs out, and rests the remainder', async () => {
    const { venue } = mk({ depth: 2, levels: 1, spread: 0.02 });
    await venue.connect();
    const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
    let filled = 0;
    venue.onFill((f) => { filled += f.sizeContracts; });
    await venue.placeOrder(orderFor(m, { limitPrice: 0.9, limitPriceRaw: 900_000n, sizeContracts: 10 }));
    expect(filled).toBeGreaterThan(0);
    expect(filled).toBeLessThan(10);
    expect(venue.openOrders().length).toBeGreaterThan(0);
  });

  it('a FILL_OR_KILL remainder is dropped rather than rested', async () => {
    const { venue } = mk({ depth: 2, levels: 1 });
    await venue.connect();
    const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
    await venue.placeOrder(orderFor(m, {
      type: 'FILL_OR_KILL', limitPrice: 0.9, limitPriceRaw: 900_000n, sizeContracts: 10,
    }));
    expect(venue.openOrders()).toHaveLength(0);
  });

  it('a resting order can be consumed by an opposing order', async () => {
    const { venue } = mk({ depth: 0 });                  // no synthetic liquidity
    await venue.connect();
    const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
    await venue.placeOrder(orderFor(m, {
      clientOrderId: 'resting-bid', kind: 'BUY_YES', side: 'YES',
      limitPrice: 0.4, limitPriceRaw: 400_000n, sizeContracts: 5,
    }));
    expect(venue.openOrders()).toHaveLength(1);
    // Mint inventory, then sell into that bid.
    await venue.mintPair(m.id, 10);
    let fills = 0;
    venue.onFill(() => { fills++; });
    await venue.placeOrder(orderFor(m, {
      clientOrderId: 'taker-ask', kind: 'SELL_YES', side: 'YES',
      limitPrice: 0.3, limitPriceRaw: 300_000n, sizeContracts: 5,
    }));
    expect(fills).toBeGreaterThan(0);
  });

  it('quotes bid <= ask with the configured spread', async () => {
    const { venue } = mk({ spread: 0.05 });
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    const q = await venue.getQuote(m.id);
    expect(q.ask - q.bid).toBeGreaterThan(0.02);
    expect(q.bid).toBeLessThanOrEqual(q.mid);
    expect(q.mid).toBeLessThanOrEqual(q.ask);
  });
});

describe('T-031 configured latency', () => {
  it('queues rather than accepting, and fills exactly at the configured delay', async () => {
    const { clock, venue } = mk({ latencyMs: 250 });
    await venue.connect();
    const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
    const at: number[] = [];
    venue.onFill(() => at.push(clock.now()));
    const ack = await venue.placeOrder(orderFor(m, {
      type: 'MARKET', limitPrice: null, limitPriceRaw: null, sizeContracts: 2,
    }));
    expect(ack.status).toBe('QUEUED');
    clock.advance(249);
    expect(at).toHaveLength(0);
    clock.advance(1);
    expect(at).toEqual([250]);
  });

  it('matches inline when latency is zero', async () => {
    const { venue } = mk({ latencyMs: 0 });
    await venue.connect();
    const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
    let fills = 0;
    venue.onFill(() => { fills++; });
    const ack = await venue.placeOrder(orderFor(m, {
      type: 'MARKET', limitPrice: null, limitPriceRaw: null, sizeContracts: 2,
    }));
    expect(ack.status).toBe('ACCEPTED');
    expect(fills).toBeGreaterThan(0);
  });
});

describe('T-031 the market lifecycle walks the chain statuses (RFC-001 A3)', () => {
  it('goes Listed -> Trading -> Locked -> Settling -> Resolved on the virtual clock', async () => {
    const { clock, venue } = mk({
      markets: [{ id: 'lc', asset: 'BTC', strike: 79_000, intervalSec: 60,
        tradingStartMs: 1_000, expiryMs: 61_000 }],
      lockMs: 5_000, settlingMs: 5_000,
    });
    await venue.connect();
    const statusAt = async (t: number) => {
      clock.advanceTo(t);
      return (await venue.getMarkets())[0]!.status;
    };
    expect(await statusAt(0)).toBe('Listed');
    expect(await statusAt(1_000)).toBe('Trading');
    expect(await statusAt(60_999)).toBe('Trading');
    expect(await statusAt(61_000)).toBe('Locked');
    expect(await statusAt(66_000)).toBe('Settling');
    expect(await statusAt(71_000)).toBe('Resolved');
  });

  it('refuses orders in every status but Trading', async () => {
    const { clock, venue } = mk({
      markets: [{ id: 'lc', asset: 'BTC', strike: 79_000, intervalSec: 60,
        tradingStartMs: 1_000, expiryMs: 61_000 }],
    });
    await venue.connect();
    for (const [t, status] of [[0, 'Listed'], [61_000, 'Locked'], [80_000, 'Resolved']] as const) {
      clock.advanceTo(t);
      const m = (await venue.getMarkets())[0]!;
      expect(m.status).toBe(status);
      const ack = await venue.placeOrder(orderFor(m, { clientOrderId: `o${t}`, expiresMs: t + 1_000 }));
      expect(ack.status).toBe('REJECTED');
      expect(ack.reason).toMatch(/status/i);
    }
  });
});

describe('T-031 reference-mode boundary (S1 C3, RFC-001 A4)', () => {
  it('reports boundaryPosted false and a null strike until the boundary posts', async () => {
    const { venue } = mk();
    await venue.connect();
    const ref = (await venue.getMarkets()).find((m) => m.mode === 'reference')!;
    expect(ref.boundaryPosted).toBe(false);
    expect(ref.strike).toBeNull();
  });

  it('reports the boundary once posted', async () => {
    const { venue } = mk();
    await venue.connect();
    const before = (await venue.getMarkets()).find((m) => m.mode === 'reference')!;
    venue.postBoundary(before.id, 79_250);
    const after = (await venue.getMarkets()).find((m) => m.id === before.id)!;
    expect(after.boundaryPosted).toBe(true);
    expect(after.strike).toBe(79_250);
  });
});

describe('T-031 settlement requires an explicit claim (RFC-001 A5)', () => {
  it('does not credit collateral when a market resolves', async () => {
    const { clock, venue } = mk({
      markets: [{ id: 's1', asset: 'BTC', strike: 79_000, intervalSec: 60, expiryMs: 60_000 }],
      depth: 20, balanceUsd: 1_000,
    });
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    await venue.placeOrder(orderFor(m, {
      type: 'MARKET', limitPrice: null, limitPriceRaw: null, sizeContracts: 10,
    }));
    const afterBuy = await venue.balanceUsd();
    venue.setSpot('BTC', 80_000);                        // finishes above the strike
    clock.advanceTo(120_000);
    expect((await venue.getMarkets())[0]!.status).toBe('Resolved');
    // Winnings exist but have NOT arrived: this is the failure the claim loop prevents.
    expect(await venue.balanceUsd()).toBe(afterBuy);
    const claimable = await venue.claimable();
    expect(claimable).toHaveLength(1);
    expect(claimable[0]!.sizeContracts).toBe(10);
  });

  it('credits collateral only on claim, and is idempotent', async () => {
    const { clock, venue } = mk({
      markets: [{ id: 's1', asset: 'BTC', strike: 79_000, intervalSec: 60, expiryMs: 60_000 }],
      depth: 20,
    });
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    await venue.placeOrder(orderFor(m, {
      type: 'MARKET', limitPrice: null, limitPriceRaw: null, sizeContracts: 10,
    }));
    const before = await venue.balanceUsd();
    venue.setSpot('BTC', 80_000);
    clock.advanceTo(120_000);
    const r1 = await venue.claim('s1');
    expect(r1.claimed).toBe(true);
    expect(r1.amountUsd).toBe(10);
    expect(await venue.balanceUsd()).toBeCloseTo(before + 10, 9);
    const r2 = await venue.claim('s1');
    expect(r2.claimed).toBe(false);
    expect(r2.reason).toMatch(/already/i);
    expect(await venue.balanceUsd()).toBeCloseTo(before + 10, 9);
  });

  it('never reports a losing outcome as claimable', async () => {
    const { clock, venue } = mk({
      markets: [{ id: 's1', asset: 'BTC', strike: 79_000, intervalSec: 60, expiryMs: 60_000 }],
      depth: 20,
    });
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    await venue.placeOrder(orderFor(m, {
      type: 'MARKET', limitPrice: null, limitPriceRaw: null, sizeContracts: 10,
    }));
    venue.setSpot('BTC', 70_000);                        // finishes below the strike
    clock.advanceTo(120_000);
    expect(await venue.claimable()).toHaveLength(0);
    expect((await venue.claim('s1')).claimed).toBe(false);
  });

  it('settledMarkets finds a resolved market that getMarkets still lists', async () => {
    const { clock, venue } = mk({
      markets: [{ id: 's1', asset: 'BTC', strike: 79_000, intervalSec: 60, expiryMs: 60_000 }],
    });
    await venue.connect();
    clock.advanceTo(120_000);
    const settled = await venue.settledMarkets();
    expect(settled.map((m) => m.id)).toContain('s1');
  });
});

describe('T-031 inventory and collateral', () => {
  it('mintPair costs collateral and yields both outcomes', async () => {
    const { venue } = mk({ balanceUsd: 100 });
    await venue.connect();
    const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
    const ack = await venue.mintPair(m.id, 10);
    expect(ack.status).toBe('ACCEPTED');
    expect(await venue.balanceUsd()).toBe(90);
    // Both sells now have inventory.
    for (const kind of ['SELL_YES', 'SELL_NO'] as const) {
      const r = await venue.placeOrder(orderFor(m, {
        clientOrderId: `s-${kind}`, kind, side: kind.endsWith('YES') ? 'YES' : 'NO',
        type: 'MARKET', limitPrice: null, limitPriceRaw: null, sizeContracts: 5,
      }));
      expect(r.status).not.toBe('REJECTED');
    }
  });

  it('refuses to mint more than the collateral held', async () => {
    const { venue } = mk({ balanceUsd: 5 });
    await venue.connect();
    const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
    const ack = await venue.mintPair(m.id, 50);
    expect(ack.status).toBe('REJECTED');
    expect(ack.reason).toMatch(/collateral/i);
  });

  it('a buy reduces cash by size x price', async () => {
    const { venue } = mk({ balanceUsd: 100, depth: 100, levels: 1, spread: 0.02 });
    await venue.connect();
    const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
    const q = await venue.getQuote(m.id);
    await venue.placeOrder(orderFor(m, {
      type: 'MARKET', limitPrice: null, limitPriceRaw: null, sizeContracts: 10,
    }));
    expect(await venue.balanceUsd()).toBeCloseTo(100 - 10 * q.ask, 4);
  });
});

describe('T-031 grid enforcement (RFC-001 A8)', () => {
  it('rejects a price one raw unit off the tick grid', async () => {
    const { venue } = mk({ tickRaw: 1_000n });
    await venue.connect();
    const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
    const ack = await venue.placeOrder(orderFor(m, { limitPriceRaw: 500_001n, limitPrice: 0.500001 }));
    expect(ack.status).toBe('REJECTED');
    expect(ack.reason).toMatch(/tick/i);
  });

  it('accepts an exact multiple of the tick grid', async () => {
    const { venue } = mk({ tickRaw: 1_000n });
    await venue.connect();
    const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
    const ack = await venue.placeOrder(orderFor(m, { limitPriceRaw: 500_000n, limitPrice: 0.5 }));
    expect(ack.status).not.toBe('REJECTED');
  });

  it('rejects a price of 0 or 1 (no finite payout)', async () => {
    const { venue } = mk();
    await venue.connect();
    const m = (await venue.getMarkets()).find((x) => x.status === 'Trading')!;
    for (const raw of [0n, 1_000_000n]) {
      const ack = await venue.placeOrder(orderFor(m, {
        clientOrderId: `p${raw}`, limitPriceRaw: raw, limitPrice: Number(raw) / 1e6,
      }));
      expect(ack.status).toBe('REJECTED');
    }
  });
});

describe('T-031 scenario hooks (feed T-032)', () => {
  it('freezeQuotes ages the quote timestamp so the pricer sees it as stale', async () => {
    const { clock, venue } = mk();
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    venue.freezeQuotes(60_000);
    clock.advance(5_000);
    const q = await venue.getQuote(m.id);
    expect(q.stale).toBe(true);
    expect(clock.now() - q.tsMs).toBeGreaterThan(4_000);   // beyond maxQuoteAgeMs
  });

  it('setDepth 0 empties the book so sizing clamps (THIN_BOOK)', async () => {
    const { venue } = mk();
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    venue.setDepth(0);
    const q = await venue.getQuote(m.id);
    expect(q.depthBid).toBe(0);
    expect(q.depthAsk).toBe(0);
  });

  it('setFairProb moves the book', async () => {
    const { venue } = mk();
    await venue.connect();
    const m = (await venue.getMarkets())[0]!;
    const before = (await venue.getQuote(m.id)).mid;
    venue.setFairProb(m.id, 0.8);
    expect((await venue.getQuote(m.id)).mid).toBeGreaterThan(before);
  });
});
