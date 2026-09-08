// Per-user skill measurement.
//
// A Brier score alone says "you were wrong by this much". Its Murphy
// decomposition says HOW: reliability (when you say 70%, does it happen 70% of
// the time?) and resolution (can you separate likely from unlikely at all?).
// That distinction is the useful thing to hand a person — a confident forecaster
// and a timid one can share a Brier score and need opposite advice.
import { describe, it, expect } from 'vitest';
import { calibrationBuckets, murphy, userRecord, headToHead } from '../calibration.ts';

const fc = (userAddr: string, marketId: string, p: number) =>
  ({ forecastId: `${userAddr}-${marketId}`, roundId: 'r1', marketId, userAddr, p, tsMs: 1 });
const out = (marketId: string, yes: boolean) =>
  ({ marketId, roundId: 'r1', resolved: true, outcome: (yes ? 0 : 1) as 0 | 1, resolvedTsMs: 2 });
/** A market that exists but has not settled: it must score nobody. */
const unresolved = (marketId: string) =>
  ({ marketId, roundId: 'r1', resolved: false, outcome: null, resolvedTsMs: null });

describe('murphy decomposition', () => {
  it('gives a perfect forecaster zero brier and zero reliability error', () => {
    const m = murphy(
      [fc('u', 'a', 0.999), fc('u', 'b', 0.001)],
      [out('a', true), out('b', false)],
    );
    expect(m.brier).toBeLessThan(0.01);
    expect(m.reliability).toBeLessThan(0.01);
    expect(m.n).toBe(2);
  });

  it('separates a MISCALIBRATED forecaster from an UNDISCRIMINATING one', () => {
    // Always says 90%, right half the time: badly calibrated, no discrimination.
    const over = murphy(
      Array.from({ length: 8 }, (_, i) => fc('u', `m${i}`, 0.9)),
      Array.from({ length: 8 }, (_, i) => out(`m${i}`, i % 2 === 0)),
    );
    // Always says 50%: perfectly honest about knowing nothing.
    const timid = murphy(
      Array.from({ length: 8 }, (_, i) => fc('u', `m${i}`, 0.5)),
      Array.from({ length: 8 }, (_, i) => out(`m${i}`, i % 2 === 0)),
    );
    expect(over.reliability).toBeGreaterThan(timid.reliability);
    expect(timid.resolution).toBeLessThan(0.01);
  });

  it('reports the base rate so a score can be read in context', () => {
    const m = murphy([fc('u', 'a', 0.5), fc('u', 'b', 0.5)], [out('a', true), out('b', true)]);
    expect(m.baseRate).toBe(1);
  });

  it('scores nothing when nothing has resolved, rather than guessing', () => {
    const m = murphy([fc('u', 'a', 0.7)], []);
    expect(m.n).toBe(0);
    expect(m.brier).toBeNull();
  });

  it('ignores a forecast whose market never resolved', () => {
    const m = murphy([fc('u', 'a', 0.7), fc('u', 'zzz', 0.9)], [out('a', true)]);
    expect(m.n).toBe(1);
  });

  it('does not score a market that exists but has not settled', () => {
    const m = murphy([fc('u', 'a', 0.7)], [unresolved('a')]);
    expect(m.n).toBe(0);
    expect(m.brier).toBeNull();
  });
});

describe('calibrationBuckets', () => {
  it('reports observed frequency against stated confidence', () => {
    const forecasts = [
      fc('u', 'a', 0.85), fc('u', 'b', 0.85), fc('u', 'c', 0.85), fc('u', 'd', 0.85),
    ];
    const outcomes = [out('a', true), out('b', true), out('c', true), out('d', false)];
    const b = calibrationBuckets(forecasts, outcomes, 5).find((x) => x.n > 0)!;
    expect(b.observed).toBeCloseTo(0.75, 6);
    expect(b.stated).toBeGreaterThan(0.8);
    expect(b.n).toBe(4);
  });

  it('leaves untouched buckets empty rather than filling them with zero', () => {
    const b = calibrationBuckets([fc('u', 'a', 0.9)], [out('a', true)], 5);
    expect(b.filter((x) => x.n > 0)).toHaveLength(1);
    expect(b.every((x) => x.n > 0 || x.observed === null)).toBe(true);
  });
});

describe('userRecord', () => {
  it('scores only that user\'s own forecasts', () => {
    const all = [fc('alice', 'a', 0.9), fc('bob', 'a', 0.1)];
    const r = userRecord('alice', all, [out('a', true)]);
    expect(r.n).toBe(1);
    expect(r.brier!).toBeLessThan(0.02);
  });
  it('is honest about a user who has never played', () => {
    expect(userRecord('nobody', [], []).n).toBe(0);
  });
});

describe('headToHead', () => {
  it('compares a user with MIRA on the SAME markets only', () => {
    const h = headToHead(
      'alice',
      [fc('alice', 'a', 0.9), fc('alice', 'b', 0.2)],
      // MIRA priced 'a' well and 'b' badly; 'c' is not the user's market.
      [{ marketId: 'a', pModel: 0.8 }, { marketId: 'b', pModel: 0.7 }, { marketId: 'c', pModel: 0.5 }],
      [out('a', true), out('b', false)],
    );
    expect(h.n).toBe(2);
    expect(h.userBrier).toBeLessThan(h.miraBrier!);
    expect(h.verdict).toBe('ahead');
  });

  it('says so when the agent is ahead', () => {
    const h = headToHead('alice', [fc('alice', 'a', 0.1)], [{ marketId: 'a', pModel: 0.9 }], [out('a', true)]);
    expect(h.verdict).toBe('behind');
  });

  it('refuses to declare a winner on no shared markets', () => {
    const h = headToHead('alice', [fc('alice', 'a', 0.5)], [], []);
    expect(h.n).toBe(0);
    expect(h.verdict).toBe('untested');
  });
});
