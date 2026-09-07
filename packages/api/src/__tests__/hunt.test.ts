// T-042 Brier scoring and T-043 hunt settlement (FR-S3, F-A5, GWT-5, WP §6).
import { describe, it, expect, vi } from 'vitest';
import { VirtualClock, type Forecast, type Outcome } from '@arena/shared';
import { EventBus } from '@arena/data';
import { brierScore, eligibleCount, rankRound, scorableForecasts, UNINFORMED_BRIER } from '../brier.ts';
import { HuntService, proRataWeights } from '../hunt.ts';

const fc = (userAddr: string, p: number, over: Partial<Forecast> = {}): Forecast => ({
  forecastId: `f-${userAddr}-${Math.random()}`,
  roundId: 'r1', marketId: 'm1', userAddr, p, tsMs: 1_000, ...over,
});

const oc = (marketId: string, outcome: 0 | 1 | null, over: Partial<Outcome> = {}): Outcome => ({
  marketId, roundId: 'r1', resolved: outcome !== null, outcome,
  resolvedTsMs: outcome !== null ? 2_000 : null, ...over,
});

describe('T-042 the Brier score itself', () => {
  it('is exactly (p - o)^2', () => {
    expect(brierScore(0.7, 1)).toBeCloseTo(0.09, 15);
    expect(brierScore(0.7, 0)).toBeCloseTo(0.49, 15);
    expect(brierScore(0.25, 0)).toBeCloseTo(0.0625, 15);
  });

  it('is 0 for a perfect forecast and 1 for a confidently wrong one', () => {
    expect(brierScore(1, 1)).toBe(0);
    expect(brierScore(0, 0)).toBe(0);
    expect(brierScore(1, 0)).toBe(1);
    expect(brierScore(0, 1)).toBe(1);
  });

  it('scores a shrug at 0.25, the reference line for beating a coin flip', () => {
    expect(brierScore(0.5, 0)).toBe(UNINFORMED_BRIER);
    expect(brierScore(0.5, 1)).toBe(UNINFORMED_BRIER);
    expect(UNINFORMED_BRIER).toBe(0.25);
  });

  it('rewards being closer to the truth, monotonically', () => {
    let prev = 0;
    for (let p = 1; p >= 0; p -= 0.1) {
      const s = brierScore(p, 1);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = s;
    }
  });
});

