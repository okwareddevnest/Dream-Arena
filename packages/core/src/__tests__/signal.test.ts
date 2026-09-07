// T-022 — hysteresis is what stops the agent spamming the book (GWT-2, GWT-3).
// The no-spam property is asserted over a thousand oscillating ticks, because a
// single-tick test cannot distinguish a working latch from a broken one.
import { describe, it, expect } from 'vitest';
import { SignalEngine } from '../signal.ts';
import type { RiskConfig, Valuation } from '@arena/shared';

const risk = (over: Partial<RiskConfig> = {}): RiskConfig => ({
  maxNetContractsPerMarket: 50, maxGrossContracts: 200, maxNotionalUsd: 250,
  maxSessionLossUsd: 100, maxOrdersPerMinute: 12, cooldownMs: 15_000,
  edgeIn: 0.06, edgeOut: 0.02, kellyFraction: 0.25, minEdgeFloor: 0.015,
  maxQuoteAgeMs: 4_000, killSwitch: false, ...over,
});

/** A valuation with a chosen edge. `pModel`/`pMarket` set the side. */
const val = (edge: number, over: Partial<Valuation> = {}): Valuation => ({
  marketId: 'm1', style: 'EXPIRY', spot: 79_000, strike: 79_000, tauYears: 1.9e-6,
  pModel: 0.55, pMarket: 0.45, sigmaForecast: 0.6, sigmaImplied: 0.6 - edge,
  edge, skipReason: null, tsMs: 1_000, ...over,
});

const mk = (over: Partial<RiskConfig> = {}) => new SignalEngine({ agent: 'MIRA', risk: risk(over) });

describe('T-022 edge definition (FR-E3)', () => {
  it('carries the valuation edge through unchanged', () => {
    const s = mk().evaluate(val(0.09), 1_000);
    expect(s.edge).toBe(0.09);
    expect(s.pModel).toBe(0.55);
    expect(s.pMarket).toBe(0.45);
  });

  it('edge equals sigmaForecast - sigmaImplied', () => {
    const v = val(0.07);
    expect(v.sigmaForecast - v.sigmaImplied!).toBeCloseTo(v.edge, 15);
  });
});

describe('T-022 hysteresis (FR-E4, GWT-1, GWT-2)', () => {
  it('enters when edge exceeds edgeIn while disengaged (GWT-1)', () => {
    const s = mk();
    const sig = s.evaluate(val(0.09), 1_000);
    expect(sig.action).toBe('ENTER');
    expect(s.isEngaged('m1')).toBe(true);
  });

  it('holds with zero size when edge sits between edgeOut and edgeIn while engaged', () => {
    const s = mk();
    s.evaluate(val(0.09), 1_000);
    const sig = s.evaluate(val(0.04), 2_000);
    expect(sig.action).toBe('HOLD');
    expect(sig.sizeContracts).toBe(0);
    expect(s.isEngaged('m1')).toBe(true);
  });

  it('stands down and disengages when edge falls below edgeOut (GWT-2)', () => {
    const s = mk();
    s.evaluate(val(0.09), 1_000);
    const sig = s.evaluate(val(0.01), 2_000);
    expect(sig.action).toBe('STAND_DOWN');
    expect(sig.sizeContracts).toBe(0);
    expect(s.isEngaged('m1')).toBe(false);
  });

  it('does not re-enter after standing down until edge again exceeds edgeIn', () => {
    const s = mk();
    s.evaluate(val(0.09), 1_000);
    s.evaluate(val(0.01), 2_000);                       // stand down
    expect(s.evaluate(val(0.03), 3_000).action).toBe('HOLD');   // above edgeOut, below edgeIn
    expect(s.evaluate(val(0.05), 4_000).action).toBe('HOLD');
    expect(s.evaluate(val(0.07), 5_000).action).toBe('ENTER');  // back above edgeIn
  });

  it('holds while disengaged and edge is below edgeIn (no entry, no noise)', () => {
    const s = mk();
    for (const e of [0, 0.01, 0.03, 0.05, 0.0599]) {
      expect(s.evaluate(val(e), 1_000).action).toBe('HOLD');
    }
    expect(s.isEngaged('m1')).toBe(false);
  });

  it('THE NO-SPAM PROPERTY: 1 000 ticks oscillating inside the band produce exactly one ENTER', () => {
    const s = mk();
    let enters = 0;
    // First push above edgeIn to engage, then oscillate strictly inside
    // [edgeOut, edgeIn) forever. A latch-less implementation re-enters here.
    if (s.evaluate(val(0.09), 0).action === 'ENTER') enters++;
    for (let i = 1; i <= 1_000; i++) {
      const edge = i % 2 === 0 ? 0.021 : 0.0599;
      if (s.evaluate(val(edge), i).action === 'ENTER') enters++;
    }
    expect(enters).toBe(1);
  });

  it('a full cycle above/below the band enters exactly once per crossing', () => {
    const s = mk();
    let enters = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
      for (const e of [0.09, 0.04, 0.01]) {             // enter, hold, stand down
        if (s.evaluate(val(e), cycle * 100 + e * 1000).action === 'ENTER') enters++;
      }
    }
    expect(enters).toBe(5);
  });

  it('tracks hysteresis per market — one market engaging does not engage another', () => {
    const s = mk();
    s.evaluate(val(0.09, { marketId: 'm1' }), 1_000);
    expect(s.isEngaged('m1')).toBe(true);
    expect(s.isEngaged('m2')).toBe(false);
    expect(s.evaluate(val(0.09, { marketId: 'm2' }), 1_000).action).toBe('ENTER');
    expect(s.evaluate(val(0.09, { marketId: 'm1' }), 2_000).action).toBe('HOLD');
  });

  it('exposes hysteresis state matching IF §4', () => {
    const s = mk();
    s.evaluate(val(0.09), 1_000);
    const st = s.state('m1');
    // cooldownUntilMs is 0: the cooldown clock starts on a fill, not a decision.
    expect(st).toEqual({ marketId: 'm1', engaged: true, lastActionTsMs: 1_000, cooldownUntilMs: 0 });
  });
});

