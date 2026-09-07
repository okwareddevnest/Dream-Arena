// The MIRA pricing engine: WP §4 F1, F2, F3 — as reconciled by RFC-002.
//
// ── The convention, stated once and obeyed everywhere ───────────────────────
// Zero rates, so S is a martingale and  ln S_T = ln S₀ − σ²τ/2 + σW_τ.
// Therefore
//        d₂ = ( ln(S/K) − σ²τ/2 ) / (σ√τ)        F1: P(S_T > K) = Φ(d₂)
// The −σ²τ/2 is Itô's correction, not a drift assumption. RFC-002 explains at
// length why it cannot be dropped: without it F1 returns 0.5 at the money for
// EVERY σ, F2 then recovers σ_impl = 0, and `edge = σ_forecast − 0` invents a
// +0.60 signal on a perfectly fair market. F2 below is the exact algebraic
// inverse of F1 above, which is the property the whole strategy rests on.
//
// Everything here is PURE and allocation-light: the engine calls it once per
// market per tick inside a single-digit-millisecond budget (ARCH §4).
import {
  norm, clamp, tauYears, TRADABLE_STATUS,
  type Market, type Ms, type Prob, type Quote, type SkipReason, type Valuation, type Vol,
} from '@arena/shared';

/** F1 — probability of finishing above the boundary (WP F1, amended RFC-002). */
export function f1ExpiryProb(spot: number, strike: number, sigma: Vol, tau: number): Prob {
  if (!(spot > 0) || !(strike > 0)) return Number.NaN;
  const m = Math.log(spot / strike);
  const x = sigma * Math.sqrt(tau);          // total volatility over the window
  // σ√τ → 0 is a real case (τ = 0 at expiry, or a zero-vol scenario): the
  // outcome is then certain, so answer 1/0 rather than dividing by zero.
  if (!(x > 0)) return m > 0 ? 1 : 0;
  const d2 = m / x - x / 2;
  return clamp(norm.cdf(d2), 0, 1);
}

/**
 * The highest probability an out-of-the-money market can attain under F1.
 *
 * For m = ln(S/K) < 0, p(sigma) is NOT monotone: it rises to a maximum and
 * falls back (RFC-002). The maximum is at sigma*sqrt(tau) = sqrt(2|m|), where
 * d2 = -sqrt(2|m|). No volatility can price the market above this, which is
 * what WP F2's "unattainable quote" means and what GWT-3 requires us to skip.
 * In the money there is no ceiling (p -> 1 as sigma -> 0).
 */
export function maxAttainableProb(spot: number, strike: number): Prob {
  const m = Math.log(spot / strike);
  if (m > 0) return 1;
  return norm.cdf(-Math.sqrt(2 * Math.abs(m)));
}

/**
 * The volatility at which an out-of-the-money market's probability peaks —
 * the boundary between F2's two solution branches.
 *
 * Measured across the live cadences (T-S1 C5: windows are 60/300/900 s):
 *   window | 0.1% away | 1% away | 5% away
 *   60 s   |   32.4    |  102.8  |  232.2
 *   300 s  |   14.5    |   46.0  |  103.8
 *   900 s  |    8.4    |   26.5  |   60.0
 *   1 day  |    0.9    |    2.7  |    6.1
 * BTC realized volatility is ~0.4-0.8, so on every window DreamDEX actually
 * runs, the operating regime sits 10-100x BELOW the branch point. Returns
 * Infinity in the money, where no branch point exists.
 */
export function branchPointVol(spot: number, strike: number, tau: number): Vol {
  const m = Math.log(spot / strike);
  if (m >= 0 || !(tau > 0)) return Infinity;
  return Math.sqrt(2 * Math.abs(m)) / Math.sqrt(tau);
}

export interface ImpliedVolResult {
  sigma: Vol | null;
  skipReason: SkipReason | null;
}