describe('T-042 ranking a round', () => {
  it('averages a user’s score over their resolved forecasts', () => {
    const scores = rankRound({
      roundId: 'r1',
      forecasts: [fc('0xa', 0.9, { marketId: 'm1' }), fc('0xa', 0.1, { marketId: 'm2' })],
      outcomes: [oc('m1', 1), oc('m2', 0)],
    });
    // (0.01 + 0.01) / 2 = 0.01
    expect(scores).toHaveLength(1);
    expect(scores[0]!.brier).toBeCloseTo(0.01, 12);
    expect(scores[0]!.nForecasts).toBe(2);
  });

  it('ranks ascending by Brier with rank numbers from 1', () => {
    const scores = rankRound({
      roundId: 'r1',
      forecasts: [fc('0xbad', 0.1), fc('0xgood', 0.95), fc('0xmid', 0.6)],
      outcomes: [oc('m1', 1)],
    });
    expect(scores.map((s) => s.userAddr)).toEqual(['0xgood', '0xmid', '0xbad']);
    expect(scores.map((s) => s.rank)).toEqual([1, 2, 3]);
  });

  it('excludes unresolved markets from scoring', () => {
    const scores = rankRound({
      roundId: 'r1',
      forecasts: [fc('0xa', 0.9, { marketId: 'm1' }), fc('0xa', 0.0, { marketId: 'pending' })],
      outcomes: [oc('m1', 1), oc('pending', null)],
    });
    expect(scores[0]!.nForecasts).toBe(1);
    expect(scores[0]!.brier).toBeCloseTo(0.01, 12);   // the pending 0.0 is ignored
  });

  it('EXCLUDES a user with zero resolved forecasts rather than scoring them 0', () => {
    // Scoring them 0 would put the least engaged participant at the TOP, since
    // 0 is the perfect Brier score.
    const scores = rankRound({
      roundId: 'r1',
      forecasts: [fc('0xplayer', 0.9, { marketId: 'm1' }), fc('0xlurker', 0.5, { marketId: 'pending' })],
      outcomes: [oc('m1', 1), oc('pending', null)],
    });
    expect(scores.map((s) => s.userAddr)).toEqual(['0xplayer']);
    expect(scores.find((s) => s.userAddr === '0xlurker')).toBeUndefined();
  });

  it('excludes forecasts from other rounds', () => {
    const scores = rankRound({
      roundId: 'r1',
      forecasts: [fc('0xa', 0.9), fc('0xb', 0.9, { roundId: 'r2' })],
      outcomes: [oc('m1', 1), oc('m1', 1, { roundId: 'r2' })],
    });
    expect(scores.map((s) => s.userAddr)).toEqual(['0xa']);
  });

  it('breaks ties on the earliest forecast, deterministically', () => {
    const scores = rankRound({
      roundId: 'r1',
      forecasts: [
        fc('0xlate', 0.8, { tsMs: 9_000 }),
        fc('0xearly', 0.8, { tsMs: 1_000 }),
      ],
      outcomes: [oc('m1', 1)],
    });
    expect(scores.map((s) => s.userAddr)).toEqual(['0xearly', '0xlate']);
    // and it is stable across repeated runs
    for (let i = 0; i < 5; i++) {
      expect(rankRound({
        roundId: 'r1',
        forecasts: [fc('0xlate', 0.8, { tsMs: 9_000 }), fc('0xearly', 0.8, { tsMs: 1_000 })],
        outcomes: [oc('m1', 1)],
      }).map((s) => s.userAddr)).toEqual(['0xearly', '0xlate']);
    }
  });

  it('ignores a forecast that is not a probability', () => {
    const scores = rankRound({
      roundId: 'r1',
      forecasts: [fc('0xa', 1.5), fc('0xa', -0.2), fc('0xa', Number.NaN), fc('0xa', 0.9)],
      outcomes: [oc('m1', 1)],
    });
    expect(scores[0]!.nForecasts).toBe(1);
  });

  it('returns an empty leaderboard when nothing has resolved', () => {
    expect(rankRound({
      roundId: 'r1', forecasts: [fc('0xa', 0.9)], outcomes: [oc('m1', null)],
    })).toEqual([]);
    expect(eligibleCount({ roundId: 'r1', forecasts: [fc('0xa', 0.9)], outcomes: [] })).toBe(0);
  });

  it('scorableForecasts reports exactly what was counted', () => {
    const fs = [fc('0xa', 0.9, { marketId: 'm1' }), fc('0xa', 0.1, { marketId: 'pending' })];
    const got = scorableForecasts({ roundId: 'r1', forecasts: fs, outcomes: [oc('m1', 1), oc('pending', null)] });
    expect(got).toHaveLength(1);
    expect(got[0]!.marketId).toBe('m1');
  });
});

describe('T-043 pro-rata weights', () => {
  it('sum to 1', () => {
    const w = proRataWeights([
      { userAddr: '0xa', roundId: 'r1', brier: 0.05, nForecasts: 1, rank: 1 },
      { userAddr: '0xb', roundId: 'r1', brier: 0.20, nForecasts: 1, rank: 2 },
      { userAddr: '0xc', roundId: 'r1', brier: 0.40, nForecasts: 1, rank: 3 },
    ]);
    expect(w.reduce((a, x) => a + x.weight, 0)).toBeCloseTo(1, 12);
  });

  it('pay the better forecaster more', () => {
    const w = proRataWeights([
      { userAddr: '0xgood', roundId: 'r1', brier: 0.02, nForecasts: 1, rank: 1 },
      { userAddr: '0xbad', roundId: 'r1', brier: 0.60, nForecasts: 1, rank: 2 },
    ]);
    expect(w[0]!.weight).toBeGreaterThan(w[1]!.weight);
  });

  it('use (1 - brier), which does not diverge on a near-perfect score', () => {
    // Inverse-Brier would give this forecaster essentially the whole pot.
    const w = proRataWeights([
      { userAddr: '0xlucky', roundId: 'r1', brier: 0.0001, nForecasts: 1, rank: 1 },
      { userAddr: '0xsolid', roundId: 'r1', brier: 0.05, nForecasts: 1, rank: 2 },
    ]);
    expect(w[0]!.weight).toBeLessThan(0.55);        // a share, not a windfall
    expect(w[0]!.weight).toBeGreaterThan(w[1]!.weight);
  });

  it('split evenly when everyone scored perfectly', () => {
    const w = proRataWeights([
      { userAddr: '0xa', roundId: 'r1', brier: 0, nForecasts: 1, rank: 1 },
      { userAddr: '0xb', roundId: 'r1', brier: 0, nForecasts: 1, rank: 2 },
    ]);
    expect(w[0]!.weight).toBeCloseTo(0.5, 12);
    expect(w[1]!.weight).toBeCloseTo(0.5, 12);
  });

  it('split evenly when everyone was confidently wrong', () => {
    const w = proRataWeights([
      { userAddr: '0xa', roundId: 'r1', brier: 1, nForecasts: 1, rank: 1 },
      { userAddr: '0xb', roundId: 'r1', brier: 1, nForecasts: 1, rank: 2 },
    ]);
    expect(w.reduce((a, x) => a + x.weight, 0)).toBeCloseTo(1, 12);
  });

  it('return nothing for an empty field', () => {
    expect(proRataWeights([])).toEqual([]);
  });
});

