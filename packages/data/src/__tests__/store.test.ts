// T-013 — the store is the projection everything reads: positions, PnL, tape,
// leaderboard. Its PnL arithmetic is what the demo puts on screen, so the
// realized/unrealized split is tested against hand-computed values.
import { describe, it, expect } from 'vitest';
import { Store } from '../store.ts';
import { EventBus } from '../bus.ts';
import type { Fill, Market, Quote } from '@arena/shared';

const market = (over: Partial<Market> = {}): Market => ({
  id: 'm1', symbol: 'BTC', yesSymbol: 'y', noSymbol: 'n', asset: 'BTC',
  strike: 79_000, mode: 'fixed', boundaryPosted: true, intervalSec: 60,
  tradingStartMs: 0, expiryMs: 60_000, style: 'EXPIRY',
  tickRaw: 1_000n, lotRaw: 1n, priceDecimals: 6, minSize: 1, feeBps: 0,
  poolAddress: null, nonce: null, venue: 'SIM', status: 'Trading', ...over,
});

const fill = (over: Partial<Fill> = {}): Fill => ({
  fillId: `f${Math.random()}`, clientOrderId: 'c1', venueOrderId: 'v1', marketId: 'm1',
  agent: 'MIRA', side: 'YES', sizeContracts: 10, price: 0.5, feeUsd: 0,
  txHash: null, explorerUrl: null, tsMs: 1_000, ...over,
});

const mk = (over: Partial<ConstructorParameters<typeof Store>[0]> = {}) =>
  new Store({ runId: 'run-1', mode: 'SIM', tapeCap: 500, pnlCurveCap: 600, ...over });

describe('T-013 position accounting', () => {
  it('nets a YES fill and an opposite fill back to zero', () => {
    const s = mk();
    s.applyFill(fill({ side: 'YES', sizeContracts: 10, price: 0.4 }));
    s.applyFill(fill({ side: 'NO', sizeContracts: 10, price: 0.4 }));
    const p = s.position('m1', 'MIRA')!;
    expect(p.netContracts).toBe(0);
  });

  it('realizes PnL on the closing fill, hand-checked', () => {
    // Buy 10 YES at 0.40, then close by buying 10 NO at 0.55.
    // Closing a long YES at an implied YES price of (1 - 0.55) = 0.45 gives
    // (0.45 - 0.40) * 10 = +0.50.
    const s = mk();
    s.applyFill(fill({ side: 'YES', sizeContracts: 10, price: 0.40 }));
    s.applyFill(fill({ side: 'NO', sizeContracts: 10, price: 0.55 }));
    const p = s.position('m1', 'MIRA')!;
    expect(p.netContracts).toBe(0);
    expect(p.realizedPnlUsd).toBeCloseTo(0.5, 10);
  });

  it('realizes a loss when the close is worse than the open', () => {
    const s = mk();
    s.applyFill(fill({ side: 'YES', sizeContracts: 10, price: 0.60 }));
    s.applyFill(fill({ side: 'NO', sizeContracts: 10, price: 0.55 }));   // YES 0.45
    expect(s.position('m1', 'MIRA')!.realizedPnlUsd).toBeCloseTo(-1.5, 10);
  });

  it('size-weights avgPrice across multiple same-side fills', () => {
    const s = mk();
    s.applyFill(fill({ sizeContracts: 10, price: 0.40 }));
    s.applyFill(fill({ sizeContracts: 30, price: 0.60 }));
    // (10*0.40 + 30*0.60) / 40 = 0.55
    expect(s.position('m1', 'MIRA')!.avgPrice).toBeCloseTo(0.55, 12);
    expect(s.position('m1', 'MIRA')!.netContracts).toBe(40);
  });

  it('leaves avgPrice untouched when partially closing', () => {
    const s = mk();
    s.applyFill(fill({ side: 'YES', sizeContracts: 20, price: 0.40 }));
    s.applyFill(fill({ side: 'NO', sizeContracts: 5, price: 0.50 }));
    const p = s.position('m1', 'MIRA')!;
    expect(p.netContracts).toBe(15);
    expect(p.avgPrice).toBeCloseTo(0.40, 12);
  });

  it('handles a flip through zero: realizes the old leg, opens the new one', () => {
    const s = mk();
    s.applyFill(fill({ side: 'YES', sizeContracts: 10, price: 0.40 }));
    s.applyFill(fill({ side: 'NO', sizeContracts: 25, price: 0.55 }));   // YES 0.45
    const p = s.position('m1', 'MIRA')!;
    expect(p.netContracts).toBe(-15);
    expect(p.realizedPnlUsd).toBeCloseTo(0.5, 10);      // only the closed 10
    // Positions are held in the YES convention, so a NO fill at 0.55 becomes a
    // YES basis of 1 - 0.55 = 0.45 for the new short leg.
    expect(p.avgPrice).toBeCloseTo(0.45, 12);
  });

  it('subtracts fees from realized PnL', () => {
    const s = mk();
    s.applyFill(fill({ sizeContracts: 10, price: 0.5, feeUsd: 0.25 }));
    expect(s.position('m1', 'MIRA')!.realizedPnlUsd).toBeCloseTo(-0.25, 12);
  });

  it('keeps each agent’s book separate', () => {
    const s = mk();
    s.applyFill(fill({ agent: 'MIRA', sizeContracts: 10 }));
    s.applyFill(fill({ agent: 'ECHO', sizeContracts: 4, side: 'NO' }));
    expect(s.position('m1', 'MIRA')!.netContracts).toBe(10);
    expect(s.position('m1', 'ECHO')!.netContracts).toBe(-4);
  });

  it('ignores a duplicate fillId (a replay must not double-count)', () => {
    const s = mk();
    const f = fill({ fillId: 'dup', sizeContracts: 10 });
    s.applyFill(f);
    s.applyFill(f);
    expect(s.position('m1', 'MIRA')!.netContracts).toBe(10);
  });
});

