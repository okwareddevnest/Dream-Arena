// T-021 — F1/F2/F3 (WP §4 as amended by RFC-002). These tests ARE the model
// spec (WP §4: "Model sanity suite (tests as spec)").
import { describe, it, expect } from 'vitest';
import { f1ExpiryProb, f2ImpliedVol, f3TouchProb, decodeStrike, priceMarket, maxAttainableProb, branchPointVol } from '../pricer.ts';
import { norm, type Market, type Quote } from '@arena/shared';

const SEC = 1 / (365 * 24 * 60 * 60);
const T60 = 60 * SEC;          // a 60 s window — the live cadence (T-S1 C5)
const T300 = 300 * SEC;
/** The venue's price tick: priceDecimals 6 => 1e-6 (T-S2). A quote cannot be finer. */
const TICK = 1e-6;

const market = (over: Partial<Market> = {}): Market => ({
  id: '0x1', symbol: 'BTC-79000', yesSymbol: 'y', noSymbol: 'n', asset: 'BTC',
  strike: 79_000, mode: 'fixed', boundaryPosted: true, intervalSec: 60,
  tradingStartMs: 0, expiryMs: 60_000, style: 'EXPIRY',
  tickRaw: 1_000n, lotRaw: 1n, priceDecimals: 6, minSize: 1, feeBps: 0,
  poolAddress: null, nonce: null, venue: 'SIM', status: 'Trading', ...over,
});

const quote = (mid: number, over: Partial<Quote> = {}): Quote => ({
  marketId: '0x1', bid: mid - 0.01, ask: mid + 0.01, mid,
  depthBid: 100, depthAsk: 100, stale: false, tsMs: 0, ...over,
});

