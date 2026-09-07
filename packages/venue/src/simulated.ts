// SimulatedVenue — a real CLOB on a virtual clock (FR-V2, F-A3).
//
// This is the venue the demo actually runs on, so it is not a stub. T-S4
// measured ZERO trades on every live testnet market, which means the simulated
// venue is the primary surface and LIVE is the proof rather than the show. It
// therefore has to model the same physics the agent will meet on chain:
//
//   • a genuine order book with resting orders, crossing, partial fills and
//     depth consumption — not a quote generator. An agent tested against
//     synthesised quotes learns nothing about queue position or slippage.
//   • the same six-status lifecycle as the chain (RFC-001 A3), walked on the
//     virtual clock: Listed -> Trading -> Locked -> Settling -> Resolved.
//   • claim-not-receive settlement (RFC-001 A5). If SIM auto-credited winnings
//     and LIVE did not, the claim loop would be untested until the demo.
//   • integer price/size units throughout (RFC-001 A8), so an off-grid price is
//     rejected here exactly as the pool rejects it there.
//
// ── The unified YES book ────────────────────────────────────────────────────
// A binary market has two outcome tokens, but one price: P(NO) = 1 - P(YES).
// All four order kinds are therefore mapped onto a single YES book, which is
// what makes crossing correct rather than approximate:
//       BUY_YES  (p)  -> bid @ p            SELL_NO (q) -> bid @ 1-q
//       SELL_YES (p)  -> ask @ p            BUY_NO  (q) -> ask @ 1-q
//
// ── Encoding a sell ─────────────────────────────────────────────────────────
// The frozen `Fill` carries a side but no direction, so a SELL of outcome X at
// price p is journaled as a BUY of its complement at 1-p. These are the same
// economic position, and it makes the Store's netting arithmetic exact: selling
// 10 YES at 0.55 against a 0.40 basis records a NO buy at 0.45, which closes
// the long at a YES price of 0.55 and realizes +1.50. Correct, with no change
// to the contract.
import {
  TRADABLE_STATUS, newId,
  type AgentId, type CancelAck, type Claimable, type ClaimResult, type Fill,
  type Market, type MarketStatus, type Ms, type Order, type OrderAck, type OrderKind,
  type Position, type Prob, type Quote, type Side, type Usd, type Venue, type VenueHealth,
  type SettlementStyle, type VirtualClock,
} from '@arena/shared';

/** Deterministic PRNG (mulberry32). A seeded venue must replay identically —
 *  40-TESTPLAN §6 rule 3 — and `Math.random` cannot promise that. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimMarketSpec {
  id: string;
  asset: string;
  /** Boundary price. `null` with mode 'reference' means it is not posted yet. */
  strike: number | null;
  mode?: 'fixed' | 'reference';
  intervalSec?: number;
  tradingStartMs?: Ms;
  expiryMs?: Ms;
  style?: SettlementStyle;
  /** Fair YES probability the synthetic book quotes around. */
  fairProb?: number;
}

export interface SimulatedVenueOptions {
  clock: VirtualClock;
  agent: AgentId;
  /** Markets to publish. Defaults cover every conformance branch. */
  markets?: SimMarketSpec[];
  seed?: number;
  /** Half-spread in probability units. */
  spread?: number;
  /** Contracts of synthetic liquidity at each book level. */
  depth?: number;
  /** Levels of synthetic liquidity each side. */
  levels?: number;
  /** Virtual ms before an accepted order is matched. 0 matches inline. */
  latencyMs?: number;
  /** Starting collateral. */
  balanceUsd?: Usd;
  /** Price tick, in raw units. */
  tickRaw?: bigint;
  lotRaw?: bigint;
  priceDecimals?: number;
  minSize?: number;
  feeBps?: number;
  /** How long after expiry a market stays Locked, then Settling. */
  lockMs?: number;
  settlingMs?: number;
}

interface RestingOrder {
  clientOrderId: string;
  marketId: string;
  agent: AgentId;
  kind: OrderKind;
  /** Book side this order sits on, in YES terms. */
  bookSide: 'bid' | 'ask';
  priceRaw: bigint;
  remaining: number;
  expiresMs: Ms;
  postOnly: boolean;
  tsMs: Ms;
}

