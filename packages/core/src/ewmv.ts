// Exponentially weighted moving variance on log returns (WP F4, FR-D2).
//
// v_t = λ·v_{t-1} + (1-λ)·r_t²   with   r_t = ln(S_t / S_{t-1})
//
// O(1) per tick, no history buffer — which is the point: the engine re-evaluates
// every market on every tick (ARCH §3) and cannot afford a windowed estimator.
//
// Two honesty rules are enforced in code rather than left to the caller:
//
//   • Before `minObs` returns have been seen, `sigma` reports the SEEDED PRIOR,
//     not the half-formed estimate. An EW variance built from three ticks is
//     nearly zero, which would make `edge = sigmaForecast - sigmaImplied`
//     hugely negative and hand the agent a confident, entirely fictional view.
//     `warm` says which regime it is in so callers can refuse to trade.
//   • A non-positive or NaN price is REJECTED, not absorbed. ln(0) is -Infinity
//     and would poison the recurrence permanently; the ingester already drops
//     bad frames (T-012) but this is the last line of defence.
import type { ModelState, Ms, Vol } from '@arena/shared';

/** Seconds in a 365-day year — must match `YEAR_MS`/`tauYears` in @arena/shared,
 *  or annualized sigma and τ would use different years and the edge would be
 *  scaled wrong (a silent, plausible-looking error). */
export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export interface EwmvOptions {
  symbol: string;
  /** Decay. Must be in (0,1). 0.97 ≈ a 33-tick effective memory. */
  lambda: number;
  /** Returns required before the measured estimate is trusted. */
  minObs: number;
  /** Annualized sigma reported while cold. */
  seedVol: Vol;
  /** Ticks per year, for annualization. Defaults to one tick per second. */
  ticksPerYear?: number;
}

export class Ewmv {
  readonly symbol: string;
  readonly lambda: number;
  readonly minObs: number;
  readonly seedVol: Vol;
  readonly ticksPerYear: number;

  private v = 0;             // running EW variance of log returns, per tick
  private lastPrice: number | null = null;
  private n = 0;             // accepted returns
  private bad = 0;           // rejected observations
  private spot = 0;

  constructor(opts: EwmvOptions) {
    if (!(opts.lambda > 0 && opts.lambda < 1)) {
      throw new RangeError(`Ewmv: lambda must be in (0,1), got ${opts.lambda}`);
    }
    if (!(opts.seedVol >= 0)) throw new RangeError(`Ewmv: seedVol must be >= 0, got ${opts.seedVol}`);
    this.symbol = opts.symbol;
    this.lambda = opts.lambda;
    this.minObs = Math.max(0, Math.floor(opts.minObs));
    this.seedVol = opts.seedVol;
    this.ticksPerYear = opts.ticksPerYear ?? SECONDS_PER_YEAR;
  }

  /** True once enough returns have been seen to trust the measured estimate. */
  get warm(): boolean { return this.n >= this.minObs && this.n > 0; }

  get nObs(): number { return this.n; }
  get rejected(): number { return this.bad; }
  get variance(): number { return this.v; }
  get lastSpot(): number { return this.spot; }

  /** Annualized forecast volatility. The seeded prior while cold — never NaN. */
  get sigma(): Vol {
    if (!this.warm) return this.seedVol;
    const s = Math.sqrt(this.v * this.ticksPerYear);
    return Number.isFinite(s) && s >= 0 ? s : this.seedVol;
  }

  /**
   * Fold one price observation in. The first accepted price only seeds
   * `lastPrice` (there is no return yet). `_tsMs` is accepted for symmetry with
   * the tick stream and to keep the call site self-documenting.
   */
  update(price: number, _tsMs: Ms): void {
    if (!Number.isFinite(price) || price <= 0) { this.bad++; return; }
    this.spot = price;
    const prev = this.lastPrice;
    this.lastPrice = price;
    if (prev === null) return;                 // seeding observation, no return
    const r = Math.log(price / prev);
    if (!Number.isFinite(r)) { this.bad++; return; }
    this.v = this.lambda * this.v + (1 - this.lambda) * r * r;
    this.n++;
  }

  /** Snapshot as the frozen `ModelState` (IF §2). */
  state(tsMs: Ms): ModelState {
    return {
      symbol: this.symbol,
      spot: this.spot,
      sigmaForecast: this.sigma,
      variance: this.v,
      lambda: this.lambda,
      nObs: this.n,
      tsMs,
    };
  }

  reset(): void {
    this.v = 0;
    this.lastPrice = null;
    this.n = 0;
    this.bad = 0;
    this.spot = 0;
  }
}