const mk = (over: Partial<ConstructorParameters<typeof HuntService>[0]> = {}) => {
  const clock = new VirtualClock(0);
  const bus = new EventBus();
  const hunt = new HuntService({ clock, bus, roundDurationMs: 300_000, topN: 5, ...over });
  return { clock, bus, hunt };
};

describe('T-043 the round clock', () => {
  it('opens a round with a window and OPEN status', () => {
    const { hunt } = mk();
    const r = hunt.open(['m1', 'm2']);
    expect(r.status).toBe('OPEN');
    expect(r.closeMs - r.openMs).toBe(300_000);
    expect(r.marketIds).toEqual(['m1', 'm2']);
    expect(r.index).toBe(1);
    expect(r.topN).toBe(5);
  });

  it('is due only once the clock passes the close time', () => {
    const { hunt, clock } = mk();
    hunt.open(['m1']);
    expect(hunt.isDue()).toBe(false);
    clock.advance(299_999);
    expect(hunt.isDue()).toBe(false);
    clock.advance(1);
    expect(hunt.isDue()).toBe(true);
  });

  it('transitions OPEN -> SCORING -> SETTLED', () => {
    const { hunt } = mk();
    const r = hunt.open(['m1']);
    expect(r.status).toBe('OPEN');
    expect(hunt.closeForScoring(10)!.status).toBe('SCORING');
    hunt.settle({ forecasts: [fc('0xa', 0.9, { roundId: r.roundId })],
      outcomes: [oc('m1', 1, { roundId: r.roundId })] });
    expect(hunt.round!.status).toBe('SETTLED');
  });

  it('publishes a round event on every transition', () => {
    const { hunt, bus } = mk();
    const seen: string[] = [];
    bus.on('round', (r) => { seen.push(r.status); });
    const r = hunt.open(['m1']);
    hunt.closeForScoring(0);
    hunt.settle({ forecasts: [fc('0xa', 0.9, { roundId: r.roundId })],
      outcomes: [oc('m1', 1, { roundId: r.roundId })] });
    expect(seen).toEqual(['OPEN', 'SCORING', 'SETTLED']);
  });

  it('increments the round index', () => {
    const { hunt } = mk();
    expect(hunt.open(['m1']).index).toBe(1);
    expect(hunt.open(['m1']).index).toBe(2);
  });

  it('refuses to settle with no round at all', () => {
    const { hunt } = mk();
    expect(() => hunt.settle({ forecasts: [], outcomes: [] })).toThrow(/no round/i);
  });
});

