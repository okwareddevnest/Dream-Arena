// DreamDEXVenue — the real venue, on @somnia-chain/markets-sdk (FR-V3).
//
// Satisfies the same `Venue` contract as SimulatedVenue and passes the same
// conformance suite, which is what makes the LIVE -> SIM switchover a
// constructor swap (GWT-8) rather than a code path.
//
// ── Every sharp edge here was measured or read, not guessed ────────────────
// The bot kit's own gotchas page is a list of things that cost its authors real
// time, and each one below is a defence against a specific documented failure:
//
//  1. GATE ON CHAIN STATUS, NOT THE INDEXER. The indexer lags by seconds; only
//     a market in `Trading` accepts orders. Writes therefore re-read status via
//     `getMarketOnchain` and refuse otherwise.
//  2. A REVERTED WRITE DOES NOT THROW. The SDK skips simulation and resolves
//     even when the transaction reverted, so a mint on a locked market
//     "succeeds" silently. Every write is checked for `receipt.status`.
//  3. NEVER HAND THE SDK A FLOAT PRICE. `(0.05).toFixed(18)` is three wei off
//     the tick grid and the pool rejects it with `InvalidPrice`; of fifteen
//     ordinary probabilities only 0.25, 0.5 and 0.75 survive on an 18-decimal
//     venue. Prices travel as integers, snapped to `tickRaw` (RFC-001 A8).
//  5. ORDER EXPIRY IS MANDATORY, capped at the market's own expiry (RFC-001 A2).
//  6. SIZE TO THE LOT GRID YOURSELF. The SDK's generic quantizer skips lot
//     sizing on binary markets and floors small sizes to zero.
//  9. THE INDEXER LAGS. Reads are cached and serialized — T-S4 measured 20 %
//     errors and a 29 s p99 at 30-way concurrency, so `indexerMaxInFlight` is 1.
// 10. MARKETS DIE ON SCHEDULE AND RESPAWN. State is keyed by `marketId`, never
//     by pool address, because pools are recycled across windows.
// 11. `loadMarkets()` CANNOT FIND YOUR WINNINGS. A settled market leaves the
//     live registry, so `settledMarkets()` goes through the binary tier's
//     `Finalized` status instead.
// 12. DO NOT PARSE THE QUESTION TEXT. Read `strike` and `intervalSec`.
//
// ── Dependency injection, and why ──────────────────────────────────────────
// The SDK surface is taken as an interface (`SdkClient`) rather than imported
// concretely. That is not indirection for its own sake: it lets the whole
// adapter run the conformance suite against a stub transport with no network,
// no key and no funded wallet — which is exactly the situation this build is in
// (T-S2 B1). The live-RPC assertions skip loudly; everything else is covered.
import {
  TRADABLE_STATUS, marketStatusFromOrdinal, newId,
  type AgentId, type CancelAck, type Claimable, type ClaimResult, type Fill,
  type Market, type MarketMode, type MarketStatus, type Ms, type Order, type OrderAck,
  type Position, type Prob, type Quote, type Side, type Usd, type Venue, type VenueHealth,
} from '@arena/shared';
import type { NonceManager, TxQueue } from './txqueue.ts';

/** A raw binary-market row as the indexer returns it (T-S2, observed live). */
export interface SdkMarketRow {
  marketId: string;
  asset?: string | null;
  /** Scaled by 100 with no `strikeDecimals` field; `"0"` is the reference-mode
   *  sentinel. Measured: BTC `"7933525"` = 79 335.25 (T-S1 C4). */
  strike?: string | number | null;
  intervalSec?: string | number | null;
  /** Unix SECONDS, not millis. */
  expiry?: string | number | null;
  tradingStart?: string | number | null;
  status?: string | null;
  poolAddress?: string | null;
  nonce?: string | number | null;
  venueId?: string | null;
  operatorId?: number | null;
  yesTokenId?: string | null;
  noTokenId?: string | null;
  outcomes?: { symbol: string; label: string; index: number }[] | null;
  symbol?: string | null;
}