interface Holding { yes: number; no: number; basis: Prob; net: number; realized: Usd }

interface MarketState {
  spec: Required<Omit<SimMarketSpec, 'strike' | 'mode'>> & { strike: number | null; mode: 'fixed' | 'reference' };
  /** Resolved outcome, set when the market reaches Resolved. */
  outcome: 0 | 1 | null;
  /** Spot at expiry, for settlement. */
  settleSpot: number | null;
  fairProb: number;
}

const DEFAULT_MARKETS: SimMarketSpec[] = [
  { id: 'sim-btc-60', asset: 'BTC', strike: 79_000, intervalSec: 60, fairProb: 0.5 },
  { id: 'sim-eth-300', asset: 'ETH', strike: 2_500, intervalSec: 300, fairProb: 0.45 },
  // A reference market with no boundary posted yet: the engine must skip it
  // (RFC-001 A4) rather than invent a strike.
  { id: 'sim-btc-ref', asset: 'BTC', strike: null, mode: 'reference', intervalSec: 300, fairProb: 0.5 },
  // A market whose trading window has not opened: exercises the status gate.
  { id: 'sim-btc-later', asset: 'BTC', strike: 80_000, intervalSec: 900,
    tradingStartMs: 3_600_000, expiryMs: 4_500_000, fairProb: 0.5 },
];

export class SimulatedVenue implements Venue {
  readonly name = 'SimulatedVenue' as const;
  readonly mode = 'SIM' as const;
  readonly agent: AgentId;

  private readonly clock: VirtualClock;
  /** Positional noise. NOT a stream: see `noiseFor`. */
  private readonly seed: number;
  private readonly opts: Required<Omit<SimulatedVenueOptions, 'clock' | 'agent' | 'markets'>>;
  private readonly mkts = new Map<string, MarketState>();
  private readonly books = new Map<string, RestingOrder[]>();
  private readonly holdings = new Map<string, Holding>();
  private readonly seenOrders = new Map<string, OrderAck>();
  private readonly claimed = new Set<string>();
  private fillCbs: ((f: Fill) => void)[] = [];
  private cash: Usd;
  private spot = new Map<string, number>();
  private connected = false;
  /** Scenario hooks (T-032 drives these). */
  private quoteFrozenUntil = 0;
  private quoteFrozenAtMs = 0;
  private depthOverride: number | null = null;