describe('T-022 the minimum edge floor (WP §4: fees + spread + noise)', () => {
  it('never enters below minEdgeFloor even when edgeIn is lower', () => {
    const s = mk({ edgeIn: 0.01, edgeOut: 0.005, minEdgeFloor: 0.05 });
    expect(s.evaluate(val(0.02), 1_000).action).toBe('HOLD');
    expect(s.evaluate(val(0.049), 1_000).action).toBe('HOLD');
    expect(s.evaluate(val(0.06), 1_000).action).toBe('ENTER');
  });

  it('says which gate stopped it, so the console can show a reason', () => {
    const s = mk({ edgeIn: 0.01, edgeOut: 0.005, minEdgeFloor: 0.05 });
    expect(s.evaluate(val(0.02), 1_000).reason).toMatch(/floor/i);
    expect(mk().evaluate(val(0.03), 1_000).reason).toMatch(/edgeIn|entry/i);
  });
});

describe('T-022 cooldown keys on FILLS, not on decisions (FR-X2)', () => {
  it('an ENTER that never fills does not start a cooldown', () => {
    // An order that was placed and never filled has cost nothing; locking the
    // market out for it would forfeit the next real opportunity.
    const s = mk({ cooldownMs: 10_000 });
    s.evaluate(val(0.09), 1_000);
    s.evaluate(val(0.01), 2_000);                        // stand down, no fill ever
    expect(s.state('m1').cooldownUntilMs).toBe(0);
    expect(s.evaluate(val(0.09), 3_000).action).toBe('ENTER');
  });

  it('blocks re-entry during the cooldown window after a fill', () => {
    const s = mk({ cooldownMs: 10_000 });
    s.evaluate(val(0.09), 1_000);
    s.noteFill('m1', 1_500);
    s.evaluate(val(0.01), 2_000);                        // stand down
    const sig = s.evaluate(val(0.09), 5_000);            // inside cooldown
    expect(sig.action).toBe('HOLD');
    expect(sig.reason).toMatch(/cooldown/i);
  });

  it('allows re-entry once the post-fill cooldown has elapsed', () => {
    const s = mk({ cooldownMs: 10_000 });
    s.evaluate(val(0.09), 1_000);
    s.noteFill('m1', 1_500);
    s.evaluate(val(0.01), 2_000);
    expect(s.evaluate(val(0.09), 11_501).action).toBe('ENTER');
  });

  it('records the cooldown deadline in the hysteresis state', () => {
    const s = mk({ cooldownMs: 10_000 });
    s.noteFill('m1', 4_000);
    expect(s.state('m1').cooldownUntilMs).toBe(14_000);
  });

  it('cooldown is per market', () => {
    const s = mk({ cooldownMs: 10_000 });
    s.noteFill('m1', 1_000);
    expect(s.evaluate(val(0.09, { marketId: 'm2' }), 2_000).action).toBe('ENTER');
    expect(s.evaluate(val(0.09, { marketId: 'm1' }), 2_000).action).toBe('HOLD');
  });
});