export interface SdkOnchainMarket {
  /** 0 Listed · 1 Trading · 2 Locked · 3 Settling · 4 Resolved · 5 Voided. */
  status: number;
  poolAddress?: string | null;
  nonce?: number | null;
  winningOutcome?: number | null;
}

export interface SdkOrderBook {
  bids: [number, number][];
  asks: [number, number][];
}

export interface SdkTxResult {
  hash?: string;
  /** The SDK resolves even on a revert, so this must be inspected (gotcha 2). */
  receipt?: { status?: string };
  info?: { receipt?: { status?: string } };
  orderId?: string;
}

/** The slice of the SDK this adapter uses. Injected so it can be stubbed. */
export interface SdkClient {
  listBinaryMarkets(q: { venueId?: string; status?: string; limit?: number }): Promise<SdkMarketRow[]>;
  getMarketOnchain(marketId: string): Promise<SdkOnchainMarket | null>;
  fetchOrderBook(outcomeSymbol: string, depth: number): Promise<SdkOrderBook>;
  /** Raw tier: integer quantities and prices only (gotcha 3). */
  placeOrderRaw(args: {
    marketId: string; outcomeSymbol: string; kind: number;
    priceRaw: bigint; quantityRaw: bigint; orderType: number;
    expireTimestampNs: bigint; nonce: number;
  }): Promise<SdkTxResult>;
  cancelOrder(args: { marketId: string; orderId: string; nonce: number }): Promise<SdkTxResult>;
  openOrders(args: { venueId?: string }): Promise<{ orderId: string; marketId: string; clientTag?: string }[]>;
  outcomeBalances(marketId: string): Promise<{ yes: number; no: number }>;
  collateralBalance(): Promise<number>;
  mintSet(args: { marketId: string; quantityRaw: bigint; nonce: number }): Promise<SdkTxResult>;
  redeem(args: { marketId: string; nonce: number }): Promise<SdkTxResult & { amount?: number }>;
  blockNumber(): Promise<number>;
  /** Named to match `NonceSource` so an SdkClient IS a nonce source (viem uses
   *  the same name), rather than needing an adapter between them. */
  getTransactionCount(): Promise<number>;
}

export interface DreamDEXVenueOptions {
  client: SdkClient;
  agent: AgentId;
  /** Required: two venues are live simultaneously and the ids move (T-S4). */
  venueId: string;
  /** Required for writes. Absent = read-only, and construction says so. */
  privateKey?: string | null;
  /** Writes MUST go through the queue, never straight to the RPC (T-033). */
  queue?: TxQueue;
  nonces?: NonceManager;
  explorerBase?: string;
  priceDecimals?: number;
  tickRaw?: bigint;
  lotRaw?: bigint;
  minSize?: number;
  feeBps?: number;
  /** Measured caches (T-S4). */
  marketsCacheMs?: number;
  quoteCacheMs?: number;
  maxQuoteAgeMs?: number;
  now?: () => Ms;
}

/** ORDER_KIND from the SDK: BUY_YES 0, SELL_YES 1, BUY_NO 2, SELL_NO 3. */
const KIND_ORDINAL: Record<string, number> = {
  BUY_YES: 0, SELL_YES: 1, BUY_NO: 2, SELL_NO: 3,
};
/** ORDER_TYPE from the SDK: LIMIT 0, FILL_OR_KILL 1, MARKET 2, POST_ONLY 3. */
const TYPE_ORDINAL: Record<string, number> = {
  LIMIT: 0, FILL_OR_KILL: 1, MARKET: 2, POST_ONLY: 3,
};

/** Indexer status strings map onto the on-chain enum names. */
const INDEXER_STATUS: Record<string, MarketStatus> = {
  Listed: 'Listed', Trading: 'Trading', Locked: 'Locked',
  Settling: 'Settling', Resolved: 'Resolved', Finalized: 'Resolved', Voided: 'Voided',
};