  constructor(o: SimulatedVenueOptions) {
    this.clock = o.clock;
    this.agent = o.agent;
    this.opts = {
      seed: o.seed ?? 42,
      spread: o.spread ?? 0.02,
      depth: o.depth ?? 50,
      levels: o.levels ?? 3,
      latencyMs: o.latencyMs ?? 0,
      balanceUsd: o.balanceUsd ?? 1_000,
      tickRaw: o.tickRaw ?? 1_000n,
      lotRaw: o.lotRaw ?? 1n,
      priceDecimals: o.priceDecimals ?? 6,
      minSize: o.minSize ?? 1,
      feeBps: o.feeBps ?? 0,
      lockMs: o.lockMs ?? 5_000,
      settlingMs: o.settlingMs ?? 5_000,
    };
    this.cash = this.opts.balanceUsd;
    this.seed = this.opts.seed;

    for (const s of o.markets ?? DEFAULT_MARKETS) {
      const interval = s.intervalSec ?? 60;
      const start = s.tradingStartMs ?? 0;
      this.mkts.set(s.id, {
        spec: {
          id: s.id, asset: s.asset, strike: s.strike, mode: s.mode ?? 'fixed',
          intervalSec: interval, tradingStartMs: start,
          expiryMs: s.expiryMs ?? start + interval * 1_000,
          style: s.style ?? 'EXPIRY', fairProb: s.fairProb ?? 0.5,
        },
        outcome: null, settleSpot: null, fairProb: s.fairProb ?? 0.5,
      });
      this.spot.set(s.asset, s.strike ?? 79_000);
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }
  now(): Ms { return this.clock.now(); }

  async health(): Promise<VenueHealth> {
    return {
      ok: this.connected, mode: this.mode, name: this.name,
      blockNumber: Math.floor(this.clock.now() / 1_000),
      latencyMs: this.opts.latencyMs, lastErrorMs: null,
      detail: this.connected ? null : 'disconnected',
    };
  }

  // ── Scenario hooks (T-032) ───────────────────────────────────────────────
  setSpot(asset: string, price: number): void { this.spot.set(asset, price); }
  setFairProb(marketId: string, p: Prob): void {
    const m = this.mkts.get(marketId);
    if (m) m.fairProb = Math.min(1 - 1e-6, Math.max(1e-6, p));
  }
  /** Post the boundary for a reference market (what the chain does at window open). */
  postBoundary(marketId: string, strike: number): void {
    const m = this.mkts.get(marketId);
    if (m) m.spec.strike = strike;
  }
  /** Stop quote timestamps advancing, so their AGE grows and the pricer sees
   *  STALE_QUOTE from the age rather than from a flag it could choose to ignore. */
  freezeQuotes(untilMs: Ms): void {
    this.quoteFrozenUntil = untilMs;
    this.quoteFrozenAtMs = this.clock.now();
  }
  setDepth(n: number | null): void { this.depthOverride = n; }
  setSpread(_n: number): void { (this.opts as { spread: number }).spread = _n; }

  // ── Markets ──────────────────────────────────────────────────────────────
  private statusOf(m: MarketState, nowMs: Ms): MarketStatus {
    const { tradingStartMs, expiryMs } = m.spec;
    if (nowMs < tradingStartMs) return 'Listed';
    if (nowMs < expiryMs) return 'Trading';
    if (nowMs < expiryMs + this.opts.lockMs) return 'Locked';
    if (nowMs < expiryMs + this.opts.lockMs + this.opts.settlingMs) return 'Settling';
    return 'Resolved';
  }

  private toMarket(m: MarketState, nowMs: Ms): Market {
    const posted = m.spec.mode === 'fixed' ? m.spec.strike !== null : m.spec.strike !== null;
    return {
      id: m.spec.id,
      symbol: `${m.spec.asset}-${m.spec.strike ?? 'REF'}-${m.spec.intervalSec}s`,
      yesSymbol: `${m.spec.id}#YES`,
      noSymbol: `${m.spec.id}#NO`,
      asset: m.spec.asset,
      strike: m.spec.strike,
      mode: m.spec.mode,
      boundaryPosted: posted,
      intervalSec: m.spec.intervalSec,
      tradingStartMs: m.spec.tradingStartMs,
      expiryMs: m.spec.expiryMs,
      style: m.spec.style,
      tickRaw: this.opts.tickRaw,
      lotRaw: this.opts.lotRaw,
      priceDecimals: this.opts.priceDecimals,
      minSize: this.opts.minSize,
      feeBps: this.opts.feeBps,
      // A pool address exists but is never the identity: pools recycle across
      // windows, so keying state by it is the bug gotcha 10 warns about.
      poolAddress: `0xpool${m.spec.id}`,
      nonce: 1,
      venue: 'SIM',
      status: this.statusOf(m, nowMs),
    };
  }

  async getMarkets(): Promise<Market[]> {
    const now = this.clock.now();
    this.settleDue(now);
    return [...this.mkts.values()].map((m) => this.toMarket(m, now));
  }

  async settledMarkets(limit = 40): Promise<Market[]> {
    const now = this.clock.now();
    this.settleDue(now);
    return [...this.mkts.values()]
      .filter((m) => this.statusOf(m, now) === 'Resolved')
      .sort((a, b) => b.spec.expiryMs - a.spec.expiryMs)
      .slice(0, limit)
      .map((m) => this.toMarket(m, now));
  }

  // ── Quotes ───────────────────────────────────────────────────────────────
  private scale(): number { return 10 ** this.opts.priceDecimals; }
  private toRaw(p: Prob): bigint { return BigInt(Math.round(p * this.scale())); }
  private fromRaw(r: bigint): Prob { return Number(r) / this.scale(); }
  private onGrid(r: bigint): boolean { return r % this.opts.tickRaw === 0n; }
  private snap(p: Prob): bigint {
    const raw = this.toRaw(p);
    return (raw / this.opts.tickRaw) * this.opts.tickRaw;
  }

  /**
   * Deterministic noise for one book position.
   *
   * Deliberately NOT drawn from a PRNG stream. A stream would advance on every
   * `getQuote`, so merely LOOKING at the book would move it — two reads at the
   * same instant would disagree, and a fill price would depend on how many
   * times anything had glanced at the quote. Hashing (seed, market, side,
   * level) instead makes the book a pure function of its state: stable across
   * repeated reads, identical across runs with the same seed, and different
   * across seeds.
   */
  private noiseFor(marketId: string, side: 'bid' | 'ask', level: number): number {
    // FNV-1a over (seed, market, side, level). The seed goes INTO the hashed
    // string rather than being pre-multiplied in: pre-mixing left small seeds
    // (1, 2, 3) landing on the same quote, because a single multiply does not
    // avalanche low bits.
    let h = 2166136261 >>> 0;
    const s = `${this.seed}|${marketId}|${side}|${level}`;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    // murmur3 fmix32 finalizer: every input bit now affects every output bit.
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /**
   * Synthetic liquidity around the fair price, plus whatever is actually
   * resting. The synthetic side is what keeps the book non-empty — the point of
   * ECHO (WP §5) at the venue level, so the agent is never tested against a
   * vacuum that the real testnet also shows.
   */
  private levelsFor(marketId: string, side: 'bid' | 'ask', nowMs: Ms): { priceRaw: bigint; size: number }[] {
    const m = this.mkts.get(marketId);
    if (!m) return [];
    const depth = this.depthOverride ?? this.opts.depth;
    const out: { priceRaw: bigint; size: number }[] = [];
    if (depth > 0) {
      for (let i = 0; i < this.opts.levels; i++) {
        const off = this.opts.spread / 2 + i * this.opts.spread;
        const noise = (this.noiseFor(marketId, side, i) - 0.5) * this.opts.spread * 0.1;
        const p = side === 'bid' ? m.fairProb - off + noise : m.fairProb + off + noise;
        if (p <= 0 || p >= 1) continue;
        const raw = this.snap(p);
        if (raw <= 0n || raw >= this.toRaw(1)) continue;
        out.push({ priceRaw: raw, size: Math.max(1, Math.round(depth / (i + 1))) });
      }
    }
    for (const r of this.books.get(marketId) ?? []) {
      if (r.bookSide !== side || r.remaining <= 0 || r.expiresMs <= nowMs) continue;
      out.push({ priceRaw: r.priceRaw, size: r.remaining });
    }
    // Bids descend, asks ascend.
    out.sort((a, b) => (side === 'bid' ? Number(b.priceRaw - a.priceRaw) : Number(a.priceRaw - b.priceRaw)));
    return out;
  }

  async getQuote(marketId: string): Promise<Quote> {
    const m = this.mkts.get(marketId);
    if (!m) throw new Error(`SimulatedVenue: unknown market ${marketId}`);
    const now = this.clock.now();
    const bids = this.levelsFor(marketId, 'bid', now);
    const asks = this.levelsFor(marketId, 'ask', now);
    const bid = bids[0] ? this.fromRaw(bids[0].priceRaw) : 0;
    const ask = asks[0] ? this.fromRaw(asks[0].priceRaw) : 1;
    const mid = bids[0] && asks[0] ? (bid + ask) / 2 : m.fairProb;
    return {
      marketId,
      bid, ask,
      mid: Math.min(Math.max(mid, bid), ask),
      depthBid: bids[0]?.size ?? 0,
      depthAsk: asks[0]?.size ?? 0,
      // A frozen quote keeps its old timestamp, which is how STALE_QUOTE is
      // injected: the pricer sees the age, not a flag it could ignore.
      stale: now < this.quoteFrozenUntil,
      tsMs: now < this.quoteFrozenUntil ? this.quoteFrozenAtMs : now,
    };
  }

  // ── Orders ───────────────────────────────────────────────────────────────
  private holding(marketId: string): Holding {
    let h = this.holdings.get(marketId);
    if (!h) { h = { yes: 0, no: 0, basis: 0, net: 0, realized: 0 }; this.holdings.set(marketId, h); }
    return h;
  }

  private reject(o: Order, reason: string): OrderAck {
    const ack: OrderAck = {
      clientOrderId: o.clientOrderId, venueOrderId: null,
      status: 'REJECTED', txHash: null, reason, tsMs: this.clock.now(),
    };
    this.seenOrders.set(o.clientOrderId, ack);
    return ack;
  }

  /** Book side, in YES terms, for each of the four kinds. */
  private bookSideOf(kind: OrderKind): 'bid' | 'ask' {
    return kind === 'BUY_YES' || kind === 'SELL_NO' ? 'bid' : 'ask';
  }

  /** The YES-equivalent limit price for an order priced in its own outcome. */
  private yesPriceRaw(kind: OrderKind, priceRaw: bigint): bigint {
    return kind === 'BUY_NO' || kind === 'SELL_NO' ? this.toRaw(1) - priceRaw : priceRaw;
  }

  async placeOrder(o: Order): Promise<OrderAck> {
    const now = this.clock.now();

    // Idempotency: the tx queue dedupes too (T-033), but the venue is the last
    // line of defence and the conformance suite asserts it here.
    const prior = this.seenOrders.get(o.clientOrderId);
    if (prior) return prior;

    const m = this.mkts.get(o.marketId);
    if (!m) return this.reject(o, `unknown market ${o.marketId}`);

    const status = this.statusOf(m, now);
    if (status !== TRADABLE_STATUS) {
      return this.reject(o, `market status is ${status}, only ${TRADABLE_STATUS} accepts orders`);
    }

    // RFC-001 A2: expiry is mandatory and capped at the market's own expiry.
    if (!(o.expiresMs > now)) {
      return this.reject(o, `order expiry ${o.expiresMs} is not in the future (now ${now})`);
    }
    const expiresMs = Math.min(o.expiresMs, m.spec.expiryMs);

    // Size must be positive and on the lot grid.
    if (!(o.sizeContracts >= this.opts.minSize)) {
      return this.reject(o, `size ${o.sizeContracts} is below the market minimum size ${this.opts.minSize}`);
    }

    const isMarket = o.type === 'MARKET' || o.limitPriceRaw === null;
    let yesLimitRaw: bigint;
    if (isMarket) {
      // A market order accepts any price on its side of the book.
      yesLimitRaw = this.bookSideOf(o.kind) === 'bid' ? this.toRaw(1) : 0n;
    } else {
      const priceRaw = o.limitPriceRaw!;
      // RFC-001 A8: an off-grid price is rejected here exactly as the pool
      // rejects it on chain. This is the gotcha that makes float prices unusable.
      if (!this.onGrid(priceRaw)) {
        return this.reject(o, `price ${priceRaw} is not a multiple of the tick grid ${this.opts.tickRaw}`);
      }
      if (priceRaw <= 0n || priceRaw >= this.toRaw(1)) {
        return this.reject(o, `price ${priceRaw} is outside the tradable range`);
      }
      yesLimitRaw = this.yesPriceRaw(o.kind, priceRaw);
    }

    // RFC-001 A6: selling an outcome requires holding it. Escrow is inventory.
    const h = this.holding(o.marketId);
    if (o.kind === 'SELL_YES' && h.yes < o.sizeContracts) {
      return this.reject(o, `cannot SELL_YES ${o.sizeContracts}: inventory holds only ${h.yes} YES — mintPair first`);
    }
    if (o.kind === 'SELL_NO' && h.no < o.sizeContracts) {
      return this.reject(o, `cannot SELL_NO ${o.sizeContracts}: inventory holds only ${h.no} NO — mintPair first`);
    }

    const ack: OrderAck = {
      clientOrderId: o.clientOrderId,
      venueOrderId: newId('vo', this.clock),
      status: this.opts.latencyMs > 0 ? 'QUEUED' : 'ACCEPTED',
      txHash: null, reason: null, tsMs: now,
    };
    this.seenOrders.set(o.clientOrderId, ack);

    const exec = (): void => this.match(o, yesLimitRaw, expiresMs, isMarket);
    if (this.opts.latencyMs > 0) this.clock.setTimeout(exec, this.opts.latencyMs);
    else exec();

    return ack;
  }

  /**
   * Match an incoming order against the book, then rest the remainder.
   *
   * Walks price levels in order and consumes depth, so a size larger than the
   * top level pays worse prices for the rest — the slippage an agent must be
   * tested against, and the reason THIN_BOOK is a scenario rather than a flag.
   */
  private match(o: Order, yesLimitRaw: bigint, expiresMs: Ms, isMarket: boolean): void {
    const now = this.clock.now();
    const side = this.bookSideOf(o.kind);
    const opposite: 'bid' | 'ask' = side === 'bid' ? 'ask' : 'bid';
    let remaining = o.sizeContracts;

    const levels = this.levelsFor(o.marketId, opposite, now);
    for (const lvl of levels) {
      if (remaining <= 0) break;
      const crosses = side === 'bid' ? lvl.priceRaw <= yesLimitRaw : lvl.priceRaw >= yesLimitRaw;
      if (!crosses) break;
      const take = Math.min(remaining, lvl.size);
      if (take <= 0) continue;
      this.consume(o.marketId, opposite, lvl.priceRaw, take, now);
      this.emitFill(o, lvl.priceRaw, take, now);
      remaining -= take;
    }

    // Remainder rests, with escrow locked — the decision gotcha 4 names. A
    // POST_ONLY order that would have crossed is dropped instead.
    if (remaining > 0 && !isMarket && o.type !== 'FILL_OR_KILL') {
      const rest = this.books.get(o.marketId) ?? [];
      rest.push({
        clientOrderId: o.clientOrderId, marketId: o.marketId, agent: o.agent,
        kind: o.kind, bookSide: side, priceRaw: yesLimitRaw,
        remaining, expiresMs, postOnly: o.type === 'POST_ONLY', tsMs: now,
      });
      this.books.set(o.marketId, rest);
    }
  }

  /** Reduce a resting order at this level, if the level was a real one. */
  private consume(marketId: string, side: 'bid' | 'ask', priceRaw: bigint, size: number, nowMs: Ms): void {
    const rest = this.books.get(marketId);
    if (!rest) return;
    let left = size;
    for (const r of rest) {
      if (left <= 0) break;
      if (r.bookSide !== side || r.priceRaw !== priceRaw || r.remaining <= 0 || r.expiresMs <= nowMs) continue;
      const take = Math.min(left, r.remaining);
      r.remaining -= take;
      left -= take;
    }
    this.books.set(marketId, rest.filter((r) => r.remaining > 0));
  }

  /**
   * Record a trade. `yesPriceRaw` is the price on the unified YES book; the
   * fill is expressed in the trader's own outcome, with a SELL encoded as a BUY
   * of the complement (see the header note).
   */
  private emitFill(o: Order, yesPriceRaw: bigint, size: number, nowMs: Ms): void {
    const yesPrice = this.fromRaw(yesPriceRaw);
    const h = this.holding(o.marketId);

    // Cash and token effects, per kind.
    let side: Side;
    let price: Prob;
    switch (o.kind) {
      case 'BUY_YES':
        this.cash -= size * yesPrice; h.yes += size; side = 'YES'; price = yesPrice; break;
      case 'BUY_NO':
        this.cash -= size * (1 - yesPrice); h.no += size; side = 'NO'; price = 1 - yesPrice; break;
      case 'SELL_YES':
        this.cash += size * yesPrice; h.yes -= size;
        // Encoded as buying the complement, so netting realizes correctly.
        side = 'NO'; price = 1 - yesPrice; break;
      case 'SELL_NO':
        this.cash += size * (1 - yesPrice); h.no -= size;
        side = 'YES'; price = yesPrice; break;
    }

    const fee = (size * price * this.opts.feeBps) / 10_000;
    this.cash -= fee;

    // Track a basis so `positions()` can report PnL without the Store.
    const signed = side === 'YES' ? size : -size;
    const basisPrice = side === 'YES' ? price : 1 - price;
    if (h.net === 0 || Math.sign(signed) === Math.sign(h.net)) {
      const total = h.net + signed;
      h.basis = total === 0 ? 0 : (h.basis * h.net + basisPrice * signed) / total;
      h.net = total;
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(h.net));
      h.realized += Math.sign(h.net) * (basisPrice - h.basis) * closing;
      const remainder = Math.abs(signed) - closing;
      h.net += signed;
      if (remainder > 0) h.basis = basisPrice;
      else if (h.net === 0) h.basis = 0;
    }
    h.realized -= fee;

    const f: Fill = {
      fillId: newId('fill', this.clock),
      clientOrderId: o.clientOrderId,
      venueOrderId: this.seenOrders.get(o.clientOrderId)?.venueOrderId ?? null,
      marketId: o.marketId,
      agent: o.agent,
      side, sizeContracts: size, price, feeUsd: fee,
      // A SIM fill must NOT fabricate a tx hash or an explorer link. The badge
      // is not the only place the demo has to be honest about which venue it is.
      txHash: null, explorerUrl: null,
      tsMs: nowMs,
    };
    for (const cb of [...this.fillCbs]) { try { cb(f); } catch { /* a subscriber must not break matching */ } }
  }

  async cancel(clientOrderId: string): Promise<CancelAck> {
    const now = this.clock.now();
    for (const [id, rest] of this.books) {
      const i = rest.findIndex((r) => r.clientOrderId === clientOrderId);
      if (i >= 0) {
        rest.splice(i, 1);
        this.books.set(id, rest);
        return { clientOrderId, status: 'CANCELLED', txHash: null, tsMs: now };
      }
    }
    const known = this.seenOrders.get(clientOrderId);
    return {
      clientOrderId,
      status: known && known.status !== 'REJECTED' ? 'ALREADY_FILLED' : 'NOT_FOUND',
      txHash: null, tsMs: now,
    };
  }

  async cancelAll(agent?: AgentId): Promise<CancelAck[]> {
    const now = this.clock.now();
    const out: CancelAck[] = [];
    for (const [id, rest] of this.books) {
      const keep: RestingOrder[] = [];
      for (const r of rest) {
        if (agent === undefined || r.agent === agent) {
          out.push({ clientOrderId: r.clientOrderId, status: 'CANCELLED', txHash: null, tsMs: now });
        } else keep.push(r);
      }
      this.books.set(id, keep);
    }
    return out;
  }

  onFill(cb: (f: Fill) => void): () => void {
    this.fillCbs.push(cb);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const i = this.fillCbs.indexOf(cb);
      if (i >= 0) this.fillCbs.splice(i, 1);
    };
  }

