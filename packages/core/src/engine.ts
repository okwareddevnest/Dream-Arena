// The MIRA engine (F-A2, ARCH §3; GWT-1, GWT-2, GWT-3).
//
// Per tick, for every open market:
//     EWMV -> price (F1/F2/F3) -> signal (hysteresis) -> size (¼-Kelly)
//     -> risk gate -> tx queue -> venue
//
// ── The one rule that shapes everything here ────────────────────────────────
// THE DECISION PATH NEVER AWAITS ANYTHING IT DOES NOT NEED.
//
// Journalling, broadcasting and persona commentary are fire-and-forget. If the
// journal's disk is full, MIRA still trades. If a WebSocket client is wedged,
// MIRA still trades. The only awaits on the path are the ones that are
// physically unavoidable — reading a quote and submitting an order — and both
// go through caches and a queue that were sized from measured latency (T-S4).
//
// The tests hold this to account directly: "engine places an order even if the
// journal throws", and a p99 decision latency under 3 ms.
//
// ── Why the pipeline is assembled here rather than in each component ───────
// Every stage is a pure function or a small object with no knowledge of the
// others. That is what let each be tested in isolation, and it means this file
// contains the only ordering assumption in the system — so there is exactly one
// place to look when the order is wrong.
import {
  newClientOrderId, kindFor, tauYears,
  type AgentId, type Bus, type Clock, type Fill, type Market, type Ms, type Order,
  type OrderAck, type Prob, type Quote, type RiskConfig, type Side, type Signal,
  type Usd, type Valuation, type Venue,
} from '@arena/shared';
import { Ewmv, type EwmvOptions } from './ewmv.ts';
import { priceMarket } from './pricer.ts';
import { SignalEngine } from './signal.ts';
import { sizeOrder } from './sizer.ts';
import { RiskGuard } from './risk.ts';

/** Submits an order, serialized and deduped. Satisfied by TxQueue (T-033); the
 *  engine takes the interface so it can be tested without one. */
/** Default order lifetime. Must exceed real settlement latency: a serialized
 *  on-chain write was measured at 25-35s under agent load, and the previous
 *  6s heuristic (quoteCacheMs * 4) meant every LIVE order was rejected with
 *  "order expiry is not in the future" before it could be submitted. */
export const DEFAULT_ORDER_TTL_MS = 45_000;

/** Order expiry: `now + ttl`, never past the market's own expiry (RFC-001 A2). */
export function orderExpiryMs(nowMs: number, marketExpiryMs: number, ttlMs: number): number {
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_ORDER_TTL_MS;
  return Math.min(marketExpiryMs, nowMs + ttl);
}

export interface OrderSubmitter {
  submit<T>(task: { clientOrderId: string; run: (nonce: number) => Promise<T> }): Promise<T>;
}

export interface EngineOptions {
  agent: AgentId;
  venue: Venue;
  bus: Bus;
  clock: Clock;
  risk: RiskConfig;
  vol: Omit<EwmvOptions, 'symbol'>;
  /** Bankroll source. Read per decision so a claim or a loss is reflected. */
  balance?: () => Usd;
  submitter?: OrderSubmitter;
  /** How long an order may rest before the venue expires it. Must exceed the
   *  time it takes a write to reach the chain, or every order is dead on
   *  arrival. Defaults to DEFAULT_ORDER_TTL_MS. */
  orderTtlMs?: number;
  /** Cache window for market listings (T-S4: the indexer dies on fan-out). */
  marketsCacheMs?: number;
  quoteCacheMs?: number;
  /** Fire-and-forget observers. Both are wrapped so a throw cannot reach the path. */
  onJournal?: (kind: 'model' | 'valuation' | 'signal' | 'order' | 'ack', payload: unknown) => void;
}

export interface EngineStats {
  ticks: number;
  valuations: number;
  skips: number;
  enters: number;
  holds: number;
  standDowns: number;
  vetoes: number;
  ordersPlaced: number;
  orderErrors: number;
  quoteErrors: number;
}

interface CachedQuote { q: Quote; atMs: Ms }

