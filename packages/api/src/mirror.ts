// MIRROR intent builder (F-A6, FR-U2, GWT-4, IF §12).
//
// ── The security property, stated once ─────────────────────────────────────
// THE SERVER NEVER HOLDS A USER KEY AND NEVER SIGNS FOR A USER.
//
// This component builds an *intent* — a fully specified, unsigned order — and
// the user's own wallet signs it. That is PRD §8's "no user key custody" and
// WP §9's "users always sign their own MIRROR transactions". There is no code
// path here that could sign, because there is nothing here to sign with, and a
// test asserts the built object contains no key and no signature field.
//
// ── Why an intent expires ──────────────────────────────────────────────────
// A MIRROR is "follow the trade MIRA just made". Ten minutes later that is not
// following, it is a different bet: the edge has decayed, the window may have
// closed, and the price has moved. So an intent carries a TTL and a source fill
// age limit, and both are checked when it is built. GWT-4 gives the whole flow
// under two seconds, which is also the only latency this component is allowed.
import {
  newId,
  type Clock, type Fill, type Market, type MirrorIntent, type Ms, type Prob,
  type Quote, type Side, type UnsignedTx, type Usd,
} from '@arena/shared';

export interface MirrorOptions {
  clock: Clock;
  /** Fraction of the user's balance to commit. 0.05 default. */
  balanceFraction?: number;
  /** How long a built intent stays valid. */
  intentTtlMs?: number;
  /** How old a source fill may be and still be worth mirroring. */
  maxSourceAgeMs?: number;
  /** Chain id stamped on the unsigned tx. */
  chainId?: number;
  /** Builds the calldata for a user order. Absent in SIM: `tx` stays null. */
  buildTx?: (args: {
    market: Market; side: Side; sizeContracts: number; limitPrice: Prob; userAddr: string;
  }) => UnsignedTx;
}

export type MirrorResult =
  | { ok: true; intent: MirrorIntent }
  | { ok: false; reason: string };

export interface MirrorStats {
  built: number;
  rejected: number;
  lastBuildMs: number;
}

export class MirrorService {
  private readonly clock: Clock;
  private readonly fraction: number;
  private readonly ttlMs: number;
  private readonly maxSourceAgeMs: number;
  private readonly chainId: number;
  private readonly buildTx: MirrorOptions['buildTx'];
  private stats: MirrorStats = { built: 0, rejected: 0, lastBuildMs: 0 };

  constructor(o: MirrorOptions) {
    this.clock = o.clock;
    this.fraction = o.balanceFraction ?? 0.05;
    this.ttlMs = o.intentTtlMs ?? 60_000;
    this.maxSourceAgeMs = o.maxSourceAgeMs ?? 120_000;
    this.chainId = o.chainId ?? 50_312;
    this.buildTx = o.buildTx;
    if (!(this.fraction > 0 && this.fraction <= 1)) {
      throw new RangeError(`MirrorService: balanceFraction must be in (0,1], got ${this.fraction}`);
    }
  }

  statsSnapshot(): MirrorStats { return { ...this.stats }; }

  /**
   * Build an intent that mirrors `sourceFill` for `userAddr`.
   *
   * Rejections are values, not exceptions: the UI shows the reason on the
   * button (T-055 asserts a disabled state with a reason), so every refusal
   * has to be a sentence a spectator can read.
   */
  build(args: {
    sourceFill: Fill;
    market: Market;
    quote: Quote;
    userAddr: string;
    userBalanceUsd: Usd;
    /** Override the default fraction, e.g. from a UI slider. */
    balanceFraction?: number;
  }): MirrorResult {
    const t0 = Date.now();
    const now = this.clock.now();
    const { sourceFill: f, market: mk, quote: q } = args;

    const reject = (reason: string): MirrorResult => {
      this.stats.rejected++;
      return { ok: false, reason };
    };

    if (!args.userAddr) return reject('Connect a wallet to mirror this trade.');

    // A market that cannot be traded cannot be mirrored.
    if (mk.status !== 'Trading') {
      return reject(`That market is ${mk.status.toLowerCase()} and no longer accepts orders.`);
    }
    if (mk.expiryMs <= now) {
      return reject('That market has expired.');
    }

    // Following a stale trade is not following it.
    const age = now - f.tsMs;
    if (age > this.maxSourceAgeMs) {
      return reject(
        `That fill is ${Math.round(age / 1_000)}s old — too stale to mirror. Wait for the next one.`,
      );
    }

    const fraction = args.balanceFraction ?? this.fraction;
    if (!(fraction > 0 && fraction <= 1)) return reject('Invalid balance fraction.');
    if (!(args.userBalanceUsd > 0)) return reject('Your balance is zero — nothing to commit.');

    // Same side as MIRA, priced at what it would cost the user to cross now.
    const side: Side = f.side;
    const price: Prob = side === 'YES' ? q.ask : 1 - q.bid;
    if (!(price > 0) || !(price < 1)) {
      return reject('No usable price on that market right now.');
    }

    const budget = args.userBalanceUsd * fraction;
    const raw = budget / price;
    // Floor to the venue's grid, never up: an off-grid size is rejected on
    // chain, and rounding a user's size UP spends money they did not offer.
    const grid = mk.minSize > 0 ? mk.minSize : 1;
    const sizeContracts = Math.floor(raw / grid + 1e-9) * grid;

    if (sizeContracts < grid) {
      return reject(
        `$${budget.toFixed(2)} buys less than the ${grid}-contract minimum at ${price.toFixed(3)}.`,
      );
    }

    // Cap at available depth: an intent the book cannot fill is a bad promise.
    const depth = side === 'YES' ? q.depthAsk : q.depthBid;
    const finalSize = depth > 0 ? Math.min(sizeContracts, Math.floor(depth / grid + 1e-9) * grid) : 0;
    if (finalSize < grid) {
      return reject('Not enough depth on that side to fill a mirror right now.');
    }

    // In SIM there is no chain to build calldata for, so `tx` is null — and
    // the test asserts it, so a SIM intent can never masquerade as signable.
    const tx = this.buildTx
      ? this.buildTx({ market: mk, side, sizeContracts: finalSize, limitPrice: price, userAddr: args.userAddr })
      : null;

    const intent: MirrorIntent = {
      intentId: newId('mirror', this.clock),
      sourceFillId: f.fillId,
      marketId: mk.id,
      side,
      sizeContracts: finalSize,
      limitPrice: price,
      userAddr: args.userAddr,
      balanceFraction: fraction,
      tx,
      expiresMs: now + this.ttlMs,
    };

    this.stats.built++;
    this.stats.lastBuildMs = Date.now() - t0;
    return { ok: true, intent };
  }

  /** Has this intent gone stale? The UI must not offer a dead intent. */
  isExpired(intent: MirrorIntent, nowMs: Ms = this.clock.now()): boolean {
    return nowMs >= intent.expiresMs;
  }
}