  // ── Positions and balance ────────────────────────────────────────────────
  async positions(agent?: AgentId): Promise<Position[]> {
    if (agent !== undefined && agent !== this.agent) return [];
    const now = this.clock.now();
    const out: Position[] = [];
    for (const [marketId, h] of this.holdings) {
      if (h.net === 0 && h.realized === 0 && h.yes === 0 && h.no === 0) continue;
      const q = await this.getQuote(marketId).catch(() => null);
      const mark = q?.mid ?? h.basis;
      out.push({
        marketId, agent: this.agent,
        netContracts: h.net, avgPrice: h.basis, markPrice: mark,
        realizedPnlUsd: h.realized,
        unrealizedPnlUsd: h.net === 0 ? 0 : (mark - h.basis) * h.net,
        tsMs: now,
      });
    }
    return out;
  }

  async balanceUsd(agent?: AgentId): Promise<Usd> {
    if (agent !== undefined && agent !== this.agent) return 0;
    return Math.max(0, this.cash);
  }

  // ── Settlement, claim and mint (RFC-001 A5/A6) ───────────────────────────
  /** Resolve any market whose Resolved window has arrived. */
  private settleDue(nowMs: Ms): void {
    for (const m of this.mkts.values()) {
      if (m.outcome !== null) continue;
      if (this.statusOf(m, nowMs) !== 'Resolved') continue;
      const spot = this.spot.get(m.spec.asset) ?? 0;
      m.settleSpot = spot;
      // Expiry settlement: did it finish at or above the boundary?
      m.outcome = m.spec.strike !== null && spot >= m.spec.strike ? 1 : 0;
    }
  }

