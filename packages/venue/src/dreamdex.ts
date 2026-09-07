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
import { dbg, type NonceManager, type TxQueue } from './txqueue.ts';
import { tradableByTime, type BoundarySource } from './boundary.ts';
import { ConcurrentGate } from './gate.ts';

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
  /** Matches executed by THIS order, returned synchronously by the SDK. This is
   *  the fill source: it needs no indexer (which lags) and no socket. MIRA's
   *  LIMIT orders cross the book, so most fills arrive here immediately. */
  fills?: { quantityFilled: bigint | string; fillPrice: bigint | string; id?: string }[];
}

/** A fill from the chain's live tail — how a MAKER-side match is learned. */
export interface SdkLiveFill {
  /** `${blockNumber}_${logIndex}` — stable chain id, used to dedupe. */
  id: string;
  marketId: string;
  /** Raw 6dp. */
  fillPrice: string | bigint;
  quantity: string | bigint;
  side: Side;
  txHash?: string | null;
  tsMs?: Ms;
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
  /** Reclaim escrow from orders the pool considers EXPIRED. A normal cancel on
   *  one reverts with `IncorrectSender(caller, 0x0)` — the pool has no owner for
   *  it any more — and the collateral stays locked until this is called.
   *  Optional so a stub transport need not implement it. */
  cancelExpiredOrders?(args: { marketId: string; orderIds: string[] }): Promise<SdkTxResult>;
  /** Our fills from the chain's live tail, including ones we did not initiate.
   *  Optional: a stub transport need not tail. */
  liveUserFills?(args: { marketIds: string[]; limit?: number }): Promise<SdkLiveFill[]>;
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
  /** Resolves the opening price of a `reference` market (RFC-001 A4). Without
   *  one, every reference market stays unpriceable (skip BOUNDARY_NOT_POSTED)
   *  because the indexer row carries `strike: "0"` and never posts the boundary. */
  boundary?: BoundarySource;
  /** Drop markets with less than this long to live: writes are serialised and an
   *  SDK write takes seconds, so an order on a market with moments left expires
   *  before it can be submitted. 0 disables (prior behaviour). */
  minSecondsToExpiry?: number;
  /** Concurrent `eth_call`s allowed. THROTTLE.rpcMaxInFlight (4); 1 serialises. */
  rpcMaxInFlight?: number;
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
/** The pool's way of saying "that order is expired": it has no owner any more. */
const EXPIRED_ORDER = /IncorrectSender\([^,]+,\s*0x0+\)/i;

/** Any IncorrectSender means the order is not ours to cancel — either it expired
 *  (owner 0x0) or the id now resolves to someone else's order, because pools
 *  recycle. Retrying can only ever burn gas, so the order is forgotten. */
const NOT_OURS = /IncorrectSender\(/i;

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

interface CacheEntry<T> { v: T; atMs: Ms }

export class DreamDEXVenue implements Venue {
  readonly name = 'DreamDEXVenue' as const;
  readonly mode = 'LIVE' as const;
  readonly agent: AgentId;

  private readonly c: SdkClient;
  private readonly venueId: string;
  private readonly queue: TxQueue | undefined;
  private readonly boundary: BoundarySource | undefined;
  private readonly minTteMs: number;
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

  /** INDEXER lane — the measured 1-rps constraint (T-S4) applies here only. */
  private readonly gate = new ConcurrentGate(1);
  /** RPC lane. `getMarketOnchain` / `getBinaryOrderBook` / balance reads are
   *  `eth_call`s, not indexer queries, and the node tolerates concurrency
   *  (THROTTLE.rpcMaxInFlight = 4). Sharing the indexer lane starved the WRITE
   *  path: quotes refresh every 1.5s across every market, so a placeOrder's
   *  status read queued behind them and blew the 30s TxQueue timeout while the
   *  same call took 1.5s in isolation. Reads must never starve writes. */
  private readonly rpcGate: ConcurrentGate;
  private marketsCache: CacheEntry<Market[]> | null = null;
  private readonly quoteCache = new Map<string, CacheEntry<Quote>>();
  private readonly onchainCache = new Map<string, CacheEntry<SdkOnchainMarket | null>>();
  private readonly seenOrders = new Map<string, OrderAck>();
  /** clientOrderId -> venue orderId, so `cancel` can address it. */
  private readonly venueOrderIds = new Map<string, string>();
  /** clientOrderId → marketId for orders WE placed and have not cancelled.
   *  cancelAll needs this: `openOrders()` reads the indexer, which lags the
   *  chain and returns [] right after a write — so on shutdown the agent
   *  reported "cancelled 0" while its own collateral sat locked in live orders. */
  private readonly ownOrderMarkets = new Map<string, string>();
  /** Chain fill ids already published, so the taker and maker paths cannot
   *  double-report the same trade. */
  private readonly seenChainFills = new Set<string>();
  /** Orders the pool refused to cancel as not ours — never signed for again. */
  private readonly deadOrders = new Set<string>();
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
    this.boundary = o.boundary;
    this.minTteMs = Math.max(0, (o.minSecondsToExpiry ?? 0) * 1_000);
    this.rpcGate = new ConcurrentGate(o.rpcMaxInFlight ?? 4);
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
    const all = rows.map((r) => this.rowToMarket(r));
    await this.postBoundaries(all, rows);
    // A market we cannot round-trip in is not tradable — see tradableByTime.
    const markets = this.minTteMs > 0
      ? all.filter((m) => tradableByTime(m, now, this.minTteMs))
      : all;
    this.marketsCache = { v: markets, atMs: now };
    return markets;
  }

  /**
   * Fill in the boundary of every `reference` market from the oracle price feed.
   * The indexer row carries `strike: "0"` (the reference sentinel) and never
   * posts the opening price, so without this every such market is skipped with
   * BOUNDARY_NOT_POSTED and the agent cannot trade at all (RFC-001 A4).
   * A market whose boundary is not knowable yet is left untouched — it keeps
   * skipping, which is the honest outcome, rather than being priced off a guess.
   */
  private async postBoundaries(markets: Market[], rows: SdkMarketRow[]): Promise<void> {
    const src = this.boundary;
    if (!src) return;
    await Promise.all(markets.map(async (mk, i) => {
      if (mk.mode !== 'reference' || mk.boundaryPosted) return;
      const startSec = Number(rows[i]?.tradingStart ?? 0);
      if (!(startSec > 0)) return;
      try {
        const open = await src.resolve(mk.asset, startSec);
        if (open !== null && open > 0) {
          mk.strike = open;
          mk.boundaryPosted = true;
        }
      } catch (e) {
        // A feed outage must never break market listing.
        this.note(e);
      }
    }));
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
    const v = await this.rpcGate.run(() => this.c.getMarketOnchain(marketId));
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

    const ob = await this.rpcGate.run(() => this.c.fetchOrderBook(mk.yesSymbol, 5));
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
      dbg(`VENUE submit->queue ${order.clientOrderId}`);
      const res = this.queue
        ? await this.queue.submit({ clientOrderId: order.clientOrderId, run: (n) => { dbg(`VENUE run ${order.clientOrderId} nonce=${n}`); return submit(n); } })
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
      if (res.orderId) {
        this.venueOrderIds.set(order.clientOrderId, res.orderId);
        this.ownOrderMarkets.set(order.clientOrderId, order.marketId);
      }
      this.emitResultFills(order, res);
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
    // An order the pool rejected as not ours is gone, not filled. Without this
    // the ACCEPTED ack below would report ALREADY_FILLED and a caller could book
    // a position that never existed.
    if (this.deadOrders.has(clientOrderId)) {
      return { clientOrderId, status: 'NOT_FOUND', txHash: null, tsMs: now };
    }
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
    // ownOrderMarkets is recorded at placement and is the reliable source; the
    // ack-derived lookup returns null for an order placed in an earlier cycle,
    // which reached the adapter as marketId "" ("no market row for ").
    const marketId = this.ownOrderMarkets.get(clientOrderId)
      ?? (ack ? this.marketIdFor(clientOrderId) : null);
    try {
      const res = this.queue
        ? await this.queue.submit({
            clientOrderId: `cancel:${clientOrderId}`,
            run: (nonce) => this.c.cancelOrder({ marketId: marketId ?? '', orderId, nonce }),
          })
        : await this.c.cancelOrder({ marketId: marketId ?? '', orderId, nonce: await this.fallbackNonce() });
      assertTxOk(res, `cancel ${clientOrderId}`);
      this.venueOrderIds.delete(clientOrderId);
      this.ownOrderMarkets.delete(clientOrderId);
      return { clientOrderId, status: 'CANCELLED', txHash: res.hash ?? null, tsMs: now };
    } catch (e) {
      this.note(e);
      const msg = e instanceof Error ? e.message : String(e);
      // Forget an order the pool says is not ours: retrying signs a transaction
      // that can only revert. A transient failure is NOT forgotten, so it can
      // still be retried.
      if (NOT_OURS.test(msg)) {
        this.venueOrderIds.delete(clientOrderId);
        this.ownOrderMarkets.delete(clientOrderId);
        this.deadOrders.add(clientOrderId);
      }
      // Cancelling something already gone is not an error worth throwing.
      return { clientOrderId, status: 'NOT_FOUND', txHash: null, tsMs: now };
    }
  }

  async cancelAll(agent?: AgentId): Promise<CancelAck[]> {
    if (agent !== undefined && agent !== this.agent) return [];
    // Start from OUR OWN records — orders this process placed and has not
    // cancelled. These are chain truth (we hold the receipts) and, unlike the
    // indexer, are available immediately after a write.
    const targets = new Map<string, { orderId: string; marketId: string; clientTag?: string }>();
    for (const [clientOrderId, orderId] of this.venueOrderIds) {
      targets.set(orderId, { orderId, marketId: this.ownOrderMarkets.get(clientOrderId) ?? '', clientTag: clientOrderId });
    }
    // Then union the indexer's view, which may know about orders from an
    // earlier run of this same key. Keyed by orderId so nothing cancels twice.
    try {
      for (const o of await this.gate.run(() => this.c.openOrders({ venueId: this.venueId }))) {
        if (!targets.has(o.orderId)) targets.set(o.orderId, o);
      }
    } catch (e) {
      this.note(e);   // a blind indexer must not stop us cancelling our own
    }
    const out: CancelAck[] = [];
    const expired = new Map<string, { orderId: string; clientOrderId: string }[]>();
    for (const o of targets.values()) {
      const clientOrderId = o.clientTag ?? o.orderId;
      try {
        const res = await this.c.cancelOrder({ marketId: o.marketId, orderId: o.orderId, nonce: await this.fallbackNonce() });
        assertTxOk(res, `cancelAll ${o.orderId}`);
        // Forget EVERY record pointing at this venue orderId, not just the one
        // we cancelled under: the orderId identifies the order, so any other
        // clientOrderId still mapped to it is stale. Clearing one leaves a
        // straggler that the next cancelAll would try to cancel again.
        for (const [cid, oid] of [...this.venueOrderIds]) {
          if (oid === o.orderId) { this.venueOrderIds.delete(cid); this.ownOrderMarkets.delete(cid); }
        }
        this.venueOrderIds.delete(clientOrderId);
        this.ownOrderMarkets.delete(clientOrderId);
        out.push({ clientOrderId, status: 'CANCELLED', txHash: res.hash ?? null, tsMs: this.nowFn() });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        dbg(`cancelAll FAILED ${o.orderId}: ${msg}`);
        this.note(e);
        // An expired order cannot be cancelled, but its escrow is still locked.
        // Collect it and reclaim below rather than walking away from the money.
        if (EXPIRED_ORDER.test(msg)) {
          const byMarket = expired.get(o.marketId) ?? [];
          byMarket.push({ orderId: o.orderId, clientOrderId });
          expired.set(o.marketId, byMarket);
        }
      }
    }
    await this.reclaimExpired(expired, out);
    return out;
  }

  /**
   * Reclaim escrow from orders the pool reports as expired. Reported as
   * NOT_FOUND, which is the truth: the order was gone; what we recovered was
   * the collateral behind it.
   */
  private async reclaimExpired(
    expired: Map<string, { orderId: string; clientOrderId: string }[]>,
    out: CancelAck[],
  ): Promise<void> {
    if (!expired.size || !this.c.cancelExpiredOrders) return;
    for (const [marketId, items] of expired) {
      try {
        const res = await this.c.cancelExpiredOrders({ marketId, orderIds: items.map((i) => i.orderId) });
        assertTxOk(res, `cancelExpiredOrders ${marketId}`);
        for (const it of items) {
          this.venueOrderIds.delete(it.clientOrderId);
          this.ownOrderMarkets.delete(it.clientOrderId);
          out.push({ clientOrderId: it.clientOrderId, status: 'NOT_FOUND', txHash: res.hash ?? null, tsMs: this.nowFn() });
        }
      } catch (e) {
        dbg(`reclaimExpired FAILED ${marketId}: ${e instanceof Error ? e.message : String(e)}`);
        this.note(e);
      }
    }
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
  /**
   * Publish the matches the SDK returned with a placeOrder. Without this the
   * engine never learns it traded: `netByMarket` stays 0, so the risk caps
   * (maxNetContractsPerMarket) are silently inert. Sizes and prices are raw
   * 6dp integers; contracts and probabilities are what the rest of the system
   * speaks.
   */
  private emitResultFills(order: Order, res: SdkTxResult): void {
    const scale = 10 ** this.priceDecimals;
    for (const f of res.fills ?? []) {
      let qty: bigint, px: bigint;
      try { qty = BigInt(f.quantityFilled); px = BigInt(f.fillPrice); }
      catch { continue; }               // a malformed fill must not kill the ack
      if (qty <= 0n) continue;          // never publish a phantom trade
      if (f.id) {
        if (this.seenChainFills.has(f.id)) continue;
        this.rememberChainFill(f.id);
      }
      const sizeContracts = Number(qty) / scale;
      const price = Number(px) / scale;
      this.emitFill({
        clientOrderId: order.clientOrderId,
        venueOrderId: res.orderId ?? null,
        marketId: order.marketId,
        agent: this.agent,
        side: order.side,
        sizeContracts,
        price: price as Prob,
        feeUsd: (sizeContracts * price * this.feeBps) / 10_000,
        txHash: res.hash ?? null,
        tsMs: this.nowFn(),
      });
    }
  }

  /**
   * Publish fills the chain saw that we did not initiate — i.e. someone hit a
   * quote we were resting. The taker path (placeOrder's own result) cannot see
   * these. Deduped against the taker path by the chain's own fill id, so one
   * trade is one Fill however it was discovered. Never throws: a dead tail must
   * not touch trading.
   * @returns how many new fills were published.
   */
  async pollMakerFills(): Promise<number> {
    if (!this.c.liveUserFills) return 0;
    let rows: SdkLiveFill[];
    try {
      const markets = await this.getMarkets();
      if (!markets.length) return 0;
      rows = await this.c.liveUserFills({ marketIds: markets.map((m) => m.id), limit: 50 });
    } catch (e) {
      this.note(e);
      return 0;
    }
    let n = 0;
    const scale = 10 ** this.priceDecimals;
    for (const r of rows ?? []) {
      if (!r?.id || this.seenChainFills.has(r.id)) continue;
      let qty: bigint, px: bigint;
      try { qty = BigInt(r.quantity); px = BigInt(r.fillPrice); } catch { continue; }
      if (qty <= 0n) continue;
      this.rememberChainFill(r.id);
      const sizeContracts = Number(qty) / scale;
      const price = Number(px) / scale;
      this.emitFill({
        clientOrderId: `maker:${r.id}`,   // not ours to name; the chain id is the identity
        venueOrderId: null,
        marketId: r.marketId,
        agent: this.agent,
        side: r.side,
        sizeContracts,
        price: price as Prob,
        feeUsd: (sizeContracts * price * this.feeBps) / 10_000,
        txHash: r.txHash ?? null,
        tsMs: r.tsMs ?? this.nowFn(),
      });
      n++;
    }
    return n;
  }

  /** Bounded memory: a long run must not accumulate fill ids for ever. */
  private rememberChainFill(id: string): void {
    this.seenChainFills.add(id);
    if (this.seenChainFills.size > 2_000) {
      // Sets iterate in insertion order, so this drops the oldest.
      for (const old of this.seenChainFills) {
        this.seenChainFills.delete(old);
        if (this.seenChainFills.size <= 1_500) break;
      }
    }
  }

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
        bal = await this.rpcGate.run(() => this.c.outcomeBalances(mk.id));
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
      return Math.max(0, await this.rpcGate.run(() => this.c.collateralBalance()));
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
      try { bal = await this.rpcGate.run(() => this.c.outcomeBalances(mk.id)); } catch (e) { this.note(e); continue; }
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