export class Engine {
  readonly agent: AgentId;
  private readonly venue: Venue;
  private readonly bus: Bus;
  private readonly clock: Clock;
  private readonly risk: RiskConfig;
  private readonly volOpts: Omit<EwmvOptions, 'symbol'>;
  private readonly guard: RiskGuard;
  private readonly signals: SignalEngine;
  private readonly submitter: OrderSubmitter | undefined;
  private readonly balanceFn: (() => Usd) | undefined;
  private readonly marketsCacheMs: number;
  private readonly orderTtlMs: number;
  private readonly quoteCacheMs: number;
  private readonly onJournal: EngineOptions['onJournal'];

  /** One volatility model per underlying, not per market: several markets share
   *  an asset, and each would otherwise see a fraction of the returns. */
  private readonly vols = new Map<string, Ewmv>();
  private markets: Market[] = [];
  private marketsAtMs = -Infinity;
  private readonly quotes = new Map<string, CachedQuote>();
  private cachedBalance: Usd = 0;
  private readonly netByMarket = new Map<string, number>();
  private stats: EngineStats = {
    ticks: 0, valuations: 0, skips: 0, enters: 0, holds: 0, standDowns: 0,
    vetoes: 0, ordersPlaced: 0, orderErrors: 0, quoteErrors: 0,
  };
  private offFill: (() => void) | null = null;

  constructor(o: EngineOptions) {
    this.agent = o.agent;
    this.venue = o.venue;
    this.bus = o.bus;
    this.clock = o.clock;
    this.risk = o.risk;
    this.volOpts = o.vol;
    this.submitter = o.submitter;
    this.balanceFn = o.balance;
    this.marketsCacheMs = o.marketsCacheMs ?? 15_000;
    this.orderTtlMs = o.orderTtlMs ?? DEFAULT_ORDER_TTL_MS;
    this.quoteCacheMs = o.quoteCacheMs ?? 1_500;
    this.onJournal = o.onJournal;
    this.guard = new RiskGuard({ risk: o.risk, agent: o.agent, bus: o.bus });
    this.signals = new SignalEngine({ agent: o.agent, risk: o.risk });
  }

  get riskGuard(): RiskGuard { return this.guard; }
  get signalEngine(): SignalEngine { return this.signals; }
  statsSnapshot(): EngineStats { return { ...this.stats }; }

  /** Subscribe to venue fills so cooldown, PnL and inventory stay current. */
  async start(): Promise<void> {
    this.cachedBalance = this.balanceFn ? this.balanceFn() : await this.venue.balanceUsd();
    this.offFill = this.venue.onFill((f) => this.onFill(f));
  }

  async stop(): Promise<void> {
    this.offFill?.();
    this.offFill = null;
  }

  /** A fill changes three things the decision path reads. */
  onFill(f: Fill): void {
    this.guard.onFill(f);
    this.signals.noteFill(f.marketId, f.tsMs);
    const signed = f.side === 'YES' ? f.sizeContracts : -f.sizeContracts;
    this.netByMarket.set(f.marketId, (this.netByMarket.get(f.marketId) ?? 0) + signed);
  }

  /** Fold realized PnL into the session-loss stop. */
  onRealizedPnl(deltaUsd: Usd): void { this.guard.onRealizedPnl(deltaUsd); }

  /**
   * Handle one tick: the whole decision path.
   *
   * Markets and quotes come from caches whose windows were set from measured
   * latency, so a tick does not fan out to the indexer — T-S4 measured 20 %
   * errors and a 29 s p99 when it does.
   */
  async onTick(symbol: string, price: number, tsMs: Ms): Promise<void> {
    this.stats.ticks++;

    // 1. Volatility. O(1), synchronous, one model per underlying.
    const vol = this.volFor(symbol);
    vol.update(price, tsMs);
    const model = vol.state(tsMs);
    this.bus.publish({ t: 'model', d: model });
    this.emit('model', model);

    // 2. Markets, from cache.
    const markets = await this.marketsFor(symbol, tsMs);
    if (markets.length === 0) return;

    // 3. Refresh the bankroll once per tick, not once per market.
    if (this.balanceFn) this.cachedBalance = this.balanceFn();

    for (const mk of markets) {
      await this.evaluateMarket(mk, model.spot, model.sigmaForecast, tsMs);
    }
  }