  async claimable(): Promise<Claimable[]> {
    const now = this.clock.now();
    this.settleDue(now);
    const out: Claimable[] = [];
    for (const [marketId, h] of this.holdings) {
      const m = this.mkts.get(marketId);
      if (!m || m.outcome === null || this.claimed.has(marketId)) continue;
      const size = m.outcome === 1 ? h.yes : h.no;
      if (size <= 0) continue;                    // a losing outcome is never claimable
      out.push({
        marketId,
        symbol: this.toMarket(m, now).symbol,
        expiryMs: m.spec.expiryMs,
        outcomeIdx: m.outcome === 1 ? 0 : 1,      // outcome 0 = YES, 1 = NO
        sizeContracts: size,
        estPayoutUsd: size,                        // a winning contract pays 1
      });
    }
    return out;
  }

  async claim(marketId: string): Promise<ClaimResult> {
    const now = this.clock.now();
    this.settleDue(now);
    const base = { marketId, txHash: null, tsMs: now };
    const m = this.mkts.get(marketId);
    if (!m) return { ...base, claimed: false, amountUsd: 0, reason: `unknown market ${marketId}` };
    if (m.outcome === null) {
      return { ...base, claimed: false, amountUsd: 0,
        reason: `market is ${this.statusOf(m, now)}, not Resolved — nothing to claim yet` };
    }
    if (this.claimed.has(marketId)) {
      return { ...base, claimed: false, amountUsd: 0, reason: 'already claimed' };
    }
    const h = this.holding(marketId);
    const size = m.outcome === 1 ? h.yes : h.no;
    if (size <= 0) {
      return { ...base, claimed: false, amountUsd: 0, reason: 'no winning outcome tokens held' };
    }
    // Winnings are CLAIMED, not received: only now does collateral return.
    this.claimed.add(marketId);
    this.cash += size;
    h.realized += size - (m.outcome === 1 ? h.basis * size : (1 - h.basis) * size);
    h.yes = 0; h.no = 0; h.net = 0; h.basis = 0;
    return { ...base, claimed: true, amountUsd: size, reason: null };
  }

