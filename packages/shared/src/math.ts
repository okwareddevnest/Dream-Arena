// Numerical foundation for WP F1–F3.
//
// Accuracy matters more than it looks. F2 recovers implied vol by inverting F1,
// so any inconsistency between `cdf` and `inv` shows up as a non-zero edge on a
// market that is fairly priced — a fabricated trading signal. WP §4 calls this
// out explicitly ("asymmetric convexity near the barrier manufactures fake
// edge"), so both directions are held to round-trip accuracy, not eyeball
// accuracy. The textbook 1e-7 rational approximations are NOT good enough.

export const EPS = 1e-12;

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

/**
 * Standard normal CDF — Graeme West's double-precision implementation of Hart's
 * algorithm (~1e-15 absolute). Chosen over Abramowitz–Stegun (1.5e-7) because
 * `inv(cdf(x)) ≈ x` must hold to 1e-6 and A&S cannot deliver that.
 */
function cdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;
  const ax = Math.abs(x);
  let c: number;
  if (ax > 37) {
    c = 0;
  } else {
    const e = Math.exp(-(ax * ax) / 2);
    if (ax < 7.071067811865475) {
      let b = 3.52624965998911e-2 * ax + 0.700383064443688;
      b = b * ax + 6.37396220353165;
      b = b * ax + 33.912866078383;
      b = b * ax + 112.079291497871;
      b = b * ax + 221.213596169931;
      b = b * ax + 220.206867912376;
      let d = 8.83883476483184e-2 * ax + 1.75566716318264;
      d = d * ax + 16.064177579207;
      d = d * ax + 86.7807322029461;
      d = d * ax + 296.564248779674;
      d = d * ax + 637.333633378831;
      d = d * ax + 793.826512519948;
      d = d * ax + 440.413735824752;
      c = (e * b) / d;
    } else {
      // Continued fraction in the far tail, where the rational form loses precision.
      let b = ax + 0.65;
      b = ax + 4 / b;
      b = ax + 3 / b;
      b = ax + 2 / b;
      b = ax + 1 / b;
      c = e / (b * 2.506628274631);
    }
  }
  return x > 0 ? 1 - c : c;
}

/** Standard normal PDF — needed for the Halley refinement in `inv`. */
const pdf = (x: number): number => Math.exp(-(x * x) / 2) / 2.5066282746310002;

// Acklam's rational approximation (relative error < 1.15e-9), then one Halley
// step against `cdf` to reach machine precision. Halley rather than Newton
// because it is cubically convergent and the extra term is one multiply.
const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
           1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
           6.680131188771972e1, -1.328068155288572e1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
           -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const P_LOW = 0.02425;

/**
 * Inverse standard normal CDF (probit).
 *
 * Returns ±Infinity at p = 0 / 1 rather than NaN: F2 hands this the market
 * price, and a price of exactly 0 or 1 is a real (if degenerate) quote that the
 * caller must be able to *detect* and skip. NaN would propagate silently.
 */
function inv(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) {
    throw new RangeError(`norm.inv: p must be in [0,1], got ${p}`);
  }
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  if (p === 0.5) return 0;

  let x: number;
  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
        ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  } else if (p <= 1 - P_LOW) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q /
        (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
         ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  }

  // Halley refinement: e = cdf(x) - p, u = e / pdf(x)
  const e = cdf(x) - p;
  const d = pdf(x);
  if (d > 0) {
    const u = e / d;
    x -= u / (1 + (x * u) / 2);
  }
  return x;
}

export const norm = { cdf, inv, pdf } as const;

/** Years between two epoch-millisecond instants, using a 365-day year to match
 *  the annualization convention in `ewmv` (WP F4). Never negative. */
export const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
export const tauYears = (nowMs: number, expiryMs: number): number =>
  Math.max(0, (expiryMs - nowMs) / YEAR_MS);