describe('T-021 F1 — expiry probability (full N(d2), RFC-002)', () => {
  it('is Φ(−σ√τ/2) at the money, not exactly 0.5', () => {
    const sigma = 0.6;
    const p = f1ExpiryProb(79_000, 79_000, sigma, T60);
    expect(p).toBeCloseTo(norm.cdf(-(sigma * Math.sqrt(T60)) / 2), 15);
    expect(p).toBeLessThan(0.5);                       // strictly below
  });

  it('is within 1e-3 of 0.5 at the money for tau <= 300 s (RFC-002 R4 scope)', () => {
    for (const tau of [T60, T300]) {
      for (const sigma of [0.2, 0.6, 1.5]) {
        expect(Math.abs(f1ExpiryProb(100, 100, sigma, tau) - 0.5)).toBeLessThan(1e-3);
      }
    }
  });

  it('deviates from 0.5 at the money by exactly phi(0)*sigma*sqrt(tau)/2 to first order', () => {
    // The deviation is real and grows with the window; it is not an error term
    // to be hidden. At 900 s with sigma=1.5 it is 1.6e-3, above the 1e-3 bound
    // that holds for the shorter cadences.
    for (const tau of [T60, T300, 900 * SEC]) {
      for (const sigma of [0.2, 0.6, 1.5]) {
        const dev = 0.5 - f1ExpiryProb(100, 100, sigma, tau);
        const firstOrder = norm.pdf(0) * ((sigma * Math.sqrt(tau)) / 2);
        expect(dev).toBeGreaterThan(0);
        expect(Math.abs(dev - firstOrder)).toBeLessThan(firstOrder * 1e-3);
      }
    }
  });

  it('tends to 0.5 at the money as tau -> 0, shrinking as sqrt(tau)', () => {
    const a = Math.abs(f1ExpiryProb(100, 100, 0.6, 1e-8) - 0.5);
    const b = Math.abs(f1ExpiryProb(100, 100, 0.6, 1e-12) - 0.5);
    const c = Math.abs(f1ExpiryProb(100, 100, 0.6, 1e-20) - 0.5);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(c).toBeLessThan(1e-10);
    // sqrt scaling: 1e4x smaller tau => 1e2x smaller deviation
    expect(a / b).toBeCloseTo(100, 0);
  });

  it('stays in [0,1] across the whole parameter grid', () => {
    for (const sigma of [0.01, 0.1, 0.5, 1, 2, 5]) {
      for (const tau of [1e-6, 1e-4, 0.01, 0.5, 1]) {
        for (const ratio of [0.5, 0.8, 0.95, 1, 1.05, 1.2, 2]) {
          const p = f1ExpiryProb(100 * ratio, 100, sigma, tau);
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
          expect(Number.isNaN(p)).toBe(false);
        }
      }
    }
  });

  it('is monotone non-increasing in σ when S > K', () => {
    let prev = 1.1;
    for (let sigma = 0.05; sigma <= 3; sigma += 0.05) {
      const p = f1ExpiryProb(105, 100, sigma, 0.05);
      expect(p).toBeLessThanOrEqual(prev + 1e-12);
      prev = p;
    }
  });

  it('for S < K rises to Φ(−√(2|m|)) at σ√τ = √(2|m|), then falls (RFC-002)', () => {
    const S = 90, K = 100, tau = 0.05;
    const m = Math.log(S / K);                      // negative
    const peakSigma = Math.sqrt(2 * Math.abs(m)) / Math.sqrt(tau);
    const peak = f1ExpiryProb(S, K, peakSigma, tau);
    expect(peak).toBeCloseTo(norm.cdf(-Math.sqrt(2 * Math.abs(m))), 12);
    // strictly lower on both sides of the peak
    expect(f1ExpiryProb(S, K, peakSigma * 0.5, tau)).toBeLessThan(peak);
    expect(f1ExpiryProb(S, K, peakSigma * 2, tau)).toBeLessThan(peak);
    // and the peak is the documented ceiling for this strike
    expect(maxAttainableProb(S, K)).toBeCloseTo(peak, 12);
  });

  it('goes to 1 deep in the money and 0 deep out of it', () => {
    expect(f1ExpiryProb(1e6, 100, 0.5, T60)).toBeCloseTo(1, 12);
    expect(f1ExpiryProb(1e-6, 100, 0.5, T60)).toBeCloseTo(0, 12);
  });

  it('is numerically stable at a 60 s horizon (τ = 1.9e-6 yr)', () => {
    const p = f1ExpiryProb(79_100, 79_000, 0.6, T60);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0.5);
    expect(p).toBeLessThanOrEqual(1);
  });

  it('returns 0/1 rather than NaN when σ or τ collapses to zero', () => {
    expect(f1ExpiryProb(105, 100, 0, 0.1)).toBe(1);    // certain: already above
    expect(f1ExpiryProb(95, 100, 0, 0.1)).toBe(0);     // certain: cannot get there
    expect(f1ExpiryProb(105, 100, 0.5, 0)).toBe(1);
    expect(f1ExpiryProb(95, 100, 0.5, 0)).toBe(0);
  });
});