/**
 * F2 - closed-form implied volatility (WP F2).
 *
 * Solving Phi(d2) = p for x = sigma*sqrt(tau), with z = Phi^-1(p):
 *        z = m/x - x/2   =>   x^2 + 2zx - 2m = 0   =>   x = -z +/- sqrt(z^2 + 2m)
 *
 * ── Root selection (corrects RFC-002's first answer) ───────────────────────
 * In the money (m > 0) exactly one root is positive and there is no ambiguity.
 * Out of the money (m < 0) BOTH roots are positive, and the branch matters:
 *
 *   x_low  < sqrt(2|m|) < x_high
 *
 * WP F2's written form `sqrt(z^2+2m) - z` is x_high. That is the wrong branch
 * for this product. `branchPointVol` above shows why: on the 60-900 s windows
 * DreamDEX runs, the branch point is 840%-10000% annualized volatility, while
 * BTC realizes 40-80%. Every real quote we will ever invert is on the LOW
 * branch, by a factor of 10-100. Returning x_high there is not a rounding
 * difference - it reported sigma_impl = 1750 for a market whose true implied
 * volatility was 0.61, which would have driven the sign of every edge.
 *
 * So: x_low for m < 0, x_high for m >= 0. Above the branch point the inversion
 * is genuinely ambiguous and we return the low root by documented convention;
 * `branchPointVol` lets a caller see how far from that regime it is.
 *
 * ── Numerical stability ────────────────────────────────────────────────────
 * Both roots are subtractions of nearly-equal quantities in their naive form,
 * so both are computed through the product identity x_low * x_high = -2m,
 * whichever side is the stable one:
 *
 *   z <= 0 :  x_high = -z + sqrt(disc)        (a sum of positives)
 *   z >  0 :  x_high = 2m / (z + sqrt(disc))  (naive form cancels: in the money
 *             at a 60 s window, -1.2067 + 1.20751 keeps ~4 digits and the
 *             round-trip error was 3.9e-5 against a 1e-6 bar)
 *   m <  0 :  x_low  = 2|m| / x_high          (same reason on the low branch:
 *             1.2081 - 1.20726 in the worked case)
 */
export function f2ImpliedVol(spot: number, strike: number, price: Prob, tau: number): ImpliedVolResult {
  if (!(tau > 0)) return { sigma: null, skipReason: 'EXPIRED' };
  if (!(spot > 0) || !(strike > 0)) return { sigma: null, skipReason: 'DEGENERATE' };
  // A price of exactly 0 or 1 carries no information (Phi^-1 is +/-Infinity).
  if (!(price > 0) || !(price < 1)) return { sigma: null, skipReason: 'DEGENERATE' };

  const m = Math.log(spot / strike);

  // Unattainable quote. Covers both shapes of the same phenomenon: a negative
  // discriminant (price between the ceiling and 0.5), and a positive
  // discriminant with both roots negative (price >= 0.5 out of the money).
  // Either way no volatility produces this price, so it is never traded.
  if (price >= maxAttainableProb(spot, strike)) {
    return { sigma: null, skipReason: 'NEGATIVE_DISCRIMINANT' };
  }

  const z = norm.inv(price);
  if (!Number.isFinite(z)) return { sigma: null, skipReason: 'DEGENERATE' };

  const disc = z * z + 2 * m;
  if (disc < 0) return { sigma: null, skipReason: 'NEGATIVE_DISCRIMINANT' };

  const sq = Math.sqrt(disc);
  // The larger root, computed on whichever side does not cancel.
  const xHigh = z <= 0 ? -z + sq : (2 * m) / (z + sq);
  if (!(xHigh > 0) || !Number.isFinite(xHigh)) return { sigma: null, skipReason: 'DEGENERATE' };

  // In the money the larger root is the only positive one; out of the money we
  // take the low branch, recovered from the product identity.
  const x = m >= 0 ? xHigh : (-2 * m) / xHigh;
  if (!(x > 0) || !Number.isFinite(x)) return { sigma: null, skipReason: 'DEGENERATE' };

  const sigma = x / Math.sqrt(tau);
  if (!(sigma > 0) || !Number.isFinite(sigma)) return { sigma: null, skipReason: 'DEGENERATE' };
  return { sigma, skipReason: null };
}

/**
 * F3 — probability of touching the barrier before expiry (WP F3).
 *
 * P = 2Φ( −|ln(K/S)| / (σ√τ) ), the reflection principle for DRIFTLESS Brownian
 * motion on the log price. Note the convention differs from F1/F2 (no −σ²/2);
 * RFC-002 keeps it because (a) DreamDEX is expiry-settled so F3 never prices a
 * live market — it exists for SIM scenarios and to keep the SettlementStyle
 * flag honest, (b) the discrepancy is O(σ²τ) ≈ 4e-4 at demo horizons, and
 * (c) its sanity check (ATM touch → 1, by recurrence) only holds driftless.
 */