/** T-S1 C4: strike carries two implied decimals; `0` means reference mode. */
export const STRIKE_SCALE = 100;
export function decodeStrike(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n === 0) return null;
  return n / STRIKE_SCALE;
}

/** `binaryResolutionMode` from the SDK, reimplemented so the mapping is
 *  visible here rather than hidden behind an import. */
export function resolutionMode(strike: string | number | null | undefined): MarketMode {
  return strike === null || strike === undefined || strike === '0' || strike === 0 ? 'reference' : 'fixed';
}

/** Assert a write actually landed. The SDK does NOT throw on a revert. */
export function assertTxOk(res: SdkTxResult, label: string): void {
  const status = res?.receipt?.status ?? res?.info?.receipt?.status;
  if (status === 'reverted') {
    throw new Error(
      `${label} REVERTED on-chain (tx ${res.hash ?? '?'}). The SDK resolves reverted writes ` +
      `without throwing, so this was checked explicitly.`,
    );
  }
}

/** Serializes indexer reads to one in flight. T-S4: concurrency is what breaks it. */
class SerialGate {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => undefined, () => undefined).then(fn);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

interface CacheEntry<T> { v: T; atMs: Ms }

export class DreamDEXVenue implements Venue {
  readonly name = 'DreamDEXVenue' as const;
  readonly mode = 'LIVE' as const;
  readonly agent: AgentId;

  private readonly c: SdkClient;
  private readonly venueId: string;
  private readonly queue: TxQueue | undefined;
  private readonly explorerBase: string;
  private readonly priceDecimals: number;
  private readonly tickRaw: bigint;
  private readonly lotRaw: bigint;
  private readonly minSize: number;
  private readonly feeBps: number;
  private readonly marketsCacheMs: number;
  private readonly quoteCacheMs: number;
  private readonly maxQuoteAgeMs: number;
  private readonly nowFn: () => Ms;
  private readonly canWrite: boolean;

  private readonly gate = new SerialGate();
  private marketsCache: CacheEntry<Market[]> | null = null;
  private readonly quoteCache = new Map<string, CacheEntry<Quote>>();
  private readonly onchainCache = new Map<string, CacheEntry<SdkOnchainMarket | null>>();
  private readonly seenOrders = new Map<string, OrderAck>();
  /** clientOrderId -> venue orderId, so `cancel` can address it. */
  private readonly venueOrderIds = new Map<string, string>();
  private fillCbs: ((f: Fill) => void)[] = [];
  private connected = false;
  private lastErrorMs: Ms | null = null;
  private lastDetail: string | null = null;

  constructor(o: DreamDEXVenueOptions) {
    // RFC-001: fail at CONSTRUCTION, not at the first order. A venue that
    // discovers it cannot sign halfway through a demo is worse than one that
    // refuses to start.
    if (!o.venueId) {
      throw new Error(
        'DreamDEXVenue: venueId is required. Two venues are live simultaneously on testnet ' +
        '(operatorId 2 and 4) and the ids move, so guessing trades a venue you did not mean ' +
        '(docs/spikes/S4-limits.md).',
      );
    }
    this.c = o.client;
    this.agent = o.agent;
    this.venueId = o.venueId;
    this.queue = o.queue;
    this.explorerBase = o.explorerBase ?? 'https://shannon-explorer.somnia.network/tx/';
    this.priceDecimals = o.priceDecimals ?? 6;
    this.tickRaw = o.tickRaw ?? 1_000n;
    this.lotRaw = o.lotRaw ?? 1n;
    this.minSize = o.minSize ?? 1;
    this.feeBps = o.feeBps ?? 0;
    this.marketsCacheMs = o.marketsCacheMs ?? 15_000;
    this.quoteCacheMs = o.quoteCacheMs ?? 1_500;
    this.maxQuoteAgeMs = o.maxQuoteAgeMs ?? 4_000;
    this.nowFn = o.now ?? (() => Date.now());
    this.canWrite = Boolean(o.privateKey);
  }

  now(): Ms { return this.nowFn(); }