  /** Mint a YES/NO pair against collateral, so a SELL has inventory to give. */
  async mintPair(marketId: string, sizeContracts: number): Promise<OrderAck> {
    const now = this.clock.now();
    const id = newId('mint', this.clock);
    const m = this.mkts.get(marketId);
    if (!m) {
      return { clientOrderId: id, venueOrderId: null, status: 'REJECTED', txHash: null,
        reason: `unknown market ${marketId}`, tsMs: now };
    }
    if (this.statusOf(m, now) !== TRADABLE_STATUS) {
      return { clientOrderId: id, venueOrderId: null, status: 'REJECTED', txHash: null,
        reason: `market status is ${this.statusOf(m, now)}, cannot mint`, tsMs: now };
    }
    if (!(sizeContracts > 0)) {
      return { clientOrderId: id, venueOrderId: null, status: 'REJECTED', txHash: null,
        reason: `size ${sizeContracts} must be positive`, tsMs: now };
    }
    if (this.cash < sizeContracts) {
      return { clientOrderId: id, venueOrderId: null, status: 'REJECTED', txHash: null,
        reason: `insufficient collateral: need ${sizeContracts}, hold ${this.cash.toFixed(2)}`, tsMs: now };
    }
    // A pair costs 1 collateral and is always worth 1 at settlement.
    this.cash -= sizeContracts;
    const h = this.holding(marketId);
    h.yes += sizeContracts;
    h.no += sizeContracts;
    return { clientOrderId: id, venueOrderId: newId('vo', this.clock), status: 'ACCEPTED',
      txHash: null, reason: null, tsMs: now };
  }

  /** Open resting orders — used by tests and the health snapshot. */
  openOrders(): RestingOrder[] {
    const now = this.clock.now();
    return [...this.books.values()].flat().filter((r) => r.remaining > 0 && r.expiresMs > now);
  }
}
