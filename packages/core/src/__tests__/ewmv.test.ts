// T-020 — EWMV volatility forecast (WP F4). This number IS the edge: the whole
// strategy is `edge = sigmaForecast - sigmaImplied`, so an error here is not a
// degraded signal, it is a fabricated one.
import { describe, it, expect } from 'vitest';
import { Ewmv } from '../ewmv.ts';
import { VirtualClock } from '@arena/shared';

const mk = (over: Partial<ConstructorParameters<typeof Ewmv>[0]> = {}) =>
  new Ewmv({ symbol: 'BTC', lambda: 0.97, minObs: 20, seedVol: 0.6, ticksPerYear: 365 * 24 * 60 * 60, ...over });

describe('T-020 the exponential recurrence', () => {
  it('reproduces v = λv + (1-λ)r² exactly for a hand-checked 3-tick series', () => {
    // λ=0.9, seed variance v0=0. Prices chosen so log-returns are exact-ish.
    const e = mk({ lambda: 0.9, minObs: 0, seedVol: 0, ticksPerYear: 1 });
    e.update(100, 0);
    // r1 = ln(110/100)
    e.update(110, 1);
    const r1 = Math.log(110 / 100);
    const v1 = 0.9 * 0 + 0.1 * r1 * r1;
    expect(e.variance).toBeCloseTo(v1, 15);
    // r2 = ln(99/110)
    e.update(99, 2);
    const r2 = Math.log(99 / 110);
    const v2 = 0.9 * v1 + 0.1 * r2 * r2;
    expect(e.variance).toBeCloseTo(v2, 15);
    // with ticksPerYear = 1, annualized sigma is just sqrt(variance)
    expect(e.sigma).toBeCloseTo(Math.sqrt(v2), 15);
  });

  it('drives variance toward zero on a constant price series', () => {
    const e = mk({ minObs: 0, seedVol: 1 });
    e.update(100, 0);
    for (let i = 1; i <= 2_000; i++) e.update(100, i);
    expect(e.variance).toBeLessThan(1e-12);
  });

  it('annualizes as sqrt(variance * ticksPerYear)', () => {
    const e = mk({ minObs: 0, seedVol: 0, lambda: 0.5, ticksPerYear: 10_000 });
    e.update(100, 0);
    e.update(101, 1);
    expect(e.sigma).toBeCloseTo(Math.sqrt(e.variance * 10_000), 12);
  });

  it('produces a strictly positive sigma once it has observations', () => {
    const e = mk({ minObs: 2 });
    e.update(100, 0);
    e.update(101, 1);
    e.update(100.5, 2);
    expect(e.sigma).toBeGreaterThan(0);
    expect(Number.isFinite(e.sigma)).toBe(true);
  });
});

describe('T-020 response to shocks', () => {
  it('raises sigma on a large return, then decays monotonically through quiet ticks', () => {
    const e = mk({ minObs: 0, lambda: 0.94 });
    e.update(100, 0);
    for (let i = 1; i <= 50; i++) e.update(100, i);      // quiet
    const calm = e.sigma;
    e.update(120, 51);                                    // shock
    const shocked = e.sigma;
    expect(shocked).toBeGreaterThan(calm);

    let prev = shocked;
    for (let i = 52; i <= 200; i++) {
      e.update(120, i);                                   // quiet again, flat price
      expect(e.sigma).toBeLessThanOrEqual(prev + 1e-15);
      prev = e.sigma;
    }
    expect(prev).toBeLessThan(shocked);
  });

  it('weights recent returns more than old ones (that is the point of EW)', () => {
    const shockFirst = mk({ minObs: 0, lambda: 0.9, seedVol: 0 });
    shockFirst.update(100, 0); shockFirst.update(120, 1);
    for (let i = 2; i < 12; i++) shockFirst.update(120, i);

    const shockLast = mk({ minObs: 0, lambda: 0.9, seedVol: 0 });
    shockLast.update(100, 0);
    for (let i = 1; i < 11; i++) shockLast.update(100, i);
    shockLast.update(120, 11);

    expect(shockLast.sigma).toBeGreaterThan(shockFirst.sigma);
  });
});