describe('T-043 GWT-5: settlement pays the top-N pro rata', () => {
  const round = (hunt: HuntService) => hunt.open(['m1', 'm2']);

  it('pot equals max(0, miraPnlUsd) for the round window', () => {
    const { hunt } = mk();
    const r = round(hunt);
    const s = hunt.settle({
      miraPnlUsd: 100,
      forecasts: [fc('0xa', 0.9, { roundId: r.roundId })],
      outcomes: [oc('m1', 1, { roundId: r.roundId })],
    });
    expect(s.potUsd).toBe(100);
    expect(s.miraPnlUsd).toBe(100);
  });

  it('payouts sum to the pot within 1e-6', () => {
    const { hunt } = mk();
    const r = round(hunt);
    const s = hunt.settle({
      miraPnlUsd: 137.77,
      forecasts: [
        fc('0xa', 0.93, { roundId: r.roundId }),
        fc('0xb', 0.71, { roundId: r.roundId }),
        fc('0xc', 0.55, { roundId: r.roundId }),
      ],
      outcomes: [oc('m1', 1, { roundId: r.roundId })],
    });
    const sum = s.payouts.reduce((a, p) => a + p.amountUsd, 0);
    expect(Math.abs(sum - s.potUsd)).toBeLessThan(1e-6);
  });

  it('payouts sum exactly to the pot across many awkward values', () => {
    for (const pnl of [0.01, 1 / 3, 137.77, 999.999, 1e-4]) {
      const { hunt } = mk();
      const r = round(hunt);
      const s = hunt.settle({
        miraPnlUsd: pnl,
        forecasts: [
          fc('0xa', 0.93, { roundId: r.roundId }),
          fc('0xb', 0.71, { roundId: r.roundId }),
          fc('0xc', 0.55, { roundId: r.roundId }),
          fc('0xd', 0.4, { roundId: r.roundId }),
        ],
        outcomes: [oc('m1', 1, { roundId: r.roundId })],
      });
      const sum = s.payouts.reduce((a, p) => a + p.amountUsd, 0);
      expect(Math.abs(sum - s.potUsd)).toBeLessThan(1e-9);
    }
  });

  it('pays ONLY the top N', () => {
    const { hunt } = mk({ topN: 2 });
    const r = hunt.open(['m1']);
    const s = hunt.settle({
      miraPnlUsd: 100,
      forecasts: [
        fc('0xbest', 0.99, { roundId: r.roundId }),
        fc('0xsecond', 0.9, { roundId: r.roundId }),
        fc('0xthird', 0.6, { roundId: r.roundId }),
        fc('0xfourth', 0.2, { roundId: r.roundId }),
      ],
      outcomes: [oc('m1', 1, { roundId: r.roundId })],
    });
    expect(s.payouts.map((p) => p.userAddr)).toEqual(['0xbest', '0xsecond']);
    expect(s.scores).toHaveLength(4);            // all ranked, only 2 paid
  });

  it('the best forecaster receives the largest payout', () => {
    const { hunt } = mk();
    const r = hunt.open(['m1']);
    const s = hunt.settle({
      miraPnlUsd: 100,
      forecasts: [fc('0xgood', 0.98, { roundId: r.roundId }), fc('0xmeh', 0.55, { roundId: r.roundId })],
      outcomes: [oc('m1', 1, { roundId: r.roundId })],
    });
    expect(s.payouts[0]!.userAddr).toBe('0xgood');
    expect(s.payouts[0]!.amountUsd).toBeGreaterThan(s.payouts[1]!.amountUsd);
  });

  it('records a journal seq so the payout is verifiable (GWT-5)', () => {
    const onSettle = vi.fn(() => 4_242);
    const { hunt } = mk({ onSettle });
    const r = hunt.open(['m1']);
    const s = hunt.settle({
      miraPnlUsd: 10,
      forecasts: [fc('0xa', 0.9, { roundId: r.roundId })],
      outcomes: [oc('m1', 1, { roundId: r.roundId })],
    });
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(s.journalSeq).toBe(4_242);
    expect(s.method).toBe('BRIER_PRO_RATA');
  });

  it('publishes exactly one settlement event', () => {
    const { hunt, bus } = mk();
    const seen: number[] = [];
    bus.on('settlement', (s) => { seen.push(s.potUsd); });
    const r = hunt.open(['m1']);
    hunt.settle({ miraPnlUsd: 50, forecasts: [fc('0xa', 0.9, { roundId: r.roundId })],
      outcomes: [oc('m1', 1, { roundId: r.roundId })] });
    expect(seen).toEqual([50]);
  });
});