  /** Price, signal, size and gate ONE market. */
  private async evaluateMarket(mk: Market, spot: number, sigma: number, tsMs: Ms): Promise<void> {
    const quote = await this.quoteFor(mk, tsMs);
    if (quote === null) return;                     // already reported

    // ── Pure section: no I/O, no awaits, sub-millisecond. ──
    const valuation: Valuation = priceMarket({
      market: mk, quote, spot, sigmaForecast: sigma,
      nowMs: tsMs, maxQuoteAgeMs: this.risk.maxQuoteAgeMs,
    });
    this.stats.valuations++;
    this.bus.publish({ t: 'valuation', d: valuation });
    this.emit('valuation', valuation);

    const signal = this.signals.evaluate(valuation, tsMs);
    this.bus.publish({ t: 'signal', d: signal });
    this.emit('signal', signal);

    switch (signal.action) {
      case 'SKIP': this.stats.skips++; return;
      case 'HOLD': this.stats.holds++; return;
      case 'STAND_DOWN': this.stats.standDowns++; return;
      // Counted here, at the decision — not at submission. An ENTER that is
      // later vetoed by the risk guard or sized to zero is still an enter the
      // model wanted, and the gap between `enters` and `ordersPlaced` is
      // exactly how much the guard is holding back. Previously this counter was
      // declared, initialised and never incremented, so it always read 0.
      case 'ENTER': this.stats.enters++; break;
    }
    if (signal.side === null) return;

    const sized = this.size(mk, signal, quote, signal.side);
    if (sized.sizeContracts <= 0) {
      this.stats.holds++;
      return;
    }

    const order = this.buildOrder(mk, signal, quote, signal.side, sized.sizeContracts, tsMs);

    // ── The gate. Last thing before anything leaves the process. ──
    const verdict = this.guard.check(order, tsMs);
    if (!verdict.ok) {
      this.stats.vetoes++;
      return;
    }

    this.bus.publish({ t: 'order', d: order });
    this.emit('order', order);
    this.guard.onOrderPlaced(tsMs);
    this.stats.ordersPlaced++;

    // ── Submission. The only unavoidable await, and it is serialized. ──
    await this.place(order);
  }

  private size(mk: Market, signal: Signal, quote: Quote, side: Side): { sizeContracts: number } {
    let gross = 0;
    for (const n of this.netByMarket.values()) gross += Math.abs(n);
    const price = side === 'YES' ? quote.ask : 1 - quote.bid;
    const depth = side === 'YES' ? quote.depthAsk : quote.depthBid;
    const r = sizeOrder({
      market: mk, risk: this.risk,
      pModel: signal.pModel, price, side,
      bankrollUsd: this.cachedBalance,
      existingNetContracts: this.netByMarket.get(mk.id) ?? 0,
      grossContracts: gross,
      availableDepth: depth,
    });
    return r;
  }

  private buildOrder(
    mk: Market, signal: Signal, quote: Quote, side: Side, size: number, tsMs: Ms,
  ): Order {
    // Cross the spread: buying YES pays the ask, buying NO pays 1 - bid.
    const price = side === 'YES' ? quote.ask : 1 - quote.bid;
    const scale = 10 ** mk.priceDecimals;
    // RFC-001 A8: snap to the tick grid in INTEGER units. A float that is one
    // wei off the grid is rejected outright by the pool.
    const raw = (BigInt(Math.round(price * scale)) / mk.tickRaw) * mk.tickRaw;
    return {
      clientOrderId: newClientOrderId(this.agent, this.clock),
      marketId: mk.id,
      agent: this.agent,
      side,
      kind: kindFor(side, 'BUY'),
      type: 'LIMIT',
      limitPrice: Number(raw) / scale,
      limitPriceRaw: raw,
      sizeContracts: size,
      sizeRaw: BigInt(Math.round(size * scale)),
      // RFC-001 A2: expiry is mandatory and capped at the market's own expiry.
      // Set just past the requote interval so a crashed agent's orders age off
      // the book by themselves rather than resting with escrow locked.
      expiresMs: orderExpiryMs(tsMs, mk.expiryMs, this.orderTtlMs),
      signalId: signal.id,
      tsMs,
    };
  }