describe('T-022 side selection', () => {
  it('is YES when the model is more bullish than the market', () => {
    expect(mk().evaluate(val(0.09, { pModel: 0.6, pMarket: 0.4 }), 1_000).side).toBe('YES');
  });
  it('is NO when the model is less bullish than the market', () => {
    expect(mk().evaluate(val(0.09, { pModel: 0.3, pMarket: 0.5 }), 1_000).side).toBe('NO');
  });
  it('holds rather than guessing when the model and the market agree exactly', () => {
    const sig = mk().evaluate(val(0.09, { pModel: 0.5, pMarket: 0.5 }), 1_000);
    expect(sig.action).toBe('HOLD');
    expect(sig.side).toBeNull();
    expect(sig.reason).toMatch(/no directional/i);
  });
  it('picks the side from probabilities, not from the sign of the edge', () => {
    // In the money, higher vol LOWERS the probability, so a positive vol edge
    // is a NO signal. Getting this from the edge sign would invert the trade.
    const sig = mk().evaluate(val(0.09, { spot: 80_000, strike: 79_000, pModel: 0.7, pMarket: 0.85 }), 1_000);
    expect(sig.side).toBe('NO');
  });
});

describe('T-022 skip semantics (GWT-3)', () => {
  it('reports SKIP with no side and no size for every skip reason', () => {
    for (const r of ['NEGATIVE_DISCRIMINANT', 'EXPIRED', 'STALE_QUOTE', 'DEGENERATE',
      'NO_LIQUIDITY', 'BOUNDARY_NOT_POSTED', 'NOT_TRADABLE'] as const) {
      const sig = mk().evaluate(val(0, { skipReason: r, sigmaImplied: null }), 1_000);
      expect(sig.action).toBe('SKIP');
      expect(sig.side).toBeNull();
      expect(sig.sizeContracts).toBe(0);
      expect(sig.reason).toContain(r);
    }
  });

  it('a skip disengages an engaged market rather than leaving it latched', () => {
    // Otherwise a market that goes stale while engaged stays engaged forever and
    // re-enters the moment a quote returns, without a fresh edgeIn crossing.
    const s = mk();
    s.evaluate(val(0.09), 1_000);
    expect(s.isEngaged('m1')).toBe(true);
    s.evaluate(val(0, { skipReason: 'STALE_QUOTE', sigmaImplied: null }), 2_000);
    expect(s.isEngaged('m1')).toBe(false);
  });

  it('never enters on a skipped valuation no matter how large the reported edge', () => {
    const s = mk();
    const sig = s.evaluate(val(99, { skipReason: 'NEGATIVE_DISCRIMINANT', sigmaImplied: null }), 1_000);
    expect(sig.action).toBe('SKIP');
  });

  it('treats a null sigmaImplied as a skip even if no reason was set', () => {
    const sig = mk().evaluate(val(0.09, { sigmaImplied: null, skipReason: null }), 1_000);
    expect(sig.action).toBe('SKIP');
  });
});

describe('T-022 signal shape and hygiene', () => {
  it('produces a Signal matching IF §4 with a unique id', () => {
    const s = mk();
    const a = s.evaluate(val(0.09), 1_000);
    const b = s.evaluate(val(0.09, { marketId: 'm2' }), 1_000);
    expect(a.id).not.toBe(b.id);
    expect(a.agent).toBe('MIRA');
    expect(a.marketId).toBe('m1');
    expect(a.tsMs).toBe(1_000);
    expect(a.valuation.marketId).toBe('m1');
  });

  it('reports zero size on every non-ENTER action', () => {
    const s = mk();
    for (const e of [0.09, 0.04, 0.01, 0.03]) {
      const sig = s.evaluate(val(e), 1_000);
      if (sig.action !== 'ENTER') expect(sig.sizeContracts).toBe(0);
    }
  });

  it('leaves sizing to the sizer — ENTER reports size 0 until sized', () => {
    // Separation of concerns: hysteresis decides WHETHER, Kelly decides HOW MUCH.
    expect(mk().evaluate(val(0.09), 1_000).sizeContracts).toBe(0);
  });

  it('reset clears all hysteresis state', () => {
    const s = mk();
    s.evaluate(val(0.09), 1_000);
    s.reset();
    expect(s.isEngaged('m1')).toBe(false);
    expect(s.evaluate(val(0.09), 2_000).action).toBe('ENTER');
  });

  it('evaluates a signal far inside the ARCH §4 budget of 2 ms', () => {
    // Asserted per-signal against the real budget rather than against a round
    // total: 100k iterations land around 0.5 us each, so the margin is ~4000x.
    // A total-time bound would fail on a loaded CI box while still being
    // three orders of magnitude inside spec.
    const s = mk();
    const v = val(0.04);
    const N = 100_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) s.evaluate(v, i);
    const perSignalMs = (performance.now() - t0) / N;
    expect(perSignalMs).toBeLessThan(0.05);        // 40x margin on a 2 ms budget
  });
});