describe('T-043 a losing round still settles', () => {
  it('pot is 0 and there are no payouts, but the round closes', () => {
    const { hunt } = mk();
    const r = hunt.open(['m1']);
    const s = hunt.settle({
      miraPnlUsd: -75,
      forecasts: [fc('0xa', 0.9, { roundId: r.roundId })],
      outcomes: [oc('m1', 1, { roundId: r.roundId })],
    });
    expect(s.miraPnlUsd).toBe(-75);
    expect(s.potUsd).toBe(0);
    expect(s.payouts).toEqual([]);
    expect(s.scores).toHaveLength(1);            // humans are still ranked
    expect(hunt.round!.status).toBe('SETTLED');
  });
});

describe('T-043 idempotence (no double payout)', () => {
  it('settling twice returns the original settlement', () => {
    const onSettle = vi.fn(() => 7);
    const { hunt } = mk({ onSettle });
    const r = hunt.open(['m1']);
    const args = {
      miraPnlUsd: 100,
      forecasts: [fc('0xa', 0.9, { roundId: r.roundId })],
      outcomes: [oc('m1', 1, { roundId: r.roundId })],
    };
    const a = hunt.settle(args);
    const b = hunt.settle(args);
    expect(b).toBe(a);
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(hunt.statsSnapshot().roundsSettled).toBe(1);
  });

  it('keeps every settlement addressable by roundId', () => {
    const { hunt } = mk();
    const r = hunt.open(['m1']);
    const s = hunt.settle({ miraPnlUsd: 10, forecasts: [fc('0xa', 0.9, { roundId: r.roundId })],
      outcomes: [oc('m1', 1, { roundId: r.roundId })] });
    expect(hunt.settlementFor(r.roundId)).toBe(s);
    expect(hunt.settlementFor('nope')).toBeNull();
  });
});

describe('T-043 an unclaimed pot rolls forward', () => {
  it('rolls the pot to the next round when nobody is eligible', () => {
    const { hunt } = mk();
    const r1 = hunt.open(['m1']);
    const s1 = hunt.settle({ miraPnlUsd: 80, forecasts: [], outcomes: [] });
    expect(s1.payouts).toEqual([]);
    expect(hunt.rolloverUsd).toBe(80);

    const r2 = hunt.open(['m1']);
    expect(r2.potUsd).toBe(80);                  // visible from the open
    const s2 = hunt.settle({
      roundId: r2.roundId, miraPnlUsd: 20,
      forecasts: [fc('0xa', 0.9, { roundId: r2.roundId })],
      outcomes: [oc('m1', 1, { roundId: r2.roundId })],
    });
    expect(s2.potUsd).toBe(100);                 // 80 rolled + 20 earned
    expect(s2.payouts[0]!.amountUsd).toBeCloseTo(100, 9);
    expect(hunt.rolloverUsd).toBe(0);
    expect(r1.roundId).not.toBe(r2.roundId);
  });

  it('does not roll a zero pot', () => {
    const { hunt } = mk();
    hunt.open(['m1']);
    hunt.settle({ miraPnlUsd: -10, forecasts: [], outcomes: [] });
    expect(hunt.rolloverUsd).toBe(0);
  });

  it('rolls forward across several quiet rounds', () => {
    const { hunt } = mk();
    for (const pnl of [10, 20, 30]) {
      hunt.open(['m1']);
      hunt.settle({ miraPnlUsd: pnl, forecasts: [], outcomes: [] });
    }
    expect(hunt.rolloverUsd).toBe(60);
  });
});

describe('T-043 leaderboard read', () => {
  it('ranks an in-flight round without settling it', () => {
    const { hunt } = mk();
    const r = hunt.open(['m1']);
    const lb = hunt.leaderboard({
      forecasts: [fc('0xa', 0.9, { roundId: r.roundId }), fc('0xb', 0.2, { roundId: r.roundId })],
      outcomes: [oc('m1', 1, { roundId: r.roundId })],
    });
    expect(lb.map((s) => s.userAddr)).toEqual(['0xa', '0xb']);
    expect(hunt.round!.status).toBe('OPEN');
  });

  it('returns empty when no round is open', () => {
    const { hunt } = mk();
    expect(hunt.leaderboard({ forecasts: [], outcomes: [] })).toEqual([]);
  });
});