describe('T-020 warm-up: never NaN, never a lie', () => {
  it('reports the seeded prior before minObs is reached, not NaN', () => {
    const e = mk({ minObs: 20, seedVol: 0.6 });
    expect(e.sigma).toBe(0.6);
    expect(e.warm).toBe(false);
    e.update(100, 0);
    e.update(101, 1);
    expect(e.sigma).toBe(0.6);
    expect(e.warm).toBe(false);
  });

  it('switches to the measured estimate exactly at minObs', () => {
    const e = mk({ minObs: 5, seedVol: 0.6 });
    e.update(100, 0);
    for (let i = 1; i <= 4; i++) e.update(100 + i, i);   // 4 returns
    expect(e.warm).toBe(false);
    e.update(105, 5);                                     // 5th return
    expect(e.warm).toBe(true);
    expect(e.sigma).not.toBe(0.6);
  });

  it('never returns NaN or a negative sigma across a hostile series', () => {
    const e = mk({ minObs: 3 });
    const prices = [100, 100, 0.0001, 1e9, 100, 100, 1e-9, 100];
    prices.forEach((p, i) => e.update(p, i));
    expect(Number.isNaN(e.sigma)).toBe(false);
    expect(e.sigma).toBeGreaterThanOrEqual(0);
  });
});

describe('T-020 input hygiene', () => {
  it('ignores a non-positive price (a log return would be NaN/-Infinity)', () => {
    const e = mk({ minObs: 0 });
    e.update(100, 0);
    const before = e.variance;
    e.update(0, 1);
    e.update(-5, 2);
    expect(e.variance).toBe(before);
    expect(e.rejected).toBe(2);
  });

  it('ignores a NaN price', () => {
    const e = mk({ minObs: 0 });
    e.update(100, 0);
    e.update(Number.NaN, 1);
    expect(Number.isNaN(e.variance)).toBe(false);
    expect(e.rejected).toBe(1);
  });

  it('counts observations only for accepted returns', () => {
    const e = mk({ minObs: 100 });
    e.update(100, 0);
    e.update(101, 1);
    e.update(0, 2);
    expect(e.nObs).toBe(1);
  });

  it('rejects a lambda outside (0,1) at construction rather than producing garbage', () => {
    expect(() => mk({ lambda: 0 })).toThrow();
    expect(() => mk({ lambda: 1 })).toThrow();
    expect(() => mk({ lambda: 1.5 })).toThrow();
  });
});

describe('T-020 state export', () => {
  it('emits a ModelState matching IF §2', () => {
    const clock = new VirtualClock(5_000);
    const e = mk({ minObs: 0 });
    e.update(100, 0);
    e.update(101, 1);
    const st = e.state(clock.now());
    expect(st).toEqual({
      symbol: 'BTC', spot: 101, sigmaForecast: e.sigma, variance: e.variance,
      lambda: 0.97, nObs: 1, tsMs: 5_000,
    });
  });

  it('reset returns it to the pre-warm state', () => {
    const e = mk({ minObs: 5, seedVol: 0.6 });
    for (let i = 0; i < 20; i++) e.update(100 + i, i);
    expect(e.warm).toBe(true);
    e.reset();
    expect(e.warm).toBe(false);
    expect(e.nObs).toBe(0);
    expect(e.sigma).toBe(0.6);
  });
});

describe('T-020 performance (WP F4: O(1) per tick)', () => {
  it('performs 1 000 000 updates in under 200 ms', () => {
    const e = mk({ minObs: 0 });
    e.update(100, 0);
    const t0 = performance.now();
    for (let i = 1; i <= 1_000_000; i++) e.update(100 + (i % 7) * 0.01, i);
    const el = performance.now() - t0;
    expect(el).toBeLessThan(200);
  });

  it('allocates no per-tick state (cost is independent of history length)', () => {
    const e = mk({ minObs: 0 });
    e.update(100, 0);
    const time = (n: number) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) e.update(100 + (i % 3) * 0.01, i);
      return performance.now() - t0;
    };
    time(200_000);                       // warm the JIT and build "history"
    const early = time(200_000);
    const late = time(200_000);
    expect(late).toBeLessThan(early * 3 + 5);   // no growth with history
  });
});