export function f3TouchProb(spot: number, strike: number, sigma: Vol, tau: number): Prob {
  if (!(spot > 0) || !(strike > 0)) return Number.NaN;
  const m = Math.log(strike / spot);
  if (m <= 0) return 1;                      // already at or through the barrier
  const x = sigma * Math.sqrt(tau);
  if (!(x > 0)) return 0;                    // no time and no vol: cannot get there
  return clamp(2 * norm.cdf(-m / x), 0, 1);
}

/**
 * Decode a raw `strike` field from a market row.
 *
 * Measured in T-S1: the value carries TWO implied decimals and there is no
 * `strikeDecimals` field to read it from — BTC `7933525` is 79 335.25 against a
 * live spot of 79 183.33. `0` is the sentinel for a `reference`-mode market
 * whose boundary is the window's opening price and is not known yet.
 */
export const STRIKE_SCALE = 100;
export function decodeStrike(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n === 0) return null;
  return n / STRIKE_SCALE;
}

export interface PriceMarketArgs {
  market: Market;
  quote: Quote;
  spot: number;
  sigmaForecast: Vol;
  nowMs: Ms;
  maxQuoteAgeMs: number;
}

/** Build a skipped `Valuation`. Every skip zeroes the edge and nulls the implied
 *  vol — the single invariant that guarantees a skipped quote is never traded. */
function skipped(a: PriceMarketArgs, reason: SkipReason, tau: number, pModel: Prob): Valuation {
  return {
    marketId: a.market.id, style: a.market.style,
    spot: a.spot, strike: a.market.strike ?? Number.NaN, tauYears: tau,
    pModel, pMarket: a.quote.mid,
    sigmaForecast: a.sigmaForecast, sigmaImplied: null,
    edge: 0, skipReason: reason, tsMs: a.nowMs,
  };
}

/**
 * Price one market into a `Valuation` (IF §3).
 *
 * The gate order is deliberate: cheapest and most decisive checks first, so a
 * market we must not touch is rejected before any transcendental function runs.
 */
export function priceMarket(a: PriceMarketArgs): Valuation {
  const { market: mk, quote: q } = a;
  const tau = tauYears(a.nowMs, mk.expiryMs);

  // 1. Only `Trading` accepts orders, and the chain — not the indexer — decides
  //    (RFC-001 A3). Pricing a Locked market produces a number we cannot act on.
  if (mk.status !== TRADABLE_STATUS) return skipped(a, 'NOT_TRADABLE', tau, Number.NaN);

  // 2. Expired: τ ≤ 0 makes every formula degenerate.
  if (!(tau > 0)) return skipped(a, 'EXPIRED', tau, Number.NaN);

  // 3. A `reference` market has no boundary until its opening price posts
  //    (RFC-001 A4). Guessing one manufactures the edge outright.
  if (!mk.boundaryPosted || mk.strike === null || !(mk.strike > 0)) {
    return skipped(a, 'BOUNDARY_NOT_POSTED', tau, Number.NaN);
  }

  // 4. A stale quote is a quote for a market that has moved.
  if (q.stale || a.nowMs - q.tsMs > a.maxQuoteAgeMs) {
    return skipped(a, 'STALE_QUOTE', tau, Number.NaN);
  }

  // 5. No depth means no counterparty — the measured testnet state (T-S4).
  if (!(q.depthBid > 0) || !(q.depthAsk > 0)) {
    return skipped(a, 'NO_LIQUIDITY', tau, Number.NaN);
  }

  const pModel = mk.style === 'TOUCH'
    ? f3TouchProb(a.spot, mk.strike, a.sigmaForecast, tau)
    : f1ExpiryProb(a.spot, mk.strike, a.sigmaForecast, tau);

  if (!Number.isFinite(pModel)) return skipped(a, 'DEGENERATE', tau, Number.NaN);

  // 6. F2. Implied vol is always taken against the EXPIRY form, because that is
  //    what the venue's quote actually prices (T-S1: DreamDEX is expiry-settled).
  //    Using F3's convention here would compare two different conventions —
  //    the exact mistake WP §4 warns about.
  const impl = f2ImpliedVol(a.spot, mk.strike, q.mid, tau);
  if (impl.sigma === null) return skipped(a, impl.skipReason ?? 'DEGENERATE', tau, pModel);

  return {
    marketId: mk.id, style: mk.style,
    spot: a.spot, strike: mk.strike, tauYears: tau,
    pModel, pMarket: q.mid,
    sigmaForecast: a.sigmaForecast, sigmaImplied: impl.sigma,
    edge: a.sigmaForecast - impl.sigma,
    skipReason: null, tsMs: a.nowMs,
  };
}
