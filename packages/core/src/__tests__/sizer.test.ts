// T-023 — quarter-Kelly sizing with hard caps (FR-E5, WP §4).
// Kelly is optimal only if p is right; ours is an estimate from an estimated
// volatility, so the fraction is cut to a quarter and then hard-capped. Every
// clamp here has a named failure it prevents.
import { describe, it, expect } from 'vitest';
import { fullKelly, sizeOrder } from '../sizer.ts';
import type { Market, RiskConfig } from '@arena/shared';

const risk = (over: Partial<RiskConfig> = {}): RiskConfig => ({
  maxNetContractsPerMarket: 50, maxGrossContracts: 200, maxNotionalUsd: 250,
  maxSessionLossUsd: 100, maxOrdersPerMinute: 12, cooldownMs: 15_000,
  edgeIn: 0.06, edgeOut: 0.02, kellyFraction: 0.25, minEdgeFloor: 0.015,
  maxQuoteAgeMs: 4_000, killSwitch: false, ...over,
});

const market = (over: Partial<Market> = {}): Market => ({
  id: 'm1', symbol: 'BTC', yesSymbol: 'y', noSymbol: 'n', asset: 'BTC',
  strike: 79_000, mode: 'fixed', boundaryPosted: true, intervalSec: 60,
  tradingStartMs: 0, expiryMs: 60_000, style: 'EXPIRY',
  tickRaw: 1_000n, lotRaw: 1n, priceDecimals: 6, minSize: 1, feeBps: 0,
  poolAddress: null, nonce: null, venue: 'SIM', status: 'Trading', ...over,
});

const args = (over: Partial<Parameters<typeof sizeOrder>[0]> = {}) => ({
  market: market(), risk: risk(), pModel: 0.6, price: 0.5,
  bankrollUsd: 1_000, existingNetContracts: 0, grossContracts: 0,
  availableDepth: 1e9, side: 'YES' as const, ...over,
});

describe('T-023 full Kelly (WP §4: f* = (p-q)/(1-q))', () => {
  it('matches the hand-computed value for p=0.6, q=0.5', () => {
    // (0.6 - 0.5) / (1 - 0.5) = 0.2
    expect(fullKelly(0.6, 0.5)).toBeCloseTo(0.2, 15);
  });

  it('is 0 when the model agrees with the market', () => {
    expect(fullKelly(0.5, 0.5)).toBe(0);
  });

  it('is negative when the model is less bullish than the price', () => {
    expect(fullKelly(0.4, 0.5)).toBeLessThan(0);
  });

  it('approaches 1 as certainty approaches the price limit', () => {
    expect(fullKelly(0.999, 0.5)).toBeGreaterThan(0.99);
    expect(fullKelly(1, 0.5)).toBe(1);
  });

  it('scales with the payout: a cheap contract needs a smaller stake fraction', () => {
    // q = 0.1 pays 10x, so the same edge justifies a smaller fraction
    expect(fullKelly(0.2, 0.1)).toBeLessThan(fullKelly(0.7, 0.6));
  });

  it('returns 0 rather than dividing by zero at q = 1', () => {
    expect(fullKelly(0.9, 1)).toBe(0);
  });

  it('is 0 for a price outside (0,1)', () => {
    expect(fullKelly(0.6, 0)).toBe(0);
    expect(fullKelly(0.6, 1)).toBe(0);
    expect(fullKelly(0.6, -0.1)).toBe(0);
  });
});

describe('T-023 the quarter (WP §4)', () => {
  it('applies exactly kellyFraction x full Kelly', () => {
    const r = sizeOrder(args());
    expect(r.kellyFull).toBeCloseTo(0.2, 12);
    expect(r.kellyApplied).toBeCloseTo(0.05, 12);      // 0.25 x 0.2
  });

  it('honours a different fraction', () => {
    expect(sizeOrder(args({ risk: risk({ kellyFraction: 0.5 }) })).kellyApplied).toBeCloseTo(0.1, 12);
  });

  it('sizes from the applied fraction, not the full one', () => {
    // 0.05 x 1000 = $50 of exposure at $0.50/contract = 100 contracts,
    // before the caps below cut it.
    const r = sizeOrder(args({ risk: risk({ maxNetContractsPerMarket: 1e6, maxNotionalUsd: 1e6 }) }));
    expect(r.sizeContracts).toBe(100);
  });
});

describe('T-023 refusing to size', () => {
  it('returns 0 for a negative full Kelly (no edge in this direction)', () => {
    const r = sizeOrder(args({ pModel: 0.4, price: 0.5 }));
    expect(r.sizeContracts).toBe(0);
    expect(r.reason).toMatch(/kelly/i);
  });

  it('returns 0 when the model exactly matches the price', () => {
    expect(sizeOrder(args({ pModel: 0.5, price: 0.5 })).sizeContracts).toBe(0);
  });

  it('returns 0 with a zero or negative bankroll', () => {
    expect(sizeOrder(args({ bankrollUsd: 0 })).sizeContracts).toBe(0);
    expect(sizeOrder(args({ bankrollUsd: -5 })).sizeContracts).toBe(0);
  });

  it('uses the NO-side probability when sizing a NO order', () => {
    // Buying NO at 0.5 when the model says P(YES)=0.3 means P(NO)=0.7.
    const r = sizeOrder(args({ side: 'NO', pModel: 0.3, price: 0.5 }));
    expect(r.kellyFull).toBeCloseTo(fullKelly(0.7, 0.5), 12);
    expect(r.sizeContracts).toBeGreaterThan(0);
  });
});