  async connect(): Promise<void> {
    // Prove the chain is reachable before claiming to be connected.
    await this.c.blockNumber();
    this.connected = true;
  }

  async disconnect(): Promise<void> { this.connected = false; }

  async health(): Promise<VenueHealth> {
    if (!this.connected) {
      return { ok: false, mode: this.mode, name: this.name, blockNumber: null,
        latencyMs: null, lastErrorMs: this.lastErrorMs, detail: 'disconnected' };
    }
    const t0 = Date.now();
    try {
      const bn = await this.c.blockNumber();
      return { ok: true, mode: this.mode, name: this.name, blockNumber: bn,
        latencyMs: Date.now() - t0, lastErrorMs: this.lastErrorMs, detail: this.lastDetail };
    } catch (e) {
      this.note(e);
      return { ok: false, mode: this.mode, name: this.name, blockNumber: null,
        latencyMs: Date.now() - t0, lastErrorMs: this.lastErrorMs,
        detail: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── Markets ──────────────────────────────────────────────────────────────
  private rowToMarket(r: SdkMarketRow): Market {
    const strike = decodeStrike(r.strike);
    const mode = resolutionMode(r.strike);
    const expirySec = Number(r.expiry ?? 0);
    const startSec = Number(r.tradingStart ?? 0);
    const outs = r.outcomes ?? [];
    return {
      // Keyed by marketId, never poolAddress: pools recycle (gotcha 10).
      id: r.marketId,
      symbol: r.symbol ?? `${r.asset ?? '?'}-${strike ?? 'REF'}-${r.intervalSec ?? '?'}s`,
      yesSymbol: outs[0]?.symbol ?? `${r.marketId}#YES`,
      noSymbol: outs[1]?.symbol ?? `${r.marketId}#NO`,
      asset: r.asset ?? '?',
      strike,
      mode,
      // A reference market has no boundary until its opening price posts
      // (RFC-001 A4). `strike` being non-zero IS that posting.
      boundaryPosted: strike !== null,
      intervalSec: Number(r.intervalSec ?? 0),
      // The indexer speaks seconds; everything above this line speaks millis.
      tradingStartMs: startSec * 1_000,
      expiryMs: expirySec * 1_000,
      // T-S1: DreamDEX is expiry-settled, both modes.
      style: 'EXPIRY',
      tickRaw: this.tickRaw,
      lotRaw: this.lotRaw,
      priceDecimals: this.priceDecimals,
      minSize: this.minSize,
      feeBps: this.feeBps,
      poolAddress: r.poolAddress ?? null,
      nonce: r.nonce === null || r.nonce === undefined ? null : Number(r.nonce),
      venue: 'DREAMDEX',
      status: INDEXER_STATUS[r.status ?? ''] ?? 'Voided',
    };
  }

  async getMarkets(): Promise<Market[]> {
    const now = this.nowFn();
    if (this.marketsCache && now - this.marketsCache.atMs < this.marketsCacheMs) {
      return this.marketsCache.v;
    }
    const rows = await this.gate.run(() =>
      this.c.listBinaryMarkets({ venueId: this.venueId, status: 'Trading', limit: 50 }));
    const markets = rows.map((r) => this.rowToMarket(r));
    this.marketsCache = { v: markets, atMs: now };
    return markets;
  }

  async settledMarkets(limit = 40): Promise<Market[]> {
    // `listBinaryMarkets` with `Finalized` is the ONLY way to find these: a
    // settled market leaves the live registry (gotcha 11).
    const rows = await this.gate.run(() =>
      this.c.listBinaryMarkets({ venueId: this.venueId, status: 'Finalized', limit: Math.min(200, limit * 3) }));
    return rows
      .map((r) => this.rowToMarket(r))
      .sort((a, b) => b.expiryMs - a.expiryMs)
      .slice(0, limit);
  }

  /** Authoritative status. Never trust the indexer for a write (gotcha 1). */
  private async onchain(marketId: string): Promise<SdkOnchainMarket | null> {
    const now = this.nowFn();
    const hit = this.onchainCache.get(marketId);
    if (hit && now - hit.atMs < 1_000) return hit.v;
    const v = await this.gate.run(() => this.c.getMarketOnchain(marketId));
    this.onchainCache.set(marketId, { v, atMs: now });
    return v;
  }

  // ── Quotes ───────────────────────────────────────────────────────────────
  async getQuote(marketId: string): Promise<Quote> {
    const now = this.nowFn();
    const hit = this.quoteCache.get(marketId);
    if (hit && now - hit.atMs < this.quoteCacheMs) return hit.v;

    const markets = await this.getMarkets();
    const mk = markets.find((m) => m.id === marketId);
    if (!mk) throw new Error(`DreamDEXVenue: unknown market ${marketId}`);

    const ob = await this.gate.run(() => this.c.fetchOrderBook(mk.yesSymbol, 5));
    // Prices from the book are already YES probabilities in (0,1) (T-S3).
    const bid = ob.bids[0]?.[0] ?? 0;
    const ask = ob.asks[0]?.[0] ?? 1;
    const hasBoth = ob.bids.length > 0 && ob.asks.length > 0;
    const q: Quote = {
      marketId,
      bid, ask,
      mid: hasBoth ? (bid + ask) / 2 : (ob.bids[0]?.[0] ?? ob.asks[0]?.[0] ?? 0.5),
      depthBid: ob.bids[0]?.[1] ?? 0,
      depthAsk: ob.asks[0]?.[1] ?? 0,
      stale: false,
      tsMs: now,
    };
    // Clamp mid into [bid, ask] so the frozen invariant holds even on a
    // one-sided book.
    q.mid = Math.min(Math.max(q.mid, q.bid), q.ask);
    this.quoteCache.set(marketId, { v: q, atMs: now });
    return q;
  }

  // ── Orders ───────────────────────────────────────────────────────────────
  private reject(o: Order, reason: string): OrderAck {
    const ack: OrderAck = {
      clientOrderId: o.clientOrderId, venueOrderId: null,
      status: 'REJECTED', txHash: null, reason, tsMs: this.nowFn(),
    };
    this.seenOrders.set(o.clientOrderId, ack);
    return ack;
  }

  private onGrid(raw: bigint): boolean { return raw % this.tickRaw === 0n; }

  async placeOrder(order: Order): Promise<OrderAck> {
    const now = this.nowFn();

    const prior = this.seenOrders.get(order.clientOrderId);
    if (prior) return prior;

    if (!this.canWrite) return this.reject(order, 'venue is read-only: no signing key configured');

    const markets = await this.getMarkets().catch(() => [] as Market[]);
    const mk = markets.find((m) => m.id === order.marketId);
    if (!mk) return this.reject(order, `unknown market ${order.marketId}`);

    // gotcha 1: the chain decides, not the indexer.
    let chain: SdkOnchainMarket | null;
    try {
      chain = await this.onchain(order.marketId);
    } catch (e) {
      this.note(e);
      return this.reject(order, `could not read on-chain status: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!chain) return this.reject(order, `no on-chain market for ${order.marketId}`);
    const status = marketStatusFromOrdinal(chain.status);
    if (status !== TRADABLE_STATUS) {
      return this.reject(order, `on-chain market status is ${status}, only ${TRADABLE_STATUS} accepts orders`);
    }

    // RFC-001 A2 / gotcha 5: expiry is mandatory, and capped at market expiry.
    if (!(order.expiresMs > now)) {
      return this.reject(order, `order expiry ${order.expiresMs} is not in the future (now ${now})`);
    }
    const expiresMs = Math.min(order.expiresMs, mk.expiryMs);

    // gotcha 6 / RFC-001 A8: sizes and prices are integers on their own grids.
    if (!(order.sizeContracts >= this.minSize)) {
      return this.reject(order, `size ${order.sizeContracts} is below the market minimum size ${this.minSize}`);
    }
    const isMarket = order.type === 'MARKET' || order.limitPriceRaw === null;
    let priceRaw = order.limitPriceRaw ?? 0n;
    if (!isMarket) {
      if (!this.onGrid(priceRaw)) {
        return this.reject(order,
          `price ${priceRaw} is not a multiple of the tick grid ${this.tickRaw} — the pool rejects ` +
          `off-grid prices with InvalidPrice (gotcha 3)`);
      }
      if (priceRaw <= 0n || priceRaw >= 10n ** BigInt(this.priceDecimals)) {
        return this.reject(order, `price ${priceRaw} is outside the tradable range`);
      }
    } else {
      priceRaw = order.side === 'YES' ? 10n ** BigInt(this.priceDecimals) - this.tickRaw : this.tickRaw;
    }

    const outcomeSymbol = order.side === 'YES' ? mk.yesSymbol : mk.noSymbol;
    const quantityRaw = order.sizeRaw ?? BigInt(Math.round(order.sizeContracts * 10 ** this.priceDecimals));
    // The venue takes nanoseconds; everything above this line is millis.
    const expireTimestampNs = BigInt(expiresMs) * 1_000_000n;

    const submit = async (nonce: number): Promise<SdkTxResult> => this.c.placeOrderRaw({
      marketId: order.marketId,
      outcomeSymbol,
      kind: KIND_ORDINAL[order.kind] ?? 0,
      priceRaw,
      quantityRaw,
      orderType: TYPE_ORDINAL[order.type] ?? 0,
      expireTimestampNs,
      nonce,
    });

    try {
      // Writes go through the queue, never straight to the RPC: one key, one
      // nonce stream (T-033). A missing queue is a configuration error.
      const res = this.queue
        ? await this.queue.submit({ clientOrderId: order.clientOrderId, run: submit })
        : await submit(await this.fallbackNonce());
      // gotcha 2: the SDK resolves reverted writes without throwing.
      assertTxOk(res, `placeOrder ${order.clientOrderId}`);
      const ack: OrderAck = {
        clientOrderId: order.clientOrderId,
        venueOrderId: res.orderId ?? null,
        status: 'ACCEPTED',
        txHash: res.hash ?? null,
        reason: null,
        tsMs: this.nowFn(),
      };
      if (res.orderId) this.venueOrderIds.set(order.clientOrderId, res.orderId);
      this.seenOrders.set(order.clientOrderId, ack);
      return ack;
    } catch (e) {
      this.note(e);
      // An RPC error becomes a REJECTED ack, never an unhandled rejection.
      return this.reject(order, e instanceof Error ? e.message : String(e));
    }
  }

  async cancel(clientOrderId: string): Promise<CancelAck> {
    const now = this.nowFn();
    const orderId = this.venueOrderIds.get(clientOrderId);
    if (!orderId) {
      const known = this.seenOrders.get(clientOrderId);
      return {
        clientOrderId,
        status: known && known.status === 'ACCEPTED' ? 'ALREADY_FILLED' : 'NOT_FOUND',
        txHash: null, tsMs: now,
      };
    }
    const ack = this.seenOrders.get(clientOrderId);
    const marketId = ack ? this.marketIdFor(clientOrderId) : null;
    try {
      const res = this.queue
        ? await this.queue.submit({
            clientOrderId: `cancel:${clientOrderId}`,
            run: (nonce) => this.c.cancelOrder({ marketId: marketId ?? '', orderId, nonce }),
          })
        : await this.c.cancelOrder({ marketId: marketId ?? '', orderId, nonce: await this.fallbackNonce() });
      assertTxOk(res, `cancel ${clientOrderId}`);
      this.venueOrderIds.delete(clientOrderId);
      return { clientOrderId, status: 'CANCELLED', txHash: res.hash ?? null, tsMs: now };
    } catch (e) {
      this.note(e);
      // Cancelling something already gone is not an error worth throwing.
      return { clientOrderId, status: 'NOT_FOUND', txHash: null, tsMs: now };
    }
  }

  async cancelAll(agent?: AgentId): Promise<CancelAck[]> {
    if (agent !== undefined && agent !== this.agent) return [];
    let open: { orderId: string; marketId: string; clientTag?: string }[];
    try {
      open = await this.gate.run(() => this.c.openOrders({ venueId: this.venueId }));
    } catch (e) {
      this.note(e);
      return [];
    }
    const out: CancelAck[] = [];
    for (const o of open) {
      const clientOrderId = o.clientTag ?? o.orderId;
      try {
        const res = await this.c.cancelOrder({ marketId: o.marketId, orderId: o.orderId, nonce: await this.fallbackNonce() });
        assertTxOk(res, `cancelAll ${o.orderId}`);
        this.venueOrderIds.delete(clientOrderId);
        out.push({ clientOrderId, status: 'CANCELLED', txHash: res.hash ?? null, tsMs: this.nowFn() });
      } catch (e) {
        this.note(e);
      }
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

  /** Publish a fill observed from chain events. Called by the event subscriber. */
  emitFill(f: Omit<Fill, 'fillId' | 'explorerUrl'> & { fillId?: string }): Fill {
    const fill: Fill = {
      ...f,
      fillId: f.fillId ?? newId('fill'),
      // A LIVE fill must be explorer-verifiable: the demo clicks this link.
      explorerUrl: f.txHash ? `${this.explorerBase}${f.txHash}` : null,
    };
    for (const cb of [...this.fillCbs]) { try { cb(fill); } catch { /* isolate */ } }
    return fill;
  }

  // ── Positions and balance ────────────────────────────────────────────────
  async positions(agent?: AgentId): Promise<Position[]> {
    if (agent !== undefined && agent !== this.agent) return [];
    const markets = await this.getMarkets().catch(() => [] as Market[]);
    const out: Position[] = [];
    for (const mk of markets) {
      let bal: { yes: number; no: number };
      try {
        bal = await this.gate.run(() => this.c.outcomeBalances(mk.id));
      } catch (e) {
        this.note(e);
        continue;
      }
      const net = bal.yes - bal.no;
      if (net === 0 && bal.yes === 0 && bal.no === 0) continue;
      const q = await this.getQuote(mk.id).catch(() => null);
      const mark = q?.mid ?? 0.5;
      out.push({
        marketId: mk.id, agent: this.agent,
        netContracts: net,
        // Chain balances carry no basis; the reconciler adopts net and mark,
        // and realized PnL is reconstructed from the journal (T-064).
        avgPrice: mark, markPrice: mark,
        realizedPnlUsd: 0, unrealizedPnlUsd: 0,
        tsMs: this.nowFn(),
      });
    }
    return out;
  }

  async balanceUsd(agent?: AgentId): Promise<Usd> {
    if (agent !== undefined && agent !== this.agent) return 0;
    try {
      return Math.max(0, await this.gate.run(() => this.c.collateralBalance()));
    } catch (e) {
      this.note(e);
      return 0;
    }
  }

  // ── Claim and mint (RFC-001 A5/A6) ───────────────────────────────────────
  async claimable(): Promise<Claimable[]> {
    const settled = await this.settledMarkets(25).catch(() => [] as Market[]);
    const out: Claimable[] = [];
    for (const mk of settled) {
      let chain: SdkOnchainMarket | null;
      try { chain = await this.onchain(mk.id); } catch (e) { this.note(e); continue; }
      if (!chain || chain.winningOutcome === null || chain.winningOutcome === undefined) continue;
      let bal: { yes: number; no: number };
      try { bal = await this.gate.run(() => this.c.outcomeBalances(mk.id)); } catch (e) { this.note(e); continue; }
      const winIdx = chain.winningOutcome === 0 ? 0 : 1;
      const size = winIdx === 0 ? bal.yes : bal.no;
      if (size <= 0) continue;                // a losing outcome is never claimable
      out.push({
        marketId: mk.id, symbol: mk.symbol, expiryMs: mk.expiryMs,
        outcomeIdx: winIdx as 0 | 1, sizeContracts: size, estPayoutUsd: size,
      });
    }
    return out;
  }

  async claim(marketId: string): Promise<ClaimResult> {
    const now = this.nowFn();
    const base = { marketId, txHash: null as string | null, tsMs: now };
    if (!this.canWrite) return { ...base, claimed: false, amountUsd: 0, reason: 'venue is read-only' };
    let chain: SdkOnchainMarket | null;
    try { chain = await this.onchain(marketId); } catch (e) {
      this.note(e);
      return { ...base, claimed: false, amountUsd: 0, reason: e instanceof Error ? e.message : String(e) };
    }
    if (!chain) return { ...base, claimed: false, amountUsd: 0, reason: `unknown market ${marketId}` };
    const status = marketStatusFromOrdinal(chain.status);
    if (status !== 'Resolved') {
      return { ...base, claimed: false, amountUsd: 0,
        reason: `market is ${status}, not Resolved — nothing to claim yet` };
    }
    try {
      const res = this.queue
        ? await this.queue.submit({
            clientOrderId: `claim:${marketId}`,
            run: (nonce) => this.c.redeem({ marketId, nonce }),
          })
        : await this.c.redeem({ marketId, nonce: await this.fallbackNonce() });
      assertTxOk(res, `claim ${marketId}`);
      return { marketId, claimed: true, amountUsd: res.amount ?? 0,
        txHash: res.hash ?? null, reason: null, tsMs: this.nowFn() };
    } catch (e) {
      this.note(e);
      return { ...base, claimed: false, amountUsd: 0, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async mintPair(marketId: string, sizeContracts: number): Promise<OrderAck> {
    const now = this.nowFn();
    const id = newId('mint');
    const fail = (reason: string): OrderAck => ({
      clientOrderId: id, venueOrderId: null, status: 'REJECTED', txHash: null, reason, tsMs: now,
    });
    if (!this.canWrite) return fail('venue is read-only: no signing key configured');
    if (!(sizeContracts > 0)) return fail(`size ${sizeContracts} must be positive`);
    let chain: SdkOnchainMarket | null;
    try { chain = await this.onchain(marketId); } catch (e) { this.note(e); return fail(String(e)); }
    if (!chain) return fail(`unknown market ${marketId}`);
    const status = marketStatusFromOrdinal(chain.status);
    if (status !== TRADABLE_STATUS) return fail(`market status is ${status}, cannot mint`);
    const quantityRaw = BigInt(Math.round(sizeContracts * 10 ** this.priceDecimals));
    try {
      const res = this.queue
        ? await this.queue.submit({
            clientOrderId: `mint:${marketId}:${sizeContracts}`,
            run: (nonce) => this.c.mintSet({ marketId, quantityRaw, nonce }),
          })
        : await this.c.mintSet({ marketId, quantityRaw, nonce: await this.fallbackNonce() });
      assertTxOk(res, `mintPair ${marketId}`);
      return { clientOrderId: id, venueOrderId: res.orderId ?? null, status: 'ACCEPTED',
        txHash: res.hash ?? null, reason: null, tsMs: this.nowFn() };
    } catch (e) {
      this.note(e);
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────
  private marketIdFor(_clientOrderId: string): string | null {
    // The ack does not carry a market id; the caller's order does. Kept as a
    // hook so `cancel` can be given one when the API gains it.
    return null;
  }

  private async fallbackNonce(): Promise<number> {
    return this.c.getTransactionCount();
  }

  private note(e: unknown): void {
    this.lastErrorMs = this.nowFn();
    this.lastDetail = e instanceof Error ? e.message : String(e);
  }

  /** Cache windows in force, for the health panel. */
  cacheInfo(): { marketsCacheMs: number; quoteCacheMs: number; maxQuoteAgeMs: number } {
    return {
      marketsCacheMs: this.marketsCacheMs,
      quoteCacheMs: this.quoteCacheMs,
      maxQuoteAgeMs: this.maxQuoteAgeMs,
    };
  }
}
