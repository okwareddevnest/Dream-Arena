// Position sizing: quarter-Kelly with hard caps (FR-E5, WP §4).
//
// Kelly maximises long-run log wealth, but only if `p` is correct. Ours is a
// model probability derived from an ESTIMATED volatility, so the estimation
// error goes straight into the bet size — WP §11 lists this as a known
// limitation. Two defences, in order:
//
//   1. Take a QUARTER of the Kelly fraction. Full Kelly on a mis-estimated p
//      is ruinous; a quarter gives up a little growth for a lot of survival.
//   2. Then apply HARD caps, each preventing something specific. Kelly is a
//      fraction of bankroll and says nothing about venue depth, inventory
//      limits, or how much of the session one trade may risk.
//
// Everything rounds DOWN. A size that rounds up past a cap has defeated the cap,
// and on this venue an off-grid size is rejected outright (RFC-001 A8).
import type { Market, Prob, RiskConfig, Side, Usd } from '@arena/shared';

/**
 * Binary Kelly fraction: f* = (p − q) / (1 − q), where `q` is the contract
 * price (its implied probability) and `p` the model's probability of the
 * outcome. Zero when there is no edge, negative when the edge points the other
 * way — the caller must not act on a negative fraction.
 */
export function fullKelly(p: Prob, q: Prob): number {
  if (!(q > 0) || !(q < 1)) return 0;     // a 0 or 1 price has no finite payout
  if (!Number.isFinite(p)) return 0;
  const f = (p - q) / (1 - q);
  return Number.isFinite(f) ? f : 0;
}

export interface SizeOrderArgs {
  market: Market;
  risk: RiskConfig;
  /** Model probability of the YES outcome. */
  pModel: Prob;
  /** Price of the side being bought. */
  price: Prob;
  side: Side;
  bankrollUsd: Usd;
  /** Signed net position in this market (+YES / −NO). */
  existingNetContracts: number;
  /** Absolute contracts open across all markets. */
  grossContracts: number;
  /** Contracts available at the price, from the book. */
  availableDepth: number;
}

export interface SizeResult {
  sizeContracts: number;
  kellyFull: number;
  kellyApplied: number;
  /** Which constraint decided the size — surfaced on the console. */
  reason: string;
}

const none = (kellyFull: number, kellyApplied: number, reason: string): SizeResult =>
  ({ sizeContracts: 0, kellyFull, kellyApplied, reason });

export function sizeOrder(a: SizeOrderArgs): SizeResult {
  const { risk: r, market: mk } = a;

  // The probability of the OUTCOME BEING BOUGHT. Buying NO at price q wins when
  // YES does not happen, so its probability is 1 − pModel. Sizing a NO order off
  // pModel would systematically mis-size exactly half of all trades.
  const pOutcome = a.side === 'YES' ? a.pModel : 1 - a.pModel;

  const kellyFull = fullKelly(pOutcome, a.price);
  const kellyApplied = kellyFull * r.kellyFraction;

  if (!(kellyApplied > 0)) {
    return none(kellyFull, kellyApplied,
      `kelly fraction ${kellyFull.toFixed(4)} is not positive — no edge on the ${a.side} side`);
  }
  if (!(a.bankrollUsd > 0)) return none(kellyFull, kellyApplied, 'bankroll is zero or negative');
  if (!(a.price > 0) || !(a.price < 1)) return none(kellyFull, kellyApplied, `price ${a.price} is not a tradable probability`);

  // Kelly's answer, in contracts: stake a fraction of bankroll, each contract
  // costing `price`.
  const kellyContracts = (kellyApplied * a.bankrollUsd) / a.price;

  // ── Caps. Track which one binds so the reason is truthful. ──
  let size = kellyContracts;
  let reason = `quarter-Kelly ${kellyApplied.toFixed(4)} of $${a.bankrollUsd.toFixed(2)}`;

  const bind = (limit: number, label: string): void => {
    if (limit < size) { size = limit; reason = label; }
  };

  // Prevents: one trade betting the whole session.
  bind(r.maxNotionalUsd / a.price, `capped by maxNotionalUsd $${r.maxNotionalUsd}`);

  // Prevents: unbounded concentration in a single market. Headroom is measured
  // toward the cap in the direction we are adding, so an OPPOSING position is
  // extra room rather than exposure.
  const signed = a.side === 'YES' ? a.existingNetContracts : -a.existingNetContracts;
  bind(Math.max(0, r.maxNetContractsPerMarket - signed),
    `capped by the per-market limit ${r.maxNetContractsPerMarket} (net ${a.existingNetContracts})`);

  // Prevents: many small markets adding up to one large bankroll bet.
  bind(Math.max(0, r.maxGrossContracts - a.grossContracts),
    `capped by the gross limit ${r.maxGrossContracts} (gross ${a.grossContracts})`);

  // Prevents: oversizing into a book that cannot fill it (THIN_BOOK, and the
  // measured testnet reality that depth is usually zero).
  bind(Math.max(0, a.availableDepth), `capped by available depth ${a.availableDepth}`);

  // ── Venue granularity: floor to the lot grid, never up. ──
  //
  // The epsilon is not sloppiness, it is necessary. Kelly arrives through a
  // chain of float operations: (0.6-0.5)/0.5 * 0.25 * 1000 / 0.5 evaluates to
  // 99.99999999999997, and a bare floor turns that into 99 — shaving a contract
  // off orders that should have been round numbers, systematically. A 1e-9
  // tolerance rescues float dust while being far too small to cross a real cap
  // (every cap above is an exact quantity, so floor(cap + 1e-9) === cap). The
  // venue's own SDK quantizer does exactly this, for exactly this reason.
  const LOT_EPS = 1e-9;
  const grid = mk.minSize > 0 ? mk.minSize : 1;
  const lots = Math.floor(size / grid + LOT_EPS);
  const final = lots * grid;

  if (final < grid || !(final > 0)) {
    return none(kellyFull, kellyApplied,
      `${size.toFixed(2)} contracts is below minSize ${grid} after clamps — cannot place`);
  }

  return { sizeContracts: final, kellyFull, kellyApplied, reason };
}