  private async place(order: Order): Promise<void> {
    try {
      const ack: OrderAck = this.submitter
        ? await this.submitter.submit({
            clientOrderId: order.clientOrderId,
            run: async () => this.venue.placeOrder(order),
          })
        : await this.venue.placeOrder(order);
      this.bus.publish({ t: 'ack', d: ack });
      this.emit('ack', ack);
      if (ack.status === 'REJECTED') this.stats.orderErrors++;
    } catch (e) {
      // A venue that rejects must not take the engine down with it.
      this.stats.orderErrors++;
      this.bus.publish({
        t: 'error',
        d: { where: 'engine.place', msg: e instanceof Error ? e.message : String(e), tsMs: order.tsMs },
      });
    }
  }

  // ── Caches. Windows come from T-S4's measurements, not from taste. ────────
  private volFor(symbol: string): Ewmv {
    let v = this.vols.get(symbol);
    if (!v) { v = new Ewmv({ ...this.volOpts, symbol }); this.vols.set(symbol, v); }
    return v;
  }

  private async marketsFor(symbol: string, tsMs: Ms): Promise<Market[]> {
    if (tsMs - this.marketsAtMs >= this.marketsCacheMs) {
      try {
        this.markets = await this.venue.getMarkets();
        this.marketsAtMs = tsMs;
      } catch (e) {
        this.bus.publish({
          t: 'error',
          d: { where: 'engine.getMarkets', msg: e instanceof Error ? e.message : String(e), tsMs },
        });
        // Keep the previous list: a stale market list is far better than none,
        // and the pricer's own status/expiry gates will reject anything dead.
      }
    }
    return this.markets.filter((m) => m.asset === symbol);
  }

  /** Returns null when a quote could not be obtained; the error is reported. */
  private async quoteFor(mk: Market, tsMs: Ms): Promise<Quote | null> {
    const hit = this.quotes.get(mk.id);
    if (hit && tsMs - hit.atMs < this.quoteCacheMs) return hit.q;
    try {
      const q = await this.venue.getQuote(mk.id);
      this.quotes.set(mk.id, { q, atMs: tsMs });
      return q;
    } catch (e) {
      this.stats.quoteErrors++;
      this.bus.publish({
        t: 'error',
        d: { where: 'engine.getQuote', msg: e instanceof Error ? e.message : String(e), tsMs },
      });
      return null;
    }
  }

  /**
   * Fire-and-forget journal hook.
   *
   * Wrapped so a throwing journal cannot reach the decision path — the property
   * asserted by "engine places an order even if the journal throws". This is
   * the difference between a full disk being an inconvenience and being an
   * outage.
   */
  private emit(kind: 'model' | 'valuation' | 'signal' | 'order' | 'ack', payload: unknown): void {
    if (!this.onJournal) return;
    try { this.onJournal(kind, payload); } catch { /* deliberately swallowed */ }
  }

  /** Cancel everything and stop. Used by the kill switch (GWT-7). */
  async panic(by: string): Promise<void> {
    this.guard.kill(by);
    try { await this.venue.cancelAll(this.agent); } catch { /* halting must not throw */ }
  }

  /** Current model state per underlying, for the snapshot. */
  models(): ReturnType<Ewmv['state']>[] {
    const now = this.clock.now();
    return [...this.vols.values()].map((v) => v.state(now));
  }

  /** Mid price last seen for a market, for MIRROR and the gauge. */
  lastQuote(marketId: string): Quote | null { return this.quotes.get(marketId)?.q ?? null; }

  /** Net position by market, as the engine believes it. The reconciler
   *  (T-035) overwrites this from chain state. */
  net(marketId: string): number { return this.netByMarket.get(marketId) ?? 0; }
  adoptNet(marketId: string, net: number): void { this.netByMarket.set(marketId, net); }
  dropNet(marketId: string): void { this.netByMarket.delete(marketId); }

  /** Probability the model currently assigns a market, for the gauge. */
  pModelFor(mk: Market, tsMs: Ms): Prob | null {
    const vol = this.vols.get(mk.asset);
    const q = this.lastQuote(mk.id);
    if (!vol || !q || mk.strike === null) return null;
    const v = priceMarket({
      market: mk, quote: q, spot: vol.lastSpot, sigmaForecast: vol.sigma,
      nowMs: tsMs, maxQuoteAgeMs: this.risk.maxQuoteAgeMs,
    });
    return v.skipReason === null ? v.pModel : null;
  }

  /** Years to expiry, exposed so the console can show the window closing. */
  tauFor(mk: Market, tsMs: Ms): number { return tauYears(tsMs, mk.expiryMs); }
}