describe('T-013 mark-to-market', () => {
  const quote = (mid: number): Quote => ({ marketId: 'm1', bid: mid - 0.01, ask: mid + 0.01,
    mid, depthBid: 10, depthAsk: 10, stale: false, tsMs: 2_000 });

  it('updates unrealized PnL on a mark change without touching realized', () => {
    const s = mk();
    s.applyFill(fill({ sizeContracts: 10, price: 0.40 }));
    s.applyQuote(quote(0.50));
    const p = s.position('m1', 'MIRA')!;
    expect(p.markPrice).toBe(0.50);
    expect(p.unrealizedPnlUsd).toBeCloseTo(1.0, 10);    // (0.50-0.40)*10
    expect(p.realizedPnlUsd).toBe(0);
  });

  it('marks a short position with the opposite sign', () => {
    const s = mk();
    s.applyFill(fill({ side: 'NO', sizeContracts: 10, price: 0.40 }));   // YES basis 0.60
    s.applyQuote(quote(0.50));
    expect(s.position('m1', 'MIRA')!.unrealizedPnlUsd).toBeCloseTo(1.0, 10);
  });

  it('reports zero unrealized PnL on a flat position', () => {
    const s = mk();
    s.applyFill(fill({ side: 'YES', sizeContracts: 10, price: 0.4 }));
    s.applyFill(fill({ side: 'NO', sizeContracts: 10, price: 0.4 }));
    s.applyQuote(quote(0.9));
    expect(s.position('m1', 'MIRA')!.unrealizedPnlUsd).toBe(0);
  });

  it('totals PnL as realized + unrealized across markets', () => {
    const s = mk();
    s.applyFill(fill({ marketId: 'm1', sizeContracts: 10, price: 0.40 }));
    s.applyFill(fill({ marketId: 'm2', sizeContracts: 10, price: 0.30 }));
    s.applyQuote(quote(0.50));
    s.applyQuote({ ...quote(0.35), marketId: 'm2' });
    expect(s.totalPnlUsd('MIRA')).toBeCloseTo(1.0 + 0.5, 10);
  });
});