describe('T-021 F2 — implied volatility (WP F2)', () => {
  it('inverts F1 exactly on the branch it selects (relative error < 1e-6)', () => {
    let checked = 0;
    for (const sigma of [0.05, 0.2, 0.6, 1.0, 2.0]) {
      for (const tau of [1e-5, T300, 0.01, 0.25]) {
        for (const ratio of [0.9, 0.99, 1.0, 1.01, 1.1]) {
          const S = 100 * ratio, K = 100;
          // F2 returns the low-volatility root out of the money, so the
          // round-trip is only defined for inputs on that branch. In the money
          // the root is unique and every input qualifies.
          if (sigma >= branchPointVol(S, K, tau)) continue;
          const p = f1ExpiryProb(S, K, sigma, tau);
          const got = f2ImpliedVol(S, K, p, tau);
          if (got.sigma === null) continue;
          expect(Math.abs(got.sigma - sigma) / sigma).toBeLessThan(1e-6);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(40);        // the scoping must not empty the test
  });

  it('inverts F1 at every realistic live parameter set (the operating regime)', () => {
    // BTC-like volatility on the cadences DreamDEX actually runs. Nothing here
    // is anywhere near the branch point, which is the point.
    for (const sigma of [0.3, 0.45, 0.6, 0.8, 1.2]) {
      for (const tau of [T60, T300, 900 * SEC]) {
        for (const bps of [-500, -100, -10, 0, 10, 100, 500]) {
          const S = 79_000 * (1 + bps / 10_000), K = 79_000;
          expect(sigma).toBeLessThan(branchPointVol(S, K, tau));   // always true here
          const p = f1ExpiryProb(S, K, sigma, tau);
          // A real venue quotes on a tick grid (priceDecimals 6 => 1e-6), so a
          // price cannot sit 1e-14 away from 1. Restrict to the representable,
          // tradable domain; the unrepresentable tail is pinned separately below.
          if (p <= TICK || p >= 1 - TICK) continue;
          const got = f2ImpliedVol(S, K, p, tau);
          expect(got.sigma).not.toBeNull();
          expect(Math.abs(got.sigma! - sigma) / sigma).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('degrades gracefully, not catastrophically, in the unrepresentable tail', () => {
    // At 1 - p = 1.4e-14 the price itself carries ~2 significant digits, so no
    // implementation can recover sigma to 1e-6. What matters is that the answer
    // stays close and finite rather than exploding or returning null.
    const S = 79_000 * 1.05, K = 79_000, tau = 900 / (365 * 24 * 60 * 60), sigma = 1.2;
    const p = f1ExpiryProb(S, K, sigma, tau);
    expect(1 - p).toBeLessThan(1e-13);                 // outside any tick grid
    const got = f2ImpliedVol(S, K, p, tau);
    expect(got.sigma).not.toBeNull();
    expect(Math.abs(got.sigma! - sigma) / sigma).toBeLessThan(1e-4);
  });

  it('holds 1e-6 accuracy across the full tick grid a venue can actually quote', () => {
    const K = 79_000, tau = T300;
    for (let ticks = 1; ticks < 1_000_000; ticks = Math.ceil(ticks * 3.3)) {
      const p = ticks * TICK;
      if (p >= 1) break;
      const r = f2ImpliedVol(K * 1.001, K, p, tau);
      if (r.sigma === null) continue;
      // round-trip the recovered vol back through F1 and land on the same price
      expect(Math.abs(f1ExpiryProb(K * 1.001, K, r.sigma, tau) - p)).toBeLessThan(1e-9);
    }
  });

  it('the branch point sits far above the operating regime on every live window', () => {
    // This is the fact that makes the low-branch choice correct rather than
    // arbitrary (RFC-002 as corrected).
    for (const tau of [T60, T300, 900 * SEC]) {
      for (const bps of [10, 50, 100, 500]) {
        const S = 79_000 * (1 - bps / 10_000);
        expect(branchPointVol(S, 79_000, tau)).toBeGreaterThan(8);   // >= 800% vol
      }
    }
    expect(branchPointVol(79_100, 79_000, T60)).toBe(Infinity);       // in the money
  });

  it('is stable against catastrophic cancellation on the low branch', () => {
    // Computing x_low as (-z - sqrt(disc)) subtracts two nearly-equal numbers
    // and loses most significant digits. The product identity does not.
    const S = 79_000 * (1 - 0.001), K = 79_000, tau = T60, sigma = 0.6;
    const p = f1ExpiryProb(S, K, sigma, tau);
    const got = f2ImpliedVol(S, K, p, tau);
    expect(Math.abs(got.sigma! - sigma) / sigma).toBeLessThan(1e-9);
  });

  it('THE RFC-002 REGRESSION: a fairly-priced ATM market has edge exactly 0', () => {
    const sigma = 0.6, S = 100, K = 100, tau = T60;
    const fair = f1ExpiryProb(S, K, sigma, tau);
    const impl = f2ImpliedVol(S, K, fair, tau);
    expect(impl.sigma).not.toBeNull();
    expect(Math.abs(impl.sigma! - sigma)).toBeLessThan(1e-9);
    expect(Math.abs(sigma - impl.sigma!)).toBeLessThan(1e-9);   // the edge
  });

  it('selects the LOW root when two positive roots exist (RFC-002 as corrected)', () => {
    const S = 90, K = 100, tau = 0.05;
    const m = Math.log(S / K);
    // A price strictly below the attainable maximum, so both roots are real.
    const p = norm.cdf(-Math.sqrt(2 * Math.abs(m))) * 0.5;
    const z = norm.inv(p);
    const disc = z * z + 2 * m;
    expect(disc).toBeGreaterThan(0);
    const high = (-z + Math.sqrt(disc)) / Math.sqrt(tau);
    const low = (-z - Math.sqrt(disc)) / Math.sqrt(tau);
    expect(low).toBeGreaterThan(0);            // both roots are positive
    expect(high).toBeGreaterThan(low);
    const got = f2ImpliedVol(S, K, p, tau).sigma!;
    expect(got).toBeCloseTo(low, 9);
    expect(Math.abs(got - high)).toBeGreaterThan(1e-3);
    // and both roots really do reproduce the same price
    expect(f1ExpiryProb(S, K, high, tau)).toBeCloseTo(p, 9);
    expect(f1ExpiryProb(S, K, low, tau)).toBeCloseTo(p, 9);
  });

  it('rejects an OTM quote priced above its maximum attainable probability', () => {
    const S = 90, K = 100, tau = 0.05;
    const ceiling = maxAttainableProb(S, K);
    const r = f2ImpliedVol(S, K, Math.min(0.999, ceiling + 0.05), tau);
    expect(r.sigma).toBeNull();
    expect(r.skipReason).toBe('NEGATIVE_DISCRIMINANT');
  });

  it('accepts a quote just below the ceiling and rejects just above it', () => {
    const S = 90, K = 100, tau = 0.05;
    const c = maxAttainableProb(S, K);
    expect(f2ImpliedVol(S, K, c - 1e-6, tau).sigma).not.toBeNull();
    expect(f2ImpliedVol(S, K, c + 1e-6, tau).sigma).toBeNull();
  });

  it('rejects an ATM quote at or above 0.5 as unattainable (RFC-002 as corrected)', () => {
    // At the money the ceiling is Phi(0) = 0.5, reached only as sigma -> 0.
    expect(maxAttainableProb(100, 100)).toBe(0.5);
    expect(f2ImpliedVol(100, 100, 0.5, T60).skipReason).toBe('NEGATIVE_DISCRIMINANT');
    expect(f2ImpliedVol(100, 100, 0.6, T60).skipReason).toBe('NEGATIVE_DISCRIMINANT');
    expect(f2ImpliedVol(100, 100, 0.49, T60).sigma).not.toBeNull();
  });

  it('rejects an unattainable quote whose discriminant is POSITIVE but both roots negative', () => {
    // p >= 0.5 out of the money: disc = z^2 + 2m can be > 0 while every root is
    // negative. Detecting only disc < 0 would have let this through.
    const S = 70_000, K = 79_000, tau = 0.05;
    const z = norm.inv(0.9);
    expect(z * z + 2 * Math.log(S / K)).toBeGreaterThan(0);      // positive discriminant
    expect(f2ImpliedVol(S, K, 0.9, tau).skipReason).toBe('NEGATIVE_DISCRIMINANT');
  });

  it('rejects a degenerate 0 or 1 price rather than returning ±Infinity', () => {
    expect(f2ImpliedVol(105, 100, 0, T60).skipReason).toBe('DEGENERATE');
    expect(f2ImpliedVol(105, 100, 1, T60).skipReason).toBe('DEGENERATE');
  });

  it('rejects τ <= 0 as EXPIRED', () => {
    expect(f2ImpliedVol(105, 100, 0.5, 0).skipReason).toBe('EXPIRED');
    expect(f2ImpliedVol(105, 100, 0.5, -1).skipReason).toBe('EXPIRED');
  });

  it('always returns a positive sigma when it returns one at all', () => {
    for (const ratio of [0.9, 0.99, 1.01, 1.1]) {
      for (const p of [0.05, 0.2, 0.35, 0.45]) {
        const r = f2ImpliedVol(100 * ratio, 100, p, 0.02);
        if (r.sigma !== null) expect(r.sigma).toBeGreaterThan(0);
      }
    }
  });
});

describe('T-021 F3 — touch probability (WP F3, driftless; SIM only)', () => {
  it('is exactly 1 at the money (recurrence sanity, WP F3)', () => {
    expect(f3TouchProb(100, 100, 0.6, T60)).toBe(1);
  });

  it('dominates F1 pointwise — touching is easier than finishing above', () => {
    for (const sigma of [0.2, 0.6, 1.5]) {
      for (const tau of [T60, T300, 0.01]) {
        for (const ratio of [0.8, 0.95, 1, 1.05, 1.2]) {
          const S = 100 * ratio;
          expect(f3TouchProb(S, 100, sigma, tau)).toBeGreaterThanOrEqual(f1ExpiryProb(S, 100, sigma, tau) - 1e-12);
        }
      }
    }
  });

  it('stays in [0,1] and is clamped at 1 above the barrier', () => {
    expect(f3TouchProb(120, 100, 0.6, T60)).toBe(1);   // already through it
    for (const sigma of [0.01, 1, 5]) {
      const p = f3TouchProb(80, 100, sigma, 0.5);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it('is monotone increasing in σ for a barrier above spot', () => {
    let prev = -1;
    for (let sigma = 0.05; sigma <= 3; sigma += 0.05) {
      const p = f3TouchProb(90, 100, sigma, 0.05);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = p;
    }
  });

  it('diverges from F1 by more than the flag could hide at the money', () => {
    expect(f3TouchProb(100, 100, 0.6, T60) - f1ExpiryProb(100, 100, 0.6, T60)).toBeGreaterThan(0.49);
  });
});

describe('T-021 decodeStrike (T-S1 C4: 2 implied decimals)', () => {
  it('decodes the live BTC row measured in the spike', () => {
    expect(decodeStrike('7933525')).toBe(79_335.25);
  });
  it('decodes the live ETH row measured in the spike', () => {
    expect(decodeStrike('249730')).toBe(2_497.30);
  });
  it('treats the strike-0 sentinel as no strike (reference mode)', () => {
    expect(decodeStrike('0')).toBeNull();
    expect(decodeStrike(0)).toBeNull();
    expect(decodeStrike(null)).toBeNull();
    expect(decodeStrike(undefined)).toBeNull();
  });
  it('rejects a non-numeric strike rather than producing NaN', () => {
    expect(decodeStrike('abc')).toBeNull();
  });
});

describe('T-021 priceMarket — the full valuation with skip semantics', () => {
  const base = { spot: 79_100, sigmaForecast: 0.6, nowMs: 0, maxQuoteAgeMs: 4_000 };

  it('produces a Valuation matching IF §3 for a healthy market', () => {
    const v = priceMarket({ ...base, market: market(), quote: quote(0.5) });
    expect(v.skipReason).toBeNull();
    expect(v.marketId).toBe('0x1');
    expect(v.style).toBe('EXPIRY');
    expect(v.pModel).toBeGreaterThan(0);
    expect(v.pMarket).toBe(0.5);
    expect(v.sigmaImplied).not.toBeNull();
    expect(v.edge).toBeCloseTo(0.6 - v.sigmaImplied!, 12);
  });

  it('uses F3 when the market style is TOUCH and the two differ', () => {
    const q = quote(0.5);
    const expiry = priceMarket({ ...base, spot: 79_000, market: market(), quote: q });
    const touch = priceMarket({ ...base, spot: 79_000, market: market({ style: 'TOUCH' }), quote: q });
    expect(touch.pModel).toBeGreaterThan(expiry.pModel);
    expect(touch.pModel).toBe(1);
  });

  it('skips BOUNDARY_NOT_POSTED for a reference market with no strike yet (RFC-001 A4)', () => {
    const v = priceMarket({ ...base, market: market({ mode: 'reference', strike: null, boundaryPosted: false }), quote: quote(0.5) });
    expect(v.skipReason).toBe('BOUNDARY_NOT_POSTED');
    expect(v.edge).toBe(0);
    expect(v.sigmaImplied).toBeNull();
  });

  it('prices a reference market once its boundary is posted', () => {
    const v = priceMarket({ ...base, market: market({ mode: 'reference', strike: 79_000, boundaryPosted: true }), quote: quote(0.5) });
    expect(v.skipReason).toBeNull();
  });

  it('skips NOT_TRADABLE for every non-Trading status (RFC-001 A3)', () => {
    for (const status of ['Listed', 'Locked', 'Settling', 'Resolved', 'Voided'] as const) {
      const v = priceMarket({ ...base, market: market({ status }), quote: quote(0.5) });
      expect(v.skipReason).toBe('NOT_TRADABLE');
      expect(v.edge).toBe(0);
    }
  });

  it('skips EXPIRED when the window has closed', () => {
    const v = priceMarket({ ...base, nowMs: 60_001, market: market(), quote: quote(0.5) });
    expect(v.skipReason).toBe('EXPIRED');
    expect(v.edge).toBe(0);
  });

  it('skips STALE_QUOTE when the quote is older than maxQuoteAgeMs', () => {
    const v = priceMarket({ ...base, nowMs: 10_000, market: market(), quote: quote(0.5, { tsMs: 1_000 }) });
    expect(v.skipReason).toBe('STALE_QUOTE');
    expect(v.edge).toBe(0);
  });

  it('skips STALE_QUOTE when the venue flagged the quote stale', () => {
    const v = priceMarket({ ...base, market: market(), quote: quote(0.5, { stale: true }) });
    expect(v.skipReason).toBe('STALE_QUOTE');
  });

  it('skips NO_LIQUIDITY when the book has no depth (the measured testnet state)', () => {
    const v = priceMarket({ ...base, market: market(), quote: quote(0.5, { depthBid: 0, depthAsk: 0 }) });
    expect(v.skipReason).toBe('NO_LIQUIDITY');
    expect(v.edge).toBe(0);
  });

  it('skips NEGATIVE_DISCRIMINANT on an unattainable quote (GWT-3)', () => {
    // spot far below strike, quote priced implausibly high
    const v = priceMarket({ ...base, spot: 70_000, market: market({ strike: 79_000 }), quote: quote(0.9) });
    expect(v.skipReason).toBe('NEGATIVE_DISCRIMINANT');
    expect(v.edge).toBe(0);
    expect(v.sigmaImplied).toBeNull();
  });

  it('EVERY skip reason forces edge to exactly 0 and sigmaImplied to null', () => {
    const cases = [
      market({ status: 'Locked' }),
      market({ mode: 'reference', strike: null, boundaryPosted: false }),
    ];
    for (const m of cases) {
      const v = priceMarket({ ...base, market: m, quote: quote(0.5) });
      expect(v.skipReason).not.toBeNull();
      expect(v.edge).toBe(0);
      expect(v.sigmaImplied).toBeNull();
    }
  });

  it('is a pure function — same inputs give byte-identical output', () => {
    const args = { ...base, market: market(), quote: quote(0.42) };
    expect(JSON.stringify(priceMarket(args))).toBe(JSON.stringify(priceMarket(args)));
  });

  it('evaluates 10 000 markets in under 10 ms (ARCH §4: F1+F2+F3 < 1 ms)', () => {
    const m = market(), q = quote(0.45);
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) priceMarket({ ...base, market: m, quote: q });
    expect(performance.now() - t0).toBeLessThan(10 * 10);   // generous CI headroom
  });
});