describe('T-023 hard caps (each prevents a named failure)', () => {
  it('clamps to maxNotionalUsd — prevents one trade betting the session', () => {
    const r = sizeOrder(args({ bankrollUsd: 1e6, risk: risk({ maxNotionalUsd: 25, maxNetContractsPerMarket: 1e6 }) }));
    expect(r.sizeContracts * 0.5).toBeLessThanOrEqual(25);
    expect(r.sizeContracts).toBe(50);
    expect(r.reason).toMatch(/notional/i);
  });

  it('clamps to maxNetContractsPerMarket, accounting for the existing position', () => {
    const r = sizeOrder(args({ bankrollUsd: 1e6, existingNetContracts: 45,
      risk: risk({ maxNetContractsPerMarket: 50, maxNotionalUsd: 1e6 }) }));
    expect(r.sizeContracts).toBe(5);
    expect(r.reason).toMatch(/per-market/i);
  });

  it('returns 0 when the per-market cap is already reached', () => {
    const r = sizeOrder(args({ existingNetContracts: 50, risk: risk({ maxNetContractsPerMarket: 50 }) }));
    expect(r.sizeContracts).toBe(0);
  });

  it('counts an opposing position as headroom, not as exposure', () => {
    // Short 20 YES with a 50 cap leaves room for 70 before breaching +50.
    const r = sizeOrder(args({ bankrollUsd: 1e6, existingNetContracts: -20,
      risk: risk({ maxNetContractsPerMarket: 50, maxNotionalUsd: 1e6 }) }));
    expect(r.sizeContracts).toBe(70);
  });

  it('clamps to maxGrossContracts across all markets', () => {
    const r = sizeOrder(args({ bankrollUsd: 1e6, grossContracts: 195,
      risk: risk({ maxGrossContracts: 200, maxNotionalUsd: 1e6, maxNetContractsPerMarket: 1e6 }) }));
    expect(r.sizeContracts).toBe(5);
    expect(r.reason).toMatch(/gross/i);
  });

  it('clamps to the depth actually available (THIN_BOOK)', () => {
    const r = sizeOrder(args({ bankrollUsd: 1e6, availableDepth: 3,
      risk: risk({ maxNotionalUsd: 1e6, maxNetContractsPerMarket: 1e6 }) }));
    expect(r.sizeContracts).toBe(3);
    expect(r.reason).toMatch(/depth/i);
  });

  it('applies the most restrictive cap, not the last one checked', () => {
    const r = sizeOrder(args({ bankrollUsd: 1e6, availableDepth: 7, grossContracts: 190,
      risk: risk({ maxGrossContracts: 200, maxNotionalUsd: 4, maxNetContractsPerMarket: 9 }) }));
    // caps: notional 4/0.5 = 8, per-market 9, gross 10, depth 7 -> 7 wins
    expect(r.sizeContracts).toBe(7);
  });
});

describe('T-023 venue granularity (rounds DOWN, never up)', () => {
  it('floors to the minSize grid', () => {
    const r = sizeOrder(args({ bankrollUsd: 1e6, market: market({ minSize: 5 }),
      risk: risk({ maxNotionalUsd: 11.6, maxNetContractsPerMarket: 1e6 }) }));
    // 11.6/0.5 = 23.2 -> floor to a multiple of 5 -> 20
    expect(r.sizeContracts).toBe(20);
  });

  it('returns 0 when the clamps leave less than one minSize', () => {
    const r = sizeOrder(args({ market: market({ minSize: 10 }),
      risk: risk({ maxNotionalUsd: 2, maxNetContractsPerMarket: 1e6 }) }));
    // 2/0.5 = 4 contracts, below minSize 10 -> cannot place
    expect(r.sizeContracts).toBe(0);
    expect(r.reason).toMatch(/minSize|below/i);
  });

  it('NEVER rounds up past a cap, even by one contract', () => {
    for (const cap of [1, 3, 7, 13, 49, 99]) {
      const r = sizeOrder(args({ bankrollUsd: 1e6,
        risk: risk({ maxNetContractsPerMarket: cap, maxNotionalUsd: 1e6 }) }));
      expect(r.sizeContracts).toBeLessThanOrEqual(cap);
    }
  });

  it('produces a whole number of contracts', () => {
    for (const b of [137, 999, 12_345]) {
      const r = sizeOrder(args({ bankrollUsd: b }));
      expect(Number.isInteger(r.sizeContracts)).toBe(true);
    }
  });
});

describe('T-023 output hygiene', () => {
  it('never returns NaN, Infinity or a negative size', () => {
    const hostile = [
      { price: 1e-9 }, { price: 0.999999 }, { bankrollUsd: 1e12 },
      { pModel: 1 }, { pModel: 0 }, { availableDepth: 0 },
      { market: market({ minSize: 0 }) },
    ];
    for (const over of hostile) {
      const r = sizeOrder(args(over as Partial<Parameters<typeof sizeOrder>[0]>));
      expect(Number.isFinite(r.sizeContracts)).toBe(true);
      expect(r.sizeContracts).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(r.kellyApplied)).toBe(true);
    }
  });

  it('always explains itself, so the console can show why a size was chosen', () => {
    expect(sizeOrder(args()).reason.length).toBeGreaterThan(0);
  });

  it('is pure — same inputs give the same result', () => {
    const a = args();
    expect(sizeOrder(a)).toEqual(sizeOrder(a));
  });
});