describe('T-013 the tape (bounded)', () => {
  it('records fills newest-first', () => {
    const s = mk();
    s.applyFill(fill({ fillId: 'a', tsMs: 1 }));
    s.applyFill(fill({ fillId: 'b', tsMs: 2 }));
    expect(s.tape().map((f) => f.fillId)).toEqual(['b', 'a']);
  });

  it('never exceeds its cap however many fills arrive', () => {
    const s = mk({ tapeCap: 50 });
    for (let i = 0; i < 5_000; i++) s.applyFill(fill({ fillId: `f${i}`, tsMs: i }));
    expect(s.tape()).toHaveLength(50);
    expect(s.tape()[0]!.fillId).toBe('f4999');
  });

  it('stays fast with a bounded tape at 100 000 fills', () => {
    const s = mk({ tapeCap: 500 });
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) s.applyFill(fill({ fillId: `f${i}`, tsMs: i }));
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

describe('T-013 the PnL curve (down-sampled)', () => {
  it('never exceeds its cap regardless of fill count', () => {
    const s = mk({ pnlCurveCap: 600 });
    for (let i = 0; i < 20_000; i++) s.applyFill(fill({ fillId: `f${i}`, tsMs: i, price: 0.5 }));
    expect(s.pnlCurve().length).toBeLessThanOrEqual(600);
  });

  it('keeps the first and the most recent points when down-sampling', () => {
    const s = mk({ pnlCurveCap: 10 });
    for (let i = 0; i < 1_000; i++) s.applyFill(fill({ fillId: `f${i}`, tsMs: i * 10, price: 0.5 }));
    const c = s.pnlCurve();
    expect(c[0]!.tsMs).toBe(0);
    expect(c[c.length - 1]!.tsMs).toBe(9_990);
  });

  it('stays chronological after down-sampling', () => {
    const s = mk({ pnlCurveCap: 25 });
    for (let i = 0; i < 5_000; i++) s.applyFill(fill({ fillId: `f${i}`, tsMs: i, price: 0.5 }));
    const c = s.pnlCurve();
    for (let i = 1; i < c.length; i++) expect(c[i]!.tsMs).toBeGreaterThan(c[i - 1]!.tsMs);
  });
});

describe('T-013 snapshot (IF §13)', () => {
  it('produces an ArenaSnapshot with every field populated', () => {
    const s = mk();
    s.applyMarkets([market()]);
    s.applyFill(fill());
    const snap = s.snapshot(5_000);
    expect(snap.runId).toBe('run-1');
    expect(snap.mode).toBe('SIM');
    expect(snap.markets).toHaveLength(1);
    expect(snap.positions).toHaveLength(1);
    expect(snap.tape).toHaveLength(1);
    expect(Array.isArray(snap.pnlCurve)).toBe(true);
    expect(Array.isArray(snap.valuations)).toBe(true);
    expect(Array.isArray(snap.leaderboard)).toBe(true);
    expect(Array.isArray(snap.quips)).toBe(true);
    expect(snap.health.mode).toBe('SIM');
    expect(snap.round).toBeNull();
  });

  it('is JSON-serializable (it crosses a WebSocket)', () => {
    const s = mk();
    s.applyMarkets([market()]);
    s.applyFill(fill());
    // Markets carry bigints (tickRaw/lotRaw), which JSON.stringify throws on
    // unless the store converts them. The WS broadcaster depends on this.
    expect(() => JSON.stringify(s.snapshot(1_000))).not.toThrow();
  });

  it('keeps only the latest valuation per market', () => {
    const s = mk();
    for (let i = 0; i < 5; i++) {
      s.applyValuation({ marketId: 'm1', style: 'EXPIRY', spot: 1, strike: 1, tauYears: 1e-6,
        pModel: 0.5, pMarket: 0.5, sigmaForecast: 0.6, sigmaImplied: 0.6, edge: i / 100,
        skipReason: null, tsMs: i });
    }
    const v = s.snapshot(10).valuations;
    expect(v).toHaveLength(1);
    expect(v[0]!.edge).toBeCloseTo(0.04, 12);
  });

  it('tracks tick lag and rate for the health snapshot', () => {
    const s = mk();
    s.applyTick({ symbol: 'BTC', price: 1, tsMs: 1_000, seq: 1, source: 'fixture' });
    const h = s.snapshot(1_050).health;
    expect(h.tickLagMs).toBe(50);
    expect(h.ticksPerSec).toBeGreaterThanOrEqual(0);
  });
});

describe('T-013 replay equivalence (feeds T-064 and GWT-6)', () => {
  it('two stores fed the same fills in the same order are identical', () => {
    const fills = Array.from({ length: 200 }, (_, i) =>
      fill({ fillId: `f${i}`, tsMs: i, sizeContracts: 1 + (i % 7), price: 0.3 + (i % 5) / 20,
        side: i % 3 === 0 ? 'NO' : 'YES' }));
    const a = mk(); const b = mk();
    for (const f of fills) a.applyFill(f);
    for (const f of fills) b.applyFill(f);
    expect(JSON.stringify(a.snapshot(1_000))).toBe(JSON.stringify(b.snapshot(1_000)));
  });

  it('subscribing to a bus produces the same state as applying directly', () => {
    const fills = Array.from({ length: 50 }, (_, i) => fill({ fillId: `f${i}`, tsMs: i }));
    const direct = mk();
    for (const f of fills) direct.applyFill(f);
    const bus = new EventBus();
    const viaBus = mk();
    viaBus.subscribe(bus);
    for (const f of fills) bus.publish({ t: 'fill', d: f });
    expect(JSON.stringify(viaBus.snapshot(1_000))).toBe(JSON.stringify(direct.snapshot(1_000)));
  });
});
